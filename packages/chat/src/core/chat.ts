import { ContentTypes } from 'librechat-data-provider';
import type {
  Agents,
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
  ChatAbortResult,
  ChatAbortRequest,
  ChatStreamAbortResult,
  ChatResumeSelection,
  ChatTransportError,
} from './types';
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
  /** The conversation the server settled the turn under, when it said. */
  conversationId?: string;
  /**
   * Why a settled turn's final frame carried no messages. `abort_persistence_failed` means the
   * stop was not saved, so work queued behind it must not run.
   */
  reconcileReason?: ChatFinalFrame['reconcileReason'];
};

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

type Outcome = { settled?: Settled } & (
  | { kind: 'complete' }
  | { kind: 'abort' }
  | { kind: 'error'; error: Error; disconnect: boolean }
);

type DetachedGeneration = {
  error: Error;
  target: Omit<ChatAbortRequest, 'chatId'>;
};

type ActiveRequest = {
  controller: AbortController;
  stream?: ChatStream;
  endpoint?: string;
  /** Set when reattaching to a generation already running on the server, before it attaches. */
  reattach?: { streamId?: string };
  /** The pause this request's generation reported, which a confirmed stop ends. */
  paused?: string;
  /** Set once the server confirmed a stop, so a stream that drops instead of ending aborts. */
  stopped?: boolean;
  /** The terminal status a stop answer reported for a run that had already ended on its own. */
  settledAs?: ChatStreamAbortResult['terminalStatus'];
  /** Resolves once a stop sent for this request was answered, either way. */
  stopAnswered?: Promise<void>;
  /** The error the request settled with when its connection dropped. */
  disconnected?: Error;
  /** The conversation the request's payload names, which an Assistants stop addresses. */
  conversationId?: string;
  /** The response this request produces: its placeholder, then the one its final frame names. */
  responseId?: string;
  /** Resolves once the request settled and released the chat. */
  finished: Promise<void>;
  finish: () => void;
};

const createActiveRequest = (): ActiveRequest => {
  let finish = () => {};
  const finished = new Promise<void>((resolve) => {
    finish = resolve;
  });
  return { controller: new AbortController(), finished, finish };
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

/** A run that ended on its own before a stop reached it, whose final frame never arrived. */
const getSettledOutcome = (status: ChatStreamAbortResult['terminalStatus']): Outcome => {
  if (status === 'error') {
    return {
      kind: 'error',
      error: new Error('The response failed'),
      disconnect: false,
      settled: {},
    };
  }
  return status === 'aborted' ? { kind: 'abort', settled: {} } : { kind: 'complete', settled: {} };
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

/** Merges the messages a `final` event carries onto the stored ones, by id. */
/** Merges `finals` onto `messages` by id, appending the ones the list does not hold. */
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
    if (index === -1) {
      next.push(final as TMessage);
    } else {
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

/** Writes `decision` onto every tool call of `actionId` with the given id. */
const markApproval = (
  messages: TMessage[],
  actionId: string,
  toolCallId: string,
  decision: Agents.ToolApprovalResolution,
): TMessage[] | undefined => {
  let changed = false;
  const next = messages.map((message) => {
    let content: TMessage['content'];
    message.content?.forEach((part, index) => {
      if (part?.type !== ContentTypes.TOOL_CALL) {
        return;
      }
      const toolCall = part.tool_call as Agents.ToolCall | undefined;
      if (
        !toolCall ||
        !('approval' in toolCall) ||
        toolCall.id !== toolCallId ||
        toolCall.approval?.actionId !== actionId
      ) {
        return;
      }
      content ??= [...(message.content ?? [])];
      const approval = {
        ...toolCall.approval,
        decision: decision.decision,
        reason: decision.reason,
      };
      if (decision.reason === undefined) {
        /** A changed decision shows only its own reason. */
        delete approval.reason;
      }
      content[index] = {
        ...part,
        tool_call: { ...toolCall, approval },
      } as (typeof content)[number];
    });
    if (!content) {
      return message;
    }
    changed = true;
    return { ...message, content };
  });
  return changed ? next : undefined;
};

/**
 * One conversation's turn lifecycle, framework free. AI SDK: `AbstractChat`.
 *
 * A turn is `submitted` while the request is in flight, `streaming` from its first content event,
 * then `ready` on completion or abort and `error` on failure, until `clearError`. Every write to
 * the message list (stream events, tool decisions, the optimistic turn) runs through one
 * {@link SerialJobExecutor}, so they apply in the order they were made.
 */
export class Chat {
  readonly id: string;
  private readonly init: ChatInit;
  private readonly executor = new SerialJobExecutor();
  private readonly listeners = new Set<() => void>();
  private releaseState?: () => void;
  private active?: ActiveRequest;
  private action?: Agents.PendingAction;
  private generationCreatedAt?: number;
  /** The pause whose resume request is in flight, so a second submit cannot send it again. */
  private resuming?: string;
  private disposed = false;
  /** A generation whose stream dropped while the server kept it running. */
  private detached?: DetachedGeneration;
  private readonly decisions = new Map<string, Agents.ToolApprovalResolution>();
  /** Pauses already resumed, whose replay by a reattached stream is stale. */
  private readonly resumed = new Set<string>();

  constructor(init: ChatInit) {
    this.id = init.id;
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
    options: { streamId?: string; generationCreatedAt?: number } & ChatRequestOptions,
    continuation: boolean,
  ): Promise<void> {
    if (this.active || this.disposed) {
      return;
    }
    this.detached = undefined;
    const active = createActiveRequest();
    active.endpoint = this.resumeEndpoint();
    active.reattach = { streamId: options.streamId };
    this.active = active;
    if (
      this.action &&
      options.generationCreatedAt != null &&
      this.generationCreatedAt != null &&
      options.generationCreatedAt !== this.generationCreatedAt
    ) {
      /** A restored pause belongs to the generation it was restored with, not this one. */
      this.clearAction();
    }
    /** Only a restored pause vouches for the timestamp of the generation it belongs to. */
    this.generationCreatedAt =
      options.generationCreatedAt ?? (this.action ? this.generationCreatedAt : undefined);
    this.setConnection('reconnecting');
    try {
      const stream = await openUntilAborted(
        this.init.transport.reconnectToStream({
          ...options,
          chatId: this.id,
          resume: true,
          abortSignal: active.controller.signal,
        }),
        active.controller.signal,
        (opened) => opened?.close(),
      );
      if (!stream && continuation) {
        this.settle({ kind: 'complete', settled: { conversationId: this.id } }, active);
        return;
      }
      if (!stream) {
        /** Nothing is running, so a restored pause ended elsewhere; published as one change. */
        if (this.status === 'submitted' || this.status === 'streaming') {
          this.init.state.status = 'ready';
        }
        this.init.state.connection = 'idle';
        this.action = undefined;
        this.decisions.clear();
        this.release(active);
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
   * server refused the stop, leaving the stream attached.
   */
  async stop(): Promise<void> {
    const active = this.active;
    if (!active && this.detached) {
      await this.stopDetached(this.detached);
      return;
    }
    if (!active) {
      await this.stopPaused();
      return;
    }
    if (!active.stream && !active.reattach) {
      active.controller.abort();
      await active.finished;
      return;
    }
    if (!active.endpoint) {
      throw new Error('The generation cannot be stopped without its endpoint');
    }
    active.paused ??= this.action?.actionId;
    const streamId = active.stream?.streamId ?? active.reattach?.streamId;
    const answer = this.abortOnServer({
      endpoint: active.endpoint,
      streamId,
      generationCreatedAt: active.stream?.generationCreatedAt ?? this.generationCreatedAt,
      abortKey: streamId == null ? this.abortKey(active) : undefined,
    }).then((result) => {
      active.stopped = true;
      if (result && 'settled' in result && result.settled) {
        active.settledAs = result.terminalStatus ?? 'complete';
      }
      return result;
    });
    active.stopAnswered = answer.then(
      () => undefined,
      () => undefined,
    );
    const result = await answer;
    if (result && 'runMessages' in result) {
      if (this.active === active) {
        await this.mergeRunMessages(result.runMessages);
      }
      active.controller.abort();
      active.stream?.close();
    } else if (!active.stream) {
      /** Still reattaching: nothing will report the end, so the stop ends the request here. */
      active.controller.abort();
    }
    await active.finished;
    /** The server confirmed the stop, so this generation is over however its stream ended. */
    if (active.disconnected && this.error === active.disconnected) {
      this.init.state.error = undefined;
      this.init.state.status = 'ready';
    }
    if (active.paused && this.action?.actionId === active.paused) {
      this.clearAction();
    } else {
      this.notify();
    }
  }

  /**
   * Drops a start that reached the server after it was cancelled. A stop also ends its generation
   * there; a disposal leaves it running, as it does an attached one.
   */
  private dropLateStart(active: ActiveRequest, sent: ChatSendResult): void {
    if (sent.status === 'stream') {
      sent.stream.close();
    }
    /** A `replaced` result names a newer generation this request does not own, so it is left alone. */
    if (this.disposed || !active.endpoint || sent.status !== 'stream') {
      return;
    }
    const { streamId, generationCreatedAt } = sent.stream;
    const target = {
      streamId,
      generationCreatedAt,
      abortKey: streamId == null ? this.abortKey(active) : undefined,
    };
    void this.abortOnServer({ endpoint: active.endpoint, ...target }).catch((error: unknown) =>
      this.init.onError?.(error instanceof Error ? error : new Error(String(error))),
    );
  }

  /** An Assistants run's stream ends without a final frame; the stop's answer carries it. */
  private mergeRunMessages(runMessages: TMessage[]): Promise<void> {
    return this.executor.run(() => {
      const next = mergeById(this.messages, runMessages);
      if (next) {
        this.write(next);
      }
    });
  }

  /** `conversationId:responseMessageId` of a run with no resumable stream (Assistants). */
  private abortKey(active: ActiveRequest): string | undefined {
    const conversationId = active.conversationId ?? this.id;
    return active.responseId ? `${conversationId}:${active.responseId}` : undefined;
  }

  /**
   * Stops a generation on the server. A run that already reached its own end counts as stopped;
   * a refusal rejects.
   */
  private async abortOnServer(target: Omit<ChatAbortRequest, 'chatId'>): Promise<ChatAbortResult> {
    const result = await this.init.transport.abort({ chatId: this.id, ...target });
    if (result && 'success' in result && !result.success && !result.settled) {
      throw new Error(result.error ?? 'The server refused the stop');
    }
    return result;
  }

  /** Stops a generation whose stream dropped, which the server keeps running. */
  private async stopDetached(detached: DetachedGeneration): Promise<void> {
    const result = await this.abortOnServer(detached.target);
    if (this.detached !== detached) {
      return;
    }
    if (result && 'runMessages' in result) {
      await this.mergeRunMessages(result.runMessages);
    }
    this.detached = undefined;
    if (this.error === detached.error) {
      this.init.state.error = undefined;
      this.init.state.status = 'ready';
    }
    if (this.action) {
      this.clearAction();
    } else {
      this.notify();
    }
  }

  /** Stops a pause restored without a stream on the server, which frees the chat for a turn. */
  private async stopPaused(): Promise<void> {
    const action = this.action;
    const endpoint = this.resumeEndpoint();
    if (!action) {
      return;
    }
    if (!endpoint) {
      throw new Error('The paused generation cannot be stopped without its endpoint');
    }
    await this.abortOnServer({
      endpoint,
      streamId: action.streamId,
      generationCreatedAt: this.generationCreatedAt,
    });
    if (this.action?.actionId !== action.actionId) {
      return;
    }
    if (this.status === 'error') {
      /** The stop confirmed the end a dropped connection left unknown. */
      this.init.state.error = undefined;
      this.init.state.status = 'ready';
    }
    this.clearAction();
  }

  /** The endpoint a generation this chat did not start runs on, as the host selects it. */
  private resumeEndpoint(): string | undefined {
    return this.init.resumeSelection?.().endpoint ?? undefined;
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
    if (this.active) {
      throw new Error('A request is in flight; its stream reports the pause');
    }
    if (this.detached && this.detached.target.generationCreatedAt !== generationCreatedAt) {
      /** The pause belongs to a newer generation than the one whose stream dropped. */
      this.detached = undefined;
    }
    if (action.expiresAt != null && action.expiresAt <= Date.now()) {
      /** An expired pause is stale: the server will refuse its resume. */
      if (this.action?.actionId === action.actionId) {
        this.clearAction();
      }
      return;
    }
    if (this.action?.actionId !== action.actionId) {
      this.decisions.clear();
    }
    this.action = action;
    this.generationCreatedAt = generationCreatedAt;
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
      this.releaseState = this.init.state.subscribe(() => this.notify());
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
    this.disposed = true;
    const active = this.active;
    this.active = undefined;
    active?.controller.abort();
    active?.stream?.close();
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
    if (this.action) {
      throw new Error('A paused generation is waiting for a decision; answer or stop it first');
    }
    const active = createActiveRequest();
    this.active = active;
    this.generationCreatedAt = undefined;
    this.detached = undefined;
    this.resumed.clear();
    this.init.state.error = undefined;
    this.setStatus('submitted');
    try {
      if (active.controller.signal.aborted) {
        throw active.controller.signal.reason;
      }
      const prepared = await untilAborted(
        this.init.prepareRequest({ ...request, chatId: this.id, messages: this.messages }),
        active.controller.signal,
      );
      active.responseId = prepared.responseMessageId;
      if (prepared.messages) {
        const optimistic = prepared.messages;
        await this.executor.run(() => {
          if (!active.controller.signal.aborted) {
            this.write(typeof optimistic === 'function' ? optimistic(this.messages) : optimistic);
          }
        });
      }
      if (active.controller.signal.aborted) {
        throw active.controller.signal.reason;
      }
      active.endpoint = prepared.payload.endpoint ?? undefined;
      active.conversationId = prepared.payload.conversationId ?? undefined;
      const { signal } = active.controller;
      const result = await openUntilAborted(
        this.init.transport.sendMessages({
          ...options,
          trigger: request.trigger,
          chatId: this.id,
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
      let stream: ChatStream | null = null;
      if (result.status === 'stream') {
        stream = result.stream;
      } else if (result.status === 'replaced' && result.generationProtocolVersion !== 2) {
        /** Only protocol v2 vouches for a replacement; an older server reported a conflict. */
        throw new Error('Another generation is running in this conversation');
      } else if (result.status === 'replaced') {
        this.setConnection('reconnecting');
        this.generationCreatedAt = result.generationCreatedAt ?? undefined;
        active.reattach = { streamId: result.streamId };
        stream = await openUntilAborted(
          this.init.transport.reconnectToStream({
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
    this.detached = undefined;
    if (stream.generationCreatedAt != null) {
      const previous = this.generationCreatedAt;
      this.generationCreatedAt = stream.generationCreatedAt;
      if (this.action && previous != null && previous !== stream.generationCreatedAt) {
        /** A restored pause belongs to the generation it was restored with, not this one. */
        this.clearAction();
      }
    }
    this.setConnection('live');
    let outcome: Outcome | undefined;
    try {
      for await (const event of stream) {
        if (signal.aborted) {
          break;
        }
        await this.executor.run(() => {
          if (!signal.aborted) {
            outcome = this.apply(event);
          }
        });
        if (event.type === 'pending_action') {
          active.paused = event.data.actionId;
        } else if (event.type === 'sync') {
          /** The server's ids for the turn, which an Assistants stop addresses. */
          active.conversationId = event.data.conversationId ?? active.conversationId;
          active.responseId = event.data.responseMessage?.messageId ?? active.responseId;
        } else if (event.type === 'final' && event.data.responseMessage?.messageId) {
          active.responseId = event.data.responseMessage.messageId;
        }
        if (outcome) {
          break;
        }
      }
    } catch (error) {
      outcome = this.toOutcome(error, active);
    } finally {
      stream.close();
    }
    if (!outcome && signal.aborted) {
      outcome = { kind: 'abort' };
    }
    const unresolved = !outcome || (outcome.kind === 'error' && outcome.disconnect);
    if (unresolved && active.stopAnswered) {
      /** A stream that ended during a stop is settled by the server's answer to it. */
      await active.stopAnswered;
    }
    if (active.stopped && unresolved) {
      outcome = active.settledAs ? getSettledOutcome(active.settledAs) : { kind: 'abort' };
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
  private apply(event: ChatEvent): Outcome | undefined {
    const applyEvent = this.init.applyEvent ?? defaultApplyEvent;
    applyEvent(event, {
      messages: this.messages,
      write: (messages) => this.write(messages),
    });
    let outcome: Outcome | undefined;
    if (streamingEvents.has(event.type) && this.status !== 'streaming') {
      this.setStatus('streaming');
    } else if (event.type === 'pending_action' && !this.resumed.has(event.data.actionId)) {
      /** A pause this chat already resumed is stale when a reattached stream replays it. */
      if (this.action?.actionId !== event.data.actionId) {
        /** A reconnect replays the same pause; decisions already made for it still stand. */
        this.decisions.clear();
      }
      this.action = event.data;
      this.notify();
    } else if (event.type === 'final') {
      this.action = undefined;
      outcome = getFinalOutcome(event.data);
    } else if (event.type === 'abort') {
      this.action = undefined;
      this.decisions.clear();
      outcome = { kind: 'abort' };
    } else if (event.type === 'error') {
      const disconnect = event.status === 0;
      if (!disconnect) {
        /** A dropped connection leaves the server's generation, and its pause, as it was. */
        this.action = undefined;
        this.decisions.clear();
      }
      const message = getErrorMessage(event.data) ?? 'The response failed';
      outcome = { kind: 'error', error: new Error(message), disconnect };
    }
    this.init.onEvent?.(event);
    return outcome;
  }

  private toOutcome(error: unknown, active: ActiveRequest): Outcome {
    if (active.controller.signal.aborted) {
      return active.settledAs ? getSettledOutcome(active.settledAs) : { kind: 'abort' };
    }
    const failure = error instanceof Error ? error : new Error(String(error));
    /** A request that never got a response may still be running on the server. */
    const disconnect = (failure as ChatTransportError).code === 'ERR_NETWORK';
    return { kind: 'error', error: failure, disconnect };
  }

  private settle(outcome: Outcome, active: ActiveRequest): void {
    if (this.active !== active) {
      return;
    }
    if (outcome.kind === 'error' && outcome.disconnect) {
      active.disconnected = outcome.error;
      const streamId = active.stream?.streamId ?? active.reattach?.streamId;
      if ((active.stream || active.reattach) && active.endpoint && !active.stopped) {
        /** The server keeps the generation running, so a later stop still reaches it. */
        this.detached = {
          error: outcome.error,
          target: {
            endpoint: active.endpoint,
            streamId,
            generationCreatedAt: active.stream?.generationCreatedAt ?? this.generationCreatedAt,
            abortKey: streamId == null ? this.abortKey(active) : undefined,
          },
        };
      }
    }
    /**
     * Released and published as one change before anyone is told, so a subscriber or callback
     * that starts the next turn is not overwritten by this one's terminal state.
     */
    this.active = undefined;
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
    const message =
      active.responseId !== undefined
        ? messages.find((stored) => stored.messageId === active.responseId)
        : messages[messages.length - 1];
    const { settled } = outcome;
    this.notify();
    if (outcome.kind === 'error') {
      this.init.onError?.(outcome.error);
    }
    this.init.onFinish?.({
      message,
      messages,
      isAbort: outcome.kind === 'abort',
      isDisconnect: outcome.kind === 'error' && outcome.disconnect,
      isError: outcome.kind === 'error',
      isSettled: settled !== undefined,
      ...(settled?.conversationId !== undefined && { conversationId: settled.conversationId }),
      ...(settled?.reason !== undefined && { reconcileReason: settled.reason }),
    });
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
    const generationCreatedAt = this.generationCreatedAt;
    if (generationCreatedAt == null) {
      throw new Error('The paused generation is unknown');
    }
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
    try {
      const result = await resume.call(this.init.transport, {
        ...this.init.resumeSelection?.(),
        ...resolution,
        conversationId: action.conversationId ?? this.id,
        generationCreatedAt,
        actionId: action.actionId,
      });
      this.resumed.add(action.actionId);
      /** A pause stopped or replaced while the request was in flight is no longer this one's. */
      if (this.action?.actionId !== action.actionId) {
        return;
      }
      if (!this.active && !this.disposed) {
        /** A pause restored after a reload has no stream attached for the continuation. */
        void this.reattach({ streamId: result.streamId, generationCreatedAt }, true);
      }
      this.clearAction();
    } finally {
      if (this.resuming === action.actionId) {
        this.resuming = undefined;
      }
    }
  }

  private write(messages: TMessage[]): void {
    if (this.disposed) {
      return;
    }
    this.init.state.replaceMessages(messages);
    this.notify();
  }

  private setStatus(status: ChatStatus): void {
    if (this.init.state.status === status) {
      return;
    }
    this.init.state.status = status;
    this.notify();
  }

  private setConnection(connection: ChatConnection): void {
    if (this.init.state.connection === connection) {
      return;
    }
    this.init.state.connection = connection;
    this.notify();
  }

  private notify(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }
}
