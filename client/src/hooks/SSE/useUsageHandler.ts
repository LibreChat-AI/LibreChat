import { useRef, useMemo } from 'react';
import { getDefaultStore } from 'jotai';
import { Constants, reconcileContextUsageFromEvent } from 'librechat-data-provider';
import type {
  TMessage,
  TConversation,
  TTokenUsageEvent,
  TContextUsageEvent,
} from 'librechat-data-provider';
import type { SettledThroughput } from '~/utils/throughput';
import type { ContextSnapshot } from '~/store/usage';
import {
  overheadKey,
  markUsageFolded,
  migrateUsageFolded,
  liveTokensFamily,
  totalUsageFamily,
  removeUsageAtoms,
  setModelOverhead,
  clearUsageFolded,
  calibrationFamily,
  pendingUsageFamily,
  branchTotalsFamily,
  subagentUsageFamily,
  pendingSubagentUsageFamily,
  EMPTY_USAGE_TOTALS,
  contextSnapshotFamily,
  snapshotsByAnchorFamily,
  throughputSamplesFamily,
  recordSettledThroughput,
} from '~/store/usage';
import {
  sumBranch,
  mergeUsage,
  EMPTY_USAGE,
  setEntryUsage,
  upsertEntries,
  migrateIndex,
  sumTotalUsage,
  estimateTokens,
  appendBounded,
  normalizeUsageUnits,
  THROUGHPUT_MAX_SAMPLES,
} from '~/utils';

const FLUSH_INTERVAL_MS = 250;

interface UsageSubmissionLike {
  userMessage?: Pick<TMessage, 'messageId' | 'conversationId'> | null;
  conversation?: Partial<Pick<TConversation, 'conversationId' | 'endpoint' | 'model'>> | null;
}

interface FinalDataLike {
  requestMessage?: Partial<TMessage> | null;
  responseMessage?: Partial<TMessage> | null;
  conversation?: Partial<TConversation> | null;
}

export interface UsageHandlers {
  contextHandler: (data: TContextUsageEvent, submission: UsageSubmissionLike) => void;
  usageHandler: (data: TTokenUsageEvent, submission: UsageSubmissionLike) => void;
  tapStream: (data: { delta?: { content?: unknown } }, submission: UsageSubmissionLike) => void;
  /** Live estimate for the legacy content path, which streams cumulative
   *  (not incremental) text per part — sets rather than accumulates */
  tapContent: (text: unknown, submission: UsageSubmissionLike) => void;
  finalizeUsage: (data: FinalDataLike, submission: UsageSubmissionLike) => void;
  resetLive: (submission: UsageSubmissionLike) => void;
  /** Terminal stop: attribute the in-flight pending usage to the stopped partial
   *  response (so its billed tokens aren't dropped), then reset pending so it
   *  can't leak into the next response. Discards when no response id is known. */
  attributePending: (responseId: string | null, submission: UsageSubmissionLike) => void;
  /** Idempotently folds the resumed run's collected usage into the totals */
  backfillUsage: (entries: TTokenUsageEvent[], submission: UsageSubmissionLike) => void;
  /** Seeds the live estimate from already-streamed output chars on resume */
  seedLive: (chars: number, submission: UsageSubmissionLike) => void;
}

function getConvoKey(submission: UsageSubmissionLike): string {
  /** On a new chat's first turn the `created` event stamps the real id onto
   *  the user message while the submission's conversation is still `new`;
   *  prefer the real id so live writes land where TokenUsage is subscribed */
  const fromUserMessage = submission.userMessage?.conversationId;
  if (fromUserMessage != null && fromUserMessage !== Constants.NEW_CONVO) {
    return fromUserMessage;
  }
  return submission.conversation?.conversationId ?? Constants.NEW_CONVO;
}

/** Cumulative text of a content-path part: a raw string or a `{ value }` part */
function extractContentText(text: unknown): string {
  if (typeof text === 'string') {
    return text;
  }
  const value = (text as { value?: unknown })?.value;
  return typeof value === 'string' ? value : '';
}

function countDeltaChars(content: unknown): number {
  const parts = Array.isArray(content) ? content : [content];
  let chars = 0;
  for (const part of parts) {
    if (part == null || typeof part !== 'object') {
      continue;
    }
    const { text, think } = part as { text?: unknown; think?: unknown };
    if (typeof text === 'string') {
      chars += text.length;
    } else if (typeof think === 'string') {
      chars += think.length;
    }
  }
  return chars;
}

/**
 * Imperative writers for the per-conversation token usage atoms, driven by
 * SSE events. All state lives in refs/atoms — the returned handlers are
 * stable and never cause re-renders themselves.
 */
export default function useUsageHandler(): UsageHandlers {
  /** Streamed chars since the last snapshot or model end (current call only) */
  const streamCharsRef = useRef(0);
  /** Provider-confirmed output tokens since the last snapshot (current run) */
  const confirmedRef = useRef(0);
  const lastFlushRef = useRef(0);
  /** Wall-clock bounds of the turn's streamed output, for the settled rate */
  const firstDeltaAtRef = useRef<number | null>(null);
  const lastDeltaAtRef = useRef<number | null>(null);
  /** First pre-invoke snapshot of the turn: the TTFT origin */
  const turnStartAtRef = useRef<number | null>(null);
  /** Provider-confirmed primary output across every call of the turn */
  const turnOutputRef = useRef(0);
  /** A resumed turn's timing is partial, so its settled rate is withheld */
  const resumedRef = useRef(false);
  /** Set for the synchronous replay burst that follows `seedLive`, so
   *  replayed deltas stamp neither timing nor samples */
  const replayingRef = useRef(false);

  return useMemo<UsageHandlers>(() => {
    const jotai = getDefaultStore();

    const setLive = (convoKey: string, value: number) => {
      jotai.set(liveTokensFamily(convoKey), value);
    };

    const recordDelta = (now: number) => {
      if (replayingRef.current) {
        return;
      }
      firstDeltaAtRef.current ??= now;
      lastDeltaAtRef.current = now;
    };

    const pushSample = (convoKey: string, tokens: number, now: number) => {
      if (replayingRef.current) {
        return;
      }
      const samplesAtom = throughputSamplesFamily(convoKey);
      jotai.set(
        samplesAtom,
        appendBounded(jotai.get(samplesAtom), { at: now, tokens }, THROUGHPUT_MAX_SAMPLES),
      );
    };

    const resetThroughput = (convoKey: string) => {
      firstDeltaAtRef.current = null;
      lastDeltaAtRef.current = null;
      turnStartAtRef.current = null;
      turnOutputRef.current = 0;
      resumedRef.current = false;
      jotai.set(throughputSamplesFamily(convoKey), []);
    };

    /** Settle the turn's speed onto its response: confirmed output over the
     *  first-to-last delta span, or the char estimate when no provider usage
     *  arrived. A resumed turn saw only part of the span, so it settles nothing. */
    const settleThroughput = (convoKey: string, responseId: string | null) => {
      const first = firstDeltaAtRef.current;
      const last = lastDeltaAtRef.current;
      if (responseId == null || resumedRef.current || first == null || last == null) {
        return;
      }
      const durationMs = last - first;
      if (durationMs <= 0) {
        return;
      }
      const confirmed = turnOutputRef.current;
      const estimated = confirmed <= 0;
      const outputTokens = estimated
        ? estimateTokens(streamCharsRef.current, jotai.get(calibrationFamily(convoKey)))
        : confirmed;
      if (outputTokens <= 0) {
        return;
      }
      const startedAt = turnStartAtRef.current;
      const settled: SettledThroughput = {
        responseId,
        outputTokens,
        durationMs,
        ttftMs: startedAt != null && first >= startedAt ? first - startedAt : null,
        estimated,
      };
      recordSettledThroughput(settled);
    };

    /** Flush the in-flight pending usage into a response's index entry, then
     *  reset pending. Only flushes when events were actually folded this session
     *  (eventCount > 0), so a finalize that carries persisted `metadata.usage`
     *  but folded nothing — a late/second resumable subscriber — keeps the entry
     *  loaded by `upsertEntries` instead of overwriting it with an empty record. */
    const flushPendingInto = (convoKey: string, responseId: string | null) => {
      const pendingAtom = pendingUsageFamily(convoKey);
      const pending = jotai.get(pendingAtom);
      const keep = responseId != null && pending.eventCount > 0;
      if (keep) {
        setEntryUsage(convoKey, responseId, {
          input: pending.input,
          output: pending.output,
          cacheWrite: pending.cacheWrite,
          cacheRead: pending.cacheRead,
          cost: pending.costUSD,
          costKnown: pending.costKnown,
        });
      }
      /** The run's subagent share settles with the usage it is a subset of:
       *  committed to the conversation figure when the response keeps that
       *  usage, dropped with it otherwise. */
      const pendingSubAtom = pendingSubagentUsageFamily(convoKey);
      const pendingSub = jotai.get(pendingSubAtom);
      if (keep) {
        const committedAtom = subagentUsageFamily(convoKey);
        jotai.set(committedAtom, mergeUsage(jotai.get(committedAtom), pendingSub));
      }
      jotai.set(pendingSubAtom, EMPTY_USAGE);
      jotai.set(pendingAtom, EMPTY_USAGE_TOTALS);
    };

    const contextHandler: UsageHandlers['contextHandler'] = (data, submission) => {
      const convoKey = getConvoKey(submission);
      jotai.set(contextSnapshotFamily(convoKey), {
        ...data,
        completedOutputTokens: data.resumedOutputTokens ?? data.completedOutputTokens,
        anchorMessageId: submission.userMessage?.messageId ?? null,
      });
      if (data.calibrationRatio != null && data.calibrationRatio > 0) {
        jotai.set(calibrationFamily(convoKey), data.calibrationRatio);
      }
      /** Cache the fixed instruction+tool overhead (already inclusive of tool
       *  schemas) per agent/model so a snapshot-less branch of the same config can
       *  reserve it in its prune budget and gauge. */
      const overhead = data.effectiveInstructionTokens ?? data.breakdown?.instructionTokens ?? 0;
      setModelOverhead(
        overheadKey(
          submission.conversation?.endpoint,
          submission.conversation?.model,
          data.agentId,
        ),
        overhead,
      );
      streamCharsRef.current = 0;
      confirmedRef.current = 0;
      setLive(convoKey, 0);
      if (!replayingRef.current) {
        turnStartAtRef.current ??= Date.now();
      }
    };

    /** Folds one usage event into the in-flight pending holder exactly once per
     *  conversation. Returns false when the event was already counted (live then
     *  replayed on resume), so callers can skip the live-estimate bump too.
     *  `finalizeUsage` flushes the accumulated pending into the per-message index
     *  and resets it, so branch/total stay index-derived (no double count). */
    const foldUsage = (data: TTokenUsageEvent, submission: UsageSubmissionLike): boolean => {
      const convoKey = getConvoKey(submission);
      /** runId+seq is unique per model call; fall back to the payload when a
       *  source predates the sequence tag */
      const usageKey =
        data.runId != null && data.seq != null ? `${data.runId}:${data.seq}` : JSON.stringify(data);
      if (!markUsageFolded(convoKey, usageKey)) {
        return false;
      }

      /** Displayed counts use the same normalized units billing does: input is
       *  the uncached portion, output includes repaired completion tokens */
      const units = normalizeUsageUnits(data);
      const rawCost = data.cost;
      const costKnown = typeof rawCost === 'number' && Number.isFinite(rawCost) && rawCost >= 0;
      const cost = costKnown ? rawCost : 0;

      const pendingAtom = pendingUsageFamily(convoKey);
      const prev = jotai.get(pendingAtom);
      jotai.set(pendingAtom, {
        input: prev.input + units.input,
        output: prev.output + units.output,
        cacheWrite: prev.cacheWrite + units.cacheWrite,
        cacheRead: prev.cacheRead + units.cacheRead,
        eventCount: prev.eventCount + 1,
        /** Authoritative per-event cost from the backend (premium tiers, cache
         *  rates); absent when contextCost is disabled — sums to 0 then */
        costUSD: prev.costUSD + cost,
        /** Coverage is complete only if EVERY folded event carried a cost */
        costKnown: prev.costKnown && costKnown,
      });
      /** Subagent calls are inside the rollup above (the backend's persisted
       *  rollup includes them too) — track this run's share beside the pending
       *  usage it is a subset of, so the Totals row settles with that usage
       *  instead of surviving a discarded run or being folded twice by a
       *  resume. */
      if (data.usage_type === 'subagent') {
        const subAtom = pendingSubagentUsageFamily(convoKey);
        const subPrev = jotai.get(subAtom);
        jotai.set(subAtom, {
          input: subPrev.input + units.input,
          output: subPrev.output + units.output,
          cacheWrite: subPrev.cacheWrite + units.cacheWrite,
          cacheRead: subPrev.cacheRead + units.cacheRead,
          cost: subPrev.cost + cost,
          costKnown: subPrev.costKnown && costKnown,
        });
      }
      return true;
    };

    /** Reconcile the live snapshot's calibrated estimate to a primary call's
     *  ACTUAL prompt tokens. The snapshot is pre-invoke for that call; this usage
     *  is its post-invoke truth, so the gauge stops showing the SDK multiplier's
     *  inflation (severe when a provider injects server-side content like web
     *  search). Resume is handled server-side (the job-store snapshot is reconciled
     *  when the call's usage is persisted), so no backfill reconcile is needed. */
    const reconcileLiveSnapshot = (data: TTokenUsageEvent, submission: UsageSubmissionLike) => {
      const convoKey = getConvoKey(submission);
      const snapshotAtom = contextSnapshotFamily(convoKey);
      const snapshot = jotai.get(snapshotAtom);
      if (snapshot == null) {
        return;
      }
      /** The snapshot precedes this call, so it must belong to the same run */
      if (snapshot.runId != null && data.runId != null && snapshot.runId !== data.runId) {
        return;
      }
      jotai.set(snapshotAtom, {
        ...reconcileContextUsageFromEvent(snapshot, data),
        /** Live output is held in confirmedRef until finalization. */
        completedOutputTokens: undefined,
        anchorMessageId: snapshot.anchorMessageId,
      });
    };

    const usageHandler: UsageHandlers['usageHandler'] = (data, submission) => {
      const folded = foldUsage(data, submission);

      /** Only a NEWLY folded primary call drives the live gauge. A replayed
       *  duplicate (folded=false on resume) can be an EARLIER tool-loop call that
       *  shares this run's id — reconciling with it would overwrite the latest
       *  snapshot with an earlier, smaller prompt. Tagged buckets (summarization,
       *  subagent) never touch the context gauge. */
      if (!folded || data.usage_type != null) {
        return;
      }
      /** This primary's provider-reported prompt is the post-invoke truth for the
       *  call the latest snapshot precedes — reconcile the gauge to it. */
      reconcileLiveSnapshot(data, submission);
      /** Use the repaired completion count (not raw output_tokens) so the
       *  snapshot gauge keeps the full response for under-reporting providers */
      const confirmedOutput = normalizeUsageUnits(data).output;
      confirmedRef.current += confirmedOutput;
      turnOutputRef.current += confirmedOutput;
      streamCharsRef.current = 0;
      const convoKey = getConvoKey(submission);
      setLive(convoKey, confirmedRef.current);
      pushSample(convoKey, confirmedRef.current, Date.now());
    };

    const tapStream: UsageHandlers['tapStream'] = (data, submission) => {
      const chars = countDeltaChars(data?.delta?.content);
      if (chars <= 0) {
        return;
      }
      streamCharsRef.current += chars;
      const now = Date.now();
      recordDelta(now);
      if (now - lastFlushRef.current < FLUSH_INTERVAL_MS) {
        return;
      }
      lastFlushRef.current = now;
      const convoKey = getConvoKey(submission);
      const ratio = jotai.get(calibrationFamily(convoKey));
      const live = confirmedRef.current + estimateTokens(streamCharsRef.current, ratio);
      setLive(convoKey, live);
      pushSample(convoKey, live, now);
    };

    const tapContent: UsageHandlers['tapContent'] = (text, submission) => {
      const value = extractContentText(text);
      if (value.length === 0) {
        return;
      }
      /** Cumulative per part — replace the running char count, don't add */
      streamCharsRef.current = value.length;
      const now = Date.now();
      recordDelta(now);
      if (now - lastFlushRef.current < FLUSH_INTERVAL_MS) {
        return;
      }
      lastFlushRef.current = now;
      const convoKey = getConvoKey(submission);
      const ratio = jotai.get(calibrationFamily(convoKey));
      const live = confirmedRef.current + estimateTokens(streamCharsRef.current, ratio);
      setLive(convoKey, live);
      pushSample(convoKey, live, now);
    };

    const resetLive: UsageHandlers['resetLive'] = (submission) => {
      streamCharsRef.current = 0;
      confirmedRef.current = 0;
      const convoKey = getConvoKey(submission);
      setLive(convoKey, 0);
      resetThroughput(convoKey);
      /** Terminal path with no salvageable response (stream error / intentional
       *  close): discard the in-flight pending usage — and the subagent share
       *  inside it — so neither can merge into the next response nor outlive the
       *  rollups it belongs to. The user-stop path uses `attributePending` to
       *  keep it on the partial reply. Also forget the folded-event identities
       *  so a resume's `backfillUsage` can rebuild pending — otherwise it sees
       *  them as already folded and the response's usage stays missing until a
       *  full reload. */
      jotai.set(pendingUsageFamily(convoKey), EMPTY_USAGE_TOTALS);
      jotai.set(pendingSubagentUsageFamily(convoKey), EMPTY_USAGE);
      clearUsageFolded(convoKey);
    };

    const attributePending: UsageHandlers['attributePending'] = (responseId, submission) => {
      const convoKey = getConvoKey(submission);
      settleThroughput(convoKey, responseId);
      /** Flush the billed-but-uncommitted usage onto the stopped partial reply
       *  (when its id is known and events were folded), then reset pending and
       *  the live estimate. Index-derived branch/total then reflect it. */
      flushPendingInto(convoKey, responseId);
      if (responseId != null) {
        jotai.set(branchTotalsFamily(convoKey), sumBranch(convoKey, responseId, responseId));
        jotai.set(totalUsageFamily(convoKey), sumTotalUsage(convoKey));
      }
      streamCharsRef.current = 0;
      confirmedRef.current = 0;
      setLive(convoKey, 0);
      resetThroughput(convoKey);
    };

    const backfillUsage: UsageHandlers['backfillUsage'] = (entries, submission) => {
      /** Fold the resumed run's persisted events idempotently — never reset
       *  the conversation totals, or a reconnect mid-stream would drop the
       *  usage of prompts already completed earlier in the session */
      for (const entry of entries) {
        foldUsage(entry, submission);
      }
    };

    const seedLive: UsageHandlers['seedLive'] = (chars, submission) => {
      const convoKey = getConvoKey(submission);
      /** The replay that follows runs synchronously in this same task, so the
       *  guard lifts on the next macrotask, once live deltas can arrive. Timing
       *  restarts from the first live delta; the settled rate stays withheld. */
      resumedRef.current = true;
      replayingRef.current = true;
      firstDeltaAtRef.current = null;
      lastDeltaAtRef.current = null;
      jotai.set(throughputSamplesFamily(convoKey), []);
      setTimeout(() => {
        replayingRef.current = false;
      }, 0);
      /** A completed resumed call already carries exact output in its snapshot.
       * Trailing text is the same output, not a new streaming delta. */
      if (chars <= 0 || jotai.get(contextSnapshotFamily(convoKey))?.completedOutputTokens != null) {
        return;
      }
      streamCharsRef.current = chars;
      confirmedRef.current = 0;
      setLive(convoKey, estimateTokens(chars, jotai.get(calibrationFamily(convoKey))));
    };

    const finalizeUsage: UsageHandlers['finalizeUsage'] = (data, submission) => {
      const fromKey = getConvoKey(submission);
      const realId = data.conversation?.conversationId ?? fromKey;
      /** From the refs, not the atom — the throttle may not have flushed */
      const liveAtFinalize =
        confirmedRef.current +
        estimateTokens(streamCharsRef.current, jotai.get(calibrationFamily(fromKey)));

      upsertEntries(fromKey, [data.requestMessage, data.responseMessage]);

      if (realId !== fromKey) {
        migrateIndex(fromKey, realId);
        migrateUsageFolded(fromKey, realId);
        jotai.set(contextSnapshotFamily(realId), jotai.get(contextSnapshotFamily(fromKey)));
        jotai.set(snapshotsByAnchorFamily(realId), jotai.get(snapshotsByAnchorFamily(fromKey)));
        jotai.set(pendingUsageFamily(realId), jotai.get(pendingUsageFamily(fromKey)));
        jotai.set(calibrationFamily(realId), jotai.get(calibrationFamily(fromKey)));
        jotai.set(subagentUsageFamily(realId), jotai.get(subagentUsageFamily(fromKey)));
        jotai.set(
          pendingSubagentUsageFamily(realId),
          jotai.get(pendingSubagentUsageFamily(fromKey)),
        );
        removeUsageAtoms(fromKey);
      }

      const responseMeta = data.responseMessage?.contextMeta;
      if (responseMeta?.calibrationRatio != null && responseMeta.calibrationRatio > 0) {
        jotai.set(calibrationFamily(realId), responseMeta.calibrationRatio);
      }

      const userMsgId = submission.userMessage?.messageId ?? null;
      const responseId = data.responseMessage?.messageId ?? null;
      settleThroughput(realId, responseId);

      /** Flush the in-flight response's pending usage into its index entry, then
       *  reset pending. Branch/total are summed from the index, so this single
       *  add is counted exactly once; the persisted `metadata.usage` reproduces
       *  it on reload. */
      flushPendingInto(realId, responseId);

      const tailId = responseId ?? data.requestMessage?.messageId ?? null;
      if (tailId) {
        jotai.set(branchTotalsFamily(realId), sumBranch(realId, tailId, responseId ?? userMsgId));
      }
      jotai.set(totalUsageFamily(realId), sumTotalUsage(realId));

      const snapshotAtom = contextSnapshotFamily(realId);
      const snapshot = jotai.get(snapshotAtom);
      /** Re-anchor the snapshot from the user message — shared by both branches
       *  when a response is regenerated — to the branch-unique response message,
       *  so switching to a sibling branch falls back to that branch's own
       *  totals instead of showing this generation's snapshot. Also carry the
       *  output streamed since the pre-invoke snapshot, kept after live resets.
       *  The finalized response metadata is the authoritative source for retained
       *  tool results, which the live snapshot must keep after its re-anchor. */
      if (snapshot != null && snapshot.anchorMessageId === userMsgId) {
        const retainedToolTokens = (
          data.responseMessage?.metadata?.contextUsage as TContextUsageEvent | undefined
        )?.retainedToolTokens;
        const finalized: ContextSnapshot = {
          ...snapshot,
          anchorMessageId: responseId ?? snapshot.anchorMessageId,
          ...(liveAtFinalize > 0 && { completedOutputTokens: liveAtFinalize }),
          ...(retainedToolTokens != null &&
            Number.isFinite(retainedToolTokens) &&
            retainedToolTokens > 0 && { retainedToolTokens }),
        };
        jotai.set(snapshotAtom, finalized);
        /** Retain this generation's breakdown keyed by the branch-unique
         *  response id so a later run on a sibling branch (which overwrites the
         *  live snapshot) doesn't strip this branch's granular rows. */
        if (responseId != null) {
          const historyAtom = snapshotsByAnchorFamily(realId);
          const next = new Map(jotai.get(historyAtom));
          next.set(responseId, finalized);
          jotai.set(historyAtom, next);
        }
      }

      streamCharsRef.current = 0;
      confirmedRef.current = 0;
      setLive(realId, 0);
      resetThroughput(realId);
    };

    return {
      contextHandler,
      usageHandler,
      tapStream,
      tapContent,
      finalizeUsage,
      resetLive,
      attributePending,
      backfillUsage,
      seedLive,
    };
  }, []);
}
