import {
  CacheKeys,
  AUTH_USER_DOC_BY_ID_PREFIX,
  AUTH_USER_DOC_EVICTION_FENCE_TTL_MS,
} from 'librechat-data-provider';
import type { CacheStore } from '~/types';
import {
  evictAuthUserDocs,
  evictAuthUserDocsForUsers,
  isAuthUserDocEvictionFenced,
  buildAuthUserDocEvictionFenceKey,
} from './eviction';

const INDEX_KEY = `${AUTH_USER_DOC_BY_ID_PREFIX}:user-1`;
const OTHER_INDEX_KEY = `${AUTH_USER_DOC_BY_ID_PREFIX}:user-2`;

/** A Map-backed store that rejects the operations named for a key, as a throwing Redis store does. */
function makeStore(failures: { get?: string[]; set?: string[]; delete?: string[] } = {}) {
  const values = new Map<string, unknown>([
    [INDEX_KEY, ['doc-a', 'doc-b']],
    ['doc-a', { id: 'user-1' }],
    ['doc-b', { id: 'user-1' }],
    ['doc-c', { id: 'user-1' }],
    [OTHER_INDEX_KEY, ['doc-other']],
    ['doc-other', { id: 'user-2' }],
  ]);
  return {
    values,
    get: jest.fn(async (key: string) => {
      if (failures.get?.includes(key)) {
        throw new Error(`GET ${key} failed`);
      }
      return values.get(key);
    }),
    set: jest.fn(async (key: string, value: unknown, _ttl?: number) => {
      if (failures.set?.includes(key)) {
        throw new Error(`SET ${key} failed`);
      }
      values.set(key, value);
      return true;
    }),
    delete: jest.fn(async (key: string) => {
      if (failures.delete?.includes(key)) {
        throw new Error(`DEL ${key} failed`);
      }
      return values.delete(key);
    }),
  };
}

function expectOtherUserCached(store: ReturnType<typeof makeStore>) {
  expect(store.values.get(OTHER_INDEX_KEY)).toEqual(['doc-other']);
  expect(store.values.get('doc-other')).toEqual({ id: 'user-2' });
}

describe('evictAuthUserDocs', () => {
  it('lets a retry find a document an earlier failed delete left behind', async () => {
    const store = makeStore({ delete: ['doc-a'] });
    await expect(evictAuthUserDocs(store, { userId: 'user-1' })).resolves.toBe(false);

    store.delete.mockImplementation(async (key: string) => store.values.delete(key));
    await expect(evictAuthUserDocs(store, { userId: 'user-1' })).resolves.toBe(true);

    expect(store.values.has('doc-a')).toBe(false);
    expect(store.values.has(INDEX_KEY)).toBe(false);
  });

  it('deletes the indexed and explicit documents and the index', async () => {
    const store = makeStore();

    await expect(evictAuthUserDocs(store, { userId: 'user-1', cacheKey: 'doc-c' })).resolves.toBe(
      true,
    );

    for (const key of [INDEX_KEY, 'doc-a', 'doc-b', 'doc-c']) {
      expect(store.values.has(key)).toBe(false);
    }
    expectOtherUserCached(store);
  });

  it('reports a failed index read and keeps the index for a retry', async () => {
    const store = makeStore({ get: [INDEX_KEY] });

    await expect(evictAuthUserDocs(store, { userId: 'user-1', cacheKey: 'doc-c' })).resolves.toBe(
      false,
    );

    expect(store.values.has('doc-c')).toBe(false);
    expect(store.values.get(INDEX_KEY)).toEqual(['doc-a', 'doc-b']);
    expect(store.values.has('doc-a')).toBe(true);
    expectOtherUserCached(store);
  });

  it.each([
    ['a string', 'doc-a'],
    ['a list with a non-string entry', ['doc-a', 42]],
  ])('treats a reverse index holding %s as unreadable', async (_label, indexed) => {
    const store = makeStore();
    store.values.set(INDEX_KEY, indexed);

    await expect(evictAuthUserDocs(store, { userId: 'user-1' })).resolves.toBe(false);

    expect(store.values.get(INDEX_KEY)).toEqual(indexed);
    expect(store.values.has('doc-a')).toBe(true);
  });

  it('reports a failed document delete, deletes the others and keeps the index for a retry', async () => {
    const store = makeStore({ delete: ['doc-a'] });

    await expect(evictAuthUserDocs(store, { userId: 'user-1' })).resolves.toBe(false);

    expect(store.values.has('doc-a')).toBe(true);
    expect(store.values.has('doc-b')).toBe(false);
    expect(store.values.get(INDEX_KEY)).toEqual(['doc-a', 'doc-b']);
    expectOtherUserCached(store);
  });

  it('counts documents as evicted when only the index delete fails', async () => {
    const store = makeStore({ delete: [INDEX_KEY] });

    await expect(evictAuthUserDocs(store, { userId: 'user-1' })).resolves.toBe(true);

    expect(store.values.has('doc-a')).toBe(false);
    expect(store.values.has('doc-b')).toBe(false);
    expect(store.values.get(INDEX_KEY)).toEqual(['doc-a', 'doc-b']);
    expectOtherUserCached(store);
  });

  it('fences the user for longer than a document read before the eviction can live', async () => {
    const store = makeStore();

    await expect(evictAuthUserDocs(store, { userId: 'user-1' })).resolves.toBe(true);

    expect(store.set).toHaveBeenCalledWith(
      buildAuthUserDocEvictionFenceKey('user-1'),
      expect.any(Number),
      AUTH_USER_DOC_EVICTION_FENCE_TTL_MS,
    );
    await expect(isAuthUserDocEvictionFenced(store, 'user-1')).resolves.toBe(true);
    await expect(isAuthUserDocEvictionFenced(store, 'user-2')).resolves.toBe(false);
  });

  it('reports a failed fence write even when every document was deleted', async () => {
    const store = makeStore({ set: [buildAuthUserDocEvictionFenceKey('user-1')] });

    await expect(evictAuthUserDocs(store, { userId: 'user-1' })).resolves.toBe(false);

    expect(store.values.has('doc-a')).toBe(false);
    expect(store.values.has('doc-b')).toBe(false);
    expect(store.values.get(INDEX_KEY)).toEqual(['doc-a', 'doc-b']);
  });

  it('does not fence when only a cache key is evicted', async () => {
    const store = makeStore();

    await expect(evictAuthUserDocs(store, { cacheKey: 'doc-c' })).resolves.toBe(true);

    expect(store.set).not.toHaveBeenCalled();
    expect(store.values.has('doc-c')).toBe(false);
  });
});

describe('isAuthUserDocEvictionFenced', () => {
  it('treats an unreadable fence as fenced', async () => {
    const store = makeStore({ get: [buildAuthUserDocEvictionFenceKey('user-1')] });

    await expect(isAuthUserDocEvictionFenced(store, 'user-1')).resolves.toBe(true);
  });
});

describe('evictAuthUserDocsForUsers', () => {
  const originalMode = process.env.AUTH_USER_CACHE_MODE;

  afterEach(() => {
    if (originalMode === undefined) {
      delete process.env.AUTH_USER_CACHE_MODE;
    } else {
      process.env.AUTH_USER_CACHE_MODE = originalMode;
    }
  });

  function cacheFor(store: ReturnType<typeof makeStore>) {
    return jest.fn((key: string) =>
      key === CacheKeys.AUTH_USER_DOC ? (store as CacheStore) : undefined,
    );
  }

  it('evicts and fences each distinct user once', async () => {
    process.env.AUTH_USER_CACHE_MODE = 'on';
    const store = makeStore();

    await expect(
      evictAuthUserDocsForUsers(cacheFor(store), [
        'user-1',
        { toString: () => 'user-1' },
        'user-2',
      ]),
    ).resolves.toBe(true);

    for (const key of [INDEX_KEY, OTHER_INDEX_KEY, 'doc-a', 'doc-b', 'doc-other']) {
      expect(store.values.has(key)).toBe(false);
    }
    expect(store.set).toHaveBeenCalledTimes(2);
  });

  it('reports a user whose documents may still be served', async () => {
    process.env.AUTH_USER_CACHE_MODE = 'on';
    const store = makeStore({ delete: ['doc-other'] });

    await expect(evictAuthUserDocsForUsers(cacheFor(store), ['user-1', 'user-2'])).resolves.toBe(
      false,
    );
    expect(store.values.has('doc-a')).toBe(false);
  });

  it('leaves the cache alone when the auth user cache is off', async () => {
    delete process.env.AUTH_USER_CACHE_MODE;
    const store = makeStore();
    const getCache = cacheFor(store);

    await expect(evictAuthUserDocsForUsers(getCache, ['user-1'])).resolves.toBe(true);

    expect(getCache).not.toHaveBeenCalled();
    expect(store.values.get(INDEX_KEY)).toEqual(['doc-a', 'doc-b']);
  });
});
