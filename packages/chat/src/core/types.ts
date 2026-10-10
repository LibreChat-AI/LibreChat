import type {
  TPayload,
  ChatEvent,
  TConversation,
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
  close(): void;
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
  abortSignal?: AbortSignal;
};

export type ChatAbortRequest = {
  chatId: string;
  streamId?: string;
  endpoint: string;
};

/**
 * The wire a chat runs over. AI SDK: `ChatTransport`, with LibreChat's two-step run underneath:
 * a turn is started by a POST and then attached to, so `reconnectToStream` can reattach to a
 * generation the server kept running. The queue methods are optional capabilities; a chat
 * reports them as unsupported when the transport leaves them out.
 */
export interface ChatTransport {
  /** Starts a turn, then attaches to its stream. */
  sendMessages(request: ChatSendRequest): Promise<ChatStream>;
  /** Attaches to the running generation, or resolves `null` when nothing is running. */
  reconnectToStream(request: ChatReconnectRequest): Promise<ChatStream | null>;
  /** Stops the running generation; its stream then reports the abort. */
  abort(request: ChatAbortRequest): Promise<void>;
  close?(): void;
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
  retentionMode?: string;
  feedbackEnabled: boolean;
  balanceEnabled: boolean;
  queuedSendLockTimeoutMs?: number;
  queuedTurnReconciliationTimeoutMs?: number;
  steerArmConfirmationTimeoutMs?: number;
};

export type ChatHostAuth = {
  headers: Resolvable<Record<string, string>>;
  /** Resolves a fresh token after a 401, or `undefined` when the session cannot be refreshed. */
  refreshToken?: () => Promise<string | undefined>;
  userId?: string;
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
