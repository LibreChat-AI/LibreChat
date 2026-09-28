import type { FilterQuery, Model } from 'mongoose';
import type { IConversation, IMessage } from '~/types';
import { runAsSystem, tenantStorage } from '~/config/tenantContext';
import { refreshChatProjectStatsForUser } from './chatProject';

export interface ConversationImportCleanupScope {
  user: string;
  conversationIds: readonly string[];
  tenantId?: string;
}

export interface ConversationImportMethods {
  deleteImportedMessages(scope: ConversationImportCleanupScope): Promise<void>;
  deleteImportedConversations(scope: ConversationImportCleanupScope): Promise<void>;
}

/** Keeps generated UUID arrays well below MongoDB's 16 MiB command limit. */
export const CONVERSATION_IMPORT_CLEANUP_CHUNK_SIZE = 10_000;

function createImportCleanupFilter<T>(
  scope: ConversationImportCleanupScope,
  conversationIds: readonly string[],
): FilterQuery<T> {
  return {
    user: scope.user,
    conversationId: { $in: conversationIds },
    ...(scope.tenantId == null ? { tenantId: { $exists: false } } : { tenantId: scope.tenantId }),
  };
}

function chunkConversationIds(conversationIds: readonly string[]): string[][] {
  const chunks: string[][] = [];
  for (
    let index = 0;
    index < conversationIds.length;
    index += CONVERSATION_IMPORT_CLEANUP_CHUNK_SIZE
  ) {
    chunks.push(conversationIds.slice(index, index + CONVERSATION_IMPORT_CLEANUP_CHUNK_SIZE));
  }
  return chunks;
}

export function createConversationImportMethods(
  mongoose: typeof import('mongoose'),
): ConversationImportMethods {
  async function deleteImportedMessages(scope: ConversationImportCleanupScope): Promise<void> {
    if (scope.conversationIds.length === 0) {
      return;
    }
    const Message = mongoose.models.Message as Model<IMessage>;
    await runAsSystem(async () => {
      for (const conversationIds of chunkConversationIds(scope.conversationIds)) {
        await Message.deleteMany(createImportCleanupFilter<IMessage>(scope, conversationIds));
      }
    });
  }

  async function deleteImportedConversations(scope: ConversationImportCleanupScope): Promise<void> {
    if (scope.conversationIds.length === 0) {
      return;
    }
    const Conversation = mongoose.models.Conversation as Model<IConversation>;
    const projectIds = await runAsSystem(async () => {
      const affectedProjectIds = new Set<string>();
      for (const conversationIds of chunkConversationIds(scope.conversationIds)) {
        const filter = createImportCleanupFilter<IConversation>(scope, conversationIds);
        const affectedProjects = await Conversation.distinct('chatProjectId', filter);
        for (const projectId of affectedProjects) {
          if (projectId) {
            affectedProjectIds.add(String(projectId));
          }
        }
        await Conversation.deleteMany(filter);
      }
      return [...affectedProjectIds];
    });
    const context = tenantStorage.getStore();
    await tenantStorage.run(
      { ...context, tenantId: scope.tenantId, userId: scope.user },
      async () => {
        await Promise.all(
          projectIds.map((projectId) =>
            refreshChatProjectStatsForUser(mongoose, scope.user, projectId),
          ),
        );
      },
    );
  }

  return { deleteImportedMessages, deleteImportedConversations };
}
