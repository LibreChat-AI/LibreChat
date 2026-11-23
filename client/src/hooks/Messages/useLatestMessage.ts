import { useRecoilValue } from 'recoil';
import { useParams } from 'react-router-dom';
import { Constants } from 'librechat-data-provider';
import {
  useBranchTail,
  useBranchTailId,
  useBranchTailGetter,
  useBranchTailSelect,
} from '@librechat/chat/react';
import type { TMessage } from 'librechat-data-provider';
import store from '~/store';

function useLatestMessagesQueryId(
  index: string | number,
  conversationId: string | null,
  messagesQueryId?: string | null,
) {
  const { conversationId: routeConversationId } = useParams();

  if (!conversationId) {
    return null;
  }

  if (messagesQueryId != null) {
    return messagesQueryId;
  }

  if (index === 0 && routeConversationId) {
    return routeConversationId === Constants.NEW_CONVO ? Constants.NEW_CONVO : routeConversationId;
  }

  return conversationId;
}

export function useLatestMessage(
  index: string | number,
  messagesQueryIdOverride?: string | null,
): TMessage | null {
  const conversationId = useRecoilValue(store.conversationIdByIndex(index));
  const messagesQueryId = useLatestMessagesQueryId(index, conversationId, messagesQueryIdOverride);
  return useBranchTail(conversationId, messagesQueryId);
}

export function useLatestMessageId(
  index: string | number,
  messagesQueryIdOverride?: string | null,
): string | null {
  const conversationId = useRecoilValue(store.conversationIdByIndex(index));
  const messagesQueryId = useLatestMessagesQueryId(index, conversationId, messagesQueryIdOverride);
  return useBranchTailId(conversationId, messagesQueryId);
}

export type TLatestMessageMeta = Pick<TMessage, 'messageId' | 'error' | 'isCreatedByUser'>;

const pickMeta = (tail: TMessage | null): TLatestMessageMeta | null =>
  tail && {
    messageId: tail.messageId,
    error: tail.error,
    isCreatedByUser: tail.isCreatedByUser,
  };

/**
 * Metadata-only projection of the branch tail. Streaming deltas leave these
 * fields untouched, so React Query's structural sharing keeps the selected
 * object referentially stable and consumers skip the per-delta re-renders a
 * full `useLatestMessage` subscription would cause.
 */
export function useLatestMessageMeta(
  index: string | number,
  messagesQueryIdOverride?: string | null,
): TLatestMessageMeta | null {
  return useLatestMessageSelect(index, pickMeta, messagesQueryIdOverride);
}

/**
 * A projection of the branch tail. `pick` must be stable; whatever it returns keeps its identity
 * through structural sharing until the fields it reads change, so a reader of something a
 * streamed delta never touches does not render for one.
 */
export function useLatestMessageSelect<TData>(
  index: string | number,
  pick: (tail: TMessage | null) => TData | null,
  messagesQueryIdOverride?: string | null,
): TData | null {
  const conversationId = useRecoilValue(store.conversationIdByIndex(index));
  const messagesQueryId = useLatestMessagesQueryId(index, conversationId, messagesQueryIdOverride);
  return useBranchTailSelect(conversationId, messagesQueryId, pick);
}

/**
 * Call-time reader for the branch tail: no cache subscription at all, so
 * callbacks that only need the latest message when invoked keep a stable
 * identity across streaming deltas.
 */
export function useGetLatestMessage(
  index: string | number,
  messagesQueryIdOverride?: string | null,
): () => TMessage | null {
  const conversationId = useRecoilValue(store.conversationIdByIndex(index));
  const messagesQueryId = useLatestMessagesQueryId(index, conversationId, messagesQueryIdOverride);
  return useBranchTailGetter(conversationId, messagesQueryId);
}
