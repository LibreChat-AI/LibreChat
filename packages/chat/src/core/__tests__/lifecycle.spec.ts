import { StepEvents } from 'librechat-data-provider';
import type { TMessage, TPayload, ChatEvent } from 'librechat-data-provider';
import type { ChatStream, ChatStatus, ChatTransport, ChatConnection } from '../types';
import type { ChatState, ChatFinishResult } from '../chat';
import { Chat } from '../chat';

/**
 * The chat lifecycle as a table: every generation state a chat can be in, crossed with every event
 * that can reach it, and the status, connection and completions each pair must produce.
 */

type TestStream = ChatStream & { push(event: ChatEvent): void; closed(): boolean };

const createStream = (meta: { streamId?: string; generationCreatedAt?: number } = {}) => {
  const queued: ChatEvent[] = [];
  let wake: (() => void) | undefined;
  let closed = false;
  const stream: TestStream = {
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

const payload = { endpoint: 'agents', conversationId: 'convo-1', text: 'Hi' } as TPayload;

const stepEvent: ChatEvent = {
  type: 'step',
  data: { event: StepEvents.ON_MESSAGE_DELTA, data: { id: 'step-1', delta: { content: [] } } },
};

const finalEvent = (data: Partial<Extract<ChatEvent, { type: 'final' }>['data']> = {}) =>
  ({
    type: 'final',
    data: { final: true, requestMessage: userMessage, responseMessage: placeholder, ...data },
  }) as ChatEvent;

const dropEvent = { type: 'error', status: 0, data: 'offline' } as ChatEvent;

const networkError = () => Object.assign(new Error('Network Error'), { code: 'ERR_NETWORK' });

const flush = async () => {
  for (let i = 0; i < 5; i++) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
};

type Harness = {
  chat: Chat;
  transport: jest.Mocked<ChatTransport>;
  finishes: ChatFinishResult[];
  /** The stream the chat is attached to. */
  stream?: TestStream;
  /** Settles a start or reattachment the state left pending. */
  open?: () => void;
  /** Fails that pending start or reattachment as a request that never got a response. */
  fail?: () => void;
  outcome?: string;
};

const createHarness = (): Harness => {
  let messages: TMessage[] = [];
  const state: ChatState = {
    status: 'ready' as ChatStatus,
    error: undefined,
    connection: 'idle' as ChatConnection,
    get messages() {
      return messages;
    },
    replaceMessages(next) {
      messages = next;
    },
  };
  const finishes: ChatFinishResult[] = [];
  const harness = { finishes } as Harness;
  harness.transport = {
    sendMessages: jest.fn(),
    reconnectToStream: jest.fn(async () => null),
    abort: jest.fn(async () => ({ success: true })),
  } as unknown as jest.Mocked<ChatTransport>;
  harness.chat = new Chat({
    id: 'convo-1',
    state,
    transport: harness.transport,
    prepareRequest: () => ({
      payload,
      messages: [userMessage, placeholder],
      responseMessageId: 'response-1',
    }),
    onFinish: (result) => finishes.push(result),
  });
  return harness;
};

const send = (h: Harness) => {
  h.chat.sendMessage({ parts: [{ type: 'text', text: 'Hi' }] }).then(
    () => undefined,
    () => undefined,
  );
};

/**
 * A request that stays open until the test opens or fails it. It ignores the abort signal, as a
 * transport may, so the chat itself has to let go of a start that answers late.
 */
const pending = <T>(h: Harness, opened: () => T) =>
  new Promise<T>((resolve, reject) => {
    h.open = () => resolve(opened());
    h.fail = () => reject(networkError());
  });

/** Drives a fresh chat into each generation state. */
const states: Record<string, (h: Harness) => Promise<void>> = {
  /** The start request is in flight; no stream yet. */
  starting: async (h) => {
    h.transport.sendMessages.mockImplementation(() =>
      pending(h, () => {
        h.stream = createStream({ streamId: 'convo-1', generationCreatedAt: 100 });
        return { status: 'stream' as const, stream: h.stream };
      }),
    );
    send(h);
    await flush();
  },
  /** Streaming a generation this chat started. */
  attached: async (h) => {
    h.stream = createStream({ streamId: 'convo-1', generationCreatedAt: 100 });
    h.transport.sendMessages.mockResolvedValue({ status: 'stream', stream: h.stream });
    send(h);
    await flush();
    h.stream.push(stepEvent);
    await flush();
  },
  /** The server finished the turn before the chat attached. */
  settled: async (h) => {
    h.transport.sendMessages.mockResolvedValue({
      status: 'settled',
      conversationId: 'convo-1',
      generationProtocolVersion: 2,
    });
    send(h);
    await flush();
  },
  /** The start was answered with a newer generation, whose reattachment is in flight. */
  replacing: async (h) => {
    h.transport.sendMessages.mockResolvedValue({
      status: 'replaced',
      conversationId: 'convo-1',
      streamId: 'stream-2',
      generationCreatedAt: 200,
      generationProtocolVersion: 2,
    });
    h.transport.reconnectToStream.mockImplementation(() =>
      pending(h, () => {
        h.stream = createStream({ streamId: 'stream-2', generationCreatedAt: 200 });
        return h.stream;
      }),
    );
    send(h);
    await flush();
  },
  /** The start was answered with a newer generation, which the chat reattached to. */
  replaced: async (h) => {
    const stream = createStream({ streamId: 'stream-2', generationCreatedAt: 200 });
    h.stream = stream;
    h.transport.sendMessages.mockResolvedValue({
      status: 'replaced',
      conversationId: 'convo-1',
      streamId: 'stream-2',
      generationCreatedAt: 200,
      generationProtocolVersion: 2,
    });
    h.transport.reconnectToStream.mockResolvedValue(stream);
    send(h);
    await flush();
    stream.push(stepEvent);
    await flush();
  },
  /** The generation ended with an abort frame. */
  aborted: async (h) => {
    await states.attached(h);
    h.stream?.push({ type: 'abort', data: {} } as ChatEvent);
    await flush();
    h.stream = undefined;
  },
  /** The generation failed with a server error frame. */
  failed: async (h) => {
    await states.attached(h);
    h.stream?.push({ type: 'error', status: 500, data: 'failed' } as ChatEvent);
    await flush();
    h.stream = undefined;
  },
};

const record = (h: Harness, settle: Promise<unknown>) =>
  settle.then(
    () => {
      h.outcome = 'ok';
    },
    (error: Error) => {
      h.outcome = error.message;
    },
  );

/** Every event that can reach a chat. */
const events: Record<string, (h: Harness) => Promise<void>> = {
  streamEnd: async (h) => {
    h.open?.();
    await flush();
    h.stream?.close();
    await flush();
  },
  networkDrop: async (h) => {
    if (h.stream) {
      h.stream.push(dropEvent);
    } else {
      h.fail?.();
    }
    await flush();
  },
  final: async (h) => {
    h.open?.();
    await flush();
    h.stream?.push(finalEvent());
    await flush();
  },
  reconcile: async (h) => {
    h.open?.();
    await flush();
    h.stream?.push(finalEvent({ reconcile: true, reconcileReason: 'terminal_payload_missing' }));
    await flush();
  },
  newTurn: async (h) => {
    const before = h.transport.sendMessages.mock.calls.length;
    h.transport.sendMessages.mockResolvedValue({
      status: 'settled',
      conversationId: 'convo-1',
      generationProtocolVersion: 2,
    });
    await record(h, h.chat.sendMessage({ parts: [{ type: 'text', text: 'Again' }] }));
    h.outcome =
      h.transport.sendMessages.mock.calls.length > before ? `sent:${h.outcome}` : h.outcome;
    await flush();
  },
  clearError: async (h) => {
    h.chat.clearError();
    await flush();
  },
  dispose: async (h) => {
    h.chat.dispose();
    await flush();
    h.outcome = h.stream?.closed() ? 'closed' : 'open';
  },
  /** A start or reattachment that answers after the chat let it go has its stream closed. */
  disposeThenOpen: async (h) => {
    h.chat.dispose();
    await flush();
    h.open?.();
    await flush();
    h.outcome = h.stream?.closed() ? 'closed' : 'open';
  },
};

type Expected = {
  status: ChatStatus;
  connection?: ChatConnection;
  /** How many times `onFinish` ran, over the state and the event together. */
  finishes: number;
  /** Flags of the last `onFinish`. */
  last?: Partial<Pick<ChatFinishResult, 'isAbort' | 'isDisconnect' | 'isError' | 'isSettled'>>;
  /** The message ids the list holds afterwards. */
  messages?: string[];
  /** The event's own result: `ok`, a rejection message fragment, `sent:` for a new turn. */
  outcome?: string;
};

const done = { isAbort: false, isDisconnect: false, isError: false, isSettled: false };
const aborted = { ...done, isAbort: true };
const dropped = { ...done, isError: true, isDisconnect: true };
const failed = { ...done, isError: true };
const settled = { ...done, isSettled: true };
const turn = ['user-1', 'response-1'];

const table: Array<[keyof typeof states, keyof typeof events, Expected]> = [
  ['starting', 'streamEnd', { status: 'error', connection: 'idle', finishes: 1, last: dropped }],
  ['starting', 'networkDrop', { status: 'error', connection: 'idle', finishes: 1, last: dropped }],
  ['starting', 'final', { status: 'ready', connection: 'idle', finishes: 1, last: done }],
  ['starting', 'newTurn', { status: 'submitted', finishes: 0, outcome: 'in flight' }],
  ['starting', 'dispose', { status: 'submitted', connection: 'idle', finishes: 0, messages: turn }],
  ['starting', 'disposeThenOpen', { status: 'submitted', finishes: 0, outcome: 'closed' }],

  ['attached', 'streamEnd', { status: 'error', connection: 'idle', finishes: 1, last: dropped }],
  ['attached', 'networkDrop', { status: 'error', connection: 'idle', finishes: 1, last: dropped }],
  ['attached', 'final', { status: 'ready', connection: 'idle', finishes: 1, last: done }],
  ['attached', 'reconcile', { status: 'ready', finishes: 1, last: settled }],
  ['attached', 'newTurn', { status: 'streaming', finishes: 0, outcome: 'in flight' }],
  ['attached', 'clearError', { status: 'streaming', finishes: 0 }],
  [
    'attached',
    'dispose',
    { status: 'streaming', connection: 'idle', finishes: 0, messages: turn, outcome: 'closed' },
  ],

  ['settled', 'newTurn', { status: 'ready', finishes: 2, last: settled, outcome: 'sent:ok' }],
  ['settled', 'dispose', { status: 'ready', connection: 'idle', finishes: 1, messages: turn }],

  ['replacing', 'final', { status: 'ready', connection: 'idle', finishes: 1, last: done }],
  ['replacing', 'reconcile', { status: 'ready', finishes: 1, last: settled }],
  ['replacing', 'streamEnd', { status: 'error', connection: 'idle', finishes: 1, last: dropped }],
  ['replacing', 'networkDrop', { status: 'error', connection: 'idle', finishes: 1, last: dropped }],
  [
    'replacing',
    'newTurn',
    { status: 'submitted', connection: 'reconnecting', finishes: 0, outcome: 'in flight' },
  ],
  ['replacing', 'dispose', { status: 'submitted', connection: 'idle', finishes: 0, messages: [] }],
  ['replacing', 'disposeThenOpen', { status: 'submitted', finishes: 0, outcome: 'closed' }],

  ['replaced', 'networkDrop', { status: 'error', finishes: 1, last: dropped }],
  ['replaced', 'streamEnd', { status: 'error', finishes: 1, last: dropped }],
  ['replaced', 'final', { status: 'ready', finishes: 1, last: done }],
  ['replaced', 'newTurn', { status: 'streaming', finishes: 0, outcome: 'in flight' }],
  ['replaced', 'dispose', { status: 'streaming', connection: 'idle', finishes: 0, messages: [] }],

  ['aborted', 'newTurn', { status: 'ready', finishes: 2, last: settled, outcome: 'sent:ok' }],
  ['aborted', 'clearError', { status: 'ready', finishes: 1, last: aborted }],

  ['failed', 'clearError', { status: 'ready', finishes: 1, last: failed }],
  ['failed', 'newTurn', { status: 'ready', finishes: 2, last: settled, outcome: 'sent:ok' }],
  ['failed', 'dispose', { status: 'error', connection: 'idle', finishes: 1, messages: turn }],
];

describe('Chat lifecycle', () => {
  it.each(table)('%s + %s', async (state, event, expected) => {
    const h = createHarness();
    await states[state](h);
    await events[event](h);

    expect(h.chat.status).toBe(expected.status);
    if (expected.connection) {
      expect(h.chat.connection).toBe(expected.connection);
    }
    expect(h.finishes).toHaveLength(expected.finishes);
    if (expected.last) {
      expect(h.finishes[h.finishes.length - 1]).toMatchObject(expected.last);
    }
    if (expected.messages) {
      expect(h.chat.messages.map((message) => message.messageId)).toEqual(expected.messages);
    }
    if (expected.outcome !== undefined) {
      expect(h.outcome).toContain(expected.outcome);
    }
    expect(h.transport.abort).not.toHaveBeenCalled();
  });
});
