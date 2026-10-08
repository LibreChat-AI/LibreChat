import { Keyv } from 'keyv';
import { randomUUID } from 'crypto';
import { logger, scopedCacheKey } from '@librechat/data-schemas';
import type { ReadThroughTransforms } from './ReadThroughAllCache';
import { standardCache } from '~/cache';

const GENERATION_KEY = '__generation__';
const GLOBAL_GENERATION_KEY = '__global_generation__';

/** Invalidation state a per-server miss observed, handed back with the miss so
 *  the matching fill (and only that fill) can be fenced when a targeted delete
 *  or namespace clear completed first. */
export interface FillToken {
  key: string;
  generation: string | null;
}

/**
 * Redis-capable read-through cache for per-server config entries, the
 * single-entry counterpart to {@link ReadThroughAllCache}.
 *
 * The store comes from {@link standardCache} (Redis when configured, process
 * memory otherwise), values may be kept ciphertext via
 * {@link ReadThroughTransforms}, and a ttl of zero or less disables the cache
 * entirely because entries encode ACL decisions that must not outlive a
 * revocation without a TTL bound.
 *
 * Each miss returns a fill token capturing the shared tenant and global
 * generations it observed. A targeted mutation rotates the tenant generation,
 * while a namespace reset rotates the global generation. The matching set() is
 * fenced by that token, so a fill that straddles an invalidation remains under
 * its old generation and cannot become visible again on any replica.
 *
 * Read and fill-write failures never reject: a Redis outage degrades reads to a
 * miss and writes to a skip so the shared store stays an optimization on the
 * request path. Mutation invalidations reject when their shared generation
 * cannot be rotated, rather than reporting stale data as invalidated.
 */
export class ReadThroughCache<T> {
  private readonly cache: Keyv;
  private readonly generationCache: Keyv;
  private readonly ttl: number;
  private readonly transforms?: ReadThroughTransforms<T>;

  constructor(namespace: string, ttl: number, transforms?: ReadThroughTransforms<T>) {
    this.cache = standardCache(namespace, ttl);
    this.generationCache = standardCache(`${namespace}::generation`);
    this.ttl = ttl;
    this.transforms = transforms;
  }

  private get enabled(): boolean {
    return this.ttl > 0;
  }

  private entryKey(generation: string, key: string): string {
    return `${generation}::${key}`;
  }

  private async readGeneration(): Promise<string | undefined> {
    let globalGeneration: unknown;
    let tenantGeneration: unknown;
    try {
      [globalGeneration, tenantGeneration] = await Promise.all([
        this.generationCache.get(GLOBAL_GENERATION_KEY),
        this.generationCache.get(scopedCacheKey(GENERATION_KEY)),
      ]);
    } catch (error) {
      logger.warn('[ReadThroughCache] Generation read failed:', error);
      return undefined;
    }
    const global = typeof globalGeneration === 'string' ? globalGeneration : '0';
    const tenant = typeof tenantGeneration === 'string' ? tenantGeneration : '0';
    return `${global}:${tenant}`;
  }

  /** Single decoded read: `hit` distinguishes a stored value (which may
   *  legitimately be absent) from a miss, so callers can negative-cache. An
   *  undecodable entry (e.g. after a credentials-key rotation) self-heals: it
   *  is deleted and reported as a miss so the caller refetches. */
  async getEntry(key: string): Promise<{
    hit: boolean;
    value: T | undefined;
    fill?: FillToken;
  }> {
    if (!this.enabled) {
      return { hit: false, value: undefined };
    }
    const generation = await this.readGeneration();
    if (generation == null) {
      return { hit: false, value: undefined, fill: { key, generation: null } };
    }
    const cacheKey = this.entryKey(generation, key);
    let raw: unknown;
    try {
      raw = await this.cache.get(cacheKey);
    } catch (error) {
      logger.warn('[ReadThroughCache] Store read failed; treating as a miss:', error);
      return { hit: false, value: undefined, fill: { key, generation } };
    }
    if (raw === undefined) {
      return { hit: false, value: undefined, fill: { key, generation } };
    }
    let value: T;
    if (!this.transforms?.decode) {
      value = raw as T;
    } else {
      try {
        value = await this.transforms.decode(raw as string);
      } catch (error) {
        logger.warn(
          '[ReadThroughCache] Failed to decode cached entry; deleting and missing:',
          error,
        );
        try {
          await this.cache.delete(cacheKey);
        } catch (deleteError) {
          logger.warn('[ReadThroughCache] Failed to delete undecodable cache entry:', deleteError);
        }
        return { hit: false, value: undefined, fill: { key, generation } };
      }
    }
    const current = await this.readGeneration();
    if (current !== generation) {
      return { hit: false, value: undefined, fill: { key, generation: current ?? null } };
    }
    return { hit: true, value };
  }

  async set(key: string, value: T, fill?: FillToken): Promise<void> {
    if (!this.enabled) {
      return;
    }
    if (fill != null && fill.key === key && fill.generation == null) {
      return;
    }
    const generation = await this.readGeneration();
    if (generation == null) {
      return;
    }
    if (fill != null && fill.key === key && fill.generation !== generation) {
      /** Fenced: an invalidation completed while this value was being computed;
       *  writing it would undo the mutation for every replica. */
      return;
    }
    const cacheKey = this.entryKey(generation, key);
    try {
      const stored = this.transforms?.encode ? await this.transforms.encode(value) : value;
      await this.cache.set(cacheKey, stored);
    } catch (error) {
      logger.warn('[ReadThroughCache] Failed to write cache entry:', error);
      return;
    }
    if ((await this.readGeneration()) !== generation) {
      try {
        await this.cache.delete(cacheKey);
      } catch (error) {
        logger.warn('[ReadThroughCache] Failed to delete stale cache write:', error);
      }
    }
  }

  async delete(key: string): Promise<void> {
    if (!this.enabled) {
      return;
    }
    const generation = await this.readGeneration();
    try {
      await this.generationCache.set(scopedCacheKey(GENERATION_KEY), randomUUID());
    } catch (error) {
      logger.warn('[ReadThroughCache] Generation write failed during delete:', error);
      throw error;
    }
    if (generation == null) {
      return;
    }
    try {
      await this.cache.delete(this.entryKey(generation, key));
    } catch (error) {
      logger.warn('[ReadThroughCache] Failed to delete orphaned cache entry:', error);
    }
  }

  /** Lifecycle resets only; not a hot-path invalidation. */
  async clear(): Promise<void> {
    if (!this.enabled) {
      return;
    }
    try {
      await this.generationCache.set(GLOBAL_GENERATION_KEY, randomUUID());
    } catch (error) {
      logger.warn('[ReadThroughCache] Global generation write failed:', error);
      throw error;
    }
    try {
      await this.cache.clear();
    } catch (error) {
      logger.warn('[ReadThroughCache] Failed to clear cache:', error);
    }
  }
}
