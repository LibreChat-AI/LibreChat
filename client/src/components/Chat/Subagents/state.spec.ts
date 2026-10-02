import React from 'react';
import { ContentTypes } from 'librechat-data-provider';
import { act, renderHook } from '@testing-library/react';
import { createStore, Provider as JotaiProvider } from 'jotai';
import type { SubagentUpdateEvent } from 'librechat-data-provider';
import {
  closeParentSubagentProgress,
  reduceSubagentProgress,
  reduceSubagentReplay,
  registerSubagentProgressKey,
  removeSubagentProgressAtoms,
  subagentParentStreamOpenByToolCallId,
  subagentProgressByToolCallId,
  subagentProgressKey,
  takeRegisteredSubagentProgressKeys,
  useSubagentProgress,
} from './state';

const update = (overrides: Partial<SubagentUpdateEvent> = {}): SubagentUpdateEvent => ({
  runId: 'root-run',
  parentRunId: 'parent-run',
  subagentRunId: 'child-run',
  activityEventId: 'activity-1',
  subagentType: 'researcher',
  subagentKind: 'agent',
  subagentAgentId: 'agent-1',
  parentToolCallId: 'tool-call',
  depth: 1,
  ancestry: [],
  phase: 'message_delta',
  data: { delta: { content: [{ type: 'text', text: 'Working.' }] } },
  label: 'Drafting the report',
  timestamp: '2026-08-21T20:00:00.000Z',
  ...overrides,
});

describe('reduceSubagentProgress', () => {
  it('retains graph kind when later frames omit identity metadata', () => {
    const first = reduceSubagentProgress(null, [update({ subagentKind: 'graph' })]);
    const next = reduceSubagentProgress(first, [
      update({ activityEventId: 'activity-2', subagentKind: undefined }),
    ]);
    expect(next?.subagentKind).toBe('graph');
    const batched = reduceSubagentProgress(null, [
      update({ subagentKind: 'graph' }),
      update({ activityEventId: 'activity-2', subagentKind: undefined }),
    ]);
    expect(batched?.subagentKind).toBe('graph');
  });

  it('folds an event delivered by both parent and detached streams only once', () => {
    const event = update();
    const first = reduceSubagentProgress(null, [event]);
    const replay = reduceSubagentProgress(first, [event]);

    expect(replay).toBe(first);
    expect(first?.contentParts).toEqual([{ type: ContentTypes.TEXT, text: 'Working.' }]);
    expect(first?.tickerState.lines).toHaveLength(1);
  });

  it('preserves equal chunks that carry distinct host event identities', () => {
    const progress = reduceSubagentProgress(null, [
      update({ activityEventId: 'activity-1', activitySequence: 0 }),
      update({ activityEventId: 'activity-2', activitySequence: 1 }),
    ]);

    expect(progress?.contentParts).toEqual([{ type: ContentTypes.TEXT, text: 'Working.Working.' }]);
  });

  it('marks an accepted run-start frame complete regardless of its delivery transport', () => {
    const progress = reduceSubagentProgress(
      null,
      [update({ activitySequence: 0 })],
      'detached',
      false,
    );

    expect(progress?.coverage).toBe('complete');
  });

  it('orders a same-batch overlap by the host sequence before folding', () => {
    const progress = reduceSubagentProgress(
      null,
      [
        update({
          activityEventId: 'activity-2',
          activitySequence: 2,
          data: { delta: { content: [{ type: ContentTypes.TEXT, text: 'second' }] } },
        }),
        update({
          activityEventId: 'activity-1',
          activitySequence: 1,
          data: { delta: { content: [{ type: ContentTypes.TEXT, text: 'first ' }] } },
        }),
      ],
      'detached',
      false,
    );

    expect(progress?.contentParts).toEqual([{ type: ContentTypes.TEXT, text: 'first second' }]);
    expect(progress?.lastActivitySequence).toBe(2);
  });

  it('rejects older overlap events and duplicates beyond the replay-key window', () => {
    const initial = reduceSubagentProgress(
      null,
      [
        update({
          activityEventId: 'activity-300',
          activitySequence: 300,
          data: { delta: { content: [{ type: ContentTypes.TEXT, text: 'latest' }] } },
        }),
      ],
      'detached',
      false,
    );
    const delayed = reduceSubagentProgress(initial, [
      update({
        activityEventId: 'activity-1',
        activitySequence: 1,
        data: { delta: { content: [{ type: ContentTypes.TEXT, text: 'old' }] } },
      }),
      update({
        activityEventId: 'activity-300',
        activitySequence: 300,
        data: { delta: { content: [{ type: ContentTypes.TEXT, text: 'duplicate' }] } },
      }),
    ]);

    expect(delayed).toBe(initial);
    expect(delayed?.contentParts).toEqual([{ type: ContentTypes.TEXT, text: 'latest' }]);
  });

  it('buffers a detached frame until a lagging parent delivers the missing sequence', () => {
    const detached = reduceSubagentProgress(
      null,
      [
        update({
          activityEventId: 'activity-1',
          activitySequence: 1,
          data: { delta: { content: [{ type: ContentTypes.TEXT, text: 'second' }] } },
        }),
      ],
      'detached',
      true,
    );
    expect(detached?.contentParts).toEqual([]);
    expect(detached?.pendingSequencedEvents).toHaveLength(1);

    const ordered = reduceSubagentProgress(detached, [
      update({
        activityEventId: 'activity-0',
        activitySequence: 0,
        data: { delta: { content: [{ type: ContentTypes.TEXT, text: 'first ' }] } },
      }),
    ]);

    expect(ordered?.contentParts).toEqual([{ type: ContentTypes.TEXT, text: 'first second' }]);
    expect(ordered?.pendingSequencedEvents).toBeUndefined();
    expect(ordered?.lastActivitySequence).toBe(1);
    expect(ordered?.coverage).toBe('complete');
  });

  it('uses parent stream closure as the fence for a detached suffix with no earlier frame', () => {
    const waiting = reduceSubagentProgress(
      null,
      [
        update({
          activityEventId: 'activity-5',
          activitySequence: 5,
          data: { delta: { content: [{ type: ContentTypes.TEXT, text: 'suffix' }] } },
        }),
      ],
      'detached',
      true,
    );

    const closed = closeParentSubagentProgress(waiting);

    expect(closed?.contentParts).toEqual([{ type: ContentTypes.TEXT, text: 'suffix' }]);
    expect(closed?.pendingSequencedEvents).toBeUndefined();
    expect(closed?.lastActivitySequence).toBe(5);

    const afterMissedFrames = reduceSubagentProgress(
      closed,
      [
        update({
          activityEventId: 'activity-8',
          activitySequence: 8,
          data: { delta: { content: [{ type: ContentTypes.TEXT, text: ' resumed' }] } },
        }),
      ],
      'detached',
      false,
    );
    expect(afterMissedFrames?.contentParts).toEqual([
      { type: ContentTypes.TEXT, text: 'suffix resumed' },
    ]);
    expect(afterMissedFrames?.lastActivitySequence).toBe(8);
  });

  it('bounds future sequence buffering while an earlier parent frame is missing', () => {
    const waiting = reduceSubagentProgress(
      null,
      Array.from({ length: 140 }, (_, index) =>
        update({
          activityEventId: `activity-${index + 1}`,
          activitySequence: index + 1,
          data: { delta: { content: [{ type: ContentTypes.TEXT, text: 'x'.repeat(2048) }] } },
        }),
      ),
      'detached',
      true,
    );

    expect(waiting?.pendingSequencedEvents?.length).toBeLessThanOrEqual(100);
    expect(
      new TextEncoder().encode(JSON.stringify(waiting?.pendingSequencedEvents)).byteLength,
    ).toBeLessThanOrEqual(128 * 1024);
  });

  it('accepts the missing expected frame even when the future-frame buffer is full', () => {
    const waiting = reduceSubagentProgress(
      null,
      Array.from({ length: 100 }, (_, index) =>
        update({
          activityEventId: `activity-${index + 1}`,
          activitySequence: index + 1,
          data: { delta: { content: [{ type: ContentTypes.TEXT, text: 'x' }] } },
        }),
      ),
      'detached',
      true,
    );

    expect(waiting?.pendingSequencedEvents).toHaveLength(100);

    const ordered = reduceSubagentProgress(waiting, [
      update({
        activityEventId: 'activity-0',
        activitySequence: 0,
        data: { delta: { content: [{ type: ContentTypes.TEXT, text: 'first-' }] } },
      }),
    ]);

    expect(ordered?.contentParts).toEqual([
      { type: ContentTypes.TEXT, text: `first-${'x'.repeat(100)}` },
    ]);
    expect(ordered?.pendingSequencedEvents).toBeUndefined();
    expect(ordered?.lastActivitySequence).toBe(100);
    expect(ordered?.coverage).toBe('complete');
  });

  it('preserves legacy unsequenced foreground updates', () => {
    const progress = reduceSubagentProgress(null, [
      update({ activityEventId: undefined, activitySequence: undefined }),
      update({ activityEventId: undefined, activitySequence: undefined }),
    ]);

    expect(progress?.contentParts).toEqual([{ type: ContentTypes.TEXT, text: 'Working.Working.' }]);
    expect(progress?.lastActivitySequence).toBeUndefined();
  });

  it('keeps detached reasoning text like the parent delivery path', () => {
    const progress = reduceSubagentProgress(
      null,
      [
        update({
          activitySequence: 0,
          phase: 'reasoning_delta',
          data: { delta: { content: [{ type: ContentTypes.THINK, think: 'Visible reasoning' }] } },
          label: 'Reasoning',
        }),
      ],
      'detached',
      false,
    );

    expect(progress?.contentParts).toEqual([
      { type: ContentTypes.THINK, think: 'Visible reasoning' },
    ]);
  });

  it('substitutes a marker for a pre-retention reasoning event that stripped its data', () => {
    const progress = reduceSubagentProgress(
      null,
      [
        update({
          activitySequence: 0,
          phase: 'reasoning_delta',
          data: undefined,
          label: 'Reasoning',
        }),
      ],
      'detached',
      false,
    );

    expect(progress?.contentParts).toEqual([{ type: ContentTypes.THINK, think: '…' }]);
    expect(progress?.tickerState.lines).toEqual([
      expect.objectContaining({ kind: 'reasoning', body: '…' }),
    ]);
  });

  it('preserves visible reasoning on the authoritative parent delivery path', () => {
    const progress = reduceSubagentProgress(null, [
      update({
        activitySequence: 0,
        phase: 'reasoning_delta',
        data: { delta: { content: [{ type: ContentTypes.THINK, think: 'Visible reasoning' }] } },
        label: 'Reasoning',
      }),
    ]);

    expect(progress?.contentParts).toEqual([
      { type: ContentTypes.THINK, think: 'Visible reasoning' },
    ]);
  });

  it('bounds accumulated live text to the durable activity byte budget', () => {
    const progress = reduceSubagentProgress(null, [
      update({
        activityEventId: 'large-activity',
        data: { delta: { content: [{ type: 'text', text: 'x'.repeat(96 * 1024) }] } },
      }),
    ]);

    expect(
      new TextEncoder().encode(JSON.stringify(progress?.contentParts)).byteLength,
    ).toBeLessThanOrEqual(64 * 1024);
    expect(progress?.contentParts[0]).toEqual(expect.objectContaining({ type: ContentTypes.TEXT }));
  });

  it('retains an encoded-byte-bounded singleton containing escaped text', () => {
    const progress = reduceSubagentProgress(null, [
      update({
        activityEventId: 'escaped-activity',
        data: { delta: { content: [{ type: 'text', text: '\\"'.repeat(48 * 1024) }] } },
      }),
    ]);

    expect(progress?.contentParts).toHaveLength(1);
    expect(progress?.contentParts[0]).toEqual(expect.objectContaining({ type: ContentTypes.TEXT }));
    expect(
      new TextEncoder().encode(JSON.stringify(progress?.contentParts)).byteLength,
    ).toBeLessThanOrEqual(64 * 1024);
  });

  it('retains an encoded-byte-bounded singleton tool projection', () => {
    const progress = reduceSubagentProgress(null, [
      update({
        activityEventId: 'escaped-tool-start',
        phase: 'run_step',
        data: {
          stepDetails: {
            type: 'tool_calls',
            tool_calls: [{ id: 'tool', name: 'search', args: '\\"'.repeat(48 * 1024) }],
          },
        },
      }),
      update({
        activityEventId: 'escaped-tool-complete',
        phase: 'run_step_completed',
        data: {
          result: {
            type: 'tool_call',
            tool_call: {
              id: 'tool',
              name: 'search',
              output: '\\\\'.repeat(48 * 1024),
              progress: 1,
            },
          },
        },
      }),
    ]);

    expect(progress?.contentParts).toHaveLength(1);
    expect(progress?.contentParts[0]).toEqual(
      expect.objectContaining({ type: ContentTypes.TOOL_CALL }),
    );
    expect(
      new TextEncoder().encode(JSON.stringify(progress?.contentParts)).byteLength,
    ).toBeLessThanOrEqual(64 * 1024);
  });

  it('keeps only the newest bounded activity and continues folding afterward', () => {
    const toolEvents = Array.from({ length: 120 }, (_, index) =>
      update({
        activityEventId: `tool-${index}`,
        phase: 'run_step',
        data: {
          stepDetails: {
            type: 'tool_calls',
            tool_calls: [{ id: `call-${index}`, name: 'search', args: { index } }],
          },
        },
      }),
    );
    const bounded = reduceSubagentProgress(null, toolEvents);
    const continued = reduceSubagentProgress(bounded, [
      update({
        activityEventId: 'after-bound',
        phase: 'message_delta',
        data: { delta: { content: [{ type: 'text', text: 'Final answer.' }] } },
      }),
    ]);

    expect(bounded?.contentParts).toHaveLength(100);
    expect(continued?.contentParts).toHaveLength(100);
    expect(continued?.contentParts.at(-1)).toEqual({
      type: ContentTypes.TEXT,
      text: 'Final answer.',
    });
    expect(continued?.tickerState.lines.length).toBeLessThanOrEqual(100);
  });
});

describe('removeSubagentProgressAtoms', () => {
  it('releases both family members held for one invocation', () => {
    const key = subagentProgressKey('parent-message', 'tool-call', 0);
    const progress = subagentProgressByToolCallId(key);
    const streamOpen = subagentParentStreamOpenByToolCallId(key);
    expect(subagentProgressByToolCallId(key)).toBe(progress);
    expect(subagentParentStreamOpenByToolCallId(key)).toBe(streamOpen);

    removeSubagentProgressAtoms(key);

    expect(subagentProgressByToolCallId(key)).not.toBe(progress);
    expect(subagentParentStreamOpenByToolCallId(key)).not.toBe(streamOpen);
  });
});

describe('useSubagentProgress', () => {
  beforeEach(() => {
    takeRegisteredSubagentProgressKeys();
  });

  /** Only the chat route owns the stream drain, so a card rendered anywhere
   *  else has to clean up after itself. */
  it('frees a member nothing but the read created', () => {
    const key = subagentProgressKey('search-result', 'search-call', 0);
    const { result, unmount } = renderHook(() => useSubagentProgress(key));
    const held = subagentProgressByToolCallId(key);
    expect(result.current).toBeNull();

    unmount();

    expect(subagentProgressByToolCallId(key)).not.toBe(held);
  });

  /** A panel opened before the first event reads the same still-empty member as
   *  the card that spawned it. Freeing it when the panel closes leaves the card
   *  subscribed to a member the next SSE write will not land on. */
  it('keeps a member a second reader still holds', () => {
    const key = subagentProgressKey('shared-message', 'shared-call', 0);
    const card = renderHook(() => useSubagentProgress(key));
    const panel = renderHook(() => useSubagentProgress(key));
    const held = subagentProgressByToolCallId(key);

    panel.unmount();
    expect(subagentProgressByToolCallId(key)).toBe(held);

    card.unmount();
    expect(subagentProgressByToolCallId(key)).not.toBe(held);
  });

  /** The drain owns a streaming key; freeing it here would race that boundary. */
  it('leaves a key the stream registered to the drain', () => {
    const key = subagentProgressKey('live-message', 'live-call', 0);
    registerSubagentProgressKey(key);
    const { unmount } = renderHook(() => useSubagentProgress(key));
    const held = subagentProgressByToolCallId(key);

    unmount();

    expect(subagentProgressByToolCallId(key)).toBe(held);
  });

  /** Folded activity is the record of what the child did: a reader going away
   *  must not take it with them, or reopening the card shows nothing. */
  it('keeps a member holding activity', () => {
    const key = subagentProgressKey('finished-message', 'finished-call', 0);
    const store = createStore();
    const wrapper = ({ children }: { children: React.ReactNode }) =>
      React.createElement(JotaiProvider, { store }, children);
    const { unmount } = renderHook(() => useSubagentProgress(key), { wrapper });
    const held = subagentProgressByToolCallId(key);
    act(() =>
      store.set(
        subagentProgressByToolCallId(key),
        reduceSubagentProgress(null, [update({ phase: 'stop' })]),
      ),
    );

    unmount();

    expect(subagentProgressByToolCallId(key)).toBe(held);
    expect(store.get(held)).not.toBeNull();
  });
});

it('counts an expired rejected interval without discarding later retained pending frames', () => {
  const event = (sequence: number) =>
    update({
      activityEventId: `overflow:${sequence}`,
      activitySequence: sequence,
      phase: 'message_delta',
      data: { delta: { content: [{ type: 'text', text: `${sequence},` }] } },
    });
  let progress = reduceSubagentProgress(
    null,
    Array.from({ length: 100 }, (_, i) => event(i + 2)),
    'detached',
    true,
  );
  progress = reduceSubagentProgress(progress, [event(102), event(103)], 'detached', true);
  progress = reduceSubagentProgress(progress, [event(0), event(1)], 'parent', true);
  progress = reduceSubagentProgress(progress, [event(104), event(105)], 'detached', true);
  expect(progress?.activityReplayFrom).toBe(102);
  expect(progress?.pendingSequencedEvents).toHaveLength(2);
  progress = reduceSubagentReplay(closeParentSubagentProgress(progress), [], false);
  expect(progress?.lastActivitySequence).toBe(105);
  expect(progress?.droppedCount).toBe(2);
  expect(progress?.activityReplayFrom).toBeUndefined();
  expect(progress?.contentParts).toEqual([
    {
      type: 'text',
      text: Array.from({ length: 106 }, (_, i) => i)
        .filter((i) => i !== 102 && i !== 103)
        .map((i) => `${i},`)
        .join(''),
    },
  ]);
});

describe('replay prefix projection reconciliation', () => {
  const event = (sequence: number, phase: SubagentUpdateEvent['phase'] = 'message_delta') =>
    update({
      activityEventId: `backfill:${sequence}`,
      activitySequence: sequence,
      phase,
      data:
        phase === 'reasoning_delta'
          ? { delta: { content: [{ type: 'think', think: `${sequence},` }] } }
          : { delta: { content: [{ type: 'text', text: `${sequence},` }] } },
    });
  it.each([0, 2, 4])(
    'preserves a displayed suffix when replay stops at sequence %s',
    (snapshotEnd) => {
      let progress = reduceSubagentProgress(
        null,
        [event(2), event(3), event(4)],
        'detached',
        false,
      );
      const replay = Array.from({ length: snapshotEnd + 1 }, (_, i) => event(i));
      progress = reduceSubagentReplay(progress, replay, false);
      expect(progress?.contentParts).toEqual([
        { type: 'text', text: `${snapshotEnd === 0 ? '0,' : '0,1,'}2,3,4,` },
      ]);
      expect(progress?.lastActivitySequence).toBe(4);
      progress = reduceSubagentReplay(progress, replay, false);
      expect(progress?.contentParts).toEqual([
        { type: 'text', text: `${snapshotEnd === 0 ? '0,' : '0,1,'}2,3,4,` },
      ]);
      progress = reduceSubagentProgress(
        progress,
        [{ ...event(4), data: undefined, activityDroppedCount: 4 }],
        'detached',
        false,
      );
      expect(progress?.droppedCount).toBe(0);
      progress = reduceSubagentProgress(progress, [event(5)], 'detached', false);
      expect(progress?.contentParts).toEqual([
        { type: 'text', text: `${snapshotEnd === 0 ? '0,' : '0,1,'}2,3,4,5,` },
      ]);
    },
  );
  it('preserves reasoning and tool output while merging a prefix tool start', () => {
    const toolResult = {
      ...event(3),
      phase: 'run_step_completed' as const,
      data: {
        result: {
          id: 'step',
          tool_call: {
            id: 'tool',
            name: 'execute_code',
            args: { code: '1' },
            output: 'success',
            progress: 1,
          },
        },
      },
    };
    let progress = reduceSubagentProgress(
      null,
      [event(2, 'reasoning_delta'), toolResult, event(4)],
      'detached',
      false,
    );
    const toolStart = {
      ...event(0),
      phase: 'run_step' as const,
      data: {
        id: 'step',
        stepDetails: {
          type: 'tool_calls',
          tool_calls: [{ id: 'tool', name: 'execute_code', args: { code: '1' } }],
        },
      },
    };
    progress = reduceSubagentReplay(progress, [toolStart, event(1)], false);
    expect(progress?.contentParts.map((part) => part.type)).toEqual([
      'tool_call',
      'text',
      'think',
      'text',
    ]);
    expect(progress?.contentParts[0]).toMatchObject({
      tool_call: { id: 'tool', output: 'success', progress: 1 },
    });
    expect(progress?.contentParts[2]).toEqual({ type: 'think', think: '2,' });
    expect(progress?.contentParts[3]).toEqual({ type: 'text', text: '4,' });
    progress = reduceSubagentProgress(progress, [event(5)], 'detached', false);
    expect(progress?.contentParts[3]).toEqual({ type: 'text', text: '4,5,' });
    expect(progress?.tickerState.lines.some((line) => line.kind === 'tool_complete')).toBe(true);
  });
  it('keeps item and byte limits while prepending a missing prefix', () => {
    const tool = (sequence: number) => ({
      ...event(sequence),
      phase: 'run_step' as const,
      data: {
        id: `step-${sequence}`,
        stepDetails: {
          type: 'tool_calls',
          tool_calls: [
            { id: `tool-${sequence}`, name: 'execute_code', args: { code: 'x'.repeat(2000) } },
          ],
        },
      },
    });
    const previous = reduceSubagentProgress(
      null,
      Array.from({ length: 80 }, (_, i) => tool(i + 20)),
      'detached',
      false,
    );
    const progress = reduceSubagentReplay(
      previous,
      Array.from({ length: 20 }, (_, i) => tool(i)),
      false,
    );
    expect(progress?.contentParts.length).toBeLessThanOrEqual(100);
    expect(
      new TextEncoder().encode(JSON.stringify(progress?.contentParts)).byteLength,
    ).toBeLessThanOrEqual(65_536);
    expect(progress?.contentParts.at(-1)).toMatchObject({ tool_call: { id: 'tool-99' } });
  });
});

describe('disjoint replay coverage', () => {
  const event = (sequence: number) =>
    update({
      activityEventId: `coverage:${sequence}`,
      activitySequence: sequence,
      data: { delta: { content: [{ type: 'text', text: `${sequence},` }] } },
    });
  it.each(['live', 'replay'])(
    'keeps an uncovered prefix boundary recoverable through %s',
    (source) => {
      const suffix = reduceSubagentProgress(
        null,
        [event(2), event(3), event(4)],
        'detached',
        false,
      );
      let progress = reduceSubagentReplay(suffix, [event(0)], false);
      expect(progress?.contentParts).toEqual([{ type: 'text', text: '0,2,3,4,' }]);
      expect(progress?.coverage).toBe('suffix');
      expect(progress?.replaySegments?.map((segment) => [segment.from, segment.through])).toEqual([
        [0, 0],
        [2, 4],
      ]);
      const before = JSON.stringify(progress);
      const next =
        source === 'live'
          ? reduceSubagentProgress(progress, [event(1)], 'detached', false)
          : reduceSubagentReplay(
              progress,
              [event(0), event(1), event(2), event(3), event(4)],
              false,
            );
      expect(JSON.stringify(progress)).toBe(before);
      progress = next;
      expect(progress?.contentParts).toEqual([{ type: 'text', text: '0,1,2,3,4,' }]);
      expect(progress?.coverage).toBe('complete');
      expect(progress?.replaySegments).toBeUndefined();
      progress = reduceSubagentProgress(progress, [event(5)], 'detached', false);
      expect(progress?.contentParts).toEqual([{ type: 'text', text: '0,1,2,3,4,5,' }]);
    },
  );
  it('tracks multiple disjoint prefix ranges rather than inferring coverage from endpoints', () => {
    let progress = reduceSubagentProgress(null, [event(6), event(7)], 'detached', false);
    progress = reduceSubagentReplay(progress, [event(0), event(2), event(4)], false);
    expect(progress?.coverage).toBe('suffix');
    progress = reduceSubagentReplay(
      progress,
      Array.from({ length: 8 }, (_, i) => event(i)),
      false,
    );
    expect(progress?.contentParts).toEqual([{ type: 'text', text: '0,1,2,3,4,5,6,7,' }]);
    expect(progress?.coverage).toBe('complete');
    expect(progress?.replaySegments).toBeUndefined();
  });
  it('clears an overflow fence once live frames fill the rejected interval', () => {
    let progress = reduceSubagentProgress(
      null,
      Array.from({ length: 100 }, (_, i) => event(i + 2)),
      'detached',
      true,
    );
    progress = reduceSubagentProgress(progress, [event(102), event(103)], 'detached', true);
    progress = reduceSubagentProgress(progress, [event(0), event(1)], 'parent', true);
    progress = reduceSubagentReplay(progress, [event(100), event(101)], false);
    expect(progress?.activityReplayFrom).toBe(102);
    progress = reduceSubagentProgress(progress, [event(102)], 'detached', true);
    expect(progress?.activityReplayFrom).toBe(102);
    progress = reduceSubagentProgress(progress, [event(103)], 'detached', true);
    expect(progress?.activityReplayFrom).toBeUndefined();
    progress = reduceSubagentProgress(progress, [event(104), event(105)], 'detached', false);
    progress = reduceSubagentProgress(
      progress,
      [{ ...event(108), data: undefined, activityDroppedCount: 3 }],
      'detached',
      progress?.activityReplayFrom != null,
    );
    expect(progress?.lastActivitySequence).toBe(108);
    expect(progress?.droppedCount).toBe(3);
    expect(progress?.pendingSequencedEvents).toBeUndefined();
  });
});

describe('legacy event-child invocation coverage', () => {
  const event = (sequence: number, invocation = 'generation-a') =>
    update({
      subagentRunId: 'event-task',
      activityEventId: `event-task:${invocation}:${sequence}`,
      activitySequence: undefined,
      data: { delta: { content: [{ type: 'text', text: `${invocation}:${sequence},` }] } },
    });
  it.each([0, 3])('backfills an unsequenced rollout suffix when replay ends at %s', (end) => {
    let progress = reduceSubagentProgress(null, [event(2), event(3)], 'detached', false);
    progress = reduceSubagentReplay(
      progress,
      Array.from({ length: end + 1 }, (_, i) => event(i)),
      false,
    );
    expect(progress?.contentParts).toEqual([
      {
        type: 'text',
        text: `generation-a:0,${end === 0 ? '' : 'generation-a:1,'}generation-a:2,generation-a:3,`,
      },
    ]);
    progress = reduceSubagentReplay(progress, [event(0), event(1), event(2), event(3)], false);
    expect(progress?.contentParts).toEqual([
      { type: 'text', text: 'generation-a:0,generation-a:1,generation-a:2,generation-a:3,' },
    ]);
    progress = reduceSubagentProgress(progress, [event(4)], 'detached', false);
    expect(progress?.contentParts).toEqual([
      {
        type: 'text',
        text: 'generation-a:0,generation-a:1,generation-a:2,generation-a:3,generation-a:4,',
      },
    ]);
    expect(progress?.lastActivitySequence).toBeUndefined();
  });
  it('keeps prior and resumed invocations separate while restoring earlier frames within each', () => {
    let progress = reduceSubagentProgress(
      null,
      [event(0), event(1), event(2, 'generation-b'), event(3, 'generation-b')],
      'detached',
      false,
    );
    progress = reduceSubagentReplay(
      progress,
      [event(0, 'generation-b'), event(1, 'generation-b')],
      false,
    );
    progress = reduceSubagentProgress(progress, [event(0, 'generation-c')], 'detached', false);
    expect(progress?.contentParts).toEqual([
      {
        type: 'text',
        text: 'generation-a:0,generation-a:1,generation-b:0,generation-b:1,generation-b:2,generation-b:3,generation-c:0,',
      },
    ]);
    progress = reduceSubagentReplay(
      progress,
      [event(0), event(1), event(0, 'generation-c')],
      false,
    );
    expect(progress?.contentParts).toEqual([
      {
        type: 'text',
        text: 'generation-a:0,generation-a:1,generation-b:0,generation-b:1,generation-b:2,generation-b:3,generation-c:0,',
      },
    ]);
  });
});

it('preserves compatibility updates while a numeric coverage gap is open', () => {
  const event = (sequence: number) =>
    update({
      activityEventId: `mixed:${sequence}`,
      activitySequence: sequence,
      data: { delta: { content: [{ type: 'text', text: `${sequence},` }] } },
    });
  let progress = reduceSubagentProgress(null, [event(2), event(3)], 'detached', false);
  progress = reduceSubagentReplay(progress, [event(0)], false);
  progress = reduceSubagentProgress(
    progress,
    [
      update({
        activityEventId: 'older-provider',
        activitySequence: undefined,
        data: { delta: { content: [{ type: 'text', text: 'compat,' }] } },
      }),
    ],
    'detached',
    false,
  );
  progress = reduceSubagentProgress(progress, [event(1)], 'detached', false);
  expect(progress?.contentParts).toEqual([{ type: 'text', text: '0,1,2,3,compat,' }]);
});
