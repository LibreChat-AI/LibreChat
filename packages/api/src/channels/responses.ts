import {
  channelRunFence,
  channelResponseOwner,
  channelResponseRequest,
} from '@librechat/data-schemas';
import type {
  ChannelRunRecord,
  ChannelRunStorage,
  ResponseStorage,
  ResponseOwner,
  ResponseCleanupIdentity,
} from '@librechat/data-schemas';
import type { ChannelRunSnapshot } from 'librechat-data-provider';
import type { BackgroundResponseResult } from '~/agents/responses/background';
import type { Response } from '~/agents/responses/types';
import { reserveResponseCancellation } from '~/agents/responses/retirement';
import { ChannelExecutionError } from './errors';

export interface ChannelResponseProjectionDependencies {
  storage: Pick<ResponseStorage, 'read'>;
  /** Reads through live source-key, owner, tenant, role and Agent authorization. */
  readResponse: (owner: ResponseOwner, responseId: string) => Promise<BackgroundResponseResult>;
  cancelResponse: (owner: ResponseOwner, responseId: string) => Promise<BackgroundResponseResult>;
  now?: () => number;
}

/** Cancel-only canonical admission also fences a gateway POST delayed before its first Root. */
export function createChannelResponseCancellation(deps: {
  storage: Pick<ResponseStorage, 'reserve' | 'readConversationTarget'>;
  recovery: Pick<ChannelRunStorage, 'recoverResponse'>;
  now?: () => number;
}): (run: ChannelRunRecord) => Promise<ChannelRunRecord | null> {
  return async (run) => {
    if (
      !run.cancellationRequested ||
      run.execution?.protocol !== 'responses' ||
      !run.execution.apiKeyId ||
      !run.leaseOwner
    )
      throw new ChannelExecutionError('execution_identity_changed');
    const clock = deps.now ?? Date.now;
    const now = clock();
    const fence = channelRunFence(run);
    const recovered = await deps.recovery.recoverResponse(run.tenantId, fence, now);
    if (recovered) return recovered;
    const owner = {
      userId: run.principal.userId,
      ...(run.tenantId !== '_' && { tenantId: run.tenantId }),
    };
    const conversation = await deps.storage.readConversationTarget(
      owner,
      run.execution.conversationId,
    );
    const deadlines = [run._managed?.expiredAt, conversation?.expiredAt].filter(
      (value): value is Date => value != null,
    );
    const reserved = await reserveResponseCancellation(
      deps.storage,
      {
        ...owner,
        agentId: run.agentId,
        requestKey: `channel:${run.runId}`,
        sourceKeyId: run.execution.apiKeyId,
        conversationId: run.execution.conversationId,
        parentMessageId: run.execution.parentMessageId,
        ...(conversation && {
          conversationTarget: conversation.target,
          isTemporary: conversation.isTemporary,
        }),
        ...(deadlines.length && {
          expiredAt: new Date(Math.min(...deadlines.map((date) => date.getTime()))),
        }),
      },
      channelResponseRequest(run),
      now,
    );
    // A normal POST may win with the permitted optional stream:false form. Capture its real Root.
    const captured = await deps.recovery.recoverResponse(run.tenantId, fence, clock());
    if (captured) return captured;
    if (!reserved.ok && reserved.code === 'response_unavailable') return null;
    throw new ChannelExecutionError('execution_identity_changed');
  };
}

/** Revoked channel authority can retire its exact response without recovering execution authority. */
export function createChannelResponseRetirement(deps: {
  storage: Pick<ResponseStorage, 'readCleanupIdentity' | 'reserve' | 'readConversationTarget'>;
  recovery: Pick<ChannelRunStorage, 'recoverResponse'>;
  retireResponse: (
    owner: ResponseOwner,
    responseId: string,
    retained?: ResponseCleanupIdentity,
  ) => Promise<'stopped' | 'pending'>;
  now?: () => number;
}): (run: ChannelRunRecord) => Promise<'stopped' | 'pending'> {
  const recoverCancellation = createChannelResponseCancellation(deps);
  return async (run) => {
    if (
      run.execution?.protocol !== 'responses' ||
      !run.cancellationRequested ||
      run.errorCode !== 'channel_authority_changed'
    )
      throw new ChannelExecutionError('execution_identity_changed');
    if (!run.execution.responseId) {
      if (!run.leaseOwner) throw new ChannelExecutionError('execution_identity_changed');
      const recovered = await recoverCancellation(run);
      if (!recovered) return 'pending';
      run = recovered;
    }
    const responseId = run.execution?.responseId;
    if (!responseId) return 'pending';
    if (!run.execution?.responseTarget || !run.execution.responseFingerprint)
      throw new ChannelExecutionError('execution_identity_changed');
    const owner = channelResponseOwner(run);
    const retained: ResponseCleanupIdentity = {
      ...owner,
      agentId: run.agentId,
      conversationId: run.execution!.conversationId,
      parentMessageId: run.execution!.parentMessageId,
      requestKey: `channel:${run.runId}`,
      sourceKeyId: run.execution!.apiKeyId,
      generationCreatedAt: run.execution!.generationCreatedAt,
    };
    const stored = await deps.storage.readCleanupIdentity(owner, responseId, retained);
    if (
      stored &&
      (stored.responseId !== responseId ||
        stored.userId !== owner.userId ||
        (stored.tenantId || undefined) !== (owner.tenantId || undefined) ||
        stored.agentId !== run.agentId ||
        stored.requestKey !== `channel:${run.runId}` ||
        stored.conversationId !== run.execution!.conversationId ||
        stored.parentMessageId !== run.execution!.parentMessageId ||
        (run.execution!.apiKeyId != null && stored.sourceKeyId !== run.execution!.apiKeyId))
    )
      throw new ChannelExecutionError('execution_identity_changed');
    // The private retirement owner resolves missing rows from cleanup/job identities;
    // absence here never proves that a provider stopped.
    return deps.retireResponse(owner, responseId, stored ?? retained);
  };
}

function snapshotStatus(response: Response): ChannelRunSnapshot['status'] {
  switch (response.status) {
    case 'completed':
      return 'completed';
    case 'cancelled':
      return 'cancelled';
    case 'failed':
    case 'incomplete':
      return 'failed';
    default:
      return response.required_action ? 'requires_action' : 'running';
  }
}

/** Delivery projection only: never starts an Agent, rebuilds a transcript or infers completion. */
export function createChannelResponseProjection(deps: ChannelResponseProjectionDependencies) {
  return async (
    run: ChannelRunRecord,
  ): Promise<{ snapshot: ChannelRunSnapshot; generationCreatedAt?: number }> => {
    const execution = run.execution;
    if (execution?.protocol !== 'responses' || !execution.responseId)
      throw new ChannelExecutionError('execution_not_prepared');
    if (!execution.responseTarget || !execution.responseFingerprint)
      throw new ChannelExecutionError('execution_identity_changed');
    const owner = channelResponseOwner(run);
    const stored = await deps.storage.read(owner, execution.responseId);
    if (
      !stored ||
      stored.fingerprint !== execution.responseFingerprint ||
      stored.agentId !== run.agentId ||
      stored.requestKey !== `channel:${run.runId}` ||
      stored.conversationId !== execution.conversationId ||
      stored.parentMessageId !== execution.parentMessageId ||
      (execution.apiKeyId != null && stored.sourceKeyId !== execution.apiKeyId) ||
      (execution.generationCreatedAt != null &&
        stored.generationCreatedAt !== execution.generationCreatedAt)
    )
      throw new ChannelExecutionError('execution_identity_changed');
    const result = await (run.cancellationRequested ? deps.cancelResponse : deps.readResponse)(
      owner,
      execution.responseId,
    );
    if (!result.ok) throw new ChannelExecutionError('execution_identity_changed');
    const response = result.response;
    if (
      response.id !== execution.responseId ||
      response.model !== run.agentId ||
      !response.background ||
      !response.store
    )
      throw new ChannelExecutionError('execution_identity_changed');
    const text: string[] = [];
    for (const item of response.output) {
      if (item.type !== 'message' || item.role !== 'assistant') continue;
      for (const content of item.content) {
        if (content.type === 'output_text') text.push(content.text);
      }
    }
    const terminal = ['completed', 'failed', 'incomplete', 'cancelled'].includes(response.status);
    const status = snapshotStatus(response);
    const action = response.required_action;
    return {
      generationCreatedAt: stored.generationCreatedAt,
      snapshot: {
        responseId: response.id,
        status,
        ...(response.recovery ? { recovery: response.recovery } : {}),
        text: terminal ? text.join('') : '',
        elapsedMs: Math.max(
          0,
          (response.completed_at == null
            ? (deps.now ?? Date.now)()
            : response.completed_at * 1000) - run.receivedAt,
        ),
        ...(response.accounting ? { accounting: response.accounting } : {}),
        ...(response.usage
          ? {
              usage: {
                inputTokens: response.usage.input_tokens,
                outputTokens: response.usage.output_tokens,
                totalTokens: response.usage.total_tokens,
                cachedTokens: response.usage.input_tokens_details.cached_tokens,
                reasoningTokens: response.usage.output_tokens_details.reasoning_tokens,
              },
            }
          : {}),
        ...(!terminal && action
          ? {
              pendingAction: {
                actionId: action.action_id,
                kind: action.kind === 'question' ? ('ask_user_question' as const) : action.kind,
                expiresAt: action.expires_at * 1000,
              },
            }
          : {}),
      },
    };
  };
}
