import type {
  TUser,
  TModelSpec,
  RetentionMode,
  TConversation,
  TEphemeralAgent,
  ChatTransport,
  ChatTransportRequest,
} from 'librechat-data-provider';
import type { NewConversationParams } from '@librechat/chat/react';
import type { SetStateAction, Dispatch } from 'react';
import type { PendingSteer } from '@librechat/chat';
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
import type { MessagesEditing } from '~/Providers/MessagesViewContext';
import type { Artifact, PtcTrace } from '~/common';

export type {
  ChatContract,
  RegenerateTarget,
  ChatViewContract,
  ChatFilesContract,
  ChatAbortContract,
  ChatMessagesContract,
  NewConversationOptions,
  ChatSubmissionContract,
  ChatConversationContract,
} from '@librechat/chat/react';

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
  /** Whether the deployment has answered with its config; until then the fields above are
   *  defaults, and a decision that depends on them (a rebuilt turn's retention) waits. A host
   *  that leaves it unset has no config to wait for. */
  loaded?: boolean;
  /** Whether the deployment tracks token balances, refreshed after each turn. */
  balanceEnabled?: boolean;
};

/** The signed-in account, as far as the chat reads it. */
export type ChatAuth = {
  /** Fills user variables such as `{{current_user}}` in a conversation's prompt prefix. */
  user?: TUser;
  /** Bearer token the chat's streams and run aborts authenticate with. */
  token?: string;
  isAuthenticated?: boolean;
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
  /** Reads the ephemeral agent (tool toggles) staged for a conversation, `null` when none. */
  getEphemeralAgent: (conversationId: string) => TEphemeralAgent | null;
  /** The conversation open in the added (multi-convo) pane, `null` when there is none. */
  addedConversation: TConversation | null;
  config: ChatConfig;
  auth: ChatAuth;
  /** The conversation each mounted chat pane shows, read when called rather than at render:
   *  steer recovery asks whether any pane holding a conversation is still running. */
  getPaneConversations: () => ReadonlyArray<PaneConversation>;
  /** A hook, stable across renders: the conversation a pane shows, subscribed so the reader
   *  re-renders when the pane moves to another conversation. `null` before the pane has one. */
  usePaneConversation: (index: string | number) => TConversation | null;
  /** A hook, stable across renders: a pane's conversation and its setter, for the chat that
   *  renders into that pane. Mounting it registers the pane with the app's pane list. */
  usePaneConversationState: (index: string | number) => PaneConversationState;
};

/** The conversation a chat pane shows, and the setter that replaces or updates it. */
export type PaneConversationState = {
  conversation: TConversation | null;
  setConversation: Dispatch<SetStateAction<TConversation | null>>;
};

/** One mounted chat pane and the conversation it shows. */
export type PaneConversation = {
  /** The pane key, as the app keys its panes (`0` for the main chat). */
  index: string | number;
  conversationId: string | null;
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
  MessagePartsMarkdownProps,
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
    /** The messages view an inline editor reads and writes; only rendered inside one. */
    useMessagesEditing: () => MessagesEditing;
    /** The messages view's `ask`, or one that does nothing outside a messages view. */
    useMessagesAsk: () => MessagesEditing['ask'];
  }
}
