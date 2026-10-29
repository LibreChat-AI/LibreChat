import { Constants, ContentTypes, ApprovalEvents } from 'librechat-data-provider';
import type {
  Agents,
  TPayload,
  TMessage,
  ChatEvent,
  UITextPart,
  TPendingSteer,
  ChatFinalFrame,
  ChatSyncFrame,
  ChatErrorData,
  TMessageContentParts,
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
  ChatResumeSelection,
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
  /** The agent selection a paused generation resumes with, matching the request that started it. */
  resumeSelection?(): Omit<ChatResumeSelection, 'conversationId' | 'generationCreatedAt'>;
  onError?(error: Error): void;
  onFinish?(result: ChatFinishResult): void;
  /** Every event, after it was applied: the side channels (usage, title, attachments, steering). */
  onEvent?(event: ChatEvent): void;
};

/** A tool call's review decision. AI SDK: `addToolApprovalResponse`. */
export type ToolApprovalResponse = {
  /** The paused tool call's id. */
  id: string;
  approved: boolean;
  reason?: string;
  /** A decision other than approve or reject, such as `edit` or `respond`; it overrides `approved`. */
  decision?: Agents.ToolApprovalResolution['decision'];
  editedArguments?: Agents.ToolApprovalResolution['editedArguments'];
  responseText?: Agents.ToolApprovalResolution['responseText'];
  scope?: Agents.ToolApprovalResolution['scope'];
};

/** The answer to an `ask_user_question` pause: free text, or answers keyed by question id. */
export type ToolOutput = {
  toolCallId: string;
  output: string | Record<string, string>;
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
 * drop, a reattachment and a stop read and write one record instead of copying its fields across.
 */
type Generation = {
  endpoint?: string;
  /** The conversation the payload, the server's answer or a frame named. */
  conversationId?: string;
  /** The response this generation produces: the placeholder, then the one a frame names. */
  responseId?: string;
  /**
   * The generation is not the one this chat prepared (a replacement, or a reattachment that found
   * another generation) and no frame has named its response yet.
   */
  responseUnknown?: boolean;
  /** The pause this generation reported, which a confirmed stop ends. */
  paused?: string;
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

type DetachedGeneration = {
  error: Error;
  target: Omit<ChatAbortRequest, 'chatId'>;
  generation: Generation;
};

type ActiveRequest = {
  controller: AbortController;
  /** The optimistic write, undone when the server never got the turn or ran another in its place. */
  optimistic?: OptimisticWrite;
  stream?: ChatStream;
  /** The generation this request runs or attaches to. */
  generation: Generation;
  /**
   * Set when reattaching to a generation already running on the server, before it attaches.
   * `continuation` marks one whose pause was answered meanwhile, so finding nothing means it ended.
   */
  reattach?: { streamId?: string; continuation?: boolean };
  /**
   * The stream came from attaching to a running generation, whose HTTP failure ends only the
   * attachment unless the server says the generation is gone.
   */
  attached?: boolean;
  /** The generation a reattachment continued; a stream of another one starts a new record. */
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

/**
 * A resume the server refused because the pause is over: no paused generation (404), or a conflict
 * (409) such as a replaced run or an action answered elsewhere. A 409 that only says the event
 * actor is not ready yet leaves the pause answerable for a retry.
 */
const isPauseOver = (error: ChatTransportError): boolean => {
  const status = error.response?.status;
  if (status === 404) {
    return true;
  }
  const code = (error.response?.data as { code?: string } | undefined)?.code;
  return status === 409 && code !== 'EVENT_ACTOR_NOT_READY';
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

/** The longest delay `setTimeout` honors; a longer one fires at once. */
const MAX_TIMER_DELAY = 2_147_483_647;

/**
 * The pause a sync frame carries: one buffered after the snapshot, the newest of which stands,
 * else the snapshot's own. The server sends a live pause in either place.
 */
const getSnapshotPause = (data: ChatSyncFrame): Agents.PendingAction | undefined => {
  const buffered = data.pendingEvents ?? [];
  for (let i = buffered.length - 1; i >= 0; i--) {
    const frame = buffered[i];
    if ('event' in frame && frame.event === ApprovalEvents.ON_PENDING_ACTION) {
      return frame.data;
    }
  }
  return data.resumeState?.pendingAction;
};

/** A pause past its expiry, whose resume the server refuses. */
const isExpired = (action: Agents.PendingAction): boolean =>
  action.expiresAt != null && action.expiresAt <= Date.now();

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

type PauseOrder = Pick<Agents.PendingAction, 'createdAt'>;

/**
 * Orders two pauses of one generation by when the server created them. Action ids are random, so
 * two created in the same millisecond tie, and the one this chat received last stands.
 */
const comparePauses = (a: PauseOrder, b: PauseOrder): number => a.createdAt - b.createdAt;

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

/** A tool call that may hold a subagent's own tool calls, where a paused tool can live. */
type NestedToolCall = Agents.ToolCall & { subagent_content?: TMessageContentParts[] };

/**
 * Writes `decision` onto the tool calls of `actionId` with the given id in `parts`, descending into
 * subagent calls the way the pause was tagged. Returns the new parts, or nothing when none matched.
 */
const markApprovalIn = (
  parts: TMessageContentParts[],
  actionId: string,
  toolCallId: string,
  decision: Agents.ToolApprovalResolution,
): TMessageContentParts[] | undefined => {
  let next: TMessageContentParts[] | undefined;
  parts.forEach((part, index) => {
    if (part?.type !== ContentTypes.TOOL_CALL) {
      return;
    }
    const toolCall = part.tool_call as NestedToolCall | undefined;
    if (!toolCall) {
      return;
    }
    let marked = toolCall;
    const nested = Array.isArray(toolCall.subagent_content)
      ? markApprovalIn(toolCall.subagent_content, actionId, toolCallId, decision)
      : undefined;
    if (nested) {
      marked = { ...marked, subagent_content: nested };
    }
    if (
      'approval' in toolCall &&
      toolCall.id === toolCallId &&
      toolCall.approval?.actionId === actionId
    ) {
      const approval = {
        ...toolCall.approval,
        decision: decision.decision,
        reason: decision.reason,
      };
      if (decision.reason === undefined) {
        /** A changed decision shows only its own reason. */
        delete approval.reason;
      }
      marked = { ...marked, approval };
    }
    if (marked === toolCall) {
      return;
    }
    next ??= [...parts];
    next[index] = { ...part, tool_call: marked } as TMessageContentParts;
  });
  return next;
};

/** Writes `decision` onto every tool call of `actionId` with the given id. */
const markApproval = (
  messages: TMessage[],
  actionId: string,
  toolCallId: string,
  decision: Agents.ToolApprovalResolution,
): TMessage[] | undefined => {
  let changed = false;
  const next = messages.map((message) => {
    const content = message.content
      ? markApprovalIn(message.content, actionId, toolCallId, decision)
      : undefined;
    if (!content) {
      return message;
    }
    changed = true;
    return { ...message, content };
  });
  return changed ? next : undefined;
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
  private held?: Agents.PendingAction;
  /** Fires at the held pause's expiry, so no later frame is needed to retire it. */
  private expiry?: ReturnType<typeof setTimeout>;
  private generationCreatedAt?: number;
  /** The pause whose resume request is in flight, so a second submit cannot send it again. */
  private resuming?: string;
  private disposed = false;
  /** Set while the chat writes the state, whose own report of that write the chat announces itself. */
  private writing = false;
  private revision = 0;
  /** Aborted on dispose, which ends every wait on the server so no caller outlives the chat. */
  private readonly lifetime = new AbortController();
  /** A generation whose stream dropped while the server kept it running. */
  private detached?: DetachedGeneration;
  /** The timestamps of the generations a stop or their own stream ended, whose later pauses are stale. */
  private readonly endedGenerations = new Set<number>();
  /** The generation a restored pause belongs to, which a reattachment to it continues. */
  private restored?: { createdAt: number; generation: Generation };
  private readonly decisions = new Map<string, Agents.ToolApprovalResolution>();
  /** Pauses already resumed, or refused as over, whose replay or later status read is stale. */
  private readonly resumed = new Set<string>();
  /** The newest generation a status read named, expired or not, below which a read is stale. */
  private newestRead?: number;
  /** A pause a snapshot found gone, whose decisions stand if the stream reports it again. */
  private releasedPause?: string;
  /** The newest pause this chat saw within its generation, which an older one of that generation trails. */
  private newestPause?: { generationCreatedAt: number } & PauseOrder;
  /** The newest start handed to the transport, whose conversation a late answer must not replace. */
  private latestStart?: ActiveRequest;
  /**
   * A start that reached the transport and lost its response, with nothing to address it by. It
   * stays the caller's to stop until an answer resolves that start, or one its conversation covers.
   */
  private lostStart?: ActiveRequest;
  /**
   * The conversation this chat runs under: its id, until the server names the one it created for
   * a chat started under `new`. Every later start, stop and reattachment addresses that one.
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

  /** The pause the running generation waits on; holding one arms its retirement at expiry. */
  private get action(): Agents.PendingAction | undefined {
    return this.held;
  }

  private set action(action: Agents.PendingAction | undefined) {
    if (action === this.held) {
      return;
    }
    clearTimeout(this.expiry);
    this.expiry = undefined;
    this.held = action;
    if (action?.expiresAt != null && !this.disposed) {
      this.armExpiry(action);
    }
  }

  /** Retires `action` once its expiry passes, unless an answer to it is in flight and decides. */
  private armExpiry(action: Agents.PendingAction): void {
    const remaining = (action.expiresAt ?? 0) - Date.now();
    this.expiry = setTimeout(
      () => {
        this.expiry = undefined;
        if (this.held !== action || this.disposed) {
          return;
        }
        if (!isExpired(action)) {
          /** A deadline past the longest delay a timer takes is reached in steps. */
          this.armExpiry(action);
          return;
        }
        if (this.resuming !== action.actionId) {
          this.clearAction();
        }
      },
      Math.min(Math.max(remaining, 0), MAX_TIMER_DELAY),
    );
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

  /** The pause the running generation waits on for a tool decision or an answer, if any. */
  get pendingAction(): Agents.PendingAction | undefined {
    return this.action;
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
   * Reattaches to the generation the server is still running. The status stays as it is until a
   * stream is returned, so a chat with nothing running never flashes `submitted`.
   */
  resumeStream(
    options: { streamId?: string; generationCreatedAt?: number } & ChatRequestOptions = {},
  ): Promise<void> {
    return this.reattach(options, false);
  }

  /**
   * Reattaches to a running generation. A `continuation` follows an answered pause, so finding
   * nothing running means the continuation already finished, which the turn reports as settled.
   */
  private async reattach(
    options: {
      streamId?: string;
      generationCreatedAt?: number;
      /** The conversation the generation runs under, when the server named it. */
      conversationId?: string;
      /** The endpoint an answer already resolved, so its continuation does not ask the host again. */
      endpoint?: string;
      /** A pause the server refused to resume, retired once this reattachment owns the chat. */
      retire?: string;
    } & ChatRequestOptions,
    continuation: boolean,
  ): Promise<void> {
    if (this.active || this.disposed) {
      return;
    }
    if (
      options.generationCreatedAt != null &&
      !continuation &&
      this.isStaleRead(options.generationCreatedAt)
    ) {
      /** A status read that named an older generation than this chat holds changes nothing. */
      return;
    }
    /** The host's selection is read before any marker changes, so a throw leaves them all as they were. */
    const { endpoint: resolved, retire, ...reattachOptions } = options;
    const selected = resolved ?? this.resumeEndpoint();
    if (this.active || this.disposed) {
      /** The host's selection may have started a turn or disposed the chat, which then owns it. */
      return;
    }
    /** A turn whose stream dropped: finding nothing running means it ended without this chat. */
    const dropped = this.detached;
    this.detached = undefined;
    /**
     * Reattaching to a dropped turn's own generation continues its record, so the turn's identity
     * and a stop still in flight for it carry over.
     */
    const continued =
      options.generationCreatedAt == null ||
      options.generationCreatedAt === dropped?.target.generationCreatedAt
        ? dropped
        : undefined;
    /** Reattaching to a restored pause's generation continues its record the same way. */
    const paused =
      !continued &&
      this.action &&
      (options.generationCreatedAt == null ||
        options.generationCreatedAt === this.restored?.createdAt)
        ? this.restored
        : undefined;
    this.restored = undefined;
    const active = createActiveRequest(continued?.generation ?? paused?.generation);
    const { generation } = active;
    if (!continued && generation.responseId === undefined) {
      /**
       * A reattachment this chat did not prepare has no response until a frame names one. A
       * continued local turn keeps the list-tail fallback its own request had.
       */
      generation.responseUnknown = true;
    }
    /** A continued generation runs where it started; the host's selection names any other. */
    generation.endpoint = continued?.target.endpoint ?? selected ?? dropped?.target.endpoint;
    generation.conversationId = options.conversationId ?? generation.conversationId;
    this.learnConversation(options.conversationId);
    /** The generation the caller named, or the record continued, so a stream of another is told apart. */
    active.inheritedGeneration =
      options.generationCreatedAt ?? continued?.target.generationCreatedAt ?? paused?.createdAt;
    active.reattach = { streamId: options.streamId ?? continued?.target.streamId };
    active.attached = true;
    this.active = active;
    const superseded =
      this.action &&
      options.generationCreatedAt != null &&
      this.generationCreatedAt != null &&
      options.generationCreatedAt !== this.generationCreatedAt;
    /**
     * Only the generation this continues, or a restored pause, vouches for a timestamp. Stored
     * before clearing a superseded pause notifies, so a stop made then addresses this generation.
     */
    this.generationCreatedAt =
      options.generationCreatedAt ??
      active.inheritedGeneration ??
      (this.action ? this.generationCreatedAt : undefined);
    /** A restored pause names a running generation, so finding nothing means it ended elsewhere. */
    const restored = !superseded && this.action !== undefined;
    const { conversationId = generation.conversationId ?? this.conversationId, ...request } =
      reattachOptions;
    try {
      if (superseded || (retire != null && this.action?.actionId === retire)) {
        /** A restored pause belongs to the generation it was restored with, not this one. */
        this.clearAction();
      }
      this.setConnection('reconnecting');
      if (active.controller.signal.aborted) {
        /** A listener of that notification stopped or disposed the chat; nothing is opened. */
        throw active.controller.signal.reason;
      }
      const stream = await openUntilAborted(
        this.init.transport.reconnectToStream({
          ...request,
          chatId: conversationId,
          resume: true,
          abortSignal: active.controller.signal,
        }),
        active.controller.signal,
        (opened) => opened?.close(),
      );
      /** The server answered for the conversation, so a lost start in it is no longer the caller's. */
      const released = this.releaseLostStart();
      if (!stream && generation.stopAnswered) {
        /** A stop still in flight decides how an empty reconnect ended. */
        await generation.stopAnswered;
      }
      if (!this.owns(active)) {
        return;
      }
      if (!stream && generation.stopped) {
        this.settle(getStopOutcome(generation), active);
        return;
      }
      /**
       * A caller that named the generation, as a status read does, knew it running; an unnamed
       * probe finding nothing only means nothing runs. A generation already seen ending is done.
       */
      const named =
        options.generationCreatedAt != null &&
        !this.endedGenerations.has(options.generationCreatedAt);
      /** A lost start the answer released may have finished on the server, which the host reloads. */
      const ended =
        continuation ||
        restored ||
        named ||
        dropped != null ||
        released ||
        active.reattach.continuation;
      if (!stream && ended) {
        this.action = undefined;
        this.decisions.clear();
        this.releasedPause = undefined;
        this.settle({ kind: 'complete', settled: { conversationId } }, active);
        return;
      }
      if (!stream) {
        /**
         * Nothing is running and nothing said it was. The chat is let go first and the state
         * published as one change, so a subscriber a store tells of it can start the next turn.
         */
        this.release(active);
        this.writing = true;
        try {
          if (this.status === 'submitted' || this.status === 'streaming') {
            this.init.state.status = 'ready';
          }
          this.init.state.connection = 'idle';
        } finally {
          this.writing = false;
        }
        this.notify();
        return;
      }
      await this.consume(stream, active);
    } catch (error) {
      this.settle(this.toOutcome(error, active), active);
    } finally {
      this.release(active);
    }
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
    if (!active && this.detached) {
      return this.orUnaddressed(await this.stopDetached(this.detached));
    }
    if (!active && this.lostStart) {
      /** A restored pause is stopped too, and the lost start is still the caller's. */
      return this.action ? this.orUnaddressed(await this.stopPaused()) : unaddressable;
    }
    if (!active) {
      return this.stopPaused();
    }
    if (!active.stream && !active.reattach) {
      const { detached } = this;
      active.controller.abort();
      await active.finished;
      /**
       * A start already handed to the transport may be running on the server with no frame naming
       * it; a late stream is stopped by `dropLateStart`, but one that never arrives is the caller's.
       */
      const own: ChatStopResult =
        active.sent && !active.resolved ? unaddressable : { status: 'stopped' };
      if (detached && this.detached === detached) {
        /**
         * The cancelled retry never took over the dropped generation, which this stop also ends,
         * even when a turn its completion callback started is preparing meanwhile.
         */
        const result = await this.stopDetached(detached);
        return active.sent ? own : this.orUnaddressed(result);
      }
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
      generationCreatedAt:
        active.stream?.generationCreatedAt ??
        this.generationCreatedAt ??
        active.inheritedGeneration,
      abortKey: streamId == null ? this.abortKey(generation) : undefined,
    };
    if (!this.isAddressable(target)) {
      return unaddressable;
    }
    generation.paused ??= this.action?.actionId;
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
      if (target.generationCreatedAt != null) {
        this.endedGenerations.add(target.generationCreatedAt);
      }
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
        /** The reattachment opened another generation while the merge waited its turn. */
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
       * Still reattaching: nothing will report the end, so the stop ends the request here. An
       * unsaved stop stays attached for the reconcile frame that reports it.
       */
      active.controller.abort();
    }
    await active.finished;
    if (this.disposed) {
      /** A chat disposed while the stop ended its request writes no state. */
      return getStopResult(result, generation.stoppedConversationId);
    }
    if (!this.active && this.detached?.generation === generation) {
      /** The request dropped before the answer arrived, so the answer ends what it left running. */
      this.detached = undefined;
      this.action = undefined;
      this.decisions.clear();
      this.releasedPause = undefined;
      if (this.publishUnframedStop(result, generation)) {
        return getStopResult(result, generation.stoppedConversationId);
      }
    }
    /** The server confirmed the stop, so this generation is over however its stream ended. */
    if (active.disconnected && this.error === active.disconnected) {
      this.clearFailure();
    }
    if (generation.paused && this.action?.actionId === generation.paused) {
      this.clearAction();
    } else {
      this.notify();
    }
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
        /** Like any confirmed stop, so a late status read of its generation is ignored. */
        if (generationCreatedAt != null) {
          this.endedGenerations.add(generationCreatedAt);
        }
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
    this.clearFailure();
    this.notify();
  }

  /**
   * Clears a lost start the server's answer for its conversation covers: one generation runs per
   * conversation, so the answer owns or superseded it. A start sent under `new` created a
   * conversation of its own, which no other answer covers, so it stays the caller's to stop.
   * Returns whether it released one.
   */
  private releaseLostStart(): boolean {
    if (!this.lostStart || this.lostStart.sentUnder === Constants.NEW_CONVO) {
      return false;
    }
    this.lostStart = undefined;
    return true;
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

  /** Stops a generation whose stream dropped, which the server keeps running. */
  private async stopDetached(detached: DetachedGeneration): Promise<ChatStopResult> {
    if (!this.isAddressable(detached.target)) {
      return unaddressable;
    }
    const { generation } = detached;
    const result = await this.stopGeneration(generation, detached.target);
    const active = this.active;
    if (!this.disposed && active?.generation === generation) {
      /** A reattachment took the generation over while the stop was in flight; it ends with it. */
      return this.endStopped(active, generation, result);
    }
    /**
     * The dropped generation owns the chat only while no newer request does, such as a retry. A
     * reattachment to it that failed drops it again under a new record of the same generation.
     */
    const owns = () => !this.disposed && this.detached?.generation === generation && !this.active;
    if (!owns()) {
      return getStopResult(result, generation.stoppedConversationId);
    }
    if (result && 'runMessages' in result) {
      await this.mergeRunMessages(result.runMessages, owns);
      if (!owns()) {
        /** A newer generation took over while the merge waited its turn. */
        return getStopResult(result, generation.stoppedConversationId);
      }
    }
    const failed = this.detached?.error ?? detached.error;
    this.detached = undefined;
    this.action = undefined;
    this.decisions.clear();
    this.releasedPause = undefined;
    if (this.publishUnframedStop(result, generation)) {
      return getStopResult(result, generation.stoppedConversationId);
    }
    if (this.error === failed) {
      this.clearFailure();
    }
    this.notify();
    return getStopResult(result, generation.stoppedConversationId);
  }

  /**
   * Reports a stop whose end no attached stream will frame: one the run had already settled, one
   * the server could not save, or one it stopped and saved, whose abort frame no stream is left to
   * carry. The host reloads what the server kept. Returns whether it did.
   */
  private publishUnframedStop(result: ChatAbortResult, generation: Generation): boolean {
    const settledAs = getSettledAs(result);
    const persistenceFailed = isStreamAbort(result) && result.persistenceFailed;
    const stopFramed = isStreamAbort(result) && !settledAs && !persistenceFailed;
    if (!settledAs && !persistenceFailed && !stopFramed) {
      return false;
    }
    const outcome = getStopOutcome({
      settledAs,
      persistenceFailed,
      stopFramed,
      stoppedConversationId: generation.stoppedConversationId,
    });
    /** An answer that names no stream leaves the conversation the generation's frames named. */
    const { conversationId } = generation;
    const named = conversationId !== Constants.NEW_CONVO ? conversationId : undefined;
    /** A lost start still owed its own abort keeps the failure it reported. */
    const owed = this.lostStart && this.error ? this.error : undefined;
    this.publish(
      { ...outcome, conversationId: named },
      generation.responseId,
      generation.responseUnknown,
      false,
      owed,
    );
    return true;
  }

  /** Stops a pause restored without a stream on the server, which frees the chat for a turn. */
  private async stopPaused(): Promise<ChatStopResult> {
    const action = this.action;
    if (!action) {
      return { status: 'idle' };
    }
    const endpoint = this.resumeEndpoint();
    if (!endpoint) {
      throw new Error('The paused generation cannot be stopped without its endpoint');
    }
    const stoppedAt = this.generationCreatedAt;
    /** A pause no status read restored names no response this chat prepared or saw framed. */
    const generation: Generation = this.restored?.generation ?? { responseUnknown: true };
    const result = await this.stopGeneration(generation, {
      endpoint,
      streamId: action.streamId,
      generationCreatedAt: stoppedAt,
    });
    const active = this.active;
    if (!this.disposed && active?.generation === generation) {
      /** A reattachment took the generation over while the stop was in flight; it ends with it. */
      return this.endStopped(active, generation, result);
    }
    /** Whatever pause the stopped generation holds now ends with it, however often it was refreshed. */
    const owned =
      this.action &&
      (this.action.actionId === action.actionId || this.generationCreatedAt === stoppedAt);
    if (this.disposed || !owned) {
      return getStopResult(result, generation.stoppedConversationId);
    }
    this.action = undefined;
    this.decisions.clear();
    this.releasedPause = undefined;
    /** A pause a status read restored names no response this chat prepared or saw framed. */
    const unframed = {
      conversationId: generation.conversationId,
      stoppedConversationId: generation.stoppedConversationId,
      responseId: generation.responseId,
      responseUnknown: generation.responseId === undefined,
    };
    if (this.publishUnframedStop(result, unframed)) {
      return getStopResult(result, generation.stoppedConversationId);
    }
    if (this.status === 'error' && !this.lostStart) {
      /**
       * The stop confirmed the end a dropped connection left unknown. A lost start still owed its
       * own abort keeps the failure it reported.
       */
      this.clearFailure();
    }
    this.notify();
    return getStopResult(result, generation.stoppedConversationId);
  }

  /** The conversation the paused generation's record names, which a frame may have assigned. */
  private pausedConversationId(): string | undefined {
    const generation =
      this.active?.generation ?? this.detached?.generation ?? this.restored?.generation;
    return generation?.conversationId;
  }

  /** The endpoint a generation this chat did not start runs on, as the host selects it. */
  private resumeEndpoint(): string | undefined {
    return this.init.resumeSelection?.().endpoint ?? undefined;
  }

  /**
   * Returns a failed chat to `ready` as one write, which the caller announces, so a store that
   * reports each field never shows a failed status without its error.
   */
  private clearFailure(): void {
    this.writing = true;
    try {
      this.init.state.error = undefined;
      this.init.state.status = 'ready';
    } finally {
      this.writing = false;
    }
  }

  /** Whether `action` is the held pause, or the one a snapshot released while nothing replaced it. */
  private holdsPause(action: Agents.PendingAction): boolean {
    if (this.action) {
      return this.action.actionId === action.actionId;
    }
    return this.releasedPause === action.actionId;
  }

  private assertNotResuming(action: Agents.PendingAction): void {
    if (this.disposed) {
      throw new Error('The chat was disposed');
    }
    if (this.resuming === action.actionId) {
      throw new Error('This pause is already being resumed');
    }
  }

  private clearAction(): void {
    this.action = undefined;
    this.releasedPause = undefined;
    this.decisions.clear();
    this.notify();
  }

  /** Returns a failed chat to `ready`. AI SDK: `clearError`. */
  clearError(): void {
    if (this.status !== 'error') {
      return;
    }
    this.init.state.error = undefined;
    this.setStatus('ready');
  }

  /**
   * Restores a pause the server reported outside a stream, such as the status check of a reload,
   * so its tool decisions and answers can be submitted. Refused while a request is in flight; an
   * expired pause is not restored.
   */
  restorePendingAction(action: Agents.PendingAction, generationCreatedAt: number): void {
    if (this.disposed) {
      return;
    }
    if (this.active) {
      throw new Error('A request is in flight; its stream reports the pause');
    }
    if (this.resumed.has(action.actionId) && generationCreatedAt === this.generationCreatedAt) {
      /** A status read before the answer landed reports a pause this chat already resumed. */
      return;
    }
    if (this.isStaleRead(generationCreatedAt) || this.isOlderPause(action, generationCreatedAt)) {
      return;
    }
    this.newestRead = generationCreatedAt;
    this.seePause(action, generationCreatedAt);
    const dropped = this.detached?.target.generationCreatedAt;
    if (this.detached && (dropped == null || generationCreatedAt > dropped)) {
      /**
       * The pause belongs to a newer generation, or one the dropped stream never dated, which
       * superseded the one whose stream dropped.
       */
      this.detached = undefined;
    }
    /**
     * A lost start is left as it is: no read can tell whether it names that start's generation or
     * an older one, so only an answer about the start itself clears it.
     */
    this.learnConversation(action.conversationId);
    if (isExpired(action)) {
      /**
       * An expired pause is stale: the server will refuse its resume. It also supersedes a pause
       * restored for an older generation, which no longer runs.
       */
      const superseded =
        this.action != null &&
        (generationCreatedAt !== this.generationCreatedAt ||
          this.isSupersededBy(this.action, action));
      if (this.action?.actionId === action.actionId || superseded) {
        this.clearAction();
      }
      return;
    }
    if (this.action?.actionId !== action.actionId && this.releasedPause !== action.actionId) {
      /** A pause a snapshot released keeps its decisions when a read restores it, as a frame does. */
      this.decisions.clear();
    }
    this.releasedPause = undefined;
    this.action = action;
    this.generationCreatedAt = generationCreatedAt;
    if (this.restored?.createdAt !== generationCreatedAt) {
      /** The generation whose stream dropped keeps one record, which this read adds to. */
      const dropped =
        this.detached?.target.generationCreatedAt === generationCreatedAt
          ? this.detached.generation
          : undefined;
      this.restored = { createdAt: generationCreatedAt, generation: dropped ?? {} };
    }
    /** The record carries what the status read says of the generation, for a stop or reattachment. */
    const { generation } = this.restored;
    generation.paused = action.actionId;
    generation.conversationId = action.conversationId ?? generation.conversationId;
    if (action.responseMessageId) {
      generation.responseId = action.responseMessageId;
      generation.responseUnknown = false;
    } else if (generation.responseId === undefined) {
      generation.responseUnknown = true;
    }
    this.notify();
  }

  /**
   * Records a decision for one paused tool call and shows it on the call. Once every call of the
   * pause has one, the batch resumes the generation, which continues on the attached stream.
   * AI SDK: `addToolApprovalResponse`.
   */
  async addToolApprovalResponse(response: ToolApprovalResponse): Promise<void> {
    const action = this.action;
    if (action?.payload.type !== 'tool_approval') {
      throw new Error('No tool approval is pending');
    }
    const ids = action.payload.action_requests.map((request) => request.tool_call_id);
    if (!ids.includes(response.id)) {
      throw new Error(`Tool call ${response.id} is not awaiting approval`);
    }
    this.assertNotResuming(action);
    const {
      id,
      approved,
      decision: chosen,
      reason,
      editedArguments,
      responseText,
      scope,
    } = response;
    const decision: Agents.ToolApprovalResolution = {
      tool_call_id: id,
      decision: chosen ?? (approved ? 'approve' : 'reject'),
      ...(reason !== undefined && { reason }),
      ...(editedArguments !== undefined && { editedArguments }),
      ...(responseText !== undefined && { responseText }),
      ...(scope !== undefined && { scope }),
    };
    this.decisions.set(response.id, decision);
    await this.executor.run(() => {
      const next = markApproval(this.messages, action.actionId, response.id, decision);
      if (next) {
        this.write(next);
      }
    });
    if (ids.some((id) => !this.decisions.has(id))) {
      return;
    }
    const decisions = ids.map((id) => this.decisions.get(id) as Agents.ToolApprovalResolution);
    await this.resume(action, { decisions });
  }

  /**
   * Answers an `ask_user_question` pause, which resumes the generation. AI SDK: `addToolOutput`.
   * `toolCallId` is the asking tool call, or the pause's action id when the server named no call.
   */
  async addToolOutput({ toolCallId, output }: ToolOutput): Promise<void> {
    const action = this.action;
    if (action?.payload.type !== 'ask_user_question') {
      throw new Error('No question is pending');
    }
    const expected = action.payload.tool_call_id ?? action.actionId;
    if (toolCallId !== expected) {
      throw new Error(`Tool call ${toolCallId} is not awaiting an answer`);
    }
    this.assertNotResuming(action);
    await this.resume(
      action,
      typeof output === 'string' ? { answer: output } : { answers: output },
    );
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
    clearTimeout(this.expiry);
    this.expiry = undefined;
    this.lifetime.abort(new Error('The chat was disposed'));
    const active = this.active;
    this.active = undefined;
    active?.controller.abort();
    active?.stream?.close();
    const { state } = this.init;
    const unsent = active != null && !active.sent && !active.reattach;
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
    if (this.action && isExpired(this.action) && this.resuming !== this.action.actionId) {
      /** An expired pause whose answer failed blocks nothing: the server refuses its resume. */
      this.clearAction();
      /** A subscriber told the pause is gone may have disposed the chat or started its own turn. */
      if (this.disposed) {
        throw new Error('The chat was disposed');
      }
      if (this.active) {
        throw new Error('A turn is already in flight for this chat');
      }
    }
    if (this.action) {
      throw new Error('A paused generation is waiting for a decision; answer or stop it first');
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
      /**
       * The server took the start, so it owns or superseded a generation whose stream dropped.
       * Until then that generation stays the stop target, in case the start fails.
       */
      const dropped = this.detached;
      this.detached = undefined;
      /** Likewise a lost start stays the caller's to stop until the server takes one in its conversation. */
      this.releaseLostStart();
      let answered: number | undefined;
      if (result.status === 'stream') {
        answered = result.stream.generationCreatedAt;
      } else if (result.status === 'replaced') {
        answered = result.generationCreatedAt ?? undefined;
      }
      if (answered == null || answered !== dropped?.target.generationCreatedAt) {
        /**
         * A start the server attached to the dropped generation continues it, answered pauses
         * included; any other supersedes it, and the old generation's resumed pauses with it. A
         * superseded one stays in the stale-read history so a late read of it changes nothing.
         */
        for (const superseded of [this.generationCreatedAt, dropped?.target.generationCreatedAt]) {
          if (superseded != null) {
            this.endedGenerations.add(superseded);
          }
        }
        this.generationCreatedAt = undefined;
        this.resumed.clear();
      }
      let stream: ChatStream | null = null;
      if (result.status === 'stream') {
        stream = result.stream;
        /** A start the server attached to a generation already running is an attachment too. */
        active.attached = result.stream.resumed === true;
        const { generationCreatedAt } = stream;
        if (
          generationCreatedAt != null &&
          generationCreatedAt === dropped?.target.generationCreatedAt
        ) {
          /**
           * The server attached the start to the dropped generation, whose record it continues. The
           * stream is installed before the rollback notifies, so a stop made then addresses it.
           */
          active.generation = dropped.generation;
          active.inheritedGeneration = generationCreatedAt;
          active.stream = stream;
          const rollback = active.optimistic;
          if (rollback) {
            /** That generation is not this turn, so this turn's optimistic write is undone. */
            await this.executor.run(() => {
              this.write(undoOptimisticWrite(rollback, this.messages));
            });
          }
        }
      } else if (result.status === 'replaced') {
        const generationCreatedAt = result.generationCreatedAt ?? undefined;
        /** The target is recorded before anyone hears of the reconnect, so a stop can reach it. */
        this.generationCreatedAt = generationCreatedAt;
        /**
         * The replacement it names, so a stream of yet another generation gets its own record.
         * Recorded before the rollback notifies, so a stop made then addresses the replacement.
         */
        active.inheritedGeneration = generationCreatedAt;
        active.reattach = { streamId: result.streamId };
        active.attached = true;
        if (
          generationCreatedAt != null &&
          generationCreatedAt === dropped?.target.generationCreatedAt
        ) {
          /** The dropped generation itself: its record carries the stop still in flight for it. */
          active.generation = dropped.generation;
        } else {
          /** The replacement's response is not this turn's placeholder; its first frame names it. */
          active.generation.responseId = undefined;
          active.generation.responseUnknown = true;
        }
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
    this.detached = undefined;
    if (
      active.inheritedGeneration != null &&
      stream.generationCreatedAt != null &&
      stream.generationCreatedAt !== active.inheritedGeneration
    ) {
      /**
       * The reattachment found another generation, whose response no frame has named yet. It gets
       * its own record, so a stop of the one it continued does not end it.
       */
      const { endpoint, conversationId } = active.generation;
      active.generation = { endpoint, conversationId, responseUnknown: true };
    }
    if (stream.generationCreatedAt != null) {
      const previous = this.generationCreatedAt;
      this.generationCreatedAt = stream.generationCreatedAt;
      if (this.action && previous != null && previous !== stream.generationCreatedAt) {
        /** A restored pause belongs to the generation it was restored with, not this one. */
        this.clearAction();
      }
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
            this.track(active, event);
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
    /** A pause that expired or that this chat already resumed is stale, so no card is drawn for it. */
    /** A replay of a pause older than one already seen in this generation is stale too. */
    const older =
      event.type === 'pending_action' &&
      this.generationCreatedAt != null &&
      this.isOlderPause(event.data, this.generationCreatedAt);
    const stale = event.type === 'pending_action' && this.isStalePause(event.data);
    const folded = stale ? undefined : this.withoutStalePause(event);
    const disconnect =
      event.type === 'error' &&
      (event.status === 0 || (active.attached === true && isAttachFailure(event)));
    /**
     * The pause is reconciled before the host reducer folds the event in, so a subscriber its
     * writes notify never answers a pause the same event ended or replaced.
     */
    this.reconcilePause(event, older, disconnect);
    if (folded && !this.disposed) {
      const applyEvent = this.init.applyEvent ?? defaultApplyEvent;
      applyEvent(folded, {
        messages: this.messages,
        write: (messages) => this.write(messages),
      });
    }
    /** A listener told of that write may have disposed the chat, which then owns no more state. */
    if (this.disposed) {
      return undefined;
    }
    let outcome: Outcome | undefined;
    if (streamingEvents.has(event.type)) {
      if (this.markStreaming()) {
        this.notify();
      }
      /** A listener told of that status may have disposed the chat too. */
      if (this.disposed) {
        return undefined;
      }
    } else if (event.type === 'pending_action' && !stale) {
      /** A live pause is the generation running, however its first frame arrives. */
      this.markStreaming();
      this.notify();
      /** A listener told of that status may have disposed the chat too. */
      if (this.disposed) {
        return undefined;
      }
    } else if (event.type === 'final') {
      outcome = getFinalOutcome(event.data);
    } else if (event.type === 'abort') {
      outcome = { kind: 'abort' };
    } else if (event.type === 'error') {
      const message = getErrorMessage(event.data) ?? 'The response failed';
      outcome = { kind: 'error', error: new Error(message), disconnect };
    }
    this.callHost(this.init.onEvent, event);
    return outcome;
  }

  /** What one event changes in the pause the chat holds and the decisions made for it. */
  private reconcilePause(event: ChatEvent, older: boolean, disconnect: boolean): void {
    if (event.type === 'sync' && (event.data.resumeState || event.data.pendingEvents)) {
      this.reconcileSnapshotPause(getSnapshotPause(event.data));
    } else if (event.type === 'pending_action' && isExpired(event.data)) {
      this.retireExpiredPause(event.data);
    } else if (
      event.type === 'pending_action' &&
      !this.resumed.has(event.data.actionId) &&
      !older
    ) {
      /** A pause this chat already resumed is stale when a reattached stream replays it. */
      if (
        this.action?.actionId !== event.data.actionId &&
        this.releasedPause !== event.data.actionId
      ) {
        /** A reconnect replays the same pause; decisions already made for it still stand. */
        this.decisions.clear();
      }
      this.releasedPause = undefined;
      this.seePause(event.data, this.generationCreatedAt);
      this.action = event.data;
    } else if (event.type === 'final') {
      this.action = undefined;
    } else if (event.type === 'abort' || (event.type === 'error' && !disconnect)) {
      /** A dropped connection leaves the server's generation, and its pause, as it was. */
      this.action = undefined;
      this.decisions.clear();
      this.releasedPause = undefined;
    }
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
      const streamId = active.stream?.streamId ?? active.reattach?.streamId;
      if (
        (active.stream || active.reattach) &&
        active.generation.endpoint &&
        !active.generation.stopped
      ) {
        /** The server keeps the generation running, so a later stop still reaches it. */
        this.detached = {
          error: outcome.error,
          target: {
            endpoint: active.generation.endpoint,
            streamId,
            generationCreatedAt:
              active.stream?.generationCreatedAt ??
              this.generationCreatedAt ??
              active.inheritedGeneration,
            abortKey: streamId == null ? this.abortKey(active.generation) : undefined,
          },
          generation: active.generation,
        };
      } else if (active.sent && !active.stream && !active.reattach && !active.resolved) {
        /** The start may have reached the server, which answered nothing this chat can address. */
        this.lostStart = active;
      }
    }
    /**
     * Released and published as one change before anyone is told, so a subscriber or callback
     * that starts the next turn is not overwritten by this one's terminal state.
     */
    this.active = undefined;
    if (outcome.kind !== 'error' || !outcome.disconnect) {
      /**
       * An ended generation ends its pause too, before the host hears of it, so a completion
       * callback can start the next turn; only a dropped connection leaves it running.
       */
      this.action = undefined;
      this.decisions.clear();
      this.releasedPause = undefined;
      /** Including an attachment that found its generation already finished. */
      const ended =
        active.stream?.generationCreatedAt ??
        active.inheritedGeneration ??
        (active.reattach ? this.generationCreatedAt : undefined);
      if ((active.stream || active.reattach) && ended != null) {
        this.endedGenerations.add(ended);
      }
    }
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

  /** Records the ids and pause an event reports for the request it arrived on. */
  private track(active: ActiveRequest, event: ChatEvent): void {
    const identity = getFrameIdentity(event);
    if (event.type === 'pending_action' && this.isStalePause(event.data)) {
      /** A stale pause names neither the held pause nor the response its generation reports. */
      this.adopt(active.generation, { ...identity, responseMessageId: undefined });
      return;
    }
    const snapshot = event.type === 'sync' ? getSnapshotPause(event.data) : undefined;
    if (event.type === 'pending_action') {
      active.generation.paused = event.data.actionId;
    } else if (snapshot && !this.isStalePause(snapshot)) {
      active.generation.paused = snapshot.actionId;
    }
    this.adopt(active.generation, identity);
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

  /**
   * Whether a status read names a generation this chat already knows is over or superseded: one
   * that ended, or one older than any generation the chat has seen, including one that since ended.
   * Every consumer of a status read checks this before changing anything.
   */
  private isStaleRead(generationCreatedAt: number): boolean {
    if (this.endedGenerations.has(generationCreatedAt)) {
      return true;
    }
    /** Every generation this chat saw, running or over, so an older read stays stale after it ends. */
    const seen = [
      ...this.endedGenerations,
      this.detached?.target.generationCreatedAt,
      this.generationCreatedAt,
      this.newestRead,
    ];
    return seen.some((known) => known != null && generationCreatedAt < known);
  }

  /**
   * Reconciles the pause with a sync snapshot, which carries the live one or none. The server sends
   * a live pause either here or as a `pending_action` frame right after, so a snapshot without one
   * releases the held pause, keeping its decisions in case that frame reports it again.
   */
  private reconcileSnapshotPause(snapshot: Agents.PendingAction | undefined): void {
    const generation = this.generationCreatedAt;
    if (!snapshot) {
      if (this.action) {
        this.releasedPause = this.action.actionId;
        this.action = undefined;
        this.notify();
      }
      return;
    }
    if (isExpired(snapshot)) {
      this.retireExpiredPause(snapshot);
      return;
    }
    const stale =
      this.resumed.has(snapshot.actionId) ||
      (generation != null && this.isOlderPause(snapshot, generation));
    if (stale) {
      if (this.action?.actionId === snapshot.actionId) {
        this.clearAction();
      }
      return;
    }
    if (this.action?.actionId !== snapshot.actionId && this.releasedPause !== snapshot.actionId) {
      this.decisions.clear();
    }
    this.releasedPause = undefined;
    this.seePause(snapshot, generation);
    this.action = snapshot;
    this.notify();
  }

  /**
   * An expired pause a reconnect replays or a snapshot carries is stale, as one a status read
   * restores is, and it still supersedes an older pause of its generation that the chat holds.
   */
  private retireExpiredPause(expired: Agents.PendingAction): void {
    const generation = this.generationCreatedAt;
    this.seePause(expired, generation);
    const held = this.action;
    const superseded = held != null && generation != null && this.isSupersededBy(held, expired);
    if (held?.actionId === expired.actionId || superseded) {
      this.clearAction();
    }
  }

  /**
   * The event the host reducer folds in: a sync frame drops a pause that is stale (expired,
   * already resumed, or older than one seen), from its snapshot and from the frames it buffers, as a
   * standalone `pending_action` frame of it would be skipped, so no card is drawn for a pause the
   * chat does not hold.
   */
  private withoutStalePause(event: ChatEvent): ChatEvent {
    if (event.type !== 'sync') {
      return event;
    }
    const { resumeState, pendingEvents } = event.data;
    /** Only the pause the frame stands for, and only while it is live, reaches the reducer. */
    const effective = getSnapshotPause(event.data);
    const shown = effective != null && !this.isStalePause(effective) ? effective : undefined;
    const snapshot = resumeState?.pendingAction;
    const staleSnapshot = snapshot != null && snapshot !== shown;
    const live = pendingEvents?.filter(
      (frame) =>
        !('event' in frame) ||
        frame.event !== ApprovalEvents.ON_PENDING_ACTION ||
        frame.data === shown,
    );
    const staleBuffered = live != null && live.length !== pendingEvents?.length;
    if (!staleSnapshot && !staleBuffered) {
      return event;
    }
    const data = {
      ...event.data,
      ...(staleSnapshot && { resumeState: { ...resumeState, pendingAction: undefined } }),
      ...(staleBuffered && { pendingEvents: live }),
    };
    return { ...event, data } as ChatEvent;
  }

  /** Whether `action` expired, was already resumed, or trails a pause seen in its generation. */
  private isStalePause(action: Agents.PendingAction): boolean {
    const generation = this.generationCreatedAt;
    return (
      isExpired(action) ||
      this.resumed.has(action.actionId) ||
      (generation != null && this.isOlderPause(action, generation))
    );
  }

  /**
   * Whether `next`, a pause of the held one's generation, replaces `held`: it was created later, or
   * in the same millisecond, where the pause received last stands.
   */
  private isSupersededBy(held: Agents.PendingAction, next: Agents.PendingAction): boolean {
    return held.actionId !== next.actionId && comparePauses(held, next) <= 0;
  }

  /** Whether `action` came before a pause this chat already saw in the same generation. */
  private isOlderPause(action: Agents.PendingAction, generationCreatedAt: number): boolean {
    const newest = this.newestPause;
    return (
      newest != null &&
      newest.generationCreatedAt === generationCreatedAt &&
      comparePauses(action, newest) < 0
    );
  }

  /** Records a pause of `generationCreatedAt` as the newest seen when no later one was. */
  private seePause(action: Agents.PendingAction, generationCreatedAt: number | undefined): void {
    if (generationCreatedAt == null || this.isOlderPause(action, generationCreatedAt)) {
      return;
    }
    this.newestPause = { generationCreatedAt, createdAt: action.createdAt };
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

  /** Whether `active` still holds this chat, which an async continuation checks before acting. */
  private owns(active: ActiveRequest): boolean {
    return !this.disposed && this.active === active;
  }

  private release(active: ActiveRequest): void {
    if (this.active === active) {
      this.active = undefined;
    }
    active.finish();
  }

  private async resume(
    action: Agents.PendingAction,
    resolution:
      | { decisions: Agents.ToolApprovalResolution[] }
      | { answer?: string; answers?: Record<string, string> },
  ): Promise<void> {
    const { resume } = this.init.transport;
    if (!resume) {
      throw new Error('The transport cannot resume a paused generation');
    }
    /** Unknown on a stream that names no generation; the server then fences by the action alone. */
    const generationCreatedAt = this.generationCreatedAt;
    if (this.disposed) {
      throw new Error('The chat was disposed');
    }
    if (this.action?.actionId !== action.actionId) {
      throw new Error('The pause ended before it was resumed');
    }
    if (this.resuming === action.actionId) {
      return;
    }
    this.resuming = action.actionId;
    /** Read once: the answer and the reattachment that follows it run on the same selection. */
    let selection: ReturnType<NonNullable<ChatInit['resumeSelection']>> | undefined;
    try {
      selection = this.init.resumeSelection?.();
      if (this.disposed) {
        /** The host's selection disposed the chat, which then sends no answer for it. */
        throw new Error('The chat was disposed');
      }
      /** Disposal releases the submit; a late answer then finds nothing to change. */
      const result = await untilAborted(
        resume.call(this.init.transport, {
          ...selection,
          ...resolution,
          conversationId:
            action.conversationId ?? this.pausedConversationId() ?? this.conversationId,
          ...(generationCreatedAt != null && { generationCreatedAt }),
          actionId: action.actionId,
        }),
        this.lifetime.signal,
      );
      this.resumed.add(action.actionId);
      /** The answer names the conversation, which a chat started under `new` adopts either way. */
      this.learnConversation(result.conversationId);
      /**
       * A pause stopped or replaced while the request was in flight is no longer this one's. One a
       * snapshot only released still is: the server took its answer, so its continuation runs.
       */
      if (!this.holdsPause(action)) {
        return;
      }
      const reattach = this.active && !this.active.stream ? this.active.reattach : undefined;
      if (reattach && this.generationCreatedAt === generationCreatedAt) {
        /** A reconnect already opening attaches to the continuation, or finds it finished. */
        reattach.continuation = true;
      } else if (!this.active && !this.disposed) {
        /** A pause restored after a reload has no stream attached for the continuation. */
        this.reattach(
          {
            streamId: result.streamId,
            generationCreatedAt,
            conversationId: result.conversationId,
            endpoint: selection?.endpoint ?? undefined,
          },
          true,
        ).catch((error: unknown) =>
          this.callHost(
            this.init.onError,
            error instanceof Error ? error : new Error(String(error)),
          ),
        );
      }
      this.clearAction();
    } catch (error) {
      const failure = error as ChatTransportError;
      if (isPauseOver(failure)) {
        /** Over for good: a later status read, replay or snapshot of it is stale, as an answered one is. */
        this.resumed.add(action.actionId);
        /**
         * The server answered that this pause can no longer be resumed: another client answered
         * it or a newer generation replaced it. It ends here, and a probe finds what runs now.
         */
        /** A newer pause restored meanwhile owns the chat, and the probe would end it. */
        const ours = this.action?.actionId === action.actionId;
        const probing = (ours || !this.action) && !this.active && !this.disposed;
        if (!probing && ours) {
          this.clearAction();
        }
        if (probing) {
          /**
           * Started while the pause still names its generation, so a subscriber cannot take the
           * chat first; the reattachment retires the refused pause once it owns the chat, and then
           * settles or replaces it by what it finds.
           */
          this.reattach(
            {
              streamId: action.streamId,
              endpoint: selection?.endpoint ?? undefined,
              conversationId: action.conversationId ?? this.pausedConversationId(),
              retire: action.actionId,
            },
            false,
          ).catch((probe: unknown) =>
            this.callHost(
              this.init.onError,
              probe instanceof Error ? probe : new Error(String(probe)),
            ),
          );
        }
        throw error;
      }
      const ambiguous = isRetryableNetworkError(failure);
      if (ambiguous && !this.active && !this.disposed && this.holdsPause(action)) {
        /**
         * The answer may have reached the server, which then runs the generation again. It stays
         * addressable through a reattachment, which finds the continuation, the pause or the end.
         */
        this.reattach(
          {
            streamId: action.streamId,
            endpoint: selection?.endpoint ?? undefined,
            generationCreatedAt,
            conversationId: action.conversationId ?? this.pausedConversationId(),
          },
          true,
        ).catch((failure: unknown) =>
          this.callHost(
            this.init.onError,
            failure instanceof Error ? failure : new Error(String(failure)),
          ),
        );
      }
      throw error;
    } finally {
      if (this.resuming === action.actionId) {
        this.resuming = undefined;
        const held = this.action;
        if (held?.actionId === action.actionId && isExpired(held)) {
          /**
           * Its expiry passed while the answer was in flight, which then left it unresolved. A
           * status read may have restored a copy of it meanwhile, so the held copy is the one read.
           */
          this.clearAction();
        }
      }
    }
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
