import { useAtomValue } from 'jotai';
import { useQueueDrain, submissionByIndex, useQueuedTurnReveal } from '@librechat/chat/react';
import type { ReactNode } from 'react';
import { useAdaptiveSSE, useResumeOnLoad } from '~/hooks/SSE';
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

/**
 * `ChatProvider` for the pane that owns the conversation's stream: it also runs the SSE
 * connection, resume on load and the queued-turn drain against the contract it serves.
 *
 * The session hooks run in the same component as `useChatHelpers`, after it, so their effects
 * still commit after the contract's own (`ask` releases its in-flight guard before the queue
 * drain can call it).
 */
export function ChatSessionProvider({
  index = 0,
  conversationId,
  resumeReady,
  children,
}: {
  index?: number;
  conversationId?: string;
  /** The conversation's messages have loaded and settled, so a resume can build from them. */
  resumeReady: boolean;
  children: ReactNode;
}) {
  const chat = useChatHelpers(index, conversationId);
  const rootSubmission = useAtomValue(submissionByIndex(index));

  useAdaptiveSSE(rootSubmission, chat, false, index);
  useResumeOnLoad(conversationId, chat.getMessages, index, resumeReady);

  /** Shows a server-owned queued follow-up as the next user turn as soon as its predecessor
   *  completes, ahead of the receipt and active-job polls. */
  const revealQueuedTurn = useQueuedTurnReveal(conversationId, index);
  useQueueDrain(index, conversationId, chat.ask, revealQueuedTurn);

  return <ChatContext.Provider value={chat}>{children}</ChatContext.Provider>;
}
