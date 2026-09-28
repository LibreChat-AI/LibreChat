import { getDefaultStore } from 'jotai';
import { renderHook } from '@testing-library/react';
import { Constants, reconcileContextUsageFromEvent } from 'librechat-data-provider';
import type { TContextUsageEvent, TTokenUsageEvent } from 'librechat-data-provider';
import {
  contextSnapshotFamily,
  liveTokensFamily,
  subagentUsageFamily,
  pendingSubagentUsageFamily,
} from '~/store/usage';
import useUsageHandler from '~/hooks/SSE/useUsageHandler';

/** Mirrors a real web-search + summarization turn: calibration pinned at 5
 *  inflated messageTokens to 187471 (used 213375), while the call's true prompt
 *  was 53702 + 2071 cache = 55773. */
const inflatedSnapshot = (over?: Partial<TContextUsageEvent>): TContextUsageEvent => ({
  runId: 'run-1',
  breakdown: {
    maxContextTokens: 250000,
    instructionTokens: 4205,
    systemMessageTokens: 384,
    dynamicInstructionTokens: 1525,
    toolSchemaTokens: 2296,
    summaryTokens: 1938,
    toolCount: 1,
    messageCount: 2,
    messageTokens: 187471,
    availableForMessages: 233295,
  },
  contextBudget: 237500,
  remainingContextTokens: 24125,
  calibrationRatio: 5,
  ...over,
});

const primaryUsage = (over?: Partial<TTokenUsageEvent>): TTokenUsageEvent => ({
  input_tokens: 55773, // Anthropic input_tokens is cache-inclusive (53702 fresh + 2071 read)
  output_tokens: 3780,
  total_tokens: 59553,
  input_token_details: { cache_read: 2071, cache_creation: 0 },
  provider: 'anthropic',
  model: 'primary-model',
  runId: 'run-1',
  seq: 1,
  ...over,
});

describe('useUsageHandler — live snapshot reconciliation', () => {
  it('reconciles the live snapshot to the primary call’s actual prompt tokens', () => {
    const convo = 'convo-recon-1';
    const submission = {
      userMessage: { messageId: 'u1', conversationId: convo },
      conversation: { conversationId: convo },
    };
    const { result } = renderHook(() => useUsageHandler());
    const store = getDefaultStore();

    result.current.contextHandler(inflatedSnapshot(), submission);
    expect(store.get(contextSnapshotFamily(convo))?.breakdown.messageTokens).toBe(187471);

    result.current.usageHandler(primaryUsage(), submission);

    const snap = store.get(contextSnapshotFamily(convo));
    /** used = budget − remaining = real prompt (55773), down from 213375 */
    expect(237500 - (snap?.remainingContextTokens ?? 0)).toBe(55773);
    expect(snap?.breakdown.messageTokens).toBe(55773 - 4205 - 1938);
    /** instructions/summary stay raw; the anchor is preserved */
    expect(snap?.breakdown.instructionTokens).toBe(4205);
    expect(snap?.anchorMessageId).toBe('u1');
    expect(snap).toMatchObject({
      cacheRead: 2071,
      cacheWrite: 0,
      model: 'primary-model',
      provider: 'anthropic',
    });
  });

  it('keeps resumed completed output once through text seeding, replay, and finalize', () => {
    const convo = 'convo-resume-completed';
    const submission = {
      userMessage: { messageId: 'u-completed', conversationId: convo },
      conversation: { conversationId: convo },
    };
    const { result } = renderHook(() => useUsageHandler());
    const store = getDefaultStore();
    const usage = primaryUsage();
    const { completedOutputTokens, ...reconciled } = reconcileContextUsageFromEvent(
      inflatedSnapshot(),
      usage,
    );
    const snapshot = { ...reconciled, resumedOutputTokens: completedOutputTokens };
    result.current.backfillUsage([usage], submission);
    result.current.contextHandler(snapshot, submission);
    result.current.seedLive(12000, submission);
    result.current.usageHandler(usage, submission);
    expect(store.get(liveTokensFamily(convo))).toBe(0);
    expect(store.get(contextSnapshotFamily(convo))?.completedOutputTokens).toBe(3780);
    result.current.finalizeUsage(
      {
        conversation: { conversationId: convo },
        responseMessage: { messageId: 'a-completed', conversationId: convo },
      },
      submission,
    );
    expect(store.get(contextSnapshotFamily(convo))?.completedOutputTokens).toBe(3780);

    result.current.contextHandler(inflatedSnapshot(), submission);
    result.current.seedLive(400, submission);
    expect(store.get(contextSnapshotFamily(convo))?.completedOutputTokens).toBeUndefined();
    expect(store.get(liveTokensFamily(convo))).toBe(500);
  });

  it('carries retained tool tokens from response metadata into the live snapshot', () => {
    const convo = 'convo-finalize-retained';
    const submission = {
      userMessage: { messageId: 'u-retained', conversationId: convo },
      conversation: { conversationId: convo },
    };
    const { result } = renderHook(() => useUsageHandler());
    const store = getDefaultStore();

    result.current.contextHandler(inflatedSnapshot(), submission);
    result.current.finalizeUsage(
      {
        conversation: { conversationId: convo },
        responseMessage: {
          messageId: 'a-retained',
          conversationId: convo,
          metadata: { contextUsage: { retainedToolTokens: 321 } },
        },
      },
      submission,
    );
    expect(store.get(contextSnapshotFamily(convo))?.retainedToolTokens).toBe(321);

    const noRetainedConvo = 'convo-finalize-without-retained';
    const noRetainedSubmission = {
      userMessage: { messageId: 'u-no-retained', conversationId: noRetainedConvo },
      conversation: { conversationId: noRetainedConvo },
    };
    result.current.contextHandler(inflatedSnapshot(), noRetainedSubmission);
    result.current.finalizeUsage(
      {
        conversation: { conversationId: noRetainedConvo },
        responseMessage: {
          messageId: 'a-no-retained',
          conversationId: noRetainedConvo,
        },
      },
      noRetainedSubmission,
    );
    expect(store.get(contextSnapshotFamily(noRetainedConvo))?.retainedToolTokens).toBeUndefined();
  });

  it('does not reconcile a replayed (already-folded) primary usage', () => {
    /** On resume, backfill marks the run's collected usages folded; a replayed
     *  `on_token_usage` then arrives folded=false. Since tool-loop calls share the
     *  run id, reconciling with such a duplicate could overwrite the latest
     *  snapshot with an earlier call's prompt — so it must be skipped. */
    const convo = 'convo-recon-replay';
    const submission = {
      userMessage: { messageId: 'ur', conversationId: convo },
      conversation: { conversationId: convo },
    };
    const { result } = renderHook(() => useUsageHandler());
    const store = getDefaultStore();

    result.current.contextHandler(inflatedSnapshot(), submission);
    /** Mark the usage folded (as resume backfill would), then replay it live. */
    result.current.backfillUsage([primaryUsage()], submission);
    result.current.usageHandler(primaryUsage(), submission);

    /** Duplicate (folded=false) → no reconcile → snapshot stays the raw estimate. */
    expect(store.get(contextSnapshotFamily(convo))?.breakdown.messageTokens).toBe(187471);
  });

  it('does not reconcile when the usage belongs to a different run', () => {
    const convo = 'convo-recon-2';
    const submission = {
      userMessage: { messageId: 'u2', conversationId: convo },
      conversation: { conversationId: convo },
    };
    const { result } = renderHook(() => useUsageHandler());
    const store = getDefaultStore();

    result.current.contextHandler(inflatedSnapshot({ runId: 'run-A' }), submission);
    result.current.usageHandler(primaryUsage({ runId: 'run-Z', seq: 9 }), submission);

    expect(store.get(contextSnapshotFamily(convo))?.breakdown.messageTokens).toBe(187471);
  });

  it('does not let a tagged (summarization) usage touch the gauge', () => {
    const convo = 'convo-recon-3';
    const submission = {
      userMessage: { messageId: 'u3', conversationId: convo },
      conversation: { conversationId: convo },
    };
    const { result } = renderHook(() => useUsageHandler());
    const store = getDefaultStore();

    result.current.contextHandler(inflatedSnapshot(), submission);
    result.current.usageHandler(primaryUsage({ usage_type: 'summarization', seq: 2 }), submission);

    expect(store.get(contextSnapshotFamily(convo))?.breakdown.messageTokens).toBe(187471);
  });

  it('carries subagent totals through the new-conversation id handoff', () => {
    /** The first turn of a new chat accumulates under `new`; `finalizeUsage`
     *  migrates the usage atoms to the persisted id and drops the temporary
     *  ones, so a subagent total left behind would vanish on completion. */
    const newConvo: string = Constants.NEW_CONVO;
    const submission = {
      userMessage: { messageId: 'u-sub', conversationId: newConvo },
      conversation: { conversationId: newConvo },
    };
    const { result } = renderHook(() => useUsageHandler());
    const store = getDefaultStore();

    result.current.usageHandler(
      primaryUsage({ usage_type: 'subagent', runId: 'run-sub', seq: 11 }),
      submission,
    );
    expect(store.get(pendingSubagentUsageFamily(newConvo)).output).toBe(3780);

    result.current.finalizeUsage(
      {
        conversation: { conversationId: 'convo-sub-real' },
        responseMessage: { messageId: 'r-sub', conversationId: 'convo-sub-real' },
      },
      submission,
    );

    const migrated = store.get(subagentUsageFamily('convo-sub-real'));
    expect(migrated.input).toBe(53702);
    expect(migrated.output).toBe(3780);
    expect(store.get(pendingSubagentUsageFamily('convo-sub-real')).output).toBe(0);
  });

  it('drops a failed run’s subagent share with the usage it belonged to', () => {
    /** Terminal error with no salvageable response: the pending usage is
     *  discarded, so the Totals row must not keep advertising tokens that no
     *  longer appear in the branch or conversation rollups. */
    const convo = 'convo-sub-failed';
    const submission = {
      userMessage: { messageId: 'u-fail', conversationId: convo },
      conversation: { conversationId: convo },
    };
    const { result } = renderHook(() => useUsageHandler());
    const store = getDefaultStore();

    result.current.usageHandler(
      primaryUsage({ usage_type: 'subagent', runId: 'run-fail', seq: 21 }),
      submission,
    );
    result.current.resetLive(submission);

    expect(store.get(pendingSubagentUsageFamily(convo)).output).toBe(0);
    expect(store.get(subagentUsageFamily(convo)).output).toBe(0);
  });

  it('counts a resumed run’s subagent events once', () => {
    /** `resetLive` forgets the folded identities so a resume can rebuild
     *  pending; re-folding the same subagent event must not add its tokens a
     *  second time. */
    const convo = 'convo-sub-resume';
    const submission = {
      userMessage: { messageId: 'u-resume', conversationId: convo },
      conversation: { conversationId: convo },
    };
    const { result } = renderHook(() => useUsageHandler());
    const store = getDefaultStore();
    const event = primaryUsage({ usage_type: 'subagent', runId: 'run-resume', seq: 31 });

    result.current.usageHandler(event, submission);
    result.current.resetLive(submission);
    result.current.backfillUsage([event], submission);
    result.current.finalizeUsage(
      {
        conversation: { conversationId: convo },
        responseMessage: { messageId: 'r-resume', conversationId: convo },
      },
      submission,
    );

    expect(store.get(subagentUsageFamily(convo)).output).toBe(3780);
  });
});
