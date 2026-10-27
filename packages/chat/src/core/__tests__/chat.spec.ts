import { StepEvents } from 'librechat-data-provider';
import type { Agents, TMessage, TPayload, ChatEvent } from 'librechat-data-provider';
import type { ChatStream, ChatStatus, ChatTransport, ChatConnection } from '../types';
import type { ChatState, ChatInit } from '../chat';
import { Chat } from '../chat';

/** A stream the test feeds event by event; closing it ends the iteration. */
const createStream = (meta: { streamId?: string; generationCreatedAt?: number } = {}) => {
  const queued: ChatEvent[] = [];
  let wake: (() => void) | undefined;
  let closed = false;
  const stream: ChatStream & { push(event: ChatEvent): void; closed(): boolean } = {
    ...meta,
    push(event) {
      queued.push(event);
      wake?.();
    },
    close() {
      closed = true;
      wake?.();
    },
    closed: () => closed,
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

const createState = (initial: TMessage[] = []) => {
  let messages = initial;
  const state: ChatState & { statuses: ChatStatus[] } = {
    statuses: [],
    error: undefined,
    connection: 'idle' as ChatConnection,
    get status() {
      return this.statuses[this.statuses.length - 1] ?? 'ready';
    },
    set status(status: ChatStatus) {
      this.statuses.push(status);
    },
    get messages() {
      return messages;
    },
    replaceMessages(next) {
      messages = next;
    },
  };
  return state;
};

const userMessage: TMessage = {
  messageId: 'user-1',
  conversationId: 'convo-1',
  parentMessageId: null,
  isCreatedByUser: true,
  text: 'Hi',
};

const placeholder: TMessage = {
  messageId: 'response-1',
  conversationId: 'convo-1',
  parentMessageId: 'user-1',
  isCreatedByUser: false,
  text: '',
  content: [],
};

const payload = { endpoint: 'agents', text: 'Hi' } as TPayload;

const stepEvent: ChatEvent = {
  type: 'step',
  data: { event: StepEvents.ON_MESSAGE_DELTA, data: { id: 'step-1', delta: { content: [] } } },
};

const finalEvent = (overrides: Partial<Extract<ChatEvent, { type: 'final' }>['data']> = {}) =>
  ({
    type: 'final',
    data: {
      final: true,
      requestMessage: userMessage,
      responseMessage: { ...placeholder, text: 'Hello' },
      ...overrides,
    },
  }) as ChatEvent;

type Transport = jest.Mocked<Required<ChatTransport>>;

const setup = (
  overrides: Partial<ChatInit> = {},
  transportOverrides: Partial<ChatTransport> = {},
) => {
  const stream = createStream({ streamId: 'convo-1', generationCreatedAt: 100 });
  const transport = {
    sendMessages: jest.fn(async () => ({ status: 'stream' as const, stream })),
    reconnectToStream: jest.fn(async () => null),
    abort: jest.fn(async () => ({ success: true })),
    resume: jest.fn(async () => ({
      streamId: 'convo-1',
      conversationId: 'convo-1',
      status: 'resuming' as const,
    })),
    ...transportOverrides,
  } as unknown as Transport;
  const state = createState([]);
  const onFinish = jest.fn();
  const onError = jest.fn();
  const onEvent = jest.fn();
  const chat = new Chat({
    id: 'convo-1',
    state,
    transport,
    prepareRequest: jest.fn(() => ({ payload, messages: [userMessage, placeholder] })),
    onFinish,
    onError,
    onEvent,
    ...overrides,
  });
  return { chat, stream, transport, state, onFinish, onError, onEvent };
};

/** Lets every queued stream event and executor job run. */
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('Chat', () => {
  it('walks submitted, streaming and ready, merging the final messages', async () => {
    const { chat, stream, transport, state, onFinish, onEvent } = setup();

    const sent = chat.sendMessage({ parts: [{ type: 'text', text: 'Hi' }] });
    await flush();
    expect(chat.status).toBe('submitted');
    expect(chat.connection).toBe('live');
    expect(chat.messages).toEqual([userMessage, placeholder]);
    expect(transport.sendMessages).toHaveBeenCalledWith(
      expect.objectContaining({ trigger: 'submit-message', chatId: 'convo-1', payload }),
    );

    stream.push({ type: 'created', data: { message: userMessage, created: true } });
    await flush();
    expect(chat.status).toBe('streaming');

    stream.push(finalEvent());
    await sent;

    expect(state.statuses).toEqual(['submitted', 'streaming', 'ready']);
    expect(chat.connection).toBe('idle');
    expect(chat.messages[1].text).toBe('Hello');
    expect(stream.closed()).toBe(true);
    expect(onEvent).toHaveBeenCalledTimes(2);
    expect(onFinish).toHaveBeenCalledWith(
      expect.objectContaining({ isAbort: false, isError: false, isDisconnect: false }),
    );
  });

  describe('a host listener that throws', () => {
    let reported: jest.SpyInstance;
    beforeEach(() => {
      reported = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    });

    it.each([
      ['the submitted state', (chat: Chat) => chat.status === 'submitted'],
      ['the live connection', (chat: Chat) => chat.connection === 'live'],
      ['a streamed frame', (chat: Chat) => chat.status === 'streaming'],
      ['the terminal state', (chat: Chat) => chat.status === 'ready'],
    ])('on %s neither ends the turn nor hides it from the others', async (_label, when) => {
      const { chat, stream, onFinish } = setup();
      const failure = new Error('listener failed');
      let thrown = false;
      chat.subscribe(() => {
        if (!thrown && when(chat)) {
          thrown = true;
          throw failure;
        }
      });
      const statuses: string[] = [];
      chat.subscribe(() => statuses.push(chat.status));

      const sent = chat.sendMessage({ parts: [{ type: 'text', text: 'Hi' }] });
      await flush();
      stream.push(stepEvent);
      await flush();
      stream.push(finalEvent());
      await sent;

      expect(thrown).toBe(true);
      expect(reported).toHaveBeenCalledWith(failure);
      expect(statuses).toEqual(expect.arrayContaining(['submitted', 'streaming', 'ready']));
      expect(onFinish).toHaveBeenCalledWith(
        expect.objectContaining({ isError: false, isAbort: false, isDisconnect: false }),
      );
      expect(chat.status).toBe('ready');
      expect(chat.connection).toBe('idle');
    });

    it('on dispose still releases the chat from its state', async () => {
      const { chat, state } = setup();
      const sent = chat.sendMessage({ parts: [{ type: 'text', text: 'Hi' }] });
      await flush();
      const listener = jest.fn(() => {
        throw new Error('listener failed');
      });
      chat.subscribe(listener);

      chat.dispose();
      listener.mockClear();
      state.replaceMessages([userMessage]);
      await sent;

      expect(chat.connection).toBe('idle');
      expect(listener).not.toHaveBeenCalled();
    });

    it('in onError still tells the host the turn finished', async () => {
      const onError = jest.fn(() => {
        throw new Error('callback failed');
      });
      const { chat, stream, onFinish } = setup({ onError });
      const sent = chat.sendMessage({ parts: [{ type: 'text', text: 'Hi' }] });
      await flush();
      stream.push({ type: 'error', status: 500, data: 'boom' } as ChatEvent);
      await sent;

      expect(onError).toHaveBeenCalled();
      expect(onFinish).toHaveBeenCalledWith(expect.objectContaining({ isError: true }));
    });

    it('in onEvent still ends the turn by its terminal frame', async () => {
      const onEvent = jest.fn(() => {
        throw new Error('callback failed');
      });
      const { chat, stream, onFinish } = setup({ onEvent });
      const sent = chat.sendMessage({ parts: [{ type: 'text', text: 'Hi' }] });
      await flush();
      stream.push(finalEvent());
      await sent;

      expect(onEvent).toHaveBeenCalled();
      expect(onFinish).toHaveBeenCalledWith(
        expect.objectContaining({ isError: false, isDisconnect: false }),
      );
    });
  });

  describe('dispose', () => {
    it('ends a turn that never reached the server and releases its send', async () => {
      const { chat, transport } = setup({
        prepareRequest: () => new Promise<never>(() => undefined),
      });
      const statuses: string[] = [];
      chat.subscribe(() => statuses.push(chat.status));
      const sent = chat.sendMessage({ parts: [{ type: 'text', text: 'Hi' }] });
      await flush();

      chat.dispose();

      await expect(sent).resolves.toBeUndefined();
      expect(chat.status).toBe('ready');
      expect(statuses[statuses.length - 1]).toBe('ready');
      expect(transport.sendMessages).not.toHaveBeenCalled();
    });

    it('undoes the optimistic rows of a turn disposed before it was sent', async () => {
      const earlier: TMessage = { ...placeholder, messageId: 'earlier-1', text: 'Earlier' };
      const state = createState([earlier]);
      const { chat, transport } = setup({
        state,
        prepareRequest: jest.fn(() => ({
          payload,
          messages: (current: TMessage[]) => [...current, userMessage, placeholder],
        })),
      });
      chat.subscribe(() => {
        if (chat.messages.length > 1) {
          chat.dispose();
        }
      });

      await chat.sendMessage({ parts: [{ type: 'text', text: 'Hi' }] });

      expect(transport.sendMessages).not.toHaveBeenCalled();
      expect(state.messages.map((message) => message.messageId)).toEqual(['earlier-1']);
      expect(chat.status).toBe('ready');
    });

    it('keeps a sent turn running on the server but releases its send', async () => {
      const { chat, transport } = setup();
      transport.sendMessages.mockImplementationOnce(() => new Promise<never>(() => undefined));
      const sent = chat.sendMessage({ parts: [{ type: 'text', text: 'Hi' }] });
      await flush();

      chat.dispose();

      await expect(sent).resolves.toBeUndefined();
      expect(chat.status).toBe('submitted');
      expect(chat.connection).toBe('idle');
    });
  });

  it('streams a turn whose first frame is a pause', async () => {
    const { chat, stream } = setup();
    const sent = chat.sendMessage({ parts: [{ type: 'text', text: 'Hi' }] });
    await flush();
    expect(chat.status).toBe('submitted');

    stream.push({
      type: 'pending_action',
      data: {
        actionId: 'action-1',
        streamId: 'convo-1',
        conversationId: 'convo-1',
        createdAt: 1,
        expiresAt: Date.now() + 60_000,
        payload: { type: 'ask_user_question', question: { question: 'Which?' }, tool_call_id: 'a' },
      } as Agents.PendingAction,
    });
    await flush();

    expect(chat.status).toBe('streaming');
    stream.push(finalEvent());
    await sent;
  });

  it('refuses a settled start the server did not negotiate under protocol v2', async () => {
    const { chat, onFinish } = setup(
      {},
      {
        sendMessages: jest.fn(async () => ({
          status: 'settled' as const,
          conversationId: 'convo-1',
        })),
      },
    );

    await chat.sendMessage({ parts: [{ type: 'text', text: 'Hi' }] });

    expect(chat.status).toBe('error');
    expect(onFinish).toHaveBeenCalledWith(
      expect.objectContaining({ isError: true, isSettled: false }),
    );
  });

  it('notifies subscribers of each change', async () => {
    const { chat, stream } = setup();
    const listener = jest.fn();
    const unsubscribe = chat.subscribe(listener);

    const sent = chat.sendMessage({ parts: [{ type: 'text', text: 'Hi' }] });
    stream.push(finalEvent());
    await sent;
    const calls = listener.mock.calls.length;
    unsubscribe();
    await chat.regenerate().catch(() => undefined);

    expect(calls).toBeGreaterThan(0);
    expect(listener).toHaveBeenCalledTimes(calls);
  });

  it('applies events through the host reducer one at a time, in wire order', async () => {
    const seen: string[] = [];
    const { chat, stream } = setup({
      applyEvent: (event, context) => {
        seen.push(event.type);
        if (event.type === 'step') {
          context.write([...context.messages, { ...placeholder, messageId: 'extra' }]);
        }
      },
    });

    const sent = chat.sendMessage({ parts: [{ type: 'text', text: 'Hi' }] });
    await flush();
    stream.push(stepEvent);
    stream.push(stepEvent);
    stream.push(finalEvent());
    await sent;

    expect(seen).toEqual(['step', 'step', 'final']);
    expect(chat.messages.map((message) => message.messageId)).toEqual([
      'user-1',
      'response-1',
      'extra',
      'extra',
    ]);
  });

  it('reports an error event as an error until it is cleared', async () => {
    const { chat, stream, onError, onFinish } = setup();

    const sent = chat.sendMessage({ parts: [{ type: 'text', text: 'Hi' }] });
    await flush();
    stream.push({ type: 'error', data: { message: 'Rate limited' } });
    await sent;

    expect(chat.status).toBe('error');
    expect(chat.error?.message).toBe('Rate limited');
    expect(onError).toHaveBeenCalledWith(chat.error);
    expect(onFinish).toHaveBeenCalledWith(expect.objectContaining({ isError: true }));

    chat.clearError();
    expect(chat.status).toBe('ready');
    expect(chat.error).toBeUndefined();
  });

  it('reports a final event with an error terminal status as an error', async () => {
    const { chat, stream } = setup();

    const sent = chat.sendMessage({ parts: [{ type: 'text', text: 'Hi' }] });
    stream.push(finalEvent({ terminalStatus: 'error', error: { message: 'Context too long' } }));
    await sent;

    expect(chat.status).toBe('error');
    expect(chat.error?.message).toBe('Context too long');
  });

  it('marks a dropped connection and a stream that ends early as a disconnect', async () => {
    const dropped = setup();
    const sent = dropped.chat.sendMessage({ parts: [{ type: 'text', text: 'Hi' }] });
    dropped.stream.push({ type: 'error', status: 0 });
    await sent;
    expect(dropped.onFinish).toHaveBeenCalledWith(
      expect.objectContaining({ isError: true, isDisconnect: true }),
    );

    const ended = setup();
    const endedSend = ended.chat.sendMessage({ parts: [{ type: 'text', text: 'Hi' }] });
    await flush();
    ended.stream.close();
    await endedSend;
    expect(ended.chat.status).toBe('error');
    expect(ended.onFinish).toHaveBeenCalledWith(expect.objectContaining({ isDisconnect: true }));
  });

  it('reports a failed start as an error and frees the chat for the next turn', async () => {
    const failure = new Error('start failed');
    const { chat, transport } = setup(
      {},
      { sendMessages: jest.fn(async () => Promise.reject(failure)) },
    );

    await chat.sendMessage({ parts: [{ type: 'text', text: 'Hi' }] });

    expect(chat.status).toBe('error');
    expect(chat.error).toBe(failure);
    transport.sendMessages.mockResolvedValueOnce({
      status: 'settled',
      conversationId: 'convo-1',
      generationProtocolVersion: 2,
    });
    await chat.sendMessage({ parts: [{ type: 'text', text: 'Again' }] });
    expect(chat.status).toBe('ready');
    expect(chat.error).toBeUndefined();
  });

  it('refuses a second turn while one is in flight', async () => {
    const { chat, stream } = setup();

    const first = chat.sendMessage({ parts: [{ type: 'text', text: 'Hi' }] });
    await expect(chat.sendMessage({ parts: [{ type: 'text', text: 'Again' }] })).rejects.toThrow(
      'already in flight',
    );
    stream.push(finalEvent());
    await first;

    expect(chat.status).toBe('ready');
  });

  it('merges a prepared turn into the list as it stands when the turn is written', async () => {
    const loaded: TMessage = { ...userMessage, messageId: 'loaded-1', text: 'Loaded' };
    let prepared: (() => void) | undefined;
    const { chat, state, stream } = setup({
      prepareRequest: jest.fn(
        () =>
          new Promise((resolve) => {
            prepared = () =>
              resolve({
                payload,
                messages: (current: TMessage[]) => [...current, userMessage, placeholder],
              });
          }),
      ),
    });

    const sent = chat.sendMessage({ parts: [{ type: 'text', text: 'Hi' }] });
    await flush();
    state.replaceMessages([loaded]);
    prepared?.();
    await flush();

    expect(state.messages.map((message) => message.messageId)).toEqual([
      'loaded-1',
      'user-1',
      'response-1',
    ]);
    stream.push(finalEvent());
    await sent;
  });

  it('drops its stream on dispose without reporting an error', async () => {
    const { chat, stream, onError, onFinish } = setup();

    const sent = chat.sendMessage({ parts: [{ type: 'text', text: 'Hi' }] });
    await flush();
    stream.push(stepEvent);
    await flush();
    chat.dispose();
    await sent;

    expect(stream.closed()).toBe(true);
    expect(onError).not.toHaveBeenCalled();
    expect(onFinish).not.toHaveBeenCalled();
    expect(chat.status).toBe('streaming');
  });

  it('settles a start the server already finished, and attaches to the generation replacing it', async () => {
    const settled = setup(
      {},
      {
        sendMessages: jest.fn(async () => ({
          status: 'settled' as const,
          conversationId: 'convo-1',
          generationProtocolVersion: 2,
        })),
      },
    );
    await settled.chat.sendMessage({ parts: [{ type: 'text', text: 'Hi' }] });
    expect(settled.chat.status).toBe('ready');

    const stream = createStream();
    const replaced = setup(
      {},
      {
        sendMessages: jest.fn(async () => ({
          status: 'replaced' as const,
          generationProtocolVersion: 2,
          conversationId: 'convo-1',
          streamId: 'stream-2',
          generationCreatedAt: 200,
        })),
        reconnectToStream: jest.fn(async () => stream),
      },
    );
    const sent = replaced.chat.sendMessage({ parts: [{ type: 'text', text: 'Hi' }] });
    await flush();
    stream.push(finalEvent());
    await sent;
    expect(replaced.transport.reconnectToStream).toHaveBeenCalledWith(
      expect.objectContaining({ streamId: 'stream-2', generationCreatedAt: 200, resume: true }),
    );
    expect(replaced.chat.status).toBe('ready');
  });

  it('lets a completion callback start the next turn', async () => {
    let next: Promise<void> | undefined;
    const { chat, stream, transport } = setup({
      onFinish: () => {
        next ??= chat.sendMessage({ parts: [{ type: 'text', text: 'Again' }] });
      },
    });

    const sent = chat.sendMessage({ parts: [{ type: 'text', text: 'Hi' }] });
    await flush();
    stream.push(finalEvent());
    await sent;
    await next;

    expect(transport.sendMessages).toHaveBeenCalledTimes(2);
  });

  it('keeps the next turn submitted when a subscriber starts it as the connection goes idle', async () => {
    let next: Promise<void> | undefined;
    const { chat, stream } = setup();
    const sent = chat.sendMessage({ parts: [{ type: 'text', text: 'Hi' }] });
    await flush();
    let started = false;
    const unsubscribe = chat.subscribe(() => {
      if (chat.connection === 'idle' && !started) {
        started = true;
        next = chat.sendMessage({ parts: [{ type: 'text', text: 'Again' }] });
      }
    });
    stream.push(finalEvent());
    await sent;

    expect(next).toBeDefined();
    expect(chat.status).toBe('submitted');
    unsubscribe();
  });

  it.each(['final', 'abort'] as const)(
    'finishes on %s with the response the turn produced, not the tail of another branch',
    async (end) => {
      const otherBranch: TMessage = { ...placeholder, messageId: 'other-1', parentMessageId: 'x' };
      const { chat, stream, onFinish } = setup({
        prepareRequest: jest.fn(() => ({
          payload,
          messages: [userMessage, placeholder, otherBranch],
          responseMessageId: 'response-1',
        })),
      });

      const sent = chat.sendMessage({ parts: [{ type: 'text', text: 'Hi' }] });
      await flush();
      stream.push(end === 'final' ? finalEvent() : ({ type: 'abort', data: {} } as ChatEvent));
      await sent;

      expect(onFinish).toHaveBeenCalledWith(
        expect.objectContaining({ message: expect.objectContaining({ messageId: 'response-1' }) }),
      );
    },
  );

  it('refuses a replacement the server did not report under protocol v2', async () => {
    const { chat, transport, onError } = setup(
      {},
      {
        sendMessages: jest.fn(async () => ({
          status: 'replaced' as const,
          conversationId: 'convo-1',
          streamId: 'stream-2',
          generationCreatedAt: 200,
        })),
      },
    );

    await chat.sendMessage({ parts: [{ type: 'text', text: 'Hi' }] });

    expect(transport.reconnectToStream).not.toHaveBeenCalled();
    expect(chat.status).toBe('error');
    expect(onError).toHaveBeenCalled();
  });

  it('settles a final frame that asks for reconciliation instead of completing it', async () => {
    const { chat, stream, onFinish } = setup();
    const sent = chat.sendMessage({ parts: [{ type: 'text', text: 'Hi' }] });
    await flush();
    stream.push({
      type: 'final',
      data: {
        final: true,
        reconcile: true,
        reconcileReason: 'abort_persistence_failed',
        terminalStatus: 'aborted',
      },
    } as ChatEvent);
    await sent;

    expect(onFinish).toHaveBeenCalledWith(
      expect.objectContaining({
        isAbort: true,
        isSettled: true,
        reconcileReason: 'abort_persistence_failed',
      }),
    );
  });

  it.each(['ERR_NETWORK', 'ERR_INTERNET_DISCONNECTED'])(
    'reports a start that never got a response (%s) as a disconnect',
    async (code) => {
      const failure = Object.assign(new Error('Network Error'), { code });
      const { chat, onFinish } = setup(
        {},
        { sendMessages: jest.fn(async () => Promise.reject(failure)) },
      );

      await chat.sendMessage({ parts: [{ type: 'text', text: 'Hi' }] });

      expect(onFinish).toHaveBeenCalledWith(
        expect.objectContaining({ isError: true, isDisconnect: true }),
      );
    },
  );

  it('reports a start the server settled before attaching for the host to reconcile', async () => {
    const { chat, onFinish } = setup(
      {},
      {
        sendMessages: jest.fn(async () => ({
          status: 'settled' as const,
          conversationId: 'c-9',
          generationProtocolVersion: 2,
        })),
      },
    );

    await chat.sendMessage({ parts: [{ type: 'text', text: 'Hi' }] });

    expect(onFinish).toHaveBeenCalledWith(
      expect.objectContaining({ isSettled: true, conversationId: 'c-9' }),
    );
  });

  it('reports no message when the named response left the list', async () => {
    const { chat, stream, state, onFinish } = setup({
      prepareRequest: jest.fn(() => ({
        payload,
        messages: [userMessage, placeholder],
        responseMessageId: 'response-1',
      })),
    });
    const sent = chat.sendMessage({ parts: [{ type: 'text', text: 'Hi' }] });
    await flush();
    state.replaceMessages([userMessage]);
    stream.push({ type: 'abort', data: {} } as ChatEvent);
    await sent;

    expect(onFinish).toHaveBeenCalledWith(expect.objectContaining({ message: undefined }));
  });

  it('continues a response with the continue trigger', async () => {
    const { chat, stream, transport } = setup();
    const sent = chat.continue({ messageId: 'response-1' });
    await flush();
    stream.push(finalEvent());
    await sent;

    expect(transport.sendMessages).toHaveBeenCalledWith(
      expect.objectContaining({ trigger: 'continue-message', messageId: 'response-1' }),
    );
  });

  it('regenerates a given message', async () => {
    const { stream, transport } = setup();
    const prepareRequest = jest.fn(() => ({ payload }));
    const regenerating = new Chat({
      id: 'convo-1',
      state: createState(),
      transport,
      prepareRequest,
    });

    const sent = regenerating.regenerate({ messageId: 'response-1' });
    stream.push(finalEvent());
    await sent;

    expect(prepareRequest).toHaveBeenCalledWith(
      expect.objectContaining({ trigger: 'regenerate-message', messageId: 'response-1' }),
    );
    expect(transport.sendMessages).toHaveBeenCalledWith(
      expect.objectContaining({ trigger: 'regenerate-message', messageId: 'response-1' }),
    );
    expect(regenerating.status).toBe('ready');
  });

  describe('replacement responses', () => {
    it('reports the response of a replacement that ended before any frame named it as unknown', async () => {
      const replacing = () => {
        const stream = createStream({ streamId: 'stream-2', generationCreatedAt: 200 });
        const harness = setup(
          {
            prepareRequest: jest.fn(() => ({
              payload,
              messages: [userMessage, placeholder],
              responseMessageId: placeholder.messageId,
            })),
          },
          {
            sendMessages: jest.fn(async () => ({
              status: 'replaced' as const,
              generationProtocolVersion: 2,
              conversationId: 'convo-1',
              streamId: 'stream-2',
              generationCreatedAt: 200,
            })),
            reconnectToStream: jest.fn(async () => stream),
          },
        );
        return { ...harness, stream };
      };

      const early = replacing();
      const sent = early.chat.sendMessage({ parts: [{ type: 'text', text: 'Hi' }] });
      await flush();
      early.stream.push({ type: 'abort', data: {} } as ChatEvent);
      await sent;
      expect(early.onFinish).toHaveBeenLastCalledWith(
        expect.objectContaining({ isAbort: true, isResponseUnknown: true, message: undefined }),
      );

      const named = replacing();
      const replacement: TMessage = { ...placeholder, messageId: 'response-2' };
      const sentNamed = named.chat.sendMessage({ parts: [{ type: 'text', text: 'Hi' }] });
      await flush();
      named.state.replaceMessages([...named.chat.messages, replacement]);
      named.stream.push({
        type: 'sync',
        data: { conversationId: 'convo-1', responseMessage: replacement },
      } as ChatEvent);
      named.stream.push({ type: 'abort', data: {} } as ChatEvent);
      await sentNamed;
      expect(named.onFinish).toHaveBeenLastCalledWith(
        expect.objectContaining({
          isResponseUnknown: false,
          message: expect.objectContaining({ messageId: 'response-2' }),
        }),
      );
    });

    it('sends the request options of a turn to the generation that replaced it', async () => {
      const stream = createStream();
      const { chat, transport } = setup(
        {},
        {
          sendMessages: jest.fn(async () => ({
            status: 'replaced' as const,
            generationProtocolVersion: 2,
            conversationId: 'convo-1',
            streamId: 'stream-2',
            generationCreatedAt: 200,
          })),
          reconnectToStream: jest.fn(async () => stream),
        },
      );
      const options = { headers: { 'x-tenant': 'acme' }, body: { spec: 'a' } };
      const sent = chat.sendMessage({ parts: [{ type: 'text', text: 'Hi' }] }, options);
      await flush();
      stream.push(finalEvent());
      await sent;

      expect(transport.reconnectToStream).toHaveBeenCalledWith(
        expect.objectContaining({ ...options, chatId: 'convo-1', streamId: 'stream-2' }),
      );
    });
  });

  describe('ids a turn reports', () => {
    it('opens no replacement a listener disposed the chat from on its reconnecting notice', async () => {
      const { chat, transport } = setup(
        {},
        {
          sendMessages: jest.fn(async () => ({
            status: 'replaced' as const,
            generationProtocolVersion: 2,
            conversationId: 'convo-1',
            streamId: 'stream-2',
            generationCreatedAt: 200,
          })),
        },
      );
      chat.subscribe(() => {
        if (chat.connection === 'reconnecting') {
          chat.dispose();
        }
      });

      await chat.sendMessage({ parts: [{ type: 'text', text: 'Hi' }] }).catch(() => undefined);

      expect(transport.reconnectToStream).not.toHaveBeenCalled();
    });

    it('stays idle when a listener disposes the chat on the rollback of a replaced start', async () => {
      const { chat, transport, state } = setup(
        {
          prepareRequest: jest.fn(() => ({ payload, messages: [userMessage, placeholder] })),
        },
        {
          sendMessages: jest.fn(async () => ({
            status: 'replaced' as const,
            generationProtocolVersion: 2,
            conversationId: 'convo-1',
            streamId: 'stream-2',
            generationCreatedAt: 200,
          })),
        },
      );
      let written = false;
      chat.subscribe(() => {
        written ||= chat.messages.length > 0;
        if (written && chat.messages.length === 0) {
          chat.dispose();
        }
      });

      await chat.sendMessage({ parts: [{ type: 'text', text: 'Hi' }] });

      expect(transport.reconnectToStream).not.toHaveBeenCalled();
      expect(state.connection).toBe('idle');
    });

    it('stops a stream event when a listener disposes the chat on its write', async () => {
      const { chat, stream, state, onEvent } = setup({
        applyEvent: (event, context) => {
          if (event.type === 'created') {
            context.write([...context.messages, { ...placeholder, messageId: 'created-1' }]);
          }
        },
      });
      chat.subscribe(() => {
        if (chat.messages.some((m) => m.messageId === 'created-1')) {
          chat.dispose();
        }
      });
      const sent = chat.sendMessage({ parts: [{ type: 'text', text: 'Hi' }] });
      await flush();
      stream.push({ type: 'created', data: { message: userMessage, created: true } });
      await sent;

      expect(state.statuses).not.toContain('streaming');
      expect(onEvent).not.toHaveBeenCalled();
    });

    it('reports no response for a turn whose optimistic write failed', async () => {
      const earlier: TMessage = { ...placeholder, messageId: 'earlier-1', text: 'Earlier' };
      const { chat, onFinish, transport } = setup({
        state: createState([userMessage, earlier]),
        prepareRequest: jest.fn(() => ({
          payload,
          messages: () => {
            throw new Error('Write failed');
          },
        })),
      });

      await chat.sendMessage({ parts: [{ type: 'text', text: 'Hi' }] }).catch(() => undefined);

      expect(transport.sendMessages).not.toHaveBeenCalled();
      expect(onFinish).toHaveBeenCalledWith(
        expect.objectContaining({ isError: true, message: undefined }),
      );
    });

    it('reports no response for a turn whose preparation failed', async () => {
      const earlier: TMessage = { ...placeholder, messageId: 'earlier-1', text: 'Earlier' };
      const { chat, onFinish } = setup({
        state: createState([userMessage, earlier]),
        prepareRequest: jest.fn(() => Promise.reject(new Error('Upload failed'))),
      });

      await chat.sendMessage({ parts: [{ type: 'text', text: 'Hi' }] }).catch(() => undefined);

      expect(onFinish).toHaveBeenCalledTimes(1);
      expect(onFinish).toHaveBeenCalledWith(
        expect.objectContaining({ isError: true, message: undefined }),
      );
    });
  });
});

describe('Chat attachments and reported conversations', () => {
  const replacing = (stream: ReturnType<typeof createStream>) =>
    setup(
      {},
      {
        sendMessages: jest.fn(async () => ({
          status: 'replaced' as const,
          generationProtocolVersion: 2,
          conversationId: 'convo-1',
          streamId: 'stream-2',
          generationCreatedAt: 200,
        })),
        reconnectToStream: jest.fn(async () => stream),
      },
    );

  it.each([
    [500, true],
    [401, true],
    [404, false],
    [410, false],
  ])(
    'reports an attachment that fails with HTTP %s as a disconnect: %s',
    async (status, disconnect) => {
      const stream = createStream({ streamId: 'stream-2', generationCreatedAt: 200 });
      const { chat, onFinish } = replacing(stream);
      const sent = chat.sendMessage({ parts: [{ type: 'text', text: 'Hi' }] });
      await flush();
      stream.push({ type: 'error', status, data: 'failed' } as ChatEvent);
      await sent;

      expect(onFinish).toHaveBeenCalledWith(expect.objectContaining({ isDisconnect: disconnect }));
    },
  );

  it('reports an attachment failure the host reducer threw on as a disconnect', async () => {
    const stream = createStream({ streamId: 'stream-2', generationCreatedAt: 200 });
    const { chat, onFinish } = setup(
      {
        applyEvent: (event) => {
          if (event.type === 'error') {
            throw new Error('reducer failed');
          }
        },
      },
      {
        sendMessages: jest.fn(async () => ({
          status: 'replaced' as const,
          generationProtocolVersion: 2,
          conversationId: 'convo-1',
          streamId: 'stream-2',
          generationCreatedAt: 200,
        })),
        reconnectToStream: jest.fn(async () => stream),
      },
    );
    const sent = chat.sendMessage({ parts: [{ type: 'text', text: 'Hi' }] });
    await flush();
    stream.push({ type: 'error', status: 500, data: 'failed' } as ChatEvent);
    await sent;

    expect(onFinish).toHaveBeenCalledWith(
      expect.objectContaining({ isDisconnect: true, isSettled: false }),
    );
  });

  it('reports a resumed start that fails over HTTP as a disconnect', async () => {
    const stream = Object.assign(createStream({ streamId: 'convo-1', generationCreatedAt: 100 }), {
      resumed: true,
    });
    const { chat, onFinish } = setup(
      {},
      { sendMessages: jest.fn(async () => ({ status: 'stream' as const, stream })) },
    );
    const sent = chat.sendMessage({ parts: [{ type: 'text', text: 'Hi' }] });
    await flush();
    stream.push({ type: 'error', status: 500, data: 'failed' } as ChatEvent);
    await sent;

    expect(onFinish).toHaveBeenCalledWith(expect.objectContaining({ isDisconnect: true }));
  });

  it('drops the optimistic rows of a start the server replaced before attaching', async () => {
    const earlier: TMessage = { ...placeholder, messageId: 'earlier-1', text: 'Earlier' };
    const stream = createStream({ streamId: 'stream-2', generationCreatedAt: 200 });
    let attachedWith: string[] = [];
    const { chat } = setup(
      {
        state: createState([earlier]),
        prepareRequest: jest.fn(() => ({
          payload,
          messages: (current: TMessage[]) => [...current, userMessage, placeholder],
        })),
      },
      {
        sendMessages: jest.fn(async () => ({
          status: 'replaced' as const,
          generationProtocolVersion: 2,
          conversationId: 'convo-1',
          streamId: 'stream-2',
          generationCreatedAt: 200,
        })),
        reconnectToStream: jest.fn(async () => {
          attachedWith = chat.messages.map((message) => message.messageId);
          return stream;
        }),
      },
    );
    const sent = chat.sendMessage({ parts: [{ type: 'text', text: 'Hi' }] });
    await flush();
    stream.push(finalEvent({ requestMessage: null, responseMessage: null }));
    await sent;

    expect(attachedWith).toEqual(['earlier-1']);
  });

  it.each([
    [
      'restores a row it overwrote',
      (current: TMessage[]) =>
        current.map((m) => (m.messageId === 'earlier-2' ? { ...m, text: '' } : m)),
      undefined,
      ['earlier-1:Earlier', 'earlier-2:Answer'],
    ],
    [
      'restores a row it removed in place',
      (current: TMessage[]) => current.filter((m) => m.messageId !== 'earlier-1'),
      undefined,
      ['earlier-1:Earlier', 'earlier-2:Answer'],
    ],
    [
      'restores a row it removed after the row before it, past a later prepend',
      (current: TMessage[]) => current.filter((m) => m.messageId !== 'earlier-2'),
      (current: TMessage[]) => [{ ...placeholder, messageId: 'x', text: 'X' }, ...current],
      ['x:X', 'earlier-1:Earlier', 'earlier-2:Answer'],
    ],
    [
      'keeps a later write to a row it overwrote',
      (current: TMessage[]) =>
        current.map((m) => (m.messageId === 'earlier-2' ? { ...m, text: '' } : m)),
      (current: TMessage[]) =>
        current.map((m) => (m.messageId === 'earlier-2' ? { ...m, text: 'External' } : m)),
      ['earlier-1:Earlier', 'earlier-2:External'],
    ],
  ])(
    'undoes the optimistic write of a replaced start: %s',
    async (_label, optimistic, external, expected) => {
      const earlier: TMessage[] = [
        { ...placeholder, messageId: 'earlier-1', text: 'Earlier' },
        { ...placeholder, messageId: 'earlier-2', text: 'Answer' },
      ];
      const stream = createStream({ streamId: 'stream-2', generationCreatedAt: 200 });
      const state = createState(earlier);
      let attachedWith: string[] = [];
      let answer: (() => void) | undefined;
      const { chat } = setup(
        {
          state,
          prepareRequest: jest.fn(() => ({ payload, messages: optimistic })),
        },
        {
          sendMessages: jest.fn(
            () =>
              new Promise((resolve) => {
                answer = () =>
                  resolve({
                    status: 'replaced' as const,
                    generationProtocolVersion: 2,
                    conversationId: 'convo-1',
                    streamId: 'stream-2',
                    generationCreatedAt: 200,
                  });
              }),
          ),
          reconnectToStream: jest.fn(async () => {
            attachedWith = chat.messages.map((m) => `${m.messageId}:${m.text}`);
            return stream;
          }),
        },
      );
      const sent = chat.sendMessage({ parts: [{ type: 'text', text: 'Hi' }] });
      await flush();
      if (external) {
        state.replaceMessages(external(state.messages));
      }
      answer?.();
      await flush();
      stream.push(finalEvent({ requestMessage: null, responseMessage: null }));
      await sent;

      expect(attachedWith).toEqual(expected);
    },
  );

  it.each([
    ['over a plain state', false],
    ['over a store that reports its own writes', true],
  ])(
    'keeps a row a listener appended on the optimistic write when a replaced start rolls back, %s',
    async (_label, viaStore) => {
      const earlier: TMessage = { ...placeholder, messageId: 'earlier-1', text: 'Earlier' };
      const external: TMessage = { ...placeholder, messageId: 'external-1', text: 'External' };
      const stream = createStream({ streamId: 'stream-2', generationCreatedAt: 200 });
      const state = createState([earlier]);
      const storeListeners = new Set<() => void>();
      if (viaStore) {
        const replaceMessages = state.replaceMessages.bind(state);
        state.replaceMessages = (messages: TMessage[]) => {
          replaceMessages(messages);
          storeListeners.forEach((listener) => listener());
        };
        state.subscribe = (listener: () => void) => {
          storeListeners.add(listener);
          return () => storeListeners.delete(listener);
        };
      }
      let attachedWith: string[] = [];
      const { chat } = setup(
        {
          state,
          prepareRequest: jest.fn(() => ({
            payload,
            messages: (current: TMessage[]) => [...current, userMessage, placeholder],
          })),
        },
        {
          sendMessages: jest.fn(async () => ({
            status: 'replaced' as const,
            generationProtocolVersion: 2,
            conversationId: 'convo-1',
            streamId: 'stream-2',
            generationCreatedAt: 200,
          })),
          reconnectToStream: jest.fn(async () => {
            attachedWith = chat.messages.map((m) => m.messageId);
            return stream;
          }),
        },
      );
      const append = () => {
        const current = state.messages;
        if (
          current.some((m) => m.messageId === placeholder.messageId) &&
          !current.includes(external)
        ) {
          state.replaceMessages([...current, external]);
        }
      };
      chat.subscribe(append);
      const sent = chat.sendMessage({ parts: [{ type: 'text', text: 'Hi' }] });
      await flush();
      stream.push(finalEvent({ requestMessage: null, responseMessage: null }));
      await sent;

      expect(attachedWith).toEqual(['earlier-1', 'external-1']);
    },
  );

  describe('optimistic rollback at the store boundary', () => {
    const earlier: TMessage[] = [
      { ...placeholder, messageId: 'earlier-1', text: 'Earlier' },
      { ...placeholder, messageId: 'earlier-2', text: 'Answer' },
    ];
    const external: TMessage = { ...placeholder, messageId: 'external-1', text: 'External' };
    /** Overwrites `earlier-2` and appends the turn, so the write both replaces and adds rows. */
    const optimistic = (current: TMessage[]) => [
      ...current.map((m) => (m.messageId === 'earlier-2' ? { ...m, text: '' } : m)),
      userMessage,
      placeholder,
    ];
    const replaced = {
      status: 'replaced' as const,
      generationProtocolVersion: 2,
      conversationId: 'convo-1',
      streamId: 'stream-2',
      generationCreatedAt: 200,
    };

    /**
     * A store that tells its own subscribers of every write before `replaceMessages` returns and,
     * when `shared`, commits each changed row as a copy, as a cache with structural sharing does.
     */
    const createStore = (shared: boolean) => {
      const state = createState(earlier);
      const listeners = new Set<() => void>();
      const replace = state.replaceMessages.bind(state);
      state.replaceMessages = (next: TMessage[]) => {
        const held = new Map(state.messages.map((m) => [m.messageId, m]));
        replace(shared ? next.map((m) => (held.get(m.messageId) === m ? m : { ...m })) : next);
        [...listeners].forEach((listener) => listener());
      };
      state.subscribe = (listener: () => void) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      };
      return state;
    };

    /** A store subscriber that appends `external` once the turn's placeholder is listed. */
    const appendOnWrite = (state: ChatState) => () => {
      const current = state.messages;
      if (
        current.some((m) => m.messageId === placeholder.messageId) &&
        !current.some((m) => m.messageId === external.messageId)
      ) {
        state.replaceMessages([...current, external]);
      }
    };

    const rows = (messages: TMessage[]) => messages.map((m) => `${m.messageId}:${m.text}`);

    it.each([
      ['over a store that reports writes synchronously', false],
      ['over a structurally shared store', true],
    ])(
      'keeps a row a store subscriber appended inside the write when a replaced start rolls back, %s',
      async (_label, shared) => {
        const state = createStore(shared);
        state.subscribe?.(appendOnWrite(state));
        const stream = createStream({ streamId: 'stream-2', generationCreatedAt: 200 });
        let attachedWith: string[] = [];
        const { chat } = setup(
          { state, prepareRequest: jest.fn(() => ({ payload, messages: optimistic })) },
          {
            sendMessages: jest.fn(async () => replaced),
            reconnectToStream: jest.fn(async () => {
              attachedWith = rows(chat.messages);
              return stream;
            }),
          },
        );
        const sent = chat.sendMessage({ parts: [{ type: 'text', text: 'Hi' }] });
        await flush();
        stream.push(finalEvent({ requestMessage: null, responseMessage: null }));
        await sent;

        expect(attachedWith).toEqual([
          'earlier-1:Earlier',
          'earlier-2:Answer',
          'external-1:External',
        ]);
      },
    );

    it.each([
      ['over a store that reports writes synchronously', false],
      ['over a structurally shared store', true],
    ])(
      'undoes the write of a turn a store subscriber disposed inside that write, %s',
      async (_label, shared) => {
        const state = createStore(shared);
        const append = appendOnWrite(state);
        const { chat, transport } = setup({
          state,
          prepareRequest: jest.fn(() => ({ payload, messages: optimistic })),
        });
        state.subscribe?.(() => {
          if (state.messages.some((m) => m.messageId === placeholder.messageId)) {
            append();
            chat.dispose();
          }
        });

        await chat.sendMessage({ parts: [{ type: 'text', text: 'Hi' }] });

        expect(transport.sendMessages).not.toHaveBeenCalled();
        expect(rows(state.messages)).toEqual([
          'earlier-1:Earlier',
          'earlier-2:Answer',
          'external-1:External',
        ]);
        expect(chat.status).toBe('ready');
      },
    );

    it.each([
      ['over a store that reports writes synchronously', false],
      ['over a structurally shared store', true],
    ])(
      'keeps the edits a store subscriber made to the turn rows inside the write when a replaced start rolls back, %s',
      async (_label, shared) => {
        const state = createStore(shared);
        state.subscribe?.(() => {
          const current = state.messages;
          if (current.some((m) => m.messageId === placeholder.messageId && m.text === '')) {
            state.replaceMessages(
              current.map((m) =>
                m.messageId === placeholder.messageId || m.messageId === 'earlier-2'
                  ? { ...m, text: 'Edited' }
                  : m,
              ),
            );
          }
        });
        const stream = createStream({ streamId: 'stream-2', generationCreatedAt: 200 });
        let attachedWith: string[] = [];
        const { chat } = setup(
          { state, prepareRequest: jest.fn(() => ({ payload, messages: optimistic })) },
          {
            sendMessages: jest.fn(async () => replaced),
            reconnectToStream: jest.fn(async () => {
              attachedWith = rows(chat.messages);
              return stream;
            }),
          },
        );
        const sent = chat.sendMessage({ parts: [{ type: 'text', text: 'Hi' }] });
        await flush();
        stream.push(finalEvent({ requestMessage: null, responseMessage: null }));
        await sent;

        expect(attachedWith).toEqual([
          'earlier-1:Earlier',
          'earlier-2:Edited',
          'response-1:Edited',
        ]);
      },
    );

    it('keeps a later write to a row the turn added when a structurally shared store rolls back', async () => {
      const state = createStore(true);
      const stream = createStream({ streamId: 'stream-2', generationCreatedAt: 200 });
      let attachedWith: string[] = [];
      let answer: (() => void) | undefined;
      const { chat } = setup(
        { state, prepareRequest: jest.fn(() => ({ payload, messages: optimistic })) },
        {
          sendMessages: jest.fn(
            () =>
              new Promise((resolve) => {
                answer = () => resolve(replaced);
              }),
          ),
          reconnectToStream: jest.fn(async () => {
            attachedWith = rows(chat.messages);
            return stream;
          }),
        },
      );
      const sent = chat.sendMessage({ parts: [{ type: 'text', text: 'Hi' }] });
      await flush();
      state.replaceMessages(
        state.messages.map((m) =>
          m.messageId === userMessage.messageId ? { ...m, text: 'Edited' } : m,
        ),
      );
      answer?.();
      await flush();
      stream.push(finalEvent({ requestMessage: null, responseMessage: null }));
      await sent;

      expect(attachedWith).toEqual(['earlier-1:Earlier', 'earlier-2:Answer', 'user-1:Edited']);
    });
  });

  it('reports an error the generation itself sent on an attachment as terminal', async () => {
    const stream = createStream({ streamId: 'stream-2', generationCreatedAt: 200 });
    const { chat, onFinish } = replacing(stream);
    const sent = chat.sendMessage({ parts: [{ type: 'text', text: 'Hi' }] });
    await flush();
    stream.push({ type: 'error', data: 'The run failed' } as ChatEvent);
    await sent;

    expect(onFinish).toHaveBeenCalledWith(expect.objectContaining({ isDisconnect: false }));
  });

  it('reports a stream that fails while it is read as a disconnect', async () => {
    const failing = {
      streamId: 'convo-1',
      generationCreatedAt: 100,
      close: jest.fn(),
      async *[Symbol.asyncIterator]() {
        yield stepEvent;
        throw new Error('The body could not be read');
      },
    };
    const { chat, onFinish } = setup(
      {},
      { sendMessages: jest.fn(async () => ({ status: 'stream' as const, stream: failing })) },
    );

    await chat.sendMessage({ parts: [{ type: 'text', text: 'Hi' }] });

    expect(onFinish).toHaveBeenCalledWith(
      expect.objectContaining({ isError: true, isDisconnect: true }),
    );
  });

  it('reports the conversation a first turn was created under on its finish', async () => {
    const { chat, stream, onFinish } = setup({
      id: 'new',
      prepareRequest: jest.fn(() => ({
        payload: { ...payload, conversationId: null } as unknown as TPayload,
        messages: [userMessage, placeholder],
      })),
    });
    const sent = chat.sendMessage({ parts: [{ type: 'text', text: 'Hi' }] });
    await flush();
    stream.push({
      type: 'created',
      data: { message: { ...userMessage, conversationId: 'convo-9' }, created: true },
    } as ChatEvent);
    stream.push(
      finalEvent({
        requestMessage: { ...userMessage, conversationId: 'convo-9' },
        responseMessage: { ...placeholder, conversationId: 'convo-9', text: 'Hello' },
      }),
    );
    await sent;

    expect(onFinish).toHaveBeenCalledWith(expect.objectContaining({ conversationId: 'convo-9' }));
  });
});
