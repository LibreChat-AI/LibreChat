import { CONVERSATION_TITLE_OWNERSHIP_VERSION } from 'librechat-data-provider';
import type { AppConfig, ConversationMethods } from '@librechat/data-schemas';
import type { TStartupConfig } from 'librechat-data-provider';
import type { Response } from 'express';
import { extractConversationTitleContent } from '~/protection/adapters/submissions';
import { contentFilterBlockResponse } from '~/middleware/contentFilter';
import { inspectContent } from '~/protection/runtime';
import { getSafeErrorMetadata } from '~/utils/errors';

export function getConversationTitleCapabilities(
  config?: AppConfig['interfaceConfig'],
): Pick<TStartupConfig, 'conversationTitleOwnershipVersion'> {
  return config?.runningChatRename === true
    ? { conversationTitleOwnershipVersion: CONVERSATION_TITLE_OWNERSHIP_VERSION }
    : {};
}

type RenameRequest = {
  body?: { arg?: { conversationId?: unknown; title?: unknown } };
  user?: { id: string; tenantId?: string };
  config?: Pick<AppConfig, 'filters' | 'interfaceConfig'>;
  resolvedConversation?: {
    title?: string;
    titleSetByUser?: boolean;
    isTemporary?: boolean;
    expiredAt?: Date;
  } | null;
};

type RenameDependencies = Pick<ConversationMethods, 'saveConvo' | 'getConvo'> & {
  getActiveRunIds: (
    user: string,
    conversations: readonly string[],
    tenantId?: string,
  ) => Promise<string[]>;
  logger: { error: (message: string, metadata: ReturnType<typeof getSafeErrorMetadata>) => void };
};

/** Explicit saves claim title ownership, even when the text has not changed. */
export function createRenameConversationHandler(
  deps: RenameDependencies,
): (req: RenameRequest, res: Response) => Promise<Response> {
  return async (req, res) => {
    const { conversationId, title } = req.body?.arg ?? {};
    if (typeof conversationId !== 'string' || !conversationId) {
      return res.status(400).json({ error: 'conversationId is required' });
    }
    if (title === undefined) return res.status(400).json({ error: 'title is required' });
    if (typeof title !== 'string') return res.status(400).json({ error: 'title must be a string' });
    if (!req.user?.id) return res.status(401).json({ error: 'unauthorized' });

    try {
      const current =
        req.resolvedConversation === undefined
          ? await deps.getConvo(req.user.id, conversationId)
          : req.resolvedConversation;
      if (current == null) return res.status(404).json({ error: 'conversation_not_found' });
      if (req.config?.interfaceConfig?.runningChatRename !== true) {
        // A final-timing title can still be pending after the stream becomes terminal.
        if (
          (!current.titleSetByUser &&
            (current.title == null || current.title === '' || current.title === 'New Chat')) ||
          (await deps.getActiveRunIds(req.user.id, [conversationId], req.user.tenantId)).length > 0
        ) {
          return res.status(409).json({ error: 'conversation_title_ownership_not_ready' });
        }
      }
      const sanitizedTitle = title.trim().slice(0, 1024);
      if (req.config?.filters != null) {
        const finding = inspectContent(extractConversationTitleContent({ title: sanitizedTitle }), {
          filters: req.config.filters,
        });
        if (finding) return res.status(400).json(contentFilterBlockResponse(finding));
      }
      const saved = await deps.saveConvo(
        {
          userId: req.user.id,
          isTemporary: current.isTemporary,
          expiredAt: current.expiredAt,
          interfaceConfig: req.config?.interfaceConfig,
        },
        { conversationId, title: sanitizedTitle },
        {
          context: 'POST /api/convos/update',
          titleSource: 'manual',
          appendMessageIds: [],
          noUpsert: true,
        },
      );
      if (saved == null) return res.status(404).json({ error: 'conversation_not_found' });
      if ('message' in saved) throw new Error('Conversation rename persistence failed');
      return res.status(201).json(saved);
    } catch (error) {
      deps.logger.error('[rename] Conversation title update failed', getSafeErrorMetadata(error));
      return res.status(500).send('Error updating conversation');
    }
  };
}
