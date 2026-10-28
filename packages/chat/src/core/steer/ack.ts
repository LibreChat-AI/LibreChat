import type { PendingSteer } from './types';

/** A replacement can already be submitting when an older generation's
 * delayed 202 arrives. Ordinary submission state alone would re-mint the old
 * chip after replacement reconciliation, with no old apply event left to
 * settle it. Every POST reaching here captured a non-null source epoch before
 * dispatch, so either a mismatch or a later clear proves that source
 * generation is no longer active. */
export function isSteerRunReplaced(steer: PendingSteer, activeEpoch: number | null): boolean {
  return (
    steer.generationCreatedAt != null &&
    (activeEpoch == null || steer.generationCreatedAt !== activeEpoch)
  );
}

/**
 * The chip list after a steer's 202 ACK: the local chip is swapped for its
 * server-assigned one, unless `drop` says no later SSE event will resolve it.
 * A newer local preempt label wins over the one the ACK echoes.
 */
export function acknowledgeSteerChips(
  prev: PendingSteer[],
  localId: string,
  steer: PendingSteer,
  drop: boolean,
): PendingSteer[] {
  const local = prev.find((item) => item.steerId === localId);
  let acknowledged = steer;
  if ((local?.preemptRevision ?? 0) > (steer.preemptRevision ?? 0)) {
    const { preempt: _stalePreempt, ...withoutStaleLabel } = steer;
    acknowledged = {
      ...withoutStaleLabel,
      ...(local?.preempt === true && { preempt: true }),
      preemptRevision: local?.preemptRevision,
    };
  }
  const next = prev.filter((item) => item.steerId !== localId);
  // Upsert: an SSE reconnect may have reseeded the chip under the server id
  // already; appending again would duplicate it.
  const alreadySeeded = next.some((item) => item.steerId === steer.steerId);
  return drop || alreadySeeded ? next : [...next, acknowledged];
}
