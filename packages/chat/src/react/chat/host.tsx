import { createContext, useContext } from 'react';
import type {
  TUser,
  TMessage,
  TModelSpec,
  TSubmission,
  TAttachment,
  TConversation,
  TPendingSteer,
  TEndpointOption,
  TEphemeralAgent,
  TEndpointsConfig,
  UIMappingOptions,
} from 'librechat-data-provider';
import type { Dispatch, ReactNode, SetStateAction } from 'react';
import type { BuildTurnInput, ExtendedFile } from '../../core';
import type { ChatContract } from './contract';

export interface AbortStreamParams {
  /** The stream ID to abort (if known) */
  streamId?: string;
  /** The conversation ID to abort (backend will look up the job) */
  conversationId?: string;
  /** Exact generation epoch returned by start/status. Prevents a stale tab
   * from aborting a newer turn that reused the conversation-scoped stream id. */
  generationCreatedAt?: number;
}

export interface AbortStreamResponse {
  generationProtocolVersion?: number;
  success: boolean;
  aborted?: string;
  /** Stop lost to an ordinary terminal transition; no abort FINAL was emitted. */
  settled?: boolean;
  code?: 'RUN_ALREADY_SETTLED' | string;
  streamId?: string;
  terminalStatus?: 'complete' | 'error' | 'aborted';
  error?: string;
  /** The worker stopped, but its terminal state could not be made durable.
   * The client must not infer a safe queue-drain boundary from this ACK. */
  persistenceFailed?: boolean;
  /** Steers that never reached an injection boundary; restored as queued chips. */
  pendingSteers?: TPendingSteer[];
}

/** The pane state `ask` and `regenerate` read and write for one pane. */
export type ChatTurnsParams = {
  index: number;
  files?: Map<string, ExtendedFile>;
  /** Without it a send leaves the composer's files alone. */
  setFiles?: Dispatch<SetStateAction<Map<string, ExtendedFile>>>;
  getMessages: ChatContract['getMessages'];
  setMessages: ChatContract['setMessages'];
  isSubmitting: boolean;
  conversation: TConversation | null;
  latestMessage: TMessage | null;
  setSubmission: Dispatch<SetStateAction<TSubmission | null>>;
  setConversation: Dispatch<SetStateAction<TConversation | null>>;
};

/** The code workspace and approval a send carries, decided by the app's agent settings. */
export type TurnCodeDecision = {
  code: BuildTurnInput['code'];
  /** Records the decision on the pane's conversation once the send is published. */
  apply: (conversation: TConversation) => TConversation | null;
};

/** The app's logger; `warn` and `error` may reach the app's telemetry. */
export type TurnLogger = {
  log: (...args: unknown[]) => void;
  dir: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
};

/**
 * What a pane's turns need from the app: its catalogs, routing, composer files, code workspace
 * and logging. Getters are read when a turn is sent, so they see the app's current state.
 */
export type TurnServices = {
  logger: TurnLogger;
  isTemporary: boolean;
  user?: TUser;
  modelSpecs?: TModelSpec[];
  getEndpointsConfig: () => TEndpointsConfig | undefined;
  getEphemeralAgent: (conversationId: string) => TEphemeralAgent | null;
  /** The response sender label for an endpoint option. */
  getSender: (endpointOption: TEndpointOption) => string;
  /** The stored user key expiry of the pane's endpoint, sent with non-agent endpoints. */
  getUserKey: () => string | undefined;
  /** The project the route scopes a new chat to. */
  getRouteProjectId: () => string | null;
  /** Whether cached history is mid-refetch and old enough that a send could fork from it. */
  isHistoryRevalidating: (conversationId: string | null) => boolean;
  /** The send's code decision; `null` refuses the send. */
  resolveCode: (conversation: TConversation | null) => TurnCodeDecision | null;
  /**
   * Checks a request-scoped reasoning override against the endpoint's loaded capabilities. An
   * unsupported one is dropped; `retryable` says it was refused only because the capabilities
   * are not known yet.
   */
  resolveReasoning: (args: {
    endpoint?: string | null;
    conversation: TConversation | null;
    endpointsConfig?: TEndpointsConfig;
    reasoningOverride: NonNullable<TMessage['reasoningOverride']>;
  }) => { reasoningOverride: TMessage['reasoningOverride']; retryable: boolean };
  /** Moves the pane to the route a new chat starts from. */
  openNewChat: (path: string) => void;
  /** Marks composer files as submitted, so draft cleanup keeps them. */
  releaseFiles: (fileIds: (string | undefined)[]) => void;
  /** Forgets the files queued for deletion once the composer is cleared. */
  clearFilesToDelete: () => void;
  /** Binds the conversation's usage display to the response it is waiting on. */
  bindResponse: (conversationKey: string, responseMessageId: string) => void;
  /** Brings a regenerated response into view. */
  focusResponse: (parentMessageId?: string | null) => void;
  /** Ties the composer launch to the conversation the submission starts. */
  bindLaunch: (conversation: TSubmission['conversation'], index: number) => void;
};

/** The conversation a pane shows, and the setter that replaces or updates it. */
export type ChatPaneConversation = {
  conversation: TConversation | null;
  setConversation: Dispatch<SetStateAction<TConversation | null>>;
};

/** The host's message cache, keyed by conversation id (or the pane's route key). */
export type ChatMessageCache = {
  read: (key: string) => TMessage[] | undefined;
  write: (key: string, messages: TMessage[]) => void;
  /** Subscribes to writes of one key; see {@link ChatContract.subscribeMessages}. */
  subscribe: (key: string, onChange: () => void) => () => void;
  /** How many times one key has been written; see {@link ChatContract.getMessagesRevision}. */
  revision: (key: string) => number;
  /** Marks a conversation's messages stale and refetches them, mounted or not. */
  refetchMessages: (conversationId: string) => void;
  /** Marks the active-jobs list stale. */
  refetchActiveJobs: () => void;
  /** Marks a conversation's stream status stale. */
  refetchStreamStatus: (conversationId: string) => void;
};

/** A conversation's messages as the app's data layer loads them. */
export type ChatMessagesQuery = {
  messages: TMessage[] | null;
  /** No data yet for this conversation. */
  isLoading: boolean;
  /** A load or background revalidation is in flight. */
  isFetching: boolean;
};

/** What a pane's session hands its effects each render. */
export type ChatSessionEffectsParams = {
  index: number;
  conversationId?: string;
  chat: ChatContract;
  /** The messages finished loading and no revalidation is in flight. */
  isSettled: boolean;
};

/**
 * What `useChatHelpers` needs from the app that hosts it. Members named `use*` are hooks, called
 * unconditionally by the chat hook, so the host can back each one with its own router, query
 * cache or store. A host must stay the same object for the life of the tree it wraps.
 */
export interface ChatHost {
  /** The pane's conversation in the app's pane store; mounting it registers the pane. */
  usePaneConversation(index: number): ChatPaneConversation;
  /** Starts a fresh conversation in a pane. */
  useNewConversation(index: number): ChatContract['newConversation'];
  /** What the pane's turns need from the app; see {@link TurnServices}. */
  useTurnServices(params: ChatTurnsParams): TurnServices;
  /** The tail of the branch on screen for the pane, read from the messages cached under `key`. */
  useLatestMessage(index: number, key: string): TMessage | null;
  /** The id of {@link ChatHost.useLatestMessage}, subscribed on its own. */
  useLatestMessageId(index: number, key: string): string | null;
  /** Selects the visible sibling under a parent message. */
  useSetSiblingIdx(parentMessageId: string | null): (update: SetStateAction<number>) => void;
  /** Stops a resumable generation. */
  useAbortStream(): (params: AbortStreamParams) => Promise<AbortStreamResponse>;
  useMessageCache(): ChatMessageCache;
  /** Whether message feedback controls are on. */
  useFeedbackEnabled(): boolean;
  /** The app's tool outcome rules for viewing one message; see {@link ChatContract}. */
  getMappingOptions(live: TAttachment[] | undefined): UIMappingOptions;
  /** Loads a conversation's messages; `isStreaming` lets the query hold off refetching under a
   *  live stream. An absent id loads nothing. */
  useMessages(
    conversationId: string | undefined,
    options: { isStreaming: boolean },
  ): ChatMessagesQuery;
  /**
   * Runs the pane's resume on load.
   *
   * @deprecated On arrival: a bridge to the app's `useResumeOnLoad` until it moves into this
   * package (#17565), after which the session calls it itself and this member is removed.
   */
  useSessionEffects(params: ChatSessionEffectsParams): void;
}

const ChatHostContext = createContext<ChatHost | null>(null);

/** Supplies the host `useChatHelpers` reads from. */
export function ChatHostProvider({
  host,
  children,
}: {
  host: ChatHost;
  children?: ReactNode;
}): ReactNode {
  return <ChatHostContext.Provider value={host}>{children}</ChatHostContext.Provider>;
}

export function useChatHost(): ChatHost {
  const host = useContext(ChatHostContext);
  if (host == null) {
    throw new Error('The chat hooks need a ChatHostProvider above them.');
  }
  return host;
}
