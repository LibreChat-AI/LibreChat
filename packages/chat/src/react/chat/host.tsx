import { createContext, useContext } from 'react';
import type {
  TMessage,
  TSubmission,
  TAttachment,
  TConversation,
  TPendingSteer,
  UIMappingOptions,
} from 'librechat-data-provider';
import type { Dispatch, ReactNode, SetStateAction } from 'react';
import type { ChatContract } from './contract';
import type { ExtendedFile } from '../../core';

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

/** What the host's turn builder needs to submit and regenerate turns for one pane. */
export type ChatTurnsParams = {
  index: number;
  files: Map<string, ExtendedFile>;
  setFiles: Dispatch<SetStateAction<Map<string, ExtendedFile>>>;
  getMessages: ChatContract['getMessages'];
  setMessages: ChatContract['setMessages'];
  isSubmitting: boolean;
  conversation: TConversation | null;
  latestMessage: TMessage | null;
  setSubmission: Dispatch<SetStateAction<TSubmission | null>>;
  setConversation: Dispatch<SetStateAction<TConversation | null>>;
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
  /** Builds and submits turns: `ask` and `regenerate`. */
  useTurns(params: ChatTurnsParams): Pick<ChatContract, 'ask' | 'regenerate'>;
  /** The tail of the branch on screen for the pane, read from the messages cached under `key`. */
  useLatestMessage(index: number, key: string): TMessage | null;
  /** The id of {@link ChatHost.useLatestMessage}, subscribed on its own. */
  useLatestMessageId(index: number, key: string): string | null;
  /** Selects the visible sibling under a parent message. */
  useSetSiblingIdx(parentMessageId: string | null): (update: SetStateAction<number>) => void;
  /** Stops a resumable generation. */
  useAbortStream(): (params: AbortStreamParams) => Promise<AbortStreamResponse>;
  useMessageCache(): ChatMessageCache;
  /** Attachments delivered by message id ahead of the message cache. Stable across renders. */
  useLiveAttachments(): Record<string, TAttachment[] | undefined>;
  /** Whether message feedback controls are on. */
  useFeedbackEnabled(): boolean;
  /** The app's tool outcome rules for viewing one message; see {@link ChatContract}. */
  getMappingOptions(live: TAttachment[] | undefined): UIMappingOptions;
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
