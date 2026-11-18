import { useContext, createContext } from 'react';
import type { TConversation } from 'librechat-data-provider';
import type { Context, ReactNode } from 'react';
import type { FollowedChat, FollowChatOptions } from '../follow';

/**
 * What a side chat reads from the app. Members named `use*` are hooks, called unconditionally,
 * and a host stays the same object for the life of the tree it wraps.
 */
export interface SideChatHost {
  /**
   * The conversation as a chat the reader drives: its stored messages, the generation running
   * under it, and a transport that can start and stop one on the conversation's endpoint.
   */
  useChat: (
    conversation: Pick<TConversation, 'conversationId' | 'endpoint'>,
    options?: Pick<FollowChatOptions, 'onWithdrawn'>,
  ) => FollowedChat;
  /** Opens the conversation as the page's main one. */
  useOpenConversation: () => (conversation: TConversation) => void;
  /** Whether the panel is a modal sheet over the chat rather than a region beside it. */
  useSheetLayout: () => boolean;
  /** Whether the deployment draws a footer bar the panel's composer has to clear. */
  useClearsFooter: () => boolean;
}

const SideChatHostContext: Context<SideChatHost | null> = createContext<SideChatHost | null>(null);

/** Supplies the host a side chat reads from. */
export function SideChatHostProvider({
  host,
  children,
}: {
  host: SideChatHost;
  children?: ReactNode;
}): ReactNode {
  return <SideChatHostContext.Provider value={host}>{children}</SideChatHostContext.Provider>;
}

export function useSideChatHost(): SideChatHost {
  const host = useContext(SideChatHostContext);
  if (host == null) {
    throw new Error('A side chat needs a SideChatHostProvider above it.');
  }
  return host;
}
