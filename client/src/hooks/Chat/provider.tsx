import { useAtomValue } from 'jotai';
import { Constants } from 'librechat-data-provider';
import {
  useQueueDrain,
  useIsSubmitting,
  submissionByIndex,
  useQueuedTurnReveal,
} from '@librechat/chat/react';
import type { TMessage } from 'librechat-data-provider';
import type { ReactNode } from 'react';
import { useAdaptiveSSE, useResumeOnLoad } from '~/hooks/SSE';
import { useGetMessagesByConvoId } from '~/data-provider';
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

/** The pane's messages query, as `ChatSessionProvider` hands it to the pane it renders. */
export type ChatSessionMessages = {
  messages: TMessage[] | null;
  isLoading: boolean;
};

/**
 * `ChatProvider` for the pane that owns the conversation's stream: it also loads the
 * conversation's messages and runs the SSE connection, resume on load and the queued-turn drain
 * against the contract it serves.
 *
 * Every session hook runs in this one component, in the order the pane has always run them:
 * the messages query subscribes (and starts its mount refetch) before the contract and the
 * session effects commit, and the queue drain commits after `useChatHelpers`, so `ask` has
 * released its in-flight guard and sees the refetch before the drain can call it. The pane is
 * a render function so it re-renders with every session render, as it did when it ran these
 * hooks itself.
 */
export function ChatSessionProvider({
  index = 0,
  conversationId,
  children,
}: {
  index?: number;
  conversationId?: string;
  children: (session: ChatSessionMessages) => ReactNode;
}) {
  const isSubmitting = useIsSubmitting(index);
  const {
    data: messages = null,
    isLoading,
    isFetching,
  } = useGetMessagesByConvoId(
    conversationId ?? '',
    {
      enabled: !!conversationId && conversationId !== Constants.SEARCH,
      /** Refetch stale caches on mount: navigation invalidates (not removes)
       * messages now, so a warm conversation renders instantly from cache and
       * reconciles in the background instead of unmounting into a spinner. */
      refetchOnMount: true,
    },
    { isStreaming: isSubmitting },
  );

  const chat = useChatHelpers(index, conversationId);
  const rootSubmission = useAtomValue(submissionByIndex(index));

  useAdaptiveSSE(rootSubmission, chat, false, index);

  /** Auto-resume waits for messages to load AND the warm-cache background revalidation to
   *  settle: a stale invalidated cache mounts with isLoading false while the refetch is in
   *  flight, and resume must not build from (or race) it. */
  useResumeOnLoad(conversationId, chat.getMessages, index, !isLoading && !isFetching);

  /** Shows a server-owned queued follow-up as the next user turn as soon as its predecessor
   *  completes, ahead of the receipt and active-job polls. */
  const revealQueuedTurn = useQueuedTurnReveal(conversationId, index);
  useQueueDrain(index, conversationId, chat.ask, revealQueuedTurn);

  return (
    <ChatContext.Provider value={chat}>{children({ messages, isLoading })}</ChatContext.Provider>
  );
}
