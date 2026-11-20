/**
 * @jest-environment jsdom
 */
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Constants, StepTypes, StepEvents, ContentTypes, QueryKeys } from 'librechat-data-provider';
import type { TMessage, ChatEvent } from 'librechat-data-provider';
import type { ReactNode } from 'react';
import type { ChatStream, ChatTransport, ChatStreamStatus } from '../../core';
import type { FollowChatOptions } from '../follow';
import { MAX_RETRIES, getReconnectDelay } from '../../core';
import { ABSENT_RETRIES, useFollowChat } from '../follow';

type TestStream = ChatStream & { push(event: ChatEvent): void; closed: boolean };

const createStream = (): TestStream => {
  const queued: ChatEvent[] = [];
  let wake: (() => void) | undefined;
  const stream: TestStream = {
    closed: false,
    push(event) {
      queued.push(event);
      wake?.();
    },
    close() {
      stream.closed = true;
      wake?.();
    },
    async *[Symbol.asyncIterator]() {
      while (true) {
        while (queued.length > 0) {
          yield queued.shift() as ChatEvent;
        }
        if (stream.closed) {
          return;
        }
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
    },
  };
  return stream;
};

const createTransport = (initial: ChatStreamStatus) => {
  const streams: TestStream[] = [];
  let status = initial;
  const transport: ChatTransport = {
    sendMessages: () => Promise.reject(new Error('view only')),
    abort: () => Promise.reject(new Error('view only')),
    getStatus: jest.fn(async () => status),
    reconnectToStream: jest.fn(async () => {
      if (!status.active) {
        return null;
      }
      const stream = createStream();
      streams.push(stream);
      return stream;
    }),
  };
  return {
    transport,
    streams,
    setStatus: (next: ChatStreamStatus) => {
      status = next;
    },
  };
};

const running: ChatStreamStatus = { active: true, streamId: 'thread-1', createdAt: 2000 };
const idle: ChatStreamStatus = { active: false };

const brief: TMessage = {
  messageId: 'task-1:user',
  conversationId: 'thread-1',
  parentMessageId: Constants.NO_PARENT as string,
  isCreatedByUser: true,
  text: 'Research this',
};

const answer = (text: string): TMessage => ({
  messageId: 'task-1:assistant',
  conversationId: 'thread-1',
  parentMessageId: 'task-1:user',
  isCreatedByUser: false,
  text: '',
  content: [{ type: ContentTypes.TEXT, text }],
});

const snapshot = (text: string): ChatEvent =>
  ({
    type: 'sync',
    data: {
      sync: true,
      resumeState: {
        conversationId: 'thread-1',
        responseMessageId: 'task-1:assistant',
        userMessage: { ...brief },
        runSteps: [
          {
            id: 's0',
            runId: 'task-1:assistant',
            index: 0,
            type: StepTypes.MESSAGE_CREATION,
            stepDetails: {
              type: StepTypes.MESSAGE_CREATION,
              message_creation: { message_id: 's0' },
            },
            usage: null,
          },
        ],
        aggregatedContent: [{ type: ContentTypes.TEXT, text }],
      },
    },
  }) as ChatEvent;

const token = (text: string): ChatEvent =>
  ({
    type: 'step',
    data: {
      event: StepEvents.ON_MESSAGE_DELTA,
      data: { id: 's0', delta: { content: [{ type: ContentTypes.TEXT, text }] } },
    },
  }) as ChatEvent;

const final = (text: string): ChatEvent =>
  ({
    type: 'final',
    data: {
      final: true,
      conversation: { conversationId: 'thread-1' },
      requestMessage: brief,
      responseMessage: answer(text),
    },
  }) as ChatEvent;

const textOf = (messages: TMessage[]) =>
  messages
    .find((message) => message.messageId === 'task-1:assistant')
    ?.content?.map((part) => (part as { text?: string }).text);

/** Lets promises settle and the frame that writes streamed tokens run. */
const settle = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 40));
  });

const setup = (initial: Partial<FollowChatOptions> & Pick<FollowChatOptions, 'transport'>) => {
  const queryClient = new QueryClient();
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  const loadMessages = jest.fn(async () => [brief]);
  const view = renderHook((props: FollowChatOptions) => useFollowChat(props), {
    wrapper,
    initialProps: { id: 'thread-1', loadMessages, ...initial },
  });
  return { ...view, queryClient, loadMessages };
};

describe('useFollowChat', () => {
  it('shows the stored messages and opens no stream when nothing is running', async () => {
    const { transport } = createTransport(idle);
    const { result, loadMessages, queryClient } = setup({ transport });

    expect(result.current.isLoading).toBe(true);
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.messages).toEqual([brief]);
    expect(result.current.status).toBe('ready');
    expect(loadMessages).toHaveBeenCalledTimes(1);
    expect(transport.reconnectToStream).not.toHaveBeenCalled();
    expect(queryClient.getQueryData([QueryKeys.messages, 'thread-1'])).toEqual([brief]);
  });

  it('attaches to the running generation and shows what it streams on top of what was stored', async () => {
    const { transport, streams } = createTransport(running);
    const { result } = setup({ transport });
    await waitFor(() => expect(streams).toHaveLength(1));

    act(() => streams[0].push(snapshot('Hel')));
    act(() => streams[0].push(token('lo')));
    await settle();

    expect(result.current.status).toBe('streaming');
    expect(result.current.messages.map((message) => message.messageId)).toEqual([
      'task-1:user',
      'task-1:assistant',
    ]);
    expect(textOf(result.current.messages)).toEqual(['Hello']);
  });

  it('reads the stored messages again once the generation it followed ends', async () => {
    const { transport, streams, setStatus } = createTransport(running);
    const { result, loadMessages } = setup({ transport });
    await waitFor(() => expect(streams).toHaveLength(1));
    act(() => streams[0].push(snapshot('Hel')));
    await settle();

    loadMessages.mockResolvedValue([brief, answer('Hello, stored')]);
    setStatus(idle);
    act(() => streams[0].push(final('Hello')));
    await waitFor(() => expect(loadMessages).toHaveBeenCalledTimes(2));
    await settle();

    expect(result.current.status).toBe('ready');
    expect(textOf(result.current.messages)).toEqual(['Hello, stored']);
  });

  it('says when the list is settled: after a read, and with the frame a generation ended on', async () => {
    const { transport, streams, setStatus } = createTransport(running);
    const onSettled = jest.fn();
    /** What the list held each time, to show it is told after the rows are in, not before. */
    const held: Array<string[]> = [];
    const { result, loadMessages } = setup({
      transport,
      beside: {
        onSettled: (frame) => {
          held.push(result.current.chat?.messages.map((message) => message.messageId) ?? []);
          onSettled(frame);
        },
      },
    });
    await waitFor(() => expect(streams).toHaveLength(1));

    /** The stored rows it opened with: no generation has ended yet, so no frame. */
    expect(onSettled).toHaveBeenCalledTimes(1);
    expect(onSettled).toHaveBeenLastCalledWith(undefined);
    expect(held[0]).toEqual(['task-1:user']);

    act(() => streams[0].push(snapshot('Hel')));
    await settle();
    loadMessages.mockResolvedValue([brief, answer('Hello, stored')]);
    setStatus(idle);
    const ending = final('Hello');
    act(() => streams[0].push(ending));
    await waitFor(() => expect(loadMessages).toHaveBeenCalledTimes(2));
    await settle();

    /** Once the stored rows are read back, with the frame the generation ended on. */
    expect(onSettled).toHaveBeenCalledTimes(2);
    expect(onSettled).toHaveBeenLastCalledWith((ending as { data: unknown }).data);
    expect(held[1]).toEqual(['task-1:user', 'task-1:assistant']);
  });

  it('says a turn to a screen reader: started, still being written, done, and what it says', async () => {
    const clock = jest.spyOn(Date, 'now').mockReturnValue(1_000_000);
    const announce = jest.fn();
    const { transport, streams } = createTransport(running);
    setup({ transport, beside: { announce } });
    await waitFor(() => expect(streams).toHaveLength(1));
    const step = (): ChatEvent =>
      ({
        type: 'step',
        data: {
          event: StepEvents.ON_RUN_STEP,
          data: {
            id: 's0',
            runId: 'task-1:assistant',
            index: 0,
            type: StepTypes.MESSAGE_CREATION,
            stepDetails: {
              type: StepTypes.MESSAGE_CREATION,
              message_creation: { message_id: 's0' },
            },
            usage: null,
          },
        },
      }) as ChatEvent;

    act(() =>
      streams[0].push({
        type: 'created',
        data: {
          created: true,
          message: brief,
          turn: { responseMessageId: 'task-1:assistant' },
        },
      } as ChatEvent),
    );
    await settle();
    expect(announce.mock.calls).toEqual([[{ message: 'start', isStatus: true }]]);

    /** Soon after the start nothing more is said; later, that the reply is still being written. */
    act(() => streams[0].push(step()));
    await settle();
    expect(announce).toHaveBeenCalledTimes(1);
    clock.mockReturnValue(1_008_000);
    act(() => streams[0].push(token('Hel')));
    act(() => streams[0].push(token('lo')));
    await settle();
    expect(announce.mock.calls.slice(1)).toEqual([[{ message: 'composing', isStatus: true }]]);

    act(() => streams[0].push(final('Hello')));
    await settle();
    expect(announce.mock.calls.slice(2)).toEqual([
      [{ message: 'end', isStatus: true }],
      [{ message: 'Hello' }],
    ]);
    clock.mockRestore();
  });

  it('reads again when the generation ended between the status answer and the attach', async () => {
    const { transport } = createTransport(running);
    (transport.reconnectToStream as jest.Mock).mockResolvedValue(null);
    const { result, loadMessages } = setup({ transport });

    await waitFor(() => expect(loadMessages).toHaveBeenCalledTimes(2));
    await settle();

    expect(result.current.status).toBe('ready');
  });

  it('attaches to a generation that starts after the conversation was opened', async () => {
    const { transport, streams, setStatus } = createTransport(idle);
    const { result, rerender, loadMessages } = setup({ transport });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(streams).toHaveLength(0);

    setStatus(running);
    rerender({ id: 'thread-1', transport, loadMessages, live: true });
    await waitFor(() => expect(streams).toHaveLength(1));
    act(() => streams[0].push(snapshot('New run')));
    await settle();

    expect(textOf(result.current.messages)).toEqual(['New run']);
  });

  it('reads the stored messages again when the caller sees the run end with no stream', async () => {
    const { transport, streams } = createTransport(idle);
    const { result, rerender, loadMessages } = setup({ transport, live: true });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    await settle();
    expect(streams).toHaveLength(0);
    const reads = loadMessages.mock.calls.length;

    loadMessages.mockResolvedValue([brief, answer('Finished elsewhere')]);
    rerender({ id: 'thread-1', transport, loadMessages, live: false });

    await waitFor(() => expect(loadMessages).toHaveBeenCalledTimes(reads + 1));
    await waitFor(() => expect(textOf(result.current.messages)).toEqual(['Finished elsewhere']));
  });

  it('says whether there is a generation to follow', async () => {
    const { transport, streams, setStatus } = createTransport(running);
    const { result } = setup({ transport, live: true });
    await waitFor(() => expect(streams).toHaveLength(1));
    expect(result.current.isFollowing).toBe(true);
    expect(result.current.isUnattached).toBe(false);

    setStatus(idle);
    act(() => streams[0].push(final('Done')));
    await waitFor(() => expect(result.current.isFollowing).toBe(false));
    /** A run followed to its end was reached, whatever the caller still believes is running. */
    expect(result.current.isUnattached).toBe(false);
  });

  it('says a run the caller knows of has no stream only after looking for it again', async () => {
    const { transport } = createTransport(idle);
    let release: (messages: TMessage[]) => void = () => undefined;
    const loadMessages = jest.fn(
      () =>
        new Promise<TMessage[]>((resolve) => {
          release = resolve;
        }),
    );
    const { result } = setup({ transport, loadMessages, live: true });
    await settle();
    expect(result.current.isUnattached).toBe(false);

    loadMessages.mockResolvedValue([brief]);
    jest.useFakeTimers();
    try {
      await act(async () => {
        release([brief]);
        await jest.advanceTimersByTimeAsync(getReconnectDelay(1));
      });
      /** Not found once is not yet nothing to attach to. */
      expect(result.current.isUnattached).toBe(false);
      await act(async () => {
        await jest.advanceTimersByTimeAsync(60_000);
      });
    } finally {
      jest.useRealTimers();
    }
    await waitFor(() => expect(result.current.isUnattached).toBe(true));
    expect(result.current.isFollowing).toBe(false);
    expect(transport.reconnectToStream).toHaveBeenCalledTimes(1 + ABSENT_RETRIES);
  });

  it('follows a run whose stream opens a moment after the caller learns of it', async () => {
    const { transport, streams, setStatus } = createTransport(idle);
    const { result } = setup({ transport, live: true });
    await waitFor(() => expect(transport.reconnectToStream).toHaveBeenCalledTimes(1));
    expect(streams).toHaveLength(0);

    /** The run was announced first; its generation opens now. */
    setStatus(running);
    jest.useFakeTimers();
    try {
      await act(async () => {
        await jest.advanceTimersByTimeAsync(getReconnectDelay(1));
      });
    } finally {
      jest.useRealTimers();
    }
    await waitFor(() => expect(streams).toHaveLength(1));
    act(() => streams[0].push(snapshot('Late start')));
    await settle();

    expect(textOf(result.current.messages)).toEqual(['Late start']);
    expect(result.current.isUnattached).toBe(false);
  });

  it('says the stream is gone once a dropped one could not be attached again', async () => {
    const { transport, streams } = createTransport(running);
    const { result } = setup({ transport, live: true });
    await waitFor(() => expect(streams).toHaveLength(1));
    act(() => streams[0].push(snapshot('Partial')));
    await settle();

    jest.useFakeTimers();
    try {
      (transport.reconnectToStream as jest.Mock).mockRejectedValue(
        Object.assign(new Error('offline'), { code: 'ERR_NETWORK' }),
      );
      await act(async () => {
        streams[0].push({ type: 'error', status: 0 });
        await jest.advanceTimersByTimeAsync(getReconnectDelay(1));
      });
      /** Still trying: a dropped stream is not a missing one. */
      expect(result.current.isFollowing).toBe(true);
      expect(result.current.isUnattached).toBe(false);

      await act(async () => {
        await jest.advanceTimersByTimeAsync(10 * 60_000);
      });
    } finally {
      jest.useRealTimers();
    }

    await waitFor(() => expect(result.current.isUnattached).toBe(true));
    expect(result.current.isFollowing).toBe(false);
    expect(textOf(result.current.messages)).toEqual(['Partial']);
  });

  it('follows nothing while disabled, and starts when enabled', async () => {
    const { transport, streams } = createTransport(running);
    const { result, rerender, loadMessages } = setup({ transport, enabled: false });
    await settle();

    expect(loadMessages).not.toHaveBeenCalled();
    expect(transport.getStatus).not.toHaveBeenCalled();
    expect(result.current).toMatchObject({ chat: undefined, isLoading: false, messages: [] });

    rerender({ id: 'thread-1', transport, loadMessages, enabled: true });
    await waitFor(() => expect(streams).toHaveLength(1));
  });

  it('does not attach on a live signal before the stored messages are in', async () => {
    const { transport, streams } = createTransport(running);
    let release: (messages: TMessage[]) => void = () => undefined;
    const loadMessages = jest.fn(
      () =>
        new Promise<TMessage[]>((resolve) => {
          release = resolve;
        }),
    );
    const { result } = setup({ transport, loadMessages, live: true });
    await settle();

    expect(streams).toHaveLength(0);
    expect(result.current.isLoading).toBe(true);

    await act(async () => release([brief]));
    await waitFor(() => expect(streams).toHaveLength(1));
  });

  it('attaches to a run signalled while the stored messages were still being read', async () => {
    const { transport, streams, setStatus } = createTransport(idle);
    let release: (messages: TMessage[]) => void = () => undefined;
    const loadMessages = jest.fn(
      () =>
        new Promise<TMessage[]>((resolve) => {
          release = resolve;
        }),
    );
    const { result, rerender } = setup({ transport, loadMessages });
    await settle();
    expect(transport.getStatus).toHaveBeenCalledTimes(1);

    setStatus(running);
    rerender({ id: 'thread-1', transport, loadMessages, live: true });
    await settle();
    expect(streams).toHaveLength(0);

    await act(async () => release([brief]));
    await waitFor(() => expect(streams).toHaveLength(1));
    expect(result.current.isLoading).toBe(false);
  });

  it('keeps what a dropped stream showed and attaches again instead of reading stored rows', async () => {
    const { transport, streams } = createTransport(running);
    const { result, loadMessages } = setup({ transport });
    await waitFor(() => expect(streams).toHaveLength(1));
    act(() => streams[0].push(snapshot('Partial')));
    await settle();
    expect(loadMessages).toHaveBeenCalledTimes(1);

    jest.useFakeTimers();
    try {
      await act(async () => {
        streams[0].push({ type: 'error', status: 0 });
        await jest.advanceTimersByTimeAsync(getReconnectDelay(1) - 1);
      });
      expect(streams).toHaveLength(1);
      expect(loadMessages).toHaveBeenCalledTimes(1);
      expect(textOf(result.current.messages)).toEqual(['Partial']);

      await act(async () => {
        await jest.advanceTimersByTimeAsync(1);
      });
    } finally {
      jest.useRealTimers();
    }
    await waitFor(() => expect(streams).toHaveLength(2));
    expect(loadMessages).toHaveBeenCalledTimes(1);

    act(() => streams[1].push(snapshot('Partial and more')));
    await settle();
    expect(textOf(result.current.messages)).toEqual(['Partial and more']);

    loadMessages.mockResolvedValue([brief, answer('Stored')]);
    act(() => streams[1].push(final('Partial and more')));
    await waitFor(() => expect(textOf(result.current.messages)).toEqual(['Stored']));
    expect(loadMessages).toHaveBeenCalledTimes(2);
  });

  it('stops attaching after the reconnect schedule runs out, with what it showed still there', async () => {
    const { transport, streams } = createTransport(running);
    const { result, loadMessages } = setup({ transport });
    await waitFor(() => expect(streams).toHaveLength(1));
    act(() => streams[0].push(snapshot('Partial')));
    await settle();

    jest.useFakeTimers();
    try {
      (transport.reconnectToStream as jest.Mock).mockRejectedValue(
        Object.assign(new Error('offline'), { code: 'ERR_NETWORK' }),
      );
      await act(async () => {
        streams[0].push({ type: 'error', status: 0 });
        await jest.advanceTimersByTimeAsync(10 * 60_000);
      });
    } finally {
      jest.useRealTimers();
    }

    expect(transport.reconnectToStream).toHaveBeenCalledTimes(1 + MAX_RETRIES);
    expect(loadMessages).toHaveBeenCalledTimes(1);
    expect(textOf(result.current.messages)).toEqual(['Partial']);
    expect(result.current.status).toBe('error');
  });

  it('counts an attachment that only reports a failure as failed, so the schedule still runs out', async () => {
    const { transport, streams } = createTransport(running);
    const { result, loadMessages } = setup({ transport });
    await waitFor(() => expect(streams).toHaveLength(1));
    act(() => streams[0].push(snapshot('Partial')));
    await settle();

    jest.useFakeTimers();
    try {
      /** Every later attachment opens and then drops before delivering anything. */
      (transport.reconnectToStream as jest.Mock).mockImplementation(async () => {
        const stream = createStream();
        streams.push(stream);
        stream.push({ type: 'error', status: 0 });
        return stream;
      });
      await act(async () => {
        streams[0].push({ type: 'error', status: 0 });
        await jest.advanceTimersByTimeAsync(10 * 60_000);
      });
    } finally {
      jest.useRealTimers();
    }

    expect(transport.reconnectToStream).toHaveBeenCalledTimes(1 + MAX_RETRIES);
    expect(loadMessages).toHaveBeenCalledTimes(1);
    expect(textOf(result.current.messages)).toEqual(['Partial']);
  });

  it('follows a run signalled while the stored rows of the one before it were being read', async () => {
    const { transport, streams } = createTransport(running);
    const { result, rerender, loadMessages } = setup({ transport, live: true });
    await waitFor(() => expect(streams).toHaveLength(1));
    act(() => streams[0].push(snapshot('First run')));
    await settle();

    let release: (messages: TMessage[]) => void = () => undefined;
    loadMessages.mockImplementation(
      () =>
        new Promise<TMessage[]>((resolve) => {
          release = resolve;
        }),
    );
    act(() => streams[0].push(final('First run')));
    await waitFor(() => expect(loadMessages).toHaveBeenCalledTimes(2));

    rerender({ id: 'thread-1', transport, loadMessages, live: false });
    rerender({ id: 'thread-1', transport, loadMessages, live: true });
    await settle();
    expect(streams).toHaveLength(1);

    loadMessages.mockResolvedValue([brief, answer('First run')]);
    await act(async () => release([brief, answer('First run')]));
    await waitFor(() => expect(streams).toHaveLength(2));
    act(() => streams[1].push(snapshot('Second run')));
    await settle();
    expect(textOf(result.current.messages)).toEqual(['Second run']);
  });

  it('shows the stored messages when the status cannot be read, and still tries to attach', async () => {
    const { transport, streams } = createTransport(running);
    (transport.getStatus as jest.Mock).mockRejectedValueOnce(new Error('status unavailable'));
    const { result } = setup({ transport });

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.isLoadError).toBe(false);
    expect(result.current.messages).toEqual([brief]);
    await waitFor(() => expect(streams).toHaveLength(1));
  });

  it('reads nothing more once it is gone, even with a reconnect still waiting', async () => {
    const { transport, streams } = createTransport(running);
    const { loadMessages, unmount } = setup({ transport });
    await waitFor(() => expect(streams).toHaveLength(1));
    act(() => streams[0].push(snapshot('Partial')));
    await settle();

    jest.useFakeTimers();
    try {
      await act(async () => {
        streams[0].push({ type: 'error', status: 0 });
        await jest.advanceTimersByTimeAsync(1);
      });
      unmount();
      await jest.advanceTimersByTimeAsync(10 * 60_000);
    } finally {
      jest.useRealTimers();
    }
    await settle();

    expect(loadMessages).toHaveBeenCalledTimes(1);
    expect(streams).toHaveLength(1);
  });

  it("hands what the stream changes beside the list to the caller's handlers, as they are now", async () => {
    const { transport, streams } = createTransport(running);
    const first = jest.fn();
    const second = jest.fn();
    const { rerender, loadMessages } = setup({ transport, beside: { onAttachment: first } });
    await waitFor(() => expect(streams).toHaveLength(1));
    act(() => streams[0].push(snapshot('Partial')));
    await settle();

    const file = { messageId: 'task-1:assistant', file_id: 'file-1', filename: 'chart.png' };
    act(() => streams[0].push({ type: 'attachment', data: file } as ChatEvent));
    await settle();
    expect(first).toHaveBeenCalledWith(expect.objectContaining({ data: file }));

    rerender({ id: 'thread-1', transport, loadMessages, beside: { onAttachment: second } });
    act(() =>
      streams[0].push({ type: 'attachment', data: { ...file, file_id: 'file-2' } } as ChatEvent),
    );
    await settle();
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ file_id: 'file-2' }) }),
    );
  });

  it('leaves the conversation it was following when the id changes', async () => {
    const { transport, streams } = createTransport(running);
    const { result, rerender, loadMessages } = setup({ transport });
    await waitFor(() => expect(streams).toHaveLength(1));

    loadMessages.mockResolvedValue([]);
    rerender({ id: 'thread-2', transport, loadMessages });
    await waitFor(() => expect(streams).toHaveLength(2));

    expect(streams[0].closed).toBe(true);
    expect(streams[1].closed).toBe(false);
    expect(result.current.chat?.id).toBe('thread-2');
    expect(result.current.messages).toEqual([]);
  });

  it('closes the stream when it unmounts', async () => {
    const { transport, streams } = createTransport(running);
    const { unmount } = setup({ transport });
    await waitFor(() => expect(streams).toHaveLength(1));

    unmount();

    expect(streams[0].closed).toBe(true);
  });

  it('reports stored messages it could not read, and reads them on retry', async () => {
    const { transport } = createTransport(idle);
    const loadMessages = jest.fn<Promise<TMessage[]>, []>().mockRejectedValueOnce(new Error('no'));
    const { result } = setup({ transport, loadMessages });
    await waitFor(() => expect(result.current.isLoadError).toBe(true));
    expect(result.current.isLoading).toBe(false);

    loadMessages.mockResolvedValue([brief]);
    act(() => result.current.retry());
    await waitFor(() => expect(result.current.isLoadError).toBe(false));
    await waitFor(() => expect(result.current.messages).toEqual([brief]));
  });

  it('reports a stream that failed as the chat error, keeping what was shown', async () => {
    const { transport, streams } = createTransport(running);
    const { result } = setup({ transport });
    await waitFor(() => expect(streams).toHaveLength(1));
    act(() => streams[0].push(snapshot('Partial')));
    await settle();

    act(() => streams[0].push({ type: 'error', status: 500, data: { message: 'failed' } }));
    await waitFor(() => expect(result.current.status).toBe('error'));

    expect(result.current.error).toBeInstanceOf(Error);
    expect(result.current.isLoadError).toBe(false);
  });

  describe('a conversation read a page at a time', () => {
    const row = (index: number): TMessage => ({
      messageId: `row-${index}`,
      conversationId: 'thread-1',
      parentMessageId: index === 0 ? (Constants.NO_PARENT as string) : `row-${index - 1}`,
      isCreatedByUser: index % 2 === 0,
      text: `Row ${index}`,
    });
    const rows = (from: number, to: number) =>
      Array.from({ length: to - from + 1 }, (_, offset) => row(from + offset));
    const ids = (messages: TMessage[]) => messages.map((message) => message.messageId);
    /** A store of ten rows that serves the newest four, then four before a cursor, and so on. */
    const paged = (stored: TMessage[] = rows(0, 9)) =>
      jest.fn(async (cursor?: string) => {
        const end = cursor == null ? stored.length : Number(cursor);
        const start = Math.max(0, end - 4);
        return { messages: stored.slice(start, end), earlier: start > 0 ? String(start) : null };
      });

    it('shows the newest page and says older rows exist', async () => {
      const { transport } = createTransport(idle);
      const loadMessages = paged();
      const { result } = setup({ transport, loadMessages });
      await waitFor(() => expect(result.current.isLoading).toBe(false));

      expect(ids(result.current.messages)).toEqual(ids(rows(6, 9)));
      expect(result.current.hasEarlier).toBe(true);
      expect(loadMessages).toHaveBeenCalledWith();
    });

    it('puts each earlier page ahead of the list until the first row is in', async () => {
      const { transport } = createTransport(idle);
      const loadMessages = paged();
      const { result } = setup({ transport, loadMessages });
      await waitFor(() => expect(result.current.isLoading).toBe(false));

      act(() => result.current.loadEarlier());
      expect(result.current.isLoadingEarlier).toBe(true);
      await waitFor(() => expect(ids(result.current.messages)).toEqual(ids(rows(2, 9))));
      expect(loadMessages).toHaveBeenLastCalledWith('6');
      expect(result.current.isLoadingEarlier).toBe(false);
      expect(result.current.hasEarlier).toBe(true);

      act(() => result.current.loadEarlier());
      await waitFor(() => expect(ids(result.current.messages)).toEqual(ids(rows(0, 9))));
      expect(result.current.hasEarlier).toBe(false);

      /** Nothing is before the first row, so nothing more is read. */
      act(() => result.current.loadEarlier());
      await settle();
      expect(loadMessages).toHaveBeenCalledTimes(3);
    });

    it('keeps the earlier rows it paged back to when the newest page is read again', async () => {
      const { transport, streams, setStatus } = createTransport(idle);
      const stored = rows(0, 9);
      const loadMessages = paged(stored);
      const { result, rerender } = setup({ transport, loadMessages });
      await waitFor(() => expect(result.current.isLoading).toBe(false));
      act(() => result.current.loadEarlier());
      await waitFor(() => expect(result.current.messages).toHaveLength(8));

      /** A run adds a row and ends; the newest page now starts one row later. */
      stored.push(row(10));
      setStatus(running);
      rerender({ id: 'thread-1', transport, loadMessages, live: true });
      await waitFor(() => expect(streams).toHaveLength(1));
      setStatus(idle);
      act(() =>
        streams[0].push({
          type: 'final',
          data: {
            final: true,
            conversation: { conversationId: 'thread-1' },
            requestMessage: row(9),
            responseMessage: row(10),
          },
        } as ChatEvent),
      );

      await waitFor(() => expect(ids(result.current.messages)).toEqual(ids(rows(2, 10))));
      /** Still two rows short of the start, and the cursor for them still stands. */
      expect(result.current.hasEarlier).toBe(true);
      act(() => result.current.loadEarlier());
      await waitFor(() => expect(ids(result.current.messages)).toEqual(ids(rows(0, 10))));
    });

    it('starts over from a newest page that does not join the rows it holds', async () => {
      const { transport } = createTransport(idle);
      const stored = rows(0, 9);
      const loadMessages = paged(stored);
      const { result } = setup({ transport, loadMessages });
      await waitFor(() => expect(result.current.isLoading).toBe(false));
      act(() => result.current.loadEarlier());
      await waitFor(() => expect(result.current.messages).toHaveLength(8));

      /** More than a page was written since: what is held ends before the new page begins. */
      stored.push(...rows(10, 19));
      act(() => result.current.retry());

      await waitFor(() => expect(ids(result.current.messages)).toEqual(ids(rows(16, 19))));
      /** No silent gap: the rows between are older rows still to be read. */
      expect(result.current.hasEarlier).toBe(true);
    });

    it('offers the earlier rows again to a follower that starts on rows another one left', async () => {
      const { transport } = createTransport(idle);
      const loadMessages = paged();
      const { result } = setup({ transport, loadMessages });
      await waitFor(() => expect(result.current.isLoading).toBe(false));
      act(() => result.current.loadEarlier());
      await waitFor(() => expect(result.current.messages).toHaveLength(8));

      /** A new follower of the same conversation: the cache still holds those eight rows. */
      act(() => result.current.retry());
      await waitFor(() => expect(result.current.isLoading).toBe(false));

      /** It knows where its own page begins, not where the rows it inherited did. */
      await waitFor(() => expect(ids(result.current.messages)).toEqual(ids(rows(6, 9))));
      expect(result.current.hasEarlier).toBe(true);
      act(() => result.current.loadEarlier());
      await waitFor(() => expect(ids(result.current.messages)).toEqual(ids(rows(2, 9))));
      act(() => result.current.loadEarlier());
      await waitFor(() => expect(ids(result.current.messages)).toEqual(ids(rows(0, 9))));
      expect(result.current.hasEarlier).toBe(false);
    });

    it('says when an earlier page could not be read, and reads it when asked again', async () => {
      const { transport } = createTransport(idle);
      const loadMessages = paged();
      const { result } = setup({ transport, loadMessages });
      await waitFor(() => expect(result.current.isLoading).toBe(false));
      loadMessages.mockRejectedValueOnce(new Error('offline'));

      act(() => result.current.loadEarlier());
      await waitFor(() => expect(result.current.isEarlierError).toBe(true));
      expect(result.current.isLoadingEarlier).toBe(false);
      expect(result.current.hasEarlier).toBe(true);
      expect(ids(result.current.messages)).toEqual(ids(rows(6, 9)));

      act(() => result.current.loadEarlier());
      await waitFor(() => expect(ids(result.current.messages)).toEqual(ids(rows(2, 9))));
      expect(result.current.isEarlierError).toBe(false);
    });

    it('takes a plain list as the whole conversation', async () => {
      const { transport } = createTransport(idle);
      const { result } = setup({ transport, loadMessages: jest.fn(async () => rows(0, 3)) });
      await waitFor(() => expect(result.current.isLoading).toBe(false));

      expect(ids(result.current.messages)).toEqual(ids(rows(0, 3)));
      expect(result.current.hasEarlier).toBe(false);
    });
  });
});
