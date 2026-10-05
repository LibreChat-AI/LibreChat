import { createHash } from 'node:crypto';
import { logger } from '@librechat/data-schemas';
import type { PullRequestLookup, PullRequestLookupResult, PullRequestSource } from './types';
import { PullRequestSourceError } from './types';
import { getSafeErrorMetadata } from '~/utils';

/** A failed lookup is remembered briefly so a failing upstream is not hammered by every poll. */
const FAILURE_TTL_MS = 10_000;
/** Used when GitHub rate limits a credential without saying when to come back. */
const MIN_COOLDOWN_MS = 10_000;
/** One bad header must not silence the feature for hours. */
const MAX_COOLDOWN_MS = 10 * 60_000;
const DEFAULT_MAX_ENTRIES = 500;

type Entry = { result: PullRequestLookupResult; expiresAt: number };

/** Keys carry a digest, never the token, so no credential is held in a map key or a heap dump. */
const scopeOf = (token: string): string =>
  createHash('sha256').update(token).digest('hex').slice(0, 32);

/**
 * Caches lookups per credential, repository and branch, and shares one in-flight request between
 * concurrent callers with the same credential. What a token can see is part of the answer (a
 * private repository is a pull request for one tenant and nothing for another), so the credential
 * scopes both the cache and the in-flight map. A rate limit applies to the credential, not the
 * branch, so it starts a cooldown for every branch under that credential. Callers must have
 * authorized the conversation before asking.
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
  const cooldowns = new Map<string, number>();
  const rateLimited: PullRequestLookupResult = { ok: false, error: { code: 'RATE_LIMITED' } };

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

  function startCooldown(scope: string, retryAfterMs?: number): void {
    const wait = Math.min(MAX_COOLDOWN_MS, Math.max(MIN_COOLDOWN_MS, retryAfterMs ?? 0));
    cooldowns.set(scope, now() + wait);
    for (const [other, until] of cooldowns) {
      if (until <= now()) cooldowns.delete(other);
    }
  }

  return async ({ repo, branch, token, ttlMs }) => {
    const scope = scopeOf(token);
    const key = `${scope}\0${repo}#${branch}`;
    const cached = entries.get(key);
    if (cached != null && cached.expiresAt > now()) return cached.result;
    const pending = inflight.get(key);
    if (pending != null) return pending;
    const until = cooldowns.get(scope);
    if (until != null) {
      if (until > now()) return rateLimited;
      cooldowns.delete(scope);
    }

    const run = (async (): Promise<PullRequestLookupResult> => {
      let result: PullRequestLookupResult;
      try {
        result = { ok: true, value: await source.find({ repo, branch, token }) };
      } catch (error) {
        if (!(error instanceof PullRequestSourceError)) {
          logger.warn('[PullRequests] Lookup failed', getSafeErrorMetadata(error));
        }
        const code = error instanceof PullRequestSourceError ? error.code : 'UPSTREAM_ERROR';
        if (error instanceof PullRequestSourceError && error.code === 'RATE_LIMITED') {
          startCooldown(scope, error.retryAfterMs);
        }
        result = { ok: false, error: { code } };
      }
      remember(key, result, ttlMs);
      return result;
    })().finally(() => inflight.delete(key));
    inflight.set(key, run);
    return run;
  };
}
