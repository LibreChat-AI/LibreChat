import { Constants } from 'librechat-data-provider';
import type {
  TPayload,
  TMessage,
  ChatEvent,
  UITextPart,
  ChatFinalFrame,
  ChatErrorData,
  UIMessageMetadata,
} from 'librechat-data-provider';
import type {
  ChatStream,
  ChatStatus,
  ChatTrigger,
  ChatTransport,
  ChatConnection,
  ChatRequestOptions,
  ChatSendResult,
  ChatTransportError,
} from './types';
import { isRetryableNetworkError } from './resumable/start';
import { SerialJobExecutor } from './executor';

/**
 * Where a chat keeps its messages, status and error. AI SDK: `ChatState`. The app backs it with
 * the React Query message cache, so every reader of that cache sees what the chat writes.
 */
export interface ChatState {
  status: ChatStatus;
  error: Error | undefined;
  connection: ChatConnection;
  /** The conversation's stored messages: every branch, in stored order. */
  readonly messages: TMessage[];
  /** Replaces the whole list; tree writes are whole-list, as the message cache takes them. */
  replaceMessages(messages: TMessage[]): void;
  /** Reports writes made outside the chat, such as another hook writing the same cache. */
  subscribe?(listener: () => void): () => void;
}

/**
 * A user turn in the AI SDK's `sendMessage` shape: its text parts, plus the message it attaches
 * under. File parts are left out because a turn takes its files from the composer.
 */
export type SendMessageInput = {
  parts: UITextPart[];
  metadata?: Partial<Pick<UIMessageMetadata, 'parentMessageId'>>;
};

/** What the host turns into a request body. */
export type ChatPrepareRequest = {
  trigger: ChatTrigger;
  chatId: string;
  messages: TMessage[];
  /** The user turn, for `submit-message`. */
  input?: SendMessageInput;
  /** The message to regenerate, for `regenerate-message`. */
  messageId?: string;
};

export type ChatPreparedRequest = {
  payload: TPayload;
  /**
   * The list to show while the request is in flight: the user turn and its placeholder reply. A
   * function receives the list current when it is written, so writes made while the request was
   * prepared are kept; a list replaces it as prepared.
   */
  messages?: TMessage[] | ((current: TMessage[]) => TMessage[]);
  /**
   * The placeholder reply's id, which `onFinish` reports when the turn ends without a final frame.
   * Without it, that is the list's last message.
   */
  responseMessageId?: string;
};

/** The message list as an event handler reads and writes it. */
export type ChatEventContext = {
  readonly messages: TMessage[];
  write(messages: TMessage[]): void;
};

export type ChatFinishResult = {
  /**
   * The turn's response: the one its final frame named, else the prepared `responseMessageId`,
   * else the tail of the list. `undefined` when a named response is no longer in the list.
   */
  message: TMessage | undefined;
  messages: TMessage[];
  isAbort: boolean;
  isDisconnect: boolean;
  isError: boolean;
  /**
   * The server finished the turn without this chat receiving its final frame, so `messages` are
   * what the chat held; the host reloads the conversation to reconcile them.
   */
  isSettled: boolean;
  /**
   * No frame named this turn's response, as when a generation replacing it ended before its sync
   * frame. `message` is then `undefined` rather than a guess at the list's tail.
   */
  isResponseUnknown: boolean;
  /**
   * The conversation the turn ran under: the one the server settled it under, else the one its
   * frames or payload named, so a turn under `new` reports the conversation the server created.
   */
  conversationId?: string;
  /** Why a settled turn's final frame carried no messages. */
  reconcileReason?: ChatFinalFrame['reconcileReason'];
};

export type ChatInit = {
  /** The conversation id, or `new` before the server created one. */
  id: string;
  state: ChatState;
  transport: ChatTransport;
  /**
   * Builds the request body, and the optimistic messages, for a turn. AI SDK:
   * `prepareSendMessagesRequest`.
   */
  prepareRequest(request: ChatPrepareRequest): ChatPreparedRequest | Promise<ChatPreparedRequest>;
  /**
   * Folds one stream event into the message list. Without it, a `final` event's request and
   * response messages are merged into the list by id and every other event only moves the status.
   */
  applyEvent?(event: ChatEvent, context: ChatEventContext): void;
  onError?(error: Error): void;
  onFinish?(result: ChatFinishResult): void;
  /** Every event, after it was applied: the side channels (usage, title, attachments, steering). */
  onEvent?(event: ChatEvent): void;
};

/** A turn whose messages the chat could not take from the stream, which the host reloads. */
type Settled = {
  conversationId?: string;
  reason?: ChatFinalFrame['reconcileReason'];
};

type Outcome = {
  settled?: Settled;
  /** The conversation the turn's frames named, reported when a settled outcome names none. */
  conversationId?: string;
} & (
  | { kind: 'complete' }
  | { kind: 'abort' }
  | { kind: 'error'; error: Error; disconnect: boolean }
);

/** The response a turn produces, as the frames of its generation name it. */
type Generation = {
  /** The conversation the payload, the server's answer or a frame named. */
  conversationId?: string;
  /** The response this generation produces: the placeholder, then the one a frame names. */
  responseId?: string;
  /**
   * The generation is not the one this chat prepared (a replacement) and no frame has named its
   * response yet.
   */
  responseUnknown?: boolean;
  /** A turn that ended before its preparation installed a response, so it has none to report. */
  responseless?: boolean;
};

/**
 * What one optimistic write did, by message id, so undoing it touches only those rows. A row the
 * state holds that the write did not add, replace or remove, such as one a store subscriber
 * appended while the write was committed, is never part of it.
 */
type OptimisticWrite = {
  /** The list before the write, which places a removed row back among its neighbours. */
  before: TMessage[];
  /** Each row the write added or replaced, as the state committed it. */
  committed: Map<string, TMessage>;
  /** Each row the write replaced, as it was before. */
  replaced: Map<string, TMessage>;
  /** The ids of the rows the write removed. */
  removed: Set<string>;
};

type ActiveRequest = {
  controller: AbortController;
  /** The optimistic write, undone when the server never got the turn or ran another in its place. */
  optimistic?: OptimisticWrite;
  stream?: ChatStream;
  /** The generation this request runs or attaches to. */
  generation: Generation;
  /** Set while attaching to a generation the server answered the start with, before it attaches. */
  attaching?: boolean;
  /**
   * The stream came from attaching to a running generation, whose HTTP failure ends only the
   * attachment unless the server says the generation is gone.
   */
  attached?: boolean;
  /** Set once the start was handed to the transport, so the server may be running it. */
  sent?: boolean;
  /** Resolves once the request settled and released the chat. */
  finished: Promise<void>;
  finish: () => void;
};

const createActiveRequest = (generation: Generation = {}): ActiveRequest => {
  let finish = () => {};
  const finished = new Promise<void>((resolve) => {
    finish = resolve;
  });
  return { controller: new AbortController(), generation, finished, finish };
};

/** Settles with `value`, or rejects once `signal` aborts, so a disposal never waits on it. */
const untilAborted = <T>(value: T | Promise<T>, signal: AbortSignal): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    if (signal.aborted) {
      Promise.resolve(value).catch(() => undefined);
      onAbort();
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(value)
      .then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', onAbort));
  });

/** Races opening a stream with cancellation, and hands `onLate` what opens after it. */
const openUntilAborted = <T>(
  opening: Promise<T>,
  signal: AbortSignal,
  onLate: (value: T) => void,
): Promise<T> => {
  void opening.then(
    (value) => {
      if (signal.aborted) {
        onLate(value);
      }
    },
    () => undefined,
  );
  return untilAborted(opening, signal);
};

/**
 * Reports a host listener's failure the way the DOM reports a throwing event listener, so one
 * faulty subscriber neither hides a change from the others nor interrupts the chat's transition.
 */
const reportListenerError = (error: unknown): void => {
  const { reportError } = globalThis as { reportError?: (error: unknown) => void };
  if (reportError) {
    reportError(error);
    return;
  }
  console.error(error);
};

const streamingEvents = new Set<ChatEvent['type']>(['created', 'sync', 'step', 'content', 'text']);

const getErrorMessage = (data: ChatErrorData | null | undefined): string | undefined => {
  if (typeof data === 'string') {
    return data || undefined;
  }
  if (!data) {
    return undefined;
  }
  const nested = typeof data.error === 'object' ? data.error?.message : undefined;
  const reason = typeof data.error === 'string' ? data.error : undefined;
  return data.message || data.text || reason || nested;
};

/**
 * An error frame the attachment's HTTP response raised rather than the generation: the transport
 * sets `status` only then, and a 404 or 410 says the generation itself is gone.
 */
const isAttachFailure = (event: Extract<ChatEvent, { type: 'error' }>): boolean =>
  event.status != null && event.status !== 404 && event.status !== 410;

/** The server answered that no such generation runs, rather than failing to answer. */
const isGone = (error: ChatTransportError): boolean =>
  error.code === 'NO_ACTIVE_RUN' ||
  error.response?.status === 404 ||
  error.response?.status === 410;

/**
 * A frame the chat failed to apply. A terminal frame still ended the generation, which the host
 * reloads from what the server kept; any other leaves it running.
 */
const getApplyFailure = (event: ChatEvent, failure: unknown, attached: boolean): Outcome => {
  const error = failure instanceof Error ? failure : new Error(String(failure));
  const terminal =
    event.type === 'final' ||
    event.type === 'abort' ||
    (event.type === 'error' && event.status !== 0 && !(attached && isAttachFailure(event)));
  return terminal
    ? { kind: 'error', error, disconnect: false, settled: {} }
    : { kind: 'error', error, disconnect: true };
};

/** The ids a frame names for the conversation and the response its generation produces. */
type FrameIdentity = { conversationId?: string | null; responseMessageId?: string };

/**
 * Reads the identity every frame type carries. A `created` frame's message is the user's, so it
 * names only the conversation; an attachment may belong to an uploaded file, so the same holds.
 */
const getFrameIdentity = (event: ChatEvent): FrameIdentity => {
  switch (event.type) {
    case 'created':
      return { conversationId: event.data.message?.conversationId };
    case 'sync': {
      const { resumeState } = event.data;
      return {
        conversationId: event.data.conversationId ?? resumeState?.conversationId,
        responseMessageId: event.data.responseMessage?.messageId ?? resumeState?.responseMessageId,
      };
    }
    case 'final':
      return {
        conversationId:
          event.data.conversation?.conversationId ?? event.data.responseMessage?.conversationId,
        responseMessageId: event.data.responseMessage?.messageId ?? undefined,
      };
    case 'pending_action':
    case 'steer_applied':
    case 'activity_label':
    case 'reasoning_label':
      return {
        conversationId: event.data.conversationId,
        responseMessageId: event.data.responseMessageId,
      };
    case 'steer_updated':
      return { conversationId: event.data.conversationId };
    case 'title':
      return { conversationId: event.data.data?.conversationId };
    case 'content':
      return { conversationId: event.data.conversationId, responseMessageId: event.data.messageId };
    case 'text':
      return { responseMessageId: event.data.messageId };
    case 'attachment':
      return {
        conversationId: 'conversationId' in event.data ? event.data.conversationId : undefined,
      };
    default:
      return {};
  }
};

const getFinalOutcome = (data: ChatFinalFrame): Outcome => {
  /** A `reconcile` frame committed its terminal status without the messages, so it is settled. */
  const settled: Settled | undefined = data.reconcile
    ? {
        conversationId: data.conversation?.conversationId ?? undefined,
        reason: data.reconcileReason,
      }
    : undefined;
  if (data.terminalStatus === 'error' || data.error) {
    const message = data.error?.message ?? 'The response failed';
    return { kind: 'error', error: new Error(message), disconnect: false, settled };
  }
  if (data.terminalStatus === 'aborted' || data.aborted) {
    return { kind: 'abort', settled };
  }
  return { kind: 'complete', settled };
};

/**
 * Whether a frame's message carries every field a stored row needs. A partial one only updates the
 * row it names; appended as it is, it would stand in the list as a message missing required fields.
 */
const isCompleteMessage = (message: Partial<TMessage>): message is TMessage =>
  typeof message.messageId === 'string' &&
  typeof message.text === 'string' &&
  typeof message.isCreatedByUser === 'boolean' &&
  message.conversationId !== undefined &&
  message.parentMessageId !== undefined;

/** Merges `finals` onto `messages` by id, appending the complete ones the list does not hold. */
const mergeById = (
  messages: TMessage[],
  finals: Array<Partial<TMessage> | null | undefined>,
): TMessage[] | undefined => {
  const known = finals.filter(
    (message): message is Partial<TMessage> & { messageId: string } => !!message?.messageId,
  );
  if (known.length === 0) {
    return undefined;
  }
  const next = [...messages];
  for (const final of known) {
    const index = next.findIndex((message) => message.messageId === final.messageId);
    if (index === -1 && isCompleteMessage(final)) {
      next.push(final);
    } else if (index !== -1) {
      next[index] = { ...next[index], ...final };
    }
  }
  return next;
};

const mergeFinal = (data: ChatFinalFrame, context: ChatEventContext) => {
  const next = mergeById(context.messages, [data.requestMessage, data.responseMessage]);
  if (next) {
    context.write(next);
  }
};

const defaultApplyEvent = (event: ChatEvent, context: ChatEventContext) => {
  if (event.type === 'final') {
    mergeFinal(event.data, context);
  }
};

/**
 * Where a removed row goes back: after the nearest earlier row of `before` still listed, else
 * before the nearest later one, so rows written around it since then keep their place.
 */
const getRestoreIndex = (before: TMessage[], index: number, next: TMessage[]): number => {
  const positionOf = (message: TMessage) =>
    next.findIndex((listed) => listed.messageId === message.messageId);
  for (let i = index - 1; i >= 0; i--) {
    const position = positionOf(before[i]);
    if (position !== -1) {
      return position + 1;
    }
  }
  for (let i = index + 1; i < before.length; i++) {
    const position = positionOf(before[i]);
    if (position !== -1) {
      return position;
    }
  }
  return next.length;
};

/** Structural equality over JSON-shaped values, which tells a store's copy of a row from an edit. */
const isSameValue = (a: unknown, b: unknown): boolean => {
  if (a === b) {
    return true;
  }
  if (typeof a !== 'object' || typeof b !== 'object' || a == null || b == null) {
    return false;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((item, index) => isSameValue(item, b[index]))
    );
  }
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  return (
    keys.length === Object.keys(right).length &&
    keys.every(
      (key) =>
        Object.prototype.hasOwnProperty.call(right, key) && isSameValue(left[key], right[key]),
    )
  );
};

/**
 * Records the rows `written` changed against `before`, each added or replaced row under the
 * identity the state `committed` it with, since a store may copy a row on the way in. A row a
 * store subscriber edited inside the write is that subscriber's, and the record leaves it out.
 */
const recordOptimisticWrite = (
  before: TMessage[],
  written: TMessage[],
  committed: TMessage[],
): OptimisticWrite => {
  const prior = new Map(before.map((message) => [message.messageId, message]));
  const held = new Map(committed.map((message) => [message.messageId, message]));
  const record: OptimisticWrite = {
    before,
    committed: new Map(),
    replaced: new Map(),
    removed: new Set(prior.keys()),
  };
  for (const message of written) {
    const was = prior.get(message.messageId);
    record.removed.delete(message.messageId);
    const row = held.get(message.messageId);
    if (was === message || row == null || !isSameValue(row, message)) {
      continue;
    }
    record.committed.set(message.messageId, row);
    if (was != null) {
      record.replaced.set(message.messageId, was);
    }
  }
  return record;
};

/**
 * Undoes an optimistic write on the list as it stands now: rows it added go, rows it replaced or
 * removed come back as they were, and any other row, or one of its rows someone else wrote since,
 * stays as it is.
 */
const undoOptimisticWrite = (record: OptimisticWrite, current: TMessage[]): TMessage[] => {
  const next: TMessage[] = [];
  const kept = new Set<string>();
  for (const message of current) {
    if (record.committed.get(message.messageId) !== message) {
      next.push(message);
      kept.add(message.messageId);
      continue;
    }
    const was = record.replaced.get(message.messageId);
    if (was != null) {
      next.push(was);
      kept.add(message.messageId);
    }
  }
  record.before.forEach((message, index) => {
    if (record.removed.has(message.messageId) && !kept.has(message.messageId)) {
      next.splice(getRestoreIndex(record.before, index, next), 0, message);
    }
  });
  return next;
};

/**
 * Closes the stream of a start that answered after the chat let it go. Only a disposal lets a
 * start go, and a disposed chat leaves the server's generation running, as it does an attached one.
 */
const closeLateStart = (sent: ChatSendResult): void => {
  if (sent.status === 'stream') {
    sent.stream.close();
  }
};

/**
 * One conversation's turn lifecycle, framework free. AI SDK: `AbstractChat`.
 *
 * A turn is `submitted` while the request is in flight, `streaming` from its first content event,
 * then `ready` on completion or abort and `error` on failure, until `clearError`. Every write to
 * the message list (stream events and the optimistic turn) runs through one
 * {@link SerialJobExecutor}, so they apply in the order they were made.
 */
export class Chat {
  readonly id: string;
  private readonly init: ChatInit;
  private readonly executor = new SerialJobExecutor();
  private readonly listeners = new Set<() => void>();
  private releaseState?: () => void;
  private active?: ActiveRequest;
  private disposed = false;
  /** Set while the chat writes the state, whose own report of that write the chat announces itself. */
  private writing = false;
  private revision = 0;
  /**
   * The conversation this chat runs under: its id, until the server names the one it created for
   * a chat started under `new`. Every later turn addresses that one.
   */
  private conversationId: string;

  constructor(init: ChatInit) {
    this.id = init.id;
    this.conversationId = init.id;
    this.init = init;
  }

  get status(): ChatStatus {
    return this.init.state.status;
  }

  get error(): Error | undefined {
    return this.init.state.error;
  }

  get connection(): ChatConnection {
    return this.init.state.connection;
  }

  get messages(): TMessage[] {
    return this.init.state.messages;
  }

  /**
   * Counts the changes reported to subscribers, writes made to the state outside the chat
   * included. A write can keep the same list while a message in it changed, so a snapshot keyed
   * by this sees every write.
   */
  get version(): number {
    return this.revision;
  }

  /**
   * Replaces the message list after the writes already queued. AI SDK: the `messages` setter. A
   * function receives the list current when it is written. The rollback of an optimistic write
   * treats it as it treats any write made after its own.
   */
  setMessages(messages: TMessage[] | ((current: TMessage[]) => TMessage[])): Promise<void> {
    return this.executor.run(() => {
      if (!this.disposed) {
        this.write(typeof messages === 'function' ? messages(this.messages) : messages);
      }
    });
  }

  /** Submits a user turn. Rejects while another turn of this chat is in flight. */
  sendMessage(input: SendMessageInput, options?: ChatRequestOptions): Promise<void> {
    return this.request({ trigger: 'submit-message', input }, options);
  }

  /** Regenerates the response to `messageId`, or the latest response. */
  regenerate(options: { messageId?: string } & ChatRequestOptions = {}): Promise<void> {
    const { messageId, ...requestOptions } = options;
    return this.request({ trigger: 'regenerate-message', messageId }, requestOptions);
  }

  /** Continues the response `messageId` where it stopped. */
  continue(options: { messageId: string } & ChatRequestOptions): Promise<void> {
    const { messageId, ...requestOptions } = options;
    return this.request({ trigger: 'continue-message', messageId }, requestOptions);
  }

  /** Returns a failed chat to `ready`. AI SDK: `clearError`. */
  clearError(): void {
    if (this.status !== 'error') {
      return;
    }
    this.init.state.error = undefined;
    this.setStatus('ready');
  }

  /** Notifies `listener` after every change to the messages, status or error. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    if (!this.releaseState && this.init.state.subscribe) {
      this.releaseState = this.init.state.subscribe(() => {
        if (!this.writing) {
          this.notify();
        }
      });
    }
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) {
        this.releaseState?.();
        this.releaseState = undefined;
      }
    };
  }

  /** Drops the local stream and every listener; the server's generation keeps running. */
  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    const active = this.active;
    this.active = undefined;
    active?.controller.abort();
    active?.stream?.close();
    const { state } = this.init;
    const unsent = active != null && !active.sent;
    const rollback = unsent ? active.optimistic : undefined;
    const status = unsent && state.status === 'submitted' ? 'ready' : state.status;
    if (rollback || status !== state.status || state.connection !== 'idle') {
      /**
       * A turn that never reached the server ends here, its optimistic rows with it; a sent one
       * keeps its status and rows, since the server keeps running it. Either way the chat holds
       * no stream.
       */
      if (active && rollback) {
        active.optimistic = undefined;
        state.replaceMessages(undoOptimisticWrite(rollback, state.messages));
      }
      state.status = status;
      state.connection = 'idle';
      this.notify();
    }
    /** Whoever waits on the request, such as its send, is released with the chat. */
    active?.finish();
    this.listeners.clear();
    this.releaseState?.();
    this.releaseState = undefined;
  }

  private async request(
    request: Omit<ChatPrepareRequest, 'chatId' | 'messages'>,
    options: ChatRequestOptions = {},
  ): Promise<void> {
    if (this.disposed) {
      throw new Error('The chat was disposed');
    }
    if (this.active) {
      throw new Error('A turn is already in flight for this chat');
    }
    const active = createActiveRequest({ responseless: true });
    this.active = active;
    try {
      this.init.state.error = undefined;
      this.setStatus('submitted');
      if (active.controller.signal.aborted) {
        throw active.controller.signal.reason;
      }
      const prepared = await untilAborted(
        this.init.prepareRequest({
          ...request,
          chatId: this.conversationId,
          messages: this.messages,
        }),
        active.controller.signal,
      );
      active.generation.responseId = prepared.responseMessageId;
      if (prepared.messages) {
        const optimistic = prepared.messages;
        await this.executor.run(() => {
          if (!active.controller.signal.aborted) {
            const before = this.messages;
            const written = typeof optimistic === 'function' ? optimistic(before) : optimistic;
            /** The rows as the state committed them, read before a chat subscriber writes more. */
            this.write(written, (committed) => {
              active.optimistic = recordOptimisticWrite(before, written, committed);
            });
            if (this.disposed && active.optimistic) {
              /** A store subscriber disposed the chat inside the write, before it had a record. */
              this.init.state.replaceMessages(
                undoOptimisticWrite(active.optimistic, this.messages),
              );
              active.optimistic = undefined;
            }
          }
        });
      }
      if (active.controller.signal.aborted) {
        throw active.controller.signal.reason;
      }
      /** Only now is the turn's response in the list, so a failure before this reports none. */
      active.generation.responseless = undefined;
      active.generation.conversationId = prepared.payload.conversationId ?? undefined;
      const { signal } = active.controller;
      active.sent = true;
      const result = await openUntilAborted(
        this.init.transport.sendMessages({
          ...options,
          trigger: request.trigger,
          chatId: this.conversationId,
          messageId: request.messageId,
          payload: prepared.payload,
          abortSignal: signal,
        }),
        signal,
        closeLateStart,
      );
      if (signal.aborted) {
        closeLateStart(result);
        throw signal.reason;
      }
      if (result.status === 'replaced' && result.generationProtocolVersion !== 2) {
        /** Only protocol v2 vouches for a replacement; an older server reported a conflict. */
        throw new Error('Another generation is running in this conversation');
      }
      if (result.status === 'settled' && result.generationProtocolVersion !== 2) {
        /** Only protocol v2 vouches for a settled start, which completes the turn without a stream. */
        throw new Error('The server answered with a settled start it did not negotiate');
      }
      if (result.status !== 'stream') {
        this.learnConversation(result.conversationId);
      }
      let stream: ChatStream | null = null;
      if (result.status === 'stream') {
        stream = result.stream;
        /** A start the server attached to a generation already running is an attachment too. */
        active.attached = result.stream.resumed === true;
      } else if (result.status === 'replaced') {
        const rollback = active.optimistic;
        if (rollback) {
          /** The server ran a newer generation instead, so this turn's optimistic write is undone. */
          await this.executor.run(() => {
            this.write(undoOptimisticWrite(rollback, this.messages));
          });
        }
        /** The replacement's response is not this turn's placeholder; its first frame names it. */
        active.generation.responseId = undefined;
        active.generation.responseUnknown = true;
        active.generation.conversationId = result.conversationId;
        active.attaching = true;
        active.attached = true;
        if (signal.aborted) {
          throw signal.reason;
        }
        this.setConnection('reconnecting');
        if (signal.aborted) {
          throw signal.reason;
        }
        stream = await openUntilAborted(
          this.init.transport.reconnectToStream({
            ...options,
            chatId: result.conversationId,
            streamId: result.streamId,
            generationCreatedAt: result.generationCreatedAt,
            resume: true,
            abortSignal: signal,
          }),
          signal,
          (opened) => opened?.close(),
        );
      }
      if (!stream) {
        /** The server finished the turn, or the generation replacing it, before it attached. */
        const conversationId = result.status === 'stream' ? undefined : result.conversationId;
        this.settle({ kind: 'complete', settled: { conversationId } }, active);
        return;
      }
      await this.consume(stream, active);
    } catch (error) {
      this.settle(this.toOutcome(error, active), active);
    } finally {
      this.release(active);
    }
  }

  private async consume(stream: ChatStream, active: ActiveRequest): Promise<void> {
    const { signal } = active.controller;
    if (signal.aborted) {
      /** The request was cancelled while the stream was still being opened. */
      stream.close();
      this.settle({ kind: 'abort' }, active);
      return;
    }
    active.stream = stream;
    active.attaching = undefined;
    let outcome: Outcome | undefined;
    /** The event this chat is applying, whose failure is the chat's, not the generation's. */
    let handling: ChatEvent | undefined;
    try {
      this.setConnection('live');
      for await (const event of stream) {
        if (signal.aborted) {
          break;
        }
        await this.executor.run(() => {
          if (!signal.aborted) {
            handling = event;
            this.adopt(active.generation, getFrameIdentity(event));
            outcome = this.apply(event, active);
            handling = undefined;
          }
        });
        if (outcome) {
          break;
        }
      }
    } catch (error) {
      if (signal.aborted) {
        outcome = this.toOutcome(error, active);
      } else if (handling) {
        outcome = getApplyFailure(handling, error, active.attached === true);
      } else {
        /** The stream failed before a terminal frame, as one that ends early does: a disconnect. */
        const failure = error instanceof Error ? error : new Error(String(error));
        outcome = { kind: 'error', error: failure, disconnect: true };
      }
    } finally {
      stream.close();
    }
    if (!outcome && signal.aborted) {
      outcome = { kind: 'abort' };
    }
    this.settle(
      outcome ?? {
        kind: 'error',
        error: new Error('The stream ended before the response finished'),
        disconnect: true,
      },
      active,
    );
  }

  /** Applies one event; returns the turn's outcome when the event ends it. */
  private apply(event: ChatEvent, active: ActiveRequest): Outcome | undefined {
    const applyEvent = this.init.applyEvent ?? defaultApplyEvent;
    applyEvent(event, {
      messages: this.messages,
      write: (messages) => this.write(messages),
    });
    /** A listener told of that write may have disposed the chat, which then owns no more state. */
    if (this.disposed) {
      return undefined;
    }
    let outcome: Outcome | undefined;
    if (streamingEvents.has(event.type) || event.type === 'pending_action') {
      /** A live pause is the generation running, however its first frame arrives. */
      if (this.markStreaming()) {
        this.notify();
      }
    } else if (event.type === 'final') {
      outcome = getFinalOutcome(event.data);
    } else if (event.type === 'abort') {
      outcome = { kind: 'abort' };
    } else if (event.type === 'error') {
      const disconnect = event.status === 0 || (active.attached === true && isAttachFailure(event));
      const message = getErrorMessage(event.data) ?? 'The response failed';
      outcome = { kind: 'error', error: new Error(message), disconnect };
    }
    this.callHost(this.init.onEvent, event);
    return outcome;
  }

  /**
   * Moves to `streaming` on a frame of a live generation, which also ends whatever failure a
   * dropped connection reported. Returns whether anything changed.
   */
  private markStreaming(): boolean {
    const { state } = this.init;
    if (state.status === 'streaming' && state.error === undefined) {
      return false;
    }
    state.error = undefined;
    state.status = 'streaming';
    return true;
  }

  private toOutcome(error: unknown, active: ActiveRequest): Outcome {
    if (active.controller.signal.aborted) {
      return { kind: 'abort' };
    }
    const failure = error instanceof Error ? error : new Error(String(error));
    /**
     * A request that never got a response may still be running on the server, and so may a
     * generation a failed attachment never reached, unless the server answered that it is gone.
     */
    const disconnect =
      isRetryableNetworkError(failure) ||
      (active.attaching === true && !isGone(failure as ChatTransportError));
    return { kind: 'error', error: failure, disconnect };
  }

  private settle(outcome: Outcome, active: ActiveRequest): void {
    if (this.active !== active) {
      return;
    }
    /**
     * Released and published as one change before anyone is told, so a subscriber or callback
     * that starts the next turn is not overwritten by this one's terminal state.
     */
    this.active = undefined;
    const { responseId, responseUnknown, responseless, conversationId } = active.generation;
    const named = conversationId !== Constants.NEW_CONVO ? conversationId : undefined;
    this.publish({ ...outcome, conversationId: named }, responseId, responseUnknown, responseless);
  }

  /**
   * Adopts the ids a frame names: the conversation for the generation and, for a chat started
   * under `new`, for the chat; and the response the generation produces, which makes it known.
   */
  private adopt(generation: Generation, identity: FrameIdentity): void {
    const { conversationId, responseMessageId } = identity;
    if (conversationId && conversationId !== Constants.NEW_CONVO) {
      generation.conversationId = conversationId;
      this.learnConversation(conversationId);
    }
    if (responseMessageId) {
      generation.responseId = responseMessageId;
      generation.responseUnknown = false;
    }
  }

  /** Adopts the conversation the server created for a chat started under `new`; a real id stays. */
  private learnConversation(conversationId: string | null | undefined): void {
    if (
      conversationId &&
      conversationId !== Constants.NEW_CONVO &&
      this.conversationId === Constants.NEW_CONVO
    ) {
      this.conversationId = conversationId;
    }
  }

  /** Publishes a turn's terminal state, then tells the host how it ended. */
  private publish(
    outcome: Outcome,
    responseId: string | undefined,
    responseUnknown = false,
    responseless = false,
  ): void {
    const { state } = this.init;
    const status: ChatStatus = outcome.kind === 'error' ? 'error' : 'ready';
    if (state.connection !== 'idle') {
      state.connection = 'idle';
    }
    if (state.status !== status) {
      state.status = status;
    }
    state.error = outcome.kind === 'error' ? outcome.error : undefined;
    const messages = this.messages;
    let message: TMessage | undefined;
    if (responseId !== undefined) {
      message = messages.find((stored) => stored.messageId === responseId);
    } else if (!responseUnknown && !responseless) {
      message = messages[messages.length - 1];
    }
    const { settled } = outcome;
    /** A settled outcome names its conversation; otherwise the one the turn's frames named. */
    const reportedConversation = settled?.conversationId ?? outcome.conversationId;
    this.notify();
    if (outcome.kind === 'error') {
      this.callHost(this.init.onError, outcome.error);
    }
    this.callHost(this.init.onFinish, {
      message,
      messages,
      isAbort: outcome.kind === 'abort',
      isDisconnect: outcome.kind === 'error' && outcome.disconnect,
      isError: outcome.kind === 'error',
      isSettled: settled !== undefined,
      isResponseUnknown: responseUnknown,
      ...(reportedConversation !== undefined && { conversationId: reportedConversation }),
      ...(settled?.reason !== undefined && { reconcileReason: settled.reason }),
    });
  }

  private release(active: ActiveRequest): void {
    if (this.active === active) {
      this.active = undefined;
    }
    active.finish();
  }

  /**
   * Every write below is the chat's own; a disposed chat owns none of the shared state. `commit`
   * reads the list the state committed before anyone is told of it, including a store that
   * reports its own writes.
   */
  private write(messages: TMessage[], commit?: (committed: TMessage[]) => void): void {
    if (this.disposed) {
      return;
    }
    this.writing = true;
    try {
      this.init.state.replaceMessages(messages);
    } finally {
      this.writing = false;
    }
    commit?.(this.messages);
    this.notify();
  }

  private setStatus(status: ChatStatus): void {
    if (this.disposed || this.init.state.status === status) {
      return;
    }
    this.init.state.status = status;
    this.notify();
  }

  private setConnection(connection: ChatConnection): void {
    if (this.disposed || this.init.state.connection === connection) {
      return;
    }
    this.init.state.connection = connection;
    this.notify();
  }

  /** Runs a host callback; one that throws is reported and never interrupts the chat's transition. */
  private callHost<T>(callback: ((value: T) => void) | undefined, value: T): void {
    try {
      callback?.(value);
    } catch (error) {
      reportListenerError(error);
    }
  }

  private notify(): void {
    this.revision += 1;
    for (const listener of this.listeners) {
      try {
        listener();
      } catch (error) {
        reportListenerError(error);
      }
    }
  }
}
