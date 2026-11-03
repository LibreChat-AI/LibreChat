import type {
  ResponseOwner,
  ResponseStorage,
  StoredResponseRecord,
  ResponseCleanupIdentity,
} from '@librechat/data-schemas';
import type { GenerationJobManagerClass } from '~/stream/GenerationJobManager';
import type { ResponseCheckpointIdentity } from './checkpoint';
import type { ResponseCompletionRecord } from './completion';
import {
  createResponseCompletion,
  readResponseExecutionProof,
  createResponseExecutionRelease,
  createResponseExecutionConfirmation,
} from './completion';
import { eraseResponseExecutionCheckpoint } from './checkpoint';
import { matchesResponseRoot, responseTenantId } from './scope';
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
): (
  owner: ResponseOwner,
  responseId: string,
  retained?: ResponseCleanupIdentity,
) => Promise<'stopped' | 'pending'> {
  const recover =
    deps.recoverTerminal ??
    createResponseCompletion({
      storage: deps.storage,
      confirmExecution: createResponseExecutionConfirmation(deps.storage, deps.jobs),
      cleanupCheckpoint:
        deps.cleanupCheckpoint ??
        (async () => {
          throw new Error('Response checkpoint cleanup unavailable');
        }),
      releaseExecution: createResponseExecutionRelease(deps.jobs, deps.storage),
    }).finish;
  async function retiredAuthority(
    owner: ResponseOwner,
    responseId: string,
    retained?: ResponseCleanupIdentity,
  ) {
    const identity = await deps.storage.readCleanupIdentity(owner, responseId, retained);
    if (
      !identity?.retirement &&
      !(identity?.expiredAt && identity.expiredAt.getTime() <= (deps.now ?? Date.now)())
    )
      return null;
    // Enrollment and retirement compete on the physical root. A closed scope alone
    // cannot fence an enrollment that already passed its scope read.
    const fenced =
      (await deps.storage.retireExecution(identity)) ||
      // An unused attempt may outlive physical erasure. Its exact root cannot be
      // recreated; closure plus absence fences startup without inventing enrollment.
      (identity.generationCreatedAt == null && (await deps.storage.finishErasure(identity)));
    const proof = fenced
      ? await readResponseExecutionProof(deps.storage, deps.jobs, identity)
      : null;
    const job = await deps.jobs.getJob(responseId);
    if (
      job &&
      (!matchesResponseRoot(identity, job.metadata) ||
        (identity.generationCreatedAt != null && job.createdAt !== identity.generationCreatedAt) ||
        (identity.generationCreatedAt == null && job.metadata.providerExecutionStartedId != null) ||
        job.metadata.userId !== identity.userId ||
        responseTenantId(job.metadata.tenantId) !== responseTenantId(identity.tenantId) ||
        job.metadata.agent_id !== identity.agentId ||
        job.metadata.endpoint !== 'responses' ||
        job.metadata.conversationId !== identity.conversationId ||
        job.metadata.responseMessageId !== responseId ||
        (proof &&
          (job.metadata.providerExecutionId !== proof.providerExecutionId ||
            job.metadata.providerExecutionOwnerId !== proof.ownerId)))
    )
      throw new Error('Response retirement generation changed');
    const providerExecutionId = job?.metadata.providerExecutionId ?? proof?.providerExecutionId;
    const providerExecutionOwnerId = job?.metadata.providerExecutionOwnerId ?? proof?.ownerId;
    const cleanup = async () => {
      if (!proof) throw new Error('Response checkpoint settlement is pending');
      await eraseResponseExecutionCheckpoint(
        deps.storage,
        identity,
        proof,
        deps.cleanupCheckpoint ??
          (async () => {
            throw new Error('Response checkpoint cleanup unavailable');
          }),
      );
    };
    return { identity, job, proof, fenced, cleanup, providerExecutionId, providerExecutionOwnerId };
  }
  async function finishRetired(
    owner: ResponseOwner,
    responseId: string,
    alreadyDrained = false,
    retained?: ResponseCleanupIdentity,
  ): Promise<'stopped' | 'pending' | null> {
    const retired = await retiredAuthority(owner, responseId, retained);
    if (!retired) return null;
    const { identity, job, providerExecutionId, providerExecutionOwnerId } = retired;
    if (!retired.fenced) return 'pending';
    if (identity.generationCreatedAt == null) {
      // Retirement won the root CAS before enrollment; a bound job cannot start SDK work.
      if (!job) return (await deps.storage.finishErasure(identity)) ? 'stopped' : 'pending';
      if (!providerExecutionId) throw new Error('Response retirement provider unavailable');
      await deps.jobs.abortJob(responseId, {
        expectedCreatedAt: job.createdAt,
        awaitProviderDrain: true,
        retainTerminalPersistence: true,
      });
      const current = await retiredAuthority(identity, responseId, identity);
      if (!current?.fenced || current.identity.generationCreatedAt != null)
        throw new Error('Response retirement generation changed');
      if (!current.job) return (await deps.storage.finishErasure(identity)) ? 'stopped' : 'pending';
      if (
        current.job.createdAt !== job.createdAt ||
        current.providerExecutionId !== providerExecutionId ||
        current.providerExecutionOwnerId !== providerExecutionOwnerId
      )
        throw new Error('Response retirement generation changed');
      if (
        !['complete', 'error', 'aborted'].includes(current.job.status) ||
        current.job.metadata.providerDrained !== true
      )
        return 'pending';
      if (
        !(await deps.jobs.finishProviderTerminalPersistence(
          responseId,
          job.createdAt,
          providerExecutionId,
          providerExecutionOwnerId,
        ))
      )
        throw new Error('Response terminal execution release is unavailable');
      return (await deps.storage.finishErasure(identity)) ? 'stopped' : 'pending';
    }
    if (!job) {
      if (!retired.proof) return 'pending';
      await retired.cleanup();
      await createResponseExecutionRelease(deps.jobs, deps.storage)(
        { ...identity, status: 'cancelled' },
        retired.proof,
      );
      return (await deps.storage.finishErasure(identity)) ? 'stopped' : 'pending';
    }
    if (!providerExecutionId) throw new Error('Response retirement provider unavailable');
    if (!alreadyDrained) {
      await deps.jobs.abortJob(responseId, {
        expectedCreatedAt: identity.generationCreatedAt,
        awaitProviderDrain: true,
        retainTerminalPersistence: true,
      });
    }
    // abortJob's beforePublish runs before its final drain wait. Cleanup belongs after
    // the returned drain barrier, with fresh proof for the same retained attempt.
    const drained = await retiredAuthority(identity, responseId);
    if (
      !drained ||
      drained.identity.generationCreatedAt !== identity.generationCreatedAt ||
      drained.identity.agentId !== identity.agentId ||
      drained.identity.conversationId !== identity.conversationId ||
      (drained.job &&
        (drained.providerExecutionId !== providerExecutionId ||
          drained.providerExecutionOwnerId !== providerExecutionOwnerId))
    )
      throw new Error('Response retirement generation changed');
    if (
      !drained.fenced ||
      !drained.proof ||
      (drained.job &&
        (!['complete', 'error', 'aborted'].includes(drained.job.status) ||
          drained.job.metadata.providerDrained !== true))
    )
      return 'pending';
    await drained.cleanup();
    await createResponseExecutionRelease(
      {
        getJob: deps.jobs.getJob.bind(deps.jobs),
        finishProviderTerminalPersistence: deps.jobs.finishProviderTerminalPersistence.bind(
          deps.jobs,
        ),
      },
      deps.storage,
    )(
      { ...identity, status: 'cancelled' },
      { providerExecutionId, ownerId: providerExecutionOwnerId },
    );
    return (await deps.storage.finishErasure(identity)) ? 'stopped' : 'pending';
  }
  async function recoverState(record: StoredResponseRecord): Promise<'stopped' | 'pending'> {
    const completed = await recover(record);
    if (completed.retirement)
      return (await deps.storage.finishErasure(completed)) ? 'stopped' : 'pending';
    return terminal(completed) ? 'stopped' : 'pending';
  }
  return async (owner, responseId, retained) => {
    let record = await deps.storage.requestCancellation(
      owner,
      responseId,
      (deps.now ?? Date.now)(),
    );
    const retired = await finishRetired(owner, responseId, false, retained);
    if (retired) return retired;
    if (!record) throw new Error('Response retirement identity unavailable');
    if (terminal(record)) {
      return recoverState(record);
    }
    if (record.pendingTerminal) {
      return recoverState(record);
    }
    if (record.generationCreatedAt == null) {
      const response = {
        ...buildPendingBackgroundResponse(record),
        status: 'cancelled' as const,
        completed_at: Math.floor((deps.now ?? Date.now)() / 1000),
      };
      const cancelled = await deps.storage.cancelUnstarted(record, JSON.stringify(response));
      // This CAS beats enrollment publication, which must succeed before provider startup.
      if (cancelled.ok) return recoverState(cancelled.record);
      record = await deps.storage.read(owner, responseId);
      if (!record) {
        const retired = await finishRetired(owner, responseId, false, retained);
        if (retired) return retired;
        throw new Error('Response disappeared during retirement');
      }
      if (terminal(record)) return recoverState(record);
    }
    const job = await deps.jobs.getJob(responseId);
    if (!job) return 'pending';
    if (
      record.generationCreatedAt == null ||
      job.createdAt !== record.generationCreatedAt ||
      !matchesResponseRoot(record, job.metadata) ||
      job.metadata.userId !== record.userId ||
      responseTenantId(job.metadata.tenantId) !== responseTenantId(record.tenantId) ||
      job.metadata.agent_id !== record.agentId ||
      job.metadata.endpoint !== 'responses' ||
      job.metadata.conversationId !== record.conversationId ||
      job.metadata.responseMessageId !== record.responseId
    )
      throw new Error('Response retirement generation changed');
    const executionRecord = record;
    const epoch = record.generationCreatedAt;
    const agentId = record.agentId;
    const conversationId = record.conversationId;
    const providerExecutionId = job.metadata.providerExecutionId;
    const providerExecutionOwnerId = job.metadata.providerExecutionOwnerId;
    async function isRetiredAttempt(): Promise<boolean> {
      const retired = await retiredAuthority(owner, responseId);
      if (!retired) return false;
      if (
        retired.identity.generationCreatedAt !== epoch ||
        retired.identity.agentId !== agentId ||
        retired.identity.conversationId !== conversationId ||
        retired.providerExecutionId !== providerExecutionId ||
        retired.providerExecutionOwnerId !== providerExecutionOwnerId
      )
        throw new Error('Response retirement journal changed');
      return true;
    }
    async function stageCancellation(): Promise<void> {
      const stopped = await deps.jobs.getJob(responseId);
      const proof = stopped?.metadata;
      if (
        stopped?.status !== 'aborted' ||
        !proof ||
        proof.providerDrained !== true ||
        stopped.createdAt !== epoch ||
        proof.userId !== owner.userId ||
        responseTenantId(proof.tenantId) !== responseTenantId(owner.tenantId) ||
        proof.agent_id !== agentId ||
        proof.endpoint !== 'responses' ||
        proof.responseMessageId !== responseId ||
        !matchesResponseRoot(executionRecord, proof) ||
        proof.conversationId !== conversationId ||
        proof.providerExecutionId !== providerExecutionId ||
        proof.providerExecutionOwnerId !== providerExecutionOwnerId ||
        !proof.providerExecutionId
      )
        return;
      const current = await deps.storage.read(owner, responseId);
      if (!current) {
        // The outer abort owns drain and release. Never recursively abort from this callback.
        if (await isRetiredAttempt()) return;
        throw new Error('Response retirement journal changed');
      }
      if (current.generationCreatedAt !== epoch)
        throw new Error('Response retirement journal changed');
      if (terminal(current) || current.pendingTerminal || current.preparedTerminal) return;
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
        if (!saved && (await isRetiredAttempt())) return;
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
    // Closure can win while the outer abort drains. Reuse cleanup authority,
    // without attempting to publish into the now-closed canonical scope.
    const retiredAfterDrain = await finishRetired(owner, responseId, true);
    if (retiredAfterDrain) return retiredAfterDrain;
    // Runtime publication includes provider drain and trailing writes; a missing job alone is not proof.
    let settled = await deps.storage.read(owner, responseId);
    if (settled && terminal(settled)) {
      return recoverState(settled);
    }
    if (settled?.pendingTerminal || settled?.preparedTerminal) return recoverState(settled);
    // A repeated Stop can recover a failed runtime receipt only from the exact retained,
    // aborted and drained provider. Completed jobs and absent jobs are not cancellation proof.
    await stageCancellation();
    settled = await deps.storage.read(owner, responseId);
    if (settled?.pendingTerminal || settled?.preparedTerminal) settled = await recover(settled);
    return settled && terminal(settled) ? 'stopped' : 'pending';
  };
}
