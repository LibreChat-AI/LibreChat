import { setTimeout as delay } from 'node:timers/promises';
import type { AppConfig, ConversationMethods } from '@librechat/data-schemas';
import type { Response } from 'express';
import type { ConversationWriteContext } from './save';
import { getOutboundTimeoutMs } from '~/utils/timeouts';
import { getSafeErrorMetadata } from '~/utils/errors';

type TitleCache = {
  get: (key: string) => Promise<string | undefined>;
  set: (key: string, title: string, ttl: number) => Promise<boolean>;
  delete: (key: string) => Promise<boolean>;
};

type GetGenerationEpoch = (conversationId: string) => Promise<number | undefined>;

type TitlePublication = {
  ctx: ConversationWriteContext;
  conversationId: string;
  title: string;
  convoReady?: Promise<void>;
  signal?: AbortSignal;
  discardSignal?: AbortSignal;
  epoch?: number;
  canPublishEarly?: () => boolean;
  onTitleGenerated?: (event: { conversationId: string; title: string }) => Promise<void> | void;
};

/** Explicit renames own persisted titles; an unsaved first turn can still publish eagerly. */
export async function publishConversationTitle(
  {
    saveConvo,
    getConvo,
    titleCache,
    getGenerationEpoch,
  }: Pick<ConversationMethods, 'saveConvo' | 'getConvo'> & {
    titleCache: TitleCache;
    getGenerationEpoch?: GetGenerationEpoch;
  },
  {
    ctx,
    conversationId,
    title,
    convoReady,
    signal,
    discardSignal,
    epoch,
    canPublishEarly,
    onTitleGenerated,
  }: TitlePublication,
): Promise<void> {
  if (discardSignal?.aborted) {
    return;
  }
  const key = `${ctx.userId}-${conversationId}`;
  const isCurrent =
    epoch == null ? undefined : async () => (await getGenerationEpoch?.(conversationId)) === epoch;
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
  if (convoReady != null && canPublishEarly?.() !== false) {
    const initial = await getConvo(ctx.userId, conversationId);
    if (
      (!isCurrent || (await isCurrent())) &&
      canPublishEarly?.() !== false &&
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
  }
  await convoReady;
  if (discardSignal?.aborted) {
    if (publishedEarly && (await titleCache.get(key)) === title) {
      await titleCache.delete(key);
    }
    return;
  }
  if (isCurrent && !(await isCurrent())) return;
  if (discardSignal?.aborted) return;
  let saved = await commit();
  let current = saved ?? (await getConvo(ctx.userId, conversationId));
  if (
    saved == null &&
    convoReady != null &&
    current != null &&
    !current.titleSetByUser &&
    (current.title == null || current.title === '' || current.title === 'New Chat') &&
    (!isCurrent || (await isCurrent())) &&
    !discardSignal?.aborted
  ) {
    saved = await commit();
    current = saved ?? (await getConvo(ctx.userId, conversationId));
  }
  if (current?.title == null || (isCurrent && !(await isCurrent())) || discardSignal?.aborted) {
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

const pendingKey = (key: string, epoch: number) => `pending:${epoch}:${key}`;

/** The SDK invokes a separate title model. Bound its full call, including retries, with the
 * actual signal the title chain receives. A broken integration must not pin chat cleanup. */
export async function runAgentConversationTitle({
  appConfig,
  titleCache,
  key,
  epoch,
  signal,
  discardSignal,
  generate,
  publish,
}: {
  appConfig?: AppConfig;
  titleCache: TitleCache;
  key: string;
  epoch?: number;
  signal?: AbortSignal;
  discardSignal?: AbortSignal;
  generate: (controller: AbortController) => Promise<string | undefined>;
  publish: (title: string) => Promise<void>;
}): Promise<void> {
  const titleTimeout = getOutboundTimeoutMs(appConfig, 'titleMs');
  // Inline approval resume awaits the title before publishing FINAL. Keep its legacy bound.
  const timeout = epoch == null ? Math.min(45_000, titleTimeout) : titleTimeout;
  const controller = new AbortController();
  const sources = [signal, discardSignal].filter((source) => source != null);
  const parent = AbortSignal.any(sources);
  const abort = () => controller.abort(parent.reason);
  const pending = epoch == null ? undefined : pendingKey(key, epoch);
  const deadline = Date.now() + timeout;
  if (parent.aborted) return;
  const timer = setTimeout(
    () => controller.abort(new DOMException('Title request timed out', 'TimeoutError')),
    timeout,
  );
  parent.addEventListener('abort', abort, { once: true });
  try {
    let title: string | undefined;
    // Remove the listener even if a provider never settles after being aborted.
    let onAbort: (() => void) | undefined;
    try {
      const cancelled = new Promise<never>((_, reject) => {
        onAbort = () => reject(controller.signal.reason);
        controller.signal.addEventListener('abort', onAbort, { once: true });
      });
      title = await Promise.race([
        cancelled,
        (async () => {
          if (pending) await titleCache.set(pending, String(deadline), timeout);
          controller.signal.throwIfAborted();
          return generate(controller);
        })(),
      ]);
    } finally {
      clearTimeout(timer);
      parent.removeEventListener('abort', abort);
      if (onAbort) controller.signal.removeEventListener('abort', onAbort);
      controller.abort();
    }
    if (title && !discardSignal?.aborted) await publish(title);
  } finally {
    // Keep the positive pending signal until the result is visible to readers.
    if (pending) await titleCache.delete(pending);
  }
}

type GeneratedTitleRequest = {
  params: { conversationId: string };
  query?: { pending?: unknown };
  user?: { id: string };
};

type GeneratedTitleDependencies = Pick<ConversationMethods, 'getConvoTitleState'> & {
  getCache: () => TitleCache;
  getGenerationEpoch?: GetGenerationEpoch;
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
      const supportsPending = req.query?.pending === '1';
      const notReady = (pending = false) =>
        res.status(404).json({
          message: "Title not found or method not implemented for the conversation's endpoint",
          ...(pending && { code: 'title_pending' }),
        });
      let title = await cache.get(key);
      if (title == null) {
        const disconnected = new AbortController();
        const close = () => disconnected.abort();
        res.once('close', close);
        try {
          for (const milliseconds of [0, 500, 1000, 2000, 4000, 8000]) {
            if (milliseconds > 0) {
              await (deps.delay?.(milliseconds) ??
                delay(milliseconds, undefined, {
                  signal: disconnected.signal,
                }));
              if (disconnected.signal.aborted) return res;
              title = await cache.get(key);
              if (title != null) break;
            }
            if (!supportsPending || milliseconds > 500) continue;
            const epoch = await deps.getGenerationEpoch?.(conversationId);
            if (epoch == null) continue;
            const deadline = await cache.get(pendingKey(key, epoch));
            if (deadline != null && Number(deadline) > Date.now()) return notReady(true);
          }
        } catch (error) {
          if (disconnected.signal.aborted) return res;
          throw error;
        } finally {
          res.off('close', close);
        }
      }
      if (title == null) return notReady();
      const current = await deps.getConvoTitleState(userId, conversationId);
      const result =
        current?.titleSetByUser && current.title != null
          ? { title: current.title, titleSetByUser: true, titleRevision: current.titleRevision }
          : { title };
      if (!supportsPending) await cache.delete(key);
      return res.status(200).json(result);
    } catch (error) {
      deps.logger.error('[gen_title] Title lookup failed', getSafeErrorMetadata(error));
      return res.status(500).json({ error: 'title_read_failed' });
    }
  };
}
