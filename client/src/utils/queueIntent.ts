/**
 * Cross-hook arbitration for the client-side message queue, deliberately held
 * OUTSIDE React state.
 *
 * Two independent surfaces decide whether to submit a queued message: the
 * run-end drain (`useQueueDrain`) and the rail's own actions (`useSteering`).
 * Both read `isSubmitting`, which Recoil only makes readable a render after
 * `ask()` was called, so within one browser task each can observe an idle pane
 * and submit the same slot. A ref belongs to a single hook instance and Recoil
 * is asynchronous, so neither can arbitrate; a module-scoped registry read and
 * written synchronously can.
 */

/** Opaque proof of ownership: a holder can only release the lock it took. */
export type QueueSendLock = {
  readonly pane: string;
  readonly takenAt: number;
};

/**
 * Last-resort expiry, never the normal release path.
 *
 * A claim is given up as soon as the pane's submission state moves, which for
 * the ordinary agents start happens synchronously inside `ask`. A start that
 * hard-fails without ever setting `isSubmitting` leaves nothing to observe, and
 * without an expiry that claim would sit on the pane until the user navigated
 * away. Far longer than any healthy start takes to become observable, so it can
 * only ever fire on a claim that is already broken; when it does, the pane
 * simply degrades to the unguarded behaviour rather than latching shut.
 */
const STALE_SEND_LOCK_MS = 60_000;

const sendLocks = new Map<string, QueueSendLock>();

/**
 * Claims a pane's submission slot for one queued send. Returns `null` when a
 * send is already in flight there, in which case the caller must NOT submit.
 */
export function acquireQueueSendLock(pane: string): QueueSendLock | null {
  const held = sendLocks.get(pane);
  if (held != null && Date.now() - held.takenAt < STALE_SEND_LOCK_MS) {
    return null;
  }
  const lock: QueueSendLock = { pane, takenAt: Date.now() };
  sendLocks.set(pane, lock);
  return lock;
}

/**
 * Releases a lock only while it is still the one held, so a late release
 * cannot free a slot some other caller has since claimed.
 */
export function releaseQueueSendLock(lock: QueueSendLock | null | undefined): void {
  if (lock != null && sendLocks.get(lock.pane) === lock) {
    sendLocks.delete(lock.pane);
  }
}

const queuedIntents = new Set<string>();

/**
 * Marks a queued row as spoken for while the user edits or removes it. The
 * handoff spans an await (discarding the parked server copy, then handing the
 * words to the composer) and the run-end drain can land inside that gap, which
 * would send the very message being taken back.
 *
 * Returns `false` when another intent already holds the row, so a second
 * click leaves it alone rather than racing the first.
 */
export function claimQueuedIntent(id: string): boolean {
  if (queuedIntents.has(id)) {
    return false;
  }
  queuedIntents.add(id);
  return true;
}

export function releaseQueuedIntent(id: string): void {
  queuedIntents.delete(id);
}

/** Whether a queued row is mid-edit or mid-remove; the drain skips those. */
export function hasQueuedIntent(id: string): boolean {
  return queuedIntents.has(id);
}
