import type {
  TUser,
  TPreset,
  TMessage,
  TModelSpec,
  RetentionMode,
  TConversation,
  ChatTransport,
  ChatTransportRequest,
} from 'librechat-data-provider';
import type { SetStateAction, Dispatch, MouseEvent } from 'react';
import type {
  ArmSteerParams,
  ArmSteerResponse,
  AbortStreamParams,
  CancelSteerParams,
  SteerMessageParams,
  CancelSteerResponse,
  AbortStreamResponse,
  SteerMessageResponse,
  AgentQueuedTurnReceipt,
  EnqueueAgentQueuedTurnRequest,
} from '~/data-provider';
import type {
  NewConversationParams,
  TOptionSettings,
  ExtendedFile,
  TAskFunction,
  Artifact,
  PtcTrace,
} from '~/common';
import type { PendingSteer } from './queue';

/** Options accepted by {@link ChatConversationContract.newConversation}: the shared params plus
 *  the two flags only the root pane's generator honors. */
export type NewConversationOptions = NewConversationParams & {
  /** Skips focusing the composer after the new conversation renders. */
  disableFocus?: boolean;
  /** Set when the call re-renders a composer an earlier call already opened, such as agent
   * metadata arriving late. The user never left that composer, so its draft identity and its
   * in-flight attachments outlive the refresh. */
  keepComposerState?: boolean;
};

/** Target of a regenerate: a response to redo, or the user message whose response to redo. */
export type RegenerateTarget = Partial<
  Pick<TMessage, 'messageId' | 'parentMessageId' | 'isCreatedByUser'>
>;

/** Conversation identity and the per-pane settings attached to it. */
export type ChatConversationContract = {
  /** The pane this chat renders into; `0` is the root pane, `1` the added (multi-convo) pane. */
  index: number;
  /** The active conversation for this pane, or `null` before one is created. */
  conversation: TConversation | null;
  /** Replaces or updates the active conversation for this pane. */
  setConversation: Dispatch<SetStateAction<TConversation | null>>;
  /** Starts a fresh conversation in this pane from a template and/or preset. */
  newConversation: (options?: NewConversationOptions) => void;
  /** The preset applied to this pane, if any. */
  preset: TPreset | null;
  /** Replaces the preset applied to this pane. */
  setPreset: Dispatch<SetStateAction<TPreset | null>>;
  /** Legacy per-pane option toggles (examples, code chat). */
  optionSettings: TOptionSettings;
  /** Replaces the legacy per-pane option toggles. */
  setOptionSettings: Dispatch<SetStateAction<TOptionSettings>>;
};

/** The message tree as cached for this conversation. AI SDK: `messages` / `setMessages`. */
export type ChatMessagesContract = {
  /**
   * Reads the cached message list for this pane's conversation, or for `targetConversationId`.
   * AI SDK: `messages`, read on demand instead of subscribed.
   */
  getMessages: (targetConversationId?: string | null) => TMessage[] | undefined;
  /**
   * The conversation key `getMessages()` reads when called without one: the route's id, which
   * can run ahead of `conversation` while navigation settles, or `''` before the pane has either.
   * AI SDK: the chat `id`.
   */
  messagesKey: string;
  /** Writes the full message list to every cache key this pane reads. AI SDK: `setMessages`. */
  setMessages: (messages: TMessage[]) => void;
  /** Selects the visible sibling under the latest message's parent. */
  setSiblingIdx: (update: SetStateAction<number>) => void;
  /** Id of the tail of the active branch, if loaded. */
  latestMessageId: string | undefined;
  /** Depth of the tail of the active branch, if loaded. */
  latestMessageDepth: number | undefined;
};

/** Sending, regenerating and continuing turns. AI SDK: `sendMessage` / `regenerate` / `status`. */
export type ChatSubmissionContract = {
  /** Submits a user turn (or an edit, continue or compaction of one). AI SDK: `sendMessage`. */
  ask: TAskFunction;
  /** Re-runs the response to a message on the current branch. AI SDK: `regenerate`. */
  regenerate: (target: RegenerateTarget, options?: { addedConvo?: TConversation | null }) => void;
  /**
   * Whether a turn is in flight for this pane. AI SDK: `status`, collapsed to
   * `submitted | streaming` (true) versus `ready | error` (false).
   */
  isSubmitting: boolean;
  /** Sets the in-flight flag for this pane. */
  setIsSubmitting: Dispatch<SetStateAction<boolean>>;
  /** Button handler that regenerates the latest response. AI SDK: `regenerate`. */
  handleRegenerate: (e: MouseEvent<HTMLButtonElement>) => void;
  /** Button handler that continues the latest response from where it stopped. */
  handleContinue: (e: MouseEvent<HTMLButtonElement>) => void;
};

/** Stopping an in-flight turn. AI SDK: `stop`. */
export type ChatAbortContract = {
  /** Aborts the in-flight generation for this pane's conversation. AI SDK: `stop`. */
  stopGenerating: () => Promise<void>;
  /** Button handler around `stopGenerating`. AI SDK: `stop`. */
  handleStopGenerating: (e: MouseEvent<HTMLButtonElement>) => void;
  /** Whether a stop just happened and the view should hold its scroll position. */
  abortScroll: boolean;
  /** Sets the post-stop scroll hold. */
  setAbortScroll: Dispatch<SetStateAction<boolean>>;
};

/** Composer attachments for this pane. AI SDK: the `files` option of `sendMessage`. */
export type ChatFilesContract = {
  /** Attachments staged in the composer, keyed by file id. */
  files: Map<string, ExtendedFile>;
  /** Replaces the staged attachments. */
  setFiles: Dispatch<SetStateAction<Map<string, ExtendedFile>>>;
  /** Whether an attachment is still uploading. */
  filesLoading: boolean;
  /** Sets the attachment upload flag. */
  setFilesLoading: Dispatch<SetStateAction<boolean>>;
};

/** Chat-scoped view state that has no AI SDK counterpart. */
export type ChatViewContract = {
  /** Whether the pane's settings popover is open. */
  showPopover: boolean;
  /** Opens or closes the pane's settings popover. */
  setShowPopover: Dispatch<SetStateAction<boolean>>;
  /** Whether message feedback controls are enabled by the startup config. */
  feedbackEnabled: boolean;
};

/**
 * Public surface of `useChatHelpers`, served through `ChatContext`.
 *
 * Queue and steering are not part of it: they live in `useQueueDrain`, `useSteering` and
 * the SSE handlers, and reach the composer directly rather than through this context.
 * AI SDK `error` has no member here either; errors arrive as message content.
 * Setters are typed as React dispatchers, so the contract names no state library.
 */
export type ChatContract = ChatConversationContract &
  ChatMessagesContract &
  ChatSubmissionContract &
  ChatAbortContract &
  ChatFilesContract &
  ChatViewContract;

/** Public surface of `useAddedResponse`, served through `AddedChatContext`. */
export type AddedChatContract = {
  /** The added pane's conversation, or `null` when multi-convo is off. */
  conversation: TConversation | null;
  /** Replaces or updates the added pane's conversation. */
  setConversation: Dispatch<SetStateAction<TConversation | null>>;
  /** Builds and stores a conversation for the added pane from a template and/or preset. */
  generateConversation: (params?: NewConversationParams) => TConversation;
};

/** Composer action while a run is in flight: fold the text into the run, or queue a new turn. */
export type DuringRunAction = 'steer' | 'interrupt' | 'queue';

/** The deployment settings the chat hooks act on, resolved by the host from its startup config.
 *  An unset timeout falls back to the chat's own default. */
export type ChatConfig = {
  /** How long the deployment keeps conversations; forced temporary retention hides the paths
   *  that would keep one. */
  retentionMode?: RetentionMode;
  /** Whether replies offer rating feedback; off until the deployment has answered. */
  feedbackEnabled: boolean;
  /** Whether a running chat can be renamed, because the deployment protects a manual title from
   *  the pending generated one. */
  canRenameRunningChat: boolean;
  /** Model specs the deployment offers, for presets and token limits a spec carries. */
  modelSpecs?: TModelSpec[];
  queuedSendLockTimeoutMs?: number;
  queuedTurnReconciliationTimeoutMs?: number;
  steerArmConfirmationTimeoutMs?: number;
};

/** The signed-in account, as far as the chat reads it. */
export type ChatAuth = {
  /** Fills user variables such as `{{current_user}}` in a conversation's prompt prefix. */
  user?: TUser;
};

/**
 * App-global preferences the chat reads but does not own. The host supplies them, so the chat
 * hooks never reach into the app's state store for shell settings. A preference belongs here only
 * once every chat reader of it takes it from here: a reader left on the store would act on a
 * different value than a host that supplies its own.
 */
export type ChatSettings = {
  /** Default composer action while a run is in flight. */
  duringRunDefaultAction: DuringRunAction;
  setDuringRunDefaultAction: (action: DuringRunAction) => void;
  /** Closes the artifacts panel, called when the active conversation changes. */
  resetVisibleArtifacts: () => void;
  /** Whether composer text and attachments are kept as drafts across navigation. */
  saveDrafts: boolean;
  /** Whether new turns are sent as a temporary chat that the server does not retain. */
  isTemporary: boolean;
  /** Turns temporary chat on or off for the next conversation. */
  setIsTemporary: Dispatch<SetStateAction<boolean>>;
  config: ChatConfig;
  auth: ChatAuth;
};

/** The assistants abort route and the run it stops. */
export type AbortRunRequest = {
  /** The assistants endpoint whose `/abort` route owns the run. */
  endpoint: string;
  /** `conversationId:responseMessageId` of the run to stop. */
  abortKey: string;
};

/**
 * The wire the chat runs over, supplied by the host: starting a turn, streaming it, stopping
 * it, and steering or queueing behind it. A host that substitutes its own (a test, another
 * backend) changes no chat hook for those. Answers that resume a paused run (tool approvals,
 * ask-user replies) still post to the stock resume route directly.
 *
 * AI SDK: `ChatTransport`, widened by the control requests a resumable, steerable run needs.
 */
export interface Transport {
  /**
   * The stream side for one bearer token: `send` streams a turn that carries its own response
   * (Assistants), `reconnectToStream` attaches to a generation running on the server.
   */
  stream: (auth: { token?: string }) => ChatTransport;
  /**
   * POSTs a turn to a resumable generation route. Resolves to the start response, which names
   * the stream to attach to; rejects with the HTTP failure, its body on `response.data`.
   */
  start: (request: ChatTransportRequest, options?: { signal?: AbortSignal }) => Promise<unknown>;
  /** Stops a resumable generation; the stream then reports the abort. AI SDK: `stop`. */
  abort: (params: AbortStreamParams) => Promise<AbortStreamResponse>;
  /** Stops an Assistants run, which has no resumable generation to address. */
  abortRun: (request: AbortRunRequest, auth: { token?: string }) => Promise<Response>;
  /** Queues a message for injection into the running generation. */
  steer: (params: SteerMessageParams) => Promise<SteerMessageResponse>;
  /** Withdraws a steer that has not been injected yet. */
  cancelSteer: (params: CancelSteerParams) => Promise<CancelSteerResponse>;
  /** Escalates a queued steer to interrupt the running step. */
  armSteer: (params: ArmSteerParams) => Promise<ArmSteerResponse>;
  /** Reads the server's queued turns for a conversation, narrowed to known request ids. */
  listQueued: (
    conversationId: string,
    clientRequestIds?: string[],
  ) => Promise<AgentQueuedTurnReceipt[]>;
  /** Adds a turn to the server's queue behind the running generation. */
  enqueue: (input: EnqueueAgentQueuedTurnRequest) => Promise<AgentQueuedTurnReceipt>;
  /** Withdraws a queued turn the server has not admitted yet. */
  cancelQueued: (input: {
    conversationId: string;
    queuedTurnId: string;
  }) => Promise<AgentQueuedTurnReceipt>;
}

export type {
  MessagePartsHost,
  MessagePartsUser,
  MessagePartsToast,
  MessagePartMessage,
  MessagePartsUserTextPreferences,
} from '@librechat/chat/react';

/** The artifact panel as one tool artifact card drives it. */
export type MessagePartArtifactPanel = {
  /** The artifact the panel is focused on, if any. */
  currentArtifactId: string | null;
  /** The panel's stored entry for the card's artifact, if registered. */
  registered: Artifact | undefined;
  /** Stores or replaces the card's artifact in the panel. Stable across renders. */
  register: (artifact: Artifact) => void;
  /** Focuses an artifact and reveals the panel. Stable across renders. */
  open: (artifactId: string) => void;
  /** Clears the focus and hides the panel. Stable across renders. */
  close: () => void;
  /**
   * Reads and clears the one-shot "deferred preview just resolved" flag for a file in a message.
   * Stable across renders.
   */
  consumeJustResolved: (messageId: string, fileId: string) => boolean;
};

/** The host members of parts the app still owns, whose types the app still owns too. */
declare module '@librechat/chat/react' {
  interface MessagePartsHost {
    /** Live inner-call trace of one programmatic tool call in one message. */
    usePtcTrace: (messageId: string, toolCallId: string) => PtcTrace;
    /** The artifact panel, scoped to one artifact. */
    useArtifactPanel: (artifactId: string) => MessagePartArtifactPanel;
    /** Steers sent to a conversation that the server has not confirmed yet. */
    usePendingSteers: (conversationId: string) => PendingSteer[];
  }
}
