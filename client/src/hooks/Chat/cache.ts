import { hashQueryKey } from '@tanstack/react-query';
import { QueryKeys, Constants } from 'librechat-data-provider';
import type { QueryClient, QueryCacheNotifyEvent } from '@tanstack/react-query';
import type { ChatMessagesContract } from '@librechat/chat/react';
import type { TMessage } from 'librechat-data-provider';

type MessageCacheIdsParams = {
  queryParam: string;
  conversationId?: string | null;
  messages: TMessage[];
};

function isConcreteConversationId(conversationId?: string | null): conversationId is string {
  return (
    !!conversationId &&
    conversationId !== Constants.NEW_CONVO &&
    conversationId !== Constants.PENDING_CONVO
  );
}

export function getMessagesConversationId(messages: TMessage[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const conversationId = messages[i]?.conversationId;
    if (isConcreteConversationId(conversationId)) {
      return conversationId;
    }
  }
}

export function getMessageCacheIds({
  queryParam,
  conversationId,
  messages,
}: MessageCacheIdsParams): string[] {
  const ids = [queryParam];
  const messageConversationId = getMessagesConversationId(messages);

  if (queryParam === Constants.NEW_CONVO && isConcreteConversationId(conversationId)) {
    ids.push(conversationId);
  }

  if (isConcreteConversationId(messageConversationId) && !ids.includes(messageConversationId)) {
    ids.push(messageConversationId);
  }

  return ids;
}

/** Cache events that add, drop or rewrite a query's data. */
const dataEvents = new Set<QueryCacheNotifyEvent['type']>(['added', 'removed', 'updated']);

/**
 * The contract's subscription to one conversation's cached messages. Only events that can
 * change the data count: observers mount inside other components' renders and the cache
 * notifies synchronously, so the change is delivered after the current task instead of inside
 * someone else's render. The revision is the query's own write count, so a write that lands
 * before the listener subscribes is still seen.
 */
export function createMessagesSubscription(
  queryClient: QueryClient,
  messagesKey: string,
): Pick<ChatMessagesContract, 'subscribeMessages' | 'getMessagesRevision'> {
  const queryHash = hashQueryKey([QueryKeys.messages, messagesKey]);
  return {
    subscribeMessages: (onChange) => {
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
    getMessagesRevision: () =>
      queryClient.getQueryCache().get(queryHash)?.state.dataUpdateCount ?? 0,
  };
}
