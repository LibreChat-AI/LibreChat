import { randomUUID } from 'node:crypto';
import type { ConversationMethods } from '@librechat/data-schemas';
import type { TitleOwner, TitleResult, TitleSettlement } from './stream';
import type { ConversationWriteContext } from '~/conversations/save';
import { getSafeErrorMetadata } from '~/utils/errors';
import { titleKey } from './stream';

/** How long an attempt may own a conversation's title. A `final` title starts only after the
 *  reply, so this covers a long turn; a process that dies mid-attempt holds it at most this long. */
export const TITLE_ADMISSION_TTL_MS: number = 30 * 60_000;
/** Matches `/gen_title`'s cache entry, which older clients still poll. */
const LEGACY_CACHE_TTL_MS = 120_000;

/** The attempt that currently owns a conversation's title, shared across replicas. */
export type TitleMarker = { attempt: string; expiresAt: number };

export type TitleMarkers = {
  get: (key: string) => Promise<TitleMarker | undefined>;
  set: (key: string, marker: TitleMarker, ttl: number) => Promise<unknown>;
  delete: (key: string) => Promise<unknown>;
};

/** `/gen_title`'s string cache, kept filled for clients that still poll it. */
export type LegacyTitleCache = {
  set: (key: string, title: string, ttl: number) => Promise<unknown>;
};

type Logger = {
  debug: (message: string, metadata?: Record<string, unknown>) => void;
  error: (message: string, metadata: ReturnType<typeof getSafeErrorMetadata>) => void;
};

export type TitleTaskDependencies = Pick<
  ConversationMethods,
  'saveConvo' | 'getConvoTitleState'
> & {
  markers: TitleMarkers;
  cache: LegacyTitleCache;
  stream: { settle: (owner: TitleOwner, settlement: TitleSettlement) => Promise<void> };
  logger: Logger;
};

export type TitleRun = {
  /** Produces the title. Aborted by `stop`, `discard`, cancellation or the deadline. */
  generate: (signal: AbortSignal) => Promise<string | null | undefined>;
  /** Resolves once the conversation row exists; a generated title never creates the row. */
  ready?: Promise<void>;
  timeoutMs: number;
};

export type TitleAttempt = {
  readonly id: string;
  /** Generates, saves, then settles. Never rejects; resolves once the attempt is settled. */
  run: (input: TitleRun) => Promise<void>;
  /** Cancels a generation still in flight. A title that already finished is still saved. */
  stop: () => void;
  /** Cancels the attempt outright: nothing it generates is saved. */
  discard: () => void;
  /** Settles an attempt that never ran. A no-op once `run` has started. */
  release: () => Promise<void>;
};

export type TitleTasks = {
  /** Claims the conversation's title for a new attempt before the browser can ask about it. */
  admit: (owner: TitleOwner & { ctx: ConversationWriteContext }) => Promise<TitleAttempt>;
  /** Ends any attempt for the conversation, on whichever replica runs it. */
  cancel: (owner: TitleOwner) => Promise<void>;
};

const PLACEHOLDERS = new Set(['', 'New Chat']);

/** A manual rename counts whatever it says; a generated or default title must be a real one. */
export const hasTitle = (
  state: { title?: string | null; titleSetByUser?: boolean } | null | undefined,
): boolean =>
  state?.title != null && (state.titleSetByUser === true || !PLACEHOLDERS.has(state.title));

/** Conversation-scoped title attempts that outlive the chat turn that admitted them. */
export function createTitleTasks(deps: TitleTaskDependencies): TitleTasks {
  const local = new Map<string, { id: string; discard: () => void }>();

  const owns = async (key: string, id: string): Promise<boolean> =>
    (await deps.markers.get(key))?.attempt === id;

  /** Announces the end of an attempt unless a newer one owns the conversation by now. */
  const settle = async (owner: TitleOwner, id: string, title?: TitleResult): Promise<void> => {
    const key = titleKey(owner);
    if (local.get(key)?.id === id) local.delete(key);
    const marker = await deps.markers.get(key);
    if (marker != null && marker.attempt !== id) return;
    if (marker != null) await deps.markers.delete(key);
    await deps.stream.settle(owner, { attempt: id, ...(title != null && { title }) });
  };

  /** Saves through the fill-only generated-title filter: a manual rename or an earlier title
   *  wins, and a deleted conversation is never recreated. Returns what the row now holds. */
  const save = async (
    owner: TitleOwner,
    ctx: ConversationWriteContext,
    title: string,
  ): Promise<TitleResult | undefined> => {
    const saved = await deps.saveConvo(
      ctx,
      { conversationId: owner.conversationId, title },
      {
        context: 'titleTask',
        titleSource: 'generated',
        noUpsert: true,
        preserveUpdatedAt: true,
        appendMessageIds: [],
      },
    );
    if (saved != null && 'message' in saved) {
      throw new Error('Conversation title persistence failed');
    }
    const current = saved ?? (await deps.getConvoTitleState(owner.userId, owner.conversationId));
    if (current == null || !hasTitle(current)) return undefined;
    return {
      conversationId: owner.conversationId,
      title: current.title as string,
      ...(current.titleSetByUser === true && { titleSetByUser: true }),
      ...(current.titleRevision != null && { titleRevision: current.titleRevision }),
    };
  };

  const admit: TitleTasks['admit'] = async ({ ctx, ...owner }) => {
    const id = randomUUID();
    const key = titleKey(owner);
    const controller = new AbortController();
    let state: 'admitted' | 'running' | 'settled' = 'admitted';
    let discarded = false;

    local.get(key)?.discard();
    /** Without a shared marker the attempt cannot be fenced or seen by the browser, which then
     *  polls; the fill-only save still keeps renames and deletions safe, so the title still runs. */
    let fenced = false;
    try {
      fenced =
        (await deps.markers.set(
          key,
          { attempt: id, expiresAt: Date.now() + TITLE_ADMISSION_TTL_MS },
          TITLE_ADMISSION_TTL_MS,
        )) !== false;
    } catch (error) {
      deps.logger.error('[titles] Failed to admit title attempt', getSafeErrorMetadata(error));
    }

    const discard = () => {
      discarded = true;
      controller.abort();
    };
    local.set(key, { id, discard });

    const release = async () => {
      if (state !== 'admitted') return;
      state = 'settled';
      try {
        await settle(owner, id);
      } catch (error) {
        deps.logger.error('[titles] Failed to release title attempt', getSafeErrorMetadata(error));
      }
    };

    const run = async ({ generate, ready, timeoutMs }: TitleRun) => {
      if (state !== 'admitted') return;
      state = 'running';
      let result: TitleResult | undefined;
      try {
        const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(timeoutMs)]);
        const title = discarded ? undefined : await generate(signal);
        await ready;
        if (title && !discarded && (!fenced || (await owns(key, id)))) {
          result = await save(owner, ctx, title);
        } else if (title && !discarded) {
          deps.logger.debug('[titles] Title attempt no longer owns the conversation', { id });
        }
        if (result != null) {
          await deps.cache.set(
            `${owner.userId}-${owner.conversationId}`,
            result.title,
            LEGACY_CACHE_TTL_MS,
          );
        }
      } catch (error) {
        result = undefined;
        deps.logger.error('[titles] Title attempt failed', getSafeErrorMetadata(error));
      } finally {
        state = 'settled';
        try {
          await settle(owner, id, result);
        } catch (error) {
          deps.logger.error('[titles] Failed to settle title attempt', getSafeErrorMetadata(error));
        }
      }
    };

    return {
      id,
      run,
      release,
      discard,
      stop: () => controller.abort(),
    };
  };

  const cancel: TitleTasks['cancel'] = async (owner) => {
    const key = titleKey(owner);
    const marker = await deps.markers.get(key);
    local.get(key)?.discard();
    local.delete(key);
    if (marker == null) return;
    await deps.markers.delete(key);
    await deps.stream.settle(owner, {});
  };

  return { admit, cancel };
}
