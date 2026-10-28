import { useMemo } from 'react';
import { useSetAtom } from 'jotai';
import { Constants, QueryKeys } from 'librechat-data-provider';
import { hashQueryKey, useQueryClient } from '@tanstack/react-query';
import type { ChatHost, ChatMessageCache, ChatMessagesQuery } from '@librechat/chat/react';
import type { TMessage, TAgentQueuedTurnReceipt } from 'librechat-data-provider';
import type { QueryClient, QueryCacheNotifyEvent } from '@tanstack/react-query';
import { useLatestMessage, useLatestMessageId } from '~/hooks/Messages/useLatestMessage';
import { siblingIdxFamily, siblingKey } from '~/components/Chat/Messages/Thread/state';
import { useAbortStreamMutation, useGetMessagesByConvoId } from '~/data-provider';
import { agentQueuedTurnsQueryKey } from '~/data-provider/SSE/queuedTurns';
import { useChatSettings } from '~/Providers/ChatSettingsContext';
import { getMappingOptions } from '~/hooks/Chat/outcomes';
import useTurnServices from '~/hooks/Chat/services';
import { useResumeOnLoad } from '~/hooks/SSE';
import useNewConvo from '~/hooks/useNewConvo';

/** Cache events that add, drop or rewrite a query's data. */
const dataEvents = new Set<QueryCacheNotifyEvent['type']>(['added', 'removed', 'updated']);

const messagesHash = (key: string) => hashQueryKey([QueryKeys.messages, key]);

/**
 * The chat's message cache over the app's query cache. A subscription counts only events that
 * can change the data: observers mount inside other components' renders and the cache notifies
 * synchronously, so the change is delivered after the current task instead of inside someone
 * else's render. The revision is the query's own write count, so a write that lands before the
 * listener subscribes is still seen.
 */
export function createMessageCache(queryClient: QueryClient): ChatMessageCache {
  return {
    read: (key) => queryClient.getQueryData<TMessage[]>([QueryKeys.messages, key]),
    write: (key, messages) => {
      queryClient.setQueryData<TMessage[]>([QueryKeys.messages, key], messages);
    },
    subscribe: (key, onChange) => {
      const queryHash = messagesHash(key);
      let active = true;
      const unsubscribe = queryClient.getQueryCache().subscribe((event) => {
        if (event.query.queryHash !== queryHash || !dataEvents.has(event.type)) {
          return;
        }
        queueMicrotask(() => {
          if (active) {
            onChange();
          }
        });
      });
      return () => {
        active = false;
        unsubscribe();
      };
    },
    revision: (key) =>
      queryClient.getQueryCache().get(messagesHash(key))?.state.dataUpdateCount ?? 0,
    refetchMessages: (conversationId) => {
      queryClient.invalidateQueries({
        queryKey: [QueryKeys.messages, conversationId],
        refetchType: 'all',
      });
    },
    refetchActiveJobs: () => {
      queryClient.invalidateQueries({ queryKey: [QueryKeys.activeJobs] });
    },
    refetchStreamStatus: (conversationId) => {
      queryClient.invalidateQueries({ queryKey: ['streamStatus', conversationId] });
    },
    invalidateMessages: (conversationId) => {
      queryClient.invalidateQueries({ queryKey: [QueryKeys.messages, conversationId] });
    },
    messagesUpdatedAt: (conversationId) =>
      queryClient.getQueryState([QueryKeys.messages, conversationId])?.dataUpdatedAt,
    reloadMessages: async (conversationId) => {
      await queryClient.refetchQueries(
        { queryKey: [QueryKeys.messages, conversationId], exact: true },
        { throwOnError: true },
      );
    },
    readQueuedTurns: (conversationId) =>
      queryClient.getQueryData<TAgentQueuedTurnReceipt[]>(agentQueuedTurnsQueryKey(conversationId)),
  };
}

function useMessageCache(): ChatMessageCache {
  const queryClient = useQueryClient();
  return useMemo(() => createMessageCache(queryClient), [queryClient]);
}

/** The conversation's messages query. Refetches stale caches on mount: navigation invalidates
 *  (not removes) messages, so a warm conversation renders instantly from cache and reconciles in
 *  the background instead of unmounting into a spinner. */
function useMessages(
  conversationId: string | undefined,
  { isStreaming }: { isStreaming: boolean },
): ChatMessagesQuery {
  const {
    data = null,
    isLoading,
    isFetching,
  } = useGetMessagesByConvoId(
    conversationId ?? '',
    {
      enabled: !!conversationId && conversationId !== Constants.SEARCH,
      refetchOnMount: true,
    },
    { isStreaming },
  );
  return { messages: data, isLoading, isFetching };
}

/** The app's services behind `useChatHelpers`: its pane store, message query cache, turn
 *  services, thread selection, transport and settings. */
export const appChatHost: ChatHost = {
  usePaneConversation: (index) => useChatSettings().usePaneConversationState(index),
  useNewConversation: (index) => useNewConvo(index).newConversation,
  useTurnServices,
  useLatestMessage: (index, key) => useLatestMessage(index, key),
  useLatestMessageId: (index, key) => useLatestMessageId(index, key),
  useSetSiblingIdx: (parentMessageId) => useSetAtom(siblingIdxFamily(siblingKey(parentMessageId))),
  /** `mutateAsync` is bound once per observer; the mutation result object is fresh every
   *  render and would defeat the contract's memo. */
  useAbortStream: () => useAbortStreamMutation().mutateAsync,
  useMessageCache,
  useFeedbackEnabled: () => useChatSettings().config.feedbackEnabled,
  getMappingOptions,
  useMessages,
  useSessionEffects: ({ index, conversationId, chat, isSettled }) => {
    useResumeOnLoad(conversationId, chat.getMessages, index, isSettled);
  },
};

export { ChatHostProvider, useChatHost } from '@librechat/chat/react';
