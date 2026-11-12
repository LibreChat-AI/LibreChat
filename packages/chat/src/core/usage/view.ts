import type { TModelTokenomics } from 'librechat-data-provider';
import type { ContextSnapshot, UsageTotals } from './snapshot';
import type { BranchTotals, BranchUsage } from './types';
import {
  prunedBranchTokens,
  collectAnchorSeries,
  snapshotConfiguration,
  latestExchangeTokens,
} from './branch';
import { normalizeTokenCount } from './types';

export interface TokenUsageView {
  usedTokens: number;
  maxTokens?: number;
  /** 0-100, clamped; 0 when max is unknown */
  percent: number;
  /** True when derived from per-message counts instead of a backend snapshot */
  isEstimate: boolean;
  snapshot: ContextSnapshot | null;
  snapshotActive: boolean;
  branchTotals: BranchTotals;
  /** Provider usage along the active branch (matches the gauge), incl. in-flight */
  branchUsage: BranchUsage;
  /** Provider usage across all branches of the conversation */
  totalUsage: BranchUsage;
  /** Usage of the selected response, or completed calls in the in-flight turn. */
  lastTurnUsage?: BranchUsage;
  /** Distinguishes incomplete in-flight usage from a completed saved turn. */
  turnInProgress: boolean;
  /** Whether any usage is available to display (branch has token usage) */
  hasUsage: boolean;
  /** Authoritative branch cost; the cost row is gated on `interface.contextCost` at render */
  branchCost: number;
  /** Authoritative cost across all branches (shown when it differs from branch) */
  totalCost: number;
  liveTokens: number;
  /** Estimated tokens for count-less messages (in-flight tail excluded while
   *  streaming); 0 on snapshots. Rendered as its own breakdown row. */
  estimatedTokens: number;
  /** Cached instruction + tool overhead applied to a snapshot-less estimate; 0 on
   *  snapshots (which carry their own breakdown) and until the agent has run. */
  overheadTokens: number;
  /** Final message-token portion of a snapshot-less estimate (pruned when over
   *  window, excludes live); 0 on snapshots. */
  messageTokens: number;
  /** True when over-window pruning replaced the raw message sum, so the breakdown
   *  shows a single pruned Messages row instead of input/output/estimated. */
  messagesPruned: boolean;
  /** Tool-call share of the message tokens: `breakdown.toolMessageTokens` on
   *  the snapshot path, plus retained post-snapshot tool results; the clamped
   *  branch walk share on the estimate path. Undefined when the producing SDK
   *  doesn't report it (older snapshots) or the estimate is zero, the row stays
   *  hidden. */
  toolCallTokens?: number;
  /** Cache split of the reconciling call's prompt (live or persisted), a
   *  share of the used context, not an addition. */
  cacheRead?: number;
  cacheWrite?: number;
  /** Per-tool result-token counts, when provided by the usage snapshot */
  toolMessageTokenCounts?: Record<string, number>;
  /** Turns of headroom at the current per-call growth (undefined when unknown) */
  runwayTurns?: number;
  /** Tokens a summarization could reclaim ≈ context − latest exchange */
  compactionReclaim?: number;
  /** Live subagent model-call usage, a subset of Totals */
  subagentUsage?: BranchUsage;
  rates?: TModelTokenomics;
}

/** Provider-confirmed usage of the in-flight response, as the branch rollup shape. */
export const pendingToBranchUsage = (pendingUsage: UsageTotals): BranchUsage => ({
  input: normalizeTokenCount(pendingUsage.input),
  output: normalizeTokenCount(pendingUsage.output),
  cacheWrite: normalizeTokenCount(pendingUsage.cacheWrite),
  cacheRead: normalizeTokenCount(pendingUsage.cacheRead),
  cost:
    typeof pendingUsage.costUSD === 'number' &&
    Number.isFinite(pendingUsage.costUSD) &&
    pendingUsage.costUSD > 0
      ? pendingUsage.costUSD
      : 0,
  costKnown: pendingUsage.costKnown === true,
});

/** The model limits a conversation resolves to; live snapshots override the static maximum. */
export interface TokenLimits {
  maxContextTokens?: number;
  rates?: TModelTokenomics;
  endpoint?: string;
  model?: string;
}

export interface TokenUsageInputs {
  snapshot: ContextSnapshot | null;
  isSubmitting: boolean;
  turnInProgress: boolean;
  activeResponseId: string | null;
  branchTotals: BranchTotals;
  branchUsage: BranchUsage;
  totalUsage: BranchUsage;
  lastTurnUsage?: BranchUsage;
  hasUsage: boolean;
  liveTokens: number;
  limits: TokenLimits;
  branchSnapshot: ContextSnapshot | null;
  snapshotsByAnchor: Map<string, ContextSnapshot>;
  subagentUsage: BranchUsage;
  conversationKey: string;
  /** Cached instruction and tool overhead of the conversation's agent or model, 0 until it ran. */
  modelOverhead: number;
}

/**
 * Derives the usage view from the atoms and caches the hook has already read: the live or
 * persisted snapshot when one applies, otherwise a client-side estimate from the message index.
 */
export function deriveTokenUsageView({
  snapshot,
  isSubmitting,
  turnInProgress,
  activeResponseId,
  branchTotals,
  branchUsage,
  totalUsage,
  lastTurnUsage,
  hasUsage,
  liveTokens,
  limits,
  branchSnapshot,
  snapshotsByAnchor,
  subagentUsage,
  conversationKey,
  modelOverhead,
}: TokenUsageInputs): TokenUsageView {
  /** The granular snapshot is for one specific generation. Show the live one
   *  while streaming, or when its (response-message) anchor is on the viewed
   *  branch. A null-anchor snapshot must NOT match every branch, that leaked
   *  one branch's breakdown onto its siblings. */
  const currentActive =
    snapshot != null &&
    (isSubmitting
      ? turnInProgress && snapshot.responseMessageId === activeResponseId
      : snapshot.anchorMessageId != null &&
        branchTotals.containsAnchor &&
        (snapshot.responseMessageId == null ||
          snapshot.anchorMessageId === snapshot.responseMessageId));

  /** Precedence: live/active snapshot → persisted branch snapshot →
   *  per-message estimate. The first two are authoritative (real runs with the
   *  feature on); the estimate covers snapshot-less branches (pre-feature
   *  history, imports, never-generated branches) entirely client-side. */
  const effective: ContextSnapshot | null = currentActive ? snapshot : branchSnapshot;

  /** Branch analysis: the snapshot series (oldest → newest) drives the runway
   *  projection. Walks use the branch tail, capped at summary markers,
   *  mirroring `sumBranch`. */
  const tailId = branchTotals.tailId;
  const anchorSeries =
    effective != null ? collectAnchorSeries(conversationKey, tailId, snapshotsByAnchor) : [];
  /** The snapshot is pre-invoke, so its `remainingContextTokens` predates the
   *  last call's finalized output, any retained tool result, and any in-flight
   *  output. All already ate that headroom (`usedTokens` adds them), so the
   *  projection must too. */
  const completedOutput = normalizeTokenCount(effective?.completedOutputTokens);
  const retainedToolTokens = normalizeTokenCount(effective?.retainedToolTokens);
  const liveOutput = turnInProgress ? normalizeTokenCount(liveTokens) : 0;
  const remainingForRunway =
    effective?.remainingContextTokens != null
      ? Math.max(
          0,
          normalizeTokenCount(effective.remainingContextTokens) -
            completedOutput -
            retainedToolTokens -
            liveOutput,
        )
      : null;
  let runwayTurns: number | undefined;
  if (anchorSeries.length >= 2 && remainingForRunway != null) {
    const latest = anchorSeries[anchorSeries.length - 1];
    const previous = anchorSeries[anchorSeries.length - 2];
    /** Growth is only a per-call delta when both readings were measured the
     *  same way; a remaining-based reading next to a breakdown-derived one
     *  (a snapshot saved before `remainingContextTokens` existed) differs by
     *  the content the breakdown omits, not by what the last call added. The
     *  projection stays unavailable rather than reporting that difference. */
    const comparable =
      latest.basis === previous.basis &&
      latest.configuration != null &&
      latest.configuration === previous.configuration &&
      effective != null &&
      latest.configuration === snapshotConfiguration(effective);
    const perCallGrowth = comparable ? latest.used - previous.used : 0;
    if (perCallGrowth > 0) {
      runwayTurns = Math.max(0, Math.floor(remainingForRunway / perCallGrowth));
    }
  }
  if (effective != null) {
    const breakdown = effective.breakdown;
    const maxTokens = normalizeTokenCount(effective.contextBudget ?? breakdown.maxContextTokens);
    const instructionTokens = normalizeTokenCount(
      effective.effectiveInstructionTokens ?? breakdown.instructionTokens,
    );
    const remainingContextTokens =
      effective.remainingContextTokens != null
        ? normalizeTokenCount(effective.remainingContextTokens)
        : null;
    const breakdownUsed =
      instructionTokens +
      normalizeTokenCount(breakdown.summaryTokens) +
      normalizeTokenCount(breakdown.messageTokens);
    /** A remaining count measured against a smaller instruction total than the
     *  snapshot publishes would put used below the instruction and summary
     *  shares the breakdown subtracts, hiding the Messages row. */
    const baseUsed =
      remainingContextTokens != null
        ? Math.max(maxTokens - remainingContextTokens, breakdownUsed)
        : breakdownUsed;
    /** The snapshot is pre-invoke: in-flight output rides on `liveTokens` (0
     *  unless streaming this branch), the last call's finalized output on
     *  `completedOutputTokens`, and retained tool results on
     *  `retainedToolTokens`. */
    const usedTokens = normalizeTokenCount(
      Math.max(0, baseUsed) + liveOutput + completedOutput + retainedToolTokens,
    );
    return {
      usedTokens,
      maxTokens,
      percent: maxTokens > 0 ? Math.min((usedTokens / maxTokens) * 100, 100) : 0,
      isEstimate: false,
      snapshot: effective,
      snapshotActive: true,
      branchTotals,
      branchUsage,
      totalUsage,
      lastTurnUsage,
      turnInProgress,
      hasUsage,
      branchCost: branchUsage.cost,
      totalCost: totalUsage.cost,
      liveTokens: liveOutput,
      estimatedTokens: 0,
      overheadTokens: 0,
      messageTokens: 0,
      messagesPruned: false,
      /** Retained tool results sit outside `messageTokens`, so widen the
       *  reported tool-call share without clipping it back to that pre-invoke
       *  total. Keep older snapshots unsplit when no split was reported. */
      toolCallTokens:
        breakdown.toolMessageTokens != null
          ? Math.min(
              normalizeTokenCount(breakdown.toolMessageTokens),
              normalizeTokenCount(breakdown.messageTokens),
            ) + retainedToolTokens
          : undefined,
      cacheRead: normalizeTokenCount(effective.cacheRead),
      cacheWrite: normalizeTokenCount(effective.cacheWrite),
      toolMessageTokenCounts: breakdown.toolMessageTokenCounts,
      runwayTurns,
      /** Both sides are measured after the tail call: `breakdown.messageTokens`
       *  is pre-invoke, so add the finalized output that `latestExchangeTokens`
       *  already counts in the exchange a summarization would keep, and hand it
       *  the summary block's size so a compacting turn's summarization output,
       *  folded into the response's `tokenCount` but held outside
       *  `messageTokens`, is not subtracted from a total that never carried
       *  it. A retained tool result is added for the same reason: the kept
       *  exchange counts it, so leaving it out of the total would subtract
       *  content that was never in it and understate the savings, on a large
       *  final result, down to zero. While a response streams, `completedOutput`
       *  is 0 and the in-flight tail is excluded from both sides (it rides on
       *  `liveTokens`). */
      compactionReclaim: Math.max(
        0,
        normalizeTokenCount(breakdown.messageTokens) +
          completedOutput +
          retainedToolTokens -
          latestExchangeTokens(
            conversationKey,
            tailId,
            liveOutput > 0,
            normalizeTokenCount(breakdown.summaryTokens),
          ),
      ),
      subagentUsage,
      rates: limits.rates,
    };
  }

  /** Snapshot-less estimate, computed from the in-memory message index, no
   *  server round-trip. All terms are local per-message counts / char estimates
   *  (uncalibrated): the learned calibration ratio reconciles provider-injected
   *  context that isn't present in this visible text, so applying it here would
   *  over-inflate. `summaryBaseline` is the compacted-context size from the
   *  deepest summarized response on the branch (0 if none); the walk stops
   *  there, so input/output are post-summary only, adding it keeps the estimate
   *  from re-summing the discarded pre-summary history (which otherwise pins the
   *  gauge at 100% after a compaction). */
  const maxTokens =
    limits.maxContextTokens != null ? normalizeTokenCount(limits.maxContextTokens) : undefined;
  const liveOnTail = liveOutput > 0;
  /** Fixed instruction + tool-schema overhead for this agent/model (the latter is
   *  already folded into `instructionTokens`), cached from live usage events. The
   *  client can't otherwise know it for a snapshot-less branch, so reserve it from
   *  the prune budget and add it to used, making over-window pruning faithful and
   *  the gauge consistent with snapshots. Skipped when a summary baseline exists:
   *  `computeSummaryUsedTokens` already folds the overhead into that marker, so
   *  adding it again would double-count. 0 until the agent has run once this
   *  session (then falls back to message-only, as before). */
  const overheadTokens = branchTotals.summaryBaseline > 0 ? 0 : normalizeTokenCount(modelOverhead);
  /** When a stream is live the tail is the in-flight response, already counted
   *  by `liveTokens`; drop its static estimate so a resumed/partial response
   *  isn't double-counted on the estimate path. */
  const estimatedTokens = Math.max(
    0,
    normalizeTokenCount(branchTotals.estTokens) -
      (liveOnTail ? normalizeTokenCount(branchTotals.tailEstTokens) : 0),
  );
  const rawMessageTokens =
    normalizeTokenCount(branchTotals.input) +
    normalizeTokenCount(branchTotals.output) +
    estimatedTokens;
  let messageTokens = rawMessageTokens;
  /** Tool-call share of the same walk (a subset of input/output/estimated).
   *  Mirrors the tail exclusion so a live in-flight response's tool tokens
   *  aren't counted before its content lands. */
  const estimatedToolTokens = Math.max(
    0,
    normalizeTokenCount(branchTotals.estToolTokens) -
      (liveOnTail ? normalizeTokenCount(branchTotals.tailEstToolTokens) : 0),
  );
  let toolTokens = Math.min(estimatedToolTokens, messageTokens);
  /** The send path prunes an over-window branch oldest-first before calling the
   *  model, so the next call can sit well under the window even when the full
   *  branch exceeds it. Mirror that: when the raw sum overflows the message window
   *  (max minus the always-sent summary baseline and instruction overhead), report
   *  the newest messages that actually fit instead of clamping the whole branch to
   *  100%. */
  if (maxTokens != null && maxTokens > 0) {
    const messageBudget = Math.max(
      0,
      maxTokens - normalizeTokenCount(branchTotals.summaryBaseline) - overheadTokens,
    );
    if (messageTokens > messageBudget) {
      const pruned = prunedBranchTokens(
        conversationKey,
        branchTotals.tailId,
        messageBudget,
        liveOnTail,
      );
      messageTokens = normalizeTokenCount(pruned.tokens);
      toolTokens = Math.min(normalizeTokenCount(pruned.toolTokens), messageTokens);
    }
  }
  /** When pruning replaced the raw sum, the per-category input/output/estimated
   *  rows no longer describe what's sent, so the breakdown collapses them into
   *  a single pruned Messages row to stay consistent with the gauge. */
  const messagesPruned = messageTokens < rawMessageTokens;
  const compactionReclaim = Math.max(
    0,
    messageTokens - latestExchangeTokens(conversationKey, branchTotals.tailId, liveOnTail),
  );
  const usedTokens = normalizeTokenCount(
    overheadTokens + normalizeTokenCount(branchTotals.summaryBaseline) + messageTokens + liveOutput,
  );
  return {
    usedTokens,
    maxTokens,
    percent: maxTokens != null && maxTokens > 0 ? Math.min((usedTokens / maxTokens) * 100, 100) : 0,
    isEstimate: true,
    snapshot: null,
    snapshotActive: false,
    branchTotals,
    branchUsage,
    totalUsage,
    lastTurnUsage,
    turnInProgress,
    hasUsage,
    branchCost: branchUsage.cost,
    totalCost: totalUsage.cost,
    liveTokens: liveOutput,
    estimatedTokens,
    overheadTokens,
    messageTokens,
    messagesPruned,
    toolCallTokens: toolTokens > 0 ? toolTokens : undefined,
    compactionReclaim,
    subagentUsage,
    rates: limits.rates,
  };
}
