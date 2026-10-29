import type {
  ChannelRunRecord,
  ChannelRunStorage,
  ResponseStorage,
  ResponseOwner,
} from '@librechat/data-schemas';
import type { ChannelRunSnapshot } from 'librechat-data-provider';
import type { BackgroundResponseResult } from '~/agents/responses/background';
import type { Response } from '~/agents/responses/types';
import { ChannelExecutionError } from './errors';

export interface ChannelResponseProjectionDependencies {
  storage: Pick<ResponseStorage, 'read'>;
  /** Reads through live source-key, owner, tenant, role and Agent authorization. */
  readResponse: (owner: ResponseOwner, responseId: string) => Promise<BackgroundResponseResult>;
  cancelResponse: (owner: ResponseOwner, responseId: string) => Promise<BackgroundResponseResult>;
  now?: () => number;
}

/** Revoked channel authority can retire its exact response without recovering execution authority. */
export function createChannelResponseRetirement(deps: {
  storage: Pick<ResponseStorage, 'read'>;
  recovery: Pick<ChannelRunStorage, 'recoverResponse'>;
  retireResponse: (owner: ResponseOwner, responseId: string) => Promise<'stopped' | 'pending'>;
  now?: () => number;
}): (run: ChannelRunRecord) => Promise<'stopped' | 'pending'> {
  return async (run) => {
    if (
      run.execution?.protocol !== 'responses' ||
      !run.cancellationRequested ||
      run.errorCode !== 'channel_authority_changed'
    )
      throw new ChannelExecutionError('execution_identity_changed');
    if (!run.execution.responseId) {
      if (!run.leaseOwner) throw new ChannelExecutionError('execution_identity_changed');
      const recovered = await deps.recovery.recoverResponse(
        run.tenantId,
        { runId: run.runId, owner: run.leaseOwner, epoch: run.leaseEpoch },
        (deps.now ?? Date.now)(),
      );
      if (!recovered) return 'pending';
      run = recovered;
    }
    const responseId = run.execution?.responseId;
    if (!responseId) return 'pending';
    const owner = {
      userId: run.principal.userId,
      tenantId: run.tenantId === '_' ? undefined : run.tenantId,
    };
    const stored = await deps.storage.read(owner, responseId);
    if (
      !stored ||
      stored.agentId !== run.agentId ||
      stored.requestKey !== `channel:${run.runId}` ||
      stored.conversationId !== run.execution!.conversationId ||
      stored.parentMessageId !== run.execution!.parentMessageId ||
      (run.execution!.apiKeyId != null && stored.sourceKeyId !== run.execution!.apiKeyId)
    )
      throw new ChannelExecutionError('execution_identity_changed');
    return deps.retireResponse(owner, responseId);
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
    const owner = {
      userId: run.principal.userId,
      tenantId: run.tenantId === '_' ? undefined : run.tenantId,
    };
    const stored = await deps.storage.read(owner, execution.responseId);
    if (
      !stored ||
      stored.agentId !== run.agentId ||
      stored.requestKey !== `channel:${run.runId}` ||
      stored.conversationId !== execution.conversationId ||
      stored.parentMessageId !== execution.parentMessageId ||
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
