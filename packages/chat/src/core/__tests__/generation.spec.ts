import type {
  ChatEvent,
  TMessage,
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
});
