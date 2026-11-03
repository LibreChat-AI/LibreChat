import { Constants } from 'librechat-data-provider';
import type { ChannelResponseGrant, DurableStorageConfig } from 'librechat-data-provider';
import type { StoredResponseRecord, ResponseOwner } from '~/models/response';
import type { ChannelRunRecord } from '~/models/channelRun';
import type { ManagedTarget } from '~/types/managed';
import { ChannelRunConflict, digest } from './channelProtocol';
import { includeManagedAllocations } from '~/utils/managed';
import { responseOwnerFilter } from './responseScope';
import { responseRootFilter } from './responseRoot';
import { createResponseStorage } from './response';

export type ChannelResponseOwner = ResponseOwner & {
  responseId: string;
  storageTarget: ManagedTarget<'response'>;
};

/** The gateway and cancellation owner describe the same accepted request. */
export function channelResponseRequest(run: ChannelRunRecord): ChannelResponseGrant['request'] {
  if (!run.execution) throw new ChannelRunConflict('invalid_transition');
  return {
    model: run.agentId,
    input: run.admission.input,
    background: true,
    store: true,
    ...(run.execution.parentMessageId !== Constants.NO_PARENT && {
      previous_response_id: run.execution.parentMessageId,
    }),
  };
}

/** Existing Response storage already accepts a captured record as owner authority. */
export function channelResponseOwner(run: ChannelRunRecord): ChannelResponseOwner {
  const execution = run.execution;
  if (!execution?.responseId || !execution.responseTarget || !execution.responseFingerprint)
    throw new ChannelRunConflict('invalid_transition');
  return {
    userId: run.principal.userId,
    ...(run.tenantId !== '_' && { tenantId: run.tenantId }),
    responseId: execution.responseId,
    storageTarget: execution.responseTarget,
  };
}

/** First selection may resolve the request key; every subsequent read addresses that same Root. */
export async function bindChannelRunResponse(
  mongoose: typeof import('mongoose'),
  run: ChannelRunRecord,
  getDurableConfig: () => Promise<Partial<DurableStorageConfig>>,
  responseId?: string,
  cleanup = false,
): Promise<Partial<ChannelRunRecord> | null> {
  const execution = run.execution;
  if (
    !execution ||
    execution.protocol !== 'responses' ||
    (execution.responseId != null && execution.responseId !== responseId)
  )
    throw new ChannelRunConflict('invalid_transition');
  const owner = {
    userId: run.principal.userId,
    ...(run.tenantId !== '_' && { tenantId: run.tenantId }),
  };
  if (execution.responseTarget && !execution.responseId)
    throw new ChannelRunConflict('invalid_transition');
  const candidate = await includeManagedAllocations(
    mongoose.model<StoredResponseRecord>('StoredResponse').findOne({
      ...(execution.responseTarget
        ? responseRootFilter(mongoose, {
            ...owner,
            responseId: execution.responseId!,
            target: execution.responseTarget,
          })
        : responseOwnerFilter(owner)),
      requestKey: `channel:${run.runId}`,
      agentId: run.agentId,
      ...(responseId && { responseId }),
      ...(execution.apiKeyId && { sourceKeyId: execution.apiKeyId }),
    }),
  )
    .select(
      'userId tenantId responseId agentId requestKey sourceKeyId conversationId parentMessageId fingerprint storageTarget generationCreatedAt',
    )
    .read('primary')
    .lean();
  if (!candidate?.storageTarget) return null;
  if (
    candidate.conversationId !== execution.conversationId ||
    candidate.parentMessageId !== execution.parentMessageId ||
    (execution.responseTarget &&
      digest(execution.responseTarget) !== digest(candidate.storageTarget)) ||
    (execution.responseFingerprint && execution.responseFingerprint !== candidate.fingerprint)
  )
    throw new ChannelRunConflict('invalid_transition');
  const captured: ChannelResponseOwner = {
    ...owner,
    responseId: candidate.responseId,
    storageTarget: candidate.storageTarget,
  };
  const responses = createResponseStorage(mongoose, { getDurableStorageConfig: getDurableConfig });
  const visible = await responses.read(captured, candidate.responseId);
  if (!visible && !cleanup) return null;
  if (visible) {
    if (
      visible.fingerprint !== candidate.fingerprint ||
      visible.agentId !== run.agentId ||
      visible.requestKey !== `channel:${run.runId}` ||
      visible.conversationId !== execution.conversationId ||
      visible.parentMessageId !== execution.parentMessageId ||
      (execution.apiKeyId != null && visible.sourceKeyId !== execution.apiKeyId)
    )
      throw new ChannelRunConflict('invalid_transition');
    const request = channelResponseRequest(run);
    const redactedTerminal =
      visible.requestJSON === '{}' &&
      ['completed', 'failed', 'incomplete', 'cancelled'].includes(visible.status) &&
      run.cancellationRequested &&
      execution.apiKeyId != null &&
      [digest(request), digest({ ...request, stream: false })].includes(visible.fingerprint);
    if (!redactedTerminal) {
      const saved: Omit<Partial<ChannelResponseGrant['request']>, 'background' | 'store'> & {
        background?: boolean;
        store?: boolean;
      } = JSON.parse(visible.requestJSON);
      if (
        saved.model !== request.model ||
        saved.input !== request.input ||
        (execution.responseId == null &&
          saved.previous_response_id !== request.previous_response_id) ||
        saved.background !== true ||
        saved.store === false
      )
        throw new ChannelRunConflict('invalid_transition');
    }
  } else if (!execution.apiKeyId) {
    // Cleanup may recover redacted metadata only through the original run-bound source credential.
    throw new ChannelRunConflict('invalid_transition');
  }
  return {
    execution: {
      ...execution,
      protocol: 'responses',
      responseId: candidate.responseId,
      responseTarget: candidate.storageTarget,
      responseFingerprint: candidate.fingerprint,
      ...(candidate.generationCreatedAt != null && {
        generationCreatedAt: candidate.generationCreatedAt,
      }),
    },
  };
}
