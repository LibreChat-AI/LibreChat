import type {
  TUser,
  Agents,
  TModelSpec,
  RetentionMode,
  TPayload,
  TMessage,
  TEphemeralAgent,
  ChatEvent,
  TConversation,
  TPendingSteer,
  TAgentQueuedTurnReceipt,
  TEnqueueAgentQueuedTurnRequest,
} from 'librechat-data-provider';

export type {
  TMessage,
  ChatEvent,
  UIMessage,
  UIToolPart,
  UIDataPart,
  UITextPart,
  UIMessagePart,
  UIReasoningPart,
  TMessageContentParts,
} from 'librechat-data-provider';
export {
  ContentTypes,
  toUIMessage,
  fromUIMessage,
  isUIToolPart,
  isUIDataPart,
} from 'librechat-data-provider';

/**
 * Where a chat is in its turn. AI SDK: `ChatStatus`.
 * `submitted` until the first event of the response is applied, `streaming` until the terminal
 * event, then `ready`, or `error` until the error is cleared.
 */
export type ChatStatus = 'submitted' | 'streaming' | 'ready' | 'error';

/**
 * Whether the chat holds a live stream. Orthogonal to {@link ChatStatus}: a dropped connection
 * stays `streaming` while it is `reconnecting`, because the server keeps generating.
 */
export type ChatConnection = 'idle' | 'live' | 'reconnecting';

/** A value, or a function that produces it on demand. AI SDK: `Resolvable`. */
export type Resolvable<T> = T | (() => T | Promise<T>);

/** Per-request additions a caller layers over the transport's defaults. AI SDK: `ChatRequestOptions`. */
export type ChatRequestOptions = {
  headers?: Record<string, string>;
  body?: object;
};

/** What started a stream. AI SDK: `trigger`, plus LibreChat's continue. */
export type ChatTrigger = 'submit-message' | 'regenerate-message' | 'continue-message';

/** One attached response stream: the events in wire order, ending at the terminal one. */
export type ChatStream = AsyncIterable<ChatEvent> & {
  /** The server's id for the generation, when it names one; what a reconnect addresses. */
  readonly streamId?: string;
  /**
   * When the server started this generation. A stream id is reused across a conversation's turns,
   * so an abort carries this to stop only the generation it means.
   */
  readonly generationCreatedAt?: number;
  /** The generation protocol the server selected for this stream; missing or `1` is legacy. */
  readonly generationProtocolVersion?: number;
  /** The start attached to a generation already running for this turn instead of starting one. */
  readonly resumed?: boolean;
  close(): void;
};

/**
 * How a start ended. `settled`: the turn already reached its terminal state, so there is nothing
 * to attach to. `replaced`: a newer generation owns the conversation; the caller attaches to it
 * or reports the conflict.
 */
export type ChatSendResult =
  | { status: 'stream'; stream: ChatStream }
  | { status: 'settled'; conversationId: string; generationProtocolVersion?: number }
  | {
      status: 'replaced';
      conversationId: string;
      streamId: string;
      generationCreatedAt: number;
      /** Both control outcomes are v2-only; a caller trusts them only when this says `2`. */
      generationProtocolVersion?: number;
    };

export type ChatSendRequest = ChatRequestOptions & {
  trigger: ChatTrigger;
  chatId: string;
  messageId?: string;
  payload: TPayload;
  abortSignal?: AbortSignal;
};

export type ChatReconnectRequest = ChatRequestOptions & {
  chatId: string;
  streamId?: string;
  /** Replays the generation so far before live events, for a client that missed them. */
  resume?: boolean;
  /** The {@link ChatStream.generationCreatedAt} to reattach to, so a newer run is not attached instead. */
  generationCreatedAt?: number;
  abortSignal?: AbortSignal;
};

export type ChatAbortRequest = {
  chatId: string;
  streamId?: string;
  /** The {@link ChatStream.generationCreatedAt} of the run to stop; a newer run is left running. */
  generationCreatedAt?: number;
  endpoint: string;
  /**
   * `conversationId:responseMessageId` of a run with no resumable stream (Assistants), which the
   * endpoint's own abort route addresses instead of a stream id.
   */
  abortKey?: string;
};

/** What the server did with a stop request for a resumable generation. */
export type ChatStreamAbortResult = {
  success: boolean;
  generationProtocolVersion?: number;
  /** The id of the stream that was stopped. */
  aborted?: string;
  streamId?: string;
  /** The run reached its own terminal state first, so no abort event follows. */
  settled?: boolean;
  terminalStatus?: 'complete' | 'error' | 'aborted';
  /** The run stopped but its terminal state was not saved; the queue must not drain behind it. */
  persistenceFailed?: boolean;
  /** Steers the run never injected, handed back so they can be restored. */
  pendingSteers?: TPendingSteer[];
  code?: string;
  error?: string;
};

/**
 * An Assistants stop, addressed by `abortKey`. That stream ends without a final event of its own,
 * so the stop's response carries the terminal conversation and messages; `null` when there was no
 * run left to stop.
 */
export type ChatRunAbortResult = {
  final: true;
  conversation: Partial<TConversation>;
  runMessages: TMessage[];
} | null;

export type ChatAbortResult = ChatStreamAbortResult | ChatRunAbortResult;

/** Text folded into the running generation at its next injection boundary. */
export type ChatSteerRequest = {
  conversationId: string;
  /** The generation being steered; a steer for a finished generation is refused. */
  generationCreatedAt?: number;
  /** Correlates terminal events that can arrive before the steer is acknowledged. */
  clientSteerId?: string;
  text: string;
  files?: TMessage['files'];
  /** Quoted excerpts sent with the text, merged into the turn at the injection boundary. */
  quotes?: string[];
  /** Asks to interrupt the running step instead of waiting for a tool boundary. */
  preempt?: boolean;
};

/** The server queued the steer; `settled` and `leftover` mark a receipt replayed after the run ended. */
export type ChatSteerResult = {
  generationProtocolVersion?: number;
  status: 'queued';
  steerId: string;
  position: number;
  conversationId: string;
  preempt?: boolean;
  preemptRevision?: number;
  /** Whether the server kept the quotes; when absent they are restored to the composer. */
  quotesAccepted?: boolean;
  settled?: boolean;
  leftover?: boolean;
  replayed?: boolean;
};

/** Identifies a queued steer of one generation. */
export type ChatSteerTarget = {
  conversationId: string;
  steerId: string;
  generationCreatedAt?: number;
};

/** `removed: false` means the cancel lost its race with the injection or the run's end. */
export type ChatCancelSteerResult = { generationProtocolVersion?: number; removed?: boolean };

/** `armed: false` means the steer already injected, was cancelled, or cannot interrupt here. */
export type ChatArmSteerResult = {
  generationProtocolVersion?: number;
  armed?: boolean;
  code?: string;
  preemptRevision?: number;
};

/** The server's view of a conversation's generation, read before reattaching. */
export type ChatStreamStatus = {
  generationProtocolVersion?: number;
  active: boolean;
  streamId?: string;
  status?: 'running' | 'complete' | 'error' | 'aborted' | 'requires_action';
  /** Content generated so far, for a client that reattaches mid-turn. */
  aggregatedContent?: Array<{ type: string; text?: string }>;
  createdAt?: number;
  /** Generation age on the server's clock, so elapsed time survives clock skew. */
  elapsedMs?: number;
  resumeState?: Agents.ResumeState;
  isTemporary?: boolean;
  /** The pending approval while `status` is `requires_action`. */
  pendingAction?: Agents.PendingAction;
  /** Steers a terminal drain parked because no subscriber was live; restored as queued. */
  unrecoveredSteers?: TPendingSteer[];
};

/** The agent selection a paused generation resumes with, matching its original request. */
export type ChatResumeSelection = {
  conversationId: string;
  /** The paused generation being resumed. */
  generationCreatedAt: number;
  endpoint?: string | null;
  endpointType?: string | null;
  agent_id?: string | null;
  model?: string | null;
  spec?: string | null;
  promptPrefix?: string | null;
  ephemeralAgent?: TEphemeralAgent | null;
  isTemporary?: boolean;
};

/** Answers a paused generation: tool approval decisions, or an ask-user reply. */
export type ChatResumeRequest = ChatResumeSelection & { actionId: string } & (
    | { decisions: Agents.ToolApprovalResolution[] }
    | { answer?: string; answers?: Record<string, string> }
  );

/** The continuation streams over the stream already attached. */
export type ChatResumeResult = {
  generationProtocolVersion?: number;
  streamId: string;
  conversationId: string;
  status: 'resuming';
};

/**
 * A failed transport request. `code` is `ERR_NETWORK` when the request never got a response, so a
 * caller can tell an ambiguous failure from a refusal; `response.data` carries the server's reason,
 * such as `NO_ACTIVE_RUN`, `RUN_PAUSED`, `STEER_UNSUPPORTED` or `RUN_REPLACED`.
 */
export type ChatTransportError = Error & {
  code?: string;
  response?: { status: number; data: unknown; headers: Record<string, string> };
};

/**
 * The wire a chat runs over. AI SDK: `ChatTransport`, with LibreChat's two-step run underneath:
 * a turn is started by a POST and then attached to, so `reconnectToStream` can reattach to a
 * generation the server kept running. The steer and queue methods are optional capabilities; a chat
 * reports them as unsupported when the transport leaves them out.
 */
export interface ChatTransport {
  /** Starts a turn, then attaches to its stream. Rejects with a {@link ChatTransportError}. */
  sendMessages(request: ChatSendRequest): Promise<ChatSendResult>;
  /** Attaches to the running generation, or resolves `null` when nothing is running. */
  reconnectToStream(request: ChatReconnectRequest): Promise<ChatStream | null>;
  /**
   * Stops the running generation; its stream then reports the abort, unless the result says it
   * settled first. A request with `abortKey` resolves to a {@link ChatRunAbortResult}.
   */
  abort(request: ChatAbortRequest): Promise<ChatAbortResult>;
  close?(): void;
  /** Reads the conversation's generation state; what a reload checks before reattaching. */
  getStatus?(conversationId: string): Promise<ChatStreamStatus>;
  /** Resumes a paused generation with approval decisions or an ask-user reply. */
  resume?(request: ChatResumeRequest): Promise<ChatResumeResult>;
  /** Folds text into the running generation. */
  steer?(request: ChatSteerRequest): Promise<ChatSteerResult>;
  /** Withdraws a steer that has not been injected yet. */
  cancelSteer?(
    request: ChatSteerTarget & { clientSteerId?: string },
  ): Promise<ChatCancelSteerResult>;
  /** Escalates a queued steer to interrupt the running step. */
  armSteer?(request: ChatSteerTarget): Promise<ChatArmSteerResult>;
  listQueued?(
    conversationId: string,
    clientRequestIds?: string[],
  ): Promise<TAgentQueuedTurnReceipt[]>;
  enqueue?(input: TEnqueueAgentQueuedTurnRequest): Promise<TAgentQueuedTurnReceipt>;
  cancelQueued?(input: {
    conversationId: string;
    queuedTurnId: string;
  }): Promise<TAgentQueuedTurnReceipt>;
}

/** Composer action while a run is in flight: fold the text into the run, or queue a new turn. */
export type DuringRunAction = 'steer' | 'interrupt' | 'queue';

/** App-global preferences the chat reads but does not own. */
export type ChatHostSettings = {
  duringRunDefaultAction: DuringRunAction;
  setDuringRunDefaultAction: (action: DuringRunAction) => void;
  /** Closes the artifacts panel, called when the active conversation changes. */
  resetVisibleArtifacts: () => void;
  /** Whether composer text and attachments are kept as drafts across navigation. */
  saveDrafts: boolean;
  /** Whether new turns are sent as a temporary chat that the server does not retain. */
  isTemporary: boolean;
  setIsTemporary: (value: boolean | ((previous: boolean) => boolean)) => void;
};

/** The deployment configuration the chat reads. */
export type ChatHostConfig = {
  /** How long the deployment keeps conversations; forced temporary retention hides saving paths. */
  retentionMode?: RetentionMode;
  /** Whether replies offer rating feedback. */
  feedbackEnabled: boolean;
  /** Whether a running chat can be renamed, because the deployment protects a manual title. */
  canRenameRunningChat: boolean;
  /** Model specs the deployment offers, for the presets and token limits a spec carries. */
  modelSpecs?: TModelSpec[];
  balanceEnabled: boolean;
  queuedSendLockTimeoutMs?: number;
  queuedTurnReconciliationTimeoutMs?: number;
  steerArmConfirmationTimeoutMs?: number;
};

export type ChatHostAuth = {
  headers: Resolvable<Record<string, string>>;
  /** Resolves a fresh token after a 401, or `undefined` when the session cannot be refreshed. */
  refreshToken?: () => Promise<string | undefined>;
  /** Fills user variables such as `{{current_user}}` in a conversation's prompt prefix. */
  user?: TUser;
};

export type ChatHostNavigation = {
  /** Moves the `new` route onto the conversation the server created, without a history entry. */
  replaceNewConversationUrl(conversationId: string): void;
  onConversationCreated?(conversation: TConversation): void;
};

export type ChatNotification = {
  message: string;
  status: 'error' | 'info' | 'success';
};

/**
 * Everything app-global a chat needs, supplied by the app that hosts it. Nothing in the package
 * reads the app's stores, startup config or auth context; the host passes them in here.
 */
export type ChatHost = {
  settings: ChatHostSettings;
  config: ChatHostConfig;
  auth: ChatHostAuth;
  navigation: ChatHostNavigation;
  notify?: (notification: ChatNotification) => void;
};
