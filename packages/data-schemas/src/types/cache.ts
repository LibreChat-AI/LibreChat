/**
 * Cache store contract injected into database methods from the api layer
 * (e.g. getLogStores). Lock members are only present when the store is
 * Redis-backed and cross-process build deduplication is enabled.
 */
export interface CacheStore {
  get: (key: string) => Promise<unknown>;
  /** The optional ttl overrides the store's namespace default for this entry. */
  set: (key: string, value: unknown, ttl?: number) => Promise<unknown>;
  delete?: (key: string) => Promise<unknown>;
  clear?: () => Promise<unknown>;
  /** True when the store is shared across processes (e.g. Redis-backed). */
  crossProcess?: boolean;
  /** Delay before the second invalidation pass that evicts cross-process stale rewrites. */
  staleEvictionDelayMs?: number;
  /** Acquires a cross-process build lock; resolves a release token, or null when already held. */
  acquireLock?: (key: string) => Promise<string | null>;
  releaseLock?: (key: string, token: string) => Promise<unknown>;
  /** Max time to wait for another process holding the build lock to fill the cache. */
  lockWaitMs?: number;
}
