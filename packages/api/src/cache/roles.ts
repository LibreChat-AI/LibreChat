import { randomUUID } from 'crypto';
import { logger } from '@librechat/data-schemas';
import { CacheKeys, roleCacheConfigSchema } from 'librechat-data-provider';
import type {
  CacheStore,
  RoleChangeCursor,
  RoleChangeSource,
  RoleChangeToken,
} from '@librechat/data-schemas';
import type { TCustomConfig } from 'librechat-data-provider';
import type { Keyv } from 'keyv';
import type { cacheConfig } from './cacheConfig';
import { getSafeErrorMetadata } from '~/utils/errors';

export function reportRoleCacheError(error: unknown): void {
  logger.warn(
    '[roleCache] Invalidation or caching failed; bounded expiry remains active:',
    getSafeErrorMetadata(error),
  );
}

export function reportRoleCacheInvalidation(reason: 'connected' | 'change'): void {
  logger.info('[roleCache] Regional generation invalidated', { reason });
}

/** Redis deployments may still keep the role namespace in a local Map. */
export function shouldSweepMemoryCaches(
  config: Pick<typeof cacheConfig, 'CI' | 'USE_REDIS' | 'FORCED_IN_MEMORY_CACHE_NAMESPACES'>,
): boolean {
  return (
    !config.CI &&
    (!config.USE_REDIS || config.FORCED_IN_MEMORY_CACHE_NAMESPACES?.includes(CacheKeys.ROLES))
  );
}

export interface RegionalRoleCache extends CacheStore {
  configure(ttlMs: number): void;
  invalidate(): Promise<void>;
}

/**
 * Namespace generations avoid delete/fill races without a key scan. Mutations rotate the
 * generation instead of publishing role values; only a read's captured snapshot can fill it.
 * Old entries expire, and a pre-invalidation read can only fill its now-unreachable generation.
 */
export function createRegionalRoleCache({
  cache,
  onError,
  now = Date.now,
}: {
  cache: Keyv;
  onError: (error: unknown) => void;
  now?: () => number;
}): RegionalRoleCache {
  let ttlMs: number | undefined;
  const generationKey = '__regional_role_generation';
  const bypass: CacheStore = {
    primaryReads: true,
    get: async () => undefined,
    set: async () => true,
  };

  async function invalidate(): Promise<void> {
    const written = await cache.set(generationKey, randomUUID(), 0);
    if (written === false) {
      throw new Error('Role cache generation update failed');
    }
  }

  async function snapshot(): Promise<CacheStore> {
    if (ttlMs === undefined) {
      return cache;
    }
    const lifetime = ttlMs;
    const startedAt = now();
    try {
      let generation = await cache.get(generationKey);
      if (typeof generation !== 'string') {
        generation = randomUUID();
        if ((await cache.set(generationKey, generation, 0)) === false) {
          throw new Error('Role cache generation initialization failed');
        }
      }
      const prefix = `regional:${generation}:`;
      return {
        primaryReads: true,
        get: async (key) => {
          try {
            return await cache.get(prefix + key);
          } catch (error) {
            onError(error);
            return undefined;
          }
        },
        set: async (key, value) => {
          // Count TTL from before the DB read, not from completion of a slow/stalled fill.
          const remaining = lifetime - (now() - startedAt);
          if (remaining <= 0) {
            return true;
          }
          try {
            return await cache.set(prefix + key, value, remaining);
          } catch (error) {
            onError(error);
            return false;
          }
        },
      };
    } catch (error) {
      onError(error);
      return bypass;
    }
  }

  async function mutate(operation: () => Promise<unknown>): Promise<unknown> {
    if (ttlMs === undefined) {
      return operation();
    }
    // Preserve the caller's cache-publication failure contract even if its DB write committed.
    await invalidate();
    return true;
  }

  return {
    configure: (value) => {
      if (!Number.isInteger(value) || value <= 0) {
        throw new RangeError('Role cache TTL must be a positive integer');
      }
      // Keyv and Redis each swallow failures by default. Enable both error boundaries
      // only for the opt-in cache; foreground invalidation must never certify a no-op.
      cache.throwOnErrors = true;
      const adapter = cache.opts.store;
      if (adapter && 'throwOnErrors' in adapter) {
        adapter.throwOnErrors = true;
      }
      ttlMs = value;
      if (cache.opts) {
        // Enroll the underlying memory store in the app's expired-entry cleanup.
        // Every role fill supplies its own TTL; generation metadata explicitly never expires.
        cache.opts.ttl = value;
      }
    },
    snapshot,
    invalidate,
    get: async (key) => (await snapshot()).get(key),
    set: (key, value, ttl) => mutate(() => cache.set(key, value, ttl)),
    delete: (key) => mutate(() => cache.delete?.(key) ?? Promise.resolve()),
    clear: () => mutate(() => cache.clear?.() ?? Promise.resolve()),
  };
}

/**
 * Each instance observes the durable DB change log and rotates its regional Redis namespace.
 * On every (re)connection, clear after establishing the cursor as well: missed/expired tokens
 * cannot leave persistent cached state behind. No durable checkpoint is needed across process
 * restarts because the entire reconstructable cache generation is discarded at startup.
 */
export async function startRoleCacheInvalidation({
  config,
  cache,
  open,
  onError,
  onInvalidate,
}: {
  config?: TCustomConfig['roleCache'];
  cache: RegionalRoleCache;
  open: RoleChangeSource;
  onError: (error: unknown) => void;
  onInvalidate?: (reason: 'connected' | 'change') => void;
}): Promise<() => Promise<void>> {
  if (!config?.enabled) {
    return async () => undefined;
  }
  const settings = roleCacheConfigSchema.parse(config);
  cache.configure(settings.ttlMs);
  // Do not serve pre-rollout keys, even when change streams are not enabled yet.
  try {
    await cache.invalidate();
  } catch (error) {
    onError(error);
  }
  if (!settings.changeStreamsEnabled) {
    return async () => undefined;
  }
  let closed = false;
  let cursor: RoleChangeCursor | undefined;
  let resumeAfter: RoleChangeToken | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let wake: (() => void) | undefined;

  const run = async (): Promise<void> => {
    while (!closed) {
      try {
        cursor = open({ resumeAfter, maxAwaitTimeMs: settings.maxAwaitTimeMs });
        let established = false;
        while (!closed) {
          const event = await cursor.tryNext();
          if (closed) {
            break;
          }
          if (!established || event) {
            await cache.invalidate();
            onInvalidate?.(event ? 'change' : 'connected');
            established = true;
          }
          if (event) {
            resumeAfter = event.token;
          }
        }
      } catch (error) {
        if (!closed) {
          onError(error);
          // Expired resume tokens recover by opening at the present and rotating the cache.
          resumeAfter = undefined;
        }
      } finally {
        try {
          await cursor?.close();
        } catch (error) {
          if (!closed) {
            onError(error);
          }
        }
        cursor = undefined;
      }
      if (!closed) {
        await new Promise<void>((resolve) => {
          wake = resolve;
          timer = setTimeout(resolve, settings.retryDelayMs);
          timer.unref?.();
        });
      }
    }
  };
  const running = run();
  return async () => {
    closed = true;
    clearTimeout(timer);
    wake?.();
    try {
      await cursor?.close();
    } finally {
      await running;
    }
  };
}
