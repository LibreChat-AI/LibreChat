/** Provider-reported usage of one response, in display units (post-normalize). */
export interface BranchUsage {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
  /** Authoritative USD cost; 0 when `interface.contextCost` was off at save */
  cost: number;
  /** Whether cost coverage is COMPLETE, every usage-bearing response summed
   *  here carried a cost. Gates the cost row so a partial sum (some turns saved
   *  before cost display was on) never renders an under-reported total. Starts
   *  true (vacuous) and is ANDed; pair with `hasUsage` to require ≥1 entry. */
  costKnown: boolean;
}

export const EMPTY_USAGE: BranchUsage = {
  input: 0,
  output: 0,
  cacheWrite: 0,
  cacheRead: 0,
  cost: 0,
  costKnown: true,
};
/** Token counts come from persisted/provider payloads. Keep malformed values
 * out of every aggregate so one bad event cannot turn the meter into NaN. */
export function normalizeTokenCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.min(Math.floor(value), Number.MAX_SAFE_INTEGER)
    : 0;
}

export function hasKnownCost(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

export interface TokenEntry {
  tokenCount: number;
  /** Char/4 token estimate used in place of `tokenCount`: count-less (imported /
   *  pre-feature) message bodies, plus quoted user turns (recounted from merged
   *  text+quotes, since the send path ignores their stored count). Includes
   *  tool-call name/args/output. Mutually exclusive with a counted `tokenCount`. */
  estTokens: number;
  /** Char/4 estimate of the tool-call share of the body (tool_call parts'
   *  name/args/output), for the estimate path's "Tool calls" split. Raw, sum
   *  sites clamp it to the entry's actual contribution. */
  estToolTokens: number;
  /** Tool results are outside a counted response’s model-completion total. */
  estToolResultTokens: number;
  isCreatedByUser: boolean;
  parentMessageId: string | null;
  /** Per-response provider usage from `metadata.usage` (response messages only) */
  usage?: BranchUsage;
  /** Pre-invoke compacted context size (`metadata.summaryUsedTokens`) for a
   *  response whose turn summarized. Caps the estimate so it stops re-summing
   *  the now-discarded pre-summary history. */
  summaryUsedTokens?: number;
}

export interface BranchTotals {
  /** Sum of user-message token counts on the active branch */
  input: number;
  /** Sum of assistant-message token counts on the active branch */
  output: number;
  /** Messages on the branch with a known tokenCount */
  counted: number;
  /** Total messages on the branch */
  total: number;
  /** Uncalibrated estimate sum for count-less branch messages (imports /
   *  pre-feature). Kept separate so known counts aren't re-estimated. */
  estTokens: number;
  /** The tail (latest) message's UNCOUNTED estimate, its own `estTokens` when
   *  it has no `tokenCount`, else 0. A live tail rides on `liveTokens`, so the
   *  estimate path drops this; a resumed partial that already carries a count
   *  stays in `output`, so nothing may be dropped for it. */
  tailEstTokens: number;
  /** Tool-call share of the branch estimate (`estToolTokens`, clamped per
   *  message to its contribution), the estimate path's "Tool calls" split. */
  estToolTokens: number;
  /** The tail's clamped tool share on the same basis as `tailEstTokens`: 0 for a
   *  counted tail, so the split never drops tool traffic whose tokens the
   *  message total keeps. */
  tailEstToolTokens: number;
  tailId: string | null;
  /** Whether the latest run's anchor message is on this branch */
  containsAnchor: boolean;
  /** Provider usage/cost summed along the active branch */
  usage: BranchUsage;
  /** Recorded usage of the selected response, never an earlier ancestor's usage. */
  lastTurnUsage?: BranchUsage;
  /** Compacted-context baseline from the deepest summarized response on the
   *  branch (0 if none). The branch walk stops there, so `input`/`output` cover
   *  only the post-summary messages; the estimate adds this to avoid counting
   *  the discarded pre-summary history. */
  summaryBaseline: number;
}

export const EMPTY_BRANCH: BranchTotals = {
  input: 0,
  output: 0,
  counted: 0,
  total: 0,
  estTokens: 0,
  tailEstTokens: 0,
  estToolTokens: 0,
  tailEstToolTokens: 0,
  tailId: null,
  containsAnchor: false,
  usage: EMPTY_USAGE,
  summaryBaseline: 0,
};
