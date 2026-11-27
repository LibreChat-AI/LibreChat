/** Maximum time Redis delivery may buffer an out-of-order event. */
export const REDIS_EVENT_REORDER_TIMEOUT_MS = 500;

/** Maximum time a replacement waits for its exact generation owner to
 * acknowledge an abort before it falls back to durable proof. */
export const REDIS_ABORT_ACK_TIMEOUT_MS = 3_000;

/** A replacement publishes predecessor DONE only after abort confirmation.
 * Preserve the captured subscriber for that full acknowledgement budget plus
 * the DONE reorder window and an equal scheduling/Redis settlement margin. */
export const REDIS_ABORT_TERMINAL_GRACE_MS =
  REDIS_ABORT_ACK_TIMEOUT_MS + REDIS_EVENT_REORDER_TIMEOUT_MS * 2;

/** Maximum time spent inspecting a durable replacement handoff. One final
 * event-reordering grace may follow before the captured subscriber is recycled. */
export const REDIS_REPLACEMENT_HANDOFF_MAX_WAIT_MS = 30_000;
