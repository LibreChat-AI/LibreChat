import { Keyv } from 'keyv';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createMethods, createModels } from '@librechat/data-schemas';
import { AUTH_USER_DOC_BY_ID_PREFIX, CacheKeys } from 'librechat-data-provider';
import type { IUser } from '@librechat/data-schemas';
import {
  getCachedAuthUserDoc,
  setCachedAuthUserDoc,
  buildAuthUserDocCacheKey,
  AUTH_USER_DOC_CACHE_TTL_MS,
} from './userDocCache';
import { isTokenIssuedBeforeCredentialChange } from './credentials';

let mongoServer: MongoMemoryServer;
const originalCacheMode = process.env.AUTH_USER_CACHE_MODE;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  createModels(mongoose);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

afterEach(() => {
  if (originalCacheMode === undefined) {
    delete process.env.AUTH_USER_CACHE_MODE;
  } else {
    process.env.AUTH_USER_CACHE_MODE = originalCacheMode;
  }
});

describe('credential change with a failing auth cache', () => {
  it('rejects an old OpenID access token once the credential barrier passes, even when the reverse index cannot be read', async () => {
    process.env.AUTH_USER_CACHE_MODE = 'on';
    const store = new Keyv();
    /** The index read fails the way a throwing Redis store rejects a WRONGTYPE reply. */
    const failingStore = {
      get: async (key: string) => {
        if (key.startsWith(AUTH_USER_DOC_BY_ID_PREFIX)) {
          throw new Error('WRONGTYPE Operation against a key holding the wrong kind of value');
        }
        return store.get(key);
      },
      set: (key: string, value: unknown, ttl?: number) => store.set(key, value, ttl),
      delete: (key: string) => store.delete(key),
    };
    const methods = createMethods(mongoose, {
      getCache: (key: string) => (key === CacheKeys.AUTH_USER_DOC ? failingStore : undefined),
    });
    const user = (await methods.createUser(
      { email: 'oidc@example.com', provider: 'openid', openidId: 'subject-1' },
      undefined,
      true,
      true,
    )) as Partial<IUser>;
    const userId = String(user._id);
    const cacheKey = buildAuthUserDocCacheKey({ strategy: 'openid-jwt', subject: 'subject-1' });
    if (!cacheKey) {
      throw new Error('expected a cache key');
    }
    await setCachedAuthUserDoc(store, cacheKey, user);
    const oldToken = { iat: Math.floor(Date.now() / 1000) - 60 };
    expect(
      isTokenIssuedBeforeCredentialChange(oldToken, await getCachedAuthUserDoc(store, cacheKey)),
    ).toBe(false);

    const updated = await methods.updateUser(userId, {
      password: 'new-password-hash',
      credentialsChangedAt: new Date(),
    });
    const startedAt = Date.now();
    await methods.awaitAuthUserDocEviction(userId);

    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(AUTH_USER_DOC_CACHE_TTL_MS);
    expect(updated?.credentialsChangedAt).toBeInstanceOf(Date);
    await expect(getCachedAuthUserDoc(store, cacheKey)).resolves.toBeUndefined();
    const current = await methods.findUser({ openidId: 'subject-1' });
    expect(isTokenIssuedBeforeCredentialChange(oldToken, current)).toBe(true);
  }, 20_000);
});
