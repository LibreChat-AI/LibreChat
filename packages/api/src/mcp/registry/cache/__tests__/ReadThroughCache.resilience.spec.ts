import { randomUUID } from 'crypto';
import { ReadThroughAllCache } from '../ReadThroughAllCache';
import { ReadThroughCache } from '../ReadThroughCache';

interface MockStore {
  get: jest.Mock;
  set: jest.Mock;
  delete: jest.Mock;
  clear: jest.Mock;
}

/** Stores created by the mocked `standardCache`, keyed by namespace, so tests
 *  can drive the exact boundary failures and interleavings the real Redis
 *  client cannot be asked to produce deterministically. */
const mockStores = new Map<string, MockStore>();

jest.mock('~/cache', () => {
  const actual = jest.requireActual('~/cache');
  return {
    ...actual,
    standardCache: (namespace: string) => {
      const existing = mockStores.get(namespace);
      if (existing) {
        return existing;
      }
      const store: MockStore = {
        get: jest.fn(async () => undefined),
        set: jest.fn(async () => true),
        delete: jest.fn(async () => true),
        clear: jest.fn(async () => undefined),
      };
      mockStores.set(namespace, store);
      return store;
    },
  };
});

function storesFor(namespace: string): { entry: MockStore; generation: MockStore } {
  const entry = mockStores.get(namespace);
  const generation = mockStores.get(`${namespace}::generation`);
  if (!entry || !generation) {
    throw new Error(`stores not created for ${namespace}`);
  }
  return { entry, generation };
}

function storeFor(namespace: string): MockStore {
  const store = mockStores.get(namespace);
  if (!store) {
    throw new Error(`store not created for ${namespace}`);
  }
  return store;
}

function installGenerationStore(
  generation: MockStore,
  initial: Record<string, string> = {},
): Map<string, string> {
  const values = new Map(Object.entries(initial));
  generation.get.mockImplementation(async (key: string) => values.get(key));
  generation.set.mockImplementation(async (key: string, value: string) => {
    values.set(key, value);
    return true;
  });
  return values;
}

function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe('read-through cache resilience', () => {
  test('entry store failure on get degrades to a miss', async () => {
    const namespace = `rtac-r-${randomUUID()}`;
    const cache = new ReadThroughAllCache<string>(namespace, 60_000);
    const { entry } = storesFor(namespace);
    entry.get.mockRejectedValueOnce(new Error('redis unavailable'));

    await expect(cache.get('user-1')).resolves.toEqual(expect.objectContaining({ hit: false }));
  });

  test('generation store failure on get degrades to a miss', async () => {
    const namespace = `rtac-r-${randomUUID()}`;
    const cache = new ReadThroughAllCache<string>(namespace, 60_000);
    const { generation } = storesFor(namespace);
    generation.get.mockRejectedValue(new Error('redis unavailable'));

    await expect(cache.get('user-1')).resolves.toEqual(expect.objectContaining({ hit: false }));
  });

  test('a generation-read failure marks the fill as uncacheable', async () => {
    const namespace = `rtac-r-${randomUUID()}`;
    const cache = new ReadThroughAllCache<string>(namespace, 60_000);
    const { entry, generation } = storesFor(namespace);
    generation.get.mockRejectedValue(new Error('redis unavailable'));

    const miss = await cache.get('user-1');
    expect(miss.fill).toEqual({ key: 'user-1', generation: null });

    generation.get.mockResolvedValue(undefined);
    await cache.set('user-1', 'must-not-be-shared', miss.fill);
    expect(entry.set).not.toHaveBeenCalled();
  });

  test('a generation failure cannot revive generation-zero entries', async () => {
    const namespace = `rtac-r-${randomUUID()}`;
    const cache = new ReadThroughAllCache<string>(namespace, 60_000);
    const { entry, generation } = storesFor(namespace);
    entry.get.mockResolvedValue('stale-from-generation-0');
    generation.get.mockRejectedValue(new Error('transient'));

    /** The unreadable generation must be a miss, not a fallback to "0", or an
     *  unexpired pre-invalidation entry could be served for another TTL. */
    await expect(cache.get('user-1')).resolves.toEqual(expect.objectContaining({ hit: false }));
    expect(entry.get).not.toHaveBeenCalled();
  });

  test('store failure on set never rejects and keeps the process-local memo', async () => {
    const namespace = `rtac-r-${randomUUID()}`;
    const cache = new ReadThroughAllCache<string>(namespace, 60_000);
    const { entry, generation } = storesFor(namespace);
    entry.set.mockRejectedValue(new Error('redis unavailable'));
    generation.set.mockRejectedValue(new Error('redis unavailable'));

    await expect(cache.set('user-1', 'computed')).resolves.toBeUndefined();
    /** The memo still serves the caller's own computed value; only the
     *  cross-instance sharing is lost while the store is unavailable. */
    await expect(cache.get('user-1')).resolves.toEqual(
      expect.objectContaining({ hit: true, value: 'computed' }),
    );
  });

  test('generation write failure on invalidateAll is propagated', async () => {
    const namespace = `rtac-r-${randomUUID()}`;
    const cache = new ReadThroughAllCache<string>(namespace, 60_000);
    const { generation } = storesFor(namespace);
    generation.set.mockRejectedValue(new Error('redis unavailable'));

    await expect(cache.invalidateAll()).rejects.toThrow('redis unavailable');
  });

  test('an invalidation landing mid-read is not memoized', async () => {
    const namespace = `rtac-r-${randomUUID()}`;
    const cache = new ReadThroughAllCache<string>(namespace, 60_000);
    const { entry, generation } = storesFor(namespace);
    entry.get.mockResolvedValue('pre-mutation-value');
    /** First read sees g1; the recheck after the entry fetch observes the
     *  invalidation that landed in between. */
    generation.get.mockImplementation(async (key: string) => {
      if (key === '__global_generation__') {
        return 'global';
      }
      return generation.get.mock.calls.filter(([calledKey]) => calledKey === '__generation__')
        .length === 1
        ? 'g1'
        : 'g2';
    });

    const raced = await cache.get('user-1');
    expect(raced.hit).toBe(false);
    /** The racing fill observes g1 and the generation has moved, so it stays
     *  fenced when its caller finishes computing. */
    await cache.set('user-1', 'stale-computed', raced.fill);
    expect(entry.set).not.toHaveBeenCalled();

    /** The value was never memoized, so the next read recomputes from the
     *  store under the new generation rather than replaying the stale hit. */
    entry.get.mockClear();
    await expect(cache.get('user-1')).resolves.toEqual(
      expect.objectContaining({ hit: true, value: 'pre-mutation-value' }),
    );
    expect(entry.get).toHaveBeenCalledWith('global:g2::user-1');
  });

  test('a fill computed across an invalidation is fenced', async () => {
    const namespace = `rtac-r-${randomUUID()}`;
    const cache = new ReadThroughAllCache<string>(namespace, 60_000);
    const { entry, generation } = storesFor(namespace);
    /** The miss happens under g1; the caller is still computing when the
     *  generation moves to g2, so the fill must not be written or memoized. */
    const values = installGenerationStore(generation, {
      __global_generation__: 'global',
      __generation__: 'g1',
    });
    entry.get.mockResolvedValueOnce(undefined);
    const miss = await cache.get('user-1');
    expect(miss.fill).toEqual({ key: 'user-1', generation: 'global:g1' });

    values.set('__generation__', 'g2');
    await cache.set('user-1', 'stale-computed', miss.fill);

    expect(entry.set).not.toHaveBeenCalled();
    await expect(cache.get('user-1')).resolves.toEqual(expect.objectContaining({ hit: false }));
  });

  test('a store-failure miss still fences its fill across an invalidation', async () => {
    const namespace = `rtac-r-${randomUUID()}`;
    const cache = new ReadThroughAllCache<string>(namespace, 60_000);
    const { entry, generation } = storesFor(namespace);
    /** The Redis read fails under g1 but recovers by the time the fill lands,
     *  after an invalidation moved the generation: the fill is still stale. */
    const values = installGenerationStore(generation, {
      __global_generation__: 'global',
      __generation__: 'g1',
    });
    entry.get.mockRejectedValueOnce(new Error('redis unavailable'));
    const miss = await cache.get('user-1');
    expect(miss.hit).toBe(false);

    values.set('__generation__', 'g2');
    await cache.set('user-1', 'stale-computed', miss.fill);

    expect(entry.set).not.toHaveBeenCalled();
  });

  test('a fence survives fills slower than one TTL window', async () => {
    const namespace = `rtac-r-${randomUUID()}`;
    const cache = new ReadThroughAllCache<string>(namespace, 40);
    const { entry, generation } = storesFor(namespace);
    const values = installGenerationStore(generation, {
      __global_generation__: 'global',
      __generation__: 'g1',
    });
    entry.get.mockResolvedValueOnce(undefined);
    const miss = await cache.get('user-1');
    expect(miss.hit).toBe(false);

    await new Promise((resolve) => setTimeout(resolve, 80));
    values.set('__generation__', 'g2');

    /** The miss generation travels with the fill, so a compute slower than the
     *  entry TTL is still fenced when it lands. */
    await cache.set('user-1', 'slow-stale-computed', miss.fill);
    expect(entry.set).not.toHaveBeenCalled();
  });

  test('concurrent fills for one key keep distinct fences', async () => {
    const namespace = `rtac-r-${randomUUID()}`;
    const cache = new ReadThroughAllCache<string>(namespace, 60_000);
    const { entry, generation } = storesFor(namespace);
    /** Fill A misses under g1; an invalidation moves to g2; fill B misses
     *  under g2. A's later set must stay fenced even though B's fence is
     *  current, which a shared per-key marker could not express. */
    const values = installGenerationStore(generation, {
      __global_generation__: 'global',
      __generation__: 'g1',
    });
    entry.get.mockResolvedValueOnce(undefined);
    const missA = await cache.get('user-1');

    values.set('__generation__', 'g2');
    entry.get.mockResolvedValueOnce(undefined);
    const missB = await cache.get('user-1');
    expect(missB.fill).toEqual({ key: 'user-1', generation: 'global:g2' });

    await cache.set('user-1', 'stale-from-A', missA.fill);
    expect(entry.set).not.toHaveBeenCalled();

    await cache.set('user-1', 'fresh-from-B', missB.fill);
    expect(entry.set).toHaveBeenCalledWith('global:g2::user-1', 'fresh-from-B');
  });

  test('invalidateAll evicts a memo repopulated while the generation write is pending', async () => {
    const namespace = `rtac-r-${randomUUID()}`;
    const cache = new ReadThroughAllCache<string>(namespace, 60_000);
    const { entry, generation } = storesFor(namespace);
    const values = installGenerationStore(generation, {
      __global_generation__: 'global',
      __generation__: 'g1',
    });
    const generationWrite = deferred<void>();
    generation.set.mockImplementation(async (key: string, value: string) => {
      await generationWrite.promise;
      values.set(key, value);
      return true;
    });

    await cache.set('user-1', 'memoized-old');
    entry.get.mockResolvedValue('stored-old');

    const invalidation = cache.invalidateAll();
    const racedRead = await cache.get('user-1');
    expect(racedRead).toEqual(expect.objectContaining({ hit: true, value: 'stored-old' }));

    generationWrite.resolve();
    await invalidation;

    entry.get.mockClear();
    await cache.get('user-1');
    expect(entry.get).toHaveBeenCalled();
  });

  test('invalidateAllGlobal rotates the shared fence for in-flight fills', async () => {
    const namespace = `rtac-r-${randomUUID()}`;
    const cache = new ReadThroughAllCache<string>(namespace, 60_000);
    const { entry, generation } = storesFor(namespace);
    installGenerationStore(generation, {
      __global_generation__: 'global-1',
      __generation__: 'tenant-1',
    });
    entry.get.mockResolvedValueOnce(undefined);
    const miss = await cache.get('user-1');

    await cache.invalidateAllGlobal();
    await cache.set('user-1', 'pre-reset-value', miss.fill);

    expect(generation.set).toHaveBeenCalledWith('__global_generation__', expect.any(String));
    expect(entry.set).not.toHaveBeenCalled();
  });

  test("invalidation in one tenant does not orphan another tenant's entries", async () => {
    const { tenantStorage } = await import('@librechat/data-schemas');
    const namespace = `rtac-r-${randomUUID()}`;
    const cache = new ReadThroughAllCache<string>(namespace, 60_000);
    const { entry, generation } = storesFor(namespace);
    generation.get.mockImplementation(async (key: string) => {
      if (key === '__generation__:tenant-a') {
        return 'ga1';
      }
      if (key === '__generation__:tenant-b') {
        return 'gb1';
      }
      return 'g0';
    });

    await tenantStorage.run({ tenantId: 'tenant-a' }, () => cache.set('user:tenant-a', 'value-a'));
    entry.get.mockImplementation(async (key: string) =>
      key === 'ga1::user:tenant-a' ? 'value-a' : undefined,
    );

    await tenantStorage.run({ tenantId: 'tenant-b' }, () => cache.invalidateAll());
    expect(generation.set).toHaveBeenCalledWith('__generation__:tenant-b', expect.any(String));

    /** Tenant B's invalidation left tenant A's memo entry in place, so this
     *  read never even reaches the shared store. */
    entry.get.mockClear();
    const survived = await tenantStorage.run({ tenantId: 'tenant-a' }, () =>
      cache.get('user:tenant-a'),
    );
    expect(survived).toEqual(expect.objectContaining({ hit: true, value: 'value-a' }));
    expect(entry.get).not.toHaveBeenCalled();
  });

  test('invalidateAllGlobal clears the shared namespace across tenants', async () => {
    const namespace = `rtac-r-${randomUUID()}`;
    const cache = new ReadThroughAllCache<string>(namespace, 60_000);
    const { entry, generation } = storesFor(namespace);
    installGenerationStore(generation);
    entry.get.mockResolvedValue('stored-value');
    await cache.set('user-1', 'memoized');

    await cache.invalidateAllGlobal();

    /** The namespace-wide clear ran and the memo was evicted with it, so the
     *  next read goes back to the shared store instead of replaying it. */
    expect(entry.clear).toHaveBeenCalled();
    await cache.get('user-1');
    expect(entry.get).toHaveBeenCalledWith(expect.stringMatching(/^[^:]+:0::user-1$/));
  });
});

describe('per-server ReadThroughCache resilience', () => {
  test('ttl of 0 disables the cache entirely', async () => {
    const namespace = `rtc-r-${randomUUID()}`;
    const cache = new ReadThroughCache<string>(namespace, 0);
    const store = storeFor(namespace);

    await cache.set('server::user', 'never-cached');
    await expect(cache.getEntry('server::user')).resolves.toEqual(
      expect.objectContaining({ hit: false }),
    );
    expect(store.set).not.toHaveBeenCalled();
  });

  test('store failures degrade to misses and skipped writes', async () => {
    const namespace = `rtc-r-${randomUUID()}`;
    const cache = new ReadThroughCache<string>(namespace, 60_000);
    const store = storeFor(namespace);
    store.get.mockRejectedValue(new Error('redis unavailable'));
    store.set.mockRejectedValue(new Error('redis unavailable'));
    store.delete.mockRejectedValue(new Error('redis unavailable'));

    await expect(cache.getEntry('server::user')).resolves.toEqual(
      expect.objectContaining({ hit: false }),
    );
    await expect(cache.set('server::user', 'value')).resolves.toBeUndefined();
    await expect(cache.delete('server::user')).resolves.toBeUndefined();
  });

  test('transforms keep the store ciphertext while serving plaintext', async () => {
    const namespace = `rtc-r-${randomUUID()}`;
    const cache = new ReadThroughCache<string>(namespace, 60_000, {
      encode: (value) => Buffer.from(value).toString('base64'),
      decode: (raw) => Buffer.from(raw, 'base64').toString('utf8'),
    });

    await cache.set('server::user', 'secret-value');

    const store = storeFor(namespace);
    const [, stored] = store.set.mock.calls[0];
    expect(String(stored)).not.toContain('secret-value');
    store.get.mockResolvedValueOnce(stored);
    await expect(cache.getEntry('server::user')).resolves.toEqual(
      expect.objectContaining({ hit: true, value: 'secret-value' }),
    );
  });

  test('an undecodable entry is deleted and reported as a miss', async () => {
    const namespace = `rtc-r-${randomUUID()}`;
    const cache = new ReadThroughCache<string>(namespace, 60_000, {
      encode: (value) => value,
      decode: () => {
        throw new Error('key rotation');
      },
    });
    const store = storeFor(namespace);
    store.get.mockResolvedValueOnce('stale-ciphertext');

    await expect(cache.getEntry('server::user')).resolves.toEqual(
      expect.objectContaining({ hit: false }),
    );
    expect(store.delete).toHaveBeenCalledWith('0:0::server::user');
  });

  test('a fill finishing after a targeted delete is fenced', async () => {
    const namespace = `rtc-r-${randomUUID()}`;
    const cache = new ReadThroughCache<string>(namespace, 60_000);
    const { entry: store, generation } = storesFor(namespace);
    installGenerationStore(generation);
    store.get.mockResolvedValueOnce(undefined);
    const miss = await cache.getEntry('server::user');
    expect(miss.hit).toBe(false);

    /** The server is updated and the cache key deleted while the original
     *  request was still fetching; its write must not undo the mutation. */
    await cache.delete('server::user');
    await cache.set('server::user', 'pre-mutation-value', miss.fill);

    expect(store.set).not.toHaveBeenCalled();
  });

  test('a fill finishing after a namespace clear is fenced', async () => {
    const namespace = `rtc-r-${randomUUID()}`;
    const cache = new ReadThroughCache<string>(namespace, 60_000);
    const { entry: store, generation } = storesFor(namespace);
    installGenerationStore(generation);
    store.get.mockResolvedValueOnce(undefined);
    const miss = await cache.getEntry('server::user');
    expect(miss.hit).toBe(false);

    await cache.clear();
    await cache.set('server::user', 'pre-reset-value', miss.fill);

    expect(store.set).not.toHaveBeenCalled();
  });

  test('a fill is allowed when no invalidation intervened', async () => {
    const namespace = `rtc-r-${randomUUID()}`;
    const cache = new ReadThroughCache<string>(namespace, 60_000);
    const store = storeFor(namespace);
    store.get.mockResolvedValueOnce(undefined);
    const miss = await cache.getEntry('server::user');
    expect(miss.hit).toBe(false);

    await cache.set('server::user', 'fresh', miss.fill);

    expect(store.set).toHaveBeenCalledWith('0:0::server::user', 'fresh');
  });

  test('concurrent fills for one key keep distinct fences', async () => {
    const namespace = `rtc-r-${randomUUID()}`;
    const cache = new ReadThroughCache<string>(namespace, 60_000);
    const { entry: store, generation } = storesFor(namespace);
    installGenerationStore(generation);
    /** Fill A misses; a targeted delete lands; fill B misses. A's later write
     *  must stay fenced even though B's fence is current. */
    store.get.mockResolvedValue(undefined);
    const missA = await cache.getEntry('server::user');

    await cache.delete('server::user');
    const missB = await cache.getEntry('server::user');

    await cache.set('server::user', 'stale-from-A', missA.fill);
    expect(store.set).not.toHaveBeenCalled();

    await cache.set('server::user', 'fresh-from-B', missB.fill);
    expect(store.set).toHaveBeenCalledWith(
      expect.stringContaining('::server::user'),
      'fresh-from-B',
    );
  });

  test('a cross-instance invalidation fences a write already awaiting encode', async () => {
    const namespace = `rtc-r-${randomUUID()}`;
    const encodeStarted = deferred<void>();
    const releaseEncode = deferred<void>();
    const writer = new ReadThroughCache<string>(namespace, 60_000, {
      encode: async (value) => {
        encodeStarted.resolve();
        await releaseEncode.promise;
        return value;
      },
    });
    const invalidator = new ReadThroughCache<string>(namespace, 60_000);
    const { entry, generation } = storesFor(namespace);
    installGenerationStore(generation, {
      __global_generation__: 'global',
      __generation__: 'tenant-1',
    });
    entry.get.mockResolvedValueOnce(undefined);
    const miss = await writer.getEntry('server::user');

    const write = writer.set('server::user', 'pre-mutation-value', miss.fill);
    await encodeStarted.promise;
    await invalidator.delete('server::user');
    releaseEncode.resolve();
    await write;

    expect(entry.set).toHaveBeenCalledWith('global:tenant-1::server::user', 'pre-mutation-value');
    expect(entry.delete).toHaveBeenLastCalledWith('global:tenant-1::server::user');

    entry.get.mockClear();
    await expect(invalidator.getEntry('server::user')).resolves.toEqual(
      expect.objectContaining({ hit: false }),
    );
    expect(entry.get).toHaveBeenCalledWith(expect.not.stringContaining('tenant-1'));
  });

  test('targeted invalidations reuse one shared tenant generation key', async () => {
    const namespace = `rtc-r-${randomUUID()}`;
    const cache = new ReadThroughCache<string>(namespace, 60_000);
    const { generation } = storesFor(namespace);
    installGenerationStore(generation);

    await cache.delete('server-a::user');
    await cache.delete('server-b::user');
    await cache.delete('server-c::user');

    expect(generation.set).toHaveBeenCalledTimes(3);
    expect(generation.set.mock.calls.every(([key]) => key === '__generation__')).toBe(true);
  });
});
