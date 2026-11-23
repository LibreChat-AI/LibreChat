import { Types } from 'mongoose';
import { CacheKeys } from 'librechat-data-provider';
import { logger, buildAuthUserDocEvictionFenceKey } from '@librechat/data-schemas';
import {
  AUTH_USER_DOC_CACHE_TTL_MS,
  buildAuthUserDocCacheKey,
  buildAuthUserDocReverseIndexKey,
  getAuthUserDocCacheMode,
  getCachedAuthUserDoc,
  getCurrentCachedAuthUserDoc,
  isAuthUserAdmissible,
  AUTH_USER_FRESHNESS_PROJECTION,
  invalidateCachedAuthUserDoc,
  setCachedAuthUserDoc,
  timeAuthUserLookup,
} from './userDocCache';
import { cacheConfig } from '~/cache/cacheConfig';

jest.mock('@librechat/data-schemas', () => ({
  ...jest.requireActual('@librechat/data-schemas'),
  logger: {
    warn: jest.fn(),
  },
}));

const ORIGINAL_ENV = {
  AUTH_USER_CACHE_MODE: process.env.AUTH_USER_CACHE_MODE,
};

const ORIGINAL_CACHE_CONFIG = {
  USE_REDIS: cacheConfig.USE_REDIS,
  FORCED_IN_MEMORY_CACHE_NAMESPACES: [...cacheConfig.FORCED_IN_MEMORY_CACHE_NAMESPACES],
};

function restoreEnv() {
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  cacheConfig.USE_REDIS = ORIGINAL_CACHE_CONFIG.USE_REDIS;
  cacheConfig.FORCED_IN_MEMORY_CACHE_NAMESPACES = [
    ...ORIGINAL_CACHE_CONFIG.FORCED_IN_MEMORY_CACHE_NAMESPACES,
  ];
}

function makeStore() {
  const values = new Map<string, unknown>();
  return {
    values,
    get: async <T = unknown>(key: string) => values.get(key) as T | undefined,
    set: jest.fn(async (key: string, value: unknown, _ttl?: number) => {
      values.set(key, value);
      return true;
    }),
    delete: jest.fn(async (key: string) => values.delete(key)),
  };
}

describe('auth user document cache helpers', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    restoreEnv();
  });

  afterAll(() => {
    restoreEnv();
  });

  it('only enables user request burst caching when Redis backs the auth user namespace', () => {
    process.env.AUTH_USER_CACHE_MODE = 'on';
    cacheConfig.USE_REDIS = false;
    expect(getAuthUserDocCacheMode()).toBe('off');
    expect(logger.warn).toHaveBeenCalledWith(
      '[authUserDocCache] User request burst caching requires Redis; disabling auth user cache',
    );

    cacheConfig.USE_REDIS = true;
    cacheConfig.FORCED_IN_MEMORY_CACHE_NAMESPACES = [CacheKeys.AUTH_USER_DOC];
    expect(getAuthUserDocCacheMode()).toBe('off');

    cacheConfig.FORCED_IN_MEMORY_CACHE_NAMESPACES = [CacheKeys.APP_CONFIG];
    expect(getAuthUserDocCacheMode()).toBe('on');

    process.env.AUTH_USER_CACHE_MODE = 'shadow';
    expect(getAuthUserDocCacheMode()).toBe('off');

    process.env.AUTH_USER_CACHE_MODE = 'invalid';
    expect(getAuthUserDocCacheMode()).toBe('off');
  });

  it('builds stable keys from strategy, subject, issuer, tenant, user, and scope', () => {
    const key = buildAuthUserDocCacheKey({
      strategy: ' OpenID-JWT ',
      subject: 'subject-1',
      issuer: 'https://issuer.example.com/',
      tenantId: 'Tenant-A',
      userId: 'User-A',
      scope: ' Org-A ',
    });
    const equivalent = buildAuthUserDocCacheKey({
      strategy: 'openid-jwt',
      subject: 'subject-1',
      issuer: 'https://issuer.example.com',
      tenantId: 'Tenant-A',
      userId: 'User-A',
      scope: 'org-a',
    });
    const otherTenant = buildAuthUserDocCacheKey({
      strategy: 'openid-jwt',
      subject: 'subject-1',
      issuer: 'https://issuer.example.com',
      tenantId: 'Tenant-B',
      userId: 'User-A',
      scope: 'org-a',
    });
    const caseVariantTenant = buildAuthUserDocCacheKey({
      strategy: 'openid-jwt',
      subject: 'subject-1',
      issuer: 'https://issuer.example.com',
      tenantId: 'tenant-a',
      userId: 'User-A',
      scope: 'org-a',
    });
    const otherUser = buildAuthUserDocCacheKey({
      strategy: 'openid-jwt',
      subject: 'subject-1',
      issuer: 'https://issuer.example.com',
      tenantId: 'Tenant-A',
      userId: 'User-B',
      scope: 'org-a',
    });
    const otherScope = buildAuthUserDocCacheKey({
      strategy: 'openid-jwt',
      subject: 'subject-1',
      issuer: 'https://issuer.example.com',
      tenantId: 'Tenant-A',
      userId: 'User-A',
      scope: 'org-b',
    });

    expect(key).toMatch(/^auth-user-doc:v2:/);
    expect(key).toBe(equivalent);
    expect(key).not.toBe(otherTenant);
    expect(key).not.toBe(caseVariantTenant);
    expect(key).not.toBe(otherUser);
    expect(key).not.toBe(otherScope);
    expect(buildAuthUserDocCacheKey({ strategy: '', subject: 'subject-1' })).toBeUndefined();
    expect(buildAuthUserDocCacheKey({ strategy: 'openid-jwt' })).toBeUndefined();
  });

  it('sanitizes sensitive fields and remembers cache keys by user id', async () => {
    const store = makeStore();
    const cacheKey = 'auth-user-doc:v2:key';
    const userId = new Types.ObjectId();

    await setCachedAuthUserDoc(
      store,
      cacheKey,
      {
        _id: userId,
        id: userId.toString(),
        email: 'user@example.com',
        provider: 'openid',
        password: 'secret',
        refreshToken: [{ refreshToken: 'secret' }],
        federatedTokens: { access_token: 'secret' },
        openidTokens: { access_token: 'secret' },
        totpSecret: 'secret',
        backupCodes: [{ codeHash: 'secret', used: false }],
      },
      Date.now(),
    );

    const cached = store.values.get(cacheKey) as { user: Record<string, unknown> };
    expect(cached.user).toMatchObject({
      _id: userId.toString(),
      id: userId.toString(),
      email: 'user@example.com',
    });
    expect(cached.user.password).toBeUndefined();
    expect(cached.user.refreshToken).toBeUndefined();
    expect(cached.user.federatedTokens).toBeUndefined();
    expect(cached.user.openidTokens).toBeUndefined();
    expect(cached.user.totpSecret).toBeUndefined();
    expect(cached.user.backupCodes).toBeUndefined();

    expect(store.set).toHaveBeenCalledWith(
      cacheKey,
      expect.objectContaining({ version: 2, user: expect.any(Object) }),
      AUTH_USER_DOC_CACHE_TTL_MS,
    );
    expect(store.values.get(buildAuthUserDocReverseIndexKey(userId.toString()))).toEqual([
      cacheKey,
    ]);
    expect(store.set).toHaveBeenCalledWith(
      buildAuthUserDocReverseIndexKey(userId.toString()),
      [cacheKey],
      AUTH_USER_DOC_CACHE_TTL_MS * 2,
    );
  });

  it('does not cache a document the reverse index could not record', async () => {
    const store = makeStore();
    const userId = new Types.ObjectId();
    const indexKey = buildAuthUserDocReverseIndexKey(userId.toString());
    store.set.mockImplementation(async (key: string, value: unknown) => {
      if (key === indexKey) {
        throw new Error('redis unavailable');
      }
      store.values.set(key, value);
      return true;
    });

    await setCachedAuthUserDoc(
      store,
      'auth-user-doc:v2:orphan',
      {
        _id: userId,
        email: 'user@example.com',
      },
      Date.now(),
    );

    expect(store.values.has('auth-user-doc:v2:orphan')).toBe(false);
    expect(logger.warn).toHaveBeenCalledWith('[authUserDocCache] Cache write failed', {
      error: 'redis unavailable',
    });
  });

  it('deduplicates reverse-index keys and caps the remembered set', async () => {
    const store = makeStore();
    const objectId = new Types.ObjectId();
    const userId = objectId.toString();
    const indexKey = buildAuthUserDocReverseIndexKey(userId);
    store.values.set(
      indexKey,
      Array.from({ length: 20 }, (_value, index) => `existing-key-${index}`),
    );

    await setCachedAuthUserDoc(
      store,
      'existing-key-10',
      {
        _id: objectId,
        email: 'user@example.com',
      },
      Date.now(),
    );
    await setCachedAuthUserDoc(
      store,
      'new-key',
      {
        _id: objectId,
        email: 'user@example.com',
      },
      Date.now(),
    );

    const indexed = store.values.get(indexKey);
    expect(indexed).toHaveLength(20);
    expect(indexed).not.toContain('existing-key-0');
    expect(indexed).toContain('existing-key-10');
    expect(indexed).toContain('new-key');
  });

  it('returns cached user documents only for the current cache version', async () => {
    const store = makeStore();
    store.values.set('current', {
      version: 2,
      cachedAt: Date.now(),
      expiresAt: Date.now() + AUTH_USER_DOC_CACHE_TTL_MS,
      user: { id: 'user-1' },
    });
    store.values.set('stale', { version: 1, cachedAt: Date.now(), user: { id: 'user-2' } });

    await expect(getCachedAuthUserDoc(store, 'current')).resolves.toEqual({ id: 'user-1' });
    await expect(getCachedAuthUserDoc(store, 'stale')).resolves.toBeUndefined();
  });

  it('invalidates explicit and reverse-indexed cache keys', async () => {
    const store = makeStore();
    store.values.set(buildAuthUserDocReverseIndexKey('user-1'), ['key-a', 'key-b']);

    await invalidateCachedAuthUserDoc(store, { userId: 'user-1', cacheKey: 'key-c' });

    expect(store.delete).toHaveBeenCalledWith(buildAuthUserDocReverseIndexKey('user-1'));
    expect(store.delete).toHaveBeenCalledWith('key-a');
    expect(store.delete).toHaveBeenCalledWith('key-b');
    expect(store.delete).toHaveBeenCalledWith('key-c');
  });

  it('does not serve a document read before an eviction and written after it', async () => {
    const store = makeStore();
    const userId = new Types.ObjectId();
    const lookupStartedAt = Date.now();

    await invalidateCachedAuthUserDoc(store, { userId: userId.toString() });
    await setCachedAuthUserDoc(
      store,
      'auth-user-doc:v2:late',
      { _id: userId, email: 'before@example.com' },
      lookupStartedAt,
    );

    expect(store.values.has('auth-user-doc:v2:late')).toBe(true);
    await expect(getCachedAuthUserDoc(store, 'auth-user-doc:v2:late')).resolves.toBeUndefined();
  });

  it('hides a cached document the reverse index lost once the user is evicted', async () => {
    const store = makeStore();
    const userId = new Types.ObjectId();
    const user = { _id: userId, email: 'user@example.com' };
    await setCachedAuthUserDoc(store, 'auth-user-doc:v2:lost', user, Date.now());
    await setCachedAuthUserDoc(store, 'auth-user-doc:v2:kept', user, Date.now());
    /** A concurrent read-modify-write of the index dropped the first key. */
    store.values.set(buildAuthUserDocReverseIndexKey(userId.toString()), ['auth-user-doc:v2:kept']);

    await invalidateCachedAuthUserDoc(store, { userId: userId.toString() });

    expect(store.values.has('auth-user-doc:v2:lost')).toBe(true);
    expect(store.values.has('auth-user-doc:v2:kept')).toBe(false);
    await expect(getCachedAuthUserDoc(store, 'auth-user-doc:v2:lost')).resolves.toBeUndefined();
  });

  it('serves a document again once the eviction fence expires', async () => {
    const store = makeStore();
    const userId = new Types.ObjectId();
    await invalidateCachedAuthUserDoc(store, { userId: userId.toString() });
    await setCachedAuthUserDoc(
      store,
      'auth-user-doc:v2:fresh',
      { _id: userId, email: 'after@example.com' },
      Date.now(),
    );
    await expect(getCachedAuthUserDoc(store, 'auth-user-doc:v2:fresh')).resolves.toBeUndefined();

    store.values.delete(buildAuthUserDocEvictionFenceKey(userId.toString()));

    await expect(getCachedAuthUserDoc(store, 'auth-user-doc:v2:fresh')).resolves.toMatchObject({
      email: 'after@example.com',
    });
  });

  it('does not cache a lookup slower than the cache TTL', async () => {
    const store = makeStore();
    const userId = new Types.ObjectId();

    await setCachedAuthUserDoc(
      store,
      'auth-user-doc:v2:slow',
      { _id: userId, email: 'user@example.com' },
      Date.now() - AUTH_USER_DOC_CACHE_TTL_MS - 1,
    );

    expect(store.set).not.toHaveBeenCalled();
  });

  it('skips a cached document whose eviction fence cannot be read', async () => {
    const store = makeStore();
    const userId = new Types.ObjectId();
    await setCachedAuthUserDoc(
      store,
      'auth-user-doc:v2:key',
      { _id: userId, email: 'user@example.com' },
      Date.now(),
    );
    const fenceKey = buildAuthUserDocEvictionFenceKey(userId.toString());
    const get = store.get;
    store.get = async <T = unknown>(key: string) => {
      if (key === fenceKey) {
        throw new Error('redis unavailable');
      }
      return get<T>(key);
    };

    await expect(getCachedAuthUserDoc(store, 'auth-user-doc:v2:key')).resolves.toBeUndefined();
  });

  describe('when the write stalls after the lookup', () => {
    let now: number;
    beforeEach(() => {
      now = 1_000_000;
      jest.spyOn(Date, 'now').mockImplementation(() => now);
    });
    afterEach(() => {
      jest.restoreAllMocks();
    });

    /** The index write stalls while an eviction lands, then the stale document is written. */
    function stallIndexWrite(store: ReturnType<typeof makeStore>, userId: string, stallMs: number) {
      const indexKey = buildAuthUserDocReverseIndexKey(userId);
      store.set.mockImplementation(async (key: string, value: unknown) => {
        if (key === indexKey) {
          await invalidateCachedAuthUserDoc(store, { userId });
          now += stallMs;
        }
        store.values.set(key, value);
        return true;
      });
    }

    it('anchors the expiry of a late stale document to its lookup, not to the write', async () => {
      const store = makeStore();
      const userId = new Types.ObjectId();
      const lookupStartedAt = now;
      now += 4_000;
      stallIndexWrite(store, userId.toString(), 5_500);

      await setCachedAuthUserDoc(
        store,
        'auth-user-doc:v2:stalled',
        { _id: userId, email: 'before@example.com' },
        lookupStartedAt,
      );

      const ttl = store.set.mock.calls.find(([key]) => key === 'auth-user-doc:v2:stalled')?.[2];
      expect(ttl).toBe(lookupStartedAt + AUTH_USER_DOC_CACHE_TTL_MS * 2 - now);
      await expect(
        getCachedAuthUserDoc(store, 'auth-user-doc:v2:stalled'),
      ).resolves.toBeUndefined();

      /** Even with the eviction fence gone and the entry somehow kept, it is past its expiry. */
      store.values.delete(buildAuthUserDocEvictionFenceKey(userId.toString()));
      now = lookupStartedAt + AUTH_USER_DOC_CACHE_TTL_MS * 2 + 1;
      await expect(
        getCachedAuthUserDoc(store, 'auth-user-doc:v2:stalled'),
      ).resolves.toBeUndefined();
    });

    it('does not serve a document that expired while its fence read stalled', async () => {
      const store = makeStore();
      const userId = new Types.ObjectId();
      const lookupStartedAt = now;
      await setCachedAuthUserDoc(
        store,
        'auth-user-doc:v2:unindexed',
        { _id: userId, email: 'before@example.com' },
        lookupStartedAt,
      );
      const fenceKey = buildAuthUserDocEvictionFenceKey(userId.toString());
      const get = store.get;
      /** The fence GET returns only after the fence and the document have both expired. */
      store.get = async <T = unknown>(key: string) => {
        if (key === fenceKey) {
          now = lookupStartedAt + AUTH_USER_DOC_CACHE_TTL_MS * 3 + 1;
          return undefined as T | undefined;
        }
        return get<T>(key);
      };

      await expect(
        getCachedAuthUserDoc(store, 'auth-user-doc:v2:unindexed'),
      ).resolves.toBeUndefined();
    });

    it('does not write a document whose lookup is two TTLs old once the index write returns', async () => {
      const store = makeStore();
      const userId = new Types.ObjectId();
      const lookupStartedAt = now;
      stallIndexWrite(store, userId.toString(), AUTH_USER_DOC_CACHE_TTL_MS * 2);

      await setCachedAuthUserDoc(
        store,
        'auth-user-doc:v2:expired',
        { _id: userId, email: 'before@example.com' },
        lookupStartedAt,
      );

      expect(store.values.has('auth-user-doc:v2:expired')).toBe(false);
    });
  });

  it('stamps a lookup with the time before it ran', async () => {
    let ranAt = 0;
    const before = Date.now();
    const { result, lookupStartedAt } = await timeAuthUserLookup(async () => {
      ranAt = Date.now();
      return { user: 'found' };
    });

    expect(result).toEqual({ user: 'found' });
    expect(lookupStartedAt).toBeGreaterThanOrEqual(before);
    expect(lookupStartedAt).toBeLessThanOrEqual(ranAt);
  });

  it('logs cache failures without throwing', async () => {
    const store = {
      get: async <T = unknown>(): Promise<T | undefined> => {
        throw new Error('redis unavailable');
      },
      set: jest.fn(),
      delete: jest.fn(),
    };

    await expect(getCachedAuthUserDoc(store, 'key')).resolves.toBeUndefined();

    expect(logger.warn).toHaveBeenCalledWith(
      '[authUserDocCache] Cache read failed; falling back to user lookup',
      { error: 'redis unavailable' },
    );
  });

  it('serves a cached document only while the stored updatedAt and fence still match', async () => {
    const store = makeStore();
    const updatedAt = '2026-10-20T00:00:00.000Z';
    store.values.set('key', {
      version: 2,
      cachedAt: Date.now(),
      expiresAt: Date.now() + 60_000,
      user: { _id: 'user-1', id: 'user-1', updatedAt },
    });
    const readStored = jest.fn();

    readStored.mockResolvedValueOnce({ _id: 'user-1', updatedAt: new Date(updatedAt) });
    await expect(
      getCurrentCachedAuthUserDoc(store, 'key', { findUser: readStored }),
    ).resolves.toMatchObject({
      _id: 'user-1',
    });
    expect(readStored).toHaveBeenCalledWith({ _id: 'user-1' }, AUTH_USER_FRESHNESS_PROJECTION);

    /** A mutation after the cached read moved updatedAt. */
    readStored.mockResolvedValueOnce({ _id: 'user-1', updatedAt: new Date('2026-10-27') });
    await expect(
      getCurrentCachedAuthUserDoc(store, 'key', { findUser: readStored }),
    ).resolves.toBeUndefined();

    readStored.mockResolvedValueOnce({
      _id: 'user-1',
      updatedAt: new Date(updatedAt),
      agentTriggerDeletionStartedAt: new Date(),
    });
    await expect(
      getCurrentCachedAuthUserDoc(store, 'key', { findUser: readStored }),
    ).resolves.toBeUndefined();

    readStored.mockResolvedValueOnce(null);
    await expect(
      getCurrentCachedAuthUserDoc(store, 'key', { findUser: readStored }),
    ).resolves.toBeUndefined();

    /** A password reset stamped in the same millisecond as the write before it. */
    readStored.mockResolvedValueOnce({
      _id: 'user-1',
      updatedAt: new Date(updatedAt),
      credentialsChangedAt: new Date(updatedAt),
    });
    await expect(
      getCurrentCachedAuthUserDoc(store, 'key', { findUser: readStored }),
    ).resolves.toBeUndefined();

    readStored.mockResolvedValueOnce({
      _id: 'user-1',
      updatedAt: new Date(updatedAt),
      role: 'ADMIN',
    });
    await expect(
      getCurrentCachedAuthUserDoc(store, 'key', { findUser: readStored }),
    ).resolves.toBeUndefined();
  });

  it('skips the freshness read on a cache miss', async () => {
    const readStored = jest.fn();
    await expect(
      getCurrentCachedAuthUserDoc(makeStore(), 'missing', { findUser: readStored }),
    ).resolves.toBeUndefined();
    expect(readStored).not.toHaveBeenCalled();
  });

  it('reads the deletion fence only for users the cache did not vouch for', async () => {
    const isPrincipalActive = jest.fn(async () => false);

    await expect(
      isAuthUserAdmissible('user-1', { fenceChecked: true, isPrincipalActive }),
    ).resolves.toBe(true);
    expect(isPrincipalActive).not.toHaveBeenCalled();

    await expect(
      isAuthUserAdmissible('user-1', { fenceChecked: false, isPrincipalActive }),
    ).resolves.toBe(false);
    expect(isPrincipalActive).toHaveBeenCalledWith('user-1');
  });
});
