import { logger } from '@librechat/data-schemas';
import type { PullRequestLookup, PullRequestLookupResult, PullRequestSource } from './types';
import { PullRequestSourceError } from './types';
import { getSafeErrorMetadata } from '~/utils';

/** A failed lookup is remembered briefly so a rate limit is not hammered by every poll. */
const FAILURE_TTL_MS = 10_000;
const DEFAULT_MAX_ENTRIES = 500;

type Entry = { result: PullRequestLookupResult; expiresAt: number };

/**
 * Caches lookups per repository branch and shares one in-flight request between concurrent
 * callers. A pull request is repository data, not user data: callers must have authorized the
 * conversation before asking, and the cache is keyed only by what GitHub is asked about.
 */
export function createPullRequestLookup({
  source,
  now = Date.now,
  maxEntries = DEFAULT_MAX_ENTRIES,
}: {
  source: PullRequestSource;
  now?: () => number;
  maxEntries?: number;
}): PullRequestLookup {
  const entries = new Map<string, Entry>();
  const inflight = new Map<string, Promise<PullRequestLookupResult>>();

  function remember(key: string, result: PullRequestLookupResult, ttlMs: number): void {
    const lifetime = result.ok ? ttlMs : Math.min(ttlMs, FAILURE_TTL_MS);
    entries.delete(key);
    entries.set(key, { result, expiresAt: now() + lifetime });
    while (entries.size > maxEntries) {
      const oldest = entries.keys().next();
      if (oldest.done) break;
      entries.delete(oldest.value);
    }
  }

  return async ({ repo, branch, token, ttlMs }) => {
    const key = `${repo}#${branch}`;
    const cached = entries.get(key);
    if (cached != null && cached.expiresAt > now()) return cached.result;
    const pending = inflight.get(key);
    if (pending != null) return pending;

    const run = (async (): Promise<PullRequestLookupResult> => {
      let result: PullRequestLookupResult;
      try {
        result = { ok: true, value: await source.find({ repo, branch, token }) };
      } catch (error) {
        if (!(error instanceof PullRequestSourceError)) {
          logger.warn('[PullRequests] Lookup failed', getSafeErrorMetadata(error));
        }
        const code = error instanceof PullRequestSourceError ? error.code : 'UPSTREAM_ERROR';
        result = { ok: false, error: { code } };
      }
      remember(key, result, ttlMs);
      return result;
    })().finally(() => inflight.delete(key));
    inflight.set(key, run);
    return run;
  };
}
