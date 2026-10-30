import type { ClientSession } from 'mongoose';
import type { AppConfig, IMessage } from '~/types';
import { createConversationMethods } from './conversation';
import { createMessageMethods } from './message';

/** Plain, server-owned projection of one immutable terminal receipt. No database handles escape. */
export interface ResponseTurnWrites {
  intentJSON: string;
  context: {
    userId: string;
    isTemporary?: boolean;
    expiredAt?: Date;
    interfaceConfig?: AppConfig['interfaceConfig'];
  };
  conversation: { conversationId: string; [key: string]: unknown };
  initialAgentId: string | null;
  messages: Pick<
    IMessage,
    | 'messageId'
    | 'conversationId'
    | 'parentMessageId'
    | 'isCreatedByUser'
    | 'isUserSubmitted'
    | 'text'
    | 'content'
    | 'sender'
    | 'endpoint'
    | 'model'
    | 'metadata'
    | 'unfinished'
    | 'finish_reason'
    | 'tokenCount'
    | 'langfuseSampled'
    | 'langfuseDestinationIds'
    | 'langfuseRunId'
  >[];
}

/** Reuse the canonical privacy, provenance, retention and budget writers in the caller's commit. */
export async function materializeResponseTurn(
  mongoose: typeof import('mongoose'),
  session: ClientSession,
  writes: ResponseTurnWrites,
  getMCPAppMessageBudget?: () => Promise<number | undefined>,
): Promise<void> {
  const messages = createMessageMethods(mongoose, { saveSession: session, getMCPAppMessageBudget });
  const conversations = createConversationMethods(mongoose, {
    saveSession: session,
    getMessages: messages.getMessages,
    deleteMessages: messages.deleteMessages,
  });
  const ids: string[] = [];
  for (const message of writes.messages) {
    const saved = await messages.saveMessage(writes.context, message, {
      context: 'Responses API - commit canonical turn',
    });
    if (!saved || saved.messageId !== message.messageId || !saved._id)
      throw new Error('Response message materialization failed');
    ids.push(String(saved._id));
  }
  const saved = await conversations.saveConvo(writes.context, writes.conversation, {
    initialAgentId: writes.initialAgentId,
    appendMessageIds: ids,
    context: 'Responses API - commit canonical turn',
  });
  if (
    !saved ||
    !('conversationId' in saved) ||
    saved.conversationId !== writes.conversation.conversationId
  )
    throw new Error('Response conversation materialization failed');
}
