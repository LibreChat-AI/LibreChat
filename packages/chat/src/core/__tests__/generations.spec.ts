import { StepEvents } from 'librechat-data-provider';
import type { TMessage, TPayload, ChatEvent } from 'librechat-data-provider';
import type {
  ChatInit,
  ChatState,
  ChatStopResult,
  ChatFinishResult,
  ChatPrepareRequest,
  ChatPreparedRequest,
} from '../chat';
import type {
  ChatStream,
  ChatStatus,
  ChatTransport,
  ChatConnection,
  ChatAbortResult,
  ChatSendResult,
} from '../types';
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

const networkError = () => Object.assign(new Error('Network Error'), { code: 'ERR_NETWORK' });

const flush = async () => {
  for (let i = 0; i < 5; i++) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
};

type Harness = {
  chat: Chat;
  prepare: jest.Mock<ChatPreparedRequest | Promise<ChatPreparedRequest>, [ChatPrepareRequest]>;
  transport: jest.Mocked<Required<ChatTransport>>;
  finishes: ChatFinishResult[];
  /** The stream the chat is attached to, which a confirmed stop ends with an abort frame. */
  stream?: TestStream;
  /** Settles a start or reattachment the state left pending. */
  open?: () => void;
  /** Fails that pending start or reattachment as a request that never got a response. */
  fail?: () => void;
  /** Answers that pending start as one the server already finished. */
  settle?: () => void;
  /** The transport answers a start after it was cancelled, as a request already sent can. */
  answersLate?: boolean;
  outcome?: string;
  /** Whether the turn's own send has settled. */
  turn?: 'pending' | 'settled';
  /** What a second stop answers after the event, which shows what the chat still holds. */
  after?: ChatStopResult['status'];
  /** Answers the stop the event left waiting on the server. */
  answerStop?: () => void;
};

const createHarness = (init: Partial<ChatInit> & { messages?: TMessage[] } = {}): Harness => {
  const { messages: initial = [], ...overrides } = init;
  let messages: TMessage[] = initial;
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
  harness.prepare = jest.fn((_request: ChatPrepareRequest) => ({
    payload,
    messages: [userMessage, placeholder],
    responseMessageId: 'response-1',
  }));
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
    prepareRequest: (...args) => harness.prepare(...args),
    resumeSelection: () => ({ endpoint: 'agents' }),
    onFinish: (result) => finishes.push(result),
    ...overrides,
  });
  return harness;
};

const attach = (h: Harness, stream: TestStream) => {
  h.stream = stream;
  h.transport.sendMessages.mockResolvedValue({ status: 'stream', stream });
};

const send = (h: Harness) => {
  h.turn = 'pending';
  const settle = () => {
    h.turn = 'settled';
  };
  h.chat.sendMessage({ parts: [{ type: 'text', text: 'Hi' }] }).then(settle, settle);
};

/** Drives a fresh chat into each generation state. */
const states: Record<string, (h: Harness) => Promise<void>> = {
  /** The host is still preparing the turn; nothing reached the transport. */
  preparing: async (h) => {
    h.prepare.mockImplementation(
      () =>
        new Promise((resolve) => {
          h.open = () =>
            resolve({ payload, messages: [userMessage, placeholder], responseMessageId: 'r-1' });
        }),
    );
    attach(h, createStream({ streamId: 'convo-1', generationCreatedAt: 100 }));
    send(h);
    await flush();
  },
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
          h.settle = () =>
            resolve({ status: 'settled', conversationId: 'convo-1', generationProtocolVersion: 2 });
          request.abortSignal?.addEventListener('abort', () => {
            if (!h.answersLate) {
              reject(new Error('aborted'));
            }
          });
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

const recordAfter = async (h: Harness) => {
  try {
    h.after = (await h.chat.stop()).status;
  } catch {
    h.after = undefined;
  }
};

const record = (h: Harness, settle: Promise<unknown>) =>
  settle.then(
    (value) => {
      const stopped = value as ChatStopResult | undefined;
      h.outcome = stopped?.status === 'unaddressable' ? 'unaddressable' : 'ok';
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
  /** A stop the server confirmed without saving its terminal state, as protocol v2 reports. */
  unsavedStop: async (h) => {
    const reconcile = finalEvent({
      reconcile: true,
      reconcileReason: 'abort_persistence_failed',
      terminalStatus: 'aborted',
    });
    h.transport.abort.mockImplementation(async () => {
      h.stream?.push(reconcile);
      return { success: true, generationProtocolVersion: 2, persistenceFailed: true };
    });
    const opening = !h.stream && !!h.open;
    const stopping = record(h, h.chat.stop());
    await flush();
    if (opening) {
      h.open?.();
      await flush();
      h.stream?.push(reconcile);
    }
    await stopping;
    await flush();
  },
  /** A stop that found the run already finished on its own. */
  settledStop: async (h) => {
    h.transport.abort.mockResolvedValue({
      success: true,
      generationProtocolVersion: 2,
      settled: true,
      terminalStatus: 'complete',
    });
    await events.stop(h);
  },
  /** A stop the server answers 404: the generation finished and was deleted before it arrived. */
  goneStop: async (h) => {
    h.transport.abort.mockRejectedValue(
      Object.assign(new Error('Not found'), { response: { status: 404 } }),
    );
    await events.stop(h);
  },
  /** A reconnect that finds nothing running: the generation ended while nothing was attached. */
  reconnectIdle: async (h) => {
    h.transport.reconnectToStream.mockResolvedValue(null);
    await record(h, h.chat.resumeStream({ streamId: 'convo-1', generationCreatedAt: 100 }));
    await flush();
  },
  dispose: async (h) => {
    h.chat.dispose();
    await flush();
  },
  /** A stop whose server answer, or the start it raced, arrives after it was asked. */
  lateAnswer: async (h) => {
    h.answersLate = true;
    h.transport.abort.mockImplementation(
      () =>
        new Promise((resolve) => {
          h.answerStop = () => {
            h.stream?.push(finalEvent({ terminalStatus: 'aborted' }));
            resolve({ success: true });
          };
        }),
    );
    const stopping = record(h, h.chat.stop());
    await flush();
    h.open?.();
    await flush();
    h.answerStop?.();
    await stopping;
    await flush();
    h.answerStop?.();
    await flush();
    await recordAfter(h);
  },
  /** A late answer to a cancelled start that says the server already finished it. */
  lateSettled: async (h) => {
    h.answersLate = true;
    const stopping = record(h, h.chat.stop());
    await flush();
    h.settle?.();
    await stopping;
    await flush();
    await recordAfter(h);
  },
  /** The chat is disposed while a stop waits on a server that never answers. */
  disposeDuringStop: async (h) => {
    h.transport.abort.mockImplementation(() => new Promise(() => undefined));
    const stopping = record(h, h.chat.stop());
    await flush();
    h.chat.dispose();
    await stopping;
    await flush();
  },
};

type Expected = {
  status: ChatStatus;
  connection?: ChatConnection;
  /** How many times `onFinish` ran, over the state and the event together. */
  finishes: number;
  /** Flags of the last `onFinish`. */
  last?: Partial<
    Pick<ChatFinishResult, 'isAbort' | 'isDisconnect' | 'isError' | 'isSettled' | 'reconcileReason'>
  >;
  /** What `transport.abort` was asked to stop, or `null` when it was not called. */
  abort?: { streamId?: string; generationCreatedAt?: number } | null;
  /** The event's own result: `ok`, a rejection message fragment, or `sent:` for a new turn. */
  outcome?: string;
  turn?: 'pending' | 'settled';
  after?: ChatStopResult['status'];
  /** How many starts reached the transport. */
  starts?: number;
};

const NONE = null;
const done = { isAbort: false, isDisconnect: false, isError: false, isSettled: false };
const aborted = { ...done, isAbort: true };
const dropped = { ...done, isError: true, isDisconnect: true };
const settled = { ...done, isSettled: true };
/** A confirmed stop whose abort frame never arrived, which the host reloads. */
const stoppedUnframed = { ...aborted, isSettled: true };
const unsaved = {
  ...aborted,
  isSettled: true,
  reconcileReason: 'abort_persistence_failed' as const,
};

const table: Array<[keyof typeof states, keyof typeof events, Expected]> = [
  /** The start reached the transport, so the server may run it with nothing this chat can name. */
  [
    'starting',
    'stop',
    { status: 'error', finishes: 1, last: dropped, abort: NONE, outcome: 'unaddressable' },
  ],
  ['starting', 'final', { status: 'ready', finishes: 1, last: done, abort: NONE }],
  ['starting', 'newTurn', { status: 'submitted', finishes: 0, outcome: 'in flight' }],

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

  [
    'detached',
    'stop',
    {
      status: 'ready',
      finishes: 2,
      last: stoppedUnframed,
      abort: { streamId: 'convo-1', generationCreatedAt: 100 },
    },
  ],
  ['detached', 'newTurn', { status: 'ready', finishes: 2, last: settled, outcome: 'sent:ok' }],

  [
    'reattaching',
    'stop',
    {
      status: 'ready',
      connection: 'idle',
      finishes: 1,
      last: stoppedUnframed,
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

  ['settled', 'stop', { status: 'ready', finishes: 1, last: settled, abort: NONE, outcome: 'ok' }],
  ['settled', 'newTurn', { status: 'ready', finishes: 2, outcome: 'sent:ok' }],

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

  /** Network failures before a stream, and the stop that follows a drop or a restore. */
  ['starting', 'streamEnd', { status: 'error', finishes: 1, last: dropped, abort: NONE }],
  ['starting', 'networkDrop', { status: 'error', finishes: 1, last: dropped, abort: NONE }],
  /** A start whose response was lost left nothing to address; the caller stops it its own way. */
  [
    'starting',
    'dropThenStop',
    { status: 'error', finishes: 1, last: dropped, abort: NONE, outcome: 'unaddressable' },
  ],
  [
    'attached',
    'dropThenStop',
    {
      status: 'ready',
      finishes: 2,
      last: stoppedUnframed,
      abort: { streamId: 'convo-1', generationCreatedAt: 100 },
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
      finishes: 2,
      last: stoppedUnframed,
      abort: { streamId: 'convo-1', generationCreatedAt: 300 },
    },
  ],
  ['replaced', 'streamEnd', { status: 'error', finishes: 1, last: dropped }],
  [
    'replaced',
    'dropThenStop',
    {
      status: 'ready',
      finishes: 2,
      last: stoppedUnframed,
      abort: { streamId: 'stream-2', generationCreatedAt: 200 },
    },
  ],

  /** Stops the server answered as unsaved or as already settled; neither is a plain abort. */
  [
    'attached',
    'unsavedStop',
    {
      status: 'ready',
      finishes: 1,
      last: unsaved,
      abort: { streamId: 'convo-1', generationCreatedAt: 100 },
      outcome: 'ok',
    },
  ],
  [
    'reattaching',
    'unsavedStop',
    {
      status: 'ready',
      connection: 'idle',
      finishes: 1,
      last: unsaved,
      abort: { streamId: 'convo-1', generationCreatedAt: 300 },
      outcome: 'ok',
    },
  ],
  [
    'detached',
    'unsavedStop',
    {
      status: 'ready',
      finishes: 2,
      last: unsaved,
      abort: { streamId: 'convo-1', generationCreatedAt: 100 },
      outcome: 'ok',
    },
  ],
  ['detached', 'reconnectIdle', { status: 'ready', finishes: 2, last: settled, abort: NONE }],
  ['aborted', 'reconnectIdle', { status: 'ready', finishes: 1, last: aborted, abort: NONE }],
  [
    'detached',
    'settledStop',
    {
      status: 'ready',
      finishes: 2,
      last: settled,
      abort: { streamId: 'convo-1', generationCreatedAt: 100 },
      outcome: 'ok',
    },
  ],
];

const live = { streamId: 'convo-1', generationCreatedAt: 100 };

/**
 * Dispose, stop and a late server answer, across every phase a turn can be in: before its start is
 * sent, while the start is pending, live, paused, and restored from a status read. Every awaiter
 * settles, and nothing the chat no longer holds survives as a stop target.
 */
const teardown: Array<[keyof typeof states, keyof typeof events, Expected]> = [
  [
    'preparing',
    'dispose',
    { status: 'ready', connection: 'idle', finishes: 0, turn: 'settled', abort: NONE, starts: 0 },
  ],
  [
    'preparing',
    'stop',
    {
      status: 'ready',
      finishes: 1,
      last: aborted,
      turn: 'settled',
      abort: NONE,
      outcome: 'ok',
      starts: 0,
    },
  ],
  [
    'preparing',
    'lateAnswer',
    {
      status: 'ready',
      finishes: 1,
      last: aborted,
      turn: 'settled',
      abort: NONE,
      outcome: 'ok',
      after: 'idle',
      starts: 0,
    },
  ],
  [
    'preparing',
    'disposeDuringStop',
    { status: 'ready', finishes: 1, turn: 'settled', abort: NONE, outcome: 'ok', starts: 0 },
  ],

  [
    'starting',
    'dispose',
    { status: 'submitted', connection: 'idle', finishes: 0, turn: 'settled', abort: NONE },
  ],
  /** The late start is stopped on the server, which resolves the failure its lost answer reported. */
  [
    'starting',
    'lateAnswer',
    {
      status: 'ready',
      finishes: 1,
      last: dropped,
      turn: 'settled',
      abort: live,
      outcome: 'unaddressable',
      after: 'idle',
    },
  ],
  /** The late settled answer says the lost start finished, which resolves the failure it reported. */
  [
    'starting',
    'lateSettled',
    {
      status: 'ready',
      finishes: 1,
      last: dropped,
      turn: 'settled',
      abort: NONE,
      outcome: 'unaddressable',
      after: 'idle',
    },
  ],
  [
    'starting',
    'disposeDuringStop',
    { status: 'error', finishes: 1, turn: 'settled', abort: NONE, outcome: 'unaddressable' },
  ],

  [
    'attached',
    'dispose',
    { status: 'streaming', connection: 'idle', finishes: 0, turn: 'settled', abort: NONE },
  ],
  [
    'attached',
    'lateAnswer',
    {
      status: 'ready',
      connection: 'idle',
      finishes: 1,
      last: aborted,
      turn: 'settled',
      abort: live,
      outcome: 'ok',
      after: 'idle',
    },
  ],
  [
    'attached',
    'disposeDuringStop',
    {
      status: 'streaming',
      connection: 'idle',
      finishes: 0,
      turn: 'settled',
      abort: live,
      outcome: 'disposed',
    },
  ],
];

/** A stop that finds the generation already gone ends whatever the chat still held for it. */
const gone: Array<[keyof typeof states, keyof typeof events, Expected]> = [
  [
    'attached',
    'goneStop',
    {
      status: 'ready',
      connection: 'idle',
      finishes: 1,
      last: settled,
      abort: live,
      outcome: 'ok',
      after: undefined,
    },
  ],
  [
    'detached',
    'goneStop',
    { status: 'ready', finishes: 2, last: settled, abort: live, outcome: 'ok' },
  ],
];

describe('Chat teardown', () => {
  it.each([...teardown, ...gone])('%s + %s', async (state, event, expected) => {
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
    if (expected.outcome !== undefined) {
      expect(h.outcome).toContain(expected.outcome);
    }
    if (expected.turn) {
      expect(h.turn).toBe(expected.turn);
    }
    if (expected.after) {
      expect(h.after).toBe(expected.after);
    }
    if (expected.starts !== undefined) {
      expect(h.transport.sendMessages).toHaveBeenCalledTimes(expected.starts);
    }
  });
});

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
    if (expected.outcome !== undefined) {
      expect(h.outcome).toContain(expected.outcome);
    }
  });
});

/**
 * The invariants every generation marker keeps, crossed with the states that hold one:
 * (1) an async continuation acts only on the generation it captured;
 * (2) a "may still be running" marker survives until the server answers for it;
 * (3) a disposed chat reaches no transport method;
 * (4) a generation record carries the response its source named, or counts it unknown.
 */
const lost = async (h: Harness) => {
  await states.starting(h);
  h.fail?.();
  await flush();
};

const disposedCalls: Record<string, (h: Harness) => Promise<unknown>> = {
  stop: (h) => h.chat.stop(),
  resumeStream: (h) => h.chat.resumeStream({ streamId: 'convo-1' }),
  sendMessage: (h) => h.chat.sendMessage({ parts: [{ type: 'text', text: 'Hi' }] }),
};

const transportCalls = (h: Harness) =>
  h.transport.sendMessages.mock.calls.length +
  h.transport.reconnectToStream.mock.calls.length +
  h.transport.abort.mock.calls.length +
  h.transport.resume.mock.calls.length;

const withLost: Record<string, (h: Harness) => Promise<void>> = { ...states, lost };

const disposedTable = Object.keys(withLost).flatMap((state) =>
  Object.keys(disposedCalls).map((call) => [state, call] as const),
);

const laterMessage: TMessage = { ...placeholder, messageId: 'response-10', text: 'Later' };

describe('Chat invariants', () => {
  it.each(disposedTable)('(3) %s, disposed, then %s reaches no transport', async (state, call) => {
    const h = createHarness();
    await withLost[state](h);
    h.chat.dispose();
    await flush();
    const before = transportCalls(h);
    let settled = false;
    disposedCalls[call](h).then(
      () => (settled = true),
      () => (settled = true),
    );
    await flush();

    expect(transportCalls(h)).toBe(before);
    expect(settled).toBe(true);
  });

  it.each([
    ['a stream answer', { success: true }],
    ['an Assistants answer', { final: true, conversation: {}, runMessages: [] }],
    ['an Assistants answer finding no run', null],
    ['a gone answer', Object.assign(new Error('Not Found'), { response: { status: 404 } })],
  ])(
    '(1) a stop answered with %s after its reattachment moved to another generation leaves that one running',
    async (_label, answer) => {
      const h = createHarness();
      await states.detached(h);
      let answerStop: (() => void) | undefined;
      h.transport.abort.mockImplementation(
        () =>
          new Promise((resolve, reject) => {
            answerStop = () =>
              answer instanceof Error ? reject(answer) : resolve(answer as ChatAbortResult);
          }),
      );
      const other = createStream({ streamId: 'convo-1', generationCreatedAt: 300 });
      let openOther: (() => void) | undefined;
      h.transport.reconnectToStream.mockImplementation(
        () => new Promise((resolve) => (openOther = () => resolve(other))),
      );
      h.chat.resumeStream({ streamId: 'convo-1' }).then(
        () => undefined,
        () => undefined,
      );
      await flush();
      let stopped = false;
      h.chat.stop().then(
        () => (stopped = true),
        () => (stopped = true),
      );
      await flush();
      openOther?.();
      await flush();
      answerStop?.();
      await flush();
      other.push(stepEvent);
      await flush();

      expect(stopped).toBe(true);
      expect(other.closed()).toBe(false);
      expect(h.chat.status).toBe('streaming');
      expect(h.chat.connection).toBe('live');
    },
  );

  it("(2) a lost start stays the caller's through a reattachment that failed before any answer", async () => {
    const h = createHarness({ resumeSelection: () => ({}) });
    await lost(h);
    h.transport.reconnectToStream.mockRejectedValueOnce(networkError());
    await h.chat.resumeStream({ streamId: 'convo-1' }).catch(() => undefined);

    await expect(h.chat.stop()).resolves.toEqual({ status: 'unaddressable' });
  });

  it.each([
    ['whose preparation failed', () => Promise.reject(new Error('Upload failed'))],
    ['stopped before it was sent', () => new Promise<never>(() => undefined)],
  ])("(2) a lost start stays the caller's through a retry %s", async (_label, retry) => {
    let prepared = 0;
    const h = createHarness({
      prepareRequest: () => {
        prepared += 1;
        if (prepared > 1) {
          return retry() as never;
        }
        return { payload, messages: [userMessage, placeholder], responseMessageId: 'response-1' };
      },
    });
    await lost(h);
    h.chat.sendMessage({ parts: [{ type: 'text', text: 'Again' }] }).then(
      () => undefined,
      () => undefined,
    );
    await flush();

    await expect(h.chat.stop()).resolves.toEqual({ status: 'unaddressable' });
    await expect(h.chat.stop()).resolves.toEqual({ status: 'unaddressable' });
  });

  it.each([
    [
      'a named reattachment',
      (h: Harness) =>
        h.chat.resumeStream({ streamId: 'convo-1', generationCreatedAt: 300 }).then(
          () => undefined,
          () => undefined,
        ),
    ],
    [
      'a replacement',
      (h: Harness) => {
        h.transport.sendMessages.mockResolvedValue({
          status: 'replaced',
          conversationId: 'convo-1',
          streamId: 'convo-1',
          generationCreatedAt: 300,
          generationProtocolVersion: 2,
        });
        send(h);
      },
    ],
  ])(
    '(1) a stop of %s leaves the other generation its reconnect found running',
    async (_label, start) => {
      const h = createHarness();
      let answerStop: (() => void) | undefined;
      h.transport.abort.mockImplementation(
        () => new Promise((resolve) => (answerStop = () => resolve({ success: true }))),
      );
      const other = createStream({ streamId: 'convo-1', generationCreatedAt: 400 });
      let openOther: (() => void) | undefined;
      h.transport.reconnectToStream.mockImplementation(
        () => new Promise((resolve) => (openOther = () => resolve(other))),
      );
      start(h);
      await flush();
      const first = h.chat.stop();
      await flush();
      openOther?.();
      await flush();
      answerStop?.();
      await first;
      other.push(stepEvent);
      await flush();

      expect(other.closed()).toBe(false);
      expect(h.chat.status).toBe('streaming');
      h.transport.abort.mockResolvedValueOnce({ success: true });
      const second = h.chat.stop();
      await flush();
      expect(h.transport.abort).toHaveBeenCalledTimes(2);
      expect(h.transport.abort).toHaveBeenLastCalledWith(
        expect.objectContaining({ generationCreatedAt: 400 }),
      );
      other.push(finalEvent({ terminalStatus: 'aborted' }));
      await second;
    },
  );

  it.each([
    ['settled', { status: 'settled', conversationId: 'convo-1', generationProtocolVersion: 2 }],
    [
      'replaced',
      {
        status: 'replaced',
        conversationId: 'convo-1',
        streamId: 'stream-2',
        generationCreatedAt: 200,
        generationProtocolVersion: 2,
      },
    ],
  ])(
    "(2) a cancelled start the server answers late as %s is no longer the caller's",
    async (_label, late) => {
      const h = createHarness();
      let answer: (() => void) | undefined;
      h.transport.sendMessages.mockImplementation(
        () => new Promise((resolve) => (answer = () => resolve(late as never))),
      );
      send(h);
      await flush();
      await expect(h.chat.stop()).resolves.toEqual({ status: 'unaddressable' });
      answer?.();
      await flush();

      await expect(h.chat.stop()).resolves.toEqual({ status: 'idle' });
      expect(h.transport.abort).not.toHaveBeenCalled();
      expect(h.transport.reconnectToStream).not.toHaveBeenCalled();
    },
  );

  it.each([['a streamed frame', stepEvent]])(
    "(4) a reattachment that recovers with %s ends the dropped connection's error",
    async (_label, event) => {
      const h = createHarness();
      await states.detached(h);
      expect(h.chat.status).toBe('error');
      const resumed = createStream({ streamId: 'convo-1', generationCreatedAt: 100 });
      h.transport.reconnectToStream.mockResolvedValueOnce(resumed);
      h.chat.resumeStream({ streamId: 'convo-1' }).then(
        () => undefined,
        () => undefined,
      );
      await flush();
      resumed.push(event);
      await flush();

      expect(h.chat.status).toBe('streaming');
      expect(h.chat.error).toBeUndefined();
    },
  );

  it.each([
    ['with no turn in flight', false],
    ['while a later retry is still preparing', true],
  ])(
    '(2) a stop of a dropped generation still owes the abort of a lost retry %s',
    async (_label, preparing) => {
      let prepared = 0;
      const h = createHarness({
        prepareRequest: () => {
          prepared += 1;
          if (prepared > 2) {
            return new Promise<never>(() => undefined);
          }
          return { payload, messages: [userMessage, placeholder], responseMessageId: 'response-1' };
        },
      });
      await states.detached(h);
      h.transport.sendMessages.mockRejectedValueOnce(networkError());
      send(h);
      await flush();
      if (preparing) {
        send(h);
        await flush();
      }

      await expect(h.chat.stop()).resolves.toEqual({ status: 'unaddressable' });
      expect(h.transport.abort).toHaveBeenCalledTimes(1);
      expect(h.transport.abort).toHaveBeenCalledWith(
        expect.objectContaining({ generationCreatedAt: 100 }),
      );
    },
  );

  it('(4) a fresh reattachment that drops before a frame names its response reports none', async () => {
    const h = createHarness({ messages: [userMessage, laterMessage] });
    const stream = createStream({ streamId: 'convo-1', generationCreatedAt: 700 });
    h.transport.reconnectToStream.mockResolvedValueOnce(stream);
    h.chat.resumeStream({ streamId: 'convo-1' }).then(
      () => undefined,
      () => undefined,
    );
    await flush();
    stream.push(dropEvent);
    await flush();

    expect(h.finishes).toHaveLength(1);
    expect(h.finishes[0]).toMatchObject({ isResponseUnknown: true, message: undefined });
  });
});

/** Where a host callback or transport method can throw once a request owns the chat. */
type Fault = { fault: boolean };

const throwing = (f: Fault, what: string) => {
  if (f.fault) {
    f.fault = false;
    throw new Error(`${what} failed`);
  }
};

const settles = async (pending: Promise<unknown>) => {
  let done = false;
  pending.then(
    () => (done = true),
    () => (done = true),
  );
  await flush();
  return done;
};

const freeAfter = async (h: Harness) => {
  attach(h, createStream({ streamId: 'convo-1', generationCreatedAt: 900 }));
  const next = h.chat.sendMessage({ parts: [{ type: 'text', text: 'Next' }] });
  next.then(
    () => undefined,
    () => undefined,
  );
  await flush();
  return h.chat.status === 'submitted' || h.chat.status === 'streaming';
};

describe('Chat exception safety', () => {
  it.each([
    ['prepareRequest throws', 'prepare-sync'],
    ['prepareRequest rejects', 'prepare-async'],
    ['transport.sendMessages throws', 'send'],
  ])('(5) a start whose %s settles and frees the chat', async (_label, where) => {
    const f: Fault = { fault: true };
    const h = createHarness({
      prepareRequest: () => {
        if (where === 'prepare-sync') {
          throwing(f, 'prepare');
        }
        if (where === 'prepare-async' && f.fault) {
          f.fault = false;
          return Promise.reject(new Error('prepare failed')) as never;
        }
        return { payload, messages: [userMessage, placeholder], responseMessageId: 'response-1' };
      },
    });
    if (where === 'send') {
      h.transport.sendMessages.mockImplementationOnce(() => {
        throw new Error('send failed');
      });
    }

    expect(await settles(h.chat.sendMessage({ parts: [{ type: 'text', text: 'Hi' }] }))).toBe(true);
    expect(await freeAfter(h)).toBe(true);
  });

  it('(5) a reattachment whose resume selection throws keeps the dropped generation stoppable', async () => {
    const f: Fault = { fault: false };
    const h = createHarness({
      resumeSelection: () => {
        throwing(f, 'selection');
        return { endpoint: 'agents' };
      },
    });
    await states.detached(h);
    f.fault = true;

    expect(await settles(h.chat.resumeStream({ streamId: 'convo-1' }))).toBe(true);
    await h.chat.stop();
    expect(h.transport.abort).toHaveBeenCalledWith(
      expect.objectContaining({ generationCreatedAt: 100 }),
    );
  });

  it('(5) a reattachment whose transport.reconnectToStream throws settles and frees the chat', async () => {
    const h = createHarness();
    h.transport.reconnectToStream.mockImplementationOnce(() => {
      throw new Error('reconnect failed');
    });

    expect(await settles(h.chat.resumeStream({ streamId: 'convo-1' }))).toBe(true);
    expect(await freeAfter(h)).toBe(true);
  });

  it('(5) a frame whose applyEvent throws keeps its generation stoppable', async () => {
    const f: Fault = { fault: false };
    const h = createHarness({
      applyEvent: () => {
        throwing(f, 'apply');
      },
    });
    await states.attached(h);
    f.fault = true;
    h.stream?.push(stepEvent);
    await flush();

    expect(h.chat.status).toBe('error');
    await h.chat.stop();
    expect(h.transport.abort).toHaveBeenCalledWith(
      expect.objectContaining({ generationCreatedAt: 100 }),
    );
  });

  it('(5) a stop whose transport.abort throws leaves the stream attached and a later stop sends anew', async () => {
    const h = createHarness();
    await states.attached(h);
    h.transport.abort.mockImplementationOnce(() => {
      throw new Error('abort failed');
    });

    await expect(h.chat.stop()).rejects.toThrow('abort failed');
    expect(h.chat.connection).toBe('live');
    await h.chat.stop();
    expect(h.transport.abort).toHaveBeenCalledTimes(2);
  });
});

describe('Chat stops the server answers as already settled', () => {
  it('(1) an attached stop answered as settled ends the turn without its terminal frame', async () => {
    const h = createHarness();
    await states.attached(h);
    h.transport.abort.mockResolvedValueOnce({
      success: false,
      settled: true,
      terminalStatus: 'complete',
      generationProtocolVersion: 2,
    });

    expect(await settles(h.chat.stop())).toBe(true);
    expect(h.stream?.closed()).toBe(true);
    expect(h.chat.status).toBe('ready');
    expect(h.finishes[h.finishes.length - 1]).toMatchObject({ isSettled: true, isAbort: false });
  });
});

describe('Chat final frames', () => {
  const complete: TMessage = { ...placeholder, messageId: 'response-new', text: 'Whole' };

  it.each([
    [
      'a partial row it does not hold, which it leaves out',
      { messageId: 'response-new', text: 'Part' },
      false,
    ],
    ['a complete row it does not hold, which it appends', complete, true],
  ])('(6) a final frame with %s', async (_label, responseMessage, appended) => {
    const h = createHarness();
    await states.attached(h);
    h.stream?.push(finalEvent({ responseMessage: responseMessage as TMessage }));
    await flush();

    expect(h.chat.messages.some((message) => message.messageId === 'response-new')).toBe(appended);
    expect(h.chat.messages.every((message) => typeof message.isCreatedByUser === 'boolean')).toBe(
      true,
    );
  });

  it('(6) a final frame with a partial row it holds merges the fields it carries', async () => {
    const h = createHarness();
    await states.attached(h);
    h.stream?.push(
      finalEvent({ responseMessage: { messageId: 'response-1', text: 'Done' } as TMessage }),
    );
    await flush();

    expect(h.chat.messages.find((message) => message.messageId === 'response-1')).toMatchObject({
      text: 'Done',
      conversationId: 'convo-1',
      isCreatedByUser: false,
    });
  });
});

const createdUnder = 'convo-9';
const learns: Array<[string, (h: Harness) => Promise<void>]> = [
  [
    'a sync frame',
    async (h) => {
      const stream = createStream({ streamId: createdUnder, generationCreatedAt: 100 });
      attach(h, stream);
      send(h);
      await flush();
      stream.push({
        type: 'sync',
        data: { conversationId: createdUnder, responseMessage: placeholder },
      } as ChatEvent);
      stream.push(finalEvent());
      await flush();
    },
  ],
  [
    'a created frame',
    async (h) => {
      const stream = createStream({ streamId: createdUnder, generationCreatedAt: 100 });
      attach(h, stream);
      send(h);
      await flush();
      stream.push({
        type: 'created',
        data: { message: { ...userMessage, conversationId: createdUnder }, created: true },
      } as ChatEvent);
      stream.push(finalEvent());
      await flush();
    },
  ],
  [
    'a settled start',
    async (h) => {
      h.transport.sendMessages.mockResolvedValueOnce({
        status: 'settled',
        conversationId: createdUnder,
        generationProtocolVersion: 2,
      });
      send(h);
      await flush();
    },
  ],
];

describe('Chat conversation identity', () => {
  it.each(learns)(
    '(7) after %s names the conversation, later turns, stops and reattachments use it',
    async (_label, learn) => {
      const prepared: string[] = [];
      const h = createHarness({
        id: 'new',
        prepareRequest: (request) => {
          prepared.push(request.chatId);
          return {
            payload: { ...payload, conversationId: null } as unknown as TPayload,
            messages: [userMessage, placeholder],
            responseMessageId: 'response-1',
          };
        },
      });
      await learn(h);

      const next = createStream({ streamId: createdUnder, generationCreatedAt: 700 });
      attach(h, next);
      send(h);
      await flush();
      expect(prepared[prepared.length - 1]).toBe(createdUnder);
      expect(h.transport.sendMessages).toHaveBeenLastCalledWith(
        expect.objectContaining({ chatId: createdUnder }),
      );
      h.transport.abort.mockResolvedValueOnce({ success: true });
      next.push(dropEvent);
      await flush();
      await h.chat.stop();
      expect(h.transport.abort).toHaveBeenLastCalledWith(
        expect.objectContaining({ chatId: createdUnder }),
      );
      await h.chat.resumeStream({ streamId: createdUnder }).catch(() => undefined);
      expect(h.transport.reconnectToStream).toHaveBeenLastCalledWith(
        expect.objectContaining({ chatId: createdUnder }),
      );
    },
  );
});

describe('Chat status reads out of order', () => {
  it.each([['the dropped generation', states.detached, 50, 100]])(
    '(2) a reattachment naming a generation older than %s changes nothing',
    async (_label, state, named, kept) => {
      const h = createHarness();
      await state(h);
      const reconnects = h.transport.reconnectToStream.mock.calls.length;
      await h.chat.resumeStream({ streamId: 'convo-1', generationCreatedAt: named });

      expect(h.transport.reconnectToStream.mock.calls.length).toBe(reconnects);
      h.transport.abort.mockResolvedValueOnce({ success: true });
      await h.chat.stop();
      expect(h.transport.abort).toHaveBeenLastCalledWith(
        expect.objectContaining({ generationCreatedAt: kept }),
      );
    },
  );

  it('(5) an idle stop answers idle without reading a resume selection that throws', async () => {
    const h = createHarness({
      resumeSelection: () => {
        throw new Error('no selection');
      },
    });

    await expect(h.chat.stop()).resolves.toEqual({ status: 'idle' });
  });
});

describe('Chat answers, successors and pause order', () => {
  it('(2) a stop of an unsent retry still ends the dropped generation when its callback starts a successor', async () => {
    let prepared = 0;
    let started = false;
    const h = createHarness({
      prepareRequest: () => {
        prepared += 1;
        if (prepared > 1) {
          return new Promise<never>(() => undefined);
        }
        return { payload, messages: [userMessage, placeholder], responseMessageId: 'response-1' };
      },
    });
    await states.detached(h);
    const chat = h.chat;
    const unsubscribe = chat.subscribe(() => {
      if (!started && prepared === 2 && chat.status === 'ready') {
        started = true;
        chat.sendMessage({ parts: [{ type: 'text', text: 'Successor' }] }).then(
          () => undefined,
          () => undefined,
        );
      }
    });
    send(h);
    await flush();

    await h.chat.stop();
    unsubscribe();
    expect(started).toBe(true);
    expect(h.transport.abort).toHaveBeenCalledWith(
      expect.objectContaining({ generationCreatedAt: 100 }),
    );
  });
});

describe('Chat identity every frame carries', () => {
  const ids = { conversationId: createdUnder, responseMessageId: 'response-9' };
  const frames: Array<[string, ChatEvent, { response?: boolean; conversation?: boolean }]> = [
    [
      'activity_label',
      { type: 'activity_label', data: { index: 0, part: {}, ...ids } } as unknown as ChatEvent,
      { response: true, conversation: true },
    ],
    [
      'reasoning_label',
      { type: 'reasoning_label', data: { index: 0, ...ids } } as unknown as ChatEvent,
      { response: true, conversation: true },
    ],
    [
      'steer_applied',
      {
        type: 'steer_applied',
        data: { steerId: 's', index: 0, part: {}, ...ids },
      } as unknown as ChatEvent,
      { response: true, conversation: true },
    ],
    [
      'content',
      {
        type: 'content',
        data: {
          index: 0,
          type: 'text',
          text: 'x',
          messageId: 'response-9',
          conversationId: createdUnder,
        },
      } as unknown as ChatEvent,
      { response: true, conversation: true },
    ],
    [
      'text',
      { type: 'text', data: { text: 'x', messageId: 'response-9' } } as unknown as ChatEvent,
      { response: true },
    ],
    [
      'title',
      {
        type: 'title',
        data: { event: 'title', data: { conversationId: createdUnder, title: 'T' } },
      } as ChatEvent,
      { conversation: true },
    ],
    [
      'steer_updated',
      { type: 'steer_updated', data: { conversationId: createdUnder } } as unknown as ChatEvent,
      { conversation: true },
    ],
  ];

  it.each(frames)('(4)(7) the %s frame names what it carries', async (_label, frame, names) => {
    const named: TMessage = { ...placeholder, messageId: 'response-9', text: 'Named' };
    const h = createHarness({
      id: 'new',
      messages: [userMessage, named, { ...placeholder, messageId: 'other' }],
    });
    const stream = createStream({ streamId: createdUnder, generationCreatedAt: 700 });
    h.transport.reconnectToStream.mockResolvedValueOnce(stream);
    h.chat.resumeStream({ streamId: createdUnder }).then(
      () => undefined,
      () => undefined,
    );
    await flush();
    stream.push(frame);
    await flush();
    stream.push({ type: 'error', data: 'failed' } as ChatEvent);
    await flush();

    const last = h.finishes[h.finishes.length - 1];
    if (names.response) {
      expect(last).toMatchObject({ isResponseUnknown: false });
      expect(last.message?.messageId).toBe('response-9');
    }
    if (names.conversation) {
      attach(h, createStream({ streamId: createdUnder, generationCreatedAt: 800 }));
      send(h);
      await flush();
      expect(h.transport.sendMessages).toHaveBeenLastCalledWith(
        expect.objectContaining({ chatId: createdUnder }),
      );
    }
  });
});

describe('Chat late answers and lost starts', () => {
  it('(2) a stop of an unsent retry still owes the lost start when a callback starts another turn', async () => {
    let prepared = 0;
    let started = false;
    const h = createHarness({
      prepareRequest: () => {
        prepared += 1;
        if (prepared > 1) {
          return new Promise<never>(() => undefined);
        }
        return { payload, messages: [userMessage, placeholder], responseMessageId: 'response-1' };
      },
    });
    await lost(h);
    const chat = h.chat;
    const unsubscribe = chat.subscribe(() => {
      if (!started && prepared === 2 && chat.status !== 'submitted') {
        started = true;
        chat.sendMessage({ parts: [{ type: 'text', text: 'Successor' }] }).then(
          () => undefined,
          () => undefined,
        );
      }
    });
    send(h);
    await flush();

    await expect(h.chat.stop()).resolves.toEqual({ status: 'unaddressable' });
    unsubscribe();
    expect(started).toBe(true);
  });

  it.each([
    ['settled', { status: 'settled', conversationId: createdUnder, generationProtocolVersion: 2 }],
    [
      'replaced',
      {
        status: 'replaced',
        conversationId: createdUnder,
        streamId: 'stream-2',
        generationCreatedAt: 200,
        generationProtocolVersion: 2,
      },
    ],
  ])(
    '(7) a cancelled first turn answered late as %s carries the conversation into the next turn',
    async (_label, late) => {
      const h = createHarness({
        id: 'new',
        prepareRequest: () => ({
          payload: { ...payload, conversationId: null } as unknown as TPayload,
          messages: [userMessage, placeholder],
          responseMessageId: 'response-1',
        }),
      });
      let answer: (() => void) | undefined;
      h.transport.sendMessages.mockImplementationOnce(
        () => new Promise((resolve) => (answer = () => resolve(late as never))),
      );
      send(h);
      await flush();
      await h.chat.stop();
      answer?.();
      await flush();

      attach(h, createStream({ streamId: createdUnder, generationCreatedAt: 900 }));
      send(h);
      await flush();
      expect(h.transport.sendMessages).toHaveBeenLastCalledWith(
        expect.objectContaining({ chatId: createdUnder }),
      );
    },
  );
});

describe('Chat stops while a lost start is owed', () => {
  it('(2) a stop of a reattachment still owes the lost start', async () => {
    const h = createHarness();
    await lost(h);
    h.transport.reconnectToStream.mockImplementationOnce(() => new Promise(() => undefined));
    h.chat.resumeStream({ streamId: 'convo-1', generationCreatedAt: 500 }).then(
      () => undefined,
      () => undefined,
    );
    await flush();
    h.transport.abort.mockResolvedValueOnce({ success: true });

    await expect(h.chat.stop()).resolves.toEqual({ status: 'unaddressable' });
  });

  it('(2) an Assistants stop answer without a conversation still resolves the stop', async () => {
    const h = createHarness();
    await states.attached(h);
    h.transport.abort.mockResolvedValueOnce({
      final: true,
      runMessages: [],
    } as unknown as ChatAbortResult);

    await expect(h.chat.stop()).resolves.toEqual({ status: 'stopped' });
  });
});

describe('Chat reattachments that fail over HTTP', () => {
  it('(2) a reattachment that fails with an HTTP status keeps its generation stoppable', async () => {
    const h = createHarness();
    const stream = createStream({ streamId: 'convo-1', generationCreatedAt: 700 });
    h.transport.reconnectToStream.mockResolvedValueOnce(stream);
    h.chat.resumeStream({ streamId: 'convo-1', generationCreatedAt: 700 }).then(
      () => undefined,
      () => undefined,
    );
    await flush();
    stream.push({ type: 'error', status: 502, data: 'Bad gateway' } as ChatEvent);
    await flush();

    expect(h.finishes[h.finishes.length - 1]).toMatchObject({ isDisconnect: true });
    h.transport.abort.mockResolvedValueOnce({ success: true });
    await h.chat.stop();
    expect(h.transport.abort).toHaveBeenCalledWith(
      expect.objectContaining({ generationCreatedAt: 700 }),
    );
  });
});

describe('Chat lost starts and conflict probes', () => {
  it('(2) a retry stopped before it is sent keeps the lost start failure', async () => {
    let prepared = 0;
    const h = createHarness({
      prepareRequest: () => {
        prepared += 1;
        if (prepared > 1) {
          return new Promise<never>(() => undefined);
        }
        return { payload, messages: [userMessage, placeholder], responseMessageId: 'response-1' };
      },
    });
    await lost(h);
    send(h);
    await flush();

    await expect(h.chat.stop()).resolves.toEqual({ status: 'unaddressable' });
    expect(h.chat.status).toBe('error');
    expect(h.chat.error).toBeDefined();
  });
});

describe('Chat disposed while a confirmed stop ends its request', () => {
  it.each([0, 1, 2, 3, 4, 6, 8, 12])(
    '(3) a chat disposed %i microtasks into the answer to a stop of a failed reattachment writes no state',
    async (ticks) => {
      const h = createHarness();
      await states.reattaching(h);
      let answerStop: (() => void) | undefined;
      h.transport.abort.mockImplementation(
        () =>
          new Promise((resolve) => {
            answerStop = () =>
              resolve({
                final: true,
                conversation: {},
                runMessages: [userMessage],
              } as unknown as ChatAbortResult);
          }),
      );
      h.chat.stop().then(
        () => undefined,
        () => undefined,
      );
      await flush();
      h.fail?.();
      await flush();
      expect(h.chat.status).toBe('error');

      answerStop?.();
      for (let i = 0; i < ticks; i++) {
        await Promise.resolve();
      }
      const { status, error } = h.chat;
      h.chat.dispose();
      await flush();

      expect(h.chat.status).toBe(status);
      expect(h.chat.error).toBe(error);
    },
  );

  it.each([0, 1, 2, 3, 4, 6, 8, 12])(
    '(3) a chat disposed %i microtasks into the Assistants answer to a stop of a dropped generation writes no state',
    async (ticks) => {
      const h = createHarness();
      await states.detached(h);
      expect(h.chat.status).toBe('error');
      let answerStop: (() => void) | undefined;
      h.transport.abort.mockImplementation(
        () =>
          new Promise((resolve) => {
            answerStop = () =>
              resolve({
                final: true,
                conversation: {},
                runMessages: [userMessage],
              } as unknown as ChatAbortResult);
          }),
      );
      h.chat.stop().then(
        () => undefined,
        () => undefined,
      );
      await flush();

      answerStop?.();
      for (let i = 0; i < ticks; i++) {
        await Promise.resolve();
      }
      const { status, error, messages } = h.chat;
      h.chat.dispose();
      await flush();

      expect(h.chat.status).toBe(status);
      expect(h.chat.error).toBe(error);
      expect(h.chat.messages).toBe(messages);
    },
  );

  /**
   * The reconnect opens a newer generation up to four microtasks after the answer, while the merge
   * of its run messages waits its turn; later than that, the stop has already ended the request.
   */
  it.each([0, 1, 2, 3, 4])(
    '(1) a stop answer with run messages leaves a generation its reattachment opened %i microtasks later running',
    async (ticks) => {
      const h = createHarness();
      await states.detached(h);
      let answerStop: (() => void) | undefined;
      h.transport.abort.mockImplementation(
        () =>
          new Promise((resolve) => {
            answerStop = () =>
              resolve({
                final: true,
                conversation: {},
                runMessages: [userMessage],
              } as unknown as ChatAbortResult);
          }),
      );
      const other = createStream({ streamId: 'convo-1', generationCreatedAt: 300 });
      let openOther: (() => void) | undefined;
      h.transport.reconnectToStream.mockImplementation(
        () => new Promise((resolve) => (openOther = () => resolve(other))),
      );
      h.chat.resumeStream({ streamId: 'convo-1' }).then(
        () => undefined,
        () => undefined,
      );
      await flush();
      h.chat.stop().then(
        () => undefined,
        () => undefined,
      );
      await flush();

      answerStop?.();
      for (let i = 0; i < ticks; i++) {
        await Promise.resolve();
      }
      openOther?.();
      await flush();
      other.push(stepEvent);
      await flush();

      expect(other.closed()).toBe(false);
      expect(h.chat.status).toBe('streaming');
      expect(h.chat.connection).toBe('live');
    },
  );
});

/**
 * Every way a stop ends a request, and whether the host is asked to reload (`isSettled`). The rule:
 * a stop the server confirmed reloads whenever no terminal frame delivered what it saved; a frame
 * that did deliver it, a stop the server never answered, and a stop it refused do not.
 */
type StopExit = {
  /** The last finish, or `null` when the exit must not finish the turn. */
  last: Partial<
    Pick<ChatFinishResult, 'isAbort' | 'isDisconnect' | 'isError' | 'isSettled'>
  > | null;
  /** The stop's own result: `ok`, `unaddressable`, or a rejection message fragment. */
  outcome: string;
};

const stopExits: Array<[string, (h: Harness) => Promise<void>, StopExit]> = [
  [
    'live: the abort frame delivers the saved response',
    async (h) => {
      await states.attached(h);
      await events.stop(h);
    },
    { last: aborted, outcome: 'ok' },
  ],
  [
    'live: the stream drops before the abort frame',
    async (h) => {
      await states.attached(h);
      h.transport.abort.mockImplementation(async () => {
        h.stream?.push(dropEvent);
        return { success: true };
      });
      await events.stop(h);
    },
    { last: stoppedUnframed, outcome: 'ok' },
  ],
  [
    'live: the server could not save the stop, and its reconcile frame says so',
    async (h) => {
      await states.attached(h);
      await events.unsavedStop(h);
    },
    { last: unsaved, outcome: 'ok' },
  ],
  [
    'live: the run had already settled on its own',
    async (h) => {
      await states.attached(h);
      await events.settledStop(h);
    },
    { last: settled, outcome: 'ok' },
  ],
  [
    'live: the server no longer knows the run (404)',
    async (h) => {
      await states.attached(h);
      await events.goneStop(h);
    },
    { last: settled, outcome: 'ok' },
  ],
  [
    'reattaching: the stop is confirmed before the stream opens',
    async (h) => {
      await states.reattaching(h);
      await events.stop(h);
    },
    { last: stoppedUnframed, outcome: 'ok' },
  ],
  [
    'empty reconnect: the reconnect finds nothing after the stop was confirmed',
    async (h) => {
      await states.detached(h);
      let opened: ((stream: null) => void) | undefined;
      h.transport.reconnectToStream.mockImplementation(
        () =>
          new Promise((resolve) => {
            opened = resolve;
          }),
      );
      let answer: (() => void) | undefined;
      h.transport.abort.mockImplementation(
        () =>
          new Promise((resolve) => {
            answer = () => resolve({ success: true });
          }),
      );
      const resumed = h.chat.resumeStream({ streamId: 'convo-1', generationCreatedAt: 100 });
      await flush();
      const stopping = record(h, h.chat.stop());
      await flush();
      opened?.(null);
      await flush();
      answer?.();
      await stopping;
      await resumed.catch(() => undefined);
      await flush();
    },
    { last: stoppedUnframed, outcome: 'ok' },
  ],
  [
    'detached: the dropped generation is stopped',
    async (h) => {
      await states.detached(h);
      await events.stop(h);
    },
    { last: stoppedUnframed, outcome: 'ok' },
  ],
  [
    'detached: the dropped generation had already settled',
    async (h) => {
      await states.detached(h);
      await events.settledStop(h);
    },
    { last: settled, outcome: 'ok' },
  ],
  [
    'never answered: the start lost its response, so the stop cannot name it',
    async (h) => {
      await states.starting(h);
      await events.stop(h);
    },
    { last: dropped, outcome: 'unaddressable' },
  ],
  [
    'never sent: the turn is stopped while the host still prepares it',
    async (h) => {
      await states.preparing(h);
      await events.stop(h);
      h.open?.();
      await flush();
    },
    { last: aborted, outcome: 'ok' },
  ],
  [
    'network drop: the stop request itself fails, so the run is left streaming',
    async (h) => {
      await states.attached(h);
      h.transport.abort.mockRejectedValue(networkError());
      await events.stop(h);
    },
    { last: null, outcome: 'Network Error' },
  ],
  [
    'refused: the server answers the stop without stopping the run',
    async (h) => {
      await states.attached(h);
      h.transport.abort.mockResolvedValue({ success: false, error: 'The stop was refused' });
      await events.stop(h);
    },
    { last: null, outcome: 'The stop was refused' },
  ],
];

describe('Chat stop exits and the reload signal', () => {
  it.each(stopExits)('%s', async (_exit, drive, expected) => {
    const h = createHarness();
    await drive(h);

    expect(h.outcome).toContain(expected.outcome);
    if (expected.last === null) {
      expect(h.finishes).toHaveLength(0);
      return;
    }
    expect(h.finishes[h.finishes.length - 1]).toMatchObject(expected.last);
  });
});

/** Table 2: every path a lost start can take, and what a stop answers after it. */
describe('Chat lost-start resolution', () => {
  const lose = async (h: Harness) => {
    h.transport.sendMessages.mockRejectedValueOnce(networkError());
    await h.chat.sendMessage({ parts: [{ type: 'text', text: 'Hi' }] });
  };

  const rows: Array<[string, string, (h: Harness) => Promise<void>, ChatStopResult['status']]> = [
    [
      'a reconnect the server answers for its conversation',
      'convo-1',
      async (h) => {
        h.transport.reconnectToStream.mockResolvedValueOnce(null);
        await h.chat.resumeStream({ streamId: 'convo-1' });
        await flush();
      },
      'idle',
    ],
    [
      'a reconnect while it was sent under `new`',
      'new',
      async (h) => {
        h.transport.reconnectToStream.mockResolvedValueOnce(null);
        await h.chat.resumeStream({ streamId: 'convo-9' });
        await flush();
      },
      'unaddressable',
    ],
    ['the chat is disposed', 'convo-1', async (h) => h.chat.dispose(), 'idle'],
  ];

  it.each(rows)('after %s', async (_path, id, drive, expected) => {
    const h = createHarness({ id });
    await lose(h);
    await drive(h);

    expect((await h.chat.stop()).status).toBe(expected);
  });
});

/**
 * Table 3: every place the core notifies subscribers. The rule: a request installs its ownership
 * (the active record, or the pause it is answering) before any notify, and an entry point that
 * notifies before it owns the chat rechecks afterwards, so a subscriber that starts a turn is
 * neither overwritten nor run twice.
 */
describe('Chat notify ordering and request ownership', () => {
  const startOnNotify = (h: Harness, when: () => boolean) => {
    const attempt: { started?: boolean; sent?: Promise<void>; error?: string } = {};
    const unsubscribe = h.chat.subscribe(() => {
      if (attempt.started || !when()) {
        return;
      }
      /** Set before the call, since the turn it starts notifies of its own status first. */
      attempt.started = true;
      attempt.sent = h.chat.sendMessage({ parts: [{ type: 'text', text: 'Queued' }] });
      attempt.sent.catch((error: Error) => {
        attempt.error = error.message;
      });
    });
    return { attempt, unsubscribe };
  };

  it('a request owns the chat before it notifies that it was submitted', async () => {
    const h = createHarness();
    attach(h, createStream({ streamId: 'convo-1', generationCreatedAt: 100 }));
    const { attempt, unsubscribe } = startOnNotify(h, () => h.chat.status === 'submitted');
    send(h);
    await flush();
    unsubscribe();

    expect(attempt.error).toContain('already in flight');
    expect(h.transport.sendMessages).toHaveBeenCalledTimes(1);
  });

  it('a reattachment yields to a turn the host starts while it selects the endpoint', async () => {
    let started = false;
    const h = createHarness({
      resumeSelection: () => {
        if (!started) {
          started = true;
          send(h);
        }
        return { endpoint: 'agents' };
      },
    });
    attach(h, createStream({ streamId: 'convo-1', generationCreatedAt: 100 }));
    await h.chat.resumeStream({ streamId: 'convo-1' });
    await flush();

    expect(h.transport.reconnectToStream).not.toHaveBeenCalled();
    expect(h.transport.sendMessages).toHaveBeenCalledTimes(1);
  });

  it('a streamed frame notifies while the request still owns the chat', async () => {
    const h = createHarness();
    attach(h, createStream({ streamId: 'convo-1', generationCreatedAt: 100 }));
    send(h);
    await flush();
    const { attempt, unsubscribe } = startOnNotify(h, () => h.chat.status === 'streaming');
    h.stream?.push(stepEvent);
    await flush();
    unsubscribe();

    expect(attempt.error).toContain('already in flight');
    expect(h.transport.sendMessages).toHaveBeenCalledTimes(1);
  });

  it('a turn that ends notifies after it released the chat, so the next turn owns it', async () => {
    const h = createHarness();
    await states.attached(h);
    const next = createStream({ streamId: 'convo-1', generationCreatedAt: 300 });
    const { attempt, unsubscribe } = startOnNotify(h, () => h.chat.status === 'ready');
    h.transport.sendMessages.mockResolvedValueOnce({ status: 'stream', stream: next });
    h.stream?.push(finalEvent());
    await flush();
    unsubscribe();

    expect(attempt.error).toBeUndefined();
    expect(h.chat.status).toBe('submitted');
    expect(h.transport.sendMessages).toHaveBeenCalledTimes(2);
  });

  it('a stop of a dropped generation notifies after it let the chat go, so the next turn owns it', async () => {
    const h = createHarness();
    await states.detached(h);
    const next = createStream({ streamId: 'convo-1', generationCreatedAt: 300 });
    h.transport.sendMessages.mockResolvedValueOnce({ status: 'stream', stream: next });
    const { attempt, unsubscribe } = startOnNotify(h, () => h.chat.status === 'ready');
    await h.chat.stop();
    await flush();
    unsubscribe();

    expect(attempt.error).toBeUndefined();
    expect(h.chat.status).toBe('submitted');
  });

  it('a dispose notifies after the chat is disposed, so a turn a subscriber starts is refused', async () => {
    const h = createHarness();
    await states.attached(h);
    const { attempt, unsubscribe } = startOnNotify(h, () => true);
    h.chat.dispose();
    await flush();
    unsubscribe();

    expect(attempt.error ?? 'none').not.toBe('none');
    expect(h.transport.sendMessages).toHaveBeenCalledTimes(1);
  });

  it('leaves the chat to a turn the host starts while it selects the endpoint of a reattachment', async () => {
    let started: Promise<void> | undefined;
    const h = createHarness({
      resumeSelection: () => {
        started ??= h.chat.sendMessage({ parts: [{ type: 'text', text: 'Hi' }] });
        return { endpoint: 'agents' };
      },
    });
    attach(h, createStream({ streamId: 'convo-1', generationCreatedAt: 100 }));

    await h.chat.resumeStream({ streamId: 'convo-1' });
    await flush();

    expect(h.transport.reconnectToStream).not.toHaveBeenCalled();
    expect(h.transport.sendMessages).toHaveBeenCalledTimes(1);
    h.stream?.push(finalEvent());
    await started;
    expect(h.finishes).toHaveLength(1);
  });
});

const liveLearns: Array<[string, (h: Harness) => Promise<void>]> = [
  [
    'a sync frame',
    async (h) => {
      const stream = createStream({ streamId: createdUnder, generationCreatedAt: 100 });
      attach(h, stream);
      send(h);
      await flush();
      stream.push({
        type: 'sync',
        data: { conversationId: createdUnder, responseMessage: placeholder },
      } as ChatEvent);
      stream.push(finalEvent());
      await flush();
    },
  ],
  [
    'a created frame',
    async (h) => {
      const stream = createStream({ streamId: createdUnder, generationCreatedAt: 100 });
      attach(h, stream);
      send(h);
      await flush();
      stream.push({
        type: 'created',
        data: { message: { ...userMessage, conversationId: createdUnder }, created: true },
      } as ChatEvent);
      stream.push(finalEvent());
      await flush();
    },
  ],
  [
    'a settled start',
    async (h) => {
      h.transport.sendMessages.mockResolvedValueOnce({
        status: 'settled',
        conversationId: createdUnder,
        generationProtocolVersion: 2,
      });
      send(h);
      await flush();
    },
  ],
];

describe('Chat conversation identity on a live turn', () => {
  it.each(liveLearns)(
    '(7) after %s names the conversation, later turns and stops use it',
    async (_label, learn) => {
      const prepared: string[] = [];
      const h = createHarness({
        id: 'new',
        prepareRequest: (request) => {
          prepared.push(request.chatId);
          return {
            payload: { ...payload, conversationId: null } as unknown as TPayload,
            messages: [userMessage, placeholder],
            responseMessageId: 'response-1',
          };
        },
      });
      await learn(h);

      const next = createStream({ streamId: createdUnder, generationCreatedAt: 700 });
      attach(h, next);
      send(h);
      await flush();
      expect(prepared[prepared.length - 1]).toBe(createdUnder);
      expect(h.transport.sendMessages).toHaveBeenLastCalledWith(
        expect.objectContaining({ chatId: createdUnder }),
      );
      await h.chat.stop();
      expect(h.transport.abort).toHaveBeenLastCalledWith(
        expect.objectContaining({ chatId: createdUnder }),
      );
    },
  );
});

describe('Chat identity every frame carries on a live turn', () => {
  const ids = { conversationId: createdUnder, responseMessageId: 'response-9' };
  const frames: Array<[string, ChatEvent, { response?: boolean; conversation?: boolean }]> = [
    [
      'activity_label',
      { type: 'activity_label', data: { index: 0, part: {}, ...ids } } as unknown as ChatEvent,
      { response: true, conversation: true },
    ],
    [
      'reasoning_label',
      { type: 'reasoning_label', data: { index: 0, ...ids } } as unknown as ChatEvent,
      { response: true, conversation: true },
    ],
    [
      'steer_applied',
      {
        type: 'steer_applied',
        data: { steerId: 's', index: 0, part: {}, ...ids },
      } as unknown as ChatEvent,
      { response: true, conversation: true },
    ],
    [
      'content',
      {
        type: 'content',
        data: {
          index: 0,
          type: 'text',
          text: 'x',
          messageId: 'response-9',
          conversationId: createdUnder,
        },
      } as unknown as ChatEvent,
      { response: true, conversation: true },
    ],
    [
      'text',
      { type: 'text', data: { text: 'x', messageId: 'response-9' } } as unknown as ChatEvent,
      { response: true },
    ],
    [
      'title',
      {
        type: 'title',
        data: { event: 'title', data: { conversationId: createdUnder, title: 'T' } },
      } as ChatEvent,
      { conversation: true },
    ],
    [
      'steer_updated',
      { type: 'steer_updated', data: { conversationId: createdUnder } } as unknown as ChatEvent,
      { conversation: true },
    ],
  ];

  it.each(frames)(
    '(4)(7) the %s frame on a live turn names what it carries',
    async (_label, frame, names) => {
      const named: TMessage = { ...placeholder, messageId: 'response-9', text: 'Named' };
      const h = createHarness({
        id: 'new',
        messages: [userMessage, named, { ...placeholder, messageId: 'other' }],
        prepareRequest: () => ({
          payload: { ...payload, conversationId: null } as unknown as TPayload,
        }),
      });
      const stream = createStream({ streamId: createdUnder, generationCreatedAt: 700 });
      attach(h, stream);
      send(h);
      await flush();
      stream.push(frame);
      await flush();
      stream.push({ type: 'error', data: 'failed' } as ChatEvent);
      await flush();

      const last = h.finishes[h.finishes.length - 1];
      if (names.response) {
        expect(last).toMatchObject({ isResponseUnknown: false });
        expect(last.message?.messageId).toBe('response-9');
      }
      if (names.conversation) {
        attach(h, createStream({ streamId: createdUnder, generationCreatedAt: 800 }));
        send(h);
        await flush();
        expect(h.transport.sendMessages).toHaveBeenLastCalledWith(
          expect.objectContaining({ chatId: createdUnder }),
        );
      }
    },
  );
});

describe('Chat disposed while a confirmed stop of a live turn ends its request', () => {
  it.each([0, 1, 2, 3, 4, 6, 8, 12])(
    '(3) a chat disposed %i microtasks into the Assistants answer to a stop of a live turn writes no state',
    async (ticks) => {
      const h = createHarness();
      await states.attached(h);
      let answerStop: (() => void) | undefined;
      h.transport.abort.mockImplementation(
        () =>
          new Promise((resolve) => {
            answerStop = () =>
              resolve({
                final: true,
                conversation: {},
                runMessages: [userMessage],
              } as unknown as ChatAbortResult);
          }),
      );
      let stopped = false;
      h.chat.stop().then(
        () => {
          stopped = true;
        },
        () => {
          stopped = true;
        },
      );
      await flush();

      answerStop?.();
      for (let i = 0; i < ticks; i++) {
        await Promise.resolve();
      }
      const { status, error, messages } = h.chat;
      h.chat.dispose();
      await flush();

      expect(stopped).toBe(true);
      expect(h.chat.status).toBe(status);
      expect(h.chat.error).toBe(error);
      expect(h.chat.messages).toBe(messages);
    },
  );
});

describe('Chat stop answers for a start answered late', () => {
  it('(7) a late stream under `new` stopped by its own stop answer names the conversation the next turn uses', async () => {
    const h = createHarness({
      id: 'new',
      prepareRequest: () => ({
        payload: { ...payload, conversationId: null } as unknown as TPayload,
        messages: [userMessage, placeholder],
        responseMessageId: 'response-1',
      }),
    });
    let answer: ((result: ChatSendResult) => void) | undefined;
    h.transport.sendMessages.mockImplementationOnce(
      () =>
        new Promise<ChatSendResult>((resolve) => {
          answer = resolve;
        }),
    );
    const first = h.chat.sendMessage({ parts: [{ type: 'text', text: 'Hi' }] });
    await flush();
    expect((await h.chat.stop()).status).toBe('unaddressable');
    await first;
    h.transport.abort.mockResolvedValueOnce({ success: true, aborted: createdUnder });
    answer?.({ status: 'stream', stream: createStream({ streamId: createdUnder }) });
    await flush();

    expect(h.chat.conversationId).toBe(createdUnder);
    expect(h.chat.status).toBe('ready');
  });
});

describe('Chat replacements and the notifications their rollback sends', () => {
  it('a stop a subscriber sends while the replaced turn is undone reaches the replacement', async () => {
    const h = createHarness();
    h.transport.sendMessages.mockResolvedValueOnce({
      status: 'replaced',
      generationProtocolVersion: 2,
      conversationId: 'convo-1',
      streamId: 'stream-2',
      generationCreatedAt: 200,
    });
    h.transport.reconnectToStream.mockImplementationOnce(() => new Promise(() => undefined));
    h.transport.abort.mockResolvedValueOnce({ success: true, aborted: 'stream-2' });
    let stopping: Promise<ChatStopResult> | undefined;
    let written = false;
    const unsubscribe = h.chat.subscribe(() => {
      written ||= h.chat.messages.length > 0;
      if (!stopping && written && h.chat.messages.length === 0) {
        stopping = h.chat.stop();
      }
    });
    send(h);
    await flush();
    unsubscribe();

    expect(stopping).toBeDefined();
    expect((await stopping)?.status).toBe('stopped');
    expect(h.transport.abort).toHaveBeenCalledWith(
      expect.objectContaining({ streamId: 'stream-2', generationCreatedAt: 200 }),
    );
  });
});

describe('Chat reattachment endpoints', () => {
  it('a reattachment to a dropped generation keeps its endpoint when the host selection changed', async () => {
    let endpoint = 'agents';
    const h = createHarness({ resumeSelection: () => ({ endpoint }) });
    await states.detached(h);
    endpoint = 'assistants';
    h.transport.reconnectToStream.mockImplementationOnce(() => new Promise(() => undefined));
    h.chat.resumeStream({ streamId: 'convo-1', generationCreatedAt: 100 }).then(
      () => undefined,
      () => undefined,
    );
    await flush();
    h.transport.abort.mockResolvedValueOnce({ success: true, aborted: 'convo-1' });
    await h.chat.stop();

    expect(h.transport.abort).toHaveBeenLastCalledWith(
      expect.objectContaining({ endpoint: 'agents' }),
    );
  });

  it('a reattachment to a generation this chat did not start uses the host selection', async () => {
    const h = createHarness({ resumeSelection: () => ({ endpoint: 'assistants' }) });
    h.transport.reconnectToStream.mockImplementationOnce(() => new Promise(() => undefined));
    h.chat.resumeStream({ streamId: 'convo-1', generationCreatedAt: 100 }).then(
      () => undefined,
      () => undefined,
    );
    await flush();
    h.transport.abort.mockResolvedValueOnce({ success: true, aborted: 'convo-1' });
    await h.chat.stop();

    expect(h.transport.abort).toHaveBeenLastCalledWith(
      expect.objectContaining({ endpoint: 'assistants' }),
    );
  });
});

describe('Chat dropped generations a retry, a stop or a status read settles', () => {
  it('a stop a subscriber sends while a retry continuing the dropped generation is undone reaches it', async () => {
    const h = createHarness();
    await states.detached(h);
    const retry = createStream({ streamId: 'convo-1', generationCreatedAt: 100 });
    let answer: ((result: ChatSendResult) => void) | undefined;
    h.transport.sendMessages.mockImplementationOnce(
      () =>
        new Promise<ChatSendResult>((resolve) => {
          answer = resolve;
        }),
    );
    const sent = h.chat.sendMessage({ parts: [{ type: 'text', text: 'Again' }] });
    await flush();
    h.stream = retry;
    let stopping: Promise<ChatStopResult> | undefined;
    const unsubscribe = h.chat.subscribe(() => {
      stopping ??= h.chat.stop();
    });
    answer?.({ status: 'stream', stream: retry });
    await flush();
    unsubscribe();
    await sent;

    expect(stopping).toBeDefined();
    expect((await stopping)?.status).toBe('stopped');
    expect(h.transport.abort).toHaveBeenLastCalledWith(
      expect.objectContaining({ streamId: 'convo-1', generationCreatedAt: 100 }),
    );
  });

  it('a retry the server settles keeps the dropped generation in the stale-read history', async () => {
    const h = createHarness();
    const stream = createStream({ streamId: 'convo-1', generationCreatedAt: 300 });
    attach(h, stream);
    send(h);
    await flush();
    stream.push(stepEvent);
    await flush();
    stream.push(dropEvent);
    await flush();
    h.transport.sendMessages.mockResolvedValueOnce({
      status: 'settled',
      conversationId: 'convo-1',
      generationProtocolVersion: 2,
    });
    await h.chat.sendMessage({ parts: [{ type: 'text', text: 'Again' }] });
    await flush();
    const finishes = h.finishes.length;
    h.transport.reconnectToStream.mockClear();
    h.transport.reconnectToStream.mockResolvedValueOnce(null);
    await h.chat.resumeStream({ streamId: 'convo-1', generationCreatedAt: 200 });
    await flush();

    expect(h.transport.reconnectToStream).not.toHaveBeenCalled();
    expect(h.finishes).toHaveLength(finishes);
  });

  it('(7) a stop the server finds gone reports the conversation the dropped generation named', async () => {
    const h = createHarness({
      id: 'new',
      prepareRequest: () => ({
        payload: { ...payload, conversationId: null } as unknown as TPayload,
        messages: [userMessage, placeholder],
        responseMessageId: 'response-1',
      }),
    });
    const stream = createStream({ streamId: createdUnder, generationCreatedAt: 100 });
    attach(h, stream);
    send(h);
    await flush();
    stream.push({
      type: 'sync',
      data: { conversationId: createdUnder, responseMessage: placeholder },
    } as ChatEvent);
    await flush();
    stream.push(dropEvent);
    await flush();
    h.transport.abort.mockRejectedValueOnce(
      Object.assign(new Error('gone'), { response: { status: 404 } }),
    );
    await h.chat.stop();

    expect(h.finishes[h.finishes.length - 1]).toMatchObject({
      isSettled: true,
      conversationId: createdUnder,
    });
  });

  it('a stop that outlives a failed reconnect reports what the server saved, and leaves nothing to stop', async () => {
    const h = createHarness();
    await states.reattaching(h);
    let answerStop: (() => void) | undefined;
    h.transport.abort.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          answerStop = () =>
            resolve({ success: true, aborted: 'convo-1', persistenceFailed: true });
        }),
    );
    const stopping = h.chat.stop();
    await flush();
    h.fail?.();
    await flush();
    answerStop?.();
    await stopping;
    await flush();

    expect(h.finishes[h.finishes.length - 1]).toMatchObject({
      reconcileReason: 'abort_persistence_failed',
    });
    h.transport.abort.mockClear();
    expect((await h.chat.stop()).status).toBe('idle');
    expect(h.transport.abort).not.toHaveBeenCalled();
  });
});

/** A store that reports each field it is written, as a cache another hook also writes does. */
const createReportingState = (): ChatState => {
  const listeners = new Set<() => void>();
  const tell = () => listeners.forEach((listener) => listener());
  let messages: TMessage[] = [];
  let status: ChatStatus = 'ready';
  let error: Error | undefined;
  let connection: ChatConnection = 'idle';
  return {
    get status() {
      return status;
    },
    set status(next) {
      status = next;
      tell();
    },
    get error() {
      return error;
    },
    set error(next) {
      error = next;
      tell();
    },
    get connection() {
      return connection;
    },
    set connection(next) {
      connection = next;
      tell();
    },
    get messages() {
      return messages;
    },
    replaceMessages(next) {
      messages = next;
      tell();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
};

describe('Chat reconnects that settle a dropped generation or a lost start', () => {
  it('a stop of a dropped generation still ends it when a reattachment to it fails before the answer', async () => {
    const h = createHarness();
    await states.detached(h);
    let answerStop: (() => void) | undefined;
    h.transport.abort.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          answerStop = () =>
            resolve({ success: true, aborted: 'convo-1', persistenceFailed: true });
        }),
    );
    const stopping = h.chat.stop();
    await flush();
    h.transport.reconnectToStream.mockRejectedValueOnce(networkError());
    await h.chat.resumeStream({ streamId: 'convo-1', generationCreatedAt: 100 });
    await flush();
    answerStop?.();
    await stopping;
    await flush();

    expect(h.finishes[h.finishes.length - 1]).toMatchObject({
      reconcileReason: 'abort_persistence_failed',
    });
    expect(h.chat.status).not.toBe('error');
    h.transport.abort.mockClear();
    expect((await h.chat.stop()).status).toBe('idle');
    expect(h.transport.abort).not.toHaveBeenCalled();
  });

  it('an empty reconnect lets go of the chat before a state that reports its writes is told', async () => {
    const state = createReportingState();
    const h = createHarness({ state });
    h.transport.reconnectToStream.mockResolvedValueOnce(null);
    attach(h, createStream({ streamId: 'convo-1', generationCreatedAt: 200 }));
    let reconnecting = false;
    let sent = false;
    let refused: unknown;
    const unsubscribe = h.chat.subscribe(() => {
      reconnecting ||= h.chat.connection === 'reconnecting';
      if (reconnecting && h.chat.connection === 'idle' && !sent) {
        sent = true;
        h.chat.sendMessage({ parts: [{ type: 'text', text: 'Next' }] }).catch((error: unknown) => {
          refused = error;
        });
      }
    });
    await h.chat.resumeStream();
    await flush();
    unsubscribe();

    expect(sent).toBe(true);
    expect(refused).toBeUndefined();
    expect(h.transport.sendMessages).toHaveBeenCalledTimes(1);
  });

  it('an unnamed reconnect that releases a lost start settles it for the host to reconcile', async () => {
    const h = createHarness();
    h.transport.sendMessages.mockRejectedValueOnce(networkError());
    await h.chat.sendMessage({ parts: [{ type: 'text', text: 'Hi' }] });
    expect(h.chat.status).toBe('error');
    const finishes = h.finishes.length;
    h.transport.reconnectToStream.mockResolvedValueOnce(null);
    await h.chat.resumeStream({ streamId: 'convo-1' });
    await flush();

    expect(h.finishes).toHaveLength(finishes + 1);
    expect(h.finishes[h.finishes.length - 1]).toMatchObject({ isSettled: true });
    expect(h.chat.status).toBe('ready');
    expect((await h.chat.stop()).status).toBe('idle');
  });

  it('a stop that ends a dropped generation never shows a store a failed status without its error', async () => {
    const h = createHarness({ state: createReportingState() });
    await states.detached(h);
    expect(h.chat.status).toBe('error');
    let torn = false;
    const unsubscribe = h.chat.subscribe(() => {
      torn ||= h.chat.status === 'error' && h.chat.error === undefined;
    });
    h.transport.abort.mockResolvedValueOnce({
      final: true,
      conversation: {},
    } as unknown as ChatAbortResult);
    await h.chat.stop();
    await flush();
    unsubscribe();

    expect(torn).toBe(false);
    expect(h.chat.status).toBe('ready');
  });
});
