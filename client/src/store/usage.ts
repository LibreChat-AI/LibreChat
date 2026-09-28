import { atomFamily } from 'jotai/utils';
import { atom, getDefaultStore } from 'jotai';
import type { TMessage, TContextUsageEvent } from 'librechat-data-provider';
import type { BranchTotals, BranchUsage } from '~/utils/tokens';
import { EMPTY_BRANCH, EMPTY_USAGE } from '~/utils/tokens';
import { createStorageAtom } from './jotai-utils';

/** Sticky preference: does the context popover open with the breakdown showing?
 *  The gauge alone is the default; a user who wants the detail sets it once. */
export const contextBreakdownExpandedAtom = createStorageAtom<boolean>(
  'contextBreakdownExpanded',
  false,
);

/** Latest backend context snapshot, anchored to the run's user message for staleness checks */
export interface ContextSnapshot extends TContextUsageEvent {
  anchorMessageId: string | null;
  /** Output tokens finalized after this pre-call snapshot (the last call's response) */
  completedOutputTokens?: number;
}

/**
 * In-flight usage for the streaming response only — a single-response pending
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
  /** Whether cost coverage is complete — every folded event carried a cost
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

/**
 * Split into small per-conversation atoms so high-frequency writes (live
 * stream estimates) re-render only the subscribers that draw them.
 */
export const branchTotalsFamily = atomFamily((_conversationId: string) =>
  atom<BranchTotals>(EMPTY_BRANCH),
);

export const contextSnapshotFamily = atomFamily((_conversationId: string) =>
  atom<ContextSnapshot | null>(null),
);

/**
 * Finalized snapshots keyed by their (branch-unique) response message id.
 * `contextSnapshotFamily` only holds the latest run; this retains each
 * generation's breakdown so switching to a branch generated earlier this
 * session keeps its granular rows instead of dropping to coarse totals.
 * Bounded by the conversation's generation count; cleared on convo switch.
 */
export const snapshotsByAnchorFamily = atomFamily((_conversationId: string) =>
  atom<Map<string, ContextSnapshot>>(new Map()),
);

/** In-flight usage of the streaming response; flushed into the index at finalize. */
export const pendingUsageFamily = atomFamily((_conversationId: string) =>
  atom<UsageTotals>(EMPTY_USAGE_TOTALS),
);

/** Provider usage/cost summed across all branches of the conversation. */
export const totalUsageFamily = atomFamily((_conversationId: string) =>
  atom<BranchUsage>(EMPTY_USAGE),
);

/** Throttled in-flight output token estimate for the current model call */
export const liveTokensFamily = atomFamily((_conversationId: string) => atom<number>(0));

/**
 * Subagent model calls COMMITTED to the conversation, accumulated from
 * `usage_type: 'subagent'` events once their run settles. Deliberately excluded
 * from branch/total provider usage (they bill separately and would double-count
 * a turn), so they surface as their own Totals row. Session-scoped: not
 * persisted, cleared on convo switch.
 */
export const subagentUsageFamily = atomFamily((_conversationId: string) =>
  atom<BranchUsage>(EMPTY_USAGE),
);

/**
 * The in-flight run's subagent share, held beside `pendingUsageFamily` and
 * settled with it: committed into `subagentUsageFamily` when the response is
 * finalized or a stop is attributed, discarded when the run ends with no
 * salvageable response. Committing on arrival instead would leave a failed
 * run's subagent tokens in the Totals after its usage was discarded from every
 * rollup they are a subset of, and would count them twice when a resume
 * re-folds the same events.
 */
export const pendingSubagentUsageFamily = atomFamily((_conversationId: string) =>
  atom<BranchUsage>(EMPTY_USAGE),
);

/** Last known provider-vs-estimate calibration ratio for the conversation */
export const calibrationFamily = atomFamily((_conversationId: string) => atom<number>(1));

/**
 * Per-conversation set of usage-event identities already folded into the
 * totals. Lets the live path and resume backfill fold each model call exactly
 * once, so reconnect mid-stream preserves earlier prompts' usage instead of
 * resetting the session totals.
 */
const foldedUsageKeys = new Map<string, Set<string>>();

/** Records an event identity; returns false if it was already folded. */
export function markUsageFolded(conversationId: string, key: string): boolean {
  let seen = foldedUsageKeys.get(conversationId);
  if (seen == null) {
    seen = new Set<string>();
    foldedUsageKeys.set(conversationId, seen);
  }
  if (seen.has(key)) {
    return false;
  }
  seen.add(key);
  return true;
}

/** Moves folded-key tracking from a temporary convo id to the persisted one. */
export function migrateUsageFolded(fromId: string, toId: string): void {
  const seen = foldedUsageKeys.get(fromId);
  if (seen == null) {
    return;
  }
  const target = foldedUsageKeys.get(toId) ?? new Set<string>();
  for (const key of seen) {
    target.add(key);
  }
  foldedUsageKeys.set(toId, target);
  foldedUsageKeys.delete(fromId);
}

/**
 * Forgets a conversation's folded usage-event identities so a subsequent resume
 * can re-fold them. Used when a terminal close discards the in-flight pending
 * usage: `backfillUsage` would otherwise treat the persisted events as already
 * folded and never rebuild pending after a navigate-away-then-resume.
 */
export function clearUsageFolded(conversationId: string): void {
  foldedUsageKeys.delete(conversationId);
}

/**
 * Per-agent/model instruction+tool overhead — the system prompt + tool-schema
 * tokens the next call always sends — cached from the breakdown the live
 * `ON_CONTEXT_USAGE` event emits. Keyed by agent/model (NOT per conversation),
 * so a snapshot-less branch (import / never-generated) can reuse the overhead
 * once the same agent has run anywhere this session, making its prune budget and
 * gauge account for the fixed overhead the client can't otherwise know. Never
 * cleared on convo switch; bounded by the number of distinct configs used.
 */
const modelOverhead = new Map<string, number>();

/** Stable cache key the writer (usage handler) and reader (estimate) build
 *  identically. An agent resolves to its real provider/model only after its data
 *  loads, so the reader (resolved) and writer (raw `agents` submission) would key
 *  differently — key by `agentId` when present so both agree; non-agent configs
 *  key by endpoint:model. */
export function overheadKey(
  endpoint?: string | null,
  model?: string | null,
  agentId?: string | null,
): string {
  if (agentId != null && agentId !== '') {
    return `agent:${agentId}`;
  }
  return `${endpoint ?? ''}::${model ?? ''}`;
}

export function setModelOverhead(key: string, tokens: number): void {
  if (tokens > 0) {
    modelOverhead.set(key, tokens);
  }
}

export function getModelOverhead(key: string): number {
  return modelOverhead.get(key) ?? 0;
}

/** Jotai atomFamily entries are never GC'd — call on conversation switch/cleanup */
export function removeUsageAtoms(conversationId: string): void {
  branchTotalsFamily.remove(conversationId);
  contextSnapshotFamily.remove(conversationId);
  snapshotsByAnchorFamily.remove(conversationId);
  pendingUsageFamily.remove(conversationId);
  totalUsageFamily.remove(conversationId);
  liveTokensFamily.remove(conversationId);
  subagentUsageFamily.remove(conversationId);
  pendingSubagentUsageFamily.remove(conversationId);
  calibrationFamily.remove(conversationId);
  foldedUsageKeys.delete(conversationId);
}

/**
 * Rehydrates per-branch context breakdowns from persisted `metadata.contextUsage`
 * into the snapshot-history map so the granular gauge survives a reload / opening
 * an existing conversation. Merges, never clobbers — a live finalized snapshot
 * for the same response id wins. Re-anchors each blob to its (branch-unique)
 * response message id and reads the response's `tokenCount` as completed output.
 */
export function hydrateSnapshots(conversationId: string, messages?: TMessage[] | null): void {
  if (messages == null || messages.length === 0) {
    return;
  }
  const store = getDefaultStore();
  const historyAtom = snapshotsByAnchorFamily(conversationId);
  const current = store.get(historyAtom);
  let next: Map<string, ContextSnapshot> | null = null;
  for (const message of messages) {
    const id = message?.messageId;
    if (!id || current.has(id)) {
      continue;
    }
    const blob = message.metadata?.contextUsage;
    if (blob == null || typeof blob !== 'object') {
      continue;
    }
    const event = blob as TContextUsageEvent;
    /** Use ONLY the persisted post-snapshot delta (the final call's output). Do
     *  NOT fall back to the full response `tokenCount`: the snapshot already
     *  counts earlier steps' output for multi-call turns, so adding the whole
     *  tokenCount would double-count after reload. Absent (rare: no usage event)
     *  contributes 0, matching the snapshot's pre-final-call base. */
    const snapshot: ContextSnapshot = {
      ...event,
      anchorMessageId: id,
      completedOutputTokens: event.completedOutputTokens,
    };
    next ??= new Map(current);
    next.set(id, snapshot);
  }
  if (next != null) {
    store.set(historyAtom, next);
  }
}
