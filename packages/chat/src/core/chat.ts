import { Constants } from 'librechat-data-provider';
import type {
  TPayload,
  TMessage,
  ChatEvent,
  UITextPart,
  TPendingSteer,
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
  ChatAbortResult,
  ChatAbortRequest,
  ChatStreamAbortResult,
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
  /**
   * Why a settled turn's final frame carried no messages. `abort_persistence_failed` means the
   * stop was not saved, so work queued behind it must not run.
   */
  reconcileReason?: ChatFinalFrame['reconcileReason'];
};

/**
 * What a stop did. `stopped` ended the turn, `idle` found nothing to stop, and `unaddressable`
 * means a generation may still run that this chat saw no frame for (a start whose response was
 * lost, or a turn under `new` before its sync frame), so the caller stops it on its own abort path.
 */
export type ChatStopResult =
  | {
      status: 'stopped';
      /** The conversation the server stopped, authoritative while the chat still holds `new`. */
      conversationId?: string;
      /** Steers the run never injected, which the host restores as queued turns. */
      pendingSteers?: TPendingSteer[];
    }
  | { status: 'idle' }
  | { status: 'unaddressable' };

const unaddressable: ChatStopResult = { status: 'unaddressable' };

export type ChatInit = {
  /** The conversation id, or `new` before the server created one. */
  id: string;
  state: ChatState;
  transport: ChatTransport;
  /**
   * Builds the request body, and the optimistic messages, for a turn. AI SDK:
   * `prepareSendMessagesRequest`. The payload's endpoint is what a stop addresses.
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

/**
 * A generation on the server as this chat knows it. It outlives the requests attached to it, so a
 * stop and the request it ends read and write one record instead of copying its fields across.
 */
type Generation = {
  endpoint?: string;
  /** The conversation the payload, the server's answer or a frame named. */
  conversationId?: string;
  /** The response this generation produces: the placeholder, then the one a frame names. */
  responseId?: string;
  /**
   * The generation is not the one this chat prepared (a replacement) and no frame has named its
   * response yet.
   */
  responseUnknown?: boolean;
  /** Set once the server confirmed a stop, so a stream that drops instead of ending aborts. */
  stopped?: boolean;
  /** The terminal status a stop answer reported for a run that had already ended on its own. */
  settledAs?: ChatStreamAbortResult['terminalStatus'];
  /** The stop ended the run without saving its terminal state, which a reconcile frame reports. */
  persistenceFailed?: boolean;
  /**
   * The server confirmed it stopped the stream, whose abort frame carries the saved response. A
   * request that ends without that frame leaves the host to reload what the server kept.
   */
  stopFramed?: boolean;
  /** The conversation a stop's answer named, authoritative while the chat still holds `new`. */
  stoppedConversationId?: string;
  /** Resolves once a stop sent for this generation was answered, either way. */
  stopAnswered?: Promise<void>;
  /** The stop in flight or confirmed, which a second stop joins instead of sending again. */
  stopping?: Promise<ChatAbortResult>;
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
  /**
   * Set while attaching to the generation the server answered the start with, before it attaches,
   * naming the stream a stop addresses meanwhile.
   */
  reattach?: { streamId?: string };
  /**
   * The stream came from attaching to a running generation, whose HTTP failure ends only the
   * attachment unless the server says the generation is gone.
   */
  attached?: boolean;
  /** The generation the start was answered with; a stream of another one starts a new record. */
  inheritedGeneration?: number;
  /** The error the request settled with when its connection dropped. */
  disconnected?: Error;
  /** Set once the start was handed to the transport, so the server may be running it. */
  sent?: boolean;
  /**
   * The conversation the start was sent under. One sent under `new` created a conversation of its
   * own, so no answer about another start or conversation resolves it if it is lost.
   */
  sentUnder?: string;
  /**
   * Set once the server answered for the start after it was cancelled, which can happen before the
   * request settles, so the stop that cancelled it owes nothing for it.
   */
  resolved?: boolean;
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

/** Settles with `value`, or rejects once `signal` aborts, so a stop never waits on it. */
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

/** A run that ended on its own before a stop reached it, whose final frame never arrived. */
const getSettledOutcome = (
  status: ChatStreamAbortResult['terminalStatus'],
  settled: Settled = {},
): Outcome => {
  if (status === 'error') {
    return { kind: 'error', error: new Error('The response failed'), disconnect: false, settled };
  }
  return status === 'aborted' ? { kind: 'abort', settled } : { kind: 'complete', settled };
};

/** What a confirmed stop ends a request with when no terminal frame said otherwise. */
const getStopOutcome = (stop: {
  settledAs?: ChatStreamAbortResult['terminalStatus'];
  persistenceFailed?: boolean;
  stopFramed?: boolean;
  /** The conversation the stop's answer named, which the host reloads. */
  stoppedConversationId?: string;
}): Outcome => {
  const settled: Settled =
    stop.stoppedConversationId != null ? { conversationId: stop.stoppedConversationId } : {};
  if (stop.persistenceFailed) {
    return { kind: 'abort', settled: { ...settled, reason: 'abort_persistence_failed' } };
  }
  if (stop.settledAs) {
    return getSettledOutcome(stop.settledAs, settled);
  }
  /** Read only where no abort frame ended the request, so the saved response was never received. */
  return stop.stopFramed ? { kind: 'abort', settled } : { kind: 'abort' };
};

/** The answer for a stop the server says found no generation, as an already-settled run. */
const goneStop: ChatStreamAbortResult = { success: false, settled: true, code: 'NO_ACTIVE_RUN' };

const isStreamAbort = (result: ChatAbortResult): result is ChatStreamAbortResult =>
  result != null && 'success' in result;

/**
 * How a stop's answer says the run had already ended on its own: a settled stream, or an
 * Assistants answer of `null`, which finds no run left and leaves the host to reload what it kept.
 */
const getSettledAs = (result: ChatAbortResult): ChatStreamAbortResult['terminalStatus'] => {
  if (result === null) {
    return 'complete';
  }
  return isStreamAbort(result) && result.settled
    ? (result.terminalStatus ?? 'complete')
    : undefined;
};

/**
 * What a stop hands back to the host. Steers come back only from a stop that ended the run: one
 * that settled first leaves them to its own terminal frame, and an unsaved one has none to trust.
 */
const getStopResult = (result: ChatAbortResult, conversationId?: string): ChatStopResult => {
  if (!isStreamAbort(result)) {
    /** An Assistants run's answer carries the conversation, which a first turn's server created. */
    const created = result?.conversation?.conversationId ?? undefined;
    return { status: 'stopped', ...(created != null && { conversationId: created }) };
  }
  const ended = !result.settled && !result.persistenceFailed;
  return {
    status: 'stopped',
    ...(conversationId != null && { conversationId }),
    ...(ended && result.pendingSteers && { pendingSteers: result.pendingSteers }),
  };
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
 * stays as it is. A row that stays keeps the rows the write added above it, so the tree never loses
 * the parent of a row it still lists.
 */
const undoOptimisticWrite = (record: OptimisticWrite, current: TMessage[]): TMessage[] => {
  const dropped = new Map<string, TMessage>();
  const undone = current.map((message) => {
    if (record.committed.get(message.messageId) !== message) {
      return message;
    }
    const was = record.replaced.get(message.messageId);
    if (was == null) {
      dropped.set(message.messageId, message);
    }
    return was;
  });
  for (const row of undone) {
    let parent = row != null ? dropped.get(row.parentMessageId ?? '') : undefined;
    while (parent != null && dropped.delete(parent.messageId)) {
      parent = dropped.get(parent.parentMessageId ?? '');
    }
  }
  const next: TMessage[] = [];
  const kept = new Set<string>();
  current.forEach((message, index) => {
    const row = dropped.has(message.messageId) ? undefined : (undone[index] ?? message);
    if (row != null) {
      next.push(row);
      kept.add(row.messageId);
    }
  });
  record.before.forEach((message, index) => {
    if (record.removed.has(message.messageId) && !kept.has(message.messageId)) {
      next.splice(getRestoreIndex(record.before, index, next), 0, message);
    }
  });
  return next;
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
  /** Aborted on dispose, which ends every wait on the server so no caller outlives the chat. */
  private readonly lifetime = new AbortController();
  /** The newest start handed to the transport, whose conversation a late answer must not replace. */
  private latestStart?: ActiveRequest;
  /**
   * A start that reached the transport and lost its response, with nothing to address it by. It
   * stays the caller's to stop until an answer resolves that start, or one its conversation covers.
   */
  private lostStart?: ActiveRequest;
  /**
   * The conversation this chat runs under: its id, until the server names the one it created for
   * a chat started under `new`. Every later start and stop addresses that one.
   */
  private conversation: string;

  constructor(init: ChatInit) {
    this.id = init.id;
    this.conversation = init.id;
    this.init = init;
  }

  /** The conversation this chat runs under: its id, or the one the server created under `new`. */
  get conversationId(): string {
    return this.conversation;
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

  /**
   * Stops the turn in flight. A request still starting is cancelled; an attached stream is
   * stopped on the server, and this resolves once the stream reported its end. Rejects when the
   * server refused the stop, leaving the stream attached. Resolves with the steers the run never
   * injected, for the host to restore, or `unaddressable` without contacting the server when the
   * chat holds no frame-backed identity for the generation.
   */
  async stop(): Promise<ChatStopResult> {
    if (this.disposed) {
      /** A disposed chat leaves the server's generation running, as dispose does. */
      return { status: 'idle' };
    }
    const active = this.active;
    if (!active) {
      /** The lost start is still the caller's. */
      return this.lostStart ? unaddressable : { status: 'idle' };
    }
    if (!active.stream && !active.reattach) {
      active.controller.abort();
      await active.finished;
      /**
       * A start already handed to the transport may be running on the server with no frame naming
       * it; a late stream is stopped by `dropLateStart`, but one that never arrives is the caller's.
       */
      const own: ChatStopResult =
        active.sent && !active.resolved ? unaddressable : { status: 'stopped' };
      return this.orUnaddressed(own);
    }
    const { generation } = active;
    if (!generation.endpoint) {
      throw new Error('The generation cannot be stopped without its endpoint');
    }
    const streamId = active.stream?.streamId ?? active.reattach?.streamId;
    const target = {
      endpoint: generation.endpoint,
      streamId,
      generationCreatedAt: active.stream?.generationCreatedAt ?? active.inheritedGeneration,
      abortKey: streamId == null ? this.abortKey(generation) : undefined,
    };
    if (!this.isAddressable(target)) {
      return unaddressable;
    }
    const result = await this.stopGeneration(generation, target);
    return this.orUnaddressed(await this.endStopped(active, generation, result));
  }

  /**
   * A stop's answer, unless a start this chat lost may still run on the server with nothing to
   * address it by; then the caller still owes its separate abort.
   */
  private orUnaddressed(result: ChatStopResult): ChatStopResult {
    /** Only an answer about the lost start clears it, not a turn a callback started meanwhile. */
    return this.lostStart ? unaddressable : result;
  }

  /** Sends a stop and records its answer on the generation, where every attachment reads it. */
  private stopGeneration(
    generation: Generation,
    target: Omit<ChatAbortRequest, 'chatId'>,
  ): Promise<ChatAbortResult> {
    if (generation.stopping) {
      return generation.stopping;
    }
    /** A start sent while the stop waited may run in a conversation of its own, which wins. */
    const since = this.latestStart;
    const answer = this.abortOnServer(target).then((result) => {
      generation.stopped = true;
      this.adoptStopAnswer(generation, result, since);
      generation.settledAs = getSettledAs(result);
      if (!generation.settledAs && isStreamAbort(result) && result.persistenceFailed) {
        generation.persistenceFailed = true;
      }
      generation.stopFramed =
        isStreamAbort(result) && !generation.settledAs && !generation.persistenceFailed;
      return result;
    });
    generation.stopping = answer;
    generation.stopAnswered = answer.then(
      () => undefined,
      () => {
        /** A refused stop leaves the generation running, so the next stop is sent anew. */
        generation.stopping = undefined;
      },
    );
    return answer;
  }

  /** Ends the request attached to a generation the server confirmed stopped. */
  private async endStopped(
    active: ActiveRequest,
    generation: Generation,
    result: ChatAbortResult,
  ): Promise<ChatStopResult> {
    const owns = () => active.generation === generation;
    if (!owns()) {
      /** The request moved on to another generation while the stop was in flight; that one runs on. */
      return getStopResult(result, generation.stoppedConversationId);
    }
    if (result && 'runMessages' in result) {
      await this.mergeRunMessages(result.runMessages, () => this.active === active && owns());
      if (!owns()) {
        /** The request opened another generation while the merge waited its turn. */
        return getStopResult(result, generation.stoppedConversationId);
      }
      active.controller.abort();
      active.stream?.close();
    } else if (result === null || result === goneStop || generation.settledAs) {
      /**
       * No run was left to stop, or it had already ended on its own: the answer is the end, so the
       * attachment closes rather than waiting on a terminal frame that may never arrive.
       */
      active.controller.abort();
      active.stream?.close();
    } else if (!active.stream && !generation.persistenceFailed) {
      /**
       * Still attaching: nothing will report the end, so the stop ends the request here. An
       * unsaved stop stays attached for the reconcile frame that reports it.
       */
      active.controller.abort();
    }
    await active.finished;
    if (this.disposed) {
      /** A chat disposed while the stop ended its request writes no state. */
      return getStopResult(result, generation.stoppedConversationId);
    }
    this.notify();
    return getStopResult(result, generation.stoppedConversationId);
  }

  /**
   * Drops a start that reached the server after it was cancelled. A stop also ends its generation
   * there; a disposal leaves it running, as it does an attached one.
   */
  private dropLateStart(active: ActiveRequest, sent: ChatSendResult): void {
    if (sent.status === 'stream') {
      sent.stream.close();
    }
    const answered = sent.status === 'settled' || sent.status === 'replaced';
    if (answered && sent.generationProtocolVersion === 2) {
      /**
       * The server finished the start on its own, or answered it with a newer generation this
       * request does not own and leaves alone; either way its stop has nothing left to reach, and
       * the answer names the conversation a chat started under `new` adopts.
       */
      if (!this.startsAfter(active)) {
        this.learnConversation(sent.conversationId);
      }
      this.resolveLostStart(active);
      return;
    }
    const { endpoint } = active.generation;
    if (this.disposed || !endpoint || sent.status !== 'stream') {
      return;
    }
    const { streamId, generationCreatedAt } = sent.stream;
    const target = {
      endpoint,
      streamId,
      generationCreatedAt,
      abortKey: streamId == null ? this.abortKey(active.generation) : undefined,
    };
    if (!this.isAddressable(target)) {
      /** Nothing names it; the stop already reported it unaddressable to the caller. */
      return;
    }
    void this.abortOnServer(target).then(
      (result) => {
        /** The answer names the conversation the start created, unless a newer start owns the chat. */
        this.adoptStopAnswer(active.generation, result, active);
        this.resolveLostStart(active);
      },
      (error: unknown) =>
        this.disposed
          ? undefined
          : this.callHost(
              this.init.onError,
              error instanceof Error ? error : new Error(String(error)),
            ),
    );
  }

  /**
   * Records the conversation a stop's answer names for `generation`, which a chat started under
   * `new` adopts unless a start sent after `since` may run in a conversation of its own.
   */
  private adoptStopAnswer(
    generation: Generation,
    result: ChatAbortResult,
    since: ActiveRequest | undefined,
  ): void {
    if (isStreamAbort(result)) {
      generation.stoppedConversationId = this.stoppedConversationId(generation, result);
    }
    if (this.startsAfter(since)) {
      return;
    }
    this.learnConversation(
      isStreamAbort(result)
        ? generation.stoppedConversationId
        : result?.conversation?.conversationId,
    );
  }

  /**
   * A start the chat reported lost is now answered for: its marker clears, and the failure it
   * reported resolves unless a newer turn owns the chat.
   */
  private resolveLostStart(active: ActiveRequest): void {
    active.resolved = true;
    if (this.lostStart !== active) {
      return;
    }
    this.lostStart = undefined;
    const failed = active.disconnected;
    if (this.disposed || this.active || !failed || this.error !== failed) {
      return;
    }
    this.init.state.error = undefined;
    this.init.state.status = 'ready';
    this.notify();
  }

  /**
   * Whether a start sent after `since` is still running or lost, so it may own a conversation of its own
   * that a late answer about an older generation must not replace.
   */
  private startsAfter(since: ActiveRequest | undefined): boolean {
    const latest = this.latestStart;
    return (
      latest != null && latest !== since && (latest === this.active || latest === this.lostStart)
    );
  }

  /**
   * An Assistants run's stream ends without a final frame; the stop's answer carries it as the
   * conversation's stored messages, so they replace the list and rows the run deleted go with it.
   * `owns` is checked when the write runs, so a turn that took over while it queued keeps its list.
   */
  private mergeRunMessages(runMessages: TMessage[], owns: () => boolean): Promise<void> {
    return this.executor.run(() => {
      if (!owns() || runMessages.length === 0) {
        return;
      }
      const local = new Map(this.messages.map((message) => [message.messageId, message]));
      this.write(runMessages.map((message) => ({ ...local.get(message.messageId), ...message })));
    });
  }

  /**
   * The conversation a stop that named its stream ended. The answer names only the stream, so the
   * generation's known conversation wins; a first turn no frame named yet falls back to that
   * stream id, which a resumable server keys by the conversation it created. A run that settled
   * before the stop reached it names that stream as `streamId` instead of `aborted`.
   */
  private stoppedConversationId(
    generation: Generation,
    result: ChatStreamAbortResult,
  ): string | undefined {
    const stream = result.aborted ?? result.streamId;
    if (stream == null) {
      return undefined;
    }
    const known = generation.conversationId ?? this.conversationId;
    return known !== Constants.NEW_CONVO ? known : stream;
  }

  /** `conversationId:responseMessageId` of a run with no resumable stream (Assistants). */
  private abortKey(generation: Generation): string | undefined {
    const conversationId = generation.conversationId ?? this.conversationId;
    if (conversationId === Constants.NEW_CONVO) {
      /** Before its sync frame, a turn under `new` has no id the server knows it by. */
      return undefined;
    }
    return generation.responseId ? `${conversationId}:${generation.responseId}` : undefined;
  }

  /** Whether a stop can name the generation: by its stream, its run key, or a created chat. */
  private isAddressable(target: Omit<ChatAbortRequest, 'chatId'>): boolean {
    return (
      target.streamId != null ||
      target.abortKey != null ||
      this.conversationId !== Constants.NEW_CONVO
    );
  }

  /**
   * Stops a generation on the server. A run that already reached its own end counts as stopped;
   * a refusal rejects.
   */
  private async abortOnServer(target: Omit<ChatAbortRequest, 'chatId'>): Promise<ChatAbortResult> {
    if (this.lifetime.signal.aborted) {
      throw this.lifetime.signal.reason;
    }
    const result = await untilAborted(
      this.init.transport
        .abort({ chatId: this.conversationId, ...target })
        .catch((error: unknown) => {
          if (isGone(error as ChatTransportError)) {
            /** Nothing is left to stop, so the run ended on its own and the host reloads it. */
            return goneStop;
          }
          throw error;
        }),
      this.lifetime.signal,
    );
    if (result && 'success' in result && !result.success && !result.settled) {
      throw new Error(result.error ?? 'The server refused the stop');
    }
    return result;
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
    this.lifetime.abort(new Error('The chat was disposed'));
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
    /** Whoever waits on the request, such as its send or a stop, is released with the chat. */
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
          chatId: this.conversation,
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
      active.generation.endpoint = prepared.payload.endpoint ?? undefined;
      active.generation.conversationId = prepared.payload.conversationId ?? undefined;
      const { signal } = active.controller;
      active.sent = true;
      active.sentUnder = this.conversation;
      this.latestStart = active;
      const result = await openUntilAborted(
        this.init.transport.sendMessages({
          ...options,
          trigger: request.trigger,
          chatId: this.conversation,
          messageId: request.messageId,
          payload: prepared.payload,
          abortSignal: signal,
        }),
        signal,
        (sent) => this.dropLateStart(active, sent),
      );
      if (signal.aborted) {
        this.dropLateStart(active, result);
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
      if (this.lostStart?.sentUnder !== Constants.NEW_CONVO) {
        /**
         * The server took a start in the lost start's conversation, where one generation runs, so it
         * owns or superseded it. One sent under `new` created a conversation no other start covers.
         */
        this.lostStart = undefined;
      }
      let stream: ChatStream | null = null;
      if (result.status === 'stream') {
        stream = result.stream;
        /** A start the server attached to a generation already running is an attachment too. */
        active.attached = result.stream.resumed === true;
      } else if (result.status === 'replaced') {
        /**
         * The replacement it names, so a stream of yet another generation gets its own record.
         * Recorded before the rollback notifies, so a stop made then addresses the replacement.
         */
        active.inheritedGeneration = result.generationCreatedAt ?? undefined;
        active.reattach = { streamId: result.streamId };
        active.attached = true;
        /** The replacement's response is not this turn's placeholder; its first frame names it. */
        active.generation.responseId = undefined;
        active.generation.responseUnknown = true;
        active.generation.conversationId = result.conversationId;
        const rollback = active.optimistic;
        if (rollback) {
          /** The server ran a newer generation instead, so this turn's optimistic write is undone. */
          await this.executor.run(() => {
            this.write(undoOptimisticWrite(rollback, this.messages));
          });
        }
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
      if (!stream && active.generation.stopAnswered) {
        /** A stop still in flight decides how an empty reconnect ended. */
        await active.generation.stopAnswered;
      }
      if (!stream && active.generation.stopped) {
        this.settle(getStopOutcome(active.generation), active);
        return;
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
      this.settle(getStopOutcome(active.generation), active);
      return;
    }
    active.stream = stream;
    if (
      active.inheritedGeneration != null &&
      stream.generationCreatedAt != null &&
      stream.generationCreatedAt !== active.inheritedGeneration
    ) {
      /**
       * The attachment found another generation, whose response no frame has named yet. It gets
       * its own record, so a stop of the one it was answered with does not end it.
       */
      const { endpoint, conversationId } = active.generation;
      active.generation = { endpoint, conversationId, responseUnknown: true };
    }
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
            /** Recorded first, so a host that stops from the event's own callbacks names the run. */
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
    const unresolved = !outcome || (outcome.kind === 'error' && outcome.disconnect);
    if (unresolved && active.generation.stopAnswered) {
      /** A stream that ended during a stop is settled by the server's answer to it. */
      await active.generation.stopAnswered;
    }
    if (active.generation.stopped && unresolved) {
      /** Including one the stop itself closed, whose answer may say the run had already ended. */
      outcome = getStopOutcome(active.generation);
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
      /** A listener told of that status may have disposed the chat too. */
      if (this.disposed) {
        return undefined;
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
    if (
      active.controller.signal.aborted &&
      active.sent &&
      !active.resolved &&
      !active.stream &&
      !active.reattach
    ) {
      /** A start cancelled before its answer may still run on the server, so its end is unknown. */
      return {
        kind: 'error',
        error: new Error('The stop could not reach the generation, which may still be running'),
        disconnect: true,
      };
    }
    if (active.controller.signal.aborted) {
      return getStopOutcome(active.generation);
    }
    const failure = error instanceof Error ? error : new Error(String(error));
    /**
     * A request that never got a response may still be running on the server, and so may a
     * generation a failed attachment never reached, unless the server answered that it is gone.
     */
    const attaching = active.reattach != null && !active.stream;
    const disconnect =
      isRetryableNetworkError(failure) || (attaching && !isGone(failure as ChatTransportError));
    return { kind: 'error', error: failure, disconnect };
  }

  private settle(outcome: Outcome, active: ActiveRequest): void {
    if (this.active !== active) {
      return;
    }
    if (outcome.kind === 'error' && outcome.disconnect) {
      active.disconnected = outcome.error;
      if (active.sent && !active.stream && !active.reattach && !active.resolved) {
        /** The start may have reached the server, which answered nothing this chat can address. */
        this.lostStart = active;
      }
    }
    /**
     * Released and published as one change before anyone is told, so a subscriber or callback
     * that starts the next turn is not overwritten by this one's terminal state.
     */
    this.active = undefined;
    const { responseId, responseUnknown, responseless, conversationId } = active.generation;
    const named = conversationId !== Constants.NEW_CONVO ? conversationId : undefined;
    /** A lost start still owed its own abort keeps the failure it reported. */
    const owed = this.lostStart !== active ? this.lostStart?.disconnected : undefined;
    this.publish(
      { ...outcome, conversationId: named },
      responseId,
      responseUnknown,
      responseless,
      owed,
    );
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
      this.conversation === Constants.NEW_CONVO
    ) {
      this.conversation = conversationId;
    }
  }

  /** Publishes a turn's terminal state, then tells the host how it ended. */
  private publish(
    outcome: Outcome,
    responseId: string | undefined,
    responseUnknown = false,
    responseless = false,
    /** A failure another start reported, which this terminal state does not resolve. */
    owed?: Error,
  ): void {
    const { state } = this.init;
    const status: ChatStatus = outcome.kind === 'error' || owed ? 'error' : 'ready';
    /**
     * One terminal state, with the chat's listeners told once it is all set. A store subscriber
     * told of a field may start the next turn, which then owns the fields this one has not set.
     */
    this.writing = true;
    try {
      if (state.connection !== 'idle') {
        state.connection = 'idle';
      }
      if (!this.active && state.status !== status) {
        state.status = status;
      }
      if (!this.active) {
        state.error = outcome.kind === 'error' ? outcome.error : owed;
      }
    } finally {
      this.writing = false;
    }
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
