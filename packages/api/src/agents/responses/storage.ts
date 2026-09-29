import { EModelEndpoint } from 'librechat-data-provider';
import { RESPONSE_ID_PREFIX } from './service';

/** Only persisted Responses assistant messages can name a continued run. */
export interface StoredResponseMessage {
  messageId: string;
  conversationId: string;
  endpoint?: string;
  isCreatedByUser?: boolean;
  sender?: string;
  finish_reason?: string;
  text?: string;
  tokenCount?: number;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface StoredResponseConversation {
  conversationId: string;
}

/** The referenced response bounds history; an incomplete store is never model input. */
export function selectStoredResponseHistory<
  Message extends { messageId?: string; finish_reason?: string },
>(messages: Message[], responseId?: string): Message[] {
  const lastIndex = responseId
    ? messages.findIndex((message) => message.messageId === responseId)
    : -1;
  if (responseId && lastIndex < 0) return [];
  return (responseId ? messages.slice(0, lastIndex + 1) : messages).filter(
    (message) =>
      !message.messageId?.startsWith(RESPONSE_ID_PREFIX) || message.finish_reason === 'stop',
  );
}

export interface StoredResponseReads<
  Message extends StoredResponseMessage,
  Conversation extends StoredResponseConversation,
> {
  getMessage: (params: { user: string; messageId: string }) => Promise<Message | null>;
  getConvo: (user: string, conversationId: string) => Promise<Conversation | null>;
}

/** A response ID is the assistant message ID; legacy conversation IDs remain supported. */
export async function resolveStoredResponse<
  Message extends StoredResponseMessage,
  Conversation extends StoredResponseConversation,
>(
  user: string,
  id: string,
  reads: StoredResponseReads<Message, Conversation>,
): Promise<{ conversation: Conversation; message: Message | null } | null> {
  if (!id.startsWith(RESPONSE_ID_PREFIX)) {
    const conversation = await reads.getConvo(user, id);
    return conversation ? { conversation, message: null } : null;
  }

  const message = await reads.getMessage({ user, messageId: id });
  if (
    message?.messageId !== id ||
    message.isCreatedByUser !== false ||
    message.endpoint !== EModelEndpoint.agents ||
    message.sender !== 'Agent' ||
    message.finish_reason !== 'stop' ||
    !message.conversationId
  ) {
    return null;
  }
  const conversation = await reads.getConvo(user, message.conversationId);
  return conversation?.conversationId === message.conversationId ? { conversation, message } : null;
}
