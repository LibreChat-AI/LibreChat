import { setTimeout as delay } from 'node:timers/promises';
import type { ConversationMethods } from '@librechat/data-schemas';
import type { Response } from 'express';
import type { ConversationWriteContext } from './save';
import { getSafeErrorMetadata } from '~/utils/errors';

type TitleCache = {
  get: (key: string) => Promise<string | undefined>;
  set: (key: string, title: string, ttl: number) => Promise<boolean>;
  delete: (key: string) => Promise<boolean>;
};

type TitlePublication = {
  ctx: ConversationWriteContext;
  conversationId: string;
  title: string;
  convoReady?: Promise<void>;
  signal?: AbortSignal;
  discardSignal?: AbortSignal;
  onTitleGenerated?: (event: { conversationId: string; title: string }) => Promise<void> | void;
};

/** Explicit renames own persisted titles; an unsaved first turn can still publish eagerly. */
export async function publishConversationTitle(
  {
    saveConvo,
    getConvo,
    titleCache,
  }: Pick<ConversationMethods, 'saveConvo' | 'getConvo'> & {
    titleCache: TitleCache;
  },
  {
    ctx,
    conversationId,
    title,
    convoReady,
    signal,
    discardSignal,
    onTitleGenerated,
  }: TitlePublication,
): Promise<void> {
  if (discardSignal?.aborted) {
    return;
  }
  const key = `${ctx.userId}-${conversationId}`;
  const commit = async () => {
    const saved = await saveConvo(
      ctx,
      { conversationId, title },
      {
        context: 'publishConversationTitle',
        titleSource: 'generated',
        noUpsert: true,
        preserveUpdatedAt: true,
        appendMessageIds: [],
      },
    );
    if (saved != null && 'message' in saved) {
      throw new Error('Conversation title persistence failed');
    }
    return saved;
  };
  let publishedEarly = false;
  if (convoReady != null) {
    const initial = await getConvo(ctx.userId, conversationId);
    if (
      !discardSignal?.aborted &&
      (initial == null ||
        (!initial.titleSetByUser &&
          (initial.title == null || initial.title === '' || initial.title === 'New Chat')))
    ) {
      await titleCache.set(key, title, 120000);
      if (!signal?.aborted) {
        await onTitleGenerated?.({ conversationId, title });
      }
      publishedEarly = true;
    }
    await convoReady;
  }
  if (discardSignal?.aborted) {
    if (publishedEarly && (await titleCache.get(key)) === title) {
      await titleCache.delete(key);
    }
    return;
  }
  let saved = await commit();
  let current = saved ?? (await getConvo(ctx.userId, conversationId));
  if (
    saved == null &&
    convoReady != null &&
    current != null &&
    !current.titleSetByUser &&
    (current.title == null || current.title === '' || current.title === 'New Chat') &&
    !discardSignal?.aborted
  ) {
    saved = await commit();
    current = saved ?? (await getConvo(ctx.userId, conversationId));
  }
  if (current?.title == null || discardSignal?.aborted) {
    return;
  }
  if (!publishedEarly || current.title !== title) {
    await titleCache.set(key, current.title, 120000);
  }
  if (saved && !publishedEarly && !signal?.aborted) {
    await onTitleGenerated?.({ conversationId, title: current.title });
  }
}

/** Detached fallback publication owns its failure after the response has ended. */
export async function publishFallbackConversationTitle(
  deps: Parameters<typeof publishConversationTitle>[0] & {
    logger: { error: (message: string, metadata: ReturnType<typeof getSafeErrorMetadata>) => void };
  },
  publication: TitlePublication,
): Promise<void> {
  try {
    await publishConversationTitle(deps, publication);
  } catch (error) {
    deps.logger.error('[addTitle] Fallback publication failed', getSafeErrorMetadata(error));
  }
}

type GeneratedTitleRequest = { params: { conversationId: string }; user?: { id: string } };

type GeneratedTitleDependencies = Pick<ConversationMethods, 'getConvoTitleState'> & {
  getCache: () => TitleCache;
  logger: { error: (message: string, metadata: ReturnType<typeof getSafeErrorMetadata>) => void };
  delay?: (milliseconds: number) => Promise<void>;
};

/** Keep the shared cache string-compatible with legacy replicas; project authority at read time. */
export function createGeneratedTitleHandler(
  deps: GeneratedTitleDependencies,
): (req: GeneratedTitleRequest, res: Response) => Promise<Response> {
  return async function generatedTitleHandler(req, res) {
    const { conversationId } = req.params;
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'unauthorized' });
    try {
      const cache = deps.getCache();
      const key = `${userId}-${conversationId}`;
      let title = await cache.get(key);
      if (title == null) {
        for (const milliseconds of [500, 1000, 2000, 4000, 8000]) {
          await (deps.delay ?? delay)(milliseconds);
          title = await cache.get(key);
          if (title != null) break;
        }
      }
      if (title == null)
        return res.status(404).json({
          message: "Title not found or method not implemented for the conversation's endpoint",
        });
      const current = await deps.getConvoTitleState(userId, conversationId);
      const result =
        current?.titleSetByUser && current.title != null
          ? { title: current.title, titleSetByUser: true, titleRevision: current.titleRevision }
          : { title };
      await cache.delete(key);
      return res.status(200).json(result);
    } catch (error) {
      deps.logger.error('[gen_title] Title lookup failed', getSafeErrorMetadata(error));
      return res.status(500).json({ error: 'title_read_failed' });
    }
  };
}
