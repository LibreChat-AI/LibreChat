import { StepEvents } from 'librechat-data-provider';
import type { Agents, TMessage, TPayload, ChatEvent } from 'librechat-data-provider';
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
  ChatSendResult,
  ChatConnection,
  ChatAbortResult,
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
  last?: Partial<
    Pick<ChatFinishResult, 'isAbort' | 'isDisconnect' | 'isError' | 'isSettled' | 'reconcileReason'>
  >;
  /** What `transport.abort` was asked to stop, or `null` when it was not called. */
  abort?: { streamId?: string; generationCreatedAt?: number } | null;
  action?: string | null;
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
      finishes: 2,
      last: stoppedUnframed,
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
      finishes: 1,
      last: stoppedUnframed,
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
    'detached',
    'restoreThenStop',
    {
      status: 'ready',
      finishes: 2,
      last: stoppedUnframed,
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
      finishes: 2,
      last: stoppedUnframed,
      abort: { streamId: 'convo-1', generationCreatedAt: 300 },
    },
  ],
  [
    'paused',
    'dropThenStop',
    {
      status: 'ready',
      finishes: 2,
      last: stoppedUnframed,
      action: NONE,
      abort: { streamId: 'convo-1', generationCreatedAt: 100 },
    },
  ],
  [
    'restored',
    'restoreThenStop',
    {
      status: 'ready',
      finishes: 1,
      last: stoppedUnframed,
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
  [
    'restored',
    'unsavedStop',
    {
      status: 'ready',
      finishes: 1,
      last: unsaved,
      action: NONE,
      abort: { streamId: 'convo-1', generationCreatedAt: 500 },
      outcome: 'ok',
    },
  ],
  [
    'restored',
    'settledStop',
    {
      status: 'ready',
      finishes: 1,
      last: settled,
      action: NONE,
      abort: { streamId: 'convo-1', generationCreatedAt: 500 },
      outcome: 'ok',
    },
  ],
  ['detached', 'reconnectIdle', { status: 'ready', finishes: 2, last: settled, abort: NONE }],
  /** The reconnect named generation 100, older than the restored pause's 500, so it is stale. */
  ['restored', 'reconnectIdle', { status: 'ready', finishes: 0, action: 'action-1', abort: NONE }],
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
const restoredTarget = { streamId: 'convo-1', generationCreatedAt: 500 };

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

  [
    'paused',
    'dispose',
    { status: 'streaming', connection: 'idle', finishes: 0, turn: 'settled', abort: NONE },
  ],
  [
    'paused',
    'lateAnswer',
    {
      status: 'ready',
      connection: 'idle',
      finishes: 1,
      last: aborted,
      action: NONE,
      turn: 'settled',
      abort: live,
      outcome: 'ok',
      after: 'idle',
    },
  ],
  [
    'paused',
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

  [
    'restored',
    'dispose',
    { status: 'ready', connection: 'idle', finishes: 0, action: 'action-1', abort: NONE },
  ],
  [
    'restored',
    'lateAnswer',
    {
      status: 'ready',
      finishes: 1,
      last: stoppedUnframed,
      action: NONE,
      abort: restoredTarget,
      outcome: 'ok',
      after: 'idle',
    },
  ],
  [
    'restored',
    'disposeDuringStop',
    {
      status: 'ready',
      connection: 'idle',
      finishes: 0,
      abort: restoredTarget,
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
  [
    'paused',
    'goneStop',
    {
      status: 'ready',
      connection: 'idle',
      finishes: 1,
      last: settled,
      action: NONE,
      abort: live,
      outcome: 'ok',
    },
  ],
  [
    'restored',
    'goneStop',
    {
      status: 'ready',
      finishes: 1,
      last: settled,
      action: NONE,
      abort: restoredTarget,
      outcome: 'ok',
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
    if (expected.action !== undefined) {
      expect(h.chat.pendingAction?.actionId ?? null).toBe(expected.action);
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
    if (expected.action !== undefined) {
      expect(h.chat.pendingAction?.actionId ?? null).toBe(expected.action);
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
  answer: (h) => h.chat.addToolOutput({ toolCallId: 'ask-1', output: 'A' }),
  restore: async (h) => h.chat.restorePendingAction({ ...askAction, actionId: 'action-9' }, 600),
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

const restoredResponse: TMessage = { ...placeholder, messageId: 'response-9', text: 'Paused' };
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

  it('(1) a stop of a restored pause ends the pause a refresh restored for its generation meanwhile', async () => {
    const h = createHarness();
    let answerStop: (() => void) | undefined;
    h.transport.abort.mockImplementation(
      () => new Promise((resolve) => (answerStop = () => resolve({ success: true }))),
    );
    h.chat.restorePendingAction(askAction, 500);
    const stopped = h.chat.stop();
    await flush();
    h.chat.restorePendingAction({ ...askAction, actionId: 'action-2' }, 500);
    answerStop?.();
    await stopped;

    expect(h.chat.pendingAction).toBeUndefined();
  });

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

  it.each([
    ['a streamed frame', stepEvent],
    ['a live pause', { type: 'pending_action', data: askAction } as ChatEvent],
  ])(
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

  it.each([
    ['named by the status read', 'response-9', false],
    ['the status read did not name', undefined, true],
  ])(
    '(4) an unframed stop of a restored pause reports the response %s',
    async (_label, responseMessageId, unknown) => {
      const h = createHarness({ messages: [userMessage, restoredResponse, laterMessage] });
      h.transport.abort.mockResolvedValue({
        success: true,
        generationProtocolVersion: 2,
        aborted: 'convo-1',
        persistenceFailed: true,
      });
      h.chat.restorePendingAction({ ...askAction, responseMessageId }, 500);

      await h.chat.stop();

      expect(h.finishes).toHaveLength(1);
      expect(h.finishes[0]).toMatchObject({ isResponseUnknown: unknown });
      expect(h.finishes[0].message?.messageId).toBe(responseMessageId);
    },
  );

  it('(4) a stop of a reattachment ends the pause a later status read restored for its generation', async () => {
    const h = createHarness();
    h.chat.restorePendingAction(askAction, 500);
    h.chat.restorePendingAction({ ...askAction, actionId: 'action-2' }, 500);
    h.transport.reconnectToStream.mockImplementation(() => new Promise(() => undefined));
    h.chat.resumeStream({ streamId: 'convo-1', generationCreatedAt: 500 }).then(
      () => undefined,
      () => undefined,
    );
    await flush();

    await h.chat.stop();

    expect(h.chat.pendingAction).toBeUndefined();
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

  it('(5) a reattachment whose resume selection throws keeps a restored pause', async () => {
    const f: Fault = { fault: false };
    const h = createHarness({
      resumeSelection: () => {
        throwing(f, 'selection');
        return { endpoint: 'agents' };
      },
    });
    await states.restored(h);
    f.fault = true;

    expect(
      await settles(h.chat.resumeStream({ streamId: 'convo-1', generationCreatedAt: 500 })),
    ).toBe(true);
    expect(h.chat.pendingAction?.actionId).toBe('action-1');
    await h.chat.stop();
    expect(h.transport.abort).toHaveBeenCalledWith(
      expect.objectContaining({ generationCreatedAt: 500 }),
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

  it.each([
    ['resume selection throws', 'selection'],
    ['transport.resume throws', 'resume'],
  ])('(5) an answer whose %s keeps the pause answerable', async (_label, where) => {
    const f: Fault = { fault: false };
    const h = createHarness({
      resumeSelection: () => {
        if (where === 'selection') {
          throwing(f, 'selection');
        }
        return { endpoint: 'agents' };
      },
    });
    await states.restored(h);
    f.fault = true;
    if (where === 'resume') {
      f.fault = false;
      h.transport.resume.mockImplementationOnce(() => {
        throw new Error('resume failed');
      });
    }

    await expect(h.chat.addToolOutput({ toolCallId: 'ask-1', output: 'A' })).rejects.toThrow();
    expect(h.chat.pendingAction?.actionId).toBe('action-1');
    await h.chat.addToolOutput({ toolCallId: 'ask-1', output: 'A' });
    expect(h.transport.resume).toHaveBeenCalledTimes(where === 'resume' ? 2 : 1);
  });

  it('(5) a continuation runs on the selection its answer read, so a host that throws later strands nothing', async () => {
    let calls = 0;
    const onError = jest.fn();
    const h = createHarness({
      onError,
      resumeSelection: () => {
        calls += 1;
        if (calls > 1) {
          throw new Error('selection failed');
        }
        return { endpoint: 'agents' };
      },
    });
    const continued = createStream({ streamId: 'convo-1', generationCreatedAt: 500 });
    h.transport.reconnectToStream.mockResolvedValueOnce(continued);
    const unhandled = jest.fn();
    process.on('unhandledRejection', unhandled);
    try {
      await states.restored(h);
      await h.chat.addToolOutput({ toolCallId: 'ask-1', output: 'A' });
      await flush();
      expect(unhandled).not.toHaveBeenCalled();
      expect(h.transport.reconnectToStream).toHaveBeenCalledWith(
        expect.objectContaining({ generationCreatedAt: 500 }),
      );
      h.transport.abort.mockResolvedValueOnce({ success: true });
      continued.push(stepEvent);
      await flush();
      const stopped = h.chat.stop();
      continued.push(finalEvent({ terminalStatus: 'aborted' }));
      await stopped;
      expect(h.transport.abort).toHaveBeenCalledWith(
        expect.objectContaining({ endpoint: 'agents', generationCreatedAt: 500 }),
      );
      expect(onError).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });
});

describe('Chat markers kept until a start is accepted', () => {
  it.each([
    ['whose preparation fails', 'prepare'],
    ['that loses its response', 'network'],
  ])(
    '(2) a retry %s keeps the resumed pause of the live generation stale',
    async (_label, where) => {
      const h = createHarness({
        prepareRequest: () => {
          if (where === 'prepare') {
            return Promise.reject(new Error('Upload failed')) as never;
          }
          return { payload, messages: [userMessage, placeholder], responseMessageId: 'response-1' };
        },
      });
      await states.restored(h);
      const continued = createStream({ streamId: 'convo-1', generationCreatedAt: 500 });
      h.transport.reconnectToStream.mockResolvedValueOnce(continued);
      await h.chat.addToolOutput({ toolCallId: 'ask-1', output: 'A' });
      await flush();
      continued.push(stepEvent);
      await flush();
      continued.push(dropEvent);
      await flush();
      if (where === 'network') {
        h.transport.sendMessages.mockRejectedValueOnce(networkError());
      }
      send(h);
      await flush();

      h.chat.restorePendingAction(askAction, 500);
      expect(h.chat.pendingAction).toBeUndefined();
    },
  );
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

describe('Chat status reads and lost starts', () => {
  it("(2) a status read never takes over a lost start; a stop ends the pause and still owes the start's abort", async () => {
    const h = createHarness();
    await lost(h);
    h.chat.restorePendingAction(askAction, 500);

    await expect(h.chat.stop()).resolves.toEqual({ status: 'unaddressable' });
    expect(h.transport.abort).toHaveBeenCalledWith(
      expect.objectContaining({ generationCreatedAt: 500 }),
    );
    expect(h.chat.pendingAction).toBeUndefined();
  });

  it('(2) a status read older than the dropped generation is stale and keeps it the stop target', async () => {
    const h = createHarness();
    await states.detached(h);
    h.chat.restorePendingAction(askAction, 50);

    expect(h.chat.pendingAction).toBeUndefined();
    await h.chat.stop();
    expect(h.transport.abort).toHaveBeenCalledWith(
      expect.objectContaining({ generationCreatedAt: 100 }),
    );
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
  [
    'a status read',
    async (h) => {
      h.chat.restorePendingAction({ ...askAction, conversationId: createdUnder }, 500);
      h.transport.abort.mockResolvedValueOnce({ success: true });
      await h.chat.stop();
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
  it('(2) a status read older than the restored pause is stale and keeps the newer pause', async () => {
    const h = createHarness();
    h.chat.restorePendingAction(askAction, 500);
    h.chat.restorePendingAction({ ...askAction, actionId: 'action-old' }, 400);

    expect(h.chat.pendingAction?.actionId).toBe('action-1');
    await h.chat.stop();
    expect(h.transport.abort).toHaveBeenCalledWith(
      expect.objectContaining({ generationCreatedAt: 500 }),
    );
  });

  it.each([
    ['the restored pause', states.restored, 400, 500],
    ['the dropped generation', states.detached, 50, 100],
  ])(
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

  it('(2) a status read older than a generation that already finished is stale', async () => {
    const h = createHarness();
    await states.attached(h);
    h.stream?.push(finalEvent());
    await flush();

    h.chat.restorePendingAction(askAction, 50);
    expect(h.chat.pendingAction).toBeUndefined();
  });

  it('(2) an expired status read still marks its newer generation, so an older read stays stale', async () => {
    const h = createHarness();
    h.chat.restorePendingAction(askAction, 500);
    h.chat.restorePendingAction({ ...askAction, actionId: 'action-600', expiresAt: 1 }, 600);
    h.chat.restorePendingAction({ ...askAction, actionId: 'action-550' }, 550);

    expect(h.chat.pendingAction).toBeUndefined();
  });

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
  it('(7) an answer given while the stream stays attached carries its conversation into the next turn', async () => {
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
    h.transport.resume.mockResolvedValue({
      streamId: createdUnder,
      conversationId: createdUnder,
      status: 'resuming',
    });
    const stream = createStream({ streamId: createdUnder, generationCreatedAt: 100 });
    attach(h, stream);
    send(h);
    await flush();
    stream.push({
      type: 'pending_action',
      data: { ...askAction, conversationId: undefined },
    } as ChatEvent);
    await flush();
    await h.chat.addToolOutput({ toolCallId: 'ask-1', output: 'A' });
    stream.push({ type: 'abort', data: {} } as ChatEvent);
    await flush();

    attach(h, createStream({ streamId: createdUnder, generationCreatedAt: 200 }));
    send(h);
    await flush();
    expect(prepared[prepared.length - 1]).toBe(createdUnder);
    expect(h.transport.sendMessages).toHaveBeenLastCalledWith(
      expect.objectContaining({ chatId: createdUnder }),
    );
  });

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

  it('(2) a status read of an older pause in the same generation keeps the newer one', async () => {
    const h = createHarness();
    h.chat.restorePendingAction({ ...askAction, createdAt: 3, actionId: 'action-b' }, 500);
    h.chat.restorePendingAction({ ...askAction, createdAt: 2, actionId: 'action-a' }, 500);

    expect(h.chat.pendingAction?.actionId).toBe('action-b');
  });

  it('(2) a reconnect replaying an older pause of the generation keeps the newer restored one', async () => {
    const h = createHarness();
    h.chat.restorePendingAction({ ...askAction, createdAt: 3, actionId: 'action-b' }, 500);
    const replay = createStream({ streamId: 'convo-1', generationCreatedAt: 500 });
    h.transport.reconnectToStream.mockResolvedValueOnce(replay);
    h.chat.resumeStream({ streamId: 'convo-1', generationCreatedAt: 500 }).then(
      () => undefined,
      () => undefined,
    );
    await flush();
    replay.push({
      type: 'pending_action',
      data: { ...askAction, createdAt: 2, actionId: 'action-a' },
    } as ChatEvent);
    await flush();

    expect(h.chat.pendingAction?.actionId).toBe('action-b');
  });

  it('(2) a reconnect replaying an expired newer pause clears the older restored one and stays ordered', async () => {
    const h = createHarness();
    h.chat.restorePendingAction({ ...askAction, createdAt: 2, actionId: 'action-a' }, 500);
    const replay = createStream({ streamId: 'convo-1', generationCreatedAt: 500 });
    h.transport.reconnectToStream.mockResolvedValueOnce(replay);
    h.chat.resumeStream({ streamId: 'convo-1', generationCreatedAt: 500 }).then(
      () => undefined,
      () => undefined,
    );
    await flush();
    replay.push({
      type: 'pending_action',
      data: { ...askAction, createdAt: 3, actionId: 'action-b', expiresAt: 1 },
    } as ChatEvent);
    await flush();
    expect(h.chat.pendingAction).toBeUndefined();

    replay.push({
      type: 'pending_action',
      data: { ...askAction, createdAt: 2, actionId: 'action-a' },
    } as ChatEvent);
    await flush();
    expect(h.chat.pendingAction).toBeUndefined();
  });

  it.each([
    ['a status read', 'read'],
    ['a replay', 'replay'],
  ])(
    '(2) of two pauses created in the same millisecond, the one received last stands through %s',
    async (_label, via) => {
      const h = createHarness();
      const first = { ...askAction, createdAt: 3, actionId: 'action-a' };
      const second = { ...askAction, createdAt: 3, actionId: 'action-b' };
      h.chat.restorePendingAction(second, 500);
      if (via === 'read') {
        h.chat.restorePendingAction(first, 500);
      } else {
        const replay = createStream({ streamId: 'convo-1', generationCreatedAt: 500 });
        h.transport.reconnectToStream.mockResolvedValueOnce(replay);
        h.chat.resumeStream({ streamId: 'convo-1', generationCreatedAt: 500 }).then(
          () => undefined,
          () => undefined,
        );
        await flush();
        replay.push({ type: 'pending_action', data: first } as ChatEvent);
        await flush();
      }

      expect(h.chat.pendingAction?.actionId).toBe('action-a');
    },
  );

  it.each(['ERR_NETWORK', 'ERR_INTERNET_DISCONNECTED'])(
    '(2) an answer that fails on the network (%s) reattaches to the paused generation',
    async (code) => {
      const h = createHarness();
      await states.restored(h);
      h.transport.resume.mockRejectedValueOnce(Object.assign(new Error('Network Error'), { code }));
      const continued = createStream({ streamId: 'convo-1', generationCreatedAt: 500 });
      h.transport.reconnectToStream.mockResolvedValueOnce(continued);

      await expect(h.chat.addToolOutput({ toolCallId: 'ask-1', output: 'A' })).rejects.toThrow();
      await flush();
      expect(h.transport.reconnectToStream).toHaveBeenCalledWith(
        expect.objectContaining({ generationCreatedAt: 500 }),
      );
      continued.push(stepEvent);
      await flush();
      expect(h.chat.status).toBe('streaming');
      h.transport.abort.mockResolvedValueOnce({ success: true });
      continued.push(finalEvent({ terminalStatus: 'aborted' }));
      await flush();
    },
  );

  it.each([
    ['refuses the caller', 403, {}],
    ['is not ready for yet', 409, { code: 'EVENT_ACTOR_NOT_READY' }],
  ])(
    '(2) an answer the server %s keeps the pause answerable without reattaching',
    async (_label, status, data) => {
      const h = createHarness();
      await states.restored(h);
      h.transport.resume.mockRejectedValueOnce(
        Object.assign(new Error('Refused'), { response: { status, data, headers: {} } }),
      );

      await expect(h.chat.addToolOutput({ toolCallId: 'ask-1', output: 'A' })).rejects.toThrow();
      await flush();
      expect(h.transport.reconnectToStream).not.toHaveBeenCalled();
      expect(h.chat.pendingAction?.actionId).toBe('action-1');
    },
  );

  it('(2) an expired newer pause in the same generation clears the older one held', async () => {
    const h = createHarness();
    h.chat.restorePendingAction({ ...askAction, createdAt: 2, actionId: 'action-a' }, 500);
    h.chat.restorePendingAction(
      { ...askAction, createdAt: 3, actionId: 'action-b', expiresAt: 1 },
      500,
    );

    expect(h.chat.pendingAction).toBeUndefined();
  });

  it('(2) a status read of an older pause than the one the stream delivered keeps the streamed one', async () => {
    const h = createHarness();
    await states.attached(h);
    h.stream?.push({
      type: 'pending_action',
      data: { ...askAction, createdAt: 3, actionId: 'action-b' },
    } as ChatEvent);
    await flush();
    h.stream?.push(dropEvent);
    await flush();
    h.chat.restorePendingAction({ ...askAction, createdAt: 2, actionId: 'action-a' }, 100);

    expect(h.chat.pendingAction?.actionId).toBe('action-b');
  });
});

describe('Chat sync snapshots and resume conflicts', () => {
  const snapshot = (resumeState: Record<string, unknown>) =>
    ({
      type: 'sync',
      data: { sync: true, resumeState: { runSteps: [], ...resumeState } },
    }) as ChatEvent;

  const reattached = async (h: Harness, generationCreatedAt = 500) => {
    const stream = createStream({ streamId: 'convo-1', generationCreatedAt });
    h.transport.reconnectToStream.mockResolvedValueOnce(stream);
    h.chat.resumeStream({ streamId: 'convo-1', generationCreatedAt }).then(
      () => undefined,
      () => undefined,
    );
    await flush();
    return stream;
  };

  it('(4) a sync snapshot installs the pause it carries, which can then be answered', async () => {
    const h = createHarness();
    const stream = await reattached(h);
    stream.push(snapshot({ pendingAction: askAction }));
    await flush();

    expect(h.chat.pendingAction?.actionId).toBe('action-1');
    await h.chat.addToolOutput({ toolCallId: 'ask-1', output: 'A' });
    expect(h.transport.resume).toHaveBeenCalledTimes(1);
  });

  it('(2) a sync snapshot carrying an expired newer pause clears the older one held and stays ordered', async () => {
    const h = createHarness();
    h.chat.restorePendingAction({ ...askAction, createdAt: 2, actionId: 'action-a' }, 500);
    const stream = await reattached(h);
    stream.push(
      snapshot({
        pendingAction: { ...askAction, createdAt: 3, actionId: 'action-b', expiresAt: 1 },
      }),
    );
    await flush();
    expect(h.chat.pendingAction).toBeUndefined();

    stream.push({
      type: 'pending_action',
      data: { ...askAction, createdAt: 2, actionId: 'action-a' },
    } as ChatEvent);
    await flush();
    expect(h.chat.pendingAction).toBeUndefined();
  });

  it('(4) a sync snapshot without a pause releases one answered elsewhere', async () => {
    const h = createHarness();
    h.chat.restorePendingAction(askAction, 500);
    const stream = await reattached(h);
    stream.push(snapshot({}));
    await flush();

    expect(h.chat.pendingAction).toBeUndefined();
  });

  it('(4) a pause a snapshot released and the stream reports again keeps its decisions', async () => {
    const approval = {
      ...askAction,
      payload: {
        type: 'tool_approval',
        action_requests: [{ tool_call_id: 'tool-1' }, { tool_call_id: 'tool-2' }],
      },
    } as unknown as Agents.PendingAction;
    const h = createHarness();
    h.chat.restorePendingAction(approval, 500);
    await h.chat.addToolApprovalResponse({ id: 'tool-1', approved: true });
    const stream = await reattached(h);
    stream.push(snapshot({}));
    stream.push({ type: 'pending_action', data: approval } as ChatEvent);
    await flush();
    await h.chat.addToolApprovalResponse({ id: 'tool-2', approved: true });

    expect(h.transport.resume).toHaveBeenCalledWith(
      expect.objectContaining({
        decisions: [
          expect.objectContaining({ tool_call_id: 'tool-1' }),
          expect.objectContaining({ tool_call_id: 'tool-2' }),
        ],
      }),
    );
  });

  it('(4) a pause a snapshot released and a status read restores after a drop keeps its decisions', async () => {
    const approval = {
      ...askAction,
      payload: {
        type: 'tool_approval',
        action_requests: [{ tool_call_id: 'tool-1' }, { tool_call_id: 'tool-2' }],
      },
    } as unknown as Agents.PendingAction;
    const h = createHarness();
    h.chat.restorePendingAction(approval, 500);
    await h.chat.addToolApprovalResponse({ id: 'tool-1', approved: true });
    const stream = await reattached(h);
    stream.push(snapshot({}));
    await flush();
    stream.push(dropEvent);
    await flush();
    h.chat.restorePendingAction(approval, 500);
    await h.chat.addToolApprovalResponse({ id: 'tool-2', approved: true });

    expect(h.transport.resume).toHaveBeenCalledTimes(1);
    expect(h.transport.resume).toHaveBeenCalledWith(
      expect.objectContaining({
        decisions: [
          expect.objectContaining({ tool_call_id: 'tool-1' }),
          expect.objectContaining({ tool_call_id: 'tool-2' }),
        ],
      }),
    );
  });

  it('(4) a sync snapshot names the response a later unframed end reports', async () => {
    const named: TMessage = { ...placeholder, messageId: 'response-9', text: 'Rebuilt' };
    const h = createHarness({
      messages: [userMessage, named, { ...placeholder, messageId: 'other' }],
    });
    const stream = await reattached(h, 700);
    stream.push(snapshot({ responseMessageId: 'response-9' }));
    await flush();
    stream.push(dropEvent);
    await flush();

    expect(h.finishes[h.finishes.length - 1]).toMatchObject({ isResponseUnknown: false });
    expect(h.finishes[h.finishes.length - 1].message?.messageId).toBe('response-9');
  });

  it('(7) a sync snapshot names the conversation a chat started under new adopts', async () => {
    const h = createHarness({ id: 'new' });
    const stream = createStream({ streamId: createdUnder, generationCreatedAt: 700 });
    h.transport.reconnectToStream.mockResolvedValueOnce(stream);
    h.chat.resumeStream({ streamId: createdUnder }).then(
      () => undefined,
      () => undefined,
    );
    await flush();
    stream.push(snapshot({ conversationId: createdUnder }));
    stream.push(finalEvent());
    await flush();

    attach(h, createStream({ streamId: createdUnder, generationCreatedAt: 800 }));
    send(h);
    await flush();
    expect(h.transport.sendMessages).toHaveBeenLastCalledWith(
      expect.objectContaining({ chatId: createdUnder }),
    );
  });

  it.each([
    ['a replaced run', 409, { code: 'RUN_REPLACED' }],
    ['an action answered elsewhere', 409, { error: 'No live pending action to resume' }],
    ['no paused generation', 404, { error: 'No paused generation for this conversation' }],
  ])(
    '(2) an answer refused for %s ends the pause and probes what runs now',
    async (_label, status, data) => {
      const h = createHarness();
      await states.restored(h);
      h.transport.resume.mockRejectedValueOnce(
        Object.assign(new Error('Conflict'), { response: { status, data, headers: {} } }),
      );

      await expect(h.chat.addToolOutput({ toolCallId: 'ask-1', output: 'A' })).rejects.toThrow();
      await flush();
      expect(h.chat.pendingAction).toBeUndefined();
      expect(h.transport.reconnectToStream).toHaveBeenCalledTimes(1);
      await expect(freeAfter(h)).resolves.toBe(true);
    },
  );
});

describe('Chat identity every frame carries', () => {
  const ids = { conversationId: createdUnder, responseMessageId: 'response-9' };
  const frames: Array<[string, ChatEvent, { response?: boolean; conversation?: boolean }]> = [
    [
      'pending_action',
      { type: 'pending_action', data: { ...askAction, ...ids } } as ChatEvent,
      { response: true, conversation: true },
    ],
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

describe('Chat retries that continue an answered generation', () => {
  it.each([
    ['a stream', 'stream'],
    ['a replacement', 'replaced'],
  ])(
    '(2) a retry answered with %s of the dropped generation keeps its answered pause stale',
    async (_label, kind) => {
      const h = createHarness();
      await states.restored(h);
      const continued = createStream({ streamId: 'convo-1', generationCreatedAt: 500 });
      h.transport.reconnectToStream.mockResolvedValueOnce(continued);
      await h.chat.addToolOutput({ toolCallId: 'ask-1', output: 'A' });
      await flush();
      continued.push(stepEvent);
      await flush();
      continued.push(dropEvent);
      await flush();

      const retry = createStream({ streamId: 'convo-1', generationCreatedAt: 500 });
      if (kind === 'stream') {
        h.transport.sendMessages.mockResolvedValueOnce({ status: 'stream', stream: retry });
      } else {
        h.transport.sendMessages.mockResolvedValueOnce({
          status: 'replaced',
          conversationId: 'convo-1',
          streamId: 'convo-1',
          generationCreatedAt: 500,
          generationProtocolVersion: 2,
        });
        h.transport.reconnectToStream.mockResolvedValueOnce(retry);
      }
      send(h);
      await flush();
      retry.push({ type: 'pending_action', data: askAction } as ChatEvent);
      await flush();

      expect(h.chat.pendingAction).toBeUndefined();
    },
  );
});

describe('Chat status reads of a dropped generation', () => {
  it('(4) a status read naming the response of the dropped generation reaches its unframed stop', async () => {
    const named: TMessage = { ...placeholder, messageId: 'response-9', text: 'Named' };
    const h = createHarness({
      messages: [userMessage, named, { ...placeholder, messageId: 'other' }],
    });
    const stream = createStream({ streamId: 'convo-1', generationCreatedAt: 700 });
    h.transport.reconnectToStream.mockResolvedValueOnce(stream);
    h.chat.resumeStream({ streamId: 'convo-1', generationCreatedAt: 700 }).then(
      () => undefined,
      () => undefined,
    );
    await flush();
    stream.push(dropEvent);
    await flush();
    h.chat.restorePendingAction({ ...askAction, responseMessageId: 'response-9' }, 700);
    h.transport.abort.mockResolvedValueOnce({
      success: true,
      generationProtocolVersion: 2,
      aborted: 'convo-1',
      persistenceFailed: true,
    });

    await h.chat.stop();

    const last = h.finishes[h.finishes.length - 1];
    expect(last).toMatchObject({ isResponseUnknown: false });
    expect(last.message?.messageId).toBe('response-9');
  });
});

describe('Chat stops while a lost start is owed', () => {
  it('(2) a stop of a restored pause keeps the failure a lost start reported', async () => {
    const h = createHarness();
    await lost(h);
    expect(h.chat.status).toBe('error');
    h.chat.restorePendingAction(askAction, 500);

    await expect(h.chat.stop()).resolves.toEqual({ status: 'unaddressable' });
    expect(h.chat.status).toBe('error');
  });

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

describe('Chat snapshots the host reducer folds in', () => {
  it.each([
    ['an expired pause', { ...askAction, expiresAt: 1 }],
    ['a pause older than the one held', { ...askAction, actionId: 'action-old', createdAt: 0 }],
  ])('(2) a sync snapshot reaches the host reducer without %s', async (_label, pause) => {
    const seen: ChatEvent[] = [];
    const h = createHarness({ applyEvent: (event) => seen.push(event) });
    h.chat.restorePendingAction({ ...askAction, createdAt: 1 }, 500);
    const stream = createStream({ streamId: 'convo-1', generationCreatedAt: 500 });
    h.transport.reconnectToStream.mockResolvedValueOnce(stream);
    h.chat.resumeStream({ streamId: 'convo-1', generationCreatedAt: 500 }).then(
      () => undefined,
      () => undefined,
    );
    await flush();
    stream.push({
      type: 'sync',
      data: { sync: true, resumeState: { runSteps: [], pendingAction: pause } },
    } as ChatEvent);
    await flush();

    const sync = seen.find((event) => event.type === 'sync') as Extract<
      ChatEvent,
      { type: 'sync' }
    >;
    expect(sync.data.resumeState?.pendingAction).toBeUndefined();
  });
});

describe('Chat unframed stops while a lost start is owed', () => {
  it.each([
    [
      'settled',
      { success: false, settled: true, terminalStatus: 'complete', generationProtocolVersion: 2 },
    ],
    [
      'persistence failed',
      { success: true, aborted: 'convo-1', persistenceFailed: true, generationProtocolVersion: 2 },
    ],
    ['gone', Object.assign(new Error('Not Found'), { response: { status: 404 } })],
  ])('(2) a %s stop of a restored pause keeps the lost start failure', async (_label, answer) => {
    const h = createHarness();
    await lost(h);
    const failure = h.chat.error;
    h.chat.restorePendingAction(askAction, 500);
    if (answer instanceof Error) {
      h.transport.abort.mockRejectedValueOnce(answer);
    } else {
      h.transport.abort.mockResolvedValueOnce(answer as ChatAbortResult);
    }

    await expect(h.chat.stop()).resolves.toEqual({ status: 'unaddressable' });
    expect(h.chat.status).toBe('error');
    expect(h.chat.error).toBe(failure);
  });
});

describe('Chat resume conflicts after a newer pause', () => {
  it('(1) a conflict for an answered pause leaves a newer pause restored meanwhile', async () => {
    const h = createHarness();
    await states.restored(h);
    let refuse: (() => void) | undefined;
    h.transport.resume.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          refuse = () =>
            reject(
              Object.assign(new Error('Conflict'), {
                response: { status: 409, data: { code: 'RUN_REPLACED' }, headers: {} },
              }),
            );
        }),
    );
    const answered = h.chat.addToolOutput({ toolCallId: 'ask-1', output: 'A' });
    await flush();
    h.chat.restorePendingAction({ ...askAction, actionId: 'action-newer', createdAt: 9 }, 600);
    refuse?.();
    await answered.catch(() => undefined);
    await flush();

    expect(h.chat.pendingAction?.actionId).toBe('action-newer');
    expect(h.transport.reconnectToStream).not.toHaveBeenCalled();
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

  it('(1) a resume conflict probes before a subscriber can take the chat, and settles the pause it finds ended', async () => {
    const h = createHarness();
    await states.restored(h);
    h.transport.resume.mockRejectedValueOnce(
      Object.assign(new Error('Conflict'), {
        response: { status: 409, data: { error: 'No live pending action to resume' }, headers: {} },
      }),
    );
    let raced = false;
    const unsubscribe = h.chat.subscribe(() => {
      if (!raced && !h.chat.pendingAction && h.chat.status === 'ready') {
        raced = true;
        h.chat.sendMessage({ parts: [{ type: 'text', text: 'Next' }] }).then(
          () => undefined,
          () => undefined,
        );
      }
    });

    await h.chat.addToolOutput({ toolCallId: 'ask-1', output: 'A' }).catch(() => undefined);
    await flush();
    unsubscribe();

    expect(h.transport.reconnectToStream).toHaveBeenCalledTimes(1);
    expect(h.finishes[0]).toMatchObject({ isSettled: true });
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
    'restored pause: the pause a status read restored is stopped',
    async (h) => {
      await states.restored(h);
      await events.stop(h);
    },
    { last: stoppedUnframed, outcome: 'ok' },
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

describe('Chat lost starts across conversations and turns a retirement starts', () => {
  it('refuses a turn whose call retired an expired pause and let a subscriber start another', async () => {
    const h = createHarness();
    attach(h, createStream({ streamId: 'convo-1', generationCreatedAt: 100 }));
    h.chat.restorePendingAction({ ...askAction, expiresAt: Date.now() + 60_000 }, 500);
    const later = Date.now() + 120_000;
    const now = jest.spyOn(Date, 'now').mockReturnValue(later);
    let queued: Promise<void> | undefined;
    let started = false;
    const unsubscribe = h.chat.subscribe(() => {
      if (!h.chat.pendingAction && !started) {
        started = true;
        queued = h.chat.sendMessage({ parts: [{ type: 'text', text: 'Queued' }] });
      }
    });

    try {
      await expect(h.chat.sendMessage({ parts: [{ type: 'text', text: 'Hi' }] })).rejects.toThrow(
        'A turn is already in flight for this chat',
      );
    } finally {
      now.mockRestore();
      unsubscribe();
    }
    await flush();
    expect(h.transport.sendMessages).toHaveBeenCalledTimes(1);
    h.stream?.push(finalEvent());
    await queued;
    expect(h.finishes).toHaveLength(1);
  });
});

/** Table 1: every pause transition, the pause it leaves held, and the decisions it keeps. */
describe('Chat pause lifecycle and its decision markers', () => {
  const approval = {
    ...askAction,
    payload: {
      type: 'tool_approval',
      action_requests: [{ tool_call_id: 'tool-1' }, { tool_call_id: 'tool-2' }],
    },
  } as unknown as Agents.PendingAction;
  const newer = { ...approval, actionId: 'action-2', createdAt: 2 } as Agents.PendingAction;
  const sync = (pendingAction?: Agents.PendingAction) =>
    ({
      type: 'sync',
      data: { sync: true, resumeState: { runSteps: [], ...(pendingAction && { pendingAction }) } },
    }) as ChatEvent;
  const reattached = async (h: Harness) => {
    const stream = createStream({ streamId: 'convo-1', generationCreatedAt: 500 });
    h.transport.reconnectToStream.mockResolvedValueOnce(stream);
    h.chat.resumeStream({ streamId: 'convo-1', generationCreatedAt: 500 }).then(
      () => undefined,
      () => undefined,
    );
    await flush();
    return stream;
  };
  const answerFails = (h: Harness, error: Error) => h.transport.resume.mockRejectedValueOnce(error);
  const answerSecond = async (h: Harness) => {
    await h.chat.addToolApprovalResponse({ id: 'tool-2', approved: true }).catch(() => undefined);
    await flush();
  };

  type PauseRow = {
    /** The pause held after the transition, or `null` when none is. */
    held: string | null;
    /**
     * Decisions the next resume carries once the second call is answered: 2 when the first
     * call's decision was kept, 0 when it was cleared and no resume is sent. Omitted when no pause
     * is left to answer.
     */
    submitted?: number;
  };

  const rows: Array<[string, (h: Harness) => Promise<void>, PauseRow]> = [
    [
      'a status read restores the held pause again',
      async (h) => h.chat.restorePendingAction({ ...approval }, 500),
      { held: 'action-1', submitted: 2 },
    ],
    [
      'a status read restores a newer pause of the generation',
      async (h) => h.chat.restorePendingAction(newer, 500),
      { held: 'action-2', submitted: 0 },
    ],
    [
      'a sync snapshot omits the held pause',
      async (h) => {
        const stream = await reattached(h);
        stream.push(sync());
        await flush();
      },
      { held: null },
    ],
    [
      'a sync snapshot omits the held pause and the stream reports it again',
      async (h) => {
        const stream = await reattached(h);
        stream.push(sync());
        stream.push({ type: 'pending_action', data: approval } as ChatEvent);
        await flush();
      },
      { held: 'action-1', submitted: 2 },
    ],
    [
      'a sync snapshot omits the held pause, the stream drops, and a status read restores it',
      async (h) => {
        const stream = await reattached(h);
        stream.push(sync());
        await flush();
        stream.push(dropEvent);
        await flush();
        h.chat.restorePendingAction({ ...approval }, 500);
      },
      { held: 'action-1', submitted: 2 },
    ],
    [
      'a sync snapshot names a newer pause',
      async (h) => {
        const stream = await reattached(h);
        stream.push(sync(newer));
        await flush();
      },
      { held: 'action-2', submitted: 0 },
    ],
    [
      'the stream replays the held pause',
      async (h) => {
        const stream = await reattached(h);
        stream.push({ type: 'pending_action', data: approval } as ChatEvent);
        await flush();
      },
      { held: 'action-1', submitted: 2 },
    ],
    [
      'the stream reports a newer pause',
      async (h) => {
        const stream = await reattached(h);
        stream.push({ type: 'pending_action', data: newer } as ChatEvent);
        await flush();
      },
      { held: 'action-2', submitted: 0 },
    ],
    [
      'its expiry passes with no answer in flight',
      async (h) => {
        h.chat.restorePendingAction({ ...approval, expiresAt: Date.now() + 20 }, 500);
        await new Promise((resolve) => setTimeout(resolve, 60));
      },
      { held: null },
    ],
    [
      'its expiry passes while an answer is in flight, and the answer fails',
      async (h) => {
        h.chat.restorePendingAction({ ...approval, expiresAt: Date.now() + 20 }, 500);
        let refuse: (error: Error) => void = () => undefined;
        h.transport.resume.mockImplementationOnce(
          () =>
            new Promise<never>((_, reject) => {
              refuse = reject;
            }),
        );
        const answered = h.chat.addToolApprovalResponse({ id: 'tool-2', approved: true });
        await new Promise((resolve) => setTimeout(resolve, 60));
        refuse(Object.assign(new Error('Unavailable'), { response: { status: 503 } }));
        await answered.catch(() => undefined);
        await flush();
      },
      { held: null },
    ],
    [
      'the answer is accepted, and a status read of that pause comes late',
      async (h) => {
        await answerSecond(h);
        h.chat.restorePendingAction({ ...approval }, 500);
      },
      { held: null },
    ],
    [
      'the answer is lost on the network',
      async (h) => {
        answerFails(h, networkError());
        await answerSecond(h);
      },
      { held: null },
    ],
    [
      'the answer is refused because the pause is over (409)',
      async (h) => {
        answerFails(
          h,
          Object.assign(new Error('Conflict'), {
            response: { status: 409, data: { code: 'RUN_REPLACED' }, headers: {} },
          }),
        );
        await answerSecond(h);
      },
      { held: null },
    ],
    [
      'the answer is refused because the server is not ready yet',
      async (h) => {
        answerFails(
          h,
          Object.assign(new Error('Not ready'), {
            response: { status: 409, data: { code: 'EVENT_ACTOR_NOT_READY' }, headers: {} },
          }),
        );
        await answerSecond(h);
      },
      { held: 'action-1', submitted: 2 },
    ],
    [
      'the held pause is stopped',
      async (h) => {
        await h.chat.stop();
        await flush();
      },
      { held: null },
    ],
  ];

  it.each(rows)('%s', async (_transition, drive, expected) => {
    const h = createHarness();
    h.chat.restorePendingAction(approval, 500);
    await h.chat.addToolApprovalResponse({ id: 'tool-1', approved: true });
    await drive(h);

    expect(h.chat.pendingAction?.actionId ?? null).toBe(expected.held);
    if (expected.submitted === undefined) {
      return;
    }
    const before = h.transport.resume.mock.calls.length;
    h.transport.resume.mockClear();
    await answerSecond(h);
    const calls = h.transport.resume.mock.calls as unknown as Array<[{ decisions?: unknown[] }]>;
    expect(calls.length > 0 ? (calls[calls.length - 1][0].decisions?.length ?? 0) : 0).toBe(
      expected.submitted,
    );
    expect(before).toBeGreaterThanOrEqual(0);
  });

  it.each([
    ['older than the restored one', { ...approval, responseMessageId: 'response-10' }],
    ['that expired', { ...newer, responseMessageId: 'response-10', expiresAt: 1 }],
  ])(
    'a replayed pause %s does not rename the response a drop reports',
    async (_label, replayed) => {
      const h = createHarness({ messages: [userMessage, restoredResponse, laterMessage] });
      h.chat.restorePendingAction({ ...newer, responseMessageId: 'response-9' }, 500);
      const stream = await reattached(h);
      stream.push({ type: 'pending_action', data: replayed } as unknown as ChatEvent);
      await flush();
      stream.push(dropEvent);
      await flush();

      expect(h.finishes[h.finishes.length - 1]?.message?.messageId).toBe('response-9');
    },
  );
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
    [
      'a status read that restores a pause',
      'convo-1',
      async (h) => h.chat.restorePendingAction(askAction, 500),
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

  it('a request that retires an expired pause yields to the turn a subscriber started', async () => {
    const h = createHarness();
    attach(h, createStream({ streamId: 'convo-1', generationCreatedAt: 100 }));
    h.chat.restorePendingAction({ ...askAction, expiresAt: Date.now() + 60_000 }, 500);
    const now = jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 120_000);
    const { unsubscribe } = startOnNotify(h, () => !h.chat.pendingAction);
    try {
      await expect(h.chat.sendMessage({ parts: [{ type: 'text', text: 'Hi' }] })).rejects.toThrow(
        'already in flight',
      );
    } finally {
      now.mockRestore();
      unsubscribe();
    }
    await flush();
    expect(h.transport.sendMessages).toHaveBeenCalledTimes(1);
  });

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

  it('an answer sends nothing when the host disposes the chat while it selects the endpoint', async () => {
    const h = createHarness({
      resumeSelection: () => {
        h.chat.dispose();
        return { endpoint: 'agents' };
      },
    });
    h.chat.restorePendingAction(askAction, 500);

    await expect(h.chat.addToolOutput({ toolCallId: 'ask-1', output: 'A' })).rejects.toThrow(
      'disposed',
    );
    expect(h.transport.resume).not.toHaveBeenCalled();
  });

  it('a reattachment owns the chat before it clears a pause it supersedes', async () => {
    const h = createHarness();
    h.chat.restorePendingAction(askAction, 500);
    h.transport.reconnectToStream.mockImplementation(() => new Promise(() => undefined));
    const { attempt, unsubscribe } = startOnNotify(h, () => !h.chat.pendingAction);
    h.chat.resumeStream({ streamId: 'convo-1', generationCreatedAt: 900 }).catch(() => undefined);
    await flush();
    unsubscribe();

    expect(attempt.error).toContain('already in flight');
    expect(h.transport.sendMessages).not.toHaveBeenCalled();
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

  it('an approval write notifies after the pause is held, so a second answer sends one resume', async () => {
    const approval = {
      ...askAction,
      payload: {
        type: 'tool_approval',
        action_requests: [{ tool_call_id: 'tool-1' }, { tool_call_id: 'tool-2' }],
      },
    } as unknown as Agents.PendingAction;
    const h = createHarness({ messages: [userMessage, placeholder] });
    h.chat.restorePendingAction(approval, 500);
    await h.chat.addToolApprovalResponse({ id: 'tool-1', approved: true });
    let answered: Promise<void> | undefined;
    const unsubscribe = h.chat.subscribe(() => {
      answered ??= h.chat.addToolApprovalResponse({ id: 'tool-2', approved: true });
    });
    await h.chat.addToolApprovalResponse({ id: 'tool-2', approved: true }).catch(() => undefined);
    await answered?.catch(() => undefined);
    await flush();
    unsubscribe();

    expect(h.transport.resume).toHaveBeenCalledTimes(1);
  });

  it('a status read that restores a pause notifies with the pause held, which blocks a turn', async () => {
    const h = createHarness();
    const { attempt, unsubscribe } = startOnNotify(h, () => true);
    h.chat.restorePendingAction(askAction, 500);
    await flush();
    unsubscribe();

    expect(attempt.error).toContain('waiting for a decision');
    expect(h.transport.sendMessages).not.toHaveBeenCalled();
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

  it('an expiry the timer retires notifies with nothing owned, so the turn a subscriber starts runs', async () => {
    const h = createHarness();
    attach(h, createStream({ streamId: 'convo-1', generationCreatedAt: 100 }));
    const { attempt, unsubscribe } = startOnNotify(h, () => !h.chat.pendingAction);
    h.chat.restorePendingAction({ ...askAction, expiresAt: Date.now() + 20 }, 500);
    await new Promise((resolve) => setTimeout(resolve, 60));
    await flush();
    unsubscribe();

    expect(attempt.error).toBeUndefined();
    expect(h.transport.sendMessages).toHaveBeenCalledTimes(1);
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

describe('Chat pauses a stop that outlives a failed reconnect ends', () => {
  it('the restored pause ends with the dropped generation the stop answer ends', async () => {
    const h = createHarness();
    h.chat.restorePendingAction(askAction, 500);
    let fail: (() => void) | undefined;
    h.transport.reconnectToStream.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          fail = () => reject(networkError());
        }),
    );
    h.chat.resumeStream({ streamId: 'convo-1', generationCreatedAt: 500 }).then(
      () => undefined,
      () => undefined,
    );
    await flush();
    let answerStop: (() => void) | undefined;
    h.transport.abort.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          answerStop = () => resolve({ success: true, aborted: 'convo-1' });
        }),
    );
    const stopping = h.chat.stop();
    await flush();
    fail?.();
    await flush();
    expect(h.chat.pendingAction?.actionId).toBe('action-1');
    answerStop?.();
    await stopping;
    await flush();

    expect(h.chat.pendingAction).toBeUndefined();
    expect((await h.chat.stop()).status).toBe('idle');
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

describe('Chat pauses the server refused to resume', () => {
  it('a refused pause stays retired when the probe that follows it fails on the network', async () => {
    const h = createHarness();
    h.chat.restorePendingAction(askAction, 500);
    h.transport.resume.mockRejectedValueOnce(
      Object.assign(new Error('gone'), { response: { status: 404 } }),
    );
    h.transport.reconnectToStream.mockRejectedValueOnce(networkError());
    await expect(h.chat.addToolOutput({ toolCallId: 'ask-1', output: 'A' })).rejects.toThrow();
    await flush();

    expect(h.chat.pendingAction).toBeUndefined();
    attach(h, createStream({ streamId: 'convo-1', generationCreatedAt: 600 }));
    let refused: unknown;
    h.chat.sendMessage({ parts: [{ type: 'text', text: 'Next' }] }).catch((error: unknown) => {
      refused = error;
    });
    await flush();
    expect(refused).toBeUndefined();
  });

  it('a refused pause stays over for a later status read and a reattached replay', async () => {
    const h = createHarness();
    h.chat.restorePendingAction(askAction, 500);
    h.transport.resume.mockRejectedValueOnce(
      Object.assign(new Error('gone'), { response: { status: 404 } }),
    );
    h.transport.reconnectToStream.mockRejectedValueOnce(networkError());
    await expect(h.chat.addToolOutput({ toolCallId: 'ask-1', output: 'A' })).rejects.toThrow();
    await flush();

    h.chat.restorePendingAction(askAction, 500);
    expect(h.chat.pendingAction).toBeUndefined();
    const stream = createStream({ streamId: 'convo-1', generationCreatedAt: 500 });
    h.transport.reconnectToStream.mockResolvedValueOnce(stream);
    h.chat.resumeStream({ streamId: 'convo-1', generationCreatedAt: 500 }).then(
      () => undefined,
      () => undefined,
    );
    await flush();
    stream.push({ type: 'pending_action', data: askAction } as unknown as ChatEvent);
    await flush();
    expect(h.chat.pendingAction).toBeUndefined();
  });
});

describe('Chat pauses created in the same millisecond', () => {
  const held = { ...askAction, actionId: 'action-1', createdAt: 5 } as Agents.PendingAction;
  const expired = {
    ...askAction,
    actionId: 'action-2',
    createdAt: 5,
    expiresAt: 1,
  } as Agents.PendingAction;

  it('an expired successor a status read reports retires the held pause it ties', () => {
    const h = createHarness();
    h.chat.restorePendingAction(held, 500);
    h.chat.restorePendingAction(expired, 500);

    expect(h.chat.pendingAction).toBeUndefined();
  });

  it('an expired successor a reattached stream replays retires the held pause it ties', async () => {
    const h = createHarness();
    h.chat.restorePendingAction(held, 500);
    const stream = createStream({ streamId: 'convo-1', generationCreatedAt: 500 });
    h.transport.reconnectToStream.mockResolvedValueOnce(stream);
    h.chat.resumeStream({ streamId: 'convo-1', generationCreatedAt: 500 }).then(
      () => undefined,
      () => undefined,
    );
    await flush();
    stream.push({ type: 'pending_action', data: expired } as unknown as ChatEvent);
    await flush();

    expect(h.chat.pendingAction).toBeUndefined();
  });
});

describe('Chat pauses a sync frame carries or releases while an answer is in flight', () => {
  const reattach = async (h: Harness) => {
    const stream = createStream({ streamId: 'convo-1', generationCreatedAt: 500 });
    h.transport.reconnectToStream.mockResolvedValueOnce(stream);
    h.chat.resumeStream({ streamId: 'convo-1', generationCreatedAt: 500 }).then(
      () => undefined,
      () => undefined,
    );
    await flush();
    return stream;
  };

  it('a pause buffered in the sync frame is held, so its answer resumes it', async () => {
    const h = createHarness();
    const stream = await reattach(h);
    stream.push({
      type: 'sync',
      data: {
        sync: true,
        resumeState: { runSteps: [] },
        pendingEvents: [{ event: 'on_pending_action', data: askAction }],
      },
    } as unknown as ChatEvent);
    await flush();

    expect(h.chat.pendingAction?.actionId).toBe('action-1');
    await h.chat.addToolOutput({ toolCallId: 'ask-1', output: 'A' });
    expect(h.transport.resume).toHaveBeenCalledWith(
      expect.objectContaining({ actionId: 'action-1', answer: 'A' }),
    );
  });

  it('an answer accepted after a snapshot released its pause and the stream dropped still follows the continuation', async () => {
    const h = createHarness();
    h.chat.restorePendingAction(askAction, 500);
    let answer: (() => void) | undefined;
    h.transport.resume.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          answer = () =>
            resolve({ streamId: 'convo-1', conversationId: 'convo-1', status: 'resuming' });
        }),
    );
    const answering = h.chat.addToolOutput({ toolCallId: 'ask-1', output: 'A' });
    await flush();
    const stream = await reattach(h);
    stream.push({
      type: 'sync',
      data: { sync: true, resumeState: { runSteps: [] } },
    } as unknown as ChatEvent);
    await flush();
    stream.push(dropEvent);
    await flush();
    h.transport.reconnectToStream.mockClear();
    h.transport.reconnectToStream.mockImplementationOnce(() => new Promise(() => undefined));
    answer?.();
    await answering;
    await flush();

    expect(h.transport.reconnectToStream).toHaveBeenCalledTimes(1);
  });

  it('a stale pause buffered in the sync frame never reaches the host reducer', async () => {
    const folded: ChatEvent[] = [];
    const h = createHarness({ applyEvent: (event) => folded.push(event) });
    const stream = await reattach(h);
    const expired = { ...askAction, expiresAt: 1 } as Agents.PendingAction;
    stream.push({
      type: 'sync',
      data: {
        sync: true,
        resumeState: { runSteps: [] },
        pendingEvents: [
          { event: 'on_pending_action', data: expired },
          { type: 'text', text: 'x' },
        ],
      },
    } as unknown as ChatEvent);
    await flush();

    const sync = folded.find((event) => event.type === 'sync') as Extract<
      ChatEvent,
      { type: 'sync' }
    >;
    expect(sync.data.pendingEvents).toEqual([{ type: 'text', text: 'x' }]);
    expect(h.chat.pendingAction).toBeUndefined();
  });

  it('an answer accepted after the generation of its released pause finished starts no continuation', async () => {
    const h = createHarness();
    h.chat.restorePendingAction(askAction, 500);
    let answer: (() => void) | undefined;
    h.transport.resume.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          answer = () =>
            resolve({ streamId: 'convo-1', conversationId: 'convo-1', status: 'resuming' });
        }),
    );
    const answering = h.chat.addToolOutput({ toolCallId: 'ask-1', output: 'A' });
    await flush();
    const stream = await reattach(h);
    stream.push({
      type: 'sync',
      data: { sync: true, resumeState: { runSteps: [] } },
    } as unknown as ChatEvent);
    await flush();
    stream.push(finalEvent());
    await flush();
    const finishes = h.finishes.length;
    h.transport.reconnectToStream.mockClear();
    answer?.();
    await answering;
    await flush();

    expect(h.transport.reconnectToStream).not.toHaveBeenCalled();
    expect(h.finishes).toHaveLength(finishes);
  });

  it('a snapshot pause a newer buffered one supersedes never reaches the host reducer', async () => {
    const folded: ChatEvent[] = [];
    const h = createHarness({ applyEvent: (event) => folded.push(event) });
    const stream = await reattach(h);
    const older = { ...askAction, actionId: 'action-1', createdAt: 1 } as Agents.PendingAction;
    const newer = {
      ...askAction,
      actionId: 'action-2',
      createdAt: 2,
      expiresAt: 1,
    } as Agents.PendingAction;
    stream.push({
      type: 'sync',
      data: {
        sync: true,
        resumeState: { runSteps: [], pendingAction: older },
        pendingEvents: [{ event: 'on_pending_action', data: newer }],
      },
    } as unknown as ChatEvent);
    await flush();

    const sync = folded.find((event) => event.type === 'sync') as Extract<
      ChatEvent,
      { type: 'sync' }
    >;
    expect(sync.data.resumeState?.pendingAction).toBeUndefined();
    expect(sync.data.pendingEvents).toEqual([]);
    expect(h.chat.pendingAction).toBeUndefined();
  });
});
