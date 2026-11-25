import { Constants } from 'librechat-data-provider';
import type { TContextUsageEvent, TTokenBudgetBreakdown } from 'librechat-data-provider';
import {
  BranchTotals,
  BranchUsage,
  EMPTY_BRANCH,
  EMPTY_USAGE,
  TokenEntry,
  normalizeTokenCount,
} from './types';
import { addUsage, registry, usageHistory } from './registry';

/** O(depth) walk from the branch tail up the parent chain */
export function sumBranch(
  conversationId: string,
  tailId: string | null | undefined,
  anchorId?: string | null,
): BranchTotals {
  const index = registry.get(conversationId);
  if (!index || !tailId) {
    return EMPTY_BRANCH;
  }

  const totals = {
    input: 0,
    output: 0,
    counted: 0,
    total: 0,
    estTokens: 0,
    estToolTokens: 0,
    containsAnchor: false,
  };
  /** The in-flight response, when streaming, is the branch tail and is covered
   *  by `liveTokens`; expose its estimate so the estimate path can drop it. A
   *  tail that already carries a `tokenCount` (a resumed partial response) is
   *  counted in `input`/`output` instead, and its tool share is inside
   *  `estToolTokens` clamped to that count, dropping either would leave the
   *  message total holding tokens whose tool share had been removed, so both
   *  tail figures are zero for a counted tail. */
  const tailEntry = index.get(tailId);
  const lastTurnUsage = tailEntry?.isCreatedByUser === false ? tailEntry.usage : undefined;
  const tailCounted = tailEntry != null && tailEntry.tokenCount > 0;
  const tailEstTokens = tailCounted ? 0 : (tailEntry?.estTokens ?? 0);
  const tailEstToolTokens = tailCounted
    ? 0
    : Math.min(tailEntry?.estToolTokens ?? 0, tailEntry?.estTokens ?? 0);
  let summaryBaseline = 0;
  const usage: BranchUsage = { ...EMPTY_USAGE };
  /** Once a summary marker is crossed, older turns are out of the CONTEXT WINDOW
   *  (subsumed by the baseline), but their provider spend still happened, so the
   *  usage/cost walk continues to the root while context counting stops. */
  let contextCapped = false;
  let currentId: string | null = tailId;
  let guard = index.size;

  while (currentId && currentId !== Constants.NO_PARENT && guard-- > 0) {
    const entry: TokenEntry | undefined = index.get(currentId);
    if (!entry) {
      break;
    }
    totals.total += 1;
    /** Only match the anchor while still inside the active context window. An
     *  anchor OLDER than the deepest summary marker belongs to a pre-summary
     *  snapshot; treating it as on-branch would let `useTokenUsage` revive that
     *  stale breakdown (discarded history) over the summary-baseline estimate
     *  that `findBranchSnapshotAnchor` correctly refuses to recover. */
    if (!contextCapped && anchorId != null && currentId === anchorId) {
      totals.containsAnchor = true;
    }
    if (!contextCapped && entry.tokenCount > 0) {
      totals.counted += 1;
      if (entry.isCreatedByUser) {
        totals.input += entry.tokenCount;
      } else {
        totals.output += entry.tokenCount;
      }
    } else if (!contextCapped && entry.estTokens > 0) {
      totals.estTokens += entry.estTokens;
    }
    /** Tool-call share of this entry's contribution, a subset of the
     *  input/output/estimated rows, so it never adds to the gauge. */
    if (!contextCapped) {
      const contribution = entry.tokenCount > 0 ? entry.tokenCount : entry.estTokens;
      totals.estToolTokens += Math.min(entry.estToolTokens, contribution);
    }
    /** Cost/usage is cumulative spend, never truncated at the summary boundary. */
    addUsage(usage, entry.usage);
    /** This response's turn compacted the history: its own output is counted
     *  above; record the pre-invoke compacted baseline and stop counting context
     *  tokens for older (summarized-away) turns, but keep walking for cost. */
    if (!contextCapped && entry.summaryUsedTokens != null) {
      summaryBaseline = entry.summaryUsedTokens;
      contextCapped = true;
    }
    currentId = entry.parentMessageId;
  }

  return {
    ...totals,
    tailEstTokens,
    tailEstToolTokens,
    tailId,
    usage,
    lastTurnUsage,
    summaryBaseline,
  };
}

/**
 * Message tokens that would actually be sent for an over-window branch. The send
 * path prunes oldest-first to fit (`getMessagesWithinTokenLimit`), so walk the
 * branch newest→oldest and stop once the next message would exceed `budget`,
 * mirroring its "newest-that-fits" behavior for the gauge. Approximation: it omits
 * the instruction/tool-schema overhead and tool-call pairing the real pruner also
 * accounts for, which the client can't know for a snapshot-less branch, close
 * enough for an estimate, and superseded by an exact snapshot once generated.
 * `budget` is the message window (max minus the always-sent summary baseline);
 * when `excludeTail`, the in-flight tail response is skipped (it rides on
 * `liveTokens`). Per-message contribution matches `sumBranch`: stored `tokenCount`
 * when counted, else the char-based `estTokens`. Returns the kept total plus the
 * tool-call share of what was kept, so the estimate can split the Messages row.
 */
export function prunedBranchTokens(
  conversationId: string,
  tailId: string | null | undefined,
  budget: number,
  excludeTail: boolean,
): { tokens: number; toolTokens: number } {
  const index = registry.get(conversationId);
  if (!index || !tailId || budget <= 0) {
    return { tokens: 0, toolTokens: 0 };
  }

  let total = 0;
  let toolTotal = 0;
  let currentId: string | null = tailId;
  let guard = index.size;
  let isTail = true;

  while (currentId && currentId !== Constants.NO_PARENT && guard-- > 0) {
    const entry: TokenEntry | undefined = index.get(currentId);
    if (!entry) {
      break;
    }
    const skip = isTail && excludeTail;
    isTail = false;
    if (!skip) {
      const contribution = entry.tokenCount > 0 ? entry.tokenCount : entry.estTokens;
      if (total + contribution > budget) {
        break;
      }
      total += contribution;
      toolTotal += Math.min(entry.estToolTokens, contribution);
    }
    /** Pre-summary turns are subsumed by the baseline the caller already reserved,
     *  so stop after counting the summarizing turn, mirrors `sumBranch`. */
    if (entry.summaryUsedTokens != null && entry.summaryUsedTokens > 0) {
      break;
    }
    currentId = entry.parentMessageId;
  }
  return { tokens: total, toolTokens: toolTotal };
}

/**
 * One persisted snapshot's used-context reading, with the basis it was measured
 * on. `remaining` is the authoritative pre-invoke figure (`budget − remaining`);
 * `breakdown` is the instructions+summary+messages sum a snapshot saved before
 * `remainingContextTokens` existed still supports. The two measure different
 * quantities (the backend's remaining covers content the breakdown does not),
 * so a growth delta may only compare readings of the same basis.
 */
export interface AnchorReading {
  used: number;
  basis: 'remaining' | 'breakdown';
  configuration?: string;
}

/** Compare the measured call configuration, including fixed prompt overhead.
 * Older snapshots without call identity cannot establish comparability. */
export function snapshotConfiguration(
  snapshot: Pick<TContextUsageEvent, 'model' | 'provider' | 'agentId' | 'contextBudget'> & {
    breakdown?: Partial<TTokenBudgetBreakdown>;
  },
): string | undefined {
  if (!snapshot.model || !snapshot.provider) {
    return undefined;
  }
  return JSON.stringify([
    snapshot.model,
    snapshot.provider,
    snapshot.agentId,
    snapshot.contextBudget ?? snapshot.breakdown?.maxContextTokens,
    snapshot.breakdown?.instructionTokens,
    snapshot.breakdown?.toolSchemaTokens,
  ]);
}

/**
 * Used-token readings for every persisted snapshot on the viewed branch, oldest
 * → newest (the walk is tail→root, so results are reversed). Drives the growth
 * sparkline and the runway projection in the breakdown. Stops after a summarized
 * response, older snapshots describe discarded history, mirroring `sumBranch`.
 * A snapshot that carries neither basis is skipped rather than reported as
 * having consumed its entire budget.
 */
export function collectAnchorSeries(
  conversationId: string,
  tailId: string | null | undefined,
  anchors: ReadonlyMap<string, unknown>,
): AnchorReading[] {
  const index = registry.get(conversationId);
  if (!index || !tailId || anchors.size === 0) {
    return [];
  }

  const series: AnchorReading[] = [];
  let currentId: string | null = tailId;
  let guard = index.size;

  while (currentId && currentId !== Constants.NO_PARENT && guard-- > 0) {
    const entry: TokenEntry | undefined = index.get(currentId);
    if (!entry) {
      break;
    }
    const snapshot = anchors.get(currentId) as
      | (Partial<Omit<TContextUsageEvent, 'breakdown'>> & {
          breakdown?: Partial<TTokenBudgetBreakdown>;
        })
      | undefined;
    if (snapshot != null) {
      const budget = normalizeTokenCount(
        snapshot.contextBudget ?? snapshot.breakdown?.maxContextTokens,
      );
      const configuration = snapshotConfiguration(snapshot);
      /** Runway growth keeps the raw remaining basis, even if the gauge floors
       *  that reading to the breakdown; older snapshots use all breakdown parts. */
      if (snapshot.remainingContextTokens != null && budget > 0) {
        const remaining = normalizeTokenCount(snapshot.remainingContextTokens);
        series.push({ used: Math.max(0, budget - remaining), basis: 'remaining', configuration });
      } else {
        const used =
          normalizeTokenCount(
            snapshot.effectiveInstructionTokens ?? snapshot.breakdown?.instructionTokens,
          ) +
          normalizeTokenCount(snapshot.breakdown?.summaryTokens) +
          normalizeTokenCount(snapshot.breakdown?.messageTokens);
        if (used > 0) {
          series.push({ used, basis: 'breakdown', configuration });
        }
      }
    }
    if (entry.summaryUsedTokens != null && entry.summaryUsedTokens > 0) {
      break;
    }
    currentId = entry.parentMessageId;
  }
  return series.reverse();
}

/**
 * Tokens of the most recent exchange (the tail response plus the user turn it
 * answers), what a summarization would KEEP. `excludeTail` skips an in-flight
 * tail (it rides on `liveTokens`), leaving the previous complete exchange.
 * The compaction preview is context tokens minus this.
 *
 * `summaryOutputTokens` removes an internal summarization's completion from a
 * tail whose turn compacted: the backend folds that pass into the response's
 * `tokenCount`, while the snapshot keeps it in `breakdown.summaryTokens` rather
 * than `messageTokens`. Leaving it in would subtract a summary the message
 * total never carried, understating the reclaim by the size of the summary.
 */
export function latestExchangeTokens(
  conversationId: string,
  tailId: string | null | undefined,
  excludeTail: boolean,
  summaryOutputTokens = 0,
): number {
  const index = registry.get(conversationId);
  if (!index || !tailId) {
    return 0;
  }
  const contribution = (entry: TokenEntry | undefined): number => {
    if (entry == null) {
      return 0;
    }
    /** Completion counts include call arguments, but tool results are separate.
     * Count-less content already estimates both. */
    return entry.tokenCount > 0 ? entry.tokenCount + entry.estToolResultTokens : entry.estTokens;
  };

  const tailEntry = index.get(tailId);
  const parentEntry = index.get(tailEntry?.parentMessageId ?? '');
  let tail = excludeTail ? 0 : contribution(tailEntry);
  /** Only a turn that actually summarized carries that completion; the marker
   *  persists on the response whose turn compacted. */
  if (tail > 0 && tailEntry?.summaryUsedTokens != null && tailEntry.summaryUsedTokens > 0) {
    tail = Math.max(0, tail - normalizeTokenCount(summaryOutputTokens));
  }
  return tail + contribution(parentEntry);
}

/**
 * Sums provider usage/cost across EVERY message in the conversation (all
 * branches, including regenerated/abandoned responses), the conversation
 * total, shown alongside the branch figure when they differ.
 */
export function sumTotalUsage(conversationId: string): BranchUsage {
  const usage: BranchUsage = { ...EMPTY_USAGE };
  const index = registry.get(conversationId);
  if (!index) {
    return usage;
  }
  for (const entry of index.values()) {
    addUsage(usage, entry.usage);
  }
  return usage;
}

/**
 * Attaches a response's usage to its index entry AND the sticky usage history.
 * Used by the live finalize/stop flush. The history copy lets `buildIndex`
 * restore the usage after a rebuild (the persisted `metadata.usage` reaches
 * `buildIndex` on reload; the sticky copy covers the in-session window before
 * that, including a sibling transiently dropped from the cache on regenerate).
 */
export function setEntryUsage(conversationId: string, messageId: string, usage: BranchUsage): void {
  const costKnown =
    usage.costKnown === true &&
    typeof usage.cost === 'number' &&
    Number.isFinite(usage.cost) &&
    usage.cost >= 0;
  const safeUsage: BranchUsage = {
    input: normalizeTokenCount(usage.input),
    output: normalizeTokenCount(usage.output),
    cacheWrite: normalizeTokenCount(usage.cacheWrite),
    cacheRead: normalizeTokenCount(usage.cacheRead),
    cost: costKnown ? usage.cost : 0,
    costKnown,
  };
  /** Remember it durably first so a later rebuild, or a transient cache drop
   *  during regenerate, can restore it even when the entry isn't present yet. */
  let history = usageHistory.get(conversationId);
  if (!history) {
    history = new Map<string, BranchUsage>();
    usageHistory.set(conversationId, history);
  }
  history.set(messageId, safeUsage);
  const entry = registry.get(conversationId)?.get(messageId);
  if (entry) {
    entry.usage = safeUsage;
  }
}

/**
 * Walks the branch tail up the parent chain and returns the first message id
 * present in `anchors`, i.e. the deepest (most recent) stored snapshot anchor
 * on the viewed branch. Used to recover a branch's granular breakdown after a
 * later generation on a sibling branch overwrote the live snapshot.
 */
export function findBranchSnapshotAnchor(
  conversationId: string,
  tailId: string | null | undefined,
  anchors: ReadonlyMap<string, unknown>,
): string | null {
  const index = registry.get(conversationId);
  if (!index || !tailId || anchors.size === 0) {
    return null;
  }

  let currentId: string | null = tailId;
  let guard = index.size;

  while (currentId && currentId !== Constants.NO_PARENT && guard-- > 0) {
    if (anchors.has(currentId)) {
      return currentId;
    }
    const entry: TokenEntry | undefined = index.get(currentId);
    if (!entry) {
      break;
    }
    /** Stop at a summarized response that has no snapshot of its own: crossing it
     *  would recover an older PRE-summary snapshot (discarded history), which the
     *  summary-baseline estimate is meant to replace. */
    if (entry.summaryUsedTokens != null) {
      return null;
    }
    currentId = entry.parentMessageId;
  }

  return null;
}
