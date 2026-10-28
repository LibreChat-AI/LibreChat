import { useRef, useMemo } from 'react';
import type { TMessage } from 'librechat-data-provider';
import type { TMessageChatContext } from '~/common/types';
import { useChatContext } from '~/Providers';

type LiveChatValues = {
  isSubmitting: boolean;
  latestMessageId: string | undefined;
  latestMessageDepth: number | undefined;
};

/**
 * Creates a stable `TMessageChatContext` object for memo'd message components.
 *
 * Subscribes to `useChatContext()` internally (intended to be called from non-memo'd
 * wrapper components like `Message` and `MessageContent`), then produces:
 * - A `chatContext` object that stays referentially stable across submissions and
 *   new turns: `isSubmitting`, `latestMessageId` and `latestMessageDepth` are
 *   getters backed by a ref, for reads at call time (click handlers)
 * - A stable `conversation` reference that only updates when rendering-relevant fields change
 * - An `effectiveIsSubmitting` value (false for non-latest messages)
 * - The current `latestMessageId` / `latestMessageDepth`, which the wrapper passes
 *   to the row as props so the row's comparator can ignore changes that leave
 *   this row's relation to the tail unchanged (see `isSameTailRelation`)
 *
 * Every submission and every server id hydration moves the tail, so keying the
 * context object on those values re-rendered every row of the thread several
 * times per send, when only the rows entering or leaving the tail change.
 */
export default function useMemoizedChatContext(
  message: TMessage | null | undefined,
  isSubmitting: boolean,
) {
  const chatCtx = useChatContext();
  const { latestMessageId, latestMessageDepth } = chatCtx;

  const liveRef = useRef<LiveChatValues>({ isSubmitting, latestMessageId, latestMessageDepth });
  liveRef.current = { isSubmitting, latestMessageId, latestMessageDepth };

  /**
   * Stabilize conversation: only update when rendering-relevant fields change,
   * not on every metadata update (e.g., title generation).
   */
  const stableConversation = useMemo(
    () => chatCtx.conversation,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      chatCtx.conversation?.conversationId,
      chatCtx.conversation?.endpoint,
      chatCtx.conversation?.endpointType,
      chatCtx.conversation?.model,
      chatCtx.conversation?.agent_id,
      chatCtx.conversation?.assistant_id,
    ],
  );

  const chatContext: TMessageChatContext = useMemo(
    () => ({
      ask: chatCtx.ask,
      index: chatCtx.index,
      regenerate: chatCtx.regenerate,
      conversation: stableConversation,
      handleContinue: chatCtx.handleContinue,
      feedbackEnabled: chatCtx.feedbackEnabled,
      get isSubmitting() {
        return liveRef.current.isSubmitting;
      },
      get latestMessageId() {
        return liveRef.current.latestMessageId;
      },
      get latestMessageDepth() {
        return liveRef.current.latestMessageDepth;
      },
    }),
    [
      chatCtx.ask,
      chatCtx.index,
      chatCtx.regenerate,
      stableConversation,
      chatCtx.handleContinue,
      chatCtx.feedbackEnabled,
    ],
  );

  const messageId = message?.messageId ?? null;
  const isLatestMessage = messageId === latestMessageId;
  const effectiveIsSubmitting = isLatestMessage ? isSubmitting : false;

  return { chatContext, effectiveIsSubmitting, latestMessageId, latestMessageDepth };
}
