/**
 * @jest-environment jsdom
 */
import { ContentTypes } from 'librechat-data-provider';
import { act, renderHook } from '@testing-library/react';
import type { TMessage, TPayload, ChatEvent, UIMappingOptions } from 'librechat-data-provider';
import type { ChatState, ChatStream, ChatSendResult } from '../../core';
import { useCoreChat } from '../core';
import { Chat } from '../../core';

const createStream = () => {
  const queued: ChatEvent[] = [];
  let wake: (() => void) | undefined;
  let closed = false;
  const stream: ChatStream & { push(event: ChatEvent): void } = {
    push(event) {
      queued.push(event);
      wake?.();
    },
    close() {
      closed = true;
      wake?.();
    },
    async *[Symbol.asyncIterator]() {
      while (true) {
        while (queued.length > 0) {
          yield queued.shift() as ChatEvent;
        }
        if (closed) {
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

const createState = (): ChatState => {
  let messages: TMessage[] = [];
  return {
    status: 'ready',
    error: undefined,
    connection: 'idle',
    get messages() {
      return messages;
    },
    replaceMessages(next) {
      messages = next;
    },
  };
};

const userMessage: TMessage = {
  messageId: 'user-1',
  conversationId: 'convo-1',
  parentMessageId: null,
  isCreatedByUser: true,
  text: 'Hi',
};

const response = (text: string): TMessage => ({
  messageId: 'response-1',
  conversationId: 'convo-1',
  parentMessageId: 'user-1',
  isCreatedByUser: false,
  text,
  content: [{ type: ContentTypes.TEXT, text }],
});

/** Writes the streamed text onto the response, as a host's event reducer does. */
const applyText = (
  event: ChatEvent,
  context: { messages: TMessage[]; write(m: TMessage[]): void },
) => {
  if (event.type === 'text') {
    context.write([userMessage, response(event.data.text ?? '')]);
  }
};

const noRules = (): UIMappingOptions => ({});

const setup = () => {
  const stream = createStream();
  const transport = {
    sendMessages: jest.fn(async () => ({ status: 'stream' as const, stream })),
    reconnectToStream: jest.fn(async () => null),
    abort: jest.fn(async () => ({ success: true })),
  };
  const chat = new Chat({
    id: 'convo-1',
    state: createState(),
    transport,
    applyEvent: applyText,
    prepareRequest: () => ({
      payload: { endpoint: 'agents' } as TPayload,
      messages: [userMessage, response('')],
    }),
  });
  return { chat, stream, transport };
};

const flush = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));

describe('useCoreChat', () => {
  it('renders the turn as UI messages with the status it is in', async () => {
    const { chat, stream } = setup();
    const { result } = renderHook(() => useCoreChat({ chat, getMappingOptions: noRules }));
    expect(result.current.status).toBe('ready');
    expect(result.current.messages).toEqual([]);

    let sent: Promise<void> = Promise.resolve();
    act(() => {
      sent = result.current.sendMessage({ parts: [{ type: 'text', text: 'Hi' }] });
    });
    await flush();
    expect(result.current.status).toBe('submitted');
    expect(result.current.connection).toBe('live');
    expect(result.current.messages.map((message) => message.id)).toEqual(['user-1', 'response-1']);

    stream.push({ type: 'text', data: { message: true, text: 'Hel' } });
    await flush();
    expect(result.current.status).toBe('streaming');
    expect(result.current.messages[1].parts).toEqual([{ type: 'text', text: 'Hel' }]);

    stream.push({ type: 'final', data: { final: true } });
    await act(() => sent);
    expect(result.current.status).toBe('ready');
    expect(result.current.connection).toBe('idle');
    expect(result.current.messages[1].parts).toEqual([{ type: 'text', text: 'Hel' }]);
  });

  it('throttles message updates but renders a status change at once', async () => {
    jest.useFakeTimers();
    try {
      const { chat, stream } = setup();
      let renders = 0;
      const { result } = renderHook(() => {
        renders += 1;
        return useCoreChat({ chat, getMappingOptions: noRules, throttle: 1000 });
      });
      let sent: Promise<void> = Promise.resolve();
      await act(async () => {
        sent = chat.sendMessage({ parts: [{ type: 'text', text: 'Hi' }] });
        await jest.advanceTimersByTimeAsync(1000);
      });
      stream.push({ type: 'text', data: { message: true, text: 'H' } });
      await act(() => jest.advanceTimersByTimeAsync(0));
      const before = renders;

      stream.push({ type: 'text', data: { message: true, text: 'He' } });
      stream.push({ type: 'text', data: { message: true, text: 'Hel' } });
      await act(() => jest.advanceTimersByTimeAsync(0));
      expect(renders).toBe(before);
      expect(result.current.messages[1].parts).toEqual([{ type: 'text', text: 'H' }]);

      await act(() => jest.advanceTimersByTimeAsync(1000));
      expect(result.current.messages[1].parts).toEqual([{ type: 'text', text: 'Hel' }]);

      stream.push({ type: 'error', data: 'Rate limited' } as ChatEvent);
      await act(async () => {
        await jest.advanceTimersByTimeAsync(0);
        await sent;
      });
      expect(result.current.status).toBe('error');
      expect(result.current.error?.message).toBe('Rate limited');
    } finally {
      jest.useRealTimers();
    }
  });

  it('renders a write that keeps the same list', async () => {
    const { chat } = setup();
    const list = [userMessage, response('Hello')];
    await chat.setMessages(list);
    const { result } = renderHook(() => useCoreChat({ chat, getMappingOptions: noRules }));
    expect(result.current.messages[1].parts).toEqual([{ type: 'text', text: 'Hello' }]);

    list[1] = response('Edited');
    await act(() => chat.setMessages(list));

    expect(result.current.messages[1].parts).toEqual([{ type: 'text', text: 'Edited' }]);
  });

  it('clears an error back to ready', async () => {
    const { chat, stream } = setup();
    const { result } = renderHook(() => useCoreChat({ chat, getMappingOptions: noRules }));

    let sent: Promise<void> = Promise.resolve();
    act(() => {
      sent = result.current.sendMessage({ parts: [{ type: 'text', text: 'Hi' }] });
    });
    stream.push({ type: 'error', data: 'Rate limited' } as ChatEvent);
    await act(() => sent);
    expect(result.current.status).toBe('error');

    act(() => result.current.clearError());
    expect(result.current.status).toBe('ready');
    expect(result.current.error).toBeUndefined();
  });

  it('writes views back onto the stored messages under the active branch', async () => {
    const { chat } = setup();
    const sibling: TMessage = { ...response('Other'), messageId: 'response-2' };
    await chat.setMessages([userMessage, response('Hello'), sibling]);
    const { result } = renderHook(() =>
      useCoreChat({ chat, getMappingOptions: noRules, latestMessageId: 'response-1' }),
    );

    await act(() =>
      result.current.setMessages((views) => [
        ...views,
        { id: 'note-1', role: 'assistant', parts: [{ type: 'text', text: 'Note' }] },
      ]),
    );

    expect(chat.messages[0]).toEqual(userMessage);
    expect(chat.messages[3]).toMatchObject({
      messageId: 'note-1',
      conversationId: 'convo-1',
      parentMessageId: 'response-1',
    });
    expect(result.current.messages).toHaveLength(4);
  });

  it('leaves the rows its edit did not touch to the rollback of a replaced start', async () => {
    const earlier: TMessage = { ...userMessage, messageId: 'earlier-1', text: 'Earlier' };
    const state = createState();
    state.replaceMessages([earlier]);
    let answer: ((result: ChatSendResult) => void) | undefined;
    const chat = new Chat({
      id: 'convo-1',
      state,
      transport: {
        sendMessages: jest.fn(
          () =>
            new Promise<ChatSendResult>((resolve) => {
              answer = resolve;
            }),
        ),
        reconnectToStream: jest.fn(async () => {
          const stream = createStream();
          stream.push({
            type: 'final',
            data: { final: true, requestMessage: null, responseMessage: null },
          } as ChatEvent);
          stream.close();
          return stream;
        }),
        abort: jest.fn(async () => ({ success: true })),
      },
      prepareRequest: () => ({
        payload: { endpoint: 'agents' } as TPayload,
        messages: (current: TMessage[]) => [...current, userMessage, response('')],
        responseMessageId: 'response-1',
      }),
    });
    const { result } = renderHook(() => useCoreChat({ chat, getMappingOptions: noRules }));

    const sent = chat.sendMessage({ parts: [{ type: 'text', text: 'Hi' }] });
    await flush();
    await act(() =>
      result.current.setMessages((views) =>
        views.map((view) =>
          view.id === 'earlier-1' ? { ...view, parts: [{ type: 'text', text: 'Edited' }] } : view,
        ),
      ),
    );
    answer?.({
      status: 'replaced',
      conversationId: 'convo-1',
      streamId: 'stream-2',
      generationCreatedAt: 200,
      generationProtocolVersion: 2,
    });
    await act(() => sent);

    expect(chat.messages.map((message) => message.messageId)).toEqual(['earlier-1']);
    expect(chat.messages[0]).not.toBe(earlier);
  });

  it('files a message it adds under the conversation the server created for a new chat', async () => {
    const chat = new Chat({
      id: 'new',
      state: createState(),
      transport: {
        sendMessages: jest.fn(async () => ({
          status: 'settled' as const,
          conversationId: 'convo-9',
          generationProtocolVersion: 2,
        })),
        reconnectToStream: jest.fn(async () => null),
        abort: jest.fn(async () => ({ success: true })),
      },
      prepareRequest: () => ({
        payload: { endpoint: 'agents' } as TPayload,
        messages: [{ ...userMessage, conversationId: 'convo-9' }],
      }),
    });
    const { result } = renderHook(() => useCoreChat({ chat, getMappingOptions: noRules }));

    await act(() => chat.sendMessage({ parts: [{ type: 'text', text: 'Hi' }] }));
    await act(() =>
      result.current.setMessages((views) => [
        ...views,
        { id: 'note-1', role: 'assistant', parts: [{ type: 'text', text: 'Note' }] },
      ]),
    );

    expect(chat.conversationId).toBe('convo-9');
    expect(chat.messages[1]).toMatchObject({ messageId: 'note-1', conversationId: 'convo-9' });
  });

  it('applies the host tool rules to tool parts', async () => {
    const { chat } = setup();
    await chat.setMessages([
      userMessage,
      {
        ...response(''),
        content: [
          {
            type: ContentTypes.TOOL_CALL,
            tool_call: { id: 'call-1', name: 'lookup', args: '{}', output: 'nope', progress: 1 },
          },
        ],
      } as TMessage,
    ]);
    const resolveToolFailure = jest.fn(() => 'Lookup failed');
    const getMappingOptions = (): UIMappingOptions => ({ resolveToolFailure });

    const { result } = renderHook(() => useCoreChat({ chat, getMappingOptions }));

    expect(result.current.messages[1].parts[0]).toMatchObject({
      state: 'output-error',
      errorText: 'Lookup failed',
    });
  });
});
