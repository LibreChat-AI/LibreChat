import { useMemo } from 'react';
import { SIDE_CHAT_PANE } from '@librechat/chat/react';
import { Constants, QueryKeys } from 'librechat-data-provider';
import { hashQueryKey, useQueryClient } from '@tanstack/react-query';
import type { ChatHost, ChatMessageCache, ChatMessagesQuery } from '@librechat/chat/react';
import type { TMessage, TAgentQueuedTurnReceipt } from 'librechat-data-provider';
import type { QueryClient, QueryCacheNotifyEvent } from '@tanstack/react-query';
import {
  refetchMessagesOnMount,
  useAbortStreamMutation,
  useGetMessagesByConvoId,
} from '~/data-provider';
import { agentQueuedTurnsQueryKey } from '~/data-provider/SSE/queuedTurns';
import { useChatSettings } from '~/Providers/ChatSettingsContext';
import useTurnServices from '~/hooks/Chat/services';
import useNewConvo from '~/hooks/useNewConvo';

/** Cache events that add, drop or rewrite a query's data. */
const dataEvents = new Set<QueryCacheNotifyEvent['type']>(['added', 'removed', 'updated']);

const messagesHash = (key: string) => hashQueryKey([QueryKeys.messages, key]);
const statusProps: Array<'isLoading' | 'isFetching'> = ['isLoading', 'isFetching'];

/**
 * The chat's message cache over the app's query cache. A subscription counts only events that
 * can change the data: observers mount inside other components' renders and the cache notifies
 * synchronously, so the change is delivered after the current task instead of inside someone
 * else's render. The revision is the query's own write count, so a write that lands before the
 * listener subscribes is still seen.
 */
export function createMessageCache(queryClient: QueryClient): ChatMessageCache {
  return {
    /** By the query's hash: `getQueryData` compares the key against every query in the cache,
     *  and this is read several times for each frame of a reply. */
    read: (key) => queryClient.getQueryCache().get<TMessage[]>(messagesHash(key))?.state.data,
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
      queryClient.getQueryCache().get(messagesHash(conversationId))?.state.dataUpdatedAt,
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
 *  the background instead of unmounting into a spinner. A payload or failure `ChatRoute` just
 *  prefetched counts as this mount's own load. With `enabled: false` it is a second reader of
 *  that query, which never fetches. */
function useMessages(
  conversationId: string | undefined,
  {
    isStreaming,
    enabled = true,
    messages: reads = true,
  }: { isStreaming: boolean; enabled?: boolean; messages?: boolean },
): ChatMessagesQuery {
  const query = useGetMessagesByConvoId(
    conversationId ?? '',
    {
      enabled: enabled && !!conversationId && conversationId !== Constants.SEARCH,
      /** A reader that only follows the query leaves its mount, and the prefetch's mark, alone. */
      ...(enabled && { refetchOnMount: refetchMessagesOnMount }),
      /** One that asks only whether they are loading is told of that and of nothing else. */
      ...(!reads && { notifyOnChangeProps: statusProps }),
    },
    { isStreaming },
  );
  return {
    messages: reads ? (query.data ?? null) : null,
    isLoading: query.isLoading,
    isFetching: query.isFetching,
  };
}

/** The app's services behind `useChatHelpers`: its pane store, message query cache, turn
 *  services, thread selection, transport and settings. */
export const appChatHost: ChatHost = {
  usePaneConversation: (index) => useChatSettings().usePaneConversationState(index),
  /** A conversation beside the chat has no route: its pane changes it in place or not at all. */
  useNewConversation: (index) =>
    useNewConvo(index, { routed: index !== SIDE_CHAT_PANE }).newConversation,
  useTurnServices,
  /** `mutateAsync` is bound once per observer; the mutation result object is fresh every
   *  render and would defeat the contract's memo. */
  useAbortStream: () => useAbortStreamMutation().mutateAsync,
  useMessageCache,
  useFeedbackEnabled: () => useChatSettings().config.feedbackEnabled,
  useMessages,
};

export { ChatHostProvider, useChatHost } from '@librechat/chat/react';
