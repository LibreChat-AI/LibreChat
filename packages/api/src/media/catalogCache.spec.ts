import Keyv from 'keyv';
import { CacheKeys, FileSources, resolveMediaConfig } from 'librechat-data-provider';
import { BoundedMediaCacheStore, createMediaCatalogCache } from './catalogCache';

test('bounded Keyv fallback evicts unread entries and keeps recently used entries', async () => {
  const store = new BoundedMediaCacheStore(2);
  const cache = new Keyv({ store, namespace: 'media-test' });
  await cache.set('a', { value: 'a' }, 1_000);
  await cache.set('b', { value: 'b' }, 1_000);
  expect(await cache.get('a')).toEqual({ value: 'a' });
  await cache.set('c', { value: 'c' }, 1_000);
  expect(store.size).toBe(2);
  expect(await cache.get('b')).toBeUndefined();
  expect(await cache.get('a')).toEqual({ value: 'a' });
  expect(await cache.get('c')).toEqual({ value: 'c' });
});

test('host cache factory injects the shared namespace and a bounded fallback', async () => {
  const createCache = jest.fn(
    (namespace: string, ttl: number, store: object) => new Keyv({ namespace, ttl, store }),
  );
  const cache = createMediaCatalogCache({
    appConfig: {
      config: {},
      fileStrategy: FileSources.local,
      imageOutputType: 'png',
      media: resolveMediaConfig({ catalog: { maxCacheEntries: 2, refreshMs: 1000 } }),
    },
    createCache,
  });
  expect(createCache).toHaveBeenCalledWith(
    CacheKeys.MEDIA_CATALOG,
    1000,
    expect.any(BoundedMediaCacheStore),
  );
  const entry = { expires: 2000, value: [] };
  await cache.set('entry', entry, 1500);
  expect(await cache.get('entry')).toEqual(entry);
});
