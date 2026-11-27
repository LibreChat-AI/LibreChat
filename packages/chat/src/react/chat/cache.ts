import { Constants } from 'librechat-data-provider';
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
