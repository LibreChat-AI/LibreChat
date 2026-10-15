import { StepEvents } from 'librechat-data-provider';
import type { Agents, TMessage, TPayload, ChatEvent } from 'librechat-data-provider';
import type { ChatStream, ChatStatus, ChatTransport, ChatConnection } from '../types';
import type { ChatState, ChatFinishResult } from '../chat';
import { Chat } from '../chat';

/**
 * The chat lifecycle as a table: every generation state a chat can be in, crossed with every event
 * that can reach it, and the status, completions and stop target each pair must produce.
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

const askAction = {
  actionId: 'action-1',
  streamId: 'convo-1',
  conversationId: 'convo-1',
  createdAt: 1,
  payload: { type: 'ask_user_question', question: { question: 'Which?' }, tool_call_id: 'ask-1' },
} as Agents.PendingAction;

const networkError = () => Object.assign(new Error('Network Error'), { code: 'ERR_NETWORK' });

const flush = async () => {
  for (let i = 0; i < 5; i++) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
};

type Harness = {
  chat: Chat;
  transport: jest.Mocked<Required<ChatTransport>>;
  finishes: ChatFinishResult[];
  /** The stream the chat is attached to, which a confirmed stop ends with an abort frame. */
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
    abort: jest.fn(async () => {
      harness.stream?.push(finalEvent({ terminalStatus: 'aborted' }));
      return { success: true };
    }),
    resume: jest.fn(async () => ({
      streamId: 'convo-1',
      conversationId: 'convo-1',
      status: 'resuming' as const,
    })),
  } as unknown as jest.Mocked<Required<ChatTransport>>;
  harness.chat = new Chat({
    id: 'convo-1',
    state,
    transport: harness.transport,
    prepareRequest: () => ({
      payload,
      messages: [userMessage, placeholder],
      responseMessageId: 'response-1',
    }),
    resumeSelection: () => ({ endpoint: 'agents' }),
    onFinish: (result) => finishes.push(result),
  });
  return harness;
};

const attach = (h: Harness, stream: TestStream) => {
  h.stream = stream;
  h.transport.sendMessages.mockResolvedValue({ status: 'stream', stream });
};

const send = (h: Harness) => {
  h.chat.sendMessage({ parts: [{ type: 'text', text: 'Hi' }] }).then(
    () => undefined,
    () => undefined,
  );
};

/** Drives a fresh chat into each generation state. */
const states: Record<string, (h: Harness) => Promise<void>> = {
  /** The start request is in flight; no stream yet. */
  starting: async (h) => {
    h.transport.sendMessages.mockImplementation(
      (request) =>
        new Promise((resolve, reject) => {
          h.open = () => {
            h.stream = createStream({ streamId: 'convo-1', generationCreatedAt: 100 });
            resolve({ status: 'stream', stream: h.stream });
          };
          h.fail = () => reject(networkError());
          request.abortSignal?.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    );
    send(h);
    await flush();
  },
  /** Streaming a generation this chat started. */
  attached: async (h) => {
    attach(h, createStream({ streamId: 'convo-1', generationCreatedAt: 100 }));
    send(h);
    await flush();
    h.stream?.push(stepEvent);
    await flush();
  },
  /** The stream dropped; the server keeps the generation running. */
  detached: async (h) => {
    await states.attached(h);
    h.stream?.push(dropEvent);
    await flush();
    h.stream = undefined;
  },
  /** Reattaching to a running generation; the reconnect is in flight. */
  reattaching: async (h) => {
    h.transport.reconnectToStream.mockImplementation(
      (request) =>
        new Promise((resolve, reject) => {
          h.open = () => {
            h.stream = createStream({ streamId: 'convo-1', generationCreatedAt: 300 });
            resolve(h.stream);
          };
          h.fail = () => reject(networkError());
          request.abortSignal?.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    );
    h.chat.resumeStream({ streamId: 'convo-1', generationCreatedAt: 300 }).then(
      () => undefined,
      () => undefined,
    );
    await flush();
  },
  /** Streaming a generation that paused for an answer. */
  paused: async (h) => {
    await states.attached(h);
    h.stream?.push({ type: 'pending_action', data: askAction });
    await flush();
  },
  /** A pause restored from a status check, with no stream attached. */
  restored: async (h) => {
    h.chat.restorePendingAction(askAction, 500);
    await flush();
  },
  /** The server finished the turn before the chat attached. */
  settled: async (h) => {
    h.transport.sendMessages.mockResolvedValue({ status: 'settled', conversationId: 'convo-1' });
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
  stop: async (h) => {
    await record(h, h.chat.stop());
    await flush();
  },
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
  dropThenStop: async (h) => {
    await events.networkDrop(h);
    h.stream = undefined;
    await events.stop(h);
  },
  restoreThenStop: async (h) => {
    await events.restore(h);
    await events.stop(h);
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
    h.transport.sendMessages.mockResolvedValue({ status: 'settled', conversationId: 'convo-1' });
    await record(h, h.chat.sendMessage({ parts: [{ type: 'text', text: 'Again' }] }));
    h.outcome =
      h.transport.sendMessages.mock.calls.length > before ? `sent:${h.outcome}` : h.outcome;
    await flush();
  },
  restore: async (h) => {
    try {
      h.chat.restorePendingAction({ ...askAction, actionId: 'action-9' }, 900);
      h.outcome = 'ok';
    } catch (error) {
      h.outcome = (error as Error).message;
    }
    await flush();
  },
};

type Expected = {
  status: ChatStatus;
  connection?: ChatConnection;
  /** How many times `onFinish` ran, over the state and the event together. */
  finishes: number;
  /** Flags of the last `onFinish`. */
  last?: Partial<Pick<ChatFinishResult, 'isAbort' | 'isDisconnect' | 'isError' | 'isSettled'>>;
  /** What `transport.abort` was asked to stop, or `null` when it was not called. */
  abort?: { streamId?: string; generationCreatedAt?: number } | null;
  action?: string | null;
  /** The event's own result: `ok`, a rejection message fragment, or `sent:` for a new turn. */
  outcome?: string;
};

const NONE = null;
const done = { isAbort: false, isDisconnect: false, isError: false, isSettled: false };
const aborted = { ...done, isAbort: true };
const dropped = { ...done, isError: true, isDisconnect: true };
const settled = { ...done, isSettled: true };

const table: Array<[keyof typeof states, keyof typeof events, Expected]> = [
  ['starting', 'stop', { status: 'ready', finishes: 1, last: aborted, abort: NONE, outcome: 'ok' }],
  ['starting', 'final', { status: 'ready', finishes: 1, last: done, abort: NONE }],
  ['starting', 'newTurn', { status: 'submitted', finishes: 0, outcome: 'in flight' }],
  ['starting', 'restore', { status: 'submitted', finishes: 0, outcome: 'in flight' }],

  [
    'attached',
    'stop',
    {
      status: 'ready',
      finishes: 1,
      last: aborted,
      abort: { streamId: 'convo-1', generationCreatedAt: 100 },
    },
  ],
  [
    'attached',
    'streamEnd',
    { status: 'error', connection: 'idle', finishes: 1, last: dropped, abort: NONE },
  ],
  [
    'attached',
    'networkDrop',
    { status: 'error', connection: 'idle', finishes: 1, last: dropped, abort: NONE },
  ],
  ['attached', 'final', { status: 'ready', connection: 'idle', finishes: 1, last: done }],
  ['attached', 'reconcile', { status: 'ready', finishes: 1, last: settled }],
  ['attached', 'newTurn', { status: 'streaming', finishes: 0, outcome: 'in flight' }],
  ['attached', 'restore', { status: 'streaming', finishes: 0, outcome: 'in flight' }],

  [
    'detached',
    'stop',
    {
      status: 'ready',
      finishes: 1,
      last: dropped,
      abort: { streamId: 'convo-1', generationCreatedAt: 100 },
    },
  ],
  ['detached', 'newTurn', { status: 'ready', finishes: 2, last: settled, outcome: 'sent:ok' }],
  ['detached', 'restore', { status: 'error', finishes: 1, action: 'action-9', outcome: 'ok' }],

  [
    'reattaching',
    'stop',
    {
      status: 'ready',
      connection: 'idle',
      finishes: 1,
      last: aborted,
      abort: { streamId: 'convo-1', generationCreatedAt: 300 },
    },
  ],
  ['reattaching', 'final', { status: 'ready', connection: 'idle', finishes: 1, last: done }],
  ['reattaching', 'reconcile', { status: 'ready', finishes: 1, last: settled }],
  [
    'reattaching',
    'newTurn',
    { status: 'ready', connection: 'reconnecting', finishes: 0, outcome: 'in flight' },
  ],
  ['reattaching', 'restore', { status: 'ready', finishes: 0, outcome: 'in flight' }],

  [
    'paused',
    'stop',
    {
      status: 'ready',
      finishes: 1,
      last: aborted,
      action: NONE,
      abort: { streamId: 'convo-1', generationCreatedAt: 100 },
    },
  ],
  ['paused', 'networkDrop', { status: 'error', finishes: 1, last: dropped, action: 'action-1' }],
  ['paused', 'final', { status: 'ready', finishes: 1, last: done, action: NONE }],
  [
    'paused',
    'newTurn',
    { status: 'streaming', finishes: 0, action: 'action-1', outcome: 'in flight' },
  ],

  [
    'restored',
    'stop',
    {
      status: 'ready',
      finishes: 0,
      action: NONE,
      abort: { streamId: 'convo-1', generationCreatedAt: 500 },
    },
  ],
  [
    'restored',
    'newTurn',
    { status: 'ready', finishes: 0, action: 'action-1', outcome: 'paused generation' },
  ],
  ['restored', 'restore', { status: 'ready', finishes: 0, action: 'action-9', outcome: 'ok' }],

  ['settled', 'stop', { status: 'ready', finishes: 1, last: settled, abort: NONE, outcome: 'ok' }],
  ['settled', 'newTurn', { status: 'ready', finishes: 2, outcome: 'sent:ok' }],
  ['settled', 'restore', { status: 'ready', finishes: 1, action: 'action-9', outcome: 'ok' }],

  [
    'replaced',
    'stop',
    {
      status: 'ready',
      finishes: 1,
      last: aborted,
      abort: { streamId: 'stream-2', generationCreatedAt: 200 },
    },
  ],
  ['replaced', 'networkDrop', { status: 'error', finishes: 1, last: dropped }],
  ['replaced', 'final', { status: 'ready', finishes: 1, last: done }],
  ['replaced', 'newTurn', { status: 'streaming', finishes: 0, outcome: 'in flight' }],

  ['aborted', 'stop', { status: 'ready', finishes: 1, last: aborted, abort: NONE, outcome: 'ok' }],
  ['aborted', 'newTurn', { status: 'ready', finishes: 2, outcome: 'sent:ok' }],
  ['aborted', 'restore', { status: 'ready', finishes: 1, action: 'action-9', outcome: 'ok' }],

  /** Network failures before a stream, and the stop that follows a drop or a restore. */
  ['starting', 'streamEnd', { status: 'error', finishes: 1, last: dropped, abort: NONE }],
  ['starting', 'networkDrop', { status: 'error', finishes: 1, last: dropped, abort: NONE }],
  [
    'attached',
    'dropThenStop',
    {
      status: 'ready',
      finishes: 1,
      last: dropped,
      abort: { streamId: 'convo-1', generationCreatedAt: 100 },
    },
  ],
  [
    'detached',
    'restoreThenStop',
    {
      status: 'ready',
      finishes: 1,
      action: NONE,
      abort: { streamId: 'convo-1', generationCreatedAt: 900 },
    },
  ],
  [
    'reattaching',
    'streamEnd',
    { status: 'error', connection: 'idle', finishes: 1, last: dropped, abort: NONE },
  ],
  [
    'reattaching',
    'networkDrop',
    { status: 'error', connection: 'idle', finishes: 1, last: dropped, abort: NONE },
  ],
  [
    'reattaching',
    'dropThenStop',
    {
      status: 'ready',
      finishes: 1,
      last: dropped,
      abort: { streamId: 'convo-1', generationCreatedAt: 300 },
    },
  ],
  [
    'paused',
    'dropThenStop',
    {
      status: 'ready',
      finishes: 1,
      last: dropped,
      action: NONE,
      abort: { streamId: 'convo-1', generationCreatedAt: 100 },
    },
  ],
  [
    'restored',
    'restoreThenStop',
    {
      status: 'ready',
      finishes: 0,
      action: NONE,
      abort: { streamId: 'convo-1', generationCreatedAt: 900 },
    },
  ],
  ['replaced', 'streamEnd', { status: 'error', finishes: 1, last: dropped }],
  [
    'replaced',
    'dropThenStop',
    {
      status: 'ready',
      finishes: 1,
      last: dropped,
      abort: { streamId: 'stream-2', generationCreatedAt: 200 },
    },
  ],
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
    if (expected.abort === null) {
      expect(h.transport.abort).not.toHaveBeenCalled();
    } else if (expected.abort) {
      expect(h.transport.abort).toHaveBeenCalledTimes(1);
      expect(h.transport.abort).toHaveBeenCalledWith(expect.objectContaining(expected.abort));
    }
    if (expected.action !== undefined) {
      expect(h.chat.pendingAction?.actionId ?? null).toBe(expected.action);
    }
    if (expected.outcome !== undefined) {
      expect(h.outcome).toContain(expected.outcome);
    }
  });
});
