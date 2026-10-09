/** Upper clamp for the delta-coalescing window; larger values only add UI staleness. */
const MAX_COALESCE_WINDOW_MS = 1000;
/** Coalesced-batch safety caps: a full buffer flushes immediately, ahead of the window. */
export const MAX_COALESCED_EVENTS = 64;
/** Shared raw-event JSON string-length budget, excluding transport envelopes.
 * Keep both coalescers on the same accounting basis, including for non-ASCII JSON. */
export const MAX_COALESCED_BYTES = 128 * 1024;

/**
 * Streaming-delta coalescing window shared by the Redis transport (publish
 * frames), the Redis job store (durable appends), and the generation manager
 * (hinting/backpressure). STREAM_DELTA_COALESCE_MS is deliberately the ONLY
 * source: all three read the same value, so one process cannot mix a hinting
 * manager with non-batching services or batching services with a silent
 * manager. Both sides MUST also buffer on the same window: the subscriber
 * resume frontier assumes an event is never visible in the durable chunk log
 * meaningfully earlier than its sequence lands on the shared counter, so
 * batching one side without the other reopens that race for the full window
 * instead of a same-tick skew. Unset uses 25ms; explicit 0 disables coalescing.
 */
export function resolveCoalesceWindowMs(): number {
  const raw = Number(process.env.STREAM_DELTA_COALESCE_MS ?? 25);
  if (!Number.isFinite(raw) || raw <= 0) {
    return 0;
  }
  return Math.min(Math.floor(raw), MAX_COALESCE_WINDOW_MS);
}
