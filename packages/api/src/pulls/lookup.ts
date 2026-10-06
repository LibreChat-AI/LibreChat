import { createHash } from 'node:crypto';
import { logger } from '@librechat/data-schemas';
import type { PullRequestLookup, PullRequestLookupResult, PullRequestSource } from './types';
import { PullRequestSourceError } from './types';
import { getSafeErrorMetadata } from '~/utils';

/** A failed lookup is remembered briefly so a failing upstream is not hammered by every poll. */
const FAILURE_TTL_MS = 10_000;
/** Used when GitHub rate limits a credential without saying when to come back. */
const MIN_COOLDOWN_MS = 10_000;
/** GitHub's primary limit resets within the hour; a larger hint is malformed and is capped. */
const MAX_COOLDOWN_MS = 60 * 60_000;
const DEFAULT_MAX_ENTRIES = 500;
/** Credentials with a cache partition at once unless configured; the least recently used goes. */
const DEFAULT_MAX_PARTITIONS = 256;

type Entry = { result: PullRequestLookupResult; expiresAt: number };

/** Keys carry a digest, never the token, so no credential is held in a map key or a heap dump. */
const scopeOf = (token: string): string =>
  createHash('sha256').update(token).digest('hex').slice(0, 32);

/**
 * Caches lookups per credential, repository, branch, recorded commit and lookup policy, and shares
 * one in-flight request between concurrent callers with all of those in common. Each credential
 * has its own bounded partition, sized by the capacity its callers ask for. What a token can see is part of the answer (a
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
  /** One bounded partition per credential, so a capacity setting only ever evicts entries
   *  fetched with its own credential. */
  const partitions = new Map<string, Map<string, Entry>>();
  const inflight = new Map<string, Promise<PullRequestLookupResult>>();
  const cooldowns = new Map<string, number>();
  const rateLimited: PullRequestLookupResult = { ok: false, error: { code: 'RATE_LIMITED' } };

  /**
   * The credential bound is one deployment-wide number. Callers may carry different configured
   * values (per-principal config), and one asking for a small bound must not evict the credentials
   * of another, so the largest value asked for so far applies.
   */
  let credentialBound = 0;

  /** Recency of use orders the partitions, so the one idle longest is the one dropped. */
  function touch(scope: string): Map<string, Entry> | undefined {
    const partition = partitions.get(scope);
    if (partition == null) return undefined;
    partitions.delete(scope);
    partitions.set(scope, partition);
    return partition;
  }

  function partitionOf(scope: string, credentials: number): Map<string, Entry> {
    credentialBound = Math.max(credentialBound, credentials);
    const partition = touch(scope) ?? new Map<string, Entry>();
    partitions.set(scope, partition);
    while (partitions.size > credentialBound) {
      const idle = partitions.keys().next();
      if (idle.done) break;
      partitions.delete(idle.value);
    }
    return partition;
  }

  function remember(
    scope: string,
    key: string,
    result: PullRequestLookupResult,
    ttlMs: number,
    capacity: number,
    credentials: number,
  ): void {
    const lifetime = result.ok ? ttlMs : Math.min(ttlMs, FAILURE_TTL_MS);
    const entries = partitionOf(scope, credentials);
    entries.delete(key);
    entries.set(key, { result, expiresAt: now() + lifetime });
    while (entries.size > capacity) {
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

  return async ({
    repo,
    branch,
    head,
    token,
    ttlMs,
    limits,
    cacheMaxEntries,
    cacheMaxCredentials,
  }) => {
    const scope = scopeOf(token);
    /** Everything that changes the answer or how long it may be reused is part of the key. */
    const policy = [
      ttlMs,
      limits?.requestTimeoutMs,
      limits?.lookupTimeoutMs,
      limits?.maxCheckRunPages,
      limits?.maxCandidatePullRequests,
      limits?.maxHeadComparisons,
    ].join(',');
    const key = `${scope}\0${repo}#${branch}\0${head ?? ''}\0${policy}`;
    const cached = touch(scope)?.get(key);
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
        result = { ok: true, value: await source.find({ repo, branch, head, token, limits }) };
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
      remember(
        scope,
        key,
        result,
        ttlMs,
        cacheMaxEntries ?? maxEntries,
        cacheMaxCredentials ?? DEFAULT_MAX_PARTITIONS,
      );
      return result;
    })().finally(() => inflight.delete(key));
    inflight.set(key, run);
    return run;
  };
}
