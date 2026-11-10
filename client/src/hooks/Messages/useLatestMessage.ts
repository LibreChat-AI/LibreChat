import { useCallback } from 'react';
import { useStore } from 'jotai';
import { useRecoilValue } from 'recoil';
import { useParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { Constants, QueryKeys } from 'librechat-data-provider';
import { useBranchTail, useBranchTailId, useBranchTailSelect } from '@librechat/chat/react';
import type { TMessage } from 'librechat-data-provider';
import { siblingIdxFamily, siblingKey } from '~/components/Chat/Messages/Thread/state';
import { selectActiveBranchTail } from '~/utils';
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
  const conversationId = useRecoilValue(store.conversationIdByIndex(index));
  const messagesQueryId = useLatestMessagesQueryId(index, conversationId, messagesQueryIdOverride);
  return useBranchTailSelect(conversationId, messagesQueryId, pickMeta);
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
  const queryClient = useQueryClient();
  const jotaiStore = useStore();
  const conversationId = useRecoilValue(store.conversationIdByIndex(index));
  const messagesQueryId = useLatestMessagesQueryId(index, conversationId, messagesQueryIdOverride);

  return useCallback((): TMessage | null => {
    if (!messagesQueryId) {
      return null;
    }
    const messages =
      queryClient.getQueryData<TMessage[]>([QueryKeys.messages, messagesQueryId]) ?? [];
    return selectActiveBranchTail(
      messages,
      messages[0]?.conversationId ?? conversationId,
      (parentId) => jotaiStore.get(siblingIdxFamily(siblingKey(parentId))),
    );
  }, [queryClient, jotaiStore, conversationId, messagesQueryId]);
}
