import { getDefaultStore } from 'jotai';
import { renderHook } from '@testing-library/react';
import { Constants, reconcileContextUsageFromEvent } from 'librechat-data-provider';
import type { TMessage, TContextUsageEvent, TTokenUsageEvent } from 'librechat-data-provider';
import {
  contextSnapshotFamily,
  snapshotsByAnchorFamily,
  removeUsageAtoms,
  branchTotalsFamily,
  totalUsageFamily,
  pendingUsageFamily,
  activeUsageResponseIdFamily,
  liveTokensFamily,
  subagentUsageFamily,
  pendingSubagentUsageFamily,
} from '~/store/usage';
import { buildIndex, sumTotalUsage, sumBranch, clearIndex } from '~/utils/tokens';
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
  it.each([true, false])(
    'retains a stopped snapshot with confirmed or unflushed output (confirmed=%s)',
    (confirmed) => {
      const convo = `stop-snapshot-${confirmed}`;
      const store = getDefaultStore();
      const { result } = renderHook(() => useUsageHandler());
      const submission = {
        conversation: { conversationId: convo },
        userMessage: { messageId: 'u', conversationId: convo },
        initialResponse: { messageId: 'r', parentMessageId: 'u' },
      };
      result.current.contextHandler(inflatedSnapshot({ calibrationRatio: 1 }), submission);
      if (confirmed) {
        result.current.usageHandler(
          primaryUsage({ output_tokens: 42, total_tokens: undefined }),
          submission,
        );
      } else {
        result.current.tapContent('x'.repeat(168), submission);
      }
      result.current.attributePending('r', submission);
      const snapshot = store.get(contextSnapshotFamily(convo));
      expect(snapshot?.anchorMessageId).toBe('r');
      expect(snapshot?.responseMessageId).toBe('r');
      expect(snapshot?.completedOutputTokens).toBe(42);
      expect(store.get(snapshotsByAnchorFamily(convo)).get('r')).toEqual(snapshot);
      expect(store.get(activeUsageResponseIdFamily(convo))).toBeNull();
      expect(store.get(liveTokensFamily(convo))).toBe(0);
      result.current.attributePending('r', submission);
      expect(store.get(contextSnapshotFamily(convo))?.completedOutputTokens).toBe(42);
      result.current.contextHandler(inflatedSnapshot(), {
        ...submission,
        initialResponse: { messageId: 'other', parentMessageId: 'u' },
      });
      result.current.attributePending('r', submission);
      expect(store.get(contextSnapshotFamily(convo))?.anchorMessageId).toBe('u');
      expect(store.get(snapshotsByAnchorFamily(convo)).get('r')).toEqual(snapshot);
    },
  );

  it.each(['created', 'context', 'final'])(
    'migrates unsaved usage at %s without retaining earlier optimistic branches',
    (handoff) => {
      const store = getDefaultStore();
      const temp = String(Constants.NEW_CONVO);
      removeUsageAtoms(temp);
      clearIndex(temp);
      const { result } = renderHook(() => useUsageHandler());
      for (let i = 0; i < 3; i++) {
        const real = `assigned-${handoff}-${i}`;
        const responseId = `response-${i}`;
        const old = {
          conversation: { conversationId: temp },
          userMessage: { messageId: `u-${i}`, conversationId: temp },
          initialResponse: { messageId: responseId, parentMessageId: `u-${i}` },
        };
        buildIndex(temp, [
          {
            messageId: `older-${i}`,
            text: 'Prior recorded response',
            conversationId: temp,
            parentMessageId: null,
            isCreatedByUser: false,
            metadata: { usage: { input: 20, output: 5, cacheRead: 0, cacheWrite: 0, cost: 0.01 } },
          } as TMessage,
        ]);
        result.current.bindResponse(old);
        const oldOwner = activeUsageResponseIdFamily(temp);
        result.current.contextHandler(inflatedSnapshot({ calibrationRatio: 1 }), old);
        const event = primaryUsage({
          runId: `call-${i}`,
          output_tokens: 12,
          total_tokens: undefined,
        });
        result.current.usageHandler(event, old);
        const moved = {
          ...old,
          conversation: { conversationId: real },
          userMessage: { ...old.userMessage, conversationId: real },
        };
        if (handoff === 'created') result.current.bindResponse(moved);
        if (handoff === 'context')
          result.current.contextHandler(inflatedSnapshot({ calibrationRatio: 1 }), moved);
        if (handoff !== 'final') {
          expect(store.get(oldOwner)).toBeNull();
          expect(sumTotalUsage(temp).input).toBe(0);
          expect(store.get(activeUsageResponseIdFamily(temp))).toBeNull();
          expect(store.get(pendingUsageFamily(real)).eventCount).toBe(1);
          result.current.backfillUsage([event], moved);
          expect(store.get(pendingUsageFamily(real)).eventCount).toBe(1);
        }
        // Even a terminal callback holding the original submission resolves real.
        result.current.finalizeUsage(
          {
            conversation: { conversationId: real },
            responseMessage: {
              messageId: responseId,
              parentMessageId: `u-${i}`,
              isCreatedByUser: false,
            },
          },
          old,
        );
        expect(sumBranch(real, responseId).lastTurnUsage?.output).toBe(12);
        expect(sumTotalUsage(temp).input).toBe(0);
        expect(store.get(activeUsageResponseIdFamily(temp))).toBeNull();
        expect(store.get(pendingUsageFamily(temp)).eventCount).toBe(0);
        removeUsageAtoms(real);
        clearIndex(real);
      }
    },
  );

  it.each([undefined, 0, 0.05])(
    'prefers the server rollup to partially observed events (cost=%s)',
    (cost) => {
      const convo = `final-authority-${cost}`;
      const store = getDefaultStore();
      const { result } = renderHook(() => useUsageHandler());
      const submission = {
        conversation: { conversationId: convo },
        userMessage: { messageId: 'u', conversationId: convo },
        initialResponse: { messageId: 'r', parentMessageId: 'u' },
      };
      result.current.usageHandler(
        {
          input_tokens: 10,
          output_tokens: 5,
          cost: 0.01,
          runId: 'partial',
          seq: 1,
          usage_type: 'subagent',
        },
        submission,
      );
      const final = {
        conversation: { conversationId: convo },
        responseMessage: {
          messageId: 'r',
          parentMessageId: 'u',
          conversationId: convo,
          isCreatedByUser: false,
          metadata: { usage: { input: 100, output: 50, cacheRead: 900, cacheWrite: 40, cost } },
        },
      };
      result.current.finalizeUsage(final, submission);
      expect(store.get(branchTotalsFamily(convo)).lastTurnUsage).toEqual({
        input: 100,
        output: 50,
        cacheRead: 900,
        cacheWrite: 40,
        cost: cost ?? 0,
        costKnown: cost != null,
      });
      expect(store.get(totalUsageFamily(convo)).cacheRead).toBe(900);
      expect(store.get(pendingUsageFamily(convo)).eventCount).toBe(0);
      expect(store.get(activeUsageResponseIdFamily(convo))).toBeNull();
      expect(store.get(subagentUsageFamily(convo)).input).toBe(10);
      result.current.finalizeUsage(final, submission);
      expect(store.get(totalUsageFamily(convo)).cacheRead).toBe(900);
      expect(store.get(subagentUsageFamily(convo)).input).toBe(10);
    },
  );

  it('tracks hydrated response ownership across replay, resume, regeneration, and reset', () => {
    const convo = 'usage-response-identity';
    const store = getDefaultStore();
    const { result } = renderHook(() => useUsageHandler());
    const submission = {
      userMessage: { messageId: 'server-user', conversationId: convo },
      initialResponse: { messageId: 'server-user_', parentMessageId: 'server-user' },
      conversation: { conversationId: convo },
    };
    result.current.contextHandler(inflatedSnapshot(), submission);
    expect(store.get(activeUsageResponseIdFamily(convo))).toBe('server-user_');
    expect(store.get(contextSnapshotFamily(convo))?.responseMessageId).toBe('server-user_');
    result.current.backfillUsage([primaryUsage(), primaryUsage()], submission);
    expect(store.get(pendingUsageFamily(convo)).eventCount).toBe(1);

    result.current.resetLive(submission);
    expect(store.get(activeUsageResponseIdFamily(convo))).toBeNull();
    const resumed = {
      ...submission,
      initialResponse: { messageId: 'durable-response', parentMessageId: 'server-user' },
    };
    result.current.seedLive(40, resumed);
    expect(store.get(activeUsageResponseIdFamily(convo))).toBe('durable-response');
    result.current.resetLive(submission);
    const regenerated = {
      ...submission,
      initialResponse: { messageId: 'local-user_', parentMessageId: 'server-user' },
    };
    result.current.backfillUsage([], regenerated);
    expect(store.get(activeUsageResponseIdFamily(convo))).toBe('local-user_');
    result.current.attributePending('local-user_', regenerated);
    expect(store.get(activeUsageResponseIdFamily(convo))).toBeNull();
  });

  it('binds a waiting response without usage and remaps its live context on an authoritative ID', () => {
    const convo = 'waiting-response-id';
    const store = getDefaultStore();
    const { result } = renderHook(() => useUsageHandler());
    const submission = {
      conversation: { conversationId: convo },
      userMessage: { messageId: 'user-id', conversationId: convo },
      initialResponse: { messageId: 'optimistic-id', parentMessageId: 'user-id' },
    };
    result.current.bindResponse(submission);
    expect(store.get(activeUsageResponseIdFamily(convo))).toBe('optimistic-id');
    expect(store.get(pendingUsageFamily(convo)).eventCount).toBe(0);
    result.current.contextHandler(inflatedSnapshot(), submission);
    result.current.usageHandler(primaryUsage(), submission);
    const pending = store.get(pendingUsageFamily(convo));
    const authoritative = {
      ...submission,
      initialResponse: { messageId: 'server-id', parentMessageId: 'user-id' },
    };
    result.current.bindResponse(authoritative);
    expect(store.get(contextSnapshotFamily(convo))?.responseMessageId).toBe('server-id');
    expect(store.get(pendingUsageFamily(convo))).toBe(pending);
    result.current.tapContent('some text', authoritative);
    expect(store.get(activeUsageResponseIdFamily(convo))).toBe('server-id');
    result.current.resetLive(authoritative);
    expect(store.get(activeUsageResponseIdFamily(convo))).toBeNull();
  });

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
