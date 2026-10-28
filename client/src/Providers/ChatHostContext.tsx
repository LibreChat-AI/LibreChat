import { useMemo } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import { QueryKeys } from 'librechat-data-provider';
import { hashQueryKey, useQueryClient } from '@tanstack/react-query';
import type { QueryClient, QueryCacheNotifyEvent } from '@tanstack/react-query';
import type { ChatHost, ChatMessageCache } from '@librechat/chat/react';
import type { TMessage } from 'librechat-data-provider';
import { useLatestMessage, useLatestMessageId } from '~/hooks/Messages/useLatestMessage';
import { siblingIdxFamily, siblingKey } from '~/components/Chat/Messages/Thread/state';
import { useChatSettings } from '~/Providers/ChatSettingsContext';
import { messageAttachmentsMapAtom } from '~/hooks/SSE/atoms';
import useChatFunctions from '~/hooks/Chat/useChatFunctions';
import { getMappingOptions } from '~/hooks/Chat/outcomes';
import { useAbortStreamMutation } from '~/data-provider';
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
  };
}

function useMessageCache(): ChatMessageCache {
  const queryClient = useQueryClient();
  return useMemo(() => createMessageCache(queryClient), [queryClient]);
}

/** The app's services behind `useChatHelpers`: its pane store, message query cache, turn
 *  builder, thread selection, transport and settings. */
export const appChatHost: ChatHost = {
  usePaneConversation: (index) => useChatSettings().usePaneConversationState(index),
  useNewConversation: (index) => useNewConvo(index).newConversation,
  useTurns: (params) => useChatFunctions(params),
  useLatestMessage: (index, key) => useLatestMessage(index, key),
  useLatestMessageId: (index, key) => useLatestMessageId(index, key),
  useSetSiblingIdx: (parentMessageId) => useSetAtom(siblingIdxFamily(siblingKey(parentMessageId))),
  /** `mutateAsync` is bound once per observer; the mutation result object is fresh every
   *  render and would defeat the contract's memo. */
  useAbortStream: () => useAbortStreamMutation().mutateAsync,
  useMessageCache,
  useLiveAttachments: () => useAtomValue(messageAttachmentsMapAtom),
  useFeedbackEnabled: () => useChatSettings().config.feedbackEnabled,
  getMappingOptions,
};

export { ChatHostProvider, useChatHost } from '@librechat/chat/react';
