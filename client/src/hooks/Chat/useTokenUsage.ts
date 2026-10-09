import { useEffect, useMemo, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useStore, useAtomValue, useSetAtom } from 'jotai';
import { Constants, QueryKeys } from 'librechat-data-provider';
import type { TMessage, TConversation, TModelTokenomics } from 'librechat-data-provider';
import type { BranchTotals, BranchUsage } from '~/utils/tokens';
import type { ContextSnapshot } from '~/store/usage';
import {
  overheadKey,
  getModelOverhead,
  liveTokensFamily,
  totalUsageFamily,
  removeUsageAtoms,
  hydrateSnapshots,
  pendingUsageFamily,
  activeUsageResponseIdFamily,
  subagentUsageFamily,
  pendingSubagentUsageFamily,
  branchTotalsFamily,
  contextSnapshotFamily,
  snapshotsByAnchorFamily,
} from '~/store/usage';
import {
  buildIndex,
  upsertEntries,
  sumBranch,
  clearIndex,
  mergeUsage,
  sumTotalUsage,
  prunedBranchTokens,
  collectAnchorSeries,
  snapshotConfiguration,
  latestExchangeTokens,
  findBranchSnapshotAnchor,
  normalizeTokenCount,
} from '~/utils';
import { useLatestMessageId } from '~/hooks/Messages/useLatestMessage';
import useTokenLimits from './useTokenLimits';

export interface TokenUsageParams {
  index: number;
  conversation: TConversation | null;
  isSubmitting: boolean;
}

export interface TokenUsageView {
  usedTokens: number;
  maxTokens?: number;
  /** 0–100, clamped; 0 when max is unknown */
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
   *  doesn't report it (older snapshots) or the estimate is zero — the row stays
   *  hidden. */
  toolCallTokens?: number;
  /** Cache split of the reconciling call's prompt (live or persisted) — a
   *  share of the used context, not an addition. */
  cacheRead?: number;
  cacheWrite?: number;
  /** Per-tool result-token counts, when provided by the usage snapshot */
  toolMessageTokenCounts?: Record<string, number>;
  /** Turns of headroom at the current per-call growth (undefined when unknown) */
  runwayTurns?: number;
  /** Tokens a summarization could reclaim ≈ context − latest exchange */
  compactionReclaim?: number;
  /** Live subagent model-call usage — a subset of Totals */
  subagentUsage?: BranchUsage;
  rates?: TModelTokenomics;
}

/**
 * View-model for the context usage indicator. Mount only inside the
 * indicator so its subscriptions never re-render the chat tree.
 */
export default function useTokenUsage({
  index,
  conversation,
  isSubmitting,
}: TokenUsageParams): TokenUsageView {
  const queryClient = useQueryClient();
  const usageStore = useStore();
  const conversationKey = conversation?.conversationId ?? Constants.NEW_CONVO;

  const tailId = useLatestMessageId(index);
  const snapshot = useAtomValue(contextSnapshotFamily(conversationKey));
  const snapshotsByAnchor = useAtomValue(snapshotsByAnchorFamily(conversationKey));
  const pendingUsage = useAtomValue(pendingUsageFamily(conversationKey));
  const activeResponseId = useAtomValue(activeUsageResponseIdFamily(conversationKey));
  const turnInProgress = isSubmitting && activeResponseId != null && activeResponseId === tailId;
  const totalUsageBase = useAtomValue(totalUsageFamily(conversationKey));
  const storedBranchTotals = useAtomValue(branchTotalsFamily(conversationKey));
  /** A terminal stream writer updates the shared rollup for its own response.
   * Project a different viewed tail locally, without writing it back and making
   * two views of the same conversation compete over the shared atom. */
  const branchTotals = useMemo(
    () =>
      storedBranchTotals.tailId === tailId
        ? storedBranchTotals
        : sumBranch(conversationKey, tailId, snapshot?.anchorMessageId),
    [storedBranchTotals, conversationKey, tailId, snapshot?.anchorMessageId],
  );
  const liveTokens = useAtomValue(liveTokensFamily(conversationKey));
  const committedSubagentUsage = useAtomValue(subagentUsageFamily(conversationKey));
  const pendingSubagentUsage = useAtomValue(pendingSubagentUsageFamily(conversationKey));
  const setBranchTotals = useSetAtom(branchTotalsFamily(conversationKey));
  const setTotalUsage = useSetAtom(totalUsageFamily(conversationKey));
  const limits = useTokenLimits(conversation);

  /** Deepest persisted/live snapshot on the viewed branch (present only for
   *  turns generated with the feature on). Gates the projection fetch and is a
   *  render source. */
  const branchSnapshot = useMemo(() => {
    if (snapshotsByAnchor.size === 0) {
      return null;
    }
    const anchor = findBranchSnapshotAnchor(
      conversationKey,
      branchTotals.tailId,
      snapshotsByAnchor,
    );
    return anchor != null ? (snapshotsByAnchor.get(anchor) ?? null) : null;
  }, [conversationKey, branchTotals.tailId, snapshotsByAnchor]);

  /** Branch/total provider usage is index-derived; the in-flight response is
   *  the only live add (the pending holder), counted into both — it sits on the
   *  active branch tail and inside the conversation. The backend prices each
   *  call (premium tiers, cache rates), so cost sums authoritatively. */
  const pendingAsUsage: BranchUsage = useMemo(
    () => ({
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
    }),
    [pendingUsage],
  );
  const branchUsage = useMemo(
    () => (turnInProgress ? mergeUsage(branchTotals.usage, pendingAsUsage) : branchTotals.usage),
    [branchTotals.usage, pendingAsUsage, turnInProgress],
  );
  const totalUsage = useMemo(
    () => mergeUsage(totalUsageBase, pendingAsUsage),
    [totalUsageBase, pendingAsUsage],
  );
  /** The subagent figure mirrors that split: what earlier runs committed plus
   *  the in-flight run's share, which settles or is discarded with the pending
   *  usage it sits inside. */
  const subagentUsage = useMemo(
    () => mergeUsage(committedSubagentUsage, pendingSubagentUsage),
    [committedSubagentUsage, pendingSubagentUsage],
  );
  /** Do not show the previous response as the current turn during a submission.
   * Pending contains only provider-confirmed completed calls, not text estimates. */
  let lastTurnUsage = branchTotals.lastTurnUsage;
  if (turnInProgress) {
    lastTurnUsage = pendingUsage.eventCount > 0 ? pendingAsUsage : undefined;
  }
  const hasUsage =
    branchUsage.input + branchUsage.output + branchUsage.cacheRead + branchUsage.cacheWrite > 0;

  const indexedCache = useRef<{ conversationKey: string; messages: TMessage[] | undefined }>();

  /** The messages cache is authoritative once a run settles. Stream deltas do
   * not rebuild the index, but idle transitions MUST catch up even when the
   * recovered message has the same id (404/retry-ceiling recovery has no FINAL).
   * All refresh triggers use this one projection, not separate writer paths. */
  useEffect(() => {
    const queryKey = [QueryKeys.messages, conversationKey];
    const reconcile = () => {
      const messages = queryClient.getQueryData<TMessage[]>(queryKey);
      if (
        indexedCache.current?.conversationKey !== conversationKey ||
        messages !== indexedCache.current.messages
      ) {
        /** Regeneration temporarily removes the old response and descendants
         * from the cache. A streaming projection is not a history deletion. */
        if (isSubmitting || usageStore.get(activeUsageResponseIdFamily(conversationKey)) != null) {
          upsertEntries(conversationKey, messages ?? []);
        } else {
          buildIndex(conversationKey, messages);
        }
        hydrateSnapshots(conversationKey, messages);
        indexedCache.current = { conversationKey, messages };
      }
      setBranchTotals(sumBranch(conversationKey, tailId, snapshot?.anchorMessageId));
      setTotalUsage(sumTotalUsage(conversationKey));
    };
    reconcile();
    const unsubscribe = queryClient.getQueryCache().subscribe((event) => {
      /** ask() binds before changing the cache. Read that atom synchronously:
       * this callback can run before React renders isSubmitting=true. */
      if (
        isSubmitting ||
        usageStore.get(activeUsageResponseIdFamily(conversationKey)) != null ||
        event.type !== 'updated'
      ) {
        return;
      }
      const key = event.query.queryKey;
      if (key[0] !== QueryKeys.messages || key[1] !== conversationKey) {
        return;
      }
      const messages = event.query.state.data as TMessage[] | undefined;
      if (messages !== indexedCache.current?.messages) {
        reconcile();
      }
    });
    return unsubscribe;
  }, [
    conversationKey,
    tailId,
    snapshot?.anchorMessageId,
    isSubmitting,
    queryClient,
    usageStore,
    setBranchTotals,
    setTotalUsage,
  ]);

  /** Lifetime cleanup is independent of projection refreshes. A branch change
   * or stream completion must not discard sticky usage or replay dedup keys. */
  useEffect(
    () => () => {
      if (indexedCache.current?.conversationKey === conversationKey) {
        indexedCache.current = undefined;
      }
      /** The unsaved conversation is migrated by finalizeUsage. Route changes
       * can unmount this view before that handoff, so leave its state intact. */
      if (conversationKey !== Constants.NEW_CONVO) {
        clearIndex(conversationKey);
        removeUsageAtoms(conversationKey);
      }
    },
    [conversationKey],
  );

  return useMemo(() => {
    /** The granular snapshot is for one specific generation. Show the live one
     *  while streaming, or when its (response-message) anchor is on the viewed
     *  branch. A null-anchor snapshot must NOT match every branch — that leaked
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
         *  the summary block's size so a compacting turn's summarization output —
         *  folded into the response's `tokenCount` but held outside
         *  `messageTokens` — is not subtracted from a total that never carried
         *  it. A retained tool result is added for the same reason: the kept
         *  exchange counts it, so leaving it out of the total would subtract
         *  content that was never in it and understate the savings — on a large
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

    /** Snapshot-less estimate, computed from the in-memory message index — no
     *  server round-trip. All terms are local per-message counts / char estimates
     *  (uncalibrated): the learned calibration ratio reconciles provider-injected
     *  context that isn't present in this visible text, so applying it here would
     *  over-inflate. `summaryBaseline` is the compacted-context size from the
     *  deepest summarized response on the branch (0 if none); the walk stops
     *  there, so input/output are post-summary only — adding it keeps the estimate
     *  from re-summing the discarded pre-summary history (which otherwise pins the
     *  gauge at 100% after a compaction). */
    const maxTokens =
      limits.maxContextTokens != null ? normalizeTokenCount(limits.maxContextTokens) : undefined;
    const liveOnTail = liveOutput > 0;
    /** Fixed instruction + tool-schema overhead for this agent/model (the latter is
     *  already folded into `instructionTokens`), cached from live usage events. The
     *  client can't otherwise know it for a snapshot-less branch, so reserve it from
     *  the prune budget and add it to used — making over-window pruning faithful and
     *  the gauge consistent with snapshots. Skipped when a summary baseline exists:
     *  `computeSummaryUsedTokens` already folds the overhead into that marker, so
     *  adding it again would double-count. 0 until the agent has run once this
     *  session (then falls back to message-only, as before). */
    const overheadTokens =
      branchTotals.summaryBaseline > 0
        ? 0
        : normalizeTokenCount(
            getModelOverhead(
              overheadKey(
                limits.endpoint ?? conversation?.endpoint,
                limits.model ?? conversation?.model,
                conversation?.agent_id,
              ),
            ),
          );
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
      overheadTokens +
        normalizeTokenCount(branchTotals.summaryBaseline) +
        messageTokens +
        liveOutput,
    );
    return {
      usedTokens,
      maxTokens,
      percent:
        maxTokens != null && maxTokens > 0 ? Math.min((usedTokens / maxTokens) * 100, 100) : 0,
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
  }, [
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
    conversation,
  ]);
}
