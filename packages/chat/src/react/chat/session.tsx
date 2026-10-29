import { useAtomValue } from 'jotai';
import type { TMessage } from 'librechat-data-provider';
import type { ReactNode } from 'react';
import { submissionByIndex, useIsSubmitting } from '../submission';
import useQueuedTurnReveal from '../steering/useQueuedTurnReveal';
import useQueueDrain from '../steering/useQueueDrain';
import { useResumeOnLoad } from '../stream/resume/load';
import useAdaptiveSSE from '../stream/adaptive';
import { ChatContext } from './context';
import useChatHelpers from './helpers';
import { useChatHost } from './host';

/** The pane's messages query, as `ChatSessionProvider` hands it to the pane it renders. */
export type ChatSessionMessages = {
  messages: TMessage[] | null;
  isLoading: boolean;
};

/**
 * `ChatProvider` for the pane that owns the conversation's stream: it also loads the
 * conversation's messages and runs the stream, resume on load and the queued-turn drain
 * against the contract it serves.
 *
 * Every session hook runs in this one component, in the order the pane has always run them:
 * the messages query subscribes (and starts its mount refetch) before the contract and the
 * session effects commit, and the queue drain commits after `useChatHelpers`, so `ask` has
 * released its in-flight guard and sees the refetch before the drain can call it. The pane is
 * a render function so it re-renders with every session render.
 */
export function ChatSessionProvider({
  index = 0,
  conversationId,
  children,
}: {
  /** The pane: `0` is the root pane, `1` the added (multi-convo) pane. */
  index?: number;
  /** The route's conversation id, which can run ahead of the pane's conversation. */
  conversationId?: string;
  children: (session: ChatSessionMessages) => ReactNode;
}): ReactNode {
  const host = useChatHost();
  const isSubmitting = useIsSubmitting(index);
  const { messages, isLoading, isFetching } = host.useMessages(conversationId, {
    isStreaming: isSubmitting,
  });

  const chat = useChatHelpers(index, conversationId);
  const submission = useAtomValue(submissionByIndex(index));

  useAdaptiveSSE(submission, chat, false, index);

  /** Resume waits for messages to load AND the warm-cache background revalidation to settle:
   *  a stale invalidated cache mounts with isLoading false while the refetch is in flight, and
   *  resume must not build from (or race) it. */
  useResumeOnLoad(conversationId, chat.getMessages, index, !isLoading && !isFetching);

  /** Shows a server-owned queued follow-up as the next user turn as soon as its predecessor
   *  completes, ahead of the receipt and active-job polls. */
  const revealQueuedTurn = useQueuedTurnReveal(conversationId, index);
  useQueueDrain(index, conversationId, chat.ask, revealQueuedTurn);

  return (
    <ChatContext.Provider value={chat}>{children({ messages, isLoading })}</ChatContext.Provider>
  );
}
