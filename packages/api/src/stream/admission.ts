import { logger } from '@librechat/data-schemas';
import type { GenerationPredecessorState, JobStatus } from './interfaces/IJobStore';
import { JobPredecessorMismatchError } from './interfaces/IJobStore';
import { getSafeErrorText } from '../utils/errors';

const PREDECESSOR_MISMATCH_CODE: JobPredecessorMismatchError['code'] =
  'GENERATION_PREDECESSOR_MISMATCH';

export interface GenerationStartFailureContext {
  streamId: string;
  conversationId: string;
  /** Automatic continuation (trigger delivery, wake-up, queued turn); an active
   * winner answers it with a deferrable `PARENT_NOT_READY`. */
  continuation: boolean;
  expectedPredecessorCreatedAt?: number;
}

type PredecessorMismatchState = Partial<GenerationPredecessorState>;

function isJobStatus(value: unknown): value is JobStatus {
  return (
    value === 'running' ||
    value === 'requires_action' ||
    value === 'complete' ||
    value === 'error' ||
    value === 'aborted'
  );
}

/** Matches by `code` as well as class, mirroring how the controller selects its
 * 409 response, so the log level and the response never disagree. */
function getPredecessorMismatchState(error: unknown): PredecessorMismatchState | undefined {
  if (error instanceof JobPredecessorMismatchError) {
    return error.currentJob;
  }
  if (error == null || typeof error !== 'object' || !('code' in error)) {
    return undefined;
  }
  if (error.code !== PREDECESSOR_MISMATCH_CODE) {
    return undefined;
  }
  const currentJob = 'currentJob' in error ? error.currentJob : undefined;
  if (currentJob == null || typeof currentJob !== 'object') {
    return {};
  }
  const createdAt = 'createdAt' in currentJob ? currentJob.createdAt : undefined;
  const active = 'active' in currentJob ? currentJob.active : undefined;
  const verified = 'verified' in currentJob ? currentJob.verified : undefined;
  const status = 'status' in currentJob ? currentJob.status : undefined;
  return {
    ...(typeof createdAt === 'number' && { createdAt }),
    ...(typeof active === 'boolean' && { active }),
    ...(typeof verified === 'boolean' && { verified }),
    ...(isJobStatus(status) && { status }),
  };
}

/**
 * Logs why a resumable generation failed to start.
 *
 * A predecessor-fence rejection is an expected admission outcome, not a fault:
 * the store refused before replacing anything, an automatic continuation defers
 * without consuming an attempt, and a client restores its queued turn. Sibling
 * background-tool wake-ups for one conversation race this fence by design, so it
 * logs a concise warning. Every other initialization failure stays an error.
 */
export function logGenerationStartFailure(
  error: unknown,
  context: GenerationStartFailureContext,
): void {
  const currentJob = getPredecessorMismatchState(error);
  if (currentJob === undefined) {
    logger.error(`[ResumableAgentController] Initialization error: ${getSafeErrorText(error)}`);
    return;
  }
  const active =
    typeof currentJob.active === 'boolean'
      ? currentJob.active
      : currentJob.status === 'running' || currentJob.status === 'requires_action';
  logger.warn('[ResumableAgentController] Generation predecessor changed before creation', {
    streamId: context.streamId,
    conversationId: context.conversationId,
    continuation: context.continuation,
    active,
    ...(context.expectedPredecessorCreatedAt != null && {
      expectedPredecessorCreatedAt: context.expectedPredecessorCreatedAt,
    }),
    ...(currentJob.createdAt != null && { currentCreatedAt: currentJob.createdAt }),
    ...(currentJob.status != null && { currentStatus: currentJob.status }),
    ...(currentJob.verified === false && { verified: false }),
  });
}
