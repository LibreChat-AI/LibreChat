import type { ConversationMethods } from '@librechat/data-schemas';
import type { ConversationWriteContext } from './save';

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
  let saved = await commit();
  let current = saved ?? (await getConvo(ctx.userId, conversationId));
  let publishedEarly = false;
  if (current == null && convoReady != null) {
    await titleCache.set(key, title, 120000);
    if (!signal?.aborted) {
      await onTitleGenerated?.({ conversationId, title });
    }
    publishedEarly = true;
    await convoReady;
    if (discardSignal?.aborted) {
      if ((await titleCache.get(key)) === title) {
        await titleCache.delete(key);
      }
      return;
    }
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
