import type { TContextUsageEvent } from 'librechat-data-provider';

/** Latest backend context snapshot, anchored to the run's user message for staleness checks */
export interface ContextSnapshot extends TContextUsageEvent {
  anchorMessageId: string | null;
  /** Response owning a live snapshot; user-message anchors are shared by siblings. */
  responseMessageId?: string | null;
  /** Output tokens finalized after this pre-call snapshot (the last call's response) */
  completedOutputTokens?: number;
}

/**
 * In-flight usage for the streaming response only, a single-response pending
 * holder. `foldUsage` accumulates the current response's `on_token_usage`
 * events here; `finalizeUsage` flushes it into the per-message index and resets
 * it. Branch/total figures are otherwise derived by summing the index, so this
 * is the only live add (counted exactly once at finalize).
 */
export interface UsageTotals {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
  eventCount: number;
  /** Summed authoritative per-event cost from the backend (premium tiers,
   *  cache rates). Populated only when `interface.contextCost` is enabled. */
  costUSD: number;
  /** Whether cost coverage is complete, every folded event carried a cost
   *  (ANDed, vacuously true when empty); gates the cost row. */
  costKnown: boolean;
}

export const EMPTY_USAGE_TOTALS: UsageTotals = {
  input: 0,
  output: 0,
  cacheWrite: 0,
  cacheRead: 0,
  eventCount: 0,
  costUSD: 0,
  costKnown: true,
};
