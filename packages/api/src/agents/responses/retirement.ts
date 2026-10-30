import type { ResponseOwner, ResponseStorage, StoredResponseRecord } from '@librechat/data-schemas';
import type { GenerationJobManagerClass } from '~/stream/GenerationJobManager';
import type { ResponseCheckpointIdentity } from './checkpoint';
import type { ResponseCompletionRecord } from './completion';
import { createResponseCompletion, createResponseExecutionRelease } from './completion';
import { buildPendingBackgroundResponse } from './background';

export interface ResponseRetirementDependencies {
  storage: ResponseStorage;
  jobs: Pick<
    GenerationJobManagerClass,
    'getJob' | 'abortJob' | 'finishProviderTerminalPersistence'
  >;
  /** Required before a durably paused response may publish cancellation. Must be idempotent. */
  cleanupCheckpoint?: (
    record: ResponseCheckpointIdentity,
    checkpointNamespace: string,
  ) => Promise<void>;
  recoverTerminal?: (record: StoredResponseRecord) => Promise<ResponseCompletionRecord>;
  now?: () => number;
}

const terminal = (record: StoredResponseRecord) =>
  ['completed', 'failed', 'incomplete', 'cancelled'].includes(record.status);

/** Internal cleanup authority: may stop one owned response, never execute or disclose its output. */
export function createResponseRetirement(
  deps: ResponseRetirementDependencies,
): (owner: ResponseOwner, responseId: string) => Promise<'stopped' | 'pending'> {
  const recover =
    deps.recoverTerminal ??
    createResponseCompletion({
      storage: deps.storage,
      cleanupCheckpoint:
        deps.cleanupCheckpoint ??
        (async () => {
          throw new Error('Response checkpoint cleanup unavailable');
        }),
      releaseExecution: createResponseExecutionRelease(deps.jobs),
    }).finish;
  return async (owner, responseId) => {
    let record = await deps.storage.requestCancellation(
      owner,
      responseId,
      (deps.now ?? Date.now)(),
    );
    if (!record) {
      const job = await deps.jobs.getJob(responseId);
      const retained =
        job &&
        job.metadata.userId === owner.userId &&
        (job.metadata.tenantId || undefined) === (owner.tenantId || undefined) &&
        job.metadata.endpoint === 'responses' &&
        job.metadata.responseMessageId === responseId &&
        job.metadata.agent_id &&
        job.metadata.conversationId
          ? {
              userId: job.metadata.userId,
              tenantId: job.metadata.tenantId,
              responseId,
              agentId: job.metadata.agent_id,
              conversationId: job.metadata.conversationId,
              generationCreatedAt: job.createdAt,
              checkpointNamespace: job.metadata.checkpointNamespace,
              checkpointConfigJSON: job.metadata.responseCheckpointConfigJSON,
            }
          : undefined;
      const identity = await deps.storage.readCleanupIdentity(owner, responseId, retained);
      if (
        !identity?.retirement &&
        !(identity?.expiredAt && identity.expiredAt.getTime() <= (deps.now ?? Date.now)())
      )
        throw new Error('Response retirement identity unavailable');
      if (!job) return identity.generationCreatedAt == null ? 'stopped' : 'pending';
      if (
        job.createdAt !== identity.generationCreatedAt ||
        job.metadata.userId !== identity.userId ||
        job.metadata.tenantId !== identity.tenantId ||
        job.metadata.agent_id !== identity.agentId ||
        job.metadata.endpoint !== 'responses' ||
        job.metadata.conversationId !== identity.conversationId ||
        job.metadata.responseMessageId !== responseId
      )
        throw new Error('Response retirement generation changed');
      const providerExecutionId = job.metadata.providerExecutionId;
      const providerExecutionOwnerId = job.metadata.providerExecutionOwnerId;
      if (!providerExecutionId) throw new Error('Response retirement provider unavailable');
      const cleanup = async () => {
        if (identity.requiresCheckpointCleanup || identity.checkpointConfigJSON) {
          const namespace = identity.checkpointNamespace ?? job.metadata.checkpointNamespace;
          if (!namespace || !deps.cleanupCheckpoint || !identity.checkpointConfigJSON)
            throw new Error('Response checkpoint cleanup unavailable');
          await deps.cleanupCheckpoint(
            {
              ...identity,
              pendingTerminal: {
                checkpointNamespace: namespace,
                checkpointConfigJSON: identity.checkpointConfigJSON,
              },
            },
            namespace,
          );
        }
      };
      await deps.jobs.abortJob(responseId, {
        expectedCreatedAt: identity.generationCreatedAt,
        awaitProviderDrain: true,
        retainTerminalPersistence: true,
        beforePublish: cleanup,
      });
      await createResponseExecutionRelease({
        getJob: deps.jobs.getJob.bind(deps.jobs),
        finishProviderTerminalPersistence: deps.jobs.finishProviderTerminalPersistence.bind(
          deps.jobs,
        ),
      })(
        { ...identity, status: 'cancelled' },
        { providerExecutionId, ownerId: providerExecutionOwnerId },
      );
      return 'stopped';
    }
    if (terminal(record)) {
      await recover(record);
      return 'stopped';
    }
    if (record.pendingTerminal) {
      return terminal(await recover(record)) ? 'stopped' : 'pending';
    }
    if (record.generationCreatedAt == null) {
      const response = {
        ...buildPendingBackgroundResponse(record),
        status: 'cancelled' as const,
        completed_at: Math.floor((deps.now ?? Date.now)() / 1000),
      };
      const cancelled = await deps.storage.publish(owner, responseId, record.revision, {
        status: 'cancelled',
        responseJSON: JSON.stringify(response),
      });
      // This CAS beats enrollment publication, which must succeed before provider startup.
      if (cancelled.ok) return 'stopped';
      record = await deps.storage.read(owner, responseId);
      if (!record) throw new Error('Response disappeared during retirement');
      if (terminal(record)) {
        await recover(record);
        return 'stopped';
      }
    }
    const job = await deps.jobs.getJob(responseId);
    if (!job) return 'pending';
    if (
      record.generationCreatedAt == null ||
      job.createdAt !== record.generationCreatedAt ||
      job.metadata.userId !== record.userId ||
      job.metadata.tenantId !== record.tenantId ||
      job.metadata.agent_id !== record.agentId ||
      job.metadata.endpoint !== 'responses' ||
      job.metadata.conversationId !== record.conversationId ||
      job.metadata.responseMessageId !== record.responseId
    )
      throw new Error('Response retirement generation changed');
    const epoch = record.generationCreatedAt;
    const agentId = record.agentId;
    const conversationId = record.conversationId;
    const providerExecutionId = job.metadata.providerExecutionId;
    const providerExecutionOwnerId = job.metadata.providerExecutionOwnerId;
    async function stageCancellation(): Promise<void> {
      const stopped = await deps.jobs.getJob(responseId);
      const proof = stopped?.metadata;
      if (
        stopped?.status !== 'aborted' ||
        !proof ||
        proof.providerDrained !== true ||
        stopped.createdAt !== epoch ||
        proof.userId !== owner.userId ||
        proof.tenantId !== owner.tenantId ||
        proof.agent_id !== agentId ||
        proof.endpoint !== 'responses' ||
        proof.responseMessageId !== responseId ||
        proof.conversationId !== conversationId ||
        proof.providerExecutionId !== providerExecutionId ||
        proof.providerExecutionOwnerId !== providerExecutionOwnerId ||
        !proof.providerExecutionId
      )
        return;
      const current = await deps.storage.read(owner, responseId);
      if (!current || current.generationCreatedAt !== epoch)
        throw new Error('Response retirement journal changed');
      if (terminal(current) || current.pendingTerminal) return;
      if (current.cancellationRequestedAt == null)
        throw new Error('Response cancellation intent is unavailable');
      if (current.review && (!proof.checkpointNamespace || !deps.cleanupCheckpoint)) return;
      const response = {
        ...buildPendingBackgroundResponse(current),
        model: current.agentId,
        status: 'cancelled' as const,
        completed_at: Math.floor((deps.now ?? Date.now)() / 1000),
      };
      const receipt = {
        generationCreatedAt: epoch,
        providerExecutionId: proof.providerExecutionId,
        ...(proof.providerExecutionOwnerId == null
          ? {}
          : { ownerId: proof.providerExecutionOwnerId }),
        status: 'cancelled' as const,
        responseJSON: JSON.stringify(response),
        ...(current.review
          ? {
              checkpointNamespace: proof.checkpointNamespace,
              ...(current.review.checkpointConfigJSON == null
                ? {}
                : { checkpointConfigJSON: current.review.checkpointConfigJSON }),
            }
          : {}),
      };
      try {
        const staged = await deps.storage.stageTerminal(
          owner,
          responseId,
          { execution: current },
          receipt,
        );
        if (!staged.ok) throw new Error('Response retirement receipt conflicted');
      } catch (error) {
        const saved = await deps.storage.read(owner, responseId);
        if (
          !saved ||
          saved.generationCreatedAt !== epoch ||
          (!terminal(saved) &&
            (saved.pendingTerminal?.providerExecutionId !== receipt.providerExecutionId ||
              saved.pendingTerminal.responseJSON !== receipt.responseJSON))
        )
          throw error;
      }
    }
    await deps.jobs.abortJob(responseId, {
      expectedCreatedAt: record.generationCreatedAt,
      awaitProviderDrain: true,
      retainTerminalPersistence: true,
      beforePublish: stageCancellation,
    });
    // Runtime publication includes provider drain and trailing writes; a missing job alone is not proof.
    let settled = await deps.storage.read(owner, responseId);
    if (settled && terminal(settled)) {
      await recover(settled);
      return 'stopped';
    }
    if (settled?.pendingTerminal) return terminal(await recover(settled)) ? 'stopped' : 'pending';
    // A repeated Stop can recover a failed runtime receipt only from the exact retained,
    // aborted and drained provider. Completed jobs and absent jobs are not cancellation proof.
    await stageCancellation();
    settled = await deps.storage.read(owner, responseId);
    if (settled?.pendingTerminal) settled = await recover(settled);
    return settled && terminal(settled) ? 'stopped' : 'pending';
  };
}
