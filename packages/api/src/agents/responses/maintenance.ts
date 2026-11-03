import { responseReference } from '@librechat/data-schemas';
import type {
  ResponseStorage,
  StoredResponseRecord,
  ResponseExecutionProof,
} from '@librechat/data-schemas';
import type { GenerationJobManagerClass } from '~/stream/GenerationJobManager';
import type { ResponseCompletion } from './completion';
import { readResponseExecutionProof, createResponseExecutionRelease } from './completion';
import { buildPendingBackgroundResponse } from './background';
import { matchesResponseJob } from './scope';

/** Repair the existing journal from positive execution evidence; never rerun a provider. */
export function createResponseRecovery(deps: {
  storage: ResponseStorage;
  jobs: Pick<GenerationJobManagerClass, 'getJob' | 'finishProviderTerminalPersistence'>;
  completion: ResponseCompletion;
  now?: () => number;
}) {
  const release = createResponseExecutionRelease(deps.jobs, deps.storage);
  return async (record: StoredResponseRecord): Promise<StoredResponseRecord | null> => {
    if (
      record.persistenceFailure ||
      record.preparedTerminal ||
      record.pendingTerminal ||
      ['completed', 'failed', 'incomplete', 'cancelled'].includes(record.status)
    ) {
      const completed = await deps.completion.finish(record);
      return completed.retirement ? null : completed;
    }

    let outcome: 'complete' | 'error' | 'aborted';
    let binding: ResponseExecutionProof;
    const job = await deps.jobs.getJob(record.responseId);
    const unstarted = record.generationCreatedAt == null || record.resume?.state === 'admitted';
    if (
      unstarted &&
      job &&
      (job.status === 'complete' || job.status === 'error' || job.status === 'aborted')
    ) {
      if (!matchesResponseJob(record, job))
        throw new Error('Response recovery execution identity changed');
      if (
        job.metadata.providerDrained !== true ||
        job.metadata.providerExecutionStartedId != null ||
        !job.metadata.providerExecutionId ||
        (record.resume && job.metadata.providerExecutionId !== record.resume.providerExecutionId)
      )
        return record;
      outcome = job.status;
      binding = {
        generationCreatedAt: job.createdAt,
        providerExecutionId: job.metadata.providerExecutionId,
        ...(job.metadata.providerExecutionOwnerId
          ? { ownerId: job.metadata.providerExecutionOwnerId }
          : {}),
      };
      if (record.generationCreatedAt != null) {
        const enrolled = await deps.storage.enrollExecution(
          record,
          binding,
          record.responseJSON ?? '{}',
        );
        if (!enrolled.ok) return deps.storage.read(record, record.responseId);
        record = enrolled.record;
        if (!(await deps.storage.settleExecution(responseReference(record), binding, outcome)))
          return record;
      }
    } else {
      if (record.generationCreatedAt == null) return record;
      const proof = await readResponseExecutionProof(deps.storage, deps.jobs, record);
      if (!proof?.outcome) return record;
      outcome = proof.outcome;
      binding = proof;
    }
    const status =
      record.cancellationRequestedAt != null || outcome === 'aborted' ? 'cancelled' : 'failed';
    const responseJSON = JSON.stringify({
      ...buildPendingBackgroundResponse(record),
      status,
      completed_at: Math.floor((deps.now ?? Date.now)() / 1000),
      error:
        status === 'cancelled'
          ? null
          : {
              type: 'server_error',
              code: 'execution_failed',
              message: 'The Agent could not complete this request.',
            },
    });
    if (record.generationCreatedAt == null) {
      const result = await deps.storage.finishUnstartedExecution(
        record,
        { ...binding, outcome },
        status,
        responseJSON,
      );
      if (!result.ok) return deps.storage.read(record, record.responseId);
      await release(result.record, binding);
      return result.record;
    }
    // A late prepared result or Stop may win this CAS. Leave its receipt to the
    // same completion owner instead of replacing it with a missing-result failure.
    const staged = await deps.storage.stageTerminal(
      record,
      record.responseId,
      { execution: record },
      {
        ...binding,
        status,
        responseJSON,
      },
    );
    if (!staged.ok) return deps.storage.read(record, record.responseId);
    const completed = await deps.completion.finish(staged.record);
    return completed.retirement ? null : completed;
  };
}
