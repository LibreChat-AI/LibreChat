import type { TMessage, TPayload, ChatEvent } from 'librechat-data-provider';
import type { ChatStream, ChatSendResult, ChatTransport } from '../types';
import type { ChatState } from '../chat';
import { Chat } from '../chat';

const earlier: TMessage = {
  messageId: 'earlier-1',
  conversationId: 'convo-1',
  parentMessageId: null,
  isCreatedByUser: true,
  text: 'Earlier',
};

const userMessage: TMessage = { ...earlier, messageId: 'user-1', parentMessageId: 'earlier-1' };

const placeholder: TMessage = {
  messageId: 'response-1',
  conversationId: 'convo-1',
  parentMessageId: 'user-1',
  isCreatedByUser: false,
  text: '',
  content: [],
};

const payload = { endpoint: 'agents', conversationId: 'convo-1', text: 'Hi' } as TPayload;

const flush = async () => {
  for (let i = 0; i < 5; i++) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
};

const emptyStream = (): ChatStream => ({
  close: () => undefined,
  async *[Symbol.asyncIterator]() {
    yield {
      type: 'final',
      data: { final: true, requestMessage: null, responseMessage: null },
    } as ChatEvent;
  },
});

const createState = (initial: TMessage[]) => {
  let messages = initial;
  const listeners = new Set<() => void>();
  const state: ChatState & { external(next: TMessage[]): void } = {
    status: 'ready',
    error: undefined,
    connection: 'idle',
    get messages() {
      return messages;
    },
    replaceMessages(next) {
      messages = next;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    /** A write another reader of the same store makes. */
    external(next) {
      messages = next;
      listeners.forEach((listener) => listener());
    },
  };
  return state;
};

const createChat = (state: ChatState, transport: Partial<ChatTransport> = {}) =>
  new Chat({
    id: 'convo-1',
    state,
    transport: {
      sendMessages: jest.fn(),
      reconnectToStream: jest.fn(async () => null),
      abort: jest.fn(),
      ...transport,
    } as ChatTransport,
    prepareRequest: () => ({
      payload,
      messages: (current: TMessage[]) => [...current, userMessage, placeholder],
      responseMessageId: 'response-1',
    }),
  });

describe('Chat.version', () => {
  it('counts a write that keeps the same list', async () => {
    const chat = createChat(createState([earlier]));
    const before = chat.version;

    await chat.setMessages(chat.messages);

    expect(chat.version).toBe(before + 1);
  });

  it('counts a write made to the state outside the chat while it is subscribed', () => {
    const state = createState([earlier]);
    const chat = createChat(state);
    const listener = jest.fn();
    const unsubscribe = chat.subscribe(listener);
    const before = chat.version;

    state.external([{ ...earlier, text: 'Edited' }]);

    expect(chat.version).toBe(before + 1);
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
  });
});

describe('Chat.setMessages', () => {
  it('replaces the list and notifies subscribers', async () => {
    const chat = createChat(createState([earlier]));
    const listener = jest.fn();
    chat.subscribe(listener);
    const next = [{ ...earlier, text: 'Edited' }];

    await chat.setMessages(next);

    expect(chat.messages).toBe(next);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('hands a function the list current when it is written', async () => {
    const chat = createChat(createState([earlier]));
    const first = chat.setMessages((current) => [...current, userMessage]);
    const second = chat.setMessages((current) => [...current, placeholder]);
    await Promise.all([first, second]);

    expect(chat.messages.map((message) => message.messageId)).toEqual([
      'earlier-1',
      'user-1',
      'response-1',
    ]);
  });

  it('writes nothing once the chat is disposed', async () => {
    const state = createState([earlier]);
    const chat = createChat(state);
    chat.dispose();

    await chat.setMessages([]);

    expect(state.messages).toEqual([earlier]);
  });

  it('never runs a function once the chat is disposed, one queued before the disposal included', async () => {
    const state = createState([earlier]);
    const chat = createChat(state);
    const updater = jest.fn((current: TMessage[]) => {
      current[0] = { ...earlier, text: 'Edited' };
      return current;
    });
    /** The first write runs at once; the second waits its turn behind it, past the disposal. */
    const first = chat.setMessages((current) => current);
    const queued = chat.setMessages(updater);
    chat.dispose();
    await Promise.all([first, queued]);
    await chat.setMessages(updater);

    expect(updater).not.toHaveBeenCalled();
    expect(state.messages).toEqual([earlier]);
  });

  it('keeps its write when the server replaces the start and the optimistic rows are undone', async () => {
    let answer: ((result: ChatSendResult) => void) | undefined;
    const state = createState([earlier]);
    const chat = createChat(state, {
      sendMessages: jest.fn(
        () =>
          new Promise<ChatSendResult>((resolve) => {
            answer = resolve;
          }),
      ),
      reconnectToStream: jest.fn(async () => emptyStream()),
    });
    const sent = chat.sendMessage({ parts: [{ type: 'text', text: 'Hi' }] });
    await flush();
    await chat.setMessages((current) =>
      current.map((message) =>
        message.messageId === 'earlier-1' ? { ...message, text: 'Edited' } : message,
      ),
    );

    answer?.({
      status: 'replaced',
      conversationId: 'convo-1',
      streamId: 'stream-2',
      generationCreatedAt: 200,
      generationProtocolVersion: 2,
    });
    await sent;

    expect(chat.messages.map((message) => `${message.messageId}:${message.text}`)).toEqual([
      'earlier-1:Edited',
    ]);
  });
});
