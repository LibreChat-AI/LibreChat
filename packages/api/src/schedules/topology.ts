import { GenerationJobManager } from '../stream/GenerationJobManager';
import { isEnabled } from '../utils/common';

/**
 * Whether this process may run a loop that judges other processes' runs by their generation
 * jobs: the scheduler, and the event subscriptions' run reconciler.
 *
 * v1 is single-process by design, but the standard entrypoint runs
 * `initializeScheduleEngine` in EVERY replica and nothing stops an operator from scaling
 * it. That is only safe when replicas can see each other's generations: a shared stream
 * store (Redis) gives every replica the same job view, so reconciliation and
 * deletion-time aborts reach the run's real owner. With the process-local store a peer
 * sees the globally visible `started` row but no job, and after the orphan cutoff it
 * marks a still-running generation interrupted and frees its capacity slot.
 *
 * A single replica with the in-memory store is perfectly safe, but a process cannot
 * observe its own replica count, so that case needs an explicit operator assertion.
 */
export function isTopologySafeToArm(): boolean {
  return GenerationJobManager.isRedis || isEnabled(process.env.SCHEDULES_SINGLE_PROCESS);
}
