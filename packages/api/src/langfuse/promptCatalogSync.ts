import type { LangfusePromptListItem, LangfusePromptListResult } from './prompts';
import type { DistributedLock } from '~/cache/lock';
import { makeSourceAuthorId } from '~/utils/author';

const LANGFUSE_SYNC_AUTHOR_NAME = 'Langfuse Sync';
const PAGE_LIMIT = 100;
const MAX_PAGES = 50;

export type PromptCatalogSyncSource = {
  destination: string;
  projectId: string;
  tenantId?: string;
};

export type PromptCatalogSyncCounts = {
  created: number;
  unchanged: number;
  skipped: number;
};

export type PromptCatalogSyncResult =
  | { ok: true; value: PromptCatalogSyncCounts }
  | { ok: false; error: { code: 'already_running' | 'lock_lost' } };

/** The identity a synced group is found or created by. */
export type PromptGroupSourceIdentity = {
  sourceDestination: string;
  sourceProjectId: string;
  sourcePromptName: string;
};

export type PromptCatalogSyncCreateInput = PromptGroupSourceIdentity & {
  name: string;
  author: string;
  authorName: string;
};

export type PromptCatalogSyncDeps = {
  listPrompts: (query: {
    type: 'text';
    limit: number;
    page: number;
  }) => Promise<LangfusePromptListResult>;
  findPromptGroup: (identity: PromptGroupSourceIdentity) => Promise<{ _id: string } | null>;
  createPromptGroup: (input: PromptCatalogSyncCreateInput) => Promise<{ _id: string }>;
  isDuplicateKeyError: (error: unknown) => boolean;
  isValidationError: (error: unknown) => boolean;
  grantPublicViewer: (groupId: string) => Promise<void>;
  deletePromptGroup: (groupId: string) => Promise<void>;
  lock: DistributedLock;
  lockLeaseMs: number;
  logger: {
    warn: (message: string, ...args: unknown[]) => void;
    error: (message: string, ...args: unknown[]) => void;
  };
  pageLimit?: number;
  maxPages?: number;
};

/** Finds-or-creates one Langfuse text prompt as a pointer-only group, granting
 *  a PUBLIC viewer entry only when it was just created. A match is left as is:
 *  no ACL write and no update statement run against an existing group. */
async function syncOne(
  item: LangfusePromptListItem,
  identity: PromptGroupSourceIdentity,
  author: string,
  deps: PromptCatalogSyncDeps,
): Promise<'created' | 'unchanged' | 'skipped'> {
  const existing = await deps.findPromptGroup(identity);
  if (existing) {
    return 'unchanged';
  }

  let created: { _id: string };
  try {
    created = await deps.createPromptGroup({
      ...identity,
      name: item.name,
      author,
      authorName: LANGFUSE_SYNC_AUTHOR_NAME,
    });
  } catch (error) {
    if (deps.isDuplicateKeyError(error)) {
      return 'unchanged';
    }
    if (deps.isValidationError(error)) {
      deps.logger.warn(
        '[langfuse] Could not save a synced prompt group that failed validation:',
        item.name,
        error,
      );
      return 'skipped';
    }
    throw error;
  }

  try {
    await deps.grantPublicViewer(created._id);
  } catch (error) {
    deps.logger.error('[langfuse] Could not grant public access to a synced prompt group:', error);
    try {
      await deps.deletePromptGroup(created._id);
    } catch (deleteError) {
      deps.logger.error(
        '[langfuse] Could not roll back an ungranted synced prompt group:',
        deleteError,
      );
    }
    throw error;
  }

  return 'created';
}

/**
 * Syncs every Langfuse text prompt in `source`'s project into the local
 * prompt catalog as a read-only, pointer-only group: name and source identity
 * only, never content. A synced group is never modified once inserted;
 * `unchanged` covers both an existing match and a duplicate-key race lost to
 * a concurrent insert (defense in depth behind the per-tenant lock, which
 * already serializes syncs for one source). A chat prompt that slips past the
 * server-side `type: 'text'` filter is warned and counted `skipped`, never
 * saved.
 *
 * Runs under a per-tenant lock (`prompt-sync:langfuse:<tenantId ?? ''>`) so
 * two concurrent syncs for the same source cannot race: a lock already held
 * returns `already_running` without listing a single prompt. The lock is
 * extended only when another page will actually be fetched — the current
 * page is not the last one (`page < totalPages`) and the page cap has not
 * been reached (`page < maxPages`) — so a fully processed sync, and a run
 * that ends because it hit the page cap, never fails on a spurious lock loss
 * it no longer needs the lock for. A lost lock stops the loop with `lock_lost`
 * before saving further pages — pages already saved stay, so a re-run
 * completes the sync. The lock is released on every exit path, including
 * when the upstream client throws.
 */
export async function syncLangfusePromptCatalog(
  source: PromptCatalogSyncSource,
  deps: PromptCatalogSyncDeps,
): Promise<PromptCatalogSyncResult> {
  const lockKey = `prompt-sync:langfuse:${source.tenantId ?? ''}`;
  const token = await deps.lock.acquire(lockKey, deps.lockLeaseMs);
  if (token == null) {
    return { ok: false, error: { code: 'already_running' } };
  }

  try {
    const author = makeSourceAuthorId('langfuse', source.projectId, source.tenantId);
    const counts: PromptCatalogSyncCounts = { created: 0, unchanged: 0, skipped: 0 };
    const seen = new Set<string>();
    const pageLimit = deps.pageLimit ?? PAGE_LIMIT;
    const maxPages = deps.maxPages ?? MAX_PAGES;
    let brokeEarly = false;
    let lastTotalPages = 0;

    for (let page = 1; page <= maxPages; page++) {
      const result = await deps.listPrompts({ type: 'text', limit: pageLimit, page });
      lastTotalPages = result.meta.totalPages;

      for (const item of result.items) {
        if (item.type !== 'text') {
          deps.logger.warn(
            `[langfuse] Skipped a non-text prompt "${item.name}" past the server-side filter`,
          );
          counts.skipped += 1;
          continue;
        }
        if (seen.has(item.name)) {
          continue;
        }
        seen.add(item.name);

        const identity: PromptGroupSourceIdentity = {
          sourceDestination: source.destination,
          sourceProjectId: source.projectId,
          sourcePromptName: item.name,
        };
        const outcome = await syncOne(item, identity, author, deps);
        counts[outcome] += 1;
      }

      if (result.items.length === 0 || page >= result.meta.totalPages) {
        brokeEarly = true;
        break;
      }

      if (page < maxPages) {
        const extended = await deps.lock.extend(lockKey, token, deps.lockLeaseMs);
        if (!extended) {
          return { ok: false, error: { code: 'lock_lost' } };
        }
      }
    }

    if (!brokeEarly && lastTotalPages > maxPages) {
      deps.logger.warn('[langfuse] Langfuse prompt sync stopped at the page cap', {
        maxPages,
        totalPages: lastTotalPages,
      });
    }

    return { ok: true, value: counts };
  } finally {
    try {
      await deps.lock.release(lockKey, token);
    } catch (error) {
      deps.logger.warn(
        '[langfuse] Could not release the prompt sync lock; the lease will expire',
        error,
      );
    }
  }
}
