import type { TMessage } from 'librechat-data-provider';
import type { PendingSteer, QueuedMessageOrigin } from './types';
import type { GenerationProtocolVersion } from '../protocol';
import type { SteerCarriedContext } from './steer';
import { getSteerErrorCode, isDefiniteSteerRejection } from './errors';
import { supportsGenerationProtocolV2 } from '../protocol';

/** Everything one steer submission keeps constant across the chips it mints:
 * the optimistic one, the acknowledged one, and every failure or recovery
 * state, so a later conversion restores the same words, files and context. */
export type SteerAttempt = {
  localId: string;
  text: string;
  createdAt: number;
  files?: TMessage['files'];
  generationCreatedAt?: number;
  generationProtocolVersion: GenerationProtocolVersion;
  queuedOrigin?: QueuedMessageOrigin;
  carried: SteerCarriedContext;
};

/** A chip for this attempt in the given state. Callers add the fields that
 * differ by state (preempt label, delivery uncertainty, server correlation). */
export function steerAttemptChip(
  attempt: SteerAttempt,
  chip: Pick<PendingSteer, 'steerId' | 'status'> & Partial<PendingSteer>,
): PendingSteer {
  return {
    text: attempt.text,
    createdAt: attempt.createdAt,
    ...(attempt.files && { files: attempt.files }),
    ...(attempt.generationCreatedAt != null && {
      generationCreatedAt: attempt.generationCreatedAt,
    }),
    generationProtocolVersion: attempt.generationProtocolVersion,
    ...(attempt.queuedOrigin && { queuedOrigin: attempt.queuedOrigin }),
    ...attempt.carried,
    ...chip,
  };
}

/**
 * What a failed steer POST means for its words:
 * - `send-after-run`: the run ended first; send as a new turn once the pane is
 *   free, else put the words back in the queue.
 * - `send-when-idle`: the run refused steering; send now when idle, otherwise
 *   queue them and say so.
 * - `requeue`: a newer generation owns the conversation; never replace it.
 * - `failed`: a definite rejection; the chip keeps its ordinary controls.
 * - `uncertain`: delivery is unknown; the chip locks until ownership resolves.
 */
export type SteerFailureRoute =
  | 'send-after-run'
  | 'send-when-idle'
  | 'requeue'
  | 'failed'
  | 'uncertain';

export function routeSteerFailure(
  error: unknown,
  generationProtocolVersion: GenerationProtocolVersion,
): SteerFailureRoute {
  const code = getSteerErrorCode(error);
  if (code === 'NO_ACTIVE_RUN') {
    return 'send-after-run';
  }
  if (code === 'RUN_PAUSED' || code === 'STEER_UNSUPPORTED' || code === 'STEER_QUEUE_FULL') {
    return 'send-when-idle';
  }
  const errorData = (error as { response?: { data?: unknown } } | undefined)?.response?.data;
  if (
    code === 'RUN_REPLACED' &&
    generationProtocolVersion === 2 &&
    supportsGenerationProtocolV2(errorData)
  ) {
    return 'requeue';
  }
  return isDefiniteSteerRejection(error) ? 'failed' : 'uncertain';
}
