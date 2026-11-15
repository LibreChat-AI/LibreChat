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
import { useFollowChat } from '../follow';

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
});
