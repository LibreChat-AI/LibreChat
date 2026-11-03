import type { DurableStorageConfig } from 'librechat-data-provider';
import type { StoredResponseRecord, ResponseTerminalReceipt } from '~/models/response';
import type { AppConfig, IMessage } from '~/types';
import { ManagedDocumentTooLargeError } from '~/utils/bson';
import { activeExpirationFilter } from '~/utils/retention';
import { createConversationMethods } from './conversation';
import { createResponseTurnPublisher } from './projection';
import { createConversationModel } from '~/models/convo';
import { canonicalConversationFilter } from './managed';
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
    | 'langfuseCentralTraceExportEnabled'
    | 'langfuseSampled'
    | 'langfuseDestinationIds'
    | 'langfuseRunId'
  >[];
}

export type ResponseConversationWrites = Pick<
  ResponseTurnWrites,
  'context' | 'conversation' | 'initialAgentId'
>;

/** Publish only confirmed history, then append to the captured physical Conversation. */
export async function materializeResponseTurn(
  mongoose: typeof import('mongoose'),
  record: StoredResponseRecord,
  receipt: ResponseTerminalReceipt,
  writes: ResponseTurnWrites,
  getMCPAppMessageBudget?: () => Promise<number | undefined>,
  bounds: Partial<DurableStorageConfig> = {},
): Promise<
  { ok: true } | { ok: false; code: 'response_conflict' | 'target_retired' | 'document_limit' }
> {
  try {
    if (!record.storageTarget || !record.conversationTarget)
      return { ok: false, code: 'target_retired' };
    const target = record.conversationTarget;
    if (
      target.userId !== record.userId ||
      target.conversationId !== record.conversationId ||
      (target.tenantId || undefined) !== (record.tenantId || undefined)
    )
      throw new Error('Response canonical Conversation identity changed');
    const present = await createConversationModel(mongoose)
      .exists({
        ...canonicalConversationFilter(mongoose, target),
        $and: [activeExpirationFilter()],
      })
      .read('primary');
    if (!present) return { ok: false, code: 'target_retired' };
    const ids: string[] = [];
    const publish = createResponseTurnPublisher(mongoose, record, receipt);
    for (const message of writes.messages) {
      const published = await publish(
        message.messageId,
        async (publication, expiredAt) => {
          const messages = createMessageMethods(mongoose, {
            managedPublication: publication,
            getMCPAppMessageBudget,
          });
          return messages.saveMessage(
            {
              ...writes.context,
              ...(expiredAt && (!writes.context.expiredAt || expiredAt < writes.context.expiredAt)
                ? { expiredAt }
                : {}),
            },
            message,
            { context: 'Responses API - commit canonical turn' },
          );
        },
        { ...bounds, expiredAt: writes.context.expiredAt },
      );
      if (!published.ok) return published;
      if (published.value.messageId !== message.messageId || !published.value._id)
        throw new Error('Response canonical Message identity changed');
      ids.push(String(published.value._id));
    }
    const messages = createMessageMethods(mongoose);
    const saved = await createConversationMethods(mongoose, {
      conversationTarget: target,
      getMessages: messages.getMessages,
      deleteMessages: messages.deleteMessages,
    }).saveConvo(writes.context, writes.conversation, {
      appendMessageIds: ids,
      context: 'Responses API - append confirmed canonical turn',
    });
    const appended =
      !!saved &&
      '_id' in saved &&
      String(saved._id) === target.id &&
      saved.conversationId === record.conversationId;
    if (appended) return { ok: true };
    const remaining = await createConversationModel(mongoose)
      .exists({
        ...canonicalConversationFilter(mongoose, target),
        $and: [activeExpirationFilter()],
      })
      .read('primary');
    return { ok: false, code: remaining ? 'response_conflict' : 'target_retired' };
  } catch (error) {
    // MongoDB used 17419/17420 for oversized updates/upserts before standardizing
    // them on BSONObjectTooLarge (10334). Only a definite size rejection is final.
    if (
      error instanceof ManagedDocumentTooLargeError ||
      (error instanceof mongoose.mongo.MongoServerError &&
        typeof error.code === 'number' &&
        [10334, 17419, 17420].includes(error.code))
    )
      return { ok: false, code: 'document_limit' };
    throw error;
  }
}
