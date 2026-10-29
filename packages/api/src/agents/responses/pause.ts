import type { ResponseStorage, StoredResponseRecord } from '@librechat/data-schemas';
import type { Agents, TCheckpointerConfig } from 'librechat-data-provider';
import type { RunInterruptResult } from '@librechat/agents';
import type { GenerationJobManagerClass } from '~/stream/GenerationJobManager';
import type { AgentExecutionEnrollment } from '../remote/lifecycle';
import type { GenerationJob } from '~/types/stream';
import type { Response } from './types';
import { hasDurableAgentInterruptCheckpoint, resolveCheckpointerConfig } from '../checkpointer';
import { checkpointOwnerNamespacePrefix } from '~/stream/checkpoints';
import { buildPendingBackgroundResponse } from './background';

export interface ResponsePauseDependencies {
  storage: ResponseStorage;
  jobs: Pick<GenerationJobManagerClass, 'getJob'>;
  /** Capture the host's existing graph/project/code/MCP approval bindings; never caller body data. */
  buildAction: (interrupt: RunInterruptResult, job: GenerationJob) => Promise<Agents.PendingAction>;
  /** Save the ordinary unfinished assistant turn, with existing content/privacy filtering. */
  persistUnfinished: (response: Response, action: Agents.PendingAction) => Promise<void>;
}

/** Capture the SDK's real, durable interrupt before exposing any resumable action. */
export async function pauseResponseForReview(
  input: {
    run: { getInterrupt: () => RunInterruptResult | undefined };
    execution: AgentExecutionEnrollment;
    record: StoredResponseRecord;
    partial: Response;
    visibleOutputTokens?: number;
    checkpointer?: TCheckpointerConfig;
  },
  deps: ResponsePauseDependencies,
): Promise<boolean> {
  const interrupt = input.run.getInterrupt();
  if (!interrupt) return false;
  if (
    !interrupt.payload ||
    !['ask_user_question', 'tool_approval'].includes(interrupt.payload.type)
  )
    throw new Error('Unsupported response interrupt');
  const { record, execution } = input;
  const job = await deps.jobs.getJob(record.responseId);
  const namespace = job?.metadata.checkpointNamespace;
  const providerExecutionId = job?.metadata.providerExecutionId;
  if (
    !job ||
    job.createdAt !== record.generationCreatedAt ||
    job.createdAt !== execution.createdAt ||
    job.status !== 'running' ||
    !providerExecutionId ||
    job.metadata.userId !== record.userId ||
    job.metadata.tenantId !== record.tenantId ||
    job.metadata.agent_id !== record.agentId ||
    job.metadata.endpoint !== 'responses' ||
    job.metadata.conversationId !== record.conversationId ||
    !namespace?.startsWith(checkpointOwnerNamespacePrefix(record.userId, record.tenantId)) ||
    input.partial.id !== record.responseId ||
    input.partial.model !== record.agentId ||
    !interrupt.checkpointId ||
    !interrupt.interruptId ||
    (interrupt.threadId != null && interrupt.threadId !== record.conversationId)
  )
    throw new Error('Response interrupt identity changed');
  const config = resolveCheckpointerConfig(input.checkpointer);
  if (
    config.type !== 'mongo' ||
    !(await hasDurableAgentInterruptCheckpoint(record.conversationId, input.checkpointer, {
      checkpointNamespace: namespace,
      checkpointId: interrupt.checkpointId,
      checkpointNs: interrupt.checkpointNs,
      interruptId: interrupt.interruptId,
    }))
  )
    throw new Error('Response interrupt checkpoint is unavailable');
  const action = await deps.buildAction(interrupt, job);
  const expiresAt = action.expiresAt;
  if (
    action.streamId !== record.responseId ||
    action.responseMessageId !== record.responseId ||
    action.conversationId !== record.conversationId ||
    action.threadId !== record.conversationId ||
    action.interruptId !== interrupt.interruptId ||
    expiresAt == null ||
    !Number.isSafeInteger(expiresAt)
  )
    throw new Error('Response review action identity changed');
  return execution.pauseForReview(action, async () => {
    await deps.persistUnfinished(input.partial, action);
    const current = await deps.storage.read(record, record.responseId);
    if (!current || current.generationCreatedAt !== execution.createdAt)
      throw new Error('Response pause journal identity changed');
    const publicResponse = {
      ...buildPendingBackgroundResponse(current),
      status: 'in_progress' as const,
    };
    const published = await deps.storage.publishReview(
      current,
      current.responseId,
      current.revision,
      execution.createdAt,
      {
        actionId: action.actionId,
        providerExecutionId,
        expiresAt,
        partialResponseJSON: JSON.stringify(input.partial),
        ...(input.visibleOutputTokens == null
          ? {}
          : { visibleOutputTokens: input.visibleOutputTokens }),
        pendingActionJSON: JSON.stringify(action),
        checkpointId: interrupt.checkpointId,
        checkpointNs: interrupt.checkpointNs ?? '',
        checkpointConfigJSON: JSON.stringify({
          type: config.type,
          ttl: config.ttlSeconds,
          checkpointCollectionName: config.checkpointCollectionName,
          checkpointWritesCollectionName: config.checkpointWritesCollectionName,
        }),
      },
      JSON.stringify(publicResponse),
    );
    if (!published.ok) throw new Error('Response pause journal publication failed');
  });
}
