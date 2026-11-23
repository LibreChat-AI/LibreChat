import { useAtomValue } from 'jotai';
import type { TMessage } from 'librechat-data-provider';
import type { ReactNode } from 'react';
import { submissionByIndex, useIsSubmitting } from '../submission';
import useQueuedTurnReveal from '../steering/useQueuedTurnReveal';
import { useResumeOnLoad } from '../stream/resume/load';
import useQueueDrain from '../steering/useQueueDrain';
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
 * The messages of a pane's session, for whatever under `ChatSessionProvider` draws them. It
 * subscribes for itself, so the reader is redrawn when the messages change, as they do on every
 * frame of a reply, and what stands between the provider and the reader is not. Deliberately
 * not a context: a context that changes this often has React search the whole thread under its
 * provider for readers on every change.
 *
 * It follows what the session loads and loads nothing itself: the session's own query decides
 * when the conversation is fetched. It says the same of the pane's stream as the session does,
 * so the two readers of one query never disagree about whether a reply is being written: which
 * of them a refetch takes its guard from is the query library's to choose.
 */
export function useChatSessionMessages(conversationId?: string, index = 0): ChatSessionMessages {
  const isSubmitting = useIsSubmitting(index);
  const { messages, isLoading } = useChatHost().useMessages(conversationId, {
    isStreaming: isSubmitting,
    enabled: false,
  });
  return { messages, isLoading };
}

/**
 * `ChatProvider` for the pane that owns the conversation's stream: it also loads the
 * conversation's messages and runs the stream, resume on load and the queued-turn drain
 * against the contract it serves.
 *
 * Every session hook runs in this one component, in the order the pane has always run them:
 * the messages query subscribes (and starts its mount refetch) before the contract and the
 * session effects commit, and the queue drain commits after `useChatHelpers`, so `ask` has
 * released its in-flight guard and sees the refetch before the drain can call it.
 *
 * The pane under it is given as an element, and what draws the messages reads them with
 * {@link useChatSessionMessages}: a frame of a reply then re-renders that reader, and neither
 * the pane nor this session, which asks its host only whether the messages are loading. A
 * render function is still taken; the session then reads the messages too, and calls it with
 * them on every change.
 */
export function ChatSessionProvider({
  index = 0,
  conversationId,
  historyReady = true,
  children,
}: {
  /** The pane: `0` is the root pane, `1` the added (multi-convo) pane. */
  index?: number;
  /** The route's conversation id, which can run ahead of the pane's conversation. */
  conversationId?: string;
  /** The saved record is ready for stream recovery; history can load before it. */
  historyReady?: boolean;
  children: ReactNode | ((session: ChatSessionMessages) => ReactNode);
}): ReactNode {
  const host = useChatHost();
  const isSubmitting = useIsSubmitting(index);
  /**
   * The session itself needs to know only whether the messages are loading, for resume. A pane
   * given as an element reads them for itself, so the session is not re-rendered for them: every
   * frame of a reply would otherwise run each session hook again for nothing.
   */
  const { messages, isLoading, isFetching } = host.useMessages(conversationId, {
    isStreaming: isSubmitting,
    messages: typeof children === 'function',
  });

  const chat = useChatHelpers(index, conversationId);
  const submission = useAtomValue(submissionByIndex(index));

  useAdaptiveSSE(submission, chat, false, index);

  /** Resume waits for messages to load AND the warm-cache background revalidation to settle:
   *  a stale invalidated cache mounts with isLoading false while the refetch is in flight, and
   *  resume must not build from (or race) it. */
  useResumeOnLoad(
    conversationId,
    chat.getMessages,
    index,
    historyReady && !isLoading && !isFetching,
  );

  /** Shows a server-owned queued follow-up as the next user turn as soon as its predecessor
   *  completes, ahead of the receipt and active-job polls. */
  const revealQueuedTurn = useQueuedTurnReveal(conversationId, index);
  useQueueDrain(index, conversationId, chat.ask, revealQueuedTurn);

  return (
    <ChatContext.Provider value={chat}>
      {typeof children === 'function' ? children({ messages, isLoading }) : children}
    </ChatContext.Provider>
  );
}
