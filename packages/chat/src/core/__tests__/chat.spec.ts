import { ContentTypes, StepEvents, buildTree } from 'librechat-data-provider';
import type { Agents, TMessage, TPayload, ChatEvent } from 'librechat-data-provider';
import type {
  ChatStream,
  ChatStatus,
  ChatTransport,
  ChatConnection,
  ChatAbortResult,
} from '../types';
import type { ChatState, ChatInit, ChatPreparedRequest } from '../chat';
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

    it('on the reconnecting state still attaches the reattachment', async () => {
      const resumed = createStream({ streamId: 'convo-1', generationCreatedAt: 100 });
      const { chat, transport } = setup();
      transport.reconnectToStream.mockResolvedValueOnce(resumed);
      chat.subscribe(() => {
        if (chat.connection === 'reconnecting') {
          throw new Error('listener failed');
        }
      });

      const attached = chat.resumeStream({ streamId: 'convo-1' });
      await flush();

      expect(chat.connection).toBe('live');
      resumed.push(finalEvent());
      await attached;
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
      const earlier: TMessage = {
        ...placeholder,
        messageId: 'earlier-1',
        parentMessageId: null,
        text: 'Earlier',
      };
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

    it('releases a stop still waiting for the server, and the turn it stops', async () => {
      const { chat, transport } = setup({ resumeSelection: () => ({ endpoint: 'agents' }) });
      transport.abort.mockImplementationOnce(() => new Promise<never>(() => undefined));
      const sent = chat.sendMessage({ parts: [{ type: 'text', text: 'Hi' }] });
      await flush();
      const stopped = chat.stop();
      await flush();

      chat.dispose();

      await expect(stopped).rejects.toThrow('The chat was disposed');
      await expect(sent).resolves.toBeUndefined();
      expect(chat.connection).toBe('idle');
    });
  });

  it('releases an answer still waiting on its resume when the chat is disposed', async () => {
    const { chat, stream, transport } = setup({
      resumeSelection: () => ({ endpoint: 'agents' }),
    });
    transport.resume.mockImplementationOnce(() => new Promise<never>(() => undefined));
    const sent = chat.sendMessage({ parts: [{ type: 'text', text: 'Hi' }] });
    await flush();
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
    const answered = chat.addToolOutput({ toolCallId: 'a', output: 'Yes' });
    await flush();

    chat.dispose();

    await expect(answered).rejects.toThrow('The chat was disposed');
    await sent;
  });

  describe('a replayed stale pause', () => {
    const pause = {
      actionId: 'action-1',
      streamId: 'convo-1',
      conversationId: 'convo-1',
      createdAt: 1,
      expiresAt: Date.now() + 60_000,
      payload: { type: 'ask_user_question', question: { question: 'Which?' }, tool_call_id: 'a' },
    } as Agents.PendingAction;

    it('stays out of the host reducer when it expired', async () => {
      const applyEvent = jest.fn();
      const { chat, transport } = setup({
        applyEvent,
        resumeSelection: () => ({ endpoint: 'agents' }),
      });
      const replay = createStream({ streamId: 'convo-1', generationCreatedAt: 100 });
      transport.reconnectToStream.mockResolvedValueOnce(replay);
      const attached = chat.resumeStream({ streamId: 'convo-1', generationCreatedAt: 100 });
      await flush();

      replay.push({ type: 'pending_action', data: { ...pause, expiresAt: Date.now() - 1_000 } });
      await flush();

      expect(applyEvent).not.toHaveBeenCalledWith(
        expect.objectContaining({ type: 'pending_action' }),
        expect.anything(),
      );
      replay.push(finalEvent());
      await attached;
    });

    it('stays out of the host reducer when this chat already resumed it', async () => {
      const applyEvent = jest.fn();
      const { chat, transport } = setup({
        applyEvent,
        resumeSelection: () => ({ endpoint: 'agents' }),
      });
      const continuation = createStream({ streamId: 'convo-1', generationCreatedAt: 100 });
      transport.reconnectToStream.mockResolvedValueOnce(continuation);
      chat.restorePendingAction(pause, 100);
      await chat.addToolOutput({ toolCallId: 'a', output: 'Yes' });
      await flush();

      continuation.push({ type: 'pending_action', data: pause });
      await flush();

      expect(applyEvent).not.toHaveBeenCalledWith(
        expect.objectContaining({ type: 'pending_action' }),
        expect.anything(),
      );
      continuation.push(finalEvent());
      await flush();
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

  it('clears a dropped connection error once a reconnect finishes the turn', async () => {
    const stream = createStream({ streamId: 'convo-1' });
    const { chat, state } = setup({}, { reconnectToStream: jest.fn(async () => stream) });
    state.error = new Error('dropped');
    state.status = 'error';

    const resumed = chat.resumeStream({ streamId: 'convo-1' });
    await flush();
    stream.push(finalEvent());
    await resumed;

    expect(chat.status).toBe('ready');
    expect(chat.error).toBeUndefined();
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

  it('cancels a start that has not attached yet', async () => {
    let signal: AbortSignal | undefined;
    const { chat, transport, onFinish } = setup(
      {},
      {
        sendMessages: jest.fn(
          (request) =>
            new Promise((_, reject) => {
              signal = request.abortSignal;
              request.abortSignal?.addEventListener('abort', () => reject(new Error('aborted')));
            }),
        ),
      },
    );

    const sent = chat.sendMessage({ parts: [{ type: 'text', text: 'Hi' }] });
    await flush();
    await chat.stop();
    await sent;

    expect(signal?.aborted).toBe(true);
    expect(transport.abort).not.toHaveBeenCalled();
    /** The start reached the transport, so the server may run it: its end is unknown. */
    expect(chat.status).toBe('error');
    expect(onFinish).toHaveBeenCalledWith(
      expect.objectContaining({ isAbort: false, isDisconnect: true }),
    );
  });

  it.each(['stop', 'dispose'] as const)(
    'closes a stream that arrives after %s without applying it',
    async (cancel) => {
      let open: (() => void) | undefined;
      const { chat, stream, state, onError, transport } = setup(
        {},
        {
          sendMessages: jest.fn(
            () =>
              new Promise((resolve) => {
                open = () => resolve({ status: 'stream', stream });
              }),
          ),
        },
      );

      const sent = chat.sendMessage({ parts: [{ type: 'text', text: 'Hi' }] });
      await flush();
      const cancelled = cancel === 'stop' ? chat.stop() : chat.dispose();
      stream.push(finalEvent());
      open?.();
      await sent;
      await cancelled;

      expect(stream.closed()).toBe(true);
      expect(state.messages[1].text).toBe('');
      /** A stop reports the cancelled start as a disconnect; a disposal reports nothing. */
      expect(onError).toHaveBeenCalledTimes(cancel === 'stop' ? 1 : 0);
      expect(transport.abort).toHaveBeenCalledTimes(cancel === 'stop' ? 1 : 0);
    },
  );

  it.each(['sendMessages', 'reconnectToStream'] as const)(
    'stops while %s ignores the abort signal, closing the stream it opens later',
    async (opener) => {
      let open: (() => void) | undefined;
      const stream = createStream({ streamId: 'convo-1' });
      const pending = jest.fn(
        () =>
          new Promise((resolve) => {
            open = () => resolve(opener === 'sendMessages' ? { status: 'stream', stream } : stream);
          }),
      );
      const { chat, onFinish, transport } = setup(
        { resumeSelection: () => ({ endpoint: 'agents' }) },
        { [opener]: pending },
      );

      const started =
        opener === 'sendMessages'
          ? chat.sendMessage({ parts: [{ type: 'text', text: 'Hi' }] })
          : chat.resumeStream({ streamId: 'convo-1' });
      await flush();
      await chat.stop();
      await started;
      /** A cancelled start may still run on the server; a reattachment had nothing to start. */
      expect(chat.status).toBe(opener === 'sendMessages' ? 'error' : 'ready');
      open?.();
      await flush();

      expect(stream.closed()).toBe(true);
      expect(transport.abort).toHaveBeenCalledTimes(1);
      expect(transport.abort).toHaveBeenCalledWith(
        expect.objectContaining({ endpoint: 'agents', streamId: 'convo-1' }),
      );
      expect(onFinish).toHaveBeenCalledTimes(1);
      expect(onFinish).toHaveBeenCalledWith(
        expect.objectContaining(
          opener === 'sendMessages' ? { isDisconnect: true } : { isAbort: true },
        ),
      );
    },
  );

  it('does not start a turn stopped while its optimistic messages were written', async () => {
    const { chat, transport, onFinish } = setup();
    const unsubscribe = chat.subscribe(() => {
      if (chat.messages.length > 0) {
        void chat.stop();
      }
    });

    await chat.sendMessage({ parts: [{ type: 'text', text: 'Hi' }] });
    unsubscribe();

    expect(transport.sendMessages).not.toHaveBeenCalled();
    expect(onFinish).toHaveBeenCalledWith(expect.objectContaining({ isAbort: true }));
  });

  it('does not write the optimistic messages of a turn stopped once its request was prepared', async () => {
    let prepared: (() => void) | undefined;
    const { chat, state, transport } = setup({
      prepareRequest: jest.fn(
        () =>
          new Promise((resolve) => {
            prepared = () => resolve({ payload, messages: [userMessage, placeholder] });
          }),
      ),
    });

    const sent = chat.sendMessage({ parts: [{ type: 'text', text: 'Hi' }] });
    await flush();
    prepared?.();
    await Promise.resolve();
    const stopped = chat.stop();
    await sent;
    await stopped;

    expect(state.messages).toEqual([]);
    expect(transport.sendMessages).not.toHaveBeenCalled();
  });

  it('does not prepare a turn stopped as soon as it was submitted', async () => {
    const prepareRequest = jest.fn(() => ({ payload, messages: [userMessage, placeholder] }));
    const { chat, onFinish } = setup({ prepareRequest });
    const unsubscribe = chat.subscribe(() => {
      if (chat.status === 'submitted') {
        void chat.stop();
      }
    });

    await chat.sendMessage({ parts: [{ type: 'text', text: 'Hi' }] });
    unsubscribe();

    expect(prepareRequest).not.toHaveBeenCalled();
    expect(onFinish).toHaveBeenCalledWith(expect.objectContaining({ isAbort: true }));
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

  it('finishes a turn stopped during its optimistic write with its own response', async () => {
    const otherBranch: TMessage = { ...placeholder, messageId: 'other-1', parentMessageId: 'x' };
    const { chat, onFinish } = setup({
      prepareRequest: jest.fn(() => ({
        payload,
        messages: [userMessage, placeholder, otherBranch],
        responseMessageId: 'response-1',
      })),
    });
    const unsubscribe = chat.subscribe(() => {
      if (chat.messages.length > 0) {
        void chat.stop();
      }
    });

    await chat.sendMessage({ parts: [{ type: 'text', text: 'Hi' }] });
    unsubscribe();

    expect(onFinish).toHaveBeenCalledWith(
      expect.objectContaining({
        isAbort: true,
        message: expect.objectContaining({ messageId: 'response-1' }),
      }),
    );
  });

  it('cancels a start whose request is still being prepared, without writing it', async () => {
    let prepare: (value: { payload: TPayload; messages: TMessage[] }) => void = () => {};
    const { chat, transport, state, onFinish } = setup({
      prepareRequest: () =>
        new Promise((resolve) => {
          prepare = resolve;
        }),
    });

    const sent = chat.sendMessage({ parts: [{ type: 'text', text: 'Hi' }] });
    await flush();
    await chat.stop();
    await sent;
    prepare({ payload, messages: [userMessage, placeholder] });
    await flush();

    expect(chat.status).toBe('ready');
    expect(state.messages).toEqual([]);
    expect(transport.sendMessages).not.toHaveBeenCalled();
    expect(onFinish).toHaveBeenCalledWith(expect.objectContaining({ isAbort: true }));
  });

  it('stops an attached stream on the server and resolves once it ended', async () => {
    const { chat, stream, transport, onFinish } = setup();
    transport.abort.mockImplementation(async () => {
      stream.push(finalEvent({ terminalStatus: 'aborted' }));
      return { success: true };
    });

    const sent = chat.sendMessage({ parts: [{ type: 'text', text: 'Hi' }] });
    await flush();
    stream.push(stepEvent);
    await flush();
    await chat.stop();

    expect(transport.abort).toHaveBeenCalledWith({
      chatId: 'convo-1',
      endpoint: 'agents',
      streamId: 'convo-1',
      generationCreatedAt: 100,
    });
    expect(chat.status).toBe('ready');
    expect(onFinish).toHaveBeenCalledWith(expect.objectContaining({ isAbort: true }));
    await sent;
  });

  it('reports a stopped stream that drops instead of ending as aborted', async () => {
    const { chat, stream, transport, onFinish, onError } = setup();
    transport.abort.mockImplementation(async () => {
      stream.push({ type: 'error', status: 0, data: 'offline' } as ChatEvent);
      return { success: true };
    });
    const sent = chat.sendMessage({ parts: [{ type: 'text', text: 'Hi' }] });
    await flush();
    stream.push(stepEvent);
    await flush();

    await chat.stop();
    await sent;

    expect(chat.status).toBe('ready');
    expect(onError).not.toHaveBeenCalled();
    expect(onFinish).toHaveBeenCalledWith(expect.objectContaining({ isAbort: true }));
  });

  it('asks the host to reload a confirmed stop whose abort frame the dropped stream lost', async () => {
    const { chat, stream, transport, onFinish } = setup();
    transport.abort.mockImplementation(async () => {
      stream.push({ type: 'error', status: 0, data: 'offline' } as ChatEvent);
      return { success: true, aborted: 'convo-1' };
    });
    const sent = chat.sendMessage({ parts: [{ type: 'text', text: 'Hi' }] });
    await flush();
    stream.push(stepEvent);
    await flush();

    await chat.stop();
    await sent;

    expect(onFinish).toHaveBeenLastCalledWith(
      expect.objectContaining({
        isAbort: true,
        isDisconnect: false,
        isSettled: true,
        conversationId: 'convo-1',
      }),
    );
  });

  it('reports a failed stop of a start that arrived after it', async () => {
    let open: (() => void) | undefined;
    const stream = createStream({ streamId: 'convo-1' });
    const { chat, transport, onError } = setup(
      {},
      {
        sendMessages: jest.fn(
          () =>
            new Promise((resolve) => {
              open = () => resolve({ status: 'stream', stream });
            }),
        ),
      },
    );
    transport.abort.mockImplementation(async () => ({ success: false, error: 'busy' }));

    const sent = chat.sendMessage({ parts: [{ type: 'text', text: 'Hi' }] });
    await flush();
    await chat.stop();
    await sent;
    open?.();
    await flush();

    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'busy' }));
  });

  it.each([true, false])(
    'holds a stream that drops before the stop is answered until the answer (confirmed: %s)',
    async (confirmed) => {
      const { chat, stream, transport } = setup();
      let answer: (() => void) | undefined;
      transport.abort.mockImplementation(
        () =>
          new Promise((resolve) => {
            answer = () => resolve(confirmed ? { success: true } : { success: false });
          }),
      );
      const sent = chat.sendMessage({ parts: [{ type: 'text', text: 'Hi' }] });
      await flush();
      stream.push(stepEvent);
      await flush();

      const stopped = chat.stop();
      stream.push({ type: 'error', status: 0, data: 'offline' } as ChatEvent);
      await flush();
      expect(chat.status).toBe('streaming');
      answer?.();

      if (confirmed) {
        await stopped;
        await sent;
        expect(chat.status).toBe('ready');
        expect(chat.error).toBeUndefined();
      } else {
        await expect(stopped).rejects.toThrow('refused');
        await sent;
        expect(chat.status).toBe('error');
      }
    },
  );

  it('holds a dropped turn, and refuses the next one, until its stop is answered', async () => {
    const { chat, stream, transport } = setup();
    let answer: (() => void) | undefined;
    transport.abort.mockImplementation(
      () =>
        new Promise((resolve) => {
          answer = () => resolve({ success: true });
        }),
    );
    const sent = chat.sendMessage({ parts: [{ type: 'text', text: 'Hi' }] });
    await flush();
    const stopped = chat.stop();
    stream.push({ type: 'error', status: 0, data: 'offline' } as ChatEvent);
    await flush();

    await expect(chat.sendMessage({ parts: [{ type: 'text', text: 'Again' }] })).rejects.toThrow(
      'in flight',
    );
    answer?.();
    await stopped;
    await sent;

    expect(chat.status).toBe('ready');
  });

  it('rejects a refused stop and keeps streaming', async () => {
    const failure = new Error('abort failed');
    const { chat, stream, transport } = setup();
    transport.abort.mockRejectedValueOnce(failure);

    const sent = chat.sendMessage({ parts: [{ type: 'text', text: 'Hi' }] });
    await flush();
    stream.push(stepEvent);
    await flush();

    await expect(chat.stop()).rejects.toBe(failure);
    expect(chat.status).toBe('streaming');
    stream.push(finalEvent());
    await sent;
    expect(chat.status).toBe('ready');
  });

  it('rejects a stop the server answered without stopping, and keeps streaming', async () => {
    const { chat, stream, transport } = setup();
    transport.abort.mockResolvedValueOnce({ success: false, error: 'Not the running generation' });

    const sent = chat.sendMessage({ parts: [{ type: 'text', text: 'Hi' }] });
    await flush();
    stream.push(stepEvent);
    await flush();

    await expect(chat.stop()).rejects.toThrow('Not the running generation');
    expect(chat.status).toBe('streaming');
    stream.push(finalEvent());
    await sent;
  });

  it.each([
    ['live', 'attached'],
    ['reconnecting', 'reattaching'],
  ])('returns a %s connection to idle on dispose', async (connection, phase) => {
    const { chat, transport } = setup({ resumeSelection: () => ({ endpoint: 'agents' }) });
    if (phase === 'attached') {
      void chat.sendMessage({ parts: [{ type: 'text', text: 'Hi' }] });
    } else {
      transport.reconnectToStream.mockImplementationOnce(() => new Promise(() => undefined));
      void chat.resumeStream({ streamId: 'convo-1', generationCreatedAt: 300 });
    }
    await flush();
    expect(chat.connection).toBe(connection);

    chat.dispose();

    expect(chat.connection).toBe('idle');
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

  it('resumes a pause of a replacing generation with the timestamp the start reported', async () => {
    const stream = createStream({ streamId: 'stream-2' });
    const { chat, transport } = setup(
      { resumeSelection: () => ({ endpoint: 'agents' }) },
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
    stream.push({
      type: 'pending_action',
      data: {
        actionId: 'action-3',
        streamId: 'stream-2',
        conversationId: 'convo-1',
        createdAt: 1,
        payload: { type: 'ask_user_question', question: { question: 'Which?' } },
      } as Agents.PendingAction,
    });
    await flush();

    await chat.addToolOutput({ toolCallId: 'action-3', output: 'Blue' });
    expect(transport.resume).toHaveBeenCalledWith(
      expect.objectContaining({ generationCreatedAt: 200, actionId: 'action-3' }),
    );
    stream.push(finalEvent());
    await sent;
  });

  it('stops a replacing generation on the server while it is still attaching', async () => {
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
        reconnectToStream: jest.fn(() => new Promise<null>(() => undefined)),
      },
    );

    const sent = chat.sendMessage({ parts: [{ type: 'text', text: 'Hi' }] });
    await flush();
    await chat.stop();
    await sent;

    expect(transport.abort).toHaveBeenCalledWith(
      expect.objectContaining({
        endpoint: 'agents',
        streamId: 'stream-2',
        generationCreatedAt: 200,
      }),
    );
    expect(chat.status).toBe('ready');
  });

  it('settles a replacement that finds nothing by the answer of a stop still in flight', async () => {
    let open: ((stream: ChatStream | null) => void) | undefined;
    let answer: ((result: ChatAbortResult) => void) | undefined;
    const { chat, onFinish } = setup(
      {},
      {
        sendMessages: jest.fn(async () => ({
          status: 'replaced' as const,
          generationProtocolVersion: 2,
          conversationId: 'convo-1',
          streamId: 'stream-2',
          generationCreatedAt: 200,
        })),
        reconnectToStream: jest.fn(
          () =>
            new Promise<ChatStream | null>((resolve) => {
              open = resolve;
            }),
        ),
        abort: jest.fn(
          () =>
            new Promise<ChatAbortResult>((resolve) => {
              answer = resolve;
            }),
        ),
      },
    );

    const sent = chat.sendMessage({ parts: [{ type: 'text', text: 'Hi' }] });
    await flush();
    const stopped = chat.stop();
    await flush();
    open?.(null);
    await flush();
    expect(onFinish).not.toHaveBeenCalled();

    answer?.({
      success: true,
      generationProtocolVersion: 2,
      aborted: 'convo-1',
      persistenceFailed: true,
    });
    await stopped;
    await sent;
    expect(onFinish).toHaveBeenCalledTimes(1);
    expect(onFinish).toHaveBeenCalledWith(
      expect.objectContaining({
        isAbort: true,
        isSettled: true,
        reconcileReason: 'abort_persistence_failed',
      }),
    );
  });

  it('does not carry a finished generation timestamp into a fresh reattachment', async () => {
    const resumed = createStream({ streamId: 'convo-1' });
    const { chat, stream, transport } = setup(
      { resumeSelection: () => ({ endpoint: 'agents' }) },
      { reconnectToStream: jest.fn(async () => resumed) },
    );
    const sent = chat.sendMessage({ parts: [{ type: 'text', text: 'Hi' }] });
    await flush();
    stream.push(finalEvent());
    await sent;

    const attached = chat.resumeStream({ streamId: 'convo-1' });
    await flush();
    resumed.push(stepEvent);
    await flush();
    transport.abort.mockImplementation(async () => {
      resumed.push(finalEvent({ terminalStatus: 'aborted' }));
      return { success: true };
    });
    await chat.stop();
    await attached;

    expect(transport.abort).toHaveBeenCalledWith(
      expect.objectContaining({ streamId: 'convo-1', generationCreatedAt: undefined }),
    );
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

  it('keeps the next turn submitted when a store that reports its status writes starts it as the connection goes idle', async () => {
    const state = createState([]);
    const listeners = new Set<() => void>();
    let connection: ChatConnection = 'idle';
    Object.defineProperty(state, 'connection', {
      get: () => connection,
      set: (next: ChatConnection) => {
        connection = next;
        [...listeners].forEach((listener) => listener());
      },
    });
    state.subscribe = (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    };
    let next: Promise<void> | undefined;
    const { chat, stream } = setup({ state });
    const sent = chat.sendMessage({ parts: [{ type: 'text', text: 'Hi' }] });
    await flush();
    let started = false;
    chat.subscribe(() => {
      if (chat.connection === 'idle' && !started) {
        started = true;
        next = chat.sendMessage({ parts: [{ type: 'text', text: 'Again' }] });
      }
    });
    stream.push(finalEvent());
    await sent;

    expect(next).toBeDefined();
    expect(chat.status).toBe('submitted');
    expect(chat.error).toBeUndefined();
  });

  it.each(['final', 'error'] as const)(
    'keeps the next turn a store subscriber starts as the connection goes idle, after a %s',
    async (end) => {
      const state = createState([]);
      const listeners = new Set<() => void>();
      let connection: ChatConnection = 'idle';
      Object.defineProperty(state, 'connection', {
        get: () => connection,
        set: (next: ChatConnection) => {
          connection = next;
          [...listeners].forEach((listener) => listener());
        },
      });
      state.subscribe = (listener: () => void) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      };
      const { chat, stream } = setup({ state });
      const sent = chat.sendMessage({ parts: [{ type: 'text', text: 'Hi' }] });
      await flush();
      let next: Promise<void> | undefined;
      let started = false;
      listeners.add(() => {
        if (connection === 'idle' && !started) {
          started = true;
          next = chat.sendMessage({ parts: [{ type: 'text', text: 'Again' }] });
        }
      });
      stream.push(
        end === 'final'
          ? finalEvent()
          : ({ type: 'error', data: { message: 'Failed' } } as ChatEvent),
      );
      await sent;

      expect(next).toBeDefined();
      expect(chat.status).toBe('submitted');
      expect(chat.error).toBeUndefined();
    },
  );

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

  it('stops an Assistants run by its abort key and merges the messages the stop returns', async () => {
    const stream = createStream();
    const { chat, transport, onFinish } = setup(
      {
        prepareRequest: jest.fn(() => ({
          payload: { endpoint: 'assistants', conversationId: 'convo-1', text: 'Hi' } as TPayload,
          messages: [userMessage, placeholder],
          responseMessageId: 'response-1',
        })),
      },
      { sendMessages: jest.fn(async () => ({ status: 'stream' as const, stream })) },
    );
    transport.abort.mockResolvedValue({
      final: true,
      conversation: {},
      runMessages: [userMessage, { ...placeholder, text: 'Partial' }],
    });

    const sent = chat.sendMessage({ parts: [{ type: 'text', text: 'Hi' }] });
    await flush();
    await chat.stop();
    await sent;

    expect(transport.abort).toHaveBeenCalledWith(
      expect.objectContaining({ endpoint: 'assistants', abortKey: 'convo-1:response-1' }),
    );
    expect(chat.messages[1].text).toBe('Partial');
    expect(chat.status).toBe('ready');
    expect(onFinish).toHaveBeenCalledWith(expect.objectContaining({ isAbort: true }));
  });

  it.each([
    ['an attached', false],
    ['a dropped', true],
  ])(
    'settles %s Assistants run a stop found already gone for the host to reconcile',
    async (_label, dropped) => {
      const stream = createStream();
      const { chat, transport, onFinish } = setup(
        {
          prepareRequest: jest.fn(() => ({
            payload: { endpoint: 'assistants', conversationId: 'convo-1', text: 'Hi' } as TPayload,
            messages: [userMessage, placeholder],
            responseMessageId: 'response-1',
          })),
        },
        { sendMessages: jest.fn(async () => ({ status: 'stream' as const, stream })) },
      );
      transport.abort.mockResolvedValue(null);

      const sent = chat.sendMessage({ parts: [{ type: 'text', text: 'Hi' }] });
      await flush();
      if (dropped) {
        stream.push({ type: 'error', status: 0, data: 'offline' } as ChatEvent);
        await sent;
      }
      await expect(chat.stop()).resolves.toEqual({ status: 'stopped' });
      await sent;

      expect(transport.abort).toHaveBeenCalledWith(
        expect.objectContaining({ endpoint: 'assistants', abortKey: 'convo-1:response-1' }),
      );
      expect(stream.closed()).toBe(true);
      expect(chat.status).toBe('ready');
      expect(onFinish).toHaveBeenLastCalledWith(
        expect.objectContaining({ isAbort: false, isSettled: true }),
      );
    },
  );

  it('returns the conversation an Assistants stop created for a first turn under `new`', async () => {
    const stream = createStream();
    const { chat, transport } = setup(
      {
        id: 'new',
        prepareRequest: jest.fn(() => ({
          payload: { endpoint: 'assistants', conversationId: 'new', text: 'Hi' } as TPayload,
          messages: [userMessage, placeholder],
          responseMessageId: 'response-1',
        })),
      },
      { sendMessages: jest.fn(async () => ({ status: 'stream' as const, stream })) },
    );
    transport.abort.mockResolvedValue({
      final: true,
      conversation: { conversationId: 'convo-9' },
      runMessages: [userMessage, { ...placeholder, text: 'Partial' }],
    });

    const sent = chat.sendMessage({ parts: [{ type: 'text', text: 'Hi' }] });
    await flush();
    stream.push({
      type: 'sync',
      data: { conversationId: 'convo-9', responseMessage: placeholder },
    } as ChatEvent);
    await flush();
    const result = await chat.stop();
    await sent;

    expect(result).toEqual({ status: 'stopped', conversationId: 'convo-9' });
  });

  it('replaces the list with the run messages a stop returns, dropping rows the run deleted', async () => {
    const stream = createStream();
    const unfinished: TMessage = { ...placeholder, messageId: 'tool-1', text: '' };
    const { chat, transport } = setup(
      {
        prepareRequest: jest.fn(() => ({
          payload: { endpoint: 'assistants', conversationId: 'convo-1', text: 'Hi' } as TPayload,
          messages: [userMessage, placeholder, unfinished],
          responseMessageId: 'response-1',
        })),
      },
      { sendMessages: jest.fn(async () => ({ status: 'stream' as const, stream })) },
    );
    const runMessages = [userMessage, { ...placeholder, text: 'Partial' }];
    transport.abort.mockResolvedValue({ final: true, conversation: {}, runMessages });

    const sent = chat.sendMessage({ parts: [{ type: 'text', text: 'Hi' }] });
    await flush();
    await chat.stop();
    await sent;

    expect(chat.messages).toEqual(runMessages);
  });

  it('stops a late Assistants start by its abort key', async () => {
    let open: (() => void) | undefined;
    const stream = createStream();
    const { chat, transport } = setup(
      {
        prepareRequest: jest.fn(() => ({
          payload: { endpoint: 'assistants', conversationId: 'convo-1', text: 'Hi' } as TPayload,
          messages: [userMessage, placeholder],
          responseMessageId: 'response-1',
        })),
      },
      {
        sendMessages: jest.fn(
          () =>
            new Promise((resolve) => {
              open = () => resolve({ status: 'stream', stream });
            }),
        ),
      },
    );
    const sent = chat.sendMessage({ parts: [{ type: 'text', text: 'Hi' }] });
    await flush();
    await chat.stop();
    await sent;
    open?.();
    await flush();

    expect(transport.abort).toHaveBeenCalledWith(
      expect.objectContaining({ endpoint: 'assistants', abortKey: 'convo-1:response-1' }),
    );
  });

  it('merges the messages a stop returns for an Assistants run whose stream dropped', async () => {
    const stream = createStream();
    const { chat, transport } = setup(
      {
        prepareRequest: jest.fn(() => ({
          payload: { endpoint: 'assistants', conversationId: 'convo-1', text: 'Hi' } as TPayload,
          messages: [userMessage, placeholder],
          responseMessageId: 'response-1',
        })),
      },
      { sendMessages: jest.fn(async () => ({ status: 'stream' as const, stream })) },
    );
    transport.abort.mockResolvedValue({
      final: true,
      conversation: {},
      runMessages: [userMessage, { ...placeholder, text: 'Partial' }],
    });
    const sent = chat.sendMessage({ parts: [{ type: 'text', text: 'Hi' }] });
    await flush();
    stream.push({ type: 'error', status: 0, data: 'offline' } as ChatEvent);
    await sent;

    await chat.stop();

    expect(transport.abort).toHaveBeenCalledWith(
      expect.objectContaining({ abortKey: 'convo-1:response-1' }),
    );
    expect(chat.messages[1].text).toBe('Partial');
    expect(chat.status).toBe('ready');
  });

  it('keeps a newer pause restored while a dropped Assistants run merged its stop', async () => {
    const stream = createStream();
    const { chat, transport } = setup(
      {
        prepareRequest: jest.fn(() => ({
          payload: { endpoint: 'assistants', conversationId: 'convo-1', text: 'Hi' } as TPayload,
          messages: [userMessage, placeholder],
          responseMessageId: 'response-1',
        })),
      },
      { sendMessages: jest.fn(async () => ({ status: 'stream' as const, stream })) },
    );
    transport.abort.mockResolvedValue({
      final: true,
      conversation: {},
      runMessages: [userMessage, { ...placeholder, text: 'Partial' }],
    });
    const sent = chat.sendMessage({ parts: [{ type: 'text', text: 'Hi' }] });
    await flush();
    stream.push({ type: 'error', status: 0, data: 'offline' } as ChatEvent);
    await sent;
    const newer = {
      actionId: 'action-newer',
      streamId: 'convo-1',
      conversationId: 'convo-1',
      createdAt: 2,
      payload: { type: 'ask_user_question', question: { question: 'Which?' }, tool_call_id: 'q' },
    } as Agents.PendingAction;
    let restored = false;
    const unsubscribe = chat.subscribe(() => {
      if (!restored && chat.messages[1]?.text === 'Partial') {
        restored = true;
        chat.restorePendingAction(newer, 900);
      }
    });

    await chat.stop();
    unsubscribe();

    expect(chat.messages[1].text).toBe('Partial');
    expect(chat.pendingAction?.actionId).toBe('action-newer');
  });

  it('keeps the reattachment target of a reconnect that failed on the network', async () => {
    const failure = Object.assign(new Error('Network Error'), { code: 'ERR_NETWORK' });
    const { chat, transport } = setup(
      { resumeSelection: () => ({ endpoint: 'agents' }) },
      { reconnectToStream: jest.fn(async () => Promise.reject(failure)) },
    );
    await chat.resumeStream({ streamId: 'convo-1', generationCreatedAt: 300 });
    expect(chat.status).toBe('error');

    await chat.stop();

    expect(transport.abort).toHaveBeenCalledWith(
      expect.objectContaining({
        endpoint: 'agents',
        streamId: 'convo-1',
        generationCreatedAt: 300,
      }),
    );
  });

  it('keeps a dropped generation stoppable when reattaching to it fails on the server', async () => {
    const { chat, stream, transport, onFinish } = setup({
      resumeSelection: () => ({ endpoint: 'agents' }),
    });
    const sent = chat.sendMessage({ parts: [{ type: 'text', text: 'Hi' }] });
    await flush();
    stream.push({ type: 'error', status: 0, data: 'offline' } as ChatEvent);
    await sent;
    transport.reconnectToStream.mockRejectedValueOnce(new Error('Service Unavailable'));

    await chat.resumeStream();
    expect(onFinish).toHaveBeenLastCalledWith(
      expect.objectContaining({ isError: true, isDisconnect: true }),
    );

    await expect(chat.stop()).resolves.toEqual({ status: 'stopped' });
    expect(transport.abort).toHaveBeenCalledWith(
      expect.objectContaining({
        endpoint: 'agents',
        streamId: 'convo-1',
        generationCreatedAt: 100,
      }),
    );
  });

  it.each([
    ['404', { response: { status: 404, data: null, headers: {} } }],
    ['410', { response: { status: 410, data: null, headers: {} } }],
    ['NO_ACTIVE_RUN', { code: 'NO_ACTIVE_RUN' }],
  ])(
    'settles a reattachment the server answered %s as an error, not a disconnect',
    async (_label, gone) => {
      const { chat, stream, transport, onFinish } = setup({
        resumeSelection: () => ({ endpoint: 'agents' }),
      });
      const sent = chat.sendMessage({ parts: [{ type: 'text', text: 'Hi' }] });
      await flush();
      stream.push({ type: 'error', status: 0, data: 'offline' } as ChatEvent);
      await sent;
      transport.reconnectToStream.mockRejectedValueOnce(Object.assign(new Error('Gone'), gone));

      await chat.resumeStream();

      expect(onFinish).toHaveBeenLastCalledWith(
        expect.objectContaining({ isError: true, isDisconnect: false }),
      );
      await expect(chat.stop()).resolves.toEqual({ status: 'idle' });
      expect(transport.abort).not.toHaveBeenCalled();
    },
  );

  it('does not merge a delayed stop of a dropped run into a newer turn', async () => {
    const first = createStream();
    const second = createStream();
    let answer: (() => void) | undefined;
    const { chat, transport } = setup(
      {
        prepareRequest: jest.fn(() => ({
          payload: { endpoint: 'assistants', conversationId: 'convo-1', text: 'Hi' } as TPayload,
          messages: [userMessage, placeholder],
          responseMessageId: 'response-1',
        })),
      },
      {
        sendMessages: jest
          .fn()
          .mockResolvedValueOnce({ status: 'stream', stream: first })
          .mockResolvedValueOnce({ status: 'stream', stream: second }),
      },
    );
    transport.abort.mockImplementation(
      () =>
        new Promise((resolve) => {
          answer = () =>
            resolve({
              final: true,
              conversation: {},
              runMessages: [{ ...placeholder, text: 'Old' }],
            });
        }),
    );
    const firstTurn = chat.sendMessage({ parts: [{ type: 'text', text: 'Hi' }] });
    await flush();
    first.push({ type: 'error', status: 0, data: 'offline' } as ChatEvent);
    await firstTurn;
    const stopped = chat.stop();
    const secondTurn = chat.continue({ messageId: 'response-1' });
    await flush();
    answer?.();
    await stopped;

    expect(chat.messages[1].text).toBe('');
    second.push(finalEvent());
    await secondTurn;
  });

  it('stops an Assistants run by the ids its sync frame assigned', async () => {
    const stream = createStream();
    const { chat, transport } = setup(
      {
        id: 'new',
        prepareRequest: jest.fn(() => ({
          payload: { endpoint: 'assistants', text: 'Hi' } as TPayload,
          messages: [userMessage, placeholder],
          responseMessageId: 'response-1',
        })),
      },
      { sendMessages: jest.fn(async () => ({ status: 'stream' as const, stream })) },
    );
    transport.abort.mockResolvedValue({ final: true, conversation: {}, runMessages: [] });
    const sent = chat.sendMessage({ parts: [{ type: 'text', text: 'Hi' }] });
    await flush();
    stream.push({
      type: 'sync',
      data: { sync: true, conversationId: 'convo-9', responseMessage: { messageId: 'server-2' } },
    } as ChatEvent);
    await flush();

    await chat.stop();
    await sent;

    expect(transport.abort).toHaveBeenCalledWith(
      expect.objectContaining({ abortKey: 'convo-9:server-2' }),
    );
  });

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

  it('reports reconnecting while a reattachment opens', async () => {
    let attach: ((stream: null) => void) | undefined;
    const { chat } = setup(
      {},
      {
        reconnectToStream: jest.fn(
          () =>
            new Promise<null>((resolve) => {
              attach = resolve;
            }),
        ),
      },
    );

    const resumed = chat.resumeStream({ streamId: 'convo-1' });
    expect(chat.connection).toBe('reconnecting');
    attach?.(null);
    await resumed;
    expect(chat.connection).toBe('idle');
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

  it('reports a run the stop found already finished as settled when its final frame is lost', async () => {
    const { chat, stream, transport, onFinish } = setup();
    transport.abort.mockImplementation(async () => {
      stream.close();
      return { success: false, settled: true, terminalStatus: 'complete' };
    });
    const sent = chat.sendMessage({ parts: [{ type: 'text', text: 'Hi' }] });
    await flush();

    await chat.stop();
    await sent;

    expect(onFinish).toHaveBeenCalledWith(
      expect.objectContaining({ isAbort: false, isSettled: true }),
    );
    expect(chat.status).toBe('ready');
  });

  it('reports a reattachment the stop found already finished as settled', async () => {
    const { chat, transport, onFinish } = setup(
      { resumeSelection: () => ({ endpoint: 'agents' }) },
      { reconnectToStream: jest.fn(() => new Promise<null>(() => undefined)) },
    );
    transport.abort.mockResolvedValue({
      success: false,
      settled: true,
      terminalStatus: 'complete',
    });

    const resumed = chat.resumeStream({ streamId: 'convo-1' });
    await flush();
    await chat.stop();
    await resumed;

    expect(onFinish).toHaveBeenCalledWith(
      expect.objectContaining({ isAbort: false, isSettled: true }),
    );
  });

  it('settles a reattachment the stop cancelled as it opened by the stop answer', async () => {
    let open: ((stream: ChatStream) => void) | undefined;
    let answer: ((result: ChatAbortResult) => void) | undefined;
    const opened = createStream({ streamId: 'convo-1' });
    const { chat, onFinish } = setup(
      { resumeSelection: () => ({ endpoint: 'agents' }) },
      {
        reconnectToStream: jest.fn(
          () =>
            new Promise<ChatStream>((resolve) => {
              open = resolve;
            }),
        ),
        abort: jest.fn(
          () =>
            new Promise<ChatAbortResult>((resolve) => {
              answer = resolve;
            }),
        ),
      },
    );
    const resumed = chat.resumeStream({ streamId: 'convo-1' });
    await flush();
    const stopped = chat.stop();
    await flush();

    /** The answer lands just before the stream opens, so the stop cancels the open. */
    answer?.({ success: false, settled: true, terminalStatus: 'complete' });
    await flush();
    open?.(opened);
    await stopped;
    await resumed;

    expect(opened.closed()).toBe(true);
    expect(onFinish).toHaveBeenCalledTimes(1);
    expect(onFinish).toHaveBeenCalledWith(
      expect.objectContaining({ isAbort: false, isSettled: true }),
    );
  });

  it('accepts a stop the run had already settled', async () => {
    const { chat, stream, transport } = setup();
    transport.abort.mockImplementation(async () => {
      stream.push(finalEvent());
      return { success: false, settled: true, terminalStatus: 'complete' };
    });
    const sent = chat.sendMessage({ parts: [{ type: 'text', text: 'Hi' }] });
    await flush();

    await expect(chat.stop()).resolves.toEqual({ status: 'stopped' });
    await sent;
    expect(chat.status).toBe('ready');
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

  it('leaves a replacing generation running when the start it replaced was stopped', async () => {
    let open: (() => void) | undefined;
    const { chat, transport } = setup(
      {},
      {
        sendMessages: jest.fn(
          () =>
            new Promise((resolve) => {
              open = () =>
                resolve({
                  status: 'replaced',
                  generationProtocolVersion: 2,
                  conversationId: 'convo-1',
                  streamId: 'stream-2',
                  generationCreatedAt: 200,
                });
            }),
        ),
      },
    );
    const sent = chat.sendMessage({ parts: [{ type: 'text', text: 'Hi' }] });
    await flush();
    await chat.stop();
    await sent;
    open?.();
    await flush();

    expect(transport.abort).not.toHaveBeenCalled();
  });

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

  it('stops a generation whose stream dropped, which the server kept running', async () => {
    const { chat, stream, transport } = setup();
    const sent = chat.sendMessage({ parts: [{ type: 'text', text: 'Hi' }] });
    await flush();
    stream.push(stepEvent);
    stream.push({ type: 'error', status: 0, data: 'offline' } as ChatEvent);
    await sent;
    expect(chat.status).toBe('error');

    await chat.stop();

    expect(transport.abort).toHaveBeenCalledWith(
      expect.objectContaining({
        endpoint: 'agents',
        streamId: 'convo-1',
        generationCreatedAt: 100,
      }),
    );
    expect(chat.status).toBe('ready');
    expect(chat.error).toBeUndefined();
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

  it('resumes without flashing submitted, and stays ready when nothing is running', async () => {
    const idle = setup();
    await idle.chat.resumeStream();
    expect(idle.state.statuses).toEqual([]);

    const stream = createStream({ generationCreatedAt: 300 });
    const running = setup({}, { reconnectToStream: jest.fn(async () => stream) });
    const resumed = running.chat.resumeStream({ streamId: 'convo-1' });
    await flush();
    stream.push(stepEvent);
    stream.push(finalEvent());
    await resumed;

    expect(running.transport.reconnectToStream).toHaveBeenCalledWith(
      expect.objectContaining({ chatId: 'convo-1', streamId: 'convo-1', resume: true }),
    );
    expect(running.state.statuses).toEqual(['streaming', 'ready']);
  });

  it('stops a resumed stream on the server, at the endpoint the host selects', async () => {
    const stream = createStream({ streamId: 'convo-1', generationCreatedAt: 300 });
    const { chat, transport } = setup(
      { resumeSelection: () => ({ endpoint: 'agents' }) },
      { reconnectToStream: jest.fn(async () => stream) },
    );
    transport.abort.mockImplementation(async () => {
      stream.push(finalEvent({ terminalStatus: 'aborted' }));
      return { success: true };
    });

    const resumed = chat.resumeStream({ streamId: 'convo-1' });
    await flush();
    stream.push(stepEvent);
    await flush();
    await chat.stop();
    await resumed;

    expect(transport.abort).toHaveBeenCalledWith(
      expect.objectContaining({
        endpoint: 'agents',
        streamId: 'convo-1',
        generationCreatedAt: 300,
      }),
    );
    expect(chat.status).toBe('ready');
  });

  it('refuses to stop a resumed stream whose endpoint the host does not select', async () => {
    const stream = createStream({ streamId: 'convo-1' });
    const { chat, transport, onError } = setup(
      {},
      { reconnectToStream: jest.fn(async () => stream) },
    );

    const resumed = chat.resumeStream({ streamId: 'convo-1' });
    await flush();
    stream.push(stepEvent);
    await flush();

    await expect(chat.stop()).rejects.toThrow('without its endpoint');
    expect(transport.abort).not.toHaveBeenCalled();
    expect(stream.closed()).toBe(false);
    expect(chat.status).toBe('streaming');
    stream.push(finalEvent());
    await resumed;
    expect(onError).not.toHaveBeenCalled();
  });

  describe('paused generations', () => {
    const toolCall = (id: string) => ({
      type: ContentTypes.TOOL_CALL,
      tool_call: {
        id,
        name: 'search',
        args: '{}',
        type: 'tool_call',
        approval: { actionId: 'action-1', allowed_decisions: ['approve', 'reject'] },
      },
    });

    const approvalAction = {
      actionId: 'action-1',
      streamId: 'convo-1',
      conversationId: 'convo-1',
      createdAt: 1,
      payload: {
        type: 'tool_approval',
        action_requests: [
          { name: 'search', arguments: '{}', tool_call_id: 'call-1' },
          { name: 'search', arguments: '{}', tool_call_id: 'call-2' },
        ],
        review_configs: [],
      },
    } as Agents.PendingAction;

    const askAction = {
      actionId: 'action-2',
      streamId: 'convo-1',
      conversationId: 'convo-1',
      createdAt: 1,
      payload: {
        type: 'ask_user_question',
        question: { question: 'Which?' },
        tool_call_id: 'ask-1',
      },
    } as Agents.PendingAction;

    const pause = async (action: Agents.PendingAction, overrides: Partial<ChatInit> = {}) => {
      const paused = setup({
        resumeSelection: () => ({ endpoint: 'agents', agent_id: 'agent-1' }),
        prepareRequest: () => ({
          payload,
          messages: [
            userMessage,
            { ...placeholder, content: [toolCall('call-1'), toolCall('call-2')] } as TMessage,
          ],
        }),
        ...overrides,
      });
      const sent = paused.chat.sendMessage({ parts: [{ type: 'text', text: 'Hi' }] });
      await flush();
      paused.stream.push({ type: 'pending_action', data: action });
      await flush();
      return { ...paused, sent };
    };

    it('shows a decision on a paused call nested inside a subagent', async () => {
      const subagent = {
        type: ContentTypes.TOOL_CALL,
        tool_call: {
          id: 'subagent-1',
          name: 'subagent',
          args: '{}',
          type: 'tool_call',
          subagent_content: [toolCall('call-1')],
        },
      };
      const { chat, stream, sent } = await pause(approvalAction, {
        prepareRequest: () => ({
          payload,
          messages: [
            userMessage,
            { ...placeholder, content: [subagent, toolCall('call-2')] } as TMessage,
          ],
        }),
      });

      await chat.addToolApprovalResponse({ id: 'call-1', approved: true });

      const [outer] = chat.messages[1].content as unknown as Array<{
        tool_call: { subagent_content: Array<{ tool_call: Agents.ToolCall }> };
      }>;
      expect(outer.tool_call.subagent_content[0].tool_call).toMatchObject({
        approval: { decision: 'approve' },
      });
      stream.push(finalEvent());
      await sent;
    });

    it('shows each decision and resumes once the whole batch is decided', async () => {
      const { chat, transport, stream, sent } = await pause(approvalAction);
      expect(chat.pendingAction).toBe(approvalAction);

      await chat.addToolApprovalResponse({ id: 'call-1', approved: true });
      expect(transport.resume).not.toHaveBeenCalled();
      const [first] = chat.messages[1].content as Array<{ tool_call: Agents.ToolCall }>;
      expect(first.tool_call).toMatchObject({ approval: { decision: 'approve' } });

      await chat.addToolApprovalResponse({ id: 'call-2', approved: false, reason: 'No' });
      expect(transport.resume).toHaveBeenCalledWith({
        endpoint: 'agents',
        agent_id: 'agent-1',
        conversationId: 'convo-1',
        generationCreatedAt: 100,
        actionId: 'action-1',
        decisions: [
          { tool_call_id: 'call-1', decision: 'approve' },
          { tool_call_id: 'call-2', decision: 'reject', reason: 'No' },
        ],
      });
      expect(chat.pendingAction).toBeUndefined();

      stream.push(finalEvent());
      await sent;
    });

    it('keeps the decisions of a pause the stream replays after a reconnect', async () => {
      const { chat, transport, stream, sent } = await pause(approvalAction);
      await chat.addToolApprovalResponse({ id: 'call-1', approved: true });
      stream.push({ type: 'pending_action', data: { ...approvalAction } });
      await flush();

      await chat.addToolApprovalResponse({ id: 'call-2', approved: false });

      expect(transport.resume).toHaveBeenCalledWith(
        expect.objectContaining({
          decisions: [
            { tool_call_id: 'call-1', decision: 'approve' },
            { tool_call_id: 'call-2', decision: 'reject' },
          ],
        }),
      );
      stream.push(finalEvent());
      await sent;
    });

    it('does not resume a batch whose pause was replaced while its last decision was shown', async () => {
      const { chat, transport, state } = setup();
      state.replaceMessages([
        userMessage,
        { ...placeholder, content: [toolCall('call-1'), toolCall('call-2')] } as TMessage,
      ]);
      chat.restorePendingAction(approvalAction, 500);
      await chat.addToolApprovalResponse({ id: 'call-1', approved: true });
      const unsubscribe = chat.subscribe(() => {
        if (chat.pendingAction === approvalAction) {
          chat.restorePendingAction(askAction, 500);
        }
      });

      await chat.addToolApprovalResponse({ id: 'call-2', approved: true });
      unsubscribe();

      expect(transport.resume).not.toHaveBeenCalled();
      expect(chat.pendingAction).toBe(askAction);
    });

    it('lets a subscriber start a turn once a reconnect drops a pause that ended elsewhere', async () => {
      const { chat, transport, stream } = setup();
      chat.restorePendingAction(askAction, 500);
      let next: Promise<void> | undefined;
      const unsubscribe = chat.subscribe(() => {
        if (!chat.pendingAction && !next) {
          next = Promise.resolve();
          next = chat.sendMessage({ parts: [{ type: 'text', text: 'Hi' }] });
        }
      });

      await chat.resumeStream({ streamId: 'convo-1' });
      unsubscribe();

      expect(chat.status).toBe('submitted');
      await flush();
      expect(transport.sendMessages).toHaveBeenCalled();
      stream.push(finalEvent());
      await next;
    });

    it('resumes a replayed pause once, with the decisions made before the replay', async () => {
      const { chat, transport, stream, sent } = await pause(approvalAction);
      let accept: (() => void) | undefined;
      transport.resume.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            accept = () =>
              resolve({ streamId: 'convo-1', conversationId: 'convo-1', status: 'resuming' });
          }),
      );
      await chat.addToolApprovalResponse({ id: 'call-1', approved: true });
      const resumed = chat.addToolApprovalResponse({ id: 'call-2', approved: true });
      await flush();
      stream.push({ type: 'pending_action', data: { ...approvalAction } });
      await flush();

      await expect(chat.addToolApprovalResponse({ id: 'call-2', approved: false })).rejects.toThrow(
        'already being resumed',
      );
      accept?.();
      await resumed;
      expect(transport.resume).toHaveBeenCalledTimes(1);
      expect(chat.pendingAction).toBeUndefined();
      stream.push(finalEvent());
      await sent;
    });

    it('keeps the decisions of a pause a status check restores again', async () => {
      const { chat, transport } = setup();
      chat.restorePendingAction(approvalAction, 500);
      await chat.addToolApprovalResponse({ id: 'call-1', approved: true });
      chat.restorePendingAction({ ...approvalAction }, 500);

      await chat.addToolApprovalResponse({ id: 'call-2', approved: true });

      expect(transport.resume).toHaveBeenCalledWith(
        expect.objectContaining({
          decisions: [
            { tool_call_id: 'call-1', decision: 'approve' },
            { tool_call_id: 'call-2', decision: 'approve' },
          ],
        }),
      );
    });

    it('does not reattach for a pause replaced while its resume was in flight', async () => {
      let accept: (() => void) | undefined;
      const { chat, transport } = setup(
        { resumeSelection: () => ({ endpoint: 'agents' }) },
        {
          resume: jest.fn(
            () =>
              new Promise((resolve) => {
                accept = () =>
                  resolve({ streamId: 'convo-1', conversationId: 'convo-1', status: 'resuming' });
              }),
          ),
        },
      );
      chat.restorePendingAction(askAction, 500);
      const answered = chat.addToolOutput({ toolCallId: 'ask-1', output: 'Blue' });
      await flush();
      const next = { ...approvalAction, actionId: 'action-9' } as Agents.PendingAction;
      chat.restorePendingAction(next, 900);

      accept?.();
      await answered;
      await flush();

      expect(transport.reconnectToStream).not.toHaveBeenCalled();
      expect(chat.pendingAction).toBe(next);
    });

    it('shows only the reason of the latest decision for a call', async () => {
      const { chat, stream, sent } = await pause(approvalAction);
      await chat.addToolApprovalResponse({ id: 'call-1', approved: false, reason: 'No' });
      await chat.addToolApprovalResponse({ id: 'call-1', approved: true });

      const call = chat.messages[1].content?.[0] as { tool_call: Agents.ToolCall };
      expect(call.tool_call).toMatchObject({ approval: { decision: 'approve' } });
      expect((call.tool_call as { approval?: { reason?: string } }).approval).not.toHaveProperty(
        'reason',
      );
      stream.push(finalEvent());
      await sent;
    });

    it('resumes a batch once when its last decisions arrive together', async () => {
      const { chat, transport, stream, sent } = await pause(approvalAction);
      transport.resume.mockImplementationOnce(
        () =>
          new Promise((resolve) =>
            setTimeout(
              () => resolve({ streamId: 'convo-1', conversationId: 'convo-1', status: 'resuming' }),
              10,
            ),
          ),
      );

      await Promise.all([
        chat.addToolApprovalResponse({ id: 'call-1', approved: true }),
        chat.addToolApprovalResponse({ id: 'call-2', approved: true }),
      ]);

      expect(transport.resume).toHaveBeenCalledTimes(1);
      stream.push(finalEvent());
      await sent;
    });

    it('attaches to the continuation of a pause restored without a stream', async () => {
      const continuation = createStream();
      const { chat, transport } = setup(
        {},
        { reconnectToStream: jest.fn(async () => continuation) },
      );

      chat.restorePendingAction(askAction, 500);
      await chat.addToolOutput({ toolCallId: 'ask-1', output: 'Blue' });
      await flush();

      expect(transport.reconnectToStream).toHaveBeenCalledWith(
        expect.objectContaining({ streamId: 'convo-1', generationCreatedAt: 500, resume: true }),
      );
      continuation.push(stepEvent);
      continuation.push(finalEvent());
      await flush();
      expect(chat.status).toBe('ready');
      expect(chat.messages[1].text).toBe('Hello');
    });

    it('does not reattach once disposed while a resume is in flight', async () => {
      let accept: (() => void) | undefined;
      const { chat, transport } = setup(
        {},
        {
          resume: jest.fn(
            () =>
              new Promise((resolve) => {
                accept = () =>
                  resolve({ streamId: 'convo-1', conversationId: 'convo-1', status: 'resuming' });
              }),
          ),
        },
      );

      chat.restorePendingAction(askAction, 500);
      const answered = chat.addToolOutput({ toolCallId: 'ask-1', output: 'Blue' });
      await flush();
      chat.dispose();
      await expect(answered).rejects.toThrow('The chat was disposed');
      accept?.();
      await flush();

      expect(transport.reconnectToStream).not.toHaveBeenCalled();
      await expect(chat.sendMessage({ parts: [{ type: 'text', text: 'Hi' }] })).rejects.toThrow(
        'disposed',
      );
    });

    it('stops the continuation of a restored pause with the generation it resumed', async () => {
      const continuation = createStream({ streamId: 'convo-1' });
      const { chat, transport } = setup(
        { resumeSelection: () => ({ endpoint: 'agents' }) },
        { reconnectToStream: jest.fn(async () => continuation) },
      );
      transport.abort.mockImplementation(async () => {
        continuation.push(finalEvent({ terminalStatus: 'aborted' }));
        return { success: true };
      });

      chat.restorePendingAction(askAction, 500);
      await chat.addToolOutput({ toolCallId: 'ask-1', output: 'Blue' });
      await flush();
      continuation.push(stepEvent);
      await flush();
      await chat.stop();

      expect(transport.abort).toHaveBeenCalledWith(
        expect.objectContaining({ endpoint: 'agents', generationCreatedAt: 500 }),
      );
      expect(chat.status).toBe('ready');
    });

    it('stops a restored pause on the server while its continuation is still attaching', async () => {
      const { chat, transport } = setup(
        { resumeSelection: () => ({ endpoint: 'agents' }) },
        { reconnectToStream: jest.fn(() => new Promise<null>(() => undefined)) },
      );
      chat.restorePendingAction(askAction, 500);

      const resumed = chat.resumeStream({ streamId: 'convo-1', generationCreatedAt: 500 });
      await flush();
      await chat.stop();
      await resumed;

      expect(transport.abort).toHaveBeenCalledWith({
        chatId: 'convo-1',
        endpoint: 'agents',
        streamId: 'convo-1',
        generationCreatedAt: 500,
      });
      expect(chat.pendingAction).toBeUndefined();
      expect(chat.status).toBe('ready');
    });

    it('refuses decisions and answers once disposed', async () => {
      const { chat, transport } = setup();
      chat.restorePendingAction(askAction, 500);
      chat.dispose();

      await expect(chat.addToolOutput({ toolCallId: 'ask-1', output: 'Blue' })).rejects.toThrow(
        'disposed',
      );
      expect(transport.resume).not.toHaveBeenCalled();
    });

    it('drops a restored pause once a reconnect finds nothing running', async () => {
      const { chat, transport } = setup();
      chat.restorePendingAction(askAction, 500);

      await chat.resumeStream({ streamId: 'convo-1' });

      expect(transport.reconnectToStream).toHaveBeenCalled();
      expect(chat.pendingAction).toBeUndefined();
    });

    it('drops a restored pause when the reattached stream is another generation', async () => {
      const other = createStream({ streamId: 'convo-1', generationCreatedAt: 200 });
      const { chat } = setup({}, { reconnectToStream: jest.fn(async () => other) });
      chat.restorePendingAction(askAction, 100);

      const resumed = chat.resumeStream({ streamId: 'convo-1' });
      await flush();

      expect(chat.pendingAction).toBeUndefined();
      other.push(finalEvent());
      await resumed;
    });

    it('refuses to restore a pause while a stream is attached', async () => {
      const { chat, stream, sent } = await pause(askAction);
      const newer = { ...askAction, actionId: 'action-7' } as Agents.PendingAction;

      expect(() => chat.restorePendingAction(newer, 900)).toThrow('in flight');
      expect(chat.pendingAction).toBe(askAction);
      stream.push(finalEvent());
      await sent;
    });

    it('drops a restored pause when an explicit reconnect names another generation', async () => {
      const other = createStream({ streamId: 'convo-1', generationCreatedAt: 200 });
      const { chat } = setup({}, { reconnectToStream: jest.fn(async () => other) });
      chat.restorePendingAction(askAction, 100);

      const resumed = chat.resumeStream({ streamId: 'convo-1', generationCreatedAt: 200 });
      await flush();

      expect(chat.pendingAction).toBeUndefined();
      other.push(finalEvent());
      await resumed;
    });

    it('ignores the replay of a pause it already resumed', async () => {
      let attach: (() => void) | undefined;
      const continuation = createStream({ streamId: 'convo-1' });
      const { chat } = setup(
        {},
        {
          reconnectToStream: jest.fn(
            () =>
              new Promise((resolve) => {
                attach = () => resolve(continuation);
              }),
          ),
        },
      );
      chat.restorePendingAction(askAction, 500);
      const resumed = chat.resumeStream({ streamId: 'convo-1' });
      await flush();
      await chat.addToolOutput({ toolCallId: 'ask-1', output: 'Blue' });
      attach?.();
      await flush();
      continuation.push({ type: 'pending_action', data: askAction });
      await flush();

      expect(chat.pendingAction).toBeUndefined();
      continuation.push(finalEvent());
      await resumed;
    });

    it('reports a continuation that finished before it attached as settled', async () => {
      const { chat, state, onFinish } = setup();
      state.error = new Error('dropped');
      state.status = 'error';
      chat.restorePendingAction(askAction, 500);

      await chat.addToolOutput({ toolCallId: 'ask-1', output: 'Blue' });
      await flush();

      expect(onFinish).toHaveBeenCalledWith(expect.objectContaining({ isSettled: true }));
      expect(chat.status).toBe('ready');
      expect(chat.error).toBeUndefined();
    });

    it('submits edit, respond and session-scoped decisions as given', async () => {
      const { chat, transport, stream, sent } = await pause(approvalAction);
      await chat.addToolApprovalResponse({
        id: 'call-1',
        approved: true,
        decision: 'edit',
        editedArguments: { q: 'cats' },
      });
      await chat.addToolApprovalResponse({ id: 'call-2', approved: true, scope: 'session' });

      expect(transport.resume).toHaveBeenCalledWith(
        expect.objectContaining({
          decisions: [
            { tool_call_id: 'call-1', decision: 'edit', editedArguments: { q: 'cats' } },
            { tool_call_id: 'call-2', decision: 'approve', scope: 'session' },
          ],
        }),
      );
      stream.push(finalEvent());
      await sent;
    });

    it('does not restore an expired pause, and drops the one it held', async () => {
      const { chat } = setup();
      chat.restorePendingAction(askAction, 500);

      chat.restorePendingAction({ ...askAction, expiresAt: Date.now() - 1 }, 500);

      expect(chat.pendingAction).toBeUndefined();
      chat.restorePendingAction({ ...approvalAction, expiresAt: Date.now() - 1 }, 500);
      expect(chat.pendingAction).toBeUndefined();
    });

    it('retires a restored pause when its expiry passes without another frame', async () => {
      const { chat, transport } = setup();
      const listener = jest.fn();
      chat.subscribe(listener);
      chat.restorePendingAction({ ...askAction, expiresAt: Date.now() + 30 }, 500);
      expect(chat.pendingAction).toBeDefined();
      listener.mockClear();

      await new Promise((resolve) => setTimeout(resolve, 60));

      expect(chat.pendingAction).toBeUndefined();
      expect(listener).toHaveBeenCalled();
      const next = chat.sendMessage({ parts: [{ type: 'text', text: 'Next' }] });
      await flush();
      expect(transport.sendMessages).toHaveBeenCalledTimes(1);
      chat.dispose();
      await next;
    });

    it('retires a streamed pause when its expiry passes while the stream stays quiet', async () => {
      const { chat, stream, sent } = await pause({ ...askAction, expiresAt: Date.now() + 30 });
      expect(chat.pendingAction?.actionId).toBe(askAction.actionId);

      await new Promise((resolve) => setTimeout(resolve, 60));

      expect(chat.pendingAction).toBeUndefined();
      stream.push(finalEvent());
      await sent;
    });

    it('leaves an expiring pause to the answer in flight, and drops it when that answer fails', async () => {
      let refuse: (error: Error) => void = () => undefined;
      const resume = jest.fn(
        () =>
          new Promise<never>((_, reject) => {
            refuse = reject;
          }),
      );
      const { chat } = setup({}, { resume });
      chat.restorePendingAction({ ...askAction, expiresAt: Date.now() + 30 }, 500);

      const answered = chat.addToolOutput({ toolCallId: 'ask-1', output: 'x' });
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(chat.pendingAction?.actionId).toBe(askAction.actionId);

      refuse(new Error('The pause expired'));
      await expect(answered).rejects.toThrow('The pause expired');
      expect(chat.pendingAction).toBeUndefined();
    });

    it('drops an expired copy of the pause a status read restored while its answer was in flight', async () => {
      let refuse: (error: Error) => void = () => undefined;
      const resume = jest.fn(
        () =>
          new Promise<never>((_, reject) => {
            refuse = reject;
          }),
      );
      const { chat } = setup({}, { resume });
      const action = { ...askAction, expiresAt: Date.now() + 30 };
      chat.restorePendingAction(action, 500);

      const answered = chat.addToolOutput({ toolCallId: 'ask-1', output: 'x' });
      await flush();
      chat.restorePendingAction({ ...action }, 500);
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(chat.pendingAction?.actionId).toBe(askAction.actionId);

      refuse(Object.assign(new Error('Service unavailable'), { response: { status: 503 } }));
      await expect(answered).rejects.toThrow('Service unavailable');
      expect(chat.pendingAction).toBeUndefined();
    });

    it('stops the expiry of a pause the chat no longer holds or that was disposed', async () => {
      const { chat } = setup();
      const listener = jest.fn();
      chat.subscribe(listener);
      chat.restorePendingAction({ ...askAction, expiresAt: Date.now() + 30 }, 500);
      chat.dispose();
      listener.mockClear();

      await new Promise((resolve) => setTimeout(resolve, 60));

      expect(listener).not.toHaveBeenCalled();
    });

    it('reconciles the pause before a host reducer write notifies subscribers', async () => {
      const seen: { event: string; actionId?: string }[] = [];
      let folding: string | undefined;
      const { chat, stream, sent } = await pause(askAction, {
        applyEvent: (event, context) => {
          folding = event.type;
          context.write([...context.messages]);
          folding = undefined;
        },
      });
      chat.subscribe(() => {
        if (folding) {
          seen.push({ event: folding, actionId: chat.pendingAction?.actionId });
        }
      });

      stream.push({
        type: 'sync',
        data: { sync: true, conversationId: 'convo-1', resumeState: { runSteps: [] } },
      } as ChatEvent);
      await flush();
      stream.push({ type: 'pending_action', data: approvalAction });
      await flush();
      stream.push(finalEvent());
      await sent;

      expect(seen).toEqual([
        { event: 'sync', actionId: undefined },
        { event: 'pending_action', actionId: approvalAction.actionId },
        { event: 'final', actionId: undefined },
      ]);
    });

    it('drops an expired pause a stream replays, and the one it held under that id', async () => {
      const { chat, stream, sent } = await pause(askAction);
      expect(chat.pendingAction).toBe(askAction);

      stream.push({ type: 'pending_action', data: { ...askAction, expiresAt: Date.now() - 1 } });
      await flush();
      expect(chat.pendingAction).toBeUndefined();

      stream.push({ type: 'pending_action', data: { ...approvalAction, expiresAt: 1 } });
      await flush();
      expect(chat.pendingAction).toBeUndefined();
      stream.push({ type: 'error', status: 0, data: 'offline' } as ChatEvent);
      await sent;
      await expect(chat.sendMessage({ parts: [{ type: 'text', text: 'Hi' }] })).resolves.toBe(
        undefined,
      );
    });

    it('stops a restored pause of a newer generation, not an older dropped one', async () => {
      const { chat, stream, sent, transport } = await pause(askAction, {
        resumeSelection: () => ({ endpoint: 'agents' }),
      });
      stream.push({ type: 'error', status: 0, data: 'offline' } as ChatEvent);
      await sent;
      const newer = {
        ...askAction,
        actionId: 'action-8',
        streamId: 'convo-1',
      } as Agents.PendingAction;
      chat.restorePendingAction(newer, 900);

      await chat.stop();

      expect(transport.abort).toHaveBeenCalledWith(
        expect.objectContaining({ generationCreatedAt: 900 }),
      );
      expect(chat.pendingAction).toBeUndefined();
    });

    it('holds new turns behind a restored pause until it is stopped on the server', async () => {
      const { chat, transport } = setup({ resumeSelection: () => ({ endpoint: 'agents' }) });
      chat.restorePendingAction(askAction, 500);

      await expect(chat.sendMessage({ parts: [{ type: 'text', text: 'Hi' }] })).rejects.toThrow(
        'paused generation',
      );
      expect(transport.sendMessages).not.toHaveBeenCalled();

      await chat.stop();
      expect(transport.abort).toHaveBeenCalledWith({
        chatId: 'convo-1',
        endpoint: 'agents',
        streamId: 'convo-1',
        generationCreatedAt: 500,
      });
      expect(chat.pendingAction).toBeUndefined();
    });

    it('keeps the pause when only the connection drops', async () => {
      const { chat, stream, sent } = await pause(askAction);
      stream.push({ type: 'error', status: 0, data: 'offline' } as ChatEvent);
      await sent;

      expect(chat.status).toBe('error');
      expect(chat.pendingAction).toBe(askAction);
    });

    it('refuses a decision once the batch is being resumed', async () => {
      const single = {
        ...approvalAction,
        payload: {
          ...approvalAction.payload,
          action_requests: [{ name: 'search', arguments: '{}', tool_call_id: 'call-1' }],
        },
      } as Agents.PendingAction;
      const { chat, transport, stream, sent } = await pause(single);
      let accept: (() => void) | undefined;
      transport.resume.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            accept = () =>
              resolve({ streamId: 'convo-1', conversationId: 'convo-1', status: 'resuming' });
          }),
      );

      const approved = chat.addToolApprovalResponse({ id: 'call-1', approved: true });
      await flush();
      await expect(chat.addToolApprovalResponse({ id: 'call-1', approved: false })).rejects.toThrow(
        'already being resumed',
      );
      accept?.();
      await approved;

      expect(transport.resume).toHaveBeenCalledWith(
        expect.objectContaining({
          decisions: [{ tool_call_id: 'call-1', decision: 'approve' }],
        }),
      );
      stream.push(finalEvent());
      await sent;
    });

    it('drops the pause of a stopped generation whose stream disconnects instead of aborting', async () => {
      const { chat, transport, stream, sent } = await pause(askAction);
      transport.abort.mockImplementation(async () => {
        stream.push({ type: 'error', status: 0, data: 'offline' } as ChatEvent);
        return { success: true };
      });

      await chat.stop();
      await sent;

      expect(chat.pendingAction).toBeUndefined();
    });

    it('drops a pause that arrives while a confirmed stop is in flight', async () => {
      const { chat, transport, stream } = setup();
      let confirm: (() => void) | undefined;
      transport.abort.mockImplementation(
        () =>
          new Promise((resolve) => {
            confirm = () => resolve({ success: true });
          }),
      );
      const turn = chat.sendMessage({ parts: [{ type: 'text', text: 'Hi' }] });
      await flush();
      stream.push(stepEvent);
      await flush();

      const stopped = chat.stop();
      stream.push({ type: 'pending_action', data: askAction });
      await flush();
      stream.push({ type: 'error', status: 0, data: 'offline' } as ChatEvent);
      await flush();
      confirm?.();
      await stopped;
      await turn;

      expect(chat.pendingAction).toBeUndefined();
    });

    it('keeps the pause of a turn started while a slow stop was in flight', async () => {
      const first = createStream({ streamId: 'convo-1', generationCreatedAt: 100 });
      const second = createStream({ streamId: 'convo-1', generationCreatedAt: 200 });
      let confirm: (() => void) | undefined;
      const { chat, transport } = setup(
        {},
        {
          sendMessages: jest
            .fn()
            .mockResolvedValueOnce({ status: 'stream', stream: first })
            .mockResolvedValueOnce({ status: 'stream', stream: second }),
          abort: jest.fn(
            () =>
              new Promise((resolve) => {
                confirm = () => resolve({ success: true });
              }),
          ),
        },
      );
      const firstTurn = chat.sendMessage({ parts: [{ type: 'text', text: 'Hi' }] });
      await flush();
      const stopped = chat.stop();
      first.push(finalEvent());
      await firstTurn;

      const secondTurn = chat.sendMessage({ parts: [{ type: 'text', text: 'Again' }] });
      await flush();
      second.push({ type: 'pending_action', data: askAction });
      await flush();
      confirm?.();
      await stopped;

      expect(transport.abort).toHaveBeenCalledTimes(1);
      expect(chat.pendingAction).toBe(askAction);
      second.push(finalEvent());
      await secondTurn;
    });

    it('reports ready once a stop ends a pause its dropped connection left in error', async () => {
      const { chat, stream, sent } = await pause(askAction);
      stream.push({ type: 'error', status: 0, data: 'offline' } as ChatEvent);
      await sent;
      expect(chat.status).toBe('error');

      await chat.stop();

      expect(chat.pendingAction).toBeUndefined();
      expect(chat.status).toBe('ready');
      expect(chat.error).toBeUndefined();
    });

    it('drops the pause when the generation aborts or fails', async () => {
      const aborted = await pause(askAction);
      aborted.stream.push({ type: 'abort', data: {} } as ChatEvent);
      await aborted.sent;
      expect(aborted.chat.pendingAction).toBeUndefined();
      await expect(
        aborted.chat.addToolOutput({ toolCallId: 'ask-1', output: 'x' }),
      ).rejects.toThrow('No question is pending');

      const failed = await pause(askAction);
      failed.stream.push({ type: 'error', data: 'boom' } as ChatEvent);
      await failed.sent;
      expect(failed.chat.pendingAction).toBeUndefined();
    });

    it('resumes a later pause with its own generation, not the previous one', async () => {
      const first = createStream({ streamId: 'convo-1', generationCreatedAt: 100 });
      const second = createStream({ streamId: 'convo-1' });
      const { chat, transport } = setup(
        { resumeSelection: () => ({ endpoint: 'agents' }) },
        {
          sendMessages: jest
            .fn()
            .mockResolvedValueOnce({ status: 'stream', stream: first })
            .mockResolvedValueOnce({ status: 'stream', stream: second }),
        },
      );

      const firstTurn = chat.sendMessage({ parts: [{ type: 'text', text: 'Hi' }] });
      await flush();
      first.push(finalEvent());
      await firstTurn;

      const secondTurn = chat.sendMessage({ parts: [{ type: 'text', text: 'Again' }] });
      await flush();
      second.push({ type: 'pending_action', data: askAction });
      await flush();
      await chat.addToolOutput({ toolCallId: 'ask-1', output: 'x' });
      /** The second stream names no generation, so the answer is fenced by its action alone. */
      expect(transport.resume).toHaveBeenCalledTimes(1);
      const [request] = (transport.resume as jest.Mock).mock.calls[0];
      expect(request).toMatchObject({ actionId: askAction.actionId, answer: 'x' });
      expect(request).not.toHaveProperty('generationCreatedAt');
      expect(chat.pendingAction).toBeUndefined();
      second.push(finalEvent());
      await secondTurn;
    });

    it('refuses a decision for a call the pause does not hold', async () => {
      const { chat, stream, sent } = await pause(approvalAction);

      await expect(chat.addToolApprovalResponse({ id: 'other', approved: true })).rejects.toThrow(
        'not awaiting approval',
      );
      await expect(chat.addToolOutput({ toolCallId: 'call-1', output: 'x' })).rejects.toThrow(
        'No question is pending',
      );

      stream.push(finalEvent());
      await sent;
      await expect(chat.addToolApprovalResponse({ id: 'call-1', approved: true })).rejects.toThrow(
        'No tool approval is pending',
      );
    });

    it('answers a question with free text or keyed answers', async () => {
      const { chat, transport, stream, sent } = await pause(askAction);

      await expect(chat.addToolOutput({ toolCallId: 'other', output: 'x' })).rejects.toThrow(
        'not awaiting an answer',
      );
      await chat.addToolOutput({ toolCallId: 'ask-1', output: 'Blue' });
      expect(transport.resume).toHaveBeenCalledWith(
        expect.objectContaining({ actionId: 'action-2', answer: 'Blue' }),
      );

      stream.push(finalEvent());
      await sent;

      chat.restorePendingAction(askAction, 400);
      await chat.addToolOutput({ toolCallId: 'ask-1', output: { q1: 'Blue' } });
      expect(transport.resume).toHaveBeenLastCalledWith(
        expect.objectContaining({ generationCreatedAt: 400, answers: { q1: 'Blue' } }),
      );
    });

    it('refuses to answer over a transport that cannot resume', async () => {
      const { chat, transport, stream, sent } = await pause(askAction);
      (transport as Partial<Transport>).resume = undefined;

      await expect(chat.addToolOutput({ toolCallId: 'ask-1', output: 'Blue' })).rejects.toThrow(
        'cannot resume',
      );
      expect(chat.pendingAction).toBe(askAction);

      stream.push(finalEvent());
      await sent;
    });
  });

  describe('stop answers and reattachment targets', () => {
    const steer = { steerId: 'steer-1', text: 'Shorter' };
    const pausedAction = {
      actionId: 'action-5',
      streamId: 'new',
      createdAt: 1,
      payload: {
        type: 'ask_user_question',
        question: { question: 'Which?' },
        tool_call_id: 'ask-5',
      },
    } as Agents.PendingAction;

    it('hands back the steers a stop found uninjected, under the conversation it stopped', async () => {
      const { chat, stream, transport } = setup();
      transport.abort.mockImplementation(async () => {
        stream.push(finalEvent({ terminalStatus: 'aborted' }));
        return { success: true, aborted: 'stream-7', pendingSteers: [steer] };
      });
      const sent = chat.sendMessage({ parts: [{ type: 'text', text: 'Hi' }] });
      await flush();

      /** The answer names the stopped stream; the conversation is the one the chat knows. */
      await expect(chat.stop()).resolves.toEqual({
        status: 'stopped',
        conversationId: 'convo-1',
        pendingSteers: [steer],
      });
      await sent;
    });

    it('hands back no steers from a stop the run had already settled or could not save', async () => {
      for (const answer of [
        { settled: true, terminalStatus: 'complete' as const },
        { persistenceFailed: true },
      ]) {
        const { chat, stream, transport } = setup();
        transport.abort.mockImplementation(async () => {
          stream.push(finalEvent({ terminalStatus: 'aborted' }));
          return { success: true, aborted: 'convo-1', pendingSteers: [steer], ...answer };
        });
        const sent = chat.sendMessage({ parts: [{ type: 'text', text: 'Hi' }] });
        await flush();

        await expect(chat.stop()).resolves.toEqual({
          status: 'stopped',
          conversationId: 'convo-1',
        });
        await sent;
      }
    });

    it('reports a turn under `new` it saw no frame for as unaddressable, leaving it attached', async () => {
      const stream = createStream();
      const { chat, transport } = setup(
        {
          id: 'new',
          prepareRequest: jest.fn(() => ({
            payload: { endpoint: 'assistants', text: 'Hi' } as TPayload,
            messages: [userMessage, placeholder],
            responseMessageId: 'response-1',
          })),
        },
        { sendMessages: jest.fn(async () => ({ status: 'stream' as const, stream })) },
      );
      const sent = chat.sendMessage({ parts: [{ type: 'text', text: 'Hi' }] });
      await flush();
      stream.push(stepEvent);
      await flush();

      await expect(chat.stop()).resolves.toEqual({ status: 'unaddressable' });

      expect(transport.abort).not.toHaveBeenCalled();
      expect(chat.status).toBe('streaming');
      stream.push(finalEvent());
      await sent;
    });

    it('reports a start cancelled before it reached the transport as stopped', async () => {
      const { chat, transport } = setup({
        prepareRequest: jest.fn(() => new Promise<never>(() => undefined)),
      });
      const sent = chat.sendMessage({ parts: [{ type: 'text', text: 'Hi' }] });
      await flush();

      await expect(chat.stop()).resolves.toEqual({ status: 'stopped' });
      await sent.catch(() => undefined);
      expect(transport.sendMessages).not.toHaveBeenCalled();
    });

    it('drops a restored pause once a newer generation is restored with an expired one', async () => {
      const { chat } = setup();
      chat.restorePendingAction({ ...pausedAction, streamId: 'convo-1' }, 500);

      chat.restorePendingAction(
        { ...pausedAction, actionId: 'action-6', streamId: 'convo-1', expiresAt: 1 },
        900,
      );

      expect(chat.pendingAction).toBeUndefined();
    });

    it('sends no stop for a late start it cannot name', async () => {
      let open: ((result: { status: 'stream'; stream: ChatStream }) => void) | undefined;
      const late = createStream();
      const { chat, transport, onError } = setup(
        {
          id: 'new',
          prepareRequest: jest.fn(() => ({
            payload: { endpoint: 'assistants', text: 'Hi' } as TPayload,
            messages: [userMessage, placeholder],
            responseMessageId: 'response-1',
          })),
        },
        {
          sendMessages: jest.fn(
            () =>
              new Promise<{ status: 'stream'; stream: ChatStream }>((resolve) => {
                open = resolve;
              }),
          ),
        },
      );
      const sent = chat.sendMessage({ parts: [{ type: 'text', text: 'Hi' }] });
      await flush();

      await expect(chat.stop()).resolves.toEqual({ status: 'unaddressable' });
      open?.({ status: 'stream', stream: late });
      await sent.catch(() => undefined);
      await flush();

      expect(late.closed()).toBe(true);
      expect(transport.abort).not.toHaveBeenCalled();
      expect(onError).toHaveBeenCalledTimes(1);
    });

    it("stops an Assistants run by the ids its sync frame named, from that frame's own callback", async () => {
      const stream = createStream();
      const stops: Promise<unknown>[] = [];
      const harness: { chat?: Chat } = {};
      const { chat, transport } = setup(
        {
          id: 'new',
          prepareRequest: jest.fn(() => ({
            payload: { endpoint: 'assistants', text: 'Hi' } as TPayload,
            messages: [userMessage, placeholder],
            responseMessageId: 'response-1',
          })),
          onEvent: (event) => {
            if (event.type === 'sync' && harness.chat) {
              stops.push(harness.chat.stop());
            }
          },
        },
        { sendMessages: jest.fn(async () => ({ status: 'stream' as const, stream })) },
      );
      harness.chat = chat;
      transport.abort.mockImplementation(async () => {
        stream.push(finalEvent({ terminalStatus: 'aborted' }));
        return { final: true, conversation: {}, runMessages: [] };
      });
      const sent = chat.sendMessage({ parts: [{ type: 'text', text: 'Hi' }] });
      await flush();

      stream.push({
        type: 'sync',
        data: {
          conversationId: 'convo-9',
          responseMessage: { ...placeholder, messageId: 'response-9' },
        },
      } as ChatEvent);
      await sent;
      await Promise.all(stops);

      expect(transport.abort).toHaveBeenCalledWith(
        expect.objectContaining({ abortKey: 'convo-9:response-9' }),
      );
    });

    it('reports a restored pause a reconnect finds finished elsewhere as settled', async () => {
      const { chat, transport, onFinish } = setup();
      chat.restorePendingAction({ ...pausedAction, streamId: 'convo-1' }, 500);
      transport.reconnectToStream.mockResolvedValueOnce(null);

      await chat.resumeStream({ streamId: 'convo-1', generationCreatedAt: 500 });

      expect(chat.pendingAction).toBeUndefined();
      expect(onFinish).toHaveBeenCalledTimes(1);
      expect(onFinish).toHaveBeenCalledWith(expect.objectContaining({ isSettled: true }));
    });

    it('reattaches a dropped first turn under the conversation its sync frame assigned', async () => {
      const { chat, stream, transport, onFinish } = setup({ id: 'new' });
      const sent = chat.sendMessage({ parts: [{ type: 'text', text: 'Hi' }] });
      await flush();
      stream.push({
        type: 'sync',
        data: { conversationId: 'convo-9', responseMessage: placeholder },
      } as ChatEvent);
      stream.push({ type: 'error', status: 0, data: 'offline' } as ChatEvent);
      await sent;
      transport.reconnectToStream.mockResolvedValueOnce(null);

      await chat.resumeStream({ streamId: 'convo-1' });

      expect(transport.reconnectToStream).toHaveBeenLastCalledWith(
        expect.objectContaining({ chatId: 'convo-9' }),
      );
      expect(onFinish).toHaveBeenLastCalledWith(
        expect.objectContaining({ isSettled: true, conversationId: 'convo-9' }),
      );
    });

    it('stops a replacement from the reconnect notice and reattaches it under its conversation', async () => {
      const stream = createStream({ generationCreatedAt: 200 });
      const stops: Promise<unknown>[] = [];
      const { chat, transport, onFinish } = setup(
        { id: 'new' },
        {
          sendMessages: jest.fn(async () => ({
            status: 'replaced' as const,
            generationProtocolVersion: 2,
            conversationId: 'convo-9',
            streamId: 'stream-2',
            generationCreatedAt: 200,
          })),
          reconnectToStream: jest.fn(async () => stream),
        },
      );
      transport.abort.mockImplementation(async () => {
        stream.push({ type: 'error', status: 0, data: 'offline' } as ChatEvent);
        return { success: true };
      });
      const unsubscribe = chat.subscribe(() => {
        if (chat.connection === 'reconnecting' && stops.length === 0) {
          stops.push(chat.stop());
        }
      });
      const sent = chat.sendMessage({ parts: [{ type: 'text', text: 'Hi' }] });
      await flush();
      unsubscribe();
      await expect(stops[0]).resolves.toEqual({ status: 'stopped' });
      await sent;
      expect(transport.abort).toHaveBeenCalledWith(
        expect.objectContaining({ streamId: 'stream-2', generationCreatedAt: 200 }),
      );
      expect(onFinish).toHaveBeenCalledTimes(1);

      const dropped = setup(
        { id: 'new' },
        {
          sendMessages: jest.fn(async () => ({
            status: 'replaced' as const,
            generationProtocolVersion: 2,
            conversationId: 'convo-9',
            streamId: 'stream-2',
            generationCreatedAt: 200,
          })),
        },
      );
      const replacement = createStream({ generationCreatedAt: 200 });
      dropped.transport.reconnectToStream.mockResolvedValueOnce(replacement);
      const sentDropped = dropped.chat.sendMessage({ parts: [{ type: 'text', text: 'Hi' }] });
      await flush();
      replacement.push({ type: 'error', status: 0, data: 'offline' } as ChatEvent);
      await sentDropped;
      dropped.transport.reconnectToStream.mockResolvedValueOnce(null);
      await dropped.chat.resumeStream({ streamId: 'stream-2', generationCreatedAt: 200 });

      expect(dropped.transport.reconnectToStream).toHaveBeenLastCalledWith(
        expect.objectContaining({ chatId: 'convo-9' }),
      );
    });

    it('reports nothing to stop as idle', async () => {
      const { chat, transport } = setup();

      await expect(chat.stop()).resolves.toEqual({ status: 'idle' });
      expect(transport.abort).not.toHaveBeenCalled();
    });

    it('keeps an unsaved stop attached, and reports it unsaved when nothing is left to attach to', async () => {
      let open: ((stream: ChatStream | null) => void) | undefined;
      const { chat, transport, onFinish } = setup(
        { resumeSelection: () => ({ endpoint: 'agents' }) },
        {
          reconnectToStream: jest.fn(
            () =>
              new Promise<ChatStream | null>((resolve) => {
                open = resolve;
              }),
          ),
          abort: jest.fn(async () => ({
            success: true,
            generationProtocolVersion: 2,
            aborted: 'convo-1',
            persistenceFailed: true,
          })),
        },
      );
      const resumed = chat.resumeStream({ streamId: 'convo-1', generationCreatedAt: 300 });
      await flush();

      const stopped = chat.stop();
      await flush();
      const [request] = transport.reconnectToStream.mock.calls[0];
      expect(request.abortSignal?.aborted).toBe(false);
      expect(onFinish).not.toHaveBeenCalled();

      open?.(null);
      await stopped;
      await resumed;
      expect(chat.status).toBe('ready');
      expect(onFinish).toHaveBeenCalledTimes(1);
      expect(onFinish).toHaveBeenCalledWith(
        expect.objectContaining({
          isAbort: true,
          isSettled: true,
          conversationId: 'convo-1',
          reconcileReason: 'abort_persistence_failed',
        }),
      );
    });

    it('settles a reconnect that finds nothing by the answer of a stop still in flight', async () => {
      let open: ((stream: ChatStream | null) => void) | undefined;
      let answer: ((result: ChatAbortResult) => void) | undefined;
      const { chat, onFinish } = setup(
        { resumeSelection: () => ({ endpoint: 'agents' }) },
        {
          reconnectToStream: jest.fn(
            () =>
              new Promise<ChatStream | null>((resolve) => {
                open = resolve;
              }),
          ),
          abort: jest.fn(
            () =>
              new Promise<ChatAbortResult>((resolve) => {
                answer = resolve;
              }),
          ),
        },
      );
      const resumed = chat.resumeStream({ streamId: 'convo-1', generationCreatedAt: 300 });
      await flush();

      const stopped = chat.stop();
      await flush();
      open?.(null);
      await flush();
      expect(onFinish).not.toHaveBeenCalled();

      answer?.({
        success: true,
        generationProtocolVersion: 2,
        aborted: 'convo-1',
        persistenceFailed: true,
      });
      await stopped;
      await resumed;
      expect(chat.status).toBe('ready');
      expect(onFinish).toHaveBeenCalledTimes(1);
      expect(onFinish).toHaveBeenCalledWith(
        expect.objectContaining({
          isAbort: true,
          isSettled: true,
          conversationId: 'convo-1',
          reconcileReason: 'abort_persistence_failed',
        }),
      );
    });

    it('names the conversation an unframed stop of a dropped first turn settled under', async () => {
      const { chat, stream, transport, onFinish } = setup({ id: 'new' });
      transport.abort.mockResolvedValue({
        success: true,
        generationProtocolVersion: 2,
        aborted: 'convo-9',
        persistenceFailed: true,
      });
      const sent = chat.sendMessage({ parts: [{ type: 'text', text: 'Hi' }] });
      await flush();
      stream.push({ type: 'error', status: 0, data: 'offline' } as ChatEvent);
      await sent;

      await chat.stop();

      expect(onFinish).toHaveBeenLastCalledWith(
        expect.objectContaining({
          isSettled: true,
          conversationId: 'convo-9',
          reconcileReason: 'abort_persistence_failed',
        }),
      );
    });

    it('adopts the conversation a settled stop of a dropped first turn names by its stream', async () => {
      const { chat, stream, transport, onFinish } = setup({ id: 'new' });
      transport.abort.mockResolvedValue({
        success: false,
        settled: true,
        code: 'RUN_ALREADY_SETTLED',
        streamId: 'convo-9',
        generationProtocolVersion: 2,
        terminalStatus: 'complete',
      });
      const sent = chat.sendMessage({ parts: [{ type: 'text', text: 'Hi' }] });
      await flush();
      stream.push({ type: 'error', status: 0, data: 'offline' } as ChatEvent);
      await sent;

      await expect(chat.stop()).resolves.toMatchObject({
        status: 'stopped',
        conversationId: 'convo-9',
      });
      expect(onFinish).toHaveBeenLastCalledWith(
        expect.objectContaining({ isSettled: true, conversationId: 'convo-9' }),
      );

      void chat.sendMessage({ parts: [{ type: 'text', text: 'Next' }] });
      await flush();
      expect(transport.sendMessages).toHaveBeenLastCalledWith(
        expect.objectContaining({ chatId: 'convo-9' }),
      );
    });

    it('stops a dropped turn it reattached to at the endpoint the turn started on', async () => {
      const reattached = createStream({ streamId: 'convo-1', generationCreatedAt: 100 });
      const { chat, stream, transport } = setup();
      transport.abort.mockImplementation(async () => {
        reattached.push(finalEvent({ terminalStatus: 'aborted' }));
        return { success: true };
      });
      const sent = chat.sendMessage({ parts: [{ type: 'text', text: 'Hi' }] });
      await flush();
      stream.push({ type: 'error', status: 0, data: 'offline' } as ChatEvent);
      await sent;
      transport.reconnectToStream.mockResolvedValueOnce(reattached);
      const resumed = chat.resumeStream({ streamId: 'convo-1', generationCreatedAt: 100 });
      await flush();

      await chat.stop();
      await resumed;

      expect(transport.abort).toHaveBeenCalledWith(
        expect.objectContaining({ endpoint: 'agents', streamId: 'convo-1' }),
      );
    });

    it('reports the response of a dropped turn it reattached to, not the list tail', async () => {
      const reattached = createStream({ streamId: 'convo-1', generationCreatedAt: 100 });
      const sibling: TMessage = { ...placeholder, messageId: 'sibling-1', text: 'Other branch' };
      const { chat, stream, transport, state, onFinish } = setup({
        prepareRequest: jest.fn(() => ({
          payload,
          messages: [userMessage, placeholder],
          responseMessageId: placeholder.messageId,
        })),
      });
      const sent = chat.sendMessage({ parts: [{ type: 'text', text: 'Hi' }] });
      await flush();
      stream.push({ type: 'error', status: 0, data: 'offline' } as ChatEvent);
      await sent;
      state.replaceMessages([...chat.messages, sibling]);
      transport.reconnectToStream.mockResolvedValueOnce(reattached);
      const resumed = chat.resumeStream({ streamId: 'convo-1', generationCreatedAt: 100 });
      await flush();

      reattached.push({ type: 'abort', data: {} } as ChatEvent);
      await resumed;

      expect(onFinish).toHaveBeenLastCalledWith(
        expect.objectContaining({
          isAbort: true,
          message: expect.objectContaining({ messageId: placeholder.messageId }),
        }),
      );
    });

    it('reports the response of a reattachment to another generation as unknown, not the dropped turn', async () => {
      const reattached = createStream({ streamId: 'convo-1', generationCreatedAt: 200 });
      const { chat, stream, transport, state, onFinish } = setup({
        prepareRequest: jest.fn(() => ({
          payload,
          messages: [userMessage, placeholder],
          responseMessageId: placeholder.messageId,
        })),
      });
      const sent = chat.sendMessage({ parts: [{ type: 'text', text: 'Hi' }] });
      await flush();
      stream.push({ type: 'error', status: 0, data: 'offline' } as ChatEvent);
      await sent;
      const newer: TMessage = { ...placeholder, messageId: 'response-2', text: 'Newer' };
      state.replaceMessages([...chat.messages, newer]);
      transport.reconnectToStream.mockResolvedValueOnce(reattached);
      const resumed = chat.resumeStream({ streamId: 'convo-1', generationCreatedAt: 200 });
      await flush();

      reattached.push({ type: 'abort', data: {} } as ChatEvent);
      await resumed;

      expect(onFinish).toHaveBeenLastCalledWith(
        expect.objectContaining({ isAbort: true, isResponseUnknown: true, message: undefined }),
      );
    });

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

    it('reports the response unknown when a reattachment without a timestamp finds another generation', async () => {
      const reattached = createStream({ streamId: 'convo-1', generationCreatedAt: 200 });
      const { chat, stream, transport, onFinish } = setup({
        prepareRequest: jest.fn(() => ({
          payload,
          messages: [userMessage, placeholder],
          responseMessageId: placeholder.messageId,
        })),
      });
      const sent = chat.sendMessage({ parts: [{ type: 'text', text: 'Hi' }] });
      await flush();
      stream.push({ type: 'error', status: 0, data: 'offline' } as ChatEvent);
      await sent;
      transport.reconnectToStream.mockResolvedValueOnce(reattached);
      const resumed = chat.resumeStream({ streamId: 'convo-1' });
      await flush();

      reattached.push({ type: 'abort', data: {} } as ChatEvent);
      await resumed;

      expect(onFinish).toHaveBeenLastCalledWith(
        expect.objectContaining({ isAbort: true, isResponseUnknown: true, message: undefined }),
      );
    });

    it('keeps the pause of a generation whose stream failed while read, and a stop ends it', async () => {
      const failing: ChatStream = {
        streamId: 'convo-1',
        close: () => undefined,
        async *[Symbol.asyncIterator]() {
          yield { type: 'pending_action', data: pausedAction } as ChatEvent;
          throw new Error('Malformed frame');
        },
      };
      const { chat, transport } = setup();
      transport.sendMessages.mockResolvedValueOnce({ status: 'stream', stream: failing });

      await chat.sendMessage({ parts: [{ type: 'text', text: 'Hi' }] });

      /** The stream failed, not the generation, which still waits on its pause. */
      expect(chat.status).toBe('error');
      expect(chat.pendingAction?.actionId).toBe('action-5');
      transport.abort.mockResolvedValueOnce({ success: true });
      await chat.stop();
      expect(transport.abort).toHaveBeenCalledTimes(1);
      expect(chat.pendingAction).toBeUndefined();
      transport.sendMessages.mockResolvedValueOnce({
        status: 'settled',
        conversationId: 'convo-1',
        generationProtocolVersion: 2,
      });
      await expect(
        chat.sendMessage({ parts: [{ type: 'text', text: 'Again' }] }),
      ).resolves.toBeUndefined();
    });

    it('reports a continuation that ended while an earlier reconnect was still opening', async () => {
      let open: ((stream: ChatStream | null) => void) | undefined;
      const { chat, onFinish } = setup(
        {},
        {
          reconnectToStream: jest.fn(
            () =>
              new Promise<ChatStream | null>((resolve) => {
                open = resolve;
              }),
          ),
        },
      );
      chat.restorePendingAction({ ...pausedAction, streamId: 'convo-1' }, 500);
      const resumed = chat.resumeStream({ streamId: 'convo-1', generationCreatedAt: 500 });
      await flush();

      await chat.addToolOutput({ toolCallId: 'ask-5', output: 'Blue' });
      open?.(null);
      await resumed;

      expect(chat.status).toBe('ready');
      expect(onFinish).toHaveBeenCalledTimes(1);
      expect(onFinish).toHaveBeenCalledWith(expect.objectContaining({ isSettled: true }));
    });

    it('ignores a status read that restores a pause this chat already resumed', async () => {
      const { chat } = setup();
      const action = { ...pausedAction, streamId: 'convo-1' };
      chat.restorePendingAction(action, 500);
      await chat.addToolOutput({ toolCallId: 'ask-5', output: 'Blue' });
      await flush();

      chat.restorePendingAction(action, 500);

      expect(chat.pendingAction).toBeUndefined();
    });

    it('lets a completion callback start a turn once a stopped pause ended', async () => {
      const next: Promise<void>[] = [];
      const { chat, transport } = setup({
        resumeSelection: () => ({ endpoint: 'agents' }),
        onFinish: () => {
          if (next.length > 0) {
            return;
          }
          transport.sendMessages.mockResolvedValueOnce({
            status: 'settled',
            conversationId: 'convo-1',
            generationProtocolVersion: 2,
          });
          next.push(chat.sendMessage({ parts: [{ type: 'text', text: 'Next' }] }));
        },
      });
      transport.reconnectToStream.mockImplementation(
        (request) =>
          new Promise((_resolve, reject) => {
            request.abortSignal?.addEventListener('abort', () => reject(new Error('aborted')));
          }),
      );
      chat.restorePendingAction({ ...pausedAction, streamId: 'convo-1' }, 500);
      const resumed = chat.resumeStream({ streamId: 'convo-1', generationCreatedAt: 500 });
      await flush();

      await chat.stop();
      await resumed;

      expect(next).toHaveLength(1);
      await expect(next[0]).resolves.toBeUndefined();
      expect(chat.pendingAction).toBeUndefined();
    });

    it('reports nothing for a stop answered after the chat was disposed', async () => {
      for (const restore of [false, true]) {
        let answer: ((result: ChatAbortResult) => void) | undefined;
        const { chat, stream, transport, onFinish } = setup(
          { resumeSelection: () => ({ endpoint: 'agents' }) },
          {
            abort: jest.fn(
              () =>
                new Promise((resolve) => {
                  answer = resolve;
                }),
            ),
          },
        );
        if (restore) {
          chat.restorePendingAction({ ...pausedAction, streamId: 'convo-1' }, 500);
        } else {
          const sent = chat.sendMessage({ parts: [{ type: 'text', text: 'Hi' }] });
          await flush();
          stream.push({ type: 'error', status: 0, data: 'offline' } as ChatEvent);
          await sent;
        }
        const finishes = onFinish.mock.calls.length;

        const stopped = chat.stop();
        await flush();
        chat.dispose();
        await expect(stopped).rejects.toThrow('The chat was disposed');
        answer?.({ success: true, persistenceFailed: true });
        await flush();

        expect(transport.abort).toHaveBeenCalledTimes(1);
        expect(onFinish).toHaveBeenCalledTimes(finishes);
      }
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

    it('reattaches an answered first-turn pause under the conversation the server assigned', async () => {
      const { chat, transport, onFinish } = setup(
        { id: 'new' },
        {
          resume: jest.fn(async () => ({
            streamId: 'convo-9',
            conversationId: 'convo-9',
            status: 'resuming' as const,
          })),
        },
      );

      chat.restorePendingAction(pausedAction, 500);
      await chat.addToolOutput({ toolCallId: 'ask-5', output: 'Blue' });
      await flush();

      expect(transport.reconnectToStream).toHaveBeenCalledWith(
        expect.objectContaining({ chatId: 'convo-9', streamId: 'convo-9' }),
      );
      expect(onFinish).toHaveBeenCalledWith(
        expect.objectContaining({ isSettled: true, conversationId: 'convo-9' }),
      );
    });

    it('keeps the assigned conversation of a continuation that dropped before its sync frame', async () => {
      const continuation = createStream({ streamId: 'convo-9', generationCreatedAt: 500 });
      const { chat, transport, onFinish } = setup(
        { id: 'new', resumeSelection: () => ({ endpoint: 'agents' }) },
        {
          resume: jest.fn(async () => ({
            streamId: 'convo-9',
            conversationId: 'convo-9',
            status: 'resuming' as const,
          })),
          reconnectToStream: jest.fn(async () => continuation),
        },
      );
      chat.restorePendingAction(pausedAction, 500);
      await chat.addToolOutput({ toolCallId: 'ask-5', output: 'Blue' });
      await flush();
      continuation.push({ type: 'error', status: 0, data: 'offline' } as ChatEvent);
      await flush();
      expect(onFinish).toHaveBeenLastCalledWith(expect.objectContaining({ isDisconnect: true }));
      transport.reconnectToStream.mockResolvedValueOnce(null);

      await chat.resumeStream();

      expect(transport.reconnectToStream).toHaveBeenLastCalledWith(
        expect.objectContaining({ chatId: 'convo-9' }),
      );
      expect(onFinish).toHaveBeenLastCalledWith(
        expect.objectContaining({ isSettled: true, conversationId: 'convo-9' }),
      );
    });

    it('ends a reattachment of the same generation by a detached stop answered after it', async () => {
      const { chat, stream, transport, onFinish } = setup({
        resumeSelection: () => ({ endpoint: 'agents' }),
      });
      const sent = chat.sendMessage({ parts: [{ type: 'text', text: 'Hi' }] });
      await flush();
      stream.push({ type: 'pending_action', data: pausedAction });
      stream.push({ type: 'error', status: 0, data: 'offline' } as ChatEvent);
      await sent;
      expect(chat.pendingAction?.actionId).toBe('action-5');

      let answer: (result: ChatAbortResult) => void = () => undefined;
      transport.abort.mockImplementationOnce(
        () =>
          new Promise<ChatAbortResult>((resolve) => {
            answer = resolve;
          }),
      );
      const stopped = chat.stop();
      await flush();
      const reattached = createStream({ streamId: 'convo-1', generationCreatedAt: 100 });
      transport.reconnectToStream.mockResolvedValueOnce(reattached);
      const resumed = chat.resumeStream({ streamId: 'convo-1', generationCreatedAt: 100 });
      await flush();
      expect(chat.connection).toBe('live');

      answer({ success: true });
      await flush();
      reattached.close();
      await resumed;

      await expect(stopped).resolves.toEqual({ status: 'stopped' });
      expect(transport.abort).toHaveBeenCalledTimes(1);
      expect(chat.status).toBe('ready');
      expect(chat.pendingAction).toBeUndefined();
      expect(onFinish).toHaveBeenLastCalledWith(
        expect.objectContaining({ isAbort: true, isDisconnect: false }),
      );
    });

    it('ends a reattachment of a restored pause by the stop answered after it', async () => {
      const { chat, transport, onFinish } = setup({
        resumeSelection: () => ({ endpoint: 'agents' }),
      });
      chat.restorePendingAction(pausedAction, 500);
      let answer: (result: ChatAbortResult) => void = () => undefined;
      transport.abort.mockImplementationOnce(
        () =>
          new Promise<ChatAbortResult>((resolve) => {
            answer = resolve;
          }),
      );
      const stopped = chat.stop();
      await flush();
      const reattached = createStream({ streamId: 'convo-1', generationCreatedAt: 500 });
      transport.reconnectToStream.mockResolvedValueOnce(reattached);
      const resumed = chat.resumeStream({ streamId: 'convo-1', generationCreatedAt: 500 });
      await flush();
      expect(chat.connection).toBe('live');

      answer({ success: true });
      await flush();
      reattached.close();
      await resumed;

      await expect(stopped).resolves.toEqual({ status: 'stopped' });
      expect(transport.abort).toHaveBeenCalledTimes(1);
      expect(chat.status).toBe('ready');
      expect(chat.pendingAction).toBeUndefined();
      expect(onFinish).toHaveBeenLastCalledWith(
        expect.objectContaining({ isAbort: true, isDisconnect: false }),
      );
    });

    it('does not end another generation a restored pause reattachment found by its stop', async () => {
      const { chat, transport, onFinish } = setup({
        resumeSelection: () => ({ endpoint: 'agents' }),
      });
      chat.restorePendingAction(pausedAction, 500);
      let answer: (result: ChatAbortResult) => void = () => undefined;
      transport.abort.mockImplementationOnce(
        () =>
          new Promise<ChatAbortResult>((resolve) => {
            answer = resolve;
          }),
      );
      const stopped = chat.stop();
      await flush();
      const newer = createStream({ streamId: 'convo-1', generationCreatedAt: 700 });
      transport.reconnectToStream.mockResolvedValueOnce(newer);
      const resumed = chat.resumeStream({ streamId: 'convo-1' });
      await flush();

      answer({ success: true });
      await stopped;
      newer.close();
      await resumed;

      expect(onFinish).toHaveBeenLastCalledWith(expect.objectContaining({ isDisconnect: true }));
    });

    it('addresses a stop made as a newer reattachment clears a restored pause to that one', async () => {
      const { chat, transport } = setup({
        resumeSelection: () => ({ endpoint: 'agents' }),
      });
      transport.reconnectToStream.mockImplementationOnce(() => new Promise(() => undefined));
      chat.restorePendingAction(pausedAction, 100);
      const stops: Promise<unknown>[] = [];
      chat.subscribe(() => {
        if (!chat.pendingAction && stops.length === 0) {
          stops.push(chat.stop().catch(() => undefined));
        }
      });

      void chat.resumeStream({ streamId: 'convo-1', generationCreatedAt: 200 });
      await Promise.all(stops);

      expect(transport.abort).toHaveBeenCalledWith(
        expect.objectContaining({ generationCreatedAt: 200 }),
      );
    });

    it.each([
      ['its preparation fails', 'prepare'],
      ['the server refuses its start', 'start'],
    ])('still stops a dropped generation after a retry where %s', async (_label, failure) => {
      const prepareRequest = jest.fn(() => ({ payload, messages: [userMessage, placeholder] }));
      const { chat, stream, transport } = setup({
        prepareRequest,
        resumeSelection: () => ({ endpoint: 'agents' }),
      });
      const sent = chat.sendMessage({ parts: [{ type: 'text', text: 'Hi' }] });
      await flush();
      stream.push({ type: 'error', status: 0, data: 'offline' } as ChatEvent);
      await sent;

      if (failure === 'prepare') {
        prepareRequest.mockImplementationOnce(() => {
          throw new Error('Preparation failed');
        });
      } else {
        transport.sendMessages.mockRejectedValueOnce(new Error('A run is already in progress'));
      }
      await chat.sendMessage({ parts: [{ type: 'text', text: 'Again' }] });
      expect(chat.status).toBe('error');

      await expect(chat.stop()).resolves.toEqual({ status: 'stopped' });
      expect(transport.abort).toHaveBeenCalledWith(
        expect.objectContaining({
          endpoint: 'agents',
          streamId: 'convo-1',
          generationCreatedAt: 100,
        }),
      );
    });

    it.each([
      ['still preparing', 'prepare', { status: 'stopped' }],
      ['sent but unanswered', 'start', { status: 'unaddressable' }],
    ])(
      'also stops a dropped generation when stopping its retry %s',
      async (_label, phase, expected) => {
        const prepareRequest = jest.fn((): ChatPreparedRequest | Promise<ChatPreparedRequest> => ({
          payload,
          messages: [userMessage, placeholder],
        }));
        const { chat, stream, transport } = setup({
          prepareRequest,
          resumeSelection: () => ({ endpoint: 'agents' }),
        });
        const sent = chat.sendMessage({ parts: [{ type: 'text', text: 'Hi' }] });
        await flush();
        stream.push({ type: 'error', status: 0, data: 'offline' } as ChatEvent);
        await sent;

        const pending = () => new Promise<never>(() => undefined);
        if (phase === 'prepare') {
          prepareRequest.mockImplementationOnce(pending);
        } else {
          transport.sendMessages.mockImplementationOnce(pending);
        }
        const retry = chat.sendMessage({ parts: [{ type: 'text', text: 'Again' }] });
        await flush();

        await expect(chat.stop()).resolves.toEqual(expected);
        await retry;
        expect(transport.abort).toHaveBeenCalledWith(
          expect.objectContaining({
            endpoint: 'agents',
            streamId: 'convo-1',
            generationCreatedAt: 100,
          }),
        );
      },
    );

    it('ignores a late status read restoring a pause whose generation was stopped', async () => {
      const { chat, stream } = setup({ resumeSelection: () => ({ endpoint: 'agents' }) });
      chat.restorePendingAction(pausedAction, 500);
      await expect(chat.stop()).resolves.toEqual({ status: 'stopped' });

      chat.restorePendingAction(pausedAction, 500);

      expect(chat.pendingAction).toBeUndefined();
      const sent = chat.sendMessage({ parts: [{ type: 'text', text: 'Next' }] });
      await flush();
      stream.push(finalEvent());
      await expect(sent).resolves.toBeUndefined();
    });

    it('ignores a late status read restoring a streamed pause of a stopped dropped generation', async () => {
      const { chat, stream, transport } = setup({
        resumeSelection: () => ({ endpoint: 'agents' }),
      });
      const sent = chat.sendMessage({ parts: [{ type: 'text', text: 'Hi' }] });
      await flush();
      stream.push({ type: 'pending_action', data: pausedAction });
      stream.push({ type: 'error', status: 0, data: 'offline' } as ChatEvent);
      await sent;
      await expect(chat.stop()).resolves.toEqual({ status: 'stopped' });

      chat.restorePendingAction(pausedAction, 100);

      expect(chat.pendingAction).toBeUndefined();
      const next = createStream({ streamId: 'convo-1', generationCreatedAt: 200 });
      transport.sendMessages.mockResolvedValueOnce({ status: 'stream', stream: next });
      const again = chat.sendMessage({ parts: [{ type: 'text', text: 'Next' }] });
      await flush();
      next.push(finalEvent());
      await expect(again).resolves.toBeUndefined();
    });

    it('answers a first-turn pause under the conversation its sync frame assigned', async () => {
      const { chat, stream, transport } = setup({ id: 'new' });
      void chat.sendMessage({ parts: [{ type: 'text', text: 'Hi' }] });
      await flush();
      stream.push({
        type: 'sync',
        data: { conversationId: 'convo-9', responseMessage: placeholder },
      } as ChatEvent);
      stream.push({ type: 'pending_action', data: pausedAction });
      await flush();

      await chat.addToolOutput({ toolCallId: 'ask-5', output: 'Blue' });

      expect(transport.resume).toHaveBeenCalledWith(
        expect.objectContaining({ conversationId: 'convo-9', actionId: 'action-5' }),
      );
    });

    it('still stops a dropped generation after a retry rejected as an unnegotiated replacement', async () => {
      const { chat, stream, transport } = setup({
        resumeSelection: () => ({ endpoint: 'agents' }),
      });
      const sent = chat.sendMessage({ parts: [{ type: 'text', text: 'Hi' }] });
      await flush();
      stream.push({ type: 'error', status: 0, data: 'offline' } as ChatEvent);
      await sent;
      transport.sendMessages.mockResolvedValueOnce({
        status: 'replaced',
        streamId: 'stream-2',
        conversationId: 'convo-1',
      } as Awaited<ReturnType<ChatTransport['sendMessages']>>);

      await chat.sendMessage({ parts: [{ type: 'text', text: 'Again' }] });
      expect(chat.status).toBe('error');

      await expect(chat.stop()).resolves.toEqual({ status: 'stopped' });
      expect(transport.abort).toHaveBeenCalledWith(
        expect.objectContaining({ streamId: 'convo-1', generationCreatedAt: 100 }),
      );
    });

    it('does not let an older stop of a dropped Assistants run overwrite a retry in flight', async () => {
      const stream = createStream();
      const prepareRequest = jest.fn(
        (): ChatPreparedRequest => ({
          payload: { endpoint: 'assistants', conversationId: 'convo-1', text: 'Hi' } as TPayload,
          messages: [userMessage, placeholder],
          responseMessageId: 'response-1',
        }),
      );
      const { chat, transport } = setup(
        { prepareRequest },
        { sendMessages: jest.fn(async () => ({ status: 'stream' as const, stream })) },
      );
      const sent = chat.sendMessage({ parts: [{ type: 'text', text: 'Hi' }] });
      await flush();
      stream.push({ type: 'error', status: 0, data: 'offline' } as ChatEvent);
      await sent;

      let answer: (result: ChatAbortResult) => void = () => undefined;
      transport.abort.mockImplementationOnce(
        () =>
          new Promise<ChatAbortResult>((resolve) => {
            answer = resolve;
          }),
      );
      const stopped = chat.stop();
      await flush();
      const retry: TMessage = { ...placeholder, messageId: 'response-2' };
      transport.sendMessages.mockImplementationOnce(() => new Promise(() => undefined));
      prepareRequest.mockImplementationOnce(() => ({
        payload: { endpoint: 'assistants', conversationId: 'convo-1', text: 'Again' } as TPayload,
        messages: [userMessage, retry],
        responseMessageId: 'response-2',
      }));
      void chat.sendMessage({ parts: [{ type: 'text', text: 'Again' }] });
      await flush();

      answer({ final: true, conversation: {}, runMessages: [userMessage, placeholder] });
      await stopped;

      expect(chat.messages).toEqual([userMessage, retry]);
      expect(chat.status).toBe('submitted');
    });

    it('stops a legacy first turn by the conversation its created frame named', async () => {
      const stream = createStream();
      const { chat, transport } = setup(
        {
          id: 'new',
          prepareRequest: jest.fn(() => ({
            payload: { ...payload, conversationId: 'new' },
            messages: [userMessage, placeholder],
            responseMessageId: 'response-1',
          })),
        },
        { sendMessages: jest.fn(async () => ({ status: 'stream' as const, stream })) },
      );
      transport.abort.mockImplementation(async () => {
        stream.push({ type: 'abort', data: {} } as ChatEvent);
        return { success: true };
      });
      const sent = chat.sendMessage({ parts: [{ type: 'text', text: 'Hi' }] });
      await flush();
      stream.push({
        type: 'created',
        data: { created: true, message: { ...userMessage, conversationId: 'convo-9' } },
      } as ChatEvent);
      await flush();

      await expect(chat.stop()).resolves.toEqual({ status: 'stopped' });
      await sent;
      expect(transport.abort).toHaveBeenCalledWith(
        expect.objectContaining({ abortKey: 'convo-9:response-1' }),
      );
    });

    it('keeps the stop target of a dropped generation when a stale pause of a stopped one is read', async () => {
      const { chat, stream, transport } = setup({
        resumeSelection: () => ({ endpoint: 'agents' }),
      });
      chat.restorePendingAction(pausedAction, 500);
      await chat.stop();
      const sent = chat.sendMessage({ parts: [{ type: 'text', text: 'Hi' }] });
      await flush();
      stream.push({ type: 'error', status: 0, data: 'offline' } as ChatEvent);
      await sent;

      chat.restorePendingAction(pausedAction, 500);

      await expect(chat.stop()).resolves.toEqual({ status: 'stopped' });
      expect(transport.abort).toHaveBeenLastCalledWith(
        expect.objectContaining({ streamId: 'convo-1', generationCreatedAt: 100 }),
      );
    });

    it('reports the response of a resumed generation no frame named as unknown', async () => {
      const resumed = createStream({ streamId: 'convo-1', generationCreatedAt: 300 });
      const { chat, state, transport, onFinish } = setup({
        resumeSelection: () => ({ endpoint: 'agents' }),
      });
      state.replaceMessages([userMessage, { ...placeholder, messageId: 'other-branch' }]);
      transport.reconnectToStream.mockResolvedValueOnce(resumed);

      const attached = chat.resumeStream({ streamId: 'convo-1', generationCreatedAt: 300 });
      await flush();
      resumed.push({ type: 'abort', data: {} } as ChatEvent);
      await attached;

      expect(onFinish).toHaveBeenLastCalledWith(
        expect.objectContaining({ isAbort: true, isResponseUnknown: true, message: undefined }),
      );
    });

    it('sends one stop for a generation stopped again once a reattachment took it over', async () => {
      const { chat, stream, transport } = setup({
        resumeSelection: () => ({ endpoint: 'agents' }),
      });
      const sent = chat.sendMessage({ parts: [{ type: 'text', text: 'Hi' }] });
      await flush();
      stream.push({ type: 'error', status: 0, data: 'offline' } as ChatEvent);
      await sent;

      let answer: (result: ChatAbortResult) => void = () => undefined;
      transport.abort.mockImplementationOnce(
        () =>
          new Promise<ChatAbortResult>((resolve) => {
            answer = resolve;
          }),
      );
      const first = chat.stop();
      await flush();
      const reattached = createStream({ streamId: 'convo-1', generationCreatedAt: 100 });
      transport.reconnectToStream.mockResolvedValueOnce(reattached);
      const resumed = chat.resumeStream({ streamId: 'convo-1', generationCreatedAt: 100 });
      await flush();
      const second = chat.stop();
      await flush();

      answer({ success: true });
      await flush();
      reattached.push({ type: 'abort', data: {} } as ChatEvent);
      await resumed;

      await expect(Promise.all([first, second])).resolves.toEqual([
        { status: 'stopped' },
        { status: 'stopped' },
      ]);
      expect(transport.abort).toHaveBeenCalledTimes(1);
      expect(chat.status).toBe('ready');
    });

    it('ends a retry that replaced a dropped generation with the unsaved stop sent for it', async () => {
      let answer: ((result: ChatAbortResult) => void) | undefined;
      let reconnect: ((stream: ChatStream | null) => void) | undefined;
      const { chat, stream, transport, onFinish } = setup(
        {},
        {
          abort: jest.fn(
            () =>
              new Promise<ChatAbortResult>((resolve) => {
                answer = resolve;
              }),
          ),
          reconnectToStream: jest.fn(
            () =>
              new Promise<ChatStream | null>((resolve) => {
                reconnect = resolve;
              }),
          ),
        },
      );
      const sent = chat.sendMessage({ parts: [{ type: 'text', text: 'Hi' }] });
      await flush();
      stream.push({ type: 'error', status: 0, data: 'offline' } as ChatEvent);
      await sent;

      const stopped = chat.stop();
      await flush();
      transport.sendMessages.mockResolvedValueOnce({
        status: 'replaced',
        generationProtocolVersion: 2,
        conversationId: 'convo-1',
        streamId: 'convo-1',
        generationCreatedAt: 100,
      });
      const retry = chat.sendMessage({ parts: [{ type: 'text', text: 'Hi' }] });
      await flush();
      answer?.({ success: true, persistenceFailed: true });
      await flush();
      reconnect?.(null);
      await Promise.all([stopped, retry]);

      expect(transport.abort).toHaveBeenCalledTimes(1);
      expect(onFinish).toHaveBeenLastCalledWith(
        expect.objectContaining({ isAbort: true, reconcileReason: 'abort_persistence_failed' }),
      );
    });

    it('ignores a late status read for any generation a stop ended, not only the latest', async () => {
      const { chat, transport } = setup({ resumeSelection: () => ({ endpoint: 'agents' }) });
      const older = { ...pausedAction, streamId: 'convo-1' };
      const newer = { ...older, actionId: 'action-6' };

      chat.restorePendingAction(older, 500);
      await chat.stop();
      chat.restorePendingAction(newer, 600);
      await chat.stop();
      chat.restorePendingAction(older, 500);

      expect(transport.abort).toHaveBeenCalledTimes(2);
      expect(chat.pendingAction).toBeUndefined();
    });

    it('reports a cancelled start the server may still run as a disconnect, not an abort', async () => {
      const { chat, onFinish } = setup(
        {},
        { sendMessages: jest.fn(() => new Promise<never>(() => undefined)) },
      );
      const sent = chat.sendMessage({ parts: [{ type: 'text', text: 'Hi' }] });
      await flush();

      await expect(chat.stop()).resolves.toEqual({ status: 'unaddressable' });
      await sent;

      expect(onFinish).toHaveBeenCalledTimes(1);
      expect(onFinish).toHaveBeenCalledWith(
        expect.objectContaining({ isAbort: false, isDisconnect: true }),
      );
      expect(chat.status).toBe('error');
      await expect(chat.stop()).resolves.toEqual({ status: 'unaddressable' });
    });

    it('answers a pause on a reattached stream by the dropped generation it continued', async () => {
      const reattached = createStream({ streamId: 'convo-1' });
      const { chat, stream, transport } = setup(
        { resumeSelection: () => ({ endpoint: 'agents' }) },
        { reconnectToStream: jest.fn(async () => reattached) },
      );
      const sent = chat.sendMessage({ parts: [{ type: 'text', text: 'Hi' }] });
      await flush();
      stream.push({ type: 'error', status: 0, data: 'offline' } as ChatEvent);
      await sent;

      const resumed = chat.resumeStream();
      await flush();
      reattached.push({ type: 'pending_action', data: { ...pausedAction, streamId: 'convo-1' } });
      await flush();
      await chat.addToolOutput({ toolCallId: 'ask-5', output: 'Blue' });
      reattached.push(finalEvent());
      await resumed;

      expect(transport.resume).toHaveBeenCalledWith(
        expect.objectContaining({ actionId: 'action-5', generationCreatedAt: 100 }),
      );
    });

    it('reports the stored tail when a local turn without a named response reattaches', async () => {
      const reattached = createStream({ streamId: 'convo-1', generationCreatedAt: 100 });
      const { chat, stream, onFinish } = setup(
        { resumeSelection: () => ({ endpoint: 'agents' }) },
        { reconnectToStream: jest.fn(async () => reattached) },
      );
      const sent = chat.sendMessage({ parts: [{ type: 'text', text: 'Hi' }] });
      await flush();
      stream.push({ type: 'error', status: 0, data: 'offline' } as ChatEvent);
      await sent;

      const resumed = chat.resumeStream();
      await flush();
      reattached.push({ type: 'abort', data: {} } as ChatEvent);
      await resumed;

      expect(onFinish).toHaveBeenLastCalledWith(
        expect.objectContaining({
          isAbort: true,
          isResponseUnknown: false,
          message: expect.objectContaining({ messageId: 'response-1' }),
        }),
      );
    });

    it('keeps a lost start unaddressable when a retry fails before the server takes it', async () => {
      const failure = Object.assign(new Error('Network Error'), { code: 'ERR_NETWORK' });
      const prepareRequest = jest.fn(() => ({ payload, messages: [userMessage, placeholder] }));
      const { chat, transport } = setup({ prepareRequest });
      transport.sendMessages.mockRejectedValueOnce(failure);
      await chat.sendMessage({ parts: [{ type: 'text', text: 'Hi' }] });

      prepareRequest.mockImplementationOnce(() => {
        throw new Error('prepare failed');
      });
      await chat.sendMessage({ parts: [{ type: 'text', text: 'Hi' }] });

      await expect(chat.stop()).resolves.toEqual({ status: 'unaddressable' });
    });

    it('keeps a lost start unaddressable when its retry is stopped while preparing', async () => {
      const failure = Object.assign(new Error('Network Error'), { code: 'ERR_NETWORK' });
      const prepareRequest = jest.fn((): ChatPreparedRequest | Promise<ChatPreparedRequest> => ({
        payload,
        messages: [userMessage, placeholder],
      }));
      const { chat, transport } = setup({ prepareRequest });
      transport.sendMessages.mockRejectedValueOnce(failure);
      await chat.sendMessage({ parts: [{ type: 'text', text: 'Hi' }] });

      prepareRequest.mockImplementationOnce(() => new Promise<never>(() => undefined));
      const retry = chat.sendMessage({ parts: [{ type: 'text', text: 'Again' }] });
      await flush();

      await expect(chat.stop()).resolves.toEqual({ status: 'unaddressable' });
      await retry;
    });

    it('keeps a generation stoppable when the host fails to apply one of its frames', async () => {
      const applyEvent = jest.fn((event: ChatEvent) => {
        if (event.type === 'step') {
          throw new Error('apply failed');
        }
      });
      const { chat, stream, transport, onFinish } = setup({
        applyEvent,
        resumeSelection: () => ({ endpoint: 'agents' }),
      });
      const sent = chat.sendMessage({ parts: [{ type: 'text', text: 'Hi' }] });
      await flush();
      stream.push(stepEvent);
      await sent;

      expect(stream.closed()).toBe(true);
      expect(onFinish).toHaveBeenLastCalledWith(expect.objectContaining({ isDisconnect: true }));
      await expect(chat.stop()).resolves.toEqual({ status: 'stopped' });
      expect(transport.abort).toHaveBeenCalledWith(
        expect.objectContaining({ streamId: 'convo-1', generationCreatedAt: 100 }),
      );
    });

    it('ends a turn by its terminal frame when the host fails to apply it', async () => {
      const applyEvent = jest.fn((event: ChatEvent) => {
        if (event.type === 'final') {
          throw new Error('apply failed');
        }
      });
      const { chat, stream, transport, onFinish } = setup({
        applyEvent,
        resumeSelection: () => ({ endpoint: 'agents' }),
      });
      const sent = chat.sendMessage({ parts: [{ type: 'text', text: 'Hi' }] });
      await flush();
      stream.push(finalEvent());
      await sent;

      expect(onFinish).toHaveBeenLastCalledWith(
        expect.objectContaining({ isError: true, isDisconnect: false, isSettled: true }),
      );
      await expect(chat.stop()).resolves.toEqual({ status: 'idle' });
      expect(transport.abort).not.toHaveBeenCalled();
    });

    it('keeps a lost start unaddressable when a reattachment fails before the server answers', async () => {
      const failure = () => Object.assign(new Error('Network Error'), { code: 'ERR_NETWORK' });
      const { chat, transport } = setup();
      transport.sendMessages.mockRejectedValueOnce(failure());
      await chat.sendMessage({ parts: [{ type: 'text', text: 'Hi' }] });

      transport.reconnectToStream.mockRejectedValueOnce(failure());
      await chat.resumeStream();

      await expect(chat.stop()).resolves.toEqual({ status: 'unaddressable' });
    });

    it('ends a retry the server attached to the dropped generation by the stop in flight for it', async () => {
      let answer: ((result: ChatAbortResult) => void) | undefined;
      const { chat, stream, transport, onFinish } = setup();
      transport.abort.mockImplementation(
        () =>
          new Promise<ChatAbortResult>((resolve) => {
            answer = resolve;
          }),
      );
      const sent = chat.sendMessage({ parts: [{ type: 'text', text: 'Hi' }] });
      await flush();
      stream.push({ type: 'error', status: 0, data: 'offline' } as ChatEvent);
      await sent;
      const stopped = chat.stop();
      await flush();

      const attached = createStream({ streamId: 'convo-1', generationCreatedAt: 100 });
      transport.sendMessages.mockResolvedValueOnce({ status: 'stream', stream: attached });
      const retry = chat.sendMessage({ parts: [{ type: 'text', text: 'Again' }] });
      await flush();
      answer?.({ success: true });
      await flush();
      attached.close();
      await expect(stopped).resolves.toEqual({ status: 'stopped' });
      await retry;

      expect(onFinish).toHaveBeenLastCalledWith(
        expect.objectContaining({ isAbort: true, isDisconnect: false }),
      );
    });

    it('undoes the optimistic rows of a retry the server attached to the dropped generation', async () => {
      const retryUser: TMessage = { ...userMessage, messageId: 'user-2', text: 'Again' };
      const retryResponse: TMessage = {
        ...placeholder,
        messageId: 'response-2',
        parentMessageId: 'user-2',
      };
      const prepareRequest = jest.fn(() => ({
        payload,
        messages: (current: TMessage[]) => [...current, userMessage, placeholder],
      }));
      const { chat, stream, transport } = setup({ prepareRequest });
      const sent = chat.sendMessage({ parts: [{ type: 'text', text: 'Hi' }] });
      await flush();
      stream.push({ type: 'error', status: 0, data: 'offline' } as ChatEvent);
      await sent;

      const attached = createStream({ streamId: 'convo-1', generationCreatedAt: 100 });
      let attachedWith: string[] = [];
      transport.sendMessages.mockImplementationOnce(async () => {
        await flush();
        return { status: 'stream', stream: attached };
      });
      prepareRequest.mockImplementationOnce(() => ({
        payload,
        messages: (current: TMessage[]) => [...current, retryUser, retryResponse],
      }));
      const retry = chat.sendMessage({ parts: [{ type: 'text', text: 'Again' }] });
      await flush();
      await flush();
      attachedWith = chat.messages.map((message) => message.messageId);
      attached.push(finalEvent());
      await retry;

      expect(attachedWith).toEqual(['user-1', 'response-1']);
      expect(chat.messages.map((message) => message.messageId)).toEqual(['user-1', 'response-1']);
    });

    it('ignores a late status read for a generation whose own stream ended it', async () => {
      const { chat, stream } = setup();
      const sent = chat.sendMessage({ parts: [{ type: 'text', text: 'Hi' }] });
      await flush();
      stream.push(finalEvent());
      await sent;

      chat.restorePendingAction({ ...pausedAction, expiresAt: Date.now() + 60_000 }, 100);

      expect(chat.pendingAction).toBeUndefined();
    });

    it('ignores a late status read for a generation a reattachment found finished', async () => {
      const { chat, stream, transport } = setup({
        resumeSelection: () => ({ endpoint: 'agents' }),
      });
      const sent = chat.sendMessage({ parts: [{ type: 'text', text: 'Hi' }] });
      await flush();
      stream.push({ type: 'error', status: 0, data: 'offline' } as ChatEvent);
      await sent;
      transport.reconnectToStream.mockResolvedValueOnce(null);
      await chat.resumeStream();

      chat.restorePendingAction({ ...pausedAction, expiresAt: Date.now() + 60_000 }, 100);

      expect(chat.pendingAction).toBeUndefined();
    });

    it('reports a lost start stopped once its late stream was stopped on the server', async () => {
      let deliver: ((result: { status: 'stream'; stream: ChatStream }) => void) | undefined;
      const late = createStream({ streamId: 'convo-1', generationCreatedAt: 300 });
      const { chat, transport } = setup();
      transport.sendMessages.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            deliver = resolve;
          }),
      );
      const sent = chat.sendMessage({ parts: [{ type: 'text', text: 'Hi' }] });
      await flush();
      await expect(chat.stop()).resolves.toEqual({ status: 'unaddressable' });
      await sent;

      deliver?.({ status: 'stream', stream: late });
      await flush();

      expect(transport.abort).toHaveBeenCalledWith(
        expect.objectContaining({ generationCreatedAt: 300 }),
      );
      await expect(chat.stop()).resolves.toEqual({ status: 'idle' });
    });

    it('keeps a dropped generation stoppable through a late status read of a stopped one', async () => {
      const { chat, stream, transport } = setup({
        resumeSelection: () => ({ endpoint: 'agents' }),
      });
      chat.restorePendingAction(pausedAction, 50);
      await expect(chat.stop()).resolves.toEqual({ status: 'stopped' });
      const sent = chat.sendMessage({ parts: [{ type: 'text', text: 'Hi' }] });
      await flush();
      stream.push({ type: 'error', status: 0, data: 'offline' } as ChatEvent);
      await sent;
      transport.abort.mockClear();

      chat.restorePendingAction({ ...pausedAction, expiresAt: Date.now() + 60_000 }, 50);

      expect(chat.pendingAction).toBeUndefined();
      await expect(chat.stop()).resolves.toEqual({ status: 'stopped' });
      expect(transport.abort).toHaveBeenCalledWith(
        expect.objectContaining({ streamId: 'convo-1', generationCreatedAt: 100 }),
      );
    });

    it('reports the response of a restored pause a stop found already gone as unknown', async () => {
      const { chat, state, transport, onFinish } = setup({
        resumeSelection: () => ({ endpoint: 'assistants' }),
      });
      state.replaceMessages([userMessage, { ...placeholder, messageId: 'other-branch' }]);
      transport.abort.mockResolvedValue(null);
      chat.restorePendingAction({ ...pausedAction, expiresAt: Date.now() + 60_000 }, 500);

      await expect(chat.stop()).resolves.toEqual({ status: 'stopped' });

      expect(onFinish).toHaveBeenLastCalledWith(
        expect.objectContaining({ isSettled: true, isResponseUnknown: true, message: undefined }),
      );
    });

    it('settles a named reattachment that finds its generation already finished', async () => {
      const { chat, transport, onFinish } = setup({
        resumeSelection: () => ({ endpoint: 'agents' }),
      });
      transport.reconnectToStream.mockResolvedValue(null);

      await chat.resumeStream();
      expect(onFinish).not.toHaveBeenCalled();

      await chat.resumeStream({ streamId: 'convo-1', generationCreatedAt: 300 });
      expect(onFinish).toHaveBeenCalledTimes(1);
      expect(onFinish).toHaveBeenCalledWith(expect.objectContaining({ isSettled: true }));
    });

    it('ignores a late status read for a late start a stop already ended', async () => {
      let deliver: ((result: { status: 'stream'; stream: ChatStream }) => void) | undefined;
      const late = createStream({ streamId: 'convo-1', generationCreatedAt: 300 });
      const { chat, transport } = setup();
      transport.sendMessages.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            deliver = resolve;
          }),
      );
      const sent = chat.sendMessage({ parts: [{ type: 'text', text: 'Hi' }] });
      await flush();
      await chat.stop();
      await sent;
      deliver?.({ status: 'stream', stream: late });
      await flush();
      expect(transport.abort).toHaveBeenCalledWith(
        expect.objectContaining({ generationCreatedAt: 300 }),
      );

      chat.restorePendingAction({ ...pausedAction, expiresAt: Date.now() + 60_000 }, 300);

      expect(chat.pendingAction).toBeUndefined();
    });
  });

  describe('ids a turn reports', () => {
    it('opens no reattachment a listener disposed the chat from on its reconnecting notice', async () => {
      const { chat, transport } = setup();
      chat.subscribe(() => {
        if (chat.connection === 'reconnecting') {
          chat.dispose();
        }
      });

      await chat.resumeStream({ streamId: 'convo-1' }).catch(() => undefined);

      expect(transport.reconnectToStream).not.toHaveBeenCalled();
    });

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

    it.each([
      ['a content frame', stepEvent],
      [
        'a pause',
        {
          type: 'pending_action',
          data: {
            actionId: 'action-1',
            streamId: 'convo-1',
            conversationId: 'convo-1',
            createdAt: 1,
            expiresAt: Date.now() + 60_000,
            payload: {
              type: 'ask_user_question',
              question: { question: 'Which?' },
              tool_call_id: 'a',
            },
          } as Agents.PendingAction,
        } as ChatEvent,
      ],
    ])(
      'stops %s when a listener disposes the chat on the streaming status',
      async (_label, event) => {
        const { chat, stream, onEvent } = setup();
        chat.subscribe(() => {
          if (chat.status === 'streaming') {
            chat.dispose();
          }
        });
        const sent = chat.sendMessage({ parts: [{ type: 'text', text: 'Hi' }] });
        await flush();
        stream.push(event);
        await sent;

        expect(onEvent).not.toHaveBeenCalled();
      },
    );

    it('settles an unframed stop under the chat, not under the stream id the answer names', async () => {
      const { chat, stream, transport, onFinish } = setup();
      transport.abort.mockResolvedValue({
        success: true,
        generationProtocolVersion: 2,
        aborted: 'stream-9',
        persistenceFailed: true,
      });
      const sent = chat.sendMessage({ parts: [{ type: 'text', text: 'Hi' }] });
      await flush();
      stream.push({ type: 'error', status: 0, data: 'offline' } as ChatEvent);
      await sent;

      await expect(chat.stop()).resolves.toEqual({ status: 'stopped', conversationId: 'convo-1' });

      expect(onFinish).toHaveBeenLastCalledWith(
        expect.objectContaining({
          isSettled: true,
          conversationId: 'convo-1',
          reconcileReason: 'abort_persistence_failed',
        }),
      );
    });

    it('reports no response for a turn whose optimistic write failed', async () => {
      const earlier: TMessage = {
        ...placeholder,
        messageId: 'earlier-1',
        parentMessageId: null,
        text: 'Earlier',
      };
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
      const earlier: TMessage = {
        ...placeholder,
        messageId: 'earlier-1',
        parentMessageId: null,
        text: 'Earlier',
      };
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

    it('reports no response for a turn stopped before its preparation finished', async () => {
      const earlier: TMessage = { ...placeholder, messageId: 'earlier-1', text: 'Earlier' };
      const { chat, onFinish } = setup({
        state: createState([userMessage, earlier]),
        prepareRequest: jest.fn(() => new Promise<never>(() => undefined)),
      });
      const sent = chat.sendMessage({ parts: [{ type: 'text', text: 'Hi' }] });
      await flush();

      await expect(chat.stop()).resolves.toEqual({ status: 'stopped' });
      await sent.catch(() => undefined);

      expect(onFinish).toHaveBeenCalledWith(
        expect.objectContaining({ isAbort: true, message: undefined }),
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
    const earlier: TMessage = {
      ...placeholder,
      messageId: 'earlier-1',
      parentMessageId: null,
      text: 'Earlier',
    };
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
        { ...placeholder, messageId: 'earlier-1', parentMessageId: null, text: 'Earlier' },
        { ...placeholder, messageId: 'earlier-2', parentMessageId: 'earlier-1', text: 'Answer' },
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
      const earlier: TMessage = {
        ...placeholder,
        messageId: 'earlier-1',
        parentMessageId: null,
        text: 'Earlier',
      };
      const external: TMessage = {
        ...placeholder,
        messageId: 'external-1',
        parentMessageId: 'earlier-1',
        text: 'External',
      };
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
      { ...userMessage, messageId: 'earlier-1', parentMessageId: null, text: 'Earlier' },
      { ...placeholder, messageId: 'earlier-2', parentMessageId: 'earlier-1', text: 'Answer' },
    ];
    const turnUser: TMessage = { ...userMessage, parentMessageId: 'earlier-2' };
    const external: TMessage = {
      ...placeholder,
      messageId: 'external-1',
      parentMessageId: 'earlier-2',
      text: 'External',
    };
    /** Overwrites `earlier-2` and appends the turn, so the write both replaces and adds rows. */
    const optimistic = (current: TMessage[]) => [
      ...current.map((m) => (m.messageId === 'earlier-2' ? { ...m, text: '' } : m)),
      turnUser,
      placeholder,
    ];
    type Node = TMessage & { children?: Node[] };
    /** The tree `buildTree` files the list as: one id path per root, depth first. */
    const chains = (messages: TMessage[]) => {
      const walk = (node: Node): string[] => [
        node.messageId,
        ...(node.children ?? []).flatMap((child) => walk(child)),
      ];
      return ((buildTree({ messages }) ?? []) as Node[]).map((root) => walk(root));
    };
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

    /** Edits the turn's response and the row it overwrote, as another writer of the store would. */
    const editTurn = (current: TMessage[]) =>
      current.map((m) =>
        m.messageId === placeholder.messageId || m.messageId === 'earlier-2'
          ? { ...m, text: 'Edited' }
          : m,
      );

    it.each([
      [
        'by a store subscriber inside the write, over a store that reports writes synchronously',
        false,
        true,
      ],
      ['by a store subscriber inside the write, over a structurally shared store', true, true],
      ['by the host after the write, over a store that reports writes synchronously', false, false],
      ['by the host after the write, over a structurally shared store', true, false],
    ])(
      'keeps an edited turn row and the turn rows above it when a replaced start rolls back, edited %s',
      async (_label, shared, inside) => {
        const state = createStore(shared);
        if (inside) {
          state.subscribe?.(() => {
            const current = state.messages;
            if (current.some((m) => m.messageId === placeholder.messageId && m.text === '')) {
              state.replaceMessages(editTurn(current));
            }
          });
        }
        const stream = createStream({ streamId: 'stream-2', generationCreatedAt: 200 });
        let attachedWith: TMessage[] = [];
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
              attachedWith = chat.messages;
              return stream;
            }),
          },
        );
        const sent = chat.sendMessage({ parts: [{ type: 'text', text: 'Hi' }] });
        await flush();
        if (!inside) {
          state.replaceMessages(editTurn(state.messages));
        }
        answer?.();
        await flush();
        stream.push(finalEvent({ requestMessage: null, responseMessage: null }));
        await sent;

        expect(rows(attachedWith)).toEqual([
          'earlier-1:Earlier',
          'earlier-2:Edited',
          'user-1:Hi',
          'response-1:Edited',
        ]);
        expect(chains(attachedWith)).toEqual([['earlier-1', 'earlier-2', 'user-1', 'response-1']]);
      },
    );

    it.each([
      ['over a store that reports writes synchronously', false],
      ['over a structurally shared store', true],
    ])(
      'keeps the turn rows above a row another writer appended under them when a replaced start rolls back, %s',
      async (_label, shared) => {
        const state = createStore(shared);
        const child: TMessage = {
          ...turnUser,
          messageId: 'child-1',
          parentMessageId: placeholder.messageId,
          text: 'Child',
        };
        const stream = createStream({ streamId: 'stream-2', generationCreatedAt: 200 });
        let attachedWith: TMessage[] = [];
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
              attachedWith = chat.messages;
              return stream;
            }),
          },
        );
        const sent = chat.sendMessage({ parts: [{ type: 'text', text: 'Hi' }] });
        await flush();
        state.replaceMessages([...state.messages, child]);
        answer?.();
        await flush();
        stream.push(finalEvent({ requestMessage: null, responseMessage: null }));
        await sent;

        expect(rows(attachedWith)).toEqual([
          'earlier-1:Earlier',
          'earlier-2:Answer',
          'user-1:Hi',
          'response-1:',
          'child-1:Child',
        ]);
        expect(chains(attachedWith)).toEqual([
          ['earlier-1', 'earlier-2', 'user-1', 'response-1', 'child-1'],
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

    it.each([
      ['over a store that reports writes synchronously', false],
      ['over a structurally shared store', true],
    ])(
      'keeps a row a store subscriber appended inside the write of a retry the server answered with the dropped generation, %s',
      async (_label, shared) => {
        const state = createStore(shared);
        const retryUser: TMessage = { ...userMessage, messageId: 'user-2', text: 'Again' };
        const retryResponse: TMessage = {
          ...placeholder,
          messageId: 'response-2',
          parentMessageId: 'user-2',
        };
        state.subscribe?.(() => {
          const current = state.messages;
          if (
            current.some((m) => m.messageId === retryResponse.messageId) &&
            !current.some((m) => m.messageId === external.messageId)
          ) {
            state.replaceMessages([...current, external]);
          }
        });
        const first = createStream({ streamId: 'convo-1', generationCreatedAt: 100 });
        const reattached = createStream({ streamId: 'convo-1', generationCreatedAt: 100 });
        let attachedWith: string[] = [];
        const prepareRequest = jest
          .fn()
          .mockImplementationOnce(() => ({ payload, messages: optimistic }))
          .mockImplementationOnce(() => ({
            payload,
            messages: (current: TMessage[]) => [...current, retryUser, retryResponse],
          }));
        const { chat, transport } = setup(
          { state, prepareRequest },
          {
            sendMessages: jest.fn(async () => ({ status: 'stream' as const, stream: first })),
            reconnectToStream: jest.fn(async () => {
              attachedWith = rows(chat.messages);
              return reattached;
            }),
          },
        );
        const sent = chat.sendMessage({ parts: [{ type: 'text', text: 'Hi' }] });
        await flush();
        first.push({ type: 'error', status: 0, data: 'offline' } as ChatEvent);
        await sent;
        const before = rows(state.messages);

        transport.sendMessages.mockResolvedValueOnce({ ...replaced, generationCreatedAt: 100 });
        const retry = chat.sendMessage({ parts: [{ type: 'text', text: 'Again' }] });
        await flush();
        reattached.push(finalEvent({ requestMessage: null, responseMessage: null }));
        await retry;

        expect(attachedWith).toEqual([...before, 'external-1:External']);
      },
    );

    /** The rows an Assistants stop answer carries, which replace the list when the run ends. */
    const stored: TMessage[] = [userMessage, { ...placeholder, text: 'Stored' }];
    const storedAnswer = { final: true, conversation: {}, runMessages: stored };

    /** Starts a turn over `state` and stops it with an Assistants answer that carries its rows. */
    const stopWithRunMessages = async (state: ChatState) => {
      const stream = createStream({ streamId: 'convo-1', generationCreatedAt: 100 });
      const { chat, transport } = setup(
        { state, prepareRequest: jest.fn(() => ({ payload, messages: optimistic })) },
        {
          sendMessages: jest.fn(async () => ({ status: 'stream' as const, stream })),
          abort: jest.fn(async () => {
            stream.push(finalEvent({ terminalStatus: 'aborted' }));
            return storedAnswer;
          }) as unknown as ChatTransport['abort'],
        },
      );
      const sent = chat.sendMessage({ parts: [{ type: 'text', text: 'Hi' }] });
      await flush();
      stream.push(stepEvent);
      await flush();
      return { chat, transport, sent };
    };

    const isStored = (messages: TMessage[]) =>
      messages.some((m) => m.messageId === placeholder.messageId && m.text === 'Stored');

    it.each([
      ['over a store that reports writes synchronously', false],
      ['over a structurally shared store', true],
    ])(
      "keeps a row a store subscriber appended inside a stop's run-message merge, %s",
      async (_label, shared) => {
        const state = createStore(shared);
        state.subscribe?.(() => {
          const current = state.messages;
          if (isStored(current) && !current.some((m) => m.messageId === external.messageId)) {
            state.replaceMessages([...current, external]);
          }
        });
        const { chat, sent } = await stopWithRunMessages(state);

        await expect(chat.stop()).resolves.toEqual({ status: 'stopped' });
        await sent;

        expect(rows(state.messages)).toEqual([
          'user-1:Hi',
          'response-1:Stored',
          'external-1:External',
        ]);
      },
    );

    it.each([
      ['over a store that reports writes synchronously', false],
      ['over a structurally shared store', true],
    ])(
      "writes nothing more once a store subscriber disposes the chat inside a stop's run-message merge, %s",
      async (_label, shared) => {
        const state = createStore(shared) as ReturnType<typeof createState>;
        let atDispose: { statuses: number; connection: string; rows: string[] } | undefined;
        const { chat, sent } = await stopWithRunMessages(state);
        state.subscribe?.(() => {
          if (!atDispose && isStored(state.messages)) {
            chat.dispose();
            atDispose = {
              statuses: state.statuses.length,
              connection: state.connection,
              rows: rows(state.messages),
            };
          }
        });

        await chat.stop();
        await sent;
        await flush();

        expect(atDispose).toBeDefined();
        expect(state.statuses).toHaveLength(atDispose?.statuses ?? -1);
        expect(state.connection).toBe(atDispose?.connection);
        expect(rows(state.messages)).toEqual(atDispose?.rows);
      },
    );

    const toolCall = (id: string) => ({
      type: ContentTypes.TOOL_CALL,
      tool_call: {
        id,
        name: 'search',
        args: '{}',
        type: 'tool_call',
        approval: { actionId: 'action-1', allowed_decisions: ['approve', 'reject'] },
      },
    });
    const approval = {
      actionId: 'action-1',
      streamId: 'convo-1',
      conversationId: 'convo-1',
      createdAt: 1,
      payload: {
        type: 'tool_approval',
        action_requests: [{ name: 'search', arguments: '{}', tool_call_id: 'call-1' }],
        review_configs: [],
      },
    } as Agents.PendingAction;

    /** Starts a turn over `state` whose stream pauses for approval of `call-1`. */
    const pauseForApproval = async (state: ChatState) => {
      const stream = createStream({ streamId: 'convo-1', generationCreatedAt: 100 });
      const paused = setup(
        {
          state,
          resumeSelection: () => ({ endpoint: 'agents', agent_id: 'agent-1' }),
          prepareRequest: jest.fn(() => ({
            payload,
            messages: (current: TMessage[]) => [
              ...current,
              userMessage,
              { ...placeholder, content: [toolCall('call-1')] } as TMessage,
            ],
          })),
        },
        { sendMessages: jest.fn(async () => ({ status: 'stream' as const, stream })) },
      );
      const sent = paused.chat.sendMessage({ parts: [{ type: 'text', text: 'Hi' }] });
      await flush();
      stream.push({ type: 'pending_action', data: approval });
      await flush();
      return { ...paused, stream, sent };
    };

    const isDecided = (messages: TMessage[]) =>
      messages.some((m) => JSON.stringify(m.content ?? []).includes('"decision":"approve"'));

    it.each([
      ['over a store that reports writes synchronously', false],
      ['over a structurally shared store', true],
    ])(
      'keeps a row a store subscriber appended inside an approval write and resumes once, %s',
      async (_label, shared) => {
        const state = createStore(shared);
        const { chat, transport, stream, sent } = await pauseForApproval(state);
        state.subscribe?.(() => {
          const current = state.messages;
          if (isDecided(current) && !current.some((m) => m.messageId === external.messageId)) {
            state.replaceMessages([...current, external]);
          }
        });

        await chat.addToolApprovalResponse({ id: 'call-1', approved: true });

        expect(transport.resume).toHaveBeenCalledTimes(1);
        expect(state.messages.map((m) => m.messageId)).toContain(external.messageId);
        stream.push(finalEvent({ requestMessage: null, responseMessage: null }));
        await sent;
        expect(state.messages.map((m) => m.messageId)).toContain(external.messageId);
      },
    );

    it.each([
      ['over a store that reports writes synchronously', false],
      ['over a structurally shared store', true],
    ])(
      'sends no resume once a store subscriber disposes the chat inside an approval write, %s',
      async (_label, shared) => {
        const state = createStore(shared);
        const { chat, transport, sent } = await pauseForApproval(state);
        let disposed = false;
        state.subscribe?.(() => {
          if (!disposed && isDecided(state.messages)) {
            disposed = true;
            chat.dispose();
          }
        });

        await chat.addToolApprovalResponse({ id: 'call-1', approved: true }).catch(() => undefined);
        await sent;

        expect(disposed).toBe(true);
        expect(transport.resume).not.toHaveBeenCalled();
      },
    );
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
