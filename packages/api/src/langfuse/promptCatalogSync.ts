import type { TLangfusePromptListResponse } from 'librechat-data-provider';
import type { PromptGroupSourceIdentity } from '~/prompts/types';
import type { PromptService } from '~/prompts/service';
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
  /** False when the page cap stopped the run before every upstream page was read; the counts
   *  above cover only the pages the run actually fetched. */
  complete: boolean;
};

export type PromptCatalogSyncResult =
  | { ok: true; value: PromptCatalogSyncCounts }
  | { ok: false; error: { code: 'already_running' | 'lock_lost' } };

export type PromptCatalogSyncDeps = {
  listPrompts: (query: {
    type: 'text';
    limit: number;
    page: number;
  }) => Promise<TLangfusePromptListResponse>;
  promptService: Pick<PromptService, 'importSourceGroup'>;
  lock: DistributedLock;
  lockLeaseMs: number;
  logger: {
    warn: (message: string, ...args: unknown[]) => void;
    error: (message: string, ...args: unknown[]) => void;
  };
  pageLimit?: number;
  maxPages?: number;
};

/**
 * Syncs every Langfuse text prompt in `source`'s project into the local
 * prompt catalog as a read-only, pointer-only group: name and source identity
 * only, never content. A synced group is never modified once inserted;
 * `unchanged` covers both an existing match and a duplicate-key race lost to
 * a concurrent insert — expected when the lock below is lost mid-page and a
 * second run starts while the first is still saving that page's items. A
 * chat prompt that slips past the server-side `type: 'text'` filter is
 * warned and counted `skipped`, never saved.
 *
 * Runs under a per-tenant lock (`prompt-sync:langfuse:<tenantId ?? ''>`): a
 * lock already held returns `already_running` without listing a single
 * prompt. The lock is extended only when another page will actually be
 * fetched — the current page is not the last one (`page < totalPages`) and
 * the page cap has not been reached (`page < maxPages`) — so a fully
 * processed sync, and a run that ends because it hit the page cap, never
 * fails on a spurious lock loss it no longer needs the lock for. The
 * renewal happens only between pages, never during one: a page whose own
 * processing (listing and saving its items) outlasts the lease can still
 * let the lease expire, so a second run can acquire the lock and start
 * while the first is still partway through that page. The lock reduces
 * overlapping runs; it does not guarantee only one runs at a time. A lost
 * lock stops the loop with `lock_lost` before saving further pages — pages
 * already saved stay, so a re-run completes the sync. The lock is released
 * on every exit path, including when the upstream client throws.
 *
 * The result's `complete` flag is `false` when the page cap (`maxPages`)
 * stopped the run before every upstream page was read; the counts then
 * cover only the pages actually fetched. This sync is append-only and
 * always re-lists from page 1, so a re-run with the same page limit reads
 * the same pages again and makes no further progress. Importing the rest
 * requires raising the `langfuse.promptSync.maxPages` config.
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
    const counts: Omit<PromptCatalogSyncCounts, 'complete'> = {
      created: 0,
      unchanged: 0,
      skipped: 0,
    };
    const seen = new Set<string>();
    const pageLimit = deps.pageLimit ?? PAGE_LIMIT;
    const maxPages = deps.maxPages ?? MAX_PAGES;
    // True once the loop breaks because the upstream pages ran out (an empty page or the
    // last page), as opposed to running out of the page cap first.
    let exhaustedUpstream = false;
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
        const outcome = await deps.promptService.importSourceGroup({
          identity,
          name: item.name,
          author,
          authorName: LANGFUSE_SYNC_AUTHOR_NAME,
        });
        counts[outcome] += 1;
      }

      if (result.items.length === 0 || page >= result.meta.totalPages) {
        exhaustedUpstream = true;
        break;
      }

      if (page < maxPages) {
        const extended = await deps.lock.extend(lockKey, token, deps.lockLeaseMs);
        if (!extended) {
          return { ok: false, error: { code: 'lock_lost' } };
        }
      }
    }

    if (!exhaustedUpstream && lastTotalPages > maxPages) {
      deps.logger.warn('[langfuse] Langfuse prompt sync stopped at the page cap', {
        maxPages,
        totalPages: lastTotalPages,
      });
    }

    return { ok: true, value: { ...counts, complete: exhaustedUpstream } };
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
