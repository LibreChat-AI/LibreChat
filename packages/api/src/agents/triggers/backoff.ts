/** How long a deferred delivery may wait before re-checking a condition nobody has
 * announced a change to. Matches the delivery engine's floor for readiness deferrals. */
export const WAITING_RETRY_FLOOR_MS = 5_000;
export const WAITING_RETRY_CAP_MS = 60_000;
const WAITING_RETRY_AGE_FRACTION = 0.1;

/**
 * Seconds until a waiting delivery re-checks readiness: a tenth of how long it
 * has waited, between the engine's five-second floor and the cap. Producers
 * expedite the delivery the moment its condition changes (a result becoming
 * durable, a generation settling), so this only bounds re-reads while nothing
 * has changed. Without it every pending delivery is re-claimed every five
 * seconds for as long as its tool runs or its conversation stays busy.
 */
export function waitingRetryAfter(
  waitingSinceMs: number,
  nowMs: number = Date.now(),
  capMs: number = WAITING_RETRY_CAP_MS,
): string {
  const waitedMs = Number.isFinite(waitingSinceMs) ? Math.max(0, nowMs - waitingSinceMs) : 0;
  const delayMs = Math.min(
    capMs,
    Math.max(WAITING_RETRY_FLOOR_MS, waitedMs * WAITING_RETRY_AGE_FRACTION),
  );
  return String(Math.ceil(delayMs / 1_000));
}
