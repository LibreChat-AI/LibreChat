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
  ['starting', 'final', { status: 'ready', finishes: 1, last: done, abort: NONE }],
  ['starting', 'newTurn', { status: 'submitted', finishes: 0, outcome: 'in flight' }],
  [
    'starting',
    'stop',
    { status: 'error', finishes: 1, last: dropped, abort: NONE, outcome: 'unaddressable' },
  ],

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
  ['replaced', 'streamEnd', { status: 'error', finishes: 1, last: dropped }],

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
const disposedCalls: Record<string, (h: Harness) => Promise<unknown>> = {
  stop: (h) => h.chat.stop(),
  sendMessage: (h) => h.chat.sendMessage({ parts: [{ type: 'text', text: 'Hi' }] }),
};

const transportCalls = (h: Harness) =>
  h.transport.sendMessages.mock.calls.length +
  h.transport.reconnectToStream.mock.calls.length +
  h.transport.abort.mock.calls.length +
  h.transport.resume.mock.calls.length;

const disposedTable = Object.keys(states).flatMap((state) =>
  Object.keys(disposedCalls).map((call) => [state, call] as const),
);

describe('Chat invariants', () => {
  it.each(disposedTable)('(3) %s, disposed, then %s reaches no transport', async (state, call) => {
    const h = createHarness();
    await states[state](h);
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
describe('Chat late answers and lost starts', () => {
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
});

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

describe('Chat disposed while a confirmed stop ends its request', () => {
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
