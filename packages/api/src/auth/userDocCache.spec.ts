import { Types } from 'mongoose';
import { logger } from '@librechat/data-schemas';
import { CacheKeys } from 'librechat-data-provider';
import {
  AUTH_USER_DOC_CACHE_TTL_MS,
  buildAuthUserDocCacheKey,
  buildAuthUserDocReverseIndexKey,
  getAuthUserDocCacheMode,
  getCachedAuthUserDoc,
  invalidateCachedAuthUserDoc,
  setCachedAuthUserDoc,
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

    await setCachedAuthUserDoc(store, cacheKey, {
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
    });

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

    await setCachedAuthUserDoc(store, 'auth-user-doc:v2:orphan', {
      _id: userId,
      email: 'user@example.com',
    });

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

    await setCachedAuthUserDoc(store, 'existing-key-10', {
      _id: objectId,
      email: 'user@example.com',
    });
    await setCachedAuthUserDoc(store, 'new-key', {
      _id: objectId,
      email: 'user@example.com',
    });

    const indexed = store.values.get(indexKey);
    expect(indexed).toHaveLength(20);
    expect(indexed).not.toContain('existing-key-0');
    expect(indexed).toContain('existing-key-10');
    expect(indexed).toContain('new-key');
  });

  it('returns cached user documents only for the current cache version', async () => {
    const store = makeStore();
    store.values.set('current', { version: 2, cachedAt: Date.now(), user: { id: 'user-1' } });
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
});
