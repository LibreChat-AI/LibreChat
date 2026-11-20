import type {
  TPayload,
  ChatEvent,
  TMessage,
  ChatTransportRequest,
  ChatStreamRequest,
  ChatTransport as WireTransport,
  ChatTransportOptions,
} from 'librechat-data-provider';
import type { ChatConnection, ChatStatus, ChatStreamStatus } from '../types';
import type { ChatState } from '../chat';
import { createGenerationTransport } from '../transport';
import { Chat } from '../chat';

type Attachment = {
  request: ChatStreamRequest;
  options: ChatTransportOptions;
  emit: (event: ChatEvent) => void;
};

/** A wire the test drives: every attachment is recorded, and its events are pushed by hand. */
function createWire(closed = false) {
  const attachments: Attachment[] = [];
  const wire: WireTransport = {
    send: () => undefined,
    reconnectToStream(request, options) {
      const attachment: Attachment = { request, options, emit: (event) => options.onEvent(event) };
      attachments.push(attachment);
      options.signal.addEventListener('abort', () => options.onEvent({ type: 'abort' }), {
        once: true,
      });
      return { closed };
    },
  };
  return { wire, attachments };
}

const running: ChatStreamStatus = {
  active: true,
  streamId: 'thread 1',
  status: 'running',
  createdAt: 2000,
  generationProtocolVersion: 2,
};

const setup = (status: ChatStreamStatus = running, wire = createWire()) => {
  const getStatus = jest.fn(async () => status);
  const transport = createGenerationTransport({ wire: () => wire.wire, getStatus });
  return { transport, getStatus, attachments: wire.attachments };
};

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

const drain = async (stream: AsyncIterable<ChatEvent>): Promise<ChatEvent[]> => {
  const events: ChatEvent[] = [];
  for await (const event of stream) {
    events.push(event);
  }
  return events;
};

const step = (text: string): ChatEvent =>
  ({ type: 'step', data: { event: 'on_message_delta', data: { text } } }) as unknown as ChatEvent;

const final: ChatEvent = {
  type: 'final',
  data: {
    final: true,
    conversation: { conversationId: 'thread 1' },
    requestMessage: {
      messageId: 'task:user',
      conversationId: 'thread 1',
      parentMessageId: null,
      isCreatedByUser: true,
      text: 'Go',
    },
    responseMessage: {
      messageId: 'task:assistant',
      conversationId: 'thread 1',
      parentMessageId: 'task:user',
      isCreatedByUser: false,
      text: 'Done',
    },
  },
} as unknown as ChatEvent;

describe('createGenerationTransport', () => {
  it('opens nothing and resolves null when the status route reports nothing running', async () => {
    const { transport, attachments } = setup({ active: false });

    await expect(transport.reconnectToStream({ chatId: 'thread 1' })).resolves.toBeNull();

    expect(attachments).toHaveLength(0);
  });

  it('attaches to the running generation, replayed from its start and fenced on its epoch', async () => {
    const { transport, getStatus, attachments } = setup();
    const opening = transport.reconnectToStream({ chatId: 'thread 1' });
    await flush();
    attachments[0].emit({ type: 'open' });
    const stream = await opening;

    expect(getStatus).toHaveBeenCalledWith('thread 1');
    const url = new URL(attachments[0].request.url, 'http://localhost');
    expect(url.pathname).toBe('/api/agents/chat/stream/thread%201');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      resume: 'true',
      generationCreatedAt: '2000',
      generationProtocolVersion: '2',
    });
    expect(attachments[0].request.headers).toEqual({ 'X-LibreChat-Generation-Protocol': '2' });
    expect(stream).toMatchObject({
      streamId: 'thread 1',
      generationCreatedAt: 2000,
      generationProtocolVersion: 2,
      resumed: true,
    });
  });

  it('names the generation found running before its stream opens, and none it does not attach to', async () => {
    const onGeneration = jest.fn();
    const { transport, attachments } = setup();
    const opening = transport.reconnectToStream({ chatId: 'thread 1', onGeneration });
    await flush();

    /** The stream has been asked for and has said nothing yet. */
    expect(attachments).toHaveLength(1);
    expect(onGeneration).toHaveBeenCalledTimes(1);
    expect(onGeneration).toHaveBeenCalledWith({
      streamId: 'thread 1',
      generationCreatedAt: 2000,
      generationProtocolVersion: 2,
    });
    attachments[0].emit({ type: 'open' });
    await opening;

    const idle = jest.fn();
    await setup({ active: false }).transport.reconnectToStream({
      chatId: 'thread 1',
      onGeneration: idle,
    });
    await setup().transport.reconnectToStream({
      chatId: 'thread 1',
      generationCreatedAt: 1000,
      onGeneration: idle,
    });
    expect(idle).not.toHaveBeenCalled();
  });

  it('yields the frames in wire order and ends with the final one', async () => {
    const { transport, attachments } = setup();
    const opening = transport.reconnectToStream({ chatId: 'thread 1' });
    await flush();
    attachments[0].emit({ type: 'open' });
    const stream = await opening;
    const reading = drain(stream!);

    attachments[0].emit(step('a'));
    attachments[0].emit(step('b'));
    await flush();
    attachments[0].emit(final);

    await expect(reading).resolves.toEqual([step('a'), step('b'), final]);
  });

  it('ends on a dropped connection with the error the wire reported', async () => {
    const { transport, attachments } = setup();
    const opening = transport.reconnectToStream({ chatId: 'thread 1' });
    await flush();
    attachments[0].emit({ type: 'open' });
    const stream = await opening;
    const reading = drain(stream!);

    attachments[0].emit(step('a'));
    attachments[0].emit({ type: 'error', status: 0 });

    await expect(reading).resolves.toEqual([step('a'), { type: 'error', status: 0 }]);
  });

  it.each([404, 409])(
    'resolves null when the generation is gone (%i) before attaching',
    async (status) => {
      const { transport, attachments } = setup();
      const opening = transport.reconnectToStream({ chatId: 'thread 1' });
      await flush();

      attachments[0].emit({ type: 'error', status });

      await expect(opening).resolves.toBeNull();
    },
  );

  it.each([
    [500, 'ERR_BAD_RESPONSE'],
    [0, 'ERR_NETWORK'],
  ])('rejects when the stream cannot be opened (%i)', async (status, code) => {
    const { transport, attachments } = setup();
    const opening = transport.reconnectToStream({ chatId: 'thread 1' });
    await flush();

    attachments[0].emit({ type: 'error', status, data: { message: 'private detail' } });

    await expect(opening).rejects.toMatchObject({ code, response: { status } });
  });

  it('resolves null without attaching when a different generation is the one running', async () => {
    const { transport, attachments } = setup();

    await expect(
      transport.reconnectToStream({ chatId: 'thread 1', generationCreatedAt: 1000 }),
    ).resolves.toBeNull();

    expect(attachments).toHaveLength(0);
  });

  it('closes the connection when the stream is closed, and ends the iteration', async () => {
    const { transport, attachments } = setup();
    const opening = transport.reconnectToStream({ chatId: 'thread 1' });
    await flush();
    attachments[0].emit({ type: 'open' });
    const stream = await opening;
    const reading = drain(stream!);

    stream!.close();

    expect(attachments[0].options.signal.aborted).toBe(true);
    await expect(reading).resolves.toEqual([{ type: 'abort' }]);
  });

  it("closes the connection when the caller's signal aborts", async () => {
    const { transport, attachments } = setup();
    const controller = new AbortController();
    const opening = transport.reconnectToStream({
      chatId: 'thread 1',
      abortSignal: controller.signal,
    });
    await flush();
    attachments[0].emit({ type: 'open' });
    await opening;

    controller.abort();

    expect(attachments[0].options.signal.aborted).toBe(true);
  });

  it('resolves null when the caller aborts an attachment whose wire reports nothing more', async () => {
    const attachments: Attachment[] = [];
    /** A wire mid token refresh: its connection is gone, and an abort draws no event from it. */
    const silent: WireTransport = {
      send: () => undefined,
      reconnectToStream(request, options) {
        attachments.push({ request, options, emit: (event) => options.onEvent(event) });
        return { closed: false };
      },
    };
    const transport = createGenerationTransport({
      wire: () => silent,
      getStatus: async () => running,
    });
    const caller = new AbortController();
    const settled = jest.fn();
    void transport
      .reconnectToStream({ chatId: 'thread 1', abortSignal: caller.signal })
      .then(settled);
    await flush();
    expect(attachments).toHaveLength(1);
    expect(settled).not.toHaveBeenCalled();

    caller.abort();
    await flush();

    expect(attachments[0].options.signal.aborted).toBe(true);
    expect(settled).toHaveBeenCalledWith(null);
  });

  it('refuses to send or stop when the app gave it no way to', async () => {
    const { transport } = setup();

    await expect(
      transport.sendMessages({
        trigger: 'submit-message',
        chatId: 'thread 1',
        payload: {} as never,
      }),
    ).rejects.toMatchObject({ code: 'ERR_VIEW_ONLY' });
    await expect(transport.abort({ chatId: 'thread 1', endpoint: 'agents' })).rejects.toMatchObject(
      { code: 'ERR_VIEW_ONLY' },
    );
  });

  it('passes a send and a stop through when the app supplies them', async () => {
    const sendMessages = jest.fn(async () => ({ status: 'settled' as const, conversationId: 'c' }));
    const abort = jest.fn(async () => ({ success: true }));
    const transport = createGenerationTransport({
      wire: () => createWire().wire,
      getStatus: async () => running,
      sendMessages,
      abort,
    });

    await transport.sendMessages({ trigger: 'submit-message', chatId: 'c', payload: {} as never });
    await transport.abort({ chatId: 'c', endpoint: 'agents' });

    expect(sendMessages).toHaveBeenCalledTimes(1);
    expect(abort).toHaveBeenCalledWith({ chatId: 'c', endpoint: 'agents' });
  });
});

describe('sending a turn', () => {
  const payload = {
    endpoint: 'agents',
    conversationId: 'thread 1',
    text: 'Go',
    isContinued: false,
    isTemporary: false,
    model: null,
  } as unknown as TPayload;
  const request = (overrides: object = {}) => ({
    trigger: 'submit-message' as const,
    chatId: 'thread 1',
    payload,
    ...overrides,
  });
  const sender = (start: jest.Mock, wire = createWire()) => ({
    transport: createGenerationTransport({
      wire: () => wire.wire,
      getStatus: async () => running,
      start,
    }),
    attachments: wire.attachments,
  });
  const started = { streamId: 'thread 1', conversationId: 'thread 1', generationCreatedAt: 3000 };

  it('posts the turn to its endpoint route and opens the stream of the generation it started', async () => {
    const start = jest.fn(async (_request: ChatTransportRequest) => started);
    const { transport, attachments } = sender(start);

    const sending = transport.sendMessages(request());
    await flush();
    attachments[0].emit({ type: 'open' });
    const result = await sending;

    expect(start).toHaveBeenCalledTimes(1);
    const [posted] = start.mock.calls[0];
    expect(posted.server).toMatch(/\/agents\/chat\/agents$/);
    /** Stripped of what it does not set, as main chat's start strips it. */
    expect(posted.payload).toMatchObject({ endpoint: 'agents', text: 'Go' });
    expect('model' in posted.payload).toBe(false);
    /** A turn this client started is read live, not replayed. */
    const url = new URL(attachments[0].request.url, 'http://localhost');
    expect(url.searchParams.get('resume')).not.toBe('true');
    expect(url.searchParams.get('generationCreatedAt')).toBe('3000');
    expect(result).toMatchObject({
      status: 'stream',
      stream: { streamId: 'thread 1', generationCreatedAt: 3000, resumed: false },
    });
  });

  it('names the generation as soon as the server has taken the turn, before its stream opens', async () => {
    const onGeneration = jest.fn();
    const { transport, attachments } = sender(
      jest.fn(async () => ({ ...started, generationProtocolVersion: 2 })),
    );

    const sending = transport.sendMessages(request({ onGeneration }));
    await flush();

    /** The stream has been asked for and has said nothing yet. */
    expect(attachments).toHaveLength(1);
    expect(onGeneration).toHaveBeenCalledTimes(1);
    expect(onGeneration).toHaveBeenCalledWith({
      streamId: 'thread 1',
      generationCreatedAt: 3000,
      generationProtocolVersion: 2,
    });

    attachments[0].emit({ type: 'open' });
    await sending;
    expect(onGeneration).toHaveBeenCalledTimes(1);
  });

  it('names no generation for a turn the server did not start one for', async () => {
    const v2 = { generationProtocolVersion: 2 };
    for (const answer of [
      { ...v2, status: 'settled', conversationId: 'thread 1' },
      { ...v2, ...started, status: 'replaced' },
    ]) {
      const onGeneration = jest.fn();
      const { transport } = sender(jest.fn(async () => answer));

      await transport.sendMessages(request({ onGeneration }));

      expect(onGeneration).not.toHaveBeenCalled();
    }
  });

  it('replays a start the server folded into a generation already running', async () => {
    const { transport, attachments } = sender(
      jest.fn(async () => ({ ...started, status: 'resumed' })),
    );

    const sending = transport.sendMessages(request());
    await flush();
    attachments[0].emit({ type: 'open' });
    const result = await sending;

    expect(new URL(attachments[0].request.url, 'http://localhost').searchParams.get('resume')).toBe(
      'true',
    );
    expect(result).toMatchObject({ status: 'stream', stream: { resumed: true } });
  });

  it('reports a turn the server had already run, and one a newer generation replaced', async () => {
    const v2 = { generationProtocolVersion: 2 };
    const settled = sender(
      jest.fn(async () => ({ ...v2, status: 'settled', conversationId: 'c' })),
    );
    await expect(settled.transport.sendMessages(request())).resolves.toMatchObject({
      status: 'settled',
      conversationId: 'c',
    });
    expect(settled.attachments).toHaveLength(0);

    const replaced = sender(jest.fn(async () => ({ ...v2, ...started, status: 'replaced' })));
    await expect(replaced.transport.sendMessages(request())).resolves.toMatchObject({
      status: 'replaced',
      conversationId: 'thread 1',
      streamId: 'thread 1',
      generationCreatedAt: 3000,
    });
    expect(replaced.attachments).toHaveLength(0);
  });

  it('refuses a start response that names no stream, or a control word it did not negotiate', async () => {
    const nameless = sender(jest.fn(async () => ({ conversationId: 'c' })));
    await expect(nameless.transport.sendMessages(request())).rejects.toMatchObject({
      code: 'ERR_BAD_RESPONSE',
    });
    const legacy = sender(jest.fn(async () => ({ ...started, status: 'settled' })));
    await expect(legacy.transport.sendMessages(request())).rejects.toMatchObject({
      code: 'ERR_BAD_RESPONSE',
    });
    expect(legacy.attachments).toHaveLength(0);
  });

  it('reports a generation whose stream will not open as one that dropped, by name', async () => {
    /**
     * Over already, replaced by a newer one, answered by a gateway instead of the server,
     * refused by something in between, unreachable, or a wire that closed: none says how the
     * turn ended, and none takes back the server's answer that it started.
     */
    for (const failure of [404, 409, 502, 429, 0, 'closed'] as const) {
      const wire = createWire(failure === 'closed');
      const { transport, attachments } = sender(
        jest.fn(async () => ({ ...started, generationProtocolVersion: 2 })),
        wire,
      );

      const sending = transport.sendMessages(request());
      await flush();
      if (failure !== 'closed') {
        attachments[0].emit({ type: 'error', status: failure });
      }
      const result = await sending;

      expect(result).toMatchObject({
        status: 'stream',
        stream: { streamId: 'thread 1', generationCreatedAt: 3000, generationProtocolVersion: 2 },
      });
      expect(result.status === 'stream' ? await drain(result.stream) : undefined).toEqual([]);
    }
  });

  it('posts again after a dropped connection, and gives up on an answer that is not one', async () => {
    jest.useFakeTimers();
    try {
      const offline = Object.assign(new Error('offline'), { code: 'ERR_NETWORK' });
      const start = jest.fn().mockRejectedValueOnce(offline).mockResolvedValueOnce(started);
      const { transport, attachments } = sender(start);
      const sending = transport.sendMessages(request());
      await jest.advanceTimersByTimeAsync(1000);
      attachments[0].emit({ type: 'open' });
      await expect(sending).resolves.toMatchObject({ status: 'stream' });
      expect(start).toHaveBeenCalledTimes(2);

      const refused = Object.assign(new Error('bad'), { response: { status: 400, data: {} } });
      const rejecting = sender(jest.fn().mockRejectedValue(refused));
      await expect(rejecting.transport.sendMessages(request())).rejects.toBe(refused);
    } finally {
      jest.useRealTimers();
    }
  });

  it('refuses a turn with no endpoint to send it to', async () => {
    const start = jest.fn();
    const { transport } = sender(start);

    await expect(
      transport.sendMessages(request({ payload: { ...payload, endpoint: undefined } })),
    ).rejects.toMatchObject({ code: 'ERR_BAD_REQUEST' });
    expect(start).not.toHaveBeenCalled();
  });
});

describe('a Chat following a generation through the transport', () => {
  const createState = (): ChatState & { messages: TMessage[] } => {
    let messages: TMessage[] = [];
    let status: ChatStatus = 'ready';
    return {
      error: undefined,
      connection: 'idle' as ChatConnection,
      get status() {
        return status;
      },
      set status(next: ChatStatus) {
        status = next;
      },
      get messages() {
        return messages;
      },
      replaceMessages(next) {
        messages = next;
      },
    };
  };

  const follow = (status: ChatStreamStatus = running) => {
    const wire = createWire();
    const state = createState();
    const applied: ChatEvent['type'][] = [];
    const chat = new Chat({
      id: 'thread 1',
      state,
      transport: createGenerationTransport({
        wire: () => wire.wire,
        getStatus: async () => status,
      }),
      prepareRequest: () => {
        throw new Error('view only');
      },
      onEvent: (event) => applied.push(event.type),
    });
    return { chat, state, applied, attachments: wire.attachments };
  };

  it('reattaches, reads the stream to its final frame and settles ready with the result', async () => {
    const { chat, state, applied, attachments } = follow();
    const resuming = chat.resumeStream();
    await flush();
    attachments[0].emit({ type: 'open' });
    await flush();

    attachments[0].emit(step('a'));
    attachments[0].emit(final);
    await resuming;

    expect(applied).toEqual(['step', 'final']);
    expect(chat.status).toBe('ready');
    expect(state.messages.map((message) => message.messageId)).toEqual([
      'task:user',
      'task:assistant',
    ]);
    chat.dispose();
  });

  it('stays ready and opens nothing when nothing is running', async () => {
    const { chat, attachments } = follow({ active: false });

    await chat.resumeStream();

    expect(attachments).toHaveLength(0);
    expect(chat.status).toBe('ready');
    chat.dispose();
  });
  const drive = (status: ChatStreamStatus) => {
    const wire = createWire();
    const state = createState();
    const finished: Array<{ isDisconnect: boolean; isSettled: boolean; isError: boolean }> = [];
    const abort = jest.fn(async () => ({ success: true }));
    const start = jest.fn(async () => ({
      streamId: 'thread 1',
      conversationId: 'thread 1',
      generationCreatedAt: 3000,
      generationProtocolVersion: 2,
    }));
    const chat = new Chat({
      id: 'thread 1',
      state,
      transport: createGenerationTransport({
        wire: () => wire.wire,
        getStatus: async () => status,
        start,
        abort,
      }),
      prepareRequest: () => ({
        payload: { endpoint: 'agents', conversationId: 'thread 1', text: 'Go' } as never,
      }),
      onFinish: ({ isDisconnect, isSettled, isError }) =>
        finished.push({ isDisconnect, isSettled, isError }),
    });
    return { chat, state, abort, finished, attachments: wire.attachments };
  };

  it('finds what became of a turn that was over before its stream opened', async () => {
    const { chat, finished, attachments } = drive({ active: false });

    const sending = chat.sendMessage({ parts: [{ type: 'text', text: 'Go' }] });
    await flush();
    attachments[0].emit({ type: 'error', status: 404 });
    await sending;

    /** The start says nothing of how the turn ended, so it is a dropped stream, not a failure. */
    expect(finished).toEqual([{ isDisconnect: true, isSettled: false, isError: true }]);

    /** Asking again finds nothing running, which settles the turn for the host to read back. */
    await chat.resumeStream();
    expect(finished[1]).toEqual({ isDisconnect: false, isSettled: true, isError: false });
    expect(chat.status).toBe('ready');
    expect(attachments).toHaveLength(1);
    chat.dispose();
  });

  it('follows a turn the server started whose stream a gateway answered instead', async () => {
    const { chat, state, finished, attachments } = drive({ ...running, createdAt: 3000 });

    const sending = chat.sendMessage({ parts: [{ type: 'text', text: 'Go' }] });
    await flush();
    attachments[0].emit({ type: 'error', status: 502, data: 'Bad Gateway' });
    await sending;

    /** The turn is running: what ended is its stream, which dropped. */
    expect(finished).toEqual([{ isDisconnect: true, isSettled: false, isError: true }]);

    /** Attached to again, it is read to its end like any other. */
    const resuming = chat.resumeStream();
    await flush();
    expect(attachments).toHaveLength(2);
    expect(attachments[1].request.url).toContain('generationCreatedAt=3000');
    attachments[1].emit({ type: 'open' });
    attachments[1].emit(final);
    await resuming;

    expect(finished[1]).toEqual({ isDisconnect: false, isSettled: false, isError: false });
    expect(chat.status).toBe('ready');
    expect(state.messages.map((message) => message.text)).toContain('Done');
    chat.dispose();
  });

  it('stops the generation a start began when the stop lands before its stream opens', async () => {
    const { chat, abort, attachments } = drive(running);

    const sending = chat.sendMessage({ parts: [{ type: 'text', text: 'Go' }] });
    await flush();
    expect(attachments).toHaveLength(1);
    const stopping = chat.stop();
    await sending;
    await stopping;
    await flush();

    expect(abort).toHaveBeenCalledTimes(1);
    expect(abort.mock.calls[0]).toMatchObject([
      { endpoint: 'agents', streamId: 'thread 1', generationCreatedAt: 3000 },
    ]);
    chat.dispose();
  });
});
