import { createHash } from 'node:crypto';
import { logger } from '@librechat/data-schemas';
import {
  PULL_REQUEST_CHECKS,
  PULL_REQUEST_STATES,
  PULL_REQUEST_MERGEABLE,
  PULL_REQUEST_PROVIDERS,
} from 'librechat-data-provider';
import type { TConversationPullRequest } from 'librechat-data-provider';
import type {
  PullRequestSource,
  PullRequestSharedValue,
  PullRequestLookup,
  PullRequestLookupStore,
  PullRequestLookupResult,
} from './types';
import { logDiscoveryDiagnostic } from './diagnostics';
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
/** A shared store call slower than this is abandoned; Redis answers in single milliseconds. */
const DEFAULT_SHARED_TIMEOUT_MS = 250;
/** Shared store slots for results, and again for cooldowns, unless the deployment sets its own. */
const DEFAULT_SHARED_SLOTS = 65_536;
/** Versioned, so a change to the stored shape is a miss for replicas still on the old one. */
const STORE_PREFIX = 'pr:v2:';

type Entry = { result: PullRequestLookupResult; expiresAt: number };
/**
 * What the shared store holds. `key` is the digest of the full key, since a slot is shared by every
 * key that maps to it, and `order` is when the value runs out: the store keeps the later of two
 * values for one key. Only a found answer is shared, never a failure: an upstream error can be this
 * replica's own network or proxy, and another replica may well reach the provider.
 */
type Stored = PullRequestSharedValue & { value: TConversationPullRequest | null };

/** Keys carry a digest, never the token, so no credential is held in a map key or a heap dump. */
const scopeOf = (token: string): string =>
  createHash('sha256').update(token).digest('hex').slice(0, 32);

const digestOf = (key: string): string => createHash('sha256').update(key).digest('hex');

/**
 * The shared store is a fixed number of slots, so it holds no more than its slot count however
 * many repositories and branches are looked up: an answer goes in the slot its key's digest picks,
 * replacing whatever was there, and a read whose slot holds another key is a miss. The count is
 * deployment-wide (read from the YAML only), so every caller addresses the same slot for a key.
 */
const slotOf = (kind: 'result' | 'cooldown', digest: string, slots: number): string =>
  `${STORE_PREFIX}${kind}:${Number.parseInt(digest.slice(0, 12), 16) % slots}`;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isOneOf = <T extends string>(options: readonly T[], value: unknown): value is T =>
  typeof value === 'string' && (options as readonly string[]).includes(value);

const isTime = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

/** Another replica, or another version of one, wrote this; anything not shaped right is a miss. */
function isStored(value: unknown, key: string): value is Stored {
  if (!isRecord(value) || value.key !== key || !isTime(value.order)) return false;
  const pr = value.value;
  if (pr === null) return true;
  return (
    isRecord(pr) &&
    Number.isInteger(pr.number) &&
    typeof pr.title === 'string' &&
    typeof pr.url === 'string' &&
    /** The page becomes a link in the card, so only https ever comes back out of the store. */
    pr.url.startsWith('https://') &&
    (pr.provider === undefined || isOneOf(PULL_REQUEST_PROVIDERS, pr.provider)) &&
    isTime(pr.additions) &&
    isTime(pr.deletions) &&
    typeof pr.isDraft === 'boolean' &&
    isOneOf(PULL_REQUEST_STATES, pr.state) &&
    isOneOf(PULL_REQUEST_MERGEABLE, pr.mergeable) &&
    isOneOf(PULL_REQUEST_CHECKS, pr.checks)
  );
}

/** A provider's rate limit on a credential, which holds for every replica until `order`. */
const isCooldown = (value: unknown, key: string): value is PullRequestSharedValue =>
  isRecord(value) && value.key === key && isTime(value.order);

/**
 * Runs one shared store call, bounded by `timeoutMs`. The store is an optimization, so a failure
 * or a slow answer is logged and reads as `undefined`, and the lookup carries on in memory. The
 * store gets the same deadline and drops its own command at it; the race covers one that does not.
 */
async function bounded<T>(call: () => Promise<T>, timeoutMs: number): Promise<T | undefined> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => {
      logger.debug('[PullRequests] Shared cache timed out', { timeoutMs });
      resolve(undefined);
    }, timeoutMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([call(), timeout]);
  } catch (error) {
    logger.debug('[PullRequests] Shared cache unavailable', getSafeErrorMetadata(error));
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Caches lookups per credential, repository, branch, recorded commit and lookup policy, and shares
 * one in-flight request between concurrent callers with all of those in common. Each credential
 * has its own bounded partition, sized by the capacity its callers ask for. What a token can see is part of the answer (a
 * private repository is a pull request for one tenant and nothing for another), so the credential
 * scopes both the cache and the in-flight map. A rate limit applies to the credential, not the
 * branch, so it starts a cooldown for every branch under that credential. Callers must have
 * authorized the conversation before asking.
 *
 * With a `store` and `sharedCache` on the input, results and cooldowns are also written to the
 * store and read from it on a local miss, so replicas share them. In-flight coalescing stays per
 * process, and the in-memory cache stays in front of the store.
 */
export function createPullRequestLookup({
  source,
  store,
  now = Date.now,
  maxEntries = DEFAULT_MAX_ENTRIES,
}: {
  source: PullRequestSource;
  store?: PullRequestLookupStore;
  now?: () => number;
  maxEntries?: number;
}): PullRequestLookup {
  /** One bounded partition per credential, so a capacity setting only ever evicts entries
   *  fetched with its own credential. */
  const partitions = new Map<string, Map<string, Entry>>();
  /** The largest capacity any caller asked for per credential. Principals can share a token yet
   *  carry different configured sizes, and the smaller must not trim what the larger keeps. */
  const capacities = new Map<string, number>();
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
      capacities.delete(idle.value);
    }
    return partition;
  }

  function remember(
    scope: string,
    key: string,
    entry: Entry,
    capacity: number,
    credentials: number,
  ): void {
    const entries = partitionOf(scope, credentials);
    const bound = Math.max(capacities.get(scope) ?? 0, capacity);
    capacities.set(scope, bound);
    entries.delete(key);
    entries.set(key, entry);
    while (entries.size > bound) {
      const oldest = entries.keys().next();
      if (oldest.done) break;
      entries.delete(oldest.value);
    }
  }

  /** A cooldown only ever extends: a shorter hint arriving later never ends a longer one early. */
  function startCooldown(scope: string, until: number): void {
    cooldowns.set(scope, Math.max(cooldowns.get(scope) ?? 0, until));
    for (const [other, end] of cooldowns) {
      if (end <= now()) cooldowns.delete(other);
    }
  }

  /** Writes in the background: the answer is already known, so the caller never waits on it. */
  function share(
    target: PullRequestLookupStore,
    key: string,
    value: PullRequestSharedValue,
    ttlMs: number,
    timeoutMs: number,
  ): void {
    if (ttlMs <= 0) return;
    void bounded(() => target.put(key, value, ttlMs, timeoutMs), timeoutMs);
  }

  return async ({
    repo,
    branch,
    head,
    pullRequest,
    provider,
    host,
    token,
    ttlMs,
    limits,
    allowedRepositories,
    cacheMaxEntries,
    cacheMaxCredentials,
    sharedCache,
    sharedCacheTimeoutMs = DEFAULT_SHARED_TIMEOUT_MS,
    sharedCacheSlots = DEFAULT_SHARED_SLOTS,
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
      limits?.maxCandidatePages,
      /** Which fork a pull request's checks may be read from depends on this list. */
      [...(allowedRepositories ?? [])]
        .map((entry) => entry.toLowerCase())
        .sort()
        .join('|'),
    ].join(',');
    const key = `${scope}\0${provider ?? ''}\0${host ?? ''}\0${repo}#${branch}\0${head ?? ''}\0${pullRequest ?? ''}\0${policy}`;
    const cached = touch(scope)?.get(key);
    if (cached != null && cached.expiresAt > now()) return cached.result;
    /** Only when this caller's settings ask for it; the store is there whenever Redis is. */
    const shared = sharedCache === true ? store : undefined;
    /** A caller joins only work run under its own sharing policy, so its toggle and deadline hold. */
    const flight = shared != null ? `${key}\0shared\0${sharedCacheTimeoutMs}` : key;
    const pending = inflight.get(flight);
    if (pending != null) return pending;
    /** A rate limit belongs to the credential on one provider host; elsewhere it is not limited. */
    const limitScope = `${scope}\0${provider ?? ''}\0${host ?? ''}`;
    let cooling = false;
    const until = cooldowns.get(limitScope);
    if (until != null) {
      if (until > now()) cooling = true;
      else cooldowns.delete(limitScope);
    }
    /** Another replica may already hold the answer, so only a lookup without the store stops here. */
    if (cooling && shared == null) return rateLimited;
    const lifetimeOf = (result: PullRequestLookupResult): number =>
      result.ok ? ttlMs : Math.min(ttlMs, FAILURE_TTL_MS);
    const capacity = cacheMaxEntries ?? maxEntries;
    const credentials = cacheMaxCredentials ?? DEFAULT_MAX_PARTITIONS;
    const resultDigest = digestOf(key);
    const cooldownDigest = digestOf(limitScope);
    const storeKey = slotOf('result', resultDigest, sharedCacheSlots);
    const cooldownKey = slotOf('cooldown', cooldownDigest, sharedCacheSlots);

    const run = (async (): Promise<PullRequestLookupResult> => {
      if (shared != null) {
        const [stored, cooldown] = await Promise.all([
          bounded(() => shared.get(storeKey, sharedCacheTimeoutMs), sharedCacheTimeoutMs),
          bounded(() => shared.get(cooldownKey, sharedCacheTimeoutMs), sharedCacheTimeoutMs),
        ]);
        if (isStored(stored, resultDigest) && stored.order > now()) {
          const result: PullRequestLookupResult = { ok: true, value: stored.value };
          /** Never kept longer than this replica would have kept its own answer. */
          const expiresAt = Math.min(stored.order, now() + ttlMs);
          remember(scope, key, { result, expiresAt }, capacity, credentials);
          return result;
        }
        if (cooling) return rateLimited;
        if (isCooldown(cooldown, cooldownDigest) && cooldown.order > now()) {
          startCooldown(limitScope, Math.min(cooldown.order, now() + MAX_COOLDOWN_MS));
          return rateLimited;
        }
      }
      let result: PullRequestLookupResult;
      try {
        result = {
          ok: true,
          value: await source.find({
            repo,
            branch,
            head,
            pullRequest,
            ...(provider != null ? { provider } : {}),
            ...(host != null ? { host } : {}),
            token,
            limits,
            allowedRepositories,
          }),
        };
      } catch (error) {
        if (!(error instanceof PullRequestSourceError)) {
          logger.warn('[PullRequests] Lookup failed', getSafeErrorMetadata(error));
        }
        const code = error instanceof PullRequestSourceError ? error.code : 'UPSTREAM_ERROR';
        logDiscoveryDiagnostic(provider ?? 'github', code);
        if (error instanceof PullRequestSourceError && error.code === 'RATE_LIMITED') {
          const wait = Math.min(
            MAX_COOLDOWN_MS,
            Math.max(MIN_COOLDOWN_MS, error.retryAfterMs ?? 0),
          );
          const end = now() + wait;
          startCooldown(limitScope, end);
          if (shared != null) {
            share(
              shared,
              cooldownKey,
              { key: cooldownDigest, order: end },
              wait,
              sharedCacheTimeoutMs,
            );
          }
        }
        result = { ok: false, error: { code } };
      }
      const lifetime = lifetimeOf(result);
      const entry: Entry = { result, expiresAt: now() + lifetime };
      remember(scope, key, entry, capacity, credentials);
      if (shared != null && result.ok) {
        const stored: Stored = { key: resultDigest, order: entry.expiresAt, value: result.value };
        share(shared, storeKey, stored, lifetime, sharedCacheTimeoutMs);
      }
      return result;
    })().finally(() => inflight.delete(flight));
    inflight.set(flight, run);
    return run;
  };
}
