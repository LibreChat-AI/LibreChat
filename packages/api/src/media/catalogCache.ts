import { CacheKeys } from 'librechat-data-provider';
import { getMediaConfig } from '@librechat/data-schemas';
import type { AppConfig } from '@librechat/data-schemas';
import type Keyv from 'keyv';
import type { ResolvedMediaOffering } from './discovery';

export interface MediaCatalogCacheEntry {
  expires: number;
  value: ResolvedMediaOffering[];
}

/** The host supplies a namespaced shared cache; explicit TTL applies to every write. */
export interface MediaCatalogCache {
  get(key: string): Promise<MediaCatalogCacheEntry | undefined>;
  set(key: string, value: MediaCatalogCacheEntry, ttlMs: number): Promise<unknown>;
}

/** Keyv-compatible fallback with an explicit memory bound, including expired unread entries. */
export class BoundedMediaCacheStore extends Map<string, string> {
  constructor(private readonly capacity: number) {
    super();
    if (!Number.isSafeInteger(capacity) || capacity < 1)
      throw new Error('Invalid media cache capacity.');
  }

  override get(key: string): string | undefined {
    const value = super.get(key);
    if (value !== undefined) {
      super.delete(key);
      super.set(key, value);
    }
    return value;
  }

  override set(key: string, value: string): this {
    super.delete(key);
    while (this.size >= this.capacity) {
      const oldest = this.keys().next().value;
      if (oldest === undefined) break;
      super.delete(oldest);
    }
    return super.set(key, value);
  }
}

export function createMediaCatalogCache({
  appConfig,
  createCache,
}: {
  appConfig: AppConfig;
  createCache(namespace: string, ttl: number, fallback: object): Keyv;
}): MediaCatalogCache {
  const { refreshMs, maxCacheEntries } = getMediaConfig(appConfig).catalog;
  const cache = createCache(
    CacheKeys.MEDIA_CATALOG,
    refreshMs,
    new BoundedMediaCacheStore(maxCacheEntries),
  );
  return {
    get: (key) => cache.get<MediaCatalogCacheEntry>(key),
    set: (key, value, ttl) => cache.set(key, value, ttl),
  };
}
