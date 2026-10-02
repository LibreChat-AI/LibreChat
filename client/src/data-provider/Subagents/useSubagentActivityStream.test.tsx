import React from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import { act, renderHook } from '@testing-library/react';
import { ContentTypes, QueryKeys, StepEvents } from 'librechat-data-provider';
import type { ActiveSubagentPanel } from '~/components/Chat/Subagents/state';
import {
  reduceSubagentProgress,
  closeParentSubagentProgress,
  subagentParentStreamOpenByToolCallId,
  subagentProgressByToolCallId,
  subagentProgressKey,
  takeRegisteredSubagentProgressKeys,
} from '~/components/Chat/Subagents/state';
import useSubagentActivityStream from './useSubagentActivityStream';
import { IsolatedAtomStore } from 'test/harness';

type Listener = (event: MessageEvent) => void;
type MockStream = {
  url: string;
  options: { method?: string; headers?: Record<string, string> };
  listeners: Record<string, Listener>;
  close: jest.Mock;
  emit: (type: string, data: unknown) => void;
};

const streams: MockStream[] = [];
jest.mock('sse.js', () => ({
  SSE: jest.fn().mockImplementation((url: string, options: MockStream['options']) => {
    const listeners: Record<string, Listener> = {};
    const stream: MockStream = {
      url,
      options,
      listeners,
      close: jest.fn(),
      emit: (type, data) => listeners[type]?.({ data: JSON.stringify(data) } as MessageEvent),
    };
    streams.push(stream);
    return {
      addEventListener: (type: string, listener: Listener) => {
        listeners[type] = listener;
      },
      close: stream.close,
    };
  }),
}));

const mockInvalidateQueries = jest.fn();
const mockQueryClient = { invalidateQueries: mockInvalidateQueries };
jest.mock('@tanstack/react-query', () => ({
  ...jest.requireActual('@tanstack/react-query'),
  useQueryClient: () => mockQueryClient,
}));

jest.mock('~/hooks/AuthContext', () => ({
  useAuthContext: () => ({ token: 'token-1', isAuthenticated: true }),
}));

const selection: ActiveSubagentPanel = {
  host: 'conversation',
  parentConversationId: 'parent conversation',
  parentMessageId: 'parent-message',
  toolCallId: 'tool-call',
  partIndex: 1,
  subagentType: 'researcher',
  initialProgress: 1,
  isSubmitting: false,
  durable: { threadId: 'child/thread', taskId: 'task?1' },
};

const wrapper = ({ children }: { children: React.ReactNode }) => (
  <IsolatedAtomStore>{children}</IsolatedAtomStore>
);

describe('useSubagentActivityStream', () => {
  beforeEach(() => {
    streams.length = 0;
    mockInvalidateQueries.mockClear();
    takeRegisteredSubagentProgressKeys();
  });

  it('backfills a late foreground bucket even when its coverage was marked complete', () => {
    const { result } = renderHook(
      () => {
        const progressAtom = subagentProgressByToolCallId(
          subagentProgressKey(selection.parentMessageId, selection.toolCallId, selection.partIndex),
        );
        const setProgress = useSetAtom(progressAtom);
        useSubagentActivityStream(selection);
        return { progress: useAtomValue(progressAtom), setProgress };
      },
      { wrapper },
    );
    const event = (sequence: number) => ({
      event: StepEvents.ON_SUBAGENT_UPDATE,
      data: {
        runId: 'parent',
        subagentRunId: 'child',
        subagentType: 'researcher',
        subagentAgentId: 'agent-1',
        parentToolCallId: selection.toolCallId,
        activityEventId: `task:${sequence}`,
        activitySequence: sequence,
        phase: 'message_delta' as const,
        timestamp: '2026-09-29T00:00:00.000Z',
        data: { delta: { content: [{ type: 'text', text: `${sequence}` }] } },
      },
    });
    act(() =>
      result.current.setProgress(
        closeParentSubagentProgress(reduceSubagentProgress(null, [event(2).data], 'parent', true)),
      ),
    );
    expect(result.current.progress?.coverage).toBe('complete');
    expect(result.current.progress?.firstActivitySequence).toBe(2);
    act(() =>
      streams[0].emit('message', {
        event: 'subagent_activity_replay',
        data: [event(0), event(1), event(2)],
      }),
    );
    expect(result.current.progress?.contentParts).toEqual([{ type: 'text', text: '012' }]);
  });

  it('opens one authorized task stream and closes after terminal delivery', () => {
    const { result, unmount } = renderHook(
      () => {
        useSubagentActivityStream(selection);
        return useAtomValue(
          subagentProgressByToolCallId(
            subagentProgressKey(
              selection.parentMessageId,
              selection.toolCallId,
              selection.partIndex,
            ),
          ),
        );
      },
      { wrapper },
    );

    expect(streams).toHaveLength(1);
    expect(streams[0]?.url).toContain(
      '/api/convos/parent%20conversation/subagents/child%2Fthread/tasks/task%3F1/activity',
    );
    expect(streams[0]?.options.headers).toEqual({ Authorization: 'Bearer token-1' });

    act(() => {
      streams[0]?.emit('message', {
        event: StepEvents.ON_SUBAGENT_UPDATE,
        data: {
          runId: 'root',
          parentRunId: 'parent',
          subagentRunId: 'child',
          activityEventId: 'task-1:0',
          activitySequence: 0,
          subagentType: 'researcher',
          subagentKind: 'agent',
          subagentAgentId: 'agent-1',
          parentToolCallId: 'tool-call',
          depth: 1,
          ancestry: ['parent'],
          phase: 'message_delta',
          data: { delta: { content: [{ type: 'text', text: 'Live child output' }] } },
          timestamp: '2026-08-21T20:00:00.000Z',
        },
      });
      streams[0]?.emit('message', {
        final: true,
        subagentActivity: true,
        status: 'completed',
      });
    });

    expect(result.current?.contentParts).toEqual([{ type: 'text', text: 'Live child output' }]);
    expect(result.current?.coverage).toBe('complete');
    expect(takeRegisteredSubagentProgressKeys()).toEqual([
      subagentProgressKey(selection.parentMessageId, selection.toolCallId, selection.partIndex),
    ]);
    expect(streams[0]?.close).toHaveBeenCalledTimes(1);
    expect(mockInvalidateQueries).toHaveBeenCalledWith([
      QueryKeys.subagentThread,
      'parent conversation',
      'child/thread',
      'task?1',
    ]);
    unmount();
    expect(streams[0]?.close).toHaveBeenCalledTimes(1);
  });

  it('folds a replay batch before live activity and deduplicates a reconnect snapshot', () => {
    const { result } = renderHook(
      () => {
        useSubagentActivityStream(selection);
        return useAtomValue(
          subagentProgressByToolCallId(
            subagentProgressKey(
              selection.parentMessageId,
              selection.toolCallId,
              selection.partIndex,
            ),
          ),
        );
      },
      { wrapper },
    );
    const event = (sequence: number, phase = 'message_delta') => ({
      event: StepEvents.ON_SUBAGENT_UPDATE,
      data: {
        runId: 'parent',
        subagentRunId: 'child',
        subagentType: 'researcher',
        subagentAgentId: 'agent-1',
        parentToolCallId: selection.toolCallId,
        activityEventId: `task:${sequence}`,
        activitySequence: sequence,
        phase,
        timestamp: '2026-09-29T00:00:00.000Z',
        data: (() => {
          if (phase === 'reasoning_delta')
            return { delta: { content: [{ type: 'think', think: 'Reasoning' }] } };
          if (phase === 'run_step')
            return {
              id: 'step',
              stepDetails: {
                type: 'tool_calls',
                tool_calls: [{ id: 'call', name: 'execute_code', args: { code: '1' } }],
              },
            };
          return { delta: { content: [{ type: 'text', text: `text-${sequence}` }] } };
        })(),
      },
    });
    const backlog = [event(0, 'reasoning_delta'), event(1, 'run_step'), event(2)];
    act(() => {
      streams[0].emit('message', { event: 'subagent_activity_replay', data: backlog });
    });
    expect(result.current?.contentParts.map((part) => part.type)).toEqual([
      'think',
      'tool_call',
      'text',
    ]);
    act(() => {
      streams[0].emit('message', event(3));
    });
    expect(result.current?.contentParts[2]).toEqual({ type: 'text', text: 'text-2text-3' });
    act(() => {
      streams[0].emit('message', {
        event: 'subagent_activity_replay',
        data: [...backlog, event(3)],
      });
    });
    expect(result.current?.contentParts[2]).toEqual({ type: 'text', text: 'text-2text-3' });
    expect(result.current?.lastActivitySequence).toBe(3);
    act(() => {
      streams[0].emit('message', { ...event(6), droppedCount: 2 });
    });
    expect(result.current?.droppedCount).toBe(2);
    expect(result.current?.lastActivitySequence).toBe(6);
  });

  it('preserves a displayed tool and text when a capped reconnect snapshot starts later', () => {
    const { result } = renderHook(
      () => {
        useSubagentActivityStream(selection);
        return useAtomValue(
          subagentProgressByToolCallId(
            subagentProgressKey(
              selection.parentMessageId,
              selection.toolCallId,
              selection.partIndex,
            ),
          ),
        );
      },
      { wrapper },
    );
    const event = (sequence: number) => ({
      event: StepEvents.ON_SUBAGENT_UPDATE,
      data: {
        runId: 'parent',
        subagentRunId: 'child',
        subagentType: 'researcher',
        subagentAgentId: 'agent-1',
        parentToolCallId: selection.toolCallId,
        activityEventId: `task:${sequence}`,
        activitySequence: sequence,
        phase: sequence === 10 ? 'run_step' : 'message_delta',
        timestamp: '2026-09-29T00:00:00.000Z',
        data:
          sequence === 10
            ? {
                id: 'step',
                stepDetails: {
                  type: 'tool_calls',
                  tool_calls: [{ id: 'old-tool', name: 'execute_code', args: {} }],
                },
              }
            : { delta: { content: [{ type: 'text', text: `${sequence},` }] } },
      },
    });
    act(() => {
      streams[0].emit('message', {
        event: 'subagent_activity_replay',
        data: Array.from({ length: 100 }, (_, i) => event(i + 10)),
      });
    });
    for (let sequence = 110; sequence < 120; sequence++)
      act(() => {
        streams[0].emit('message', event(sequence));
      });
    const before = result.current?.contentParts;
    expect(result.current?.firstActivitySequence).toBe(10);
    act(() => {
      streams[0].emit('message', {
        event: 'subagent_activity_replay',
        data: Array.from({ length: 100 }, (_, i) => event(i + 20)),
      });
    });
    expect(result.current?.contentParts).toEqual(before);
    expect(result.current?.contentParts[0]).toMatchObject({
      type: 'tool_call',
      tool_call: { id: 'old-tool' },
    });
    expect(result.current?.firstActivitySequence).toBe(10);
    act(() => {
      streams[0].emit('message', event(120));
    });
    expect(result.current?.lastActivitySequence).toBe(120);
  });

  it('replaces an incomplete suffix with the retained snapshot on reconnect', () => {
    const { result } = renderHook(
      () => {
        useSubagentActivityStream(selection);
        return useAtomValue(
          subagentProgressByToolCallId(
            subagentProgressKey(
              selection.parentMessageId,
              selection.toolCallId,
              selection.partIndex,
            ),
          ),
        );
      },
      { wrapper },
    );
    const event = (sequence: number) => ({
      event: StepEvents.ON_SUBAGENT_UPDATE,
      data: {
        runId: 'parent',
        subagentRunId: 'child',
        subagentType: 'researcher',
        subagentAgentId: 'agent-1',
        parentToolCallId: selection.toolCallId,
        activityEventId: `task:${sequence}`,
        activitySequence: sequence,
        phase: 'message_delta',
        timestamp: '2026-09-29T00:00:00.000Z',
        data: { delta: { content: [{ type: 'text', text: `${sequence}` }] } },
      },
    });
    act(() => {
      streams[0].emit('message', event(2));
    });
    expect(result.current?.coverage).toBe('suffix');
    act(() => {
      streams[0].emit('message', {
        event: 'subagent_activity_replay',
        data: [event(0), event(1), event(2)],
      });
    });
    expect(result.current?.contentParts).toEqual([{ type: 'text', text: '012' }]);
    expect(result.current?.coverage).toBe('complete');
  });

  it('accepts an exact task-stream update when older providers omit the optional tool-call id', () => {
    const { result } = renderHook(
      () => {
        useSubagentActivityStream(selection);
        return useAtomValue(
          subagentProgressByToolCallId(
            subagentProgressKey(
              selection.parentMessageId,
              selection.toolCallId,
              selection.partIndex,
            ),
          ),
        );
      },
      { wrapper },
    );

    act(() => {
      streams[0]?.emit('message', {
        event: StepEvents.ON_SUBAGENT_UPDATE,
        data: {
          runId: 'root',
          parentRunId: 'parent',
          subagentRunId: 'child',
          subagentType: 'researcher',
          subagentKind: 'agent',
          depth: 1,
          ancestry: [],
          phase: 'message_delta',
          data: { delta: { content: [{ type: 'text', text: 'Compatible update' }] } },
          timestamp: '2026-08-21T20:00:00.000Z',
        },
      });
    });

    expect(result.current?.contentParts).toEqual([{ type: 'text', text: 'Compatible update' }]);
  });

  it('keeps a capped replay pending until delayed parent activity backfills it', () => {
    const active = { ...selection, isSubmitting: true };
    const { result } = renderHook(
      () => {
        const progressAtom = subagentProgressByToolCallId(
          subagentProgressKey(active.parentMessageId, active.toolCallId, active.partIndex),
        );
        useSubagentActivityStream(active);
        return {
          progress: useAtomValue(progressAtom),
          setProgress: useSetAtom(progressAtom),
          closeParent: useSetAtom(
            subagentParentStreamOpenByToolCallId(
              subagentProgressKey(active.parentMessageId, active.toolCallId, active.partIndex),
            ),
          ),
        };
      },
      { wrapper },
    );
    const event = (sequence: number) => ({
      event: StepEvents.ON_SUBAGENT_UPDATE,
      data: {
        runId: 'parent',
        subagentRunId: 'child',
        subagentType: 'researcher',
        subagentAgentId: 'agent-1',
        parentToolCallId: active.toolCallId,
        activityEventId: `task:${sequence}`,
        activitySequence: sequence,
        phase: 'message_delta' as const,
        timestamp: '2026-09-29T00:00:00.000Z',
        data: { delta: { content: [{ type: 'text', text: `${sequence}` }] } },
      },
    });
    act(() =>
      streams[0].emit('message', { event: 'subagent_activity_replay', data: [event(2), event(3)] }),
    );
    expect(result.current.progress?.contentParts).toEqual([]);
    expect(result.current.progress?.pendingSequencedEvents).toHaveLength(2);
    act(() =>
      result.current.setProgress((previous) =>
        reduceSubagentProgress(previous, [event(0).data, event(1).data], 'parent', true),
      ),
    );
    expect(result.current.progress?.contentParts).toEqual([{ type: 'text', text: '0123' }]);
    expect(result.current.progress?.pendingSequencedEvents).toBeUndefined();
    act(() => streams[0].emit('message', event(4)));
    expect(result.current.progress?.contentParts).toEqual([{ type: 'text', text: '01234' }]);
    act(() => result.current.closeParent(false));
    act(() => streams[0].emit('message', event(6)));
    expect(result.current.progress?.lastActivitySequence).toBe(6);
  });

  it('counts omission markers only once when accepted, including pending replay overlap', () => {
    const active = { ...selection, isSubmitting: true };
    const { result } = renderHook(
      () => {
        const key = subagentProgressKey(
          active.parentMessageId,
          active.toolCallId,
          active.partIndex,
        );
        useSubagentActivityStream(active);
        return {
          progress: useAtomValue(subagentProgressByToolCallId(key)),
          closeParent: useSetAtom(subagentParentStreamOpenByToolCallId(key)),
        };
      },
      { wrapper },
    );
    const marker = {
      event: StepEvents.ON_SUBAGENT_UPDATE,
      droppedCount: 2,
      data: {
        runId: 'parent',
        subagentRunId: 'child',
        subagentType: 'researcher',
        subagentAgentId: 'agent-1',
        parentToolCallId: active.toolCallId,
        activityEventId: 'task:3',
        activitySequence: 3,
        phase: 'message_delta' as const,
        timestamp: '2026-09-29T00:00:00.000Z',
      },
    };
    act(() => streams[0].emit('message', marker));
    act(() =>
      streams[0].emit('message', { event: 'subagent_activity_replay', data: [marker, marker] }),
    );
    expect(result.current.progress?.droppedCount ?? 0).toBe(0);
    expect(result.current.progress?.pendingSequencedEvents).toHaveLength(1);
    act(() => result.current.closeParent(false));
    expect(result.current.progress?.droppedCount).toBe(2);
    act(() =>
      streams[0].emit('message', { event: 'subagent_activity_replay', data: [marker, marker] }),
    );
    act(() => streams[0].emit('message', marker));
    expect(result.current.progress?.droppedCount).toBe(2);
  });

  it('buffers the first detached suffix while the parent stream is still open', () => {
    const activeSelection = { ...selection, isSubmitting: true };
    const key = subagentProgressKey(
      activeSelection.parentMessageId,
      activeSelection.toolCallId,
      activeSelection.partIndex,
    );
    const { result } = renderHook(
      () => {
        useSubagentActivityStream(activeSelection);
        return {
          progress: useAtomValue(subagentProgressByToolCallId(key)),
          parentOpen: useAtomValue(subagentParentStreamOpenByToolCallId(key)),
          closeParent: useSetAtom(subagentParentStreamOpenByToolCallId(key)),
        };
      },
      { wrapper },
    );

    act(() => {
      streams[0]?.emit('message', { event: 'subagent_activity_replay', data: [] });
      streams[0]?.emit('message', {
        event: StepEvents.ON_SUBAGENT_UPDATE,
        data: {
          runId: 'root',
          parentRunId: 'parent',
          subagentRunId: 'child',
          activityEventId: 'task-1:5',
          activitySequence: 5,
          subagentType: 'researcher',
          subagentKind: 'agent',
          subagentAgentId: 'agent-1',
          parentToolCallId: 'tool-call',
          depth: 1,
          ancestry: [],
          phase: 'message_delta',
          data: { delta: { content: [{ type: ContentTypes.TEXT, text: 'suffix' }] } },
          timestamp: '2026-08-21T20:00:00.000Z',
        },
      });
    });

    expect(result.current.parentOpen).toBe(true);
    expect(result.current.progress?.contentParts).toEqual([]);
    expect(result.current.progress?.pendingSequencedEvents).toHaveLength(1);

    act(() => result.current.closeParent(false));

    expect(result.current.parentOpen).toBe(false);
    expect(result.current.progress?.contentParts).toEqual([
      { type: ContentTypes.TEXT, text: 'suffix' },
    ]);
    expect(result.current.progress?.pendingSequencedEvents).toBeUndefined();
  });

  it.each([6, 104, 106])(
    'recovers a full pending buffer with retained replay starting at %s',
    (snapshotStart) => {
      jest.useFakeTimers();
      const active = { ...selection, isSubmitting: true };
      const { result, unmount } = renderHook(
        () => {
          const key = subagentProgressKey(
            active.parentMessageId,
            active.toolCallId,
            active.partIndex,
          );
          useSubagentActivityStream(active);
          return {
            progress: useAtomValue(subagentProgressByToolCallId(key)),
            setProgress: useSetAtom(subagentProgressByToolCallId(key)),
            closeParent: useSetAtom(subagentParentStreamOpenByToolCallId(key)),
          };
        },
        { wrapper },
      );
      const event = (sequence: number) => ({
        event: StepEvents.ON_SUBAGENT_UPDATE,
        data: {
          runId: 'parent',
          subagentRunId: 'child',
          subagentType: 'researcher',
          subagentAgentId: 'agent-1',
          parentToolCallId: active.toolCallId,
          activityEventId: `task:${sequence}`,
          activitySequence: sequence,
          phase: 'message_delta' as const,
          timestamp: '2026-09-29T00:00:00.000Z',
          data: { delta: { content: [{ type: 'text', text: `${sequence},` }] } },
        },
      });
      act(() =>
        streams[0].emit('message', {
          event: 'subagent_activity_replay',
          data: Array.from({ length: 100 }, (_, i) => event(i + 2)),
        }),
      );
      for (let seq = 102; seq <= 105; seq++) act(() => streams[0].emit('message', event(seq)));
      expect(result.current.progress?.pendingSequencedEvents).toHaveLength(100);
      expect(result.current.progress?.activityReplayFrom).toBe(102);
      act(() =>
        result.current.setProgress((previous) =>
          reduceSubagentProgress(previous, [event(0).data, event(1).data], 'parent', true),
        ),
      );
      expect(result.current.progress?.lastActivitySequence).toBe(101);
      act(() => result.current.closeParent(false));
      expect(streams[0].close).toHaveBeenCalledTimes(1);
      act(() => jest.advanceTimersByTime(500));
      expect(streams).toHaveLength(2);
      act(() =>
        streams[1].emit('message', {
          event: 'subagent_activity_replay',
          data: Array.from({ length: 106 - snapshotStart }, (_, i) => event(i + snapshotStart)),
        }),
      );
      expect(result.current.progress?.lastActivitySequence).toBe(105);
      expect(result.current.progress?.activityReplayFrom).toBeUndefined();
      expect(result.current.progress?.droppedCount).toBe(Math.max(0, snapshotStart - 102));
      expect(result.current.progress?.contentParts).toEqual([
        {
          type: 'text',
          text: Array.from({ length: 106 }, (_, i) => i)
            .filter((i) => i < 102 || i >= snapshotStart)
            .map((i) => `${i},`)
            .join(''),
        },
      ]);
      act(() => streams[1].emit('message', event(106)));
      expect(result.current.progress?.lastActivitySequence).toBe(106);
      expect(result.current.progress?.activityReplayFrom).toBeUndefined();
      unmount();
      jest.useRealTimers();
    },
  );

  it('releases strict recovery ordering when healthy live frames fill the rejected interval', () => {
    jest.useFakeTimers();
    const active = { ...selection, isSubmitting: true };
    const { result, unmount } = renderHook(
      () => {
        const key = subagentProgressKey(
          active.parentMessageId,
          active.toolCallId,
          active.partIndex,
        );
        useSubagentActivityStream(active);
        return {
          progress: useAtomValue(subagentProgressByToolCallId(key)),
          setProgress: useSetAtom(subagentProgressByToolCallId(key)),
          closeParent: useSetAtom(subagentParentStreamOpenByToolCallId(key)),
        };
      },
      { wrapper },
    );
    const event = (sequence: number) => ({
      event: StepEvents.ON_SUBAGENT_UPDATE,
      data: {
        runId: 'parent',
        subagentRunId: 'child',
        subagentType: 'researcher',
        subagentAgentId: 'agent-1',
        parentToolCallId: active.toolCallId,
        activityEventId: `recover-live:${sequence}`,
        activitySequence: sequence,
        phase: 'message_delta' as const,
        timestamp: '2026-09-29T00:00:00.000Z',
        data: { delta: { content: [{ type: 'text', text: `${sequence},` }] } },
      },
    });
    act(() =>
      streams[0].emit('message', {
        event: 'subagent_activity_replay',
        data: Array.from({ length: 100 }, (_, i) => event(i + 2)),
      }),
    );
    act(() => {
      streams[0].emit('message', event(102));
      streams[0].emit('message', event(103));
    });
    act(() =>
      result.current.setProgress((previous) =>
        reduceSubagentProgress(previous, [event(0).data, event(1).data], 'parent', true),
      ),
    );
    act(() => result.current.closeParent(false));
    act(() => jest.advanceTimersByTime(500));
    act(() =>
      streams[1].emit('message', {
        event: 'subagent_activity_replay',
        data: [event(100), event(101)],
      }),
    );
    expect(result.current.progress?.activityReplayFrom).toBe(102);
    act(() => {
      for (let sequence = 102; sequence <= 105; sequence++)
        streams[1].emit('message', event(sequence));
    });
    expect(result.current.progress?.activityReplayFrom).toBeUndefined();
    act(() =>
      streams[1].emit('message', {
        ...event(108),
        droppedCount: 3,
        data: { ...event(108).data, data: undefined },
      }),
    );
    expect(result.current.progress?.lastActivitySequence).toBe(108);
    expect(result.current.progress?.droppedCount).toBe(3);
    expect(result.current.progress?.pendingSequencedEvents).toBeUndefined();
    expect(streams).toHaveLength(2);
    unmount();
    jest.useRealTimers();
  });

  it('reconnects with bounded backoff after a transient stream error', () => {
    jest.useFakeTimers();
    const { unmount } = renderHook(() => useSubagentActivityStream(selection), { wrapper });

    act(() => streams[0]?.emit('error', {}));
    expect(streams[0]?.close).toHaveBeenCalledTimes(1);
    expect(streams).toHaveLength(1);

    act(() => jest.advanceTimersByTime(500));
    expect(streams).toHaveLength(2);

    unmount();
    expect(streams[1]?.close).toHaveBeenCalledTimes(1);
    jest.useRealTimers();
  });

  it('preserves reconnect backoff after a stream-unavailable envelope', () => {
    jest.useFakeTimers();
    const { unmount } = renderHook(() => useSubagentActivityStream(selection), { wrapper });

    act(() => streams[0]?.emit('error', {}));
    act(() => jest.advanceTimersByTime(500));
    expect(streams).toHaveLength(2);

    act(() => {
      streams[1]?.emit('message', { error: 'Subagent activity stream unavailable' });
      streams[1]?.emit('error', {});
      jest.advanceTimersByTime(999);
    });
    expect(streams).toHaveLength(2);

    act(() => jest.advanceTimersByTime(1));
    expect(streams).toHaveLength(3);

    unmount();
    jest.useRealTimers();
  });

  it('keeps one forward-only stream across metadata-only selection updates', () => {
    const { rerender } = renderHook(({ value }) => useSubagentActivityStream(value), {
      initialProps: { value: selection },
      wrapper,
    });
    expect(streams).toHaveLength(1);

    rerender({
      value: {
        ...selection,
        persistedContent: [{ type: ContentTypes.TEXT, text: 'New snapshot.' }],
        durable: { ...selection.durable! },
      },
    });

    expect(streams).toHaveLength(1);
    expect(streams[0]?.close).not.toHaveBeenCalled();
  });

  it('never opens the private task stream for shares or foreground children', () => {
    const { rerender } = renderHook(({ value }) => useSubagentActivityStream(value), {
      initialProps: { value: { ...selection, host: 'share' } as ActiveSubagentPanel },
      wrapper,
    });
    expect(streams).toHaveLength(0);

    rerender({ value: { ...selection, host: 'conversation', durable: undefined } });
    expect(streams).toHaveLength(0);
  });
});
