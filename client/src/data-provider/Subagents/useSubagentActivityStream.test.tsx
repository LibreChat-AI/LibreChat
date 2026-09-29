import React from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import { act, renderHook } from '@testing-library/react';
import { ContentTypes, QueryKeys, StepEvents } from 'librechat-data-provider';
import type { ActiveSubagentPanel } from '~/components/Chat/Subagents/state';
import {
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
