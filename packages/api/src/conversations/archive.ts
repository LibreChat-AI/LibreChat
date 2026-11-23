import { logger } from '@librechat/data-schemas';
import { isAllDataRetention } from 'librechat-data-provider';
import type { AppConfig, ConversationMethods, IConversation } from '@librechat/data-schemas';
import type { Response } from 'express';
import type { ServerRequest } from '~/types';
import { getSafeErrorMetadata } from '~/utils/errors';

type ArchiveAllHandlerDependencies = Pick<ConversationMethods, 'archiveAllConvos'>;

export function createArchiveAllHandler(
  deps: ArchiveAllHandlerDependencies,
): (req: ServerRequest, res: Response) => Promise<Response> {
  return async function archiveAllHandler(req: ServerRequest, res: Response): Promise<Response> {
    try {
      const result = await deps.archiveAllConvos(req.user!.id);
      return res.status(200).json(result);
    } catch (error) {
      logger.error('Error archiving all conversations', error);
      return res.status(500).send('Error archiving all conversations');
    }
  };
}

type ArchiveDependencies = Pick<ConversationMethods, 'saveConvo' | 'getConvoRetention'>;

type ArchiveRequest = {
  body?: { arg?: { conversationId?: unknown; isArchived?: unknown } };
  user?: { id: string };
  config?: Pick<AppConfig, 'interfaceConfig'>;
  /** `undefined` when the access check trusted its cached marker and read nothing. */
  resolvedConversation?: Pick<IConversation, 'isTemporary' | 'expiredAt'> | null;
};

/**
 * Archives or unarchives a conversation as a retention-aware save, so a chat that predates the
 * request's retention mode is given the deadline, or the temporary flag, that mode calls for.
 *
 * The save keeps a deadline the chat already holds only when it is handed the stored
 * `isTemporary` and `expiredAt`. When the access check skipped its read, the handler loads them
 * under a mode that stamps deadlines, rather than let a repeated request open a new window.
 */
export function createArchiveHandler(
  deps: ArchiveDependencies,
): (req: ArchiveRequest, res: Response) => Promise<Response> {
  return async function archiveHandler(req, res) {
    const { conversationId, isArchived } = req.body?.arg ?? {};

    if (typeof conversationId !== 'string' || conversationId === '') {
      return res.status(400).json({ error: 'conversationId is required' });
    }

    if (typeof isArchived !== 'boolean') {
      return res.status(400).json({ error: 'isArchived must be a boolean' });
    }

    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ error: 'unauthorized' });
    }

    try {
      const interfaceConfig = req.config?.interfaceConfig;
      const stored =
        req.resolvedConversation === undefined && isAllDataRetention(interfaceConfig?.retentionMode)
          ? await deps.getConvoRetention(userId, conversationId)
          : req.resolvedConversation;

      const saved = await deps.saveConvo(
        {
          userId,
          isTemporary: stored?.isTemporary,
          expiredAt: stored?.expiredAt ?? undefined,
          interfaceConfig,
        },
        { conversationId, isArchived },
        {
          context: `POST /api/convos/archive ${conversationId}`,
          /** Filing a chat away is not activity: `updatedAt` stays the chat's own last
           * activity so unarchiving restores it to its real place in the date groups.
           * When it was archived is recorded separately, on `archivedAt`. */
          preserveUpdatedAt: true,
          /** Without timestamps, an upsert would insert a conversation that has none. */
          noUpsert: true,
          /** Metadata-only: skip rebuilding `messages` so a concurrent append is not erased. */
          appendMessageIds: [],
        },
      );

      if (!saved) {
        return res.status(404).json({ error: 'Conversation not found' });
      }
      if ('message' in saved) {
        throw new Error('Conversation archive persistence failed');
      }

      return res.status(200).json(saved);
    } catch (error) {
      logger.error('[archive] Conversation archive failed', getSafeErrorMetadata(error));
      return res.status(500).send('Error archiving conversation');
    }
  };
}
