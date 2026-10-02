import type { ReactNode } from 'react';
import { ChatContext } from '~/Providers/ChatContext';
import useChatHelpers from './useChatHelpers';

/**
 * Builds a pane's chat contract and serves it to `useChat`, `useChatActions` and
 * `useChatContext` below. A host renders this instead of calling `useChatHelpers` itself, so
 * components reach the chat only through the facade and its context.
 */
export function ChatProvider({
  index = 0,
  conversationId,
  children,
}: {
  /** The pane: `0` is the root pane, `1` the added (multi-convo) pane. */
  index?: number;
  /** The route's conversation id, which can run ahead of the pane's conversation. */
  conversationId?: string;
  children: ReactNode;
}) {
  const chat = useChatHelpers(index, conversationId);
  return <ChatContext.Provider value={chat}>{children}</ChatContext.Provider>;
}
