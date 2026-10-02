import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import {
  CacheKeys,
  AUTH_USER_DOC_BY_ID_PREFIX,
  AUTH_USER_DOC_CACHE_TTL_MS,
} from 'librechat-data-provider';
import type * as t from '~/types';
import { createUserMethods, USER_DELETION_FENCE_STALE_MS } from './user';
import balanceSchema from '~/schema/balance';
import userSchema from '~/schema/user';

/** Mocking crypto for generateToken */
jest.mock('~/crypto', () => ({
  signPayload: jest.fn().mockResolvedValue('mocked-token'),
}));

let mongoServer: MongoMemoryServer;
let User: mongoose.Model<t.IUser>;
let Balance: mongoose.Model<t.IBalance>;
let methods: ReturnType<typeof createUserMethods>;

const ORIGINAL_AUTH_USER_CACHE_ENV = {
  AUTH_USER_CACHE_MODE: process.env.AUTH_USER_CACHE_MODE,
};

function restoreAuthUserCacheEnv() {
  for (const [key, value] of Object.entries(ORIGINAL_AUTH_USER_CACHE_ENV)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

function enableAuthUserDocCache() {
  process.env.AUTH_USER_CACHE_MODE = 'on';
}

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  const mongoUri = mongoServer.getUri();
  await mongoose.connect(mongoUri);

  /** Register models */
  User = mongoose.models.User || mongoose.model<t.IUser>('User', userSchema);
  Balance = mongoose.models.Balance || mongoose.model<t.IBalance>('Balance', balanceSchema);

  /** Initialize methods */
  methods = createUserMethods(mongoose);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

beforeEach(async () => {
  restoreAuthUserCacheEnv();
  await mongoose.connection.dropDatabase();
});

afterEach(() => {
  restoreAuthUserCacheEnv();
});

describe('User schema indexes', () => {
  test('should define an issuer-bound idOnTheSource lookup index', async () => {
    await User.syncIndexes();

    const indexes = await User.collection.indexes();

    expect(indexes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: { idOnTheSource: 1, openidIssuer: 1, tenantId: 1 },
        }),
      ]),
    );
  });

  test('should allow the same OpenID subject from different issuers', async () => {
    await User.syncIndexes();

    await User.create({
      email: 'issuer-a@example.com',
      provider: 'openid',
      openidId: 'shared-sub',
      openidIssuer: 'https://issuer-a.example.com',
    });

    await expect(
      User.create({
        email: 'issuer-b@example.com',
        provider: 'openid',
        openidId: 'shared-sub',
        openidIssuer: 'https://issuer-b.example.com',
      }),
    ).resolves.toBeTruthy();

    await expect(
      User.create({
        email: 'issuer-a-duplicate@example.com',
        provider: 'openid',
        openidId: 'shared-sub',
        openidIssuer: 'https://issuer-a.example.com',
      }),
    ).rejects.toThrow(/duplicate key/);
  });
});

describe('User personalization', () => {
  test('defaults new users to the shared user workspace', async () => {
    const user = await User.create({
      email: 'stateful-default@example.com',
      provider: 'local',
    });

    expect(user.personalization?.statefulCodeEnvironment).toBe('user');
  });

  test('rejects unsupported stateful workspace defaults', async () => {
    await expect(
      User.create({
        email: 'invalid-stateful-default@example.com',
        provider: 'local',
        personalization: { statefulCodeEnvironment: 'agent' },
      }),
    ).rejects.toThrow();
  });
});

describe('User Methods - Database Tests', () => {
  describe('findOwnerContactUsers', () => {
    test('returns only projected owner contact rows for matching ids', async () => {
      const owner = await User.create({
        name: 'Ada Owner',
        username: 'ada',
        email: 'ada@example.com',
        provider: 'local',
      });
      await User.create({
        name: 'Other User',
        username: 'other',
        email: 'other@example.com',
        provider: 'local',
      });

      const rows = await methods.findOwnerContactUsers([
        owner._id.toString(),
        new mongoose.Types.ObjectId().toString(),
      ]);

      expect(rows).toEqual([{ _id: owner._id, name: 'Ada Owner', username: 'ada' }]);
      expect(rows[0]).not.toHaveProperty('email');
    });
  });
  describe('findUser', () => {
    test('should find user by exact email', async () => {
      await User.create({
        name: 'Test User',
        email: 'test@example.com',
        provider: 'local',
      });

      const found = await methods.findUser({ email: 'test@example.com' });

      expect(found).toBeDefined();
      expect(found?.email).toBe('test@example.com');
    });

    test('should find user by email with different case (case-insensitive)', async () => {
      await User.create({
        name: 'Test User',
        email: 'test@example.com', // stored lowercase by schema
        provider: 'local',
      });

      /** Test various case combinations - all should find the same user */
      const foundUpper = await methods.findUser({ email: 'TEST@EXAMPLE.COM' });
      const foundMixed = await methods.findUser({ email: 'Test@Example.COM' });
      const foundLower = await methods.findUser({ email: 'test@example.com' });

      expect(foundUpper).toBeDefined();
      expect(foundUpper?.email).toBe('test@example.com');

      expect(foundMixed).toBeDefined();
      expect(foundMixed?.email).toBe('test@example.com');

      expect(foundLower).toBeDefined();
      expect(foundLower?.email).toBe('test@example.com');
    });

    test('should find user by email with leading/trailing whitespace (trimmed)', async () => {
      await User.create({
        name: 'Test User',
        email: 'test@example.com',
        provider: 'local',
      });

      const foundWithSpaces = await methods.findUser({ email: '  test@example.com  ' });
      const foundWithTabs = await methods.findUser({ email: '\ttest@example.com\t' });

      expect(foundWithSpaces).toBeDefined();
      expect(foundWithSpaces?.email).toBe('test@example.com');

      expect(foundWithTabs).toBeDefined();
      expect(foundWithTabs?.email).toBe('test@example.com');
    });

    test('should find user by email with both case difference and whitespace', async () => {
      await User.create({
        name: 'Test User',
        email: 'john.doe@example.com',
        provider: 'local',
      });

      const found = await methods.findUser({ email: '  John.Doe@EXAMPLE.COM  ' });

      expect(found).toBeDefined();
      expect(found?.email).toBe('john.doe@example.com');
    });

    test('should normalize email in $or conditions', async () => {
      await User.create({
        name: 'Test User',
        email: 'test@example.com',
        provider: 'openid',
        openidId: 'openid-123',
      });

      const found = await methods.findUser({
        $or: [{ openidId: 'different-id' }, { email: 'TEST@EXAMPLE.COM' }],
      });

      expect(found).toBeDefined();
      expect(found?.email).toBe('test@example.com');
    });

    test('should find user by non-email criteria without affecting them', async () => {
      await User.create({
        name: 'Test User',
        email: 'test@example.com',
        provider: 'openid',
        openidId: 'openid-123',
      });

      const found = await methods.findUser({ openidId: 'openid-123' });

      expect(found).toBeDefined();
      expect(found?.openidId).toBe('openid-123');
    });

    test('should apply field selection correctly', async () => {
      await User.create({
        name: 'Test User',
        email: 'test@example.com',
        provider: 'local',
        username: 'testuser',
      });

      const found = await methods.findUser({ email: 'test@example.com' }, 'email name');

      expect(found).toBeDefined();
      expect(found?.email).toBe('test@example.com');
      expect(found?.name).toBe('Test User');
      expect(found?.username).toBeUndefined();
      expect(found?.provider).toBeUndefined();
    });

    test('should return null for non-existent user', async () => {
      const found = await methods.findUser({ email: 'nonexistent@example.com' });

      expect(found).toBeNull();
    });
  });

  describe('createUser', () => {
    test('should create a user and return ObjectId by default', async () => {
      const result = await methods.createUser({
        name: 'New User',
        email: 'new@example.com',
        provider: 'local',
      });

      expect(result).toBeInstanceOf(mongoose.Types.ObjectId);

      const user = await User.findById(result);
      expect(user).toBeDefined();
      expect(user?.name).toBe('New User');
      expect(user?.email).toBe('new@example.com');
    });

    test('should create a user and return user object when returnUser is true', async () => {
      const result = await methods.createUser(
        {
          name: 'New User',
          email: 'new@example.com',
          provider: 'local',
        },
        undefined,
        true,
        true,
      );

      expect(result).toHaveProperty('_id');
      expect(result).toHaveProperty('name', 'New User');
      expect(result).toHaveProperty('email', 'new@example.com');
    });

    test('should store email as lowercase regardless of input case', async () => {
      await methods.createUser({
        name: 'New User',
        email: 'NEW@EXAMPLE.COM',
        provider: 'local',
      });

      const user = await User.findOne({ email: 'new@example.com' });
      expect(user).toBeDefined();
      expect(user?.email).toBe('new@example.com');
    });

    test('should create user with TTL when disableTTL is false', async () => {
      const result = await methods.createUser(
        {
          name: 'TTL User',
          email: 'ttl@example.com',
          provider: 'local',
        },
        undefined,
        false,
        true,
      );

      expect(result).toHaveProperty('expiresAt');
      const expiresAt = (result as t.IUser).expiresAt;
      expect(expiresAt).toBeInstanceOf(Date);

      /** Should expire in approximately 1 week */
      const oneWeekMs = 604800 * 1000;
      const expectedExpiry = Date.now() + oneWeekMs;
      expect(expiresAt!.getTime()).toBeGreaterThan(expectedExpiry - 10000);
      expect(expiresAt!.getTime()).toBeLessThan(expectedExpiry + 10000);
    });

    test('should create balance record when balanceConfig is provided', async () => {
      const userId = await methods.createUser(
        {
          name: 'Balance User',
          email: 'balance@example.com',
          provider: 'local',
        },
        {
          enabled: true,
          startBalance: 1000,
        },
      );

      const balance = await Balance.findOne({ user: userId });
      expect(balance).toBeDefined();
      expect(balance?.tokenCredits).toBe(1000);
      expect(balance?._id.toString()).toBe(userId.toString());
    });
  });

  describe('updateUser', () => {
    test('should update user fields', async () => {
      const user = await User.create({
        name: 'Original Name',
        email: 'test@example.com',
        provider: 'local',
      });

      const updated = await methods.updateUser(user._id?.toString() ?? '', {
        name: 'Updated Name',
      });

      expect(updated).toBeDefined();
      expect(updated?.name).toBe('Updated Name');
      expect(updated?.email).toBe('test@example.com');
    });

    test('should remove expiresAt field on update', async () => {
      const user = await User.create({
        name: 'TTL User',
        email: 'ttl@example.com',
        provider: 'local',
        expiresAt: new Date(Date.now() + 604800 * 1000),
      });

      const updated = await methods.updateUser(user._id?.toString() || '', {
        name: 'No longer TTL',
      });

      expect(updated).toBeDefined();
      expect(updated?.expiresAt).toBeUndefined();
    });

    test.each([new Date(Date.now() + 604800 * 1000), undefined])(
      'should preserve expiresAt %s and invalidate auth cache when requested',
      async (expiresAt) => {
        enableAuthUserDocCache();
        const user = await User.create({
          name: 'Pending User',
          email: 'pending@example.com',
          provider: 'local',
          emailVerified: false,
          expiresAt,
        });
        const userId = user._id?.toString() ?? '';
        const indexKey = `${AUTH_USER_DOC_BY_ID_PREFIX}:${userId}`;
        const cache = {
          get: jest.fn().mockResolvedValue(['auth-cache-key']),
          set: jest.fn().mockResolvedValue(true),
          delete: jest.fn().mockResolvedValue(true),
        };
        const methodsWithCache = createUserMethods(mongoose, { getCache: () => cache });

        const updated = await methodsWithCache.updateUser(
          userId,
          { password: 'new-password-hash', credentialsChangedAt: new Date() },
          {},
          { preserveExpiresAt: true },
        );

        const stored = await User.findById(userId).select('+password').lean();
        expect(stored?.password).toBe('new-password-hash');
        expect(updated?.credentialsChangedAt).toBeInstanceOf(Date);
        expect(updated?.emailVerified).toBe(false);
        expect(updated?.expiresAt).toEqual(expiresAt);
        expect(cache.get).toHaveBeenCalledWith(indexKey);
        expect(cache.delete).toHaveBeenCalledWith('auth-cache-key');
        expect(cache.delete).toHaveBeenCalledWith(indexKey);
      },
    );

    test('should update only when the expected account state still matches', async () => {
      const user = await User.create({
        name: 'Conditional User',
        email: 'original@example.com',
        password: 'original-password-hash',
        provider: 'local',
      });

      const staleUpdate = await methods.updateUser(
        user._id?.toString() ?? '',
        { email: 'stale@example.com' },
        { email: 'different@example.com', password: 'original-password-hash' },
      );
      const currentUpdate = await methods.updateUser(
        user._id?.toString() ?? '',
        { email: 'current@example.com' },
        { email: 'original@example.com', password: 'original-password-hash' },
      );

      expect(staleUpdate).toBeNull();
      expect(currentUpdate?.email).toBe('current@example.com');
    });

    test('should invalidate cached auth user documents on update', async () => {
      enableAuthUserDocCache();
      const user = await User.create({
        name: 'Cached Auth User',
        email: 'cached-auth@example.com',
        provider: 'openid',
      });
      const indexKey = `${AUTH_USER_DOC_BY_ID_PREFIX}:${user._id?.toString()}`;
      const cache = {
        get: jest.fn().mockResolvedValue(['auth-cache-key-a', 'auth-cache-key-b']),
        delete: jest.fn().mockResolvedValue(true),
      };
      const getCache = jest.fn().mockReturnValue(cache);
      const methodsWithCache = createUserMethods(mongoose, { getCache });

      await methodsWithCache.updateUser(user._id?.toString() ?? '', {
        name: 'Updated Cached Auth User',
      });

      expect(getCache).toHaveBeenCalledWith(CacheKeys.AUTH_USER_DOC);
      expect(cache.get).toHaveBeenCalledWith(indexKey);
      expect(cache.delete).toHaveBeenCalledWith('auth-cache-key-a');
      expect(cache.delete).toHaveBeenCalledWith('auth-cache-key-b');
      expect(cache.delete).toHaveBeenCalledWith(indexKey);
    });

    describe('when auth cache eviction fails', () => {
      const cachedKeys = ['auth-cache-key-a', 'auth-cache-key-b'];

      /** Rejects the named operations the way the throwing Redis-backed auth cache does. */
      function makeFailingCache(failing: { indexRead?: boolean; deleteKey?: string }) {
        return {
          get: jest.fn(async () => {
            if (failing.indexRead) {
              throw new Error('WRONGTYPE');
            }
            return cachedKeys;
          }),
          set: jest.fn().mockResolvedValue(true),
          delete: jest.fn(async (key: string) => {
            if (key === failing.deleteKey) {
              throw new Error('redis unavailable');
            }
            return true;
          }),
        };
      }

      async function createCachedUser() {
        enableAuthUserDocCache();
        const user = await User.create({
          name: 'Credential User',
          email: 'credential@example.com',
          provider: 'openid',
        });
        return user._id?.toString() ?? '';
      }

      test.each<[string, { indexRead?: boolean; deleteKey?: string }]>([
        ['the reverse index read fails', { indexRead: true }],
        ['an indexed document delete fails', { deleteKey: 'auth-cache-key-a' }],
      ])('waits out the cache TTL at the credential barrier when %s', async (_label, failing) => {
        const userId = await createCachedUser();
        const cache = makeFailingCache(failing);
        const delay = jest.fn().mockResolvedValue(undefined);
        const methodsWithCache = createUserMethods(mongoose, { getCache: () => cache, delay });

        const updated = await methodsWithCache.updateUser(userId, {
          password: 'new-password-hash',
          credentialsChangedAt: new Date(),
        });
        expect(updated?.credentialsChangedAt).toBeInstanceOf(Date);
        expect(delay).not.toHaveBeenCalled();

        await methodsWithCache.awaitAuthUserDocEviction(userId);

        expect(delay).toHaveBeenCalledTimes(1);
        expect(delay.mock.calls[0][0]).toBeGreaterThan(AUTH_USER_DOC_CACHE_TTL_MS);
        expect(cache.delete).not.toHaveBeenCalledWith(`${AUTH_USER_DOC_BY_ID_PREFIX}:${userId}`);
        if (!failing.indexRead) {
          expect(cache.delete).toHaveBeenCalledWith('auth-cache-key-b');
        }
      });

      test('passes the barrier at once when only the index delete fails', async () => {
        const userId = await createCachedUser();
        const cache = makeFailingCache({ deleteKey: `${AUTH_USER_DOC_BY_ID_PREFIX}:${userId}` });
        const delay = jest.fn().mockResolvedValue(undefined);
        const methodsWithCache = createUserMethods(mongoose, { getCache: () => cache, delay });

        await methodsWithCache.awaitAuthUserDocEviction(userId);

        expect(cache.delete).toHaveBeenCalledWith('auth-cache-key-a');
        expect(cache.delete).toHaveBeenCalledWith('auth-cache-key-b');
        expect(delay).not.toHaveBeenCalled();
      });

      test('passes the barrier at once when a retried eviction succeeds', async () => {
        const userId = await createCachedUser();
        const cache = makeFailingCache({ indexRead: true });
        const delay = jest.fn().mockResolvedValue(undefined);
        const methodsWithCache = createUserMethods(mongoose, { getCache: () => cache, delay });

        await methodsWithCache.updateUser(userId, { credentialsChangedAt: new Date() });
        cache.get.mockResolvedValue(cachedKeys);
        await methodsWithCache.awaitAuthUserDocEviction(userId);

        expect(cache.delete).toHaveBeenCalledWith('auth-cache-key-a');
        expect(delay).not.toHaveBeenCalled();
      });

      test('waits at the barrier when the cache can read but not delete', async () => {
        const userId = await createCachedUser();
        const delay = jest.fn().mockResolvedValue(undefined);
        const methodsWithCache = createUserMethods(mongoose, {
          getCache: () => ({ get: jest.fn(), set: jest.fn() }),
          delay,
        });

        await methodsWithCache.awaitAuthUserDocEviction(userId);

        expect(delay).toHaveBeenCalledTimes(1);
      });

      test('keeps updates themselves best effort', async () => {
        const userId = await createCachedUser();
        const delay = jest.fn().mockResolvedValue(undefined);
        const methodsWithCache = createUserMethods(mongoose, {
          getCache: () => makeFailingCache({ indexRead: true }),
          delay,
        });

        const updated = await methodsWithCache.updateUser(userId, { name: 'Renamed' });

        expect(updated?.name).toBe('Renamed');
        expect(delay).not.toHaveBeenCalled();
      });
    });

    test('should invalidate cached auth user documents on delete', async () => {
      enableAuthUserDocCache();
      const user = await User.create({
        name: 'Deleted Cached Auth User',
        email: 'deleted-cached-auth@example.com',
        provider: 'openid',
      });
      const indexKey = `${AUTH_USER_DOC_BY_ID_PREFIX}:${user._id?.toString()}`;
      const cache = {
        get: jest.fn().mockResolvedValue(['auth-cache-key-a']),
        delete: jest.fn().mockResolvedValue(true),
      };
      const getCache = jest.fn().mockReturnValue(cache);
      const methodsWithCache = createUserMethods(mongoose, { getCache });

      await methodsWithCache.deleteUserById(user._id?.toString() ?? '');

      expect(getCache).toHaveBeenCalledWith(CacheKeys.AUTH_USER_DOC);
      expect(cache.get).toHaveBeenCalledWith(indexKey);
      expect(cache.delete).toHaveBeenCalledWith('auth-cache-key-a');
      expect(cache.delete).toHaveBeenCalledWith(indexKey);
    });

    test('should return null for non-existent user', async () => {
      const fakeId = new mongoose.Types.ObjectId();
      const result = await methods.updateUser(fakeId.toString(), { name: 'Test' });

      expect(result).toBeNull();
    });
  });

  describe('claimSamlIdentity', () => {
    test('should atomically bind an unbound SAML user', async () => {
      const user = await User.create({
        name: 'Legacy SAML User',
        email: 'legacy-saml@example.com',
        provider: 'saml',
      });

      const updated = await methods.claimSamlIdentity(user._id?.toString() ?? '', 'saml-123', {
        name: 'Current SAML User',
      });

      expect(updated).toMatchObject({
        name: 'Current SAML User',
        samlId: 'saml-123',
      });
    });

    test('should preserve an existing different SAML binding', async () => {
      const user = await User.create({
        email: 'bound-saml@example.com',
        provider: 'saml',
        samlId: 'original-saml-id',
      });

      const updated = await methods.claimSamlIdentity(user._id?.toString() ?? '', 'new-saml-id', {
        name: 'Untrusted Name',
      });
      const stored = await User.findById(user._id).lean<t.IUser>();

      expect(updated).toBeNull();
      expect(stored).toMatchObject({ samlId: 'original-saml-id' });
      expect(stored?.name).not.toBe('Untrusted Name');
    });

    test('should update a user when the SAML binding already matches', async () => {
      const user = await User.create({
        email: 'matching-saml@example.com',
        provider: 'saml',
        samlId: 'saml-123',
      });

      const updated = await methods.claimSamlIdentity(user._id?.toString() ?? '', 'saml-123', {
        name: 'Updated Name',
      });

      expect(updated).toMatchObject({
        name: 'Updated Name',
        samlId: 'saml-123',
      });
    });

    test('should not convert a user registered with a different provider', async () => {
      const user = await User.create({
        email: 'local-user@example.com',
        provider: 'local',
      });

      const updated = await methods.claimSamlIdentity(user._id?.toString() ?? '', 'saml-123', {});
      const stored = await User.findById(user._id).lean<t.IUser>();

      expect(updated).toBeNull();
      expect(stored).toMatchObject({ provider: 'local' });
      expect(stored?.samlId).toBeUndefined();
    });

    test('should allow only one concurrent first-time SAML binding', async () => {
      const user = await User.create({
        email: 'concurrent-saml@example.com',
        provider: 'saml',
      });
      const userId = user._id?.toString() ?? '';

      const results = await Promise.all([
        methods.claimSamlIdentity(userId, 'saml-a', { name: 'Identity A' }),
        methods.claimSamlIdentity(userId, 'saml-b', { name: 'Identity B' }),
      ]);
      const stored = await User.findById(user._id).lean<t.IUser>();

      expect(results.filter(Boolean)).toHaveLength(1);
      expect(['saml-a', 'saml-b']).toContain(stored?.samlId);
      expect(results.find(Boolean)?.samlId).toBe(stored?.samlId);
    });

    test('should invalidate cached auth documents after a successful claim', async () => {
      enableAuthUserDocCache();
      const user = await User.create({
        email: 'cached-saml@example.com',
        provider: 'saml',
      });
      const userId = user._id?.toString() ?? '';
      const indexKey = `${AUTH_USER_DOC_BY_ID_PREFIX}:${userId}`;
      const cache = {
        get: jest.fn().mockResolvedValue(['auth-cache-key']),
        delete: jest.fn().mockResolvedValue(true),
      };
      const methodsWithCache = createUserMethods(mongoose, {
        getCache: jest.fn().mockReturnValue(cache),
      });

      await methodsWithCache.claimSamlIdentity(userId, 'saml-123', {});

      expect(cache.get).toHaveBeenCalledWith(indexKey);
      expect(cache.delete).toHaveBeenCalledWith('auth-cache-key');
      expect(cache.delete).toHaveBeenCalledWith(indexKey);
    });

    test('should not invalidate cached auth documents after a rejected claim', async () => {
      enableAuthUserDocCache();
      const user = await User.create({
        email: 'cached-bound-saml@example.com',
        provider: 'saml',
        samlId: 'original-saml-id',
      });
      const cache = {
        get: jest.fn(),
        delete: jest.fn(),
      };
      const getCache = jest.fn().mockReturnValue(cache);
      const methodsWithCache = createUserMethods(mongoose, { getCache });

      const updated = await methodsWithCache.claimSamlIdentity(
        user._id?.toString() ?? '',
        'different-saml-id',
        {},
      );

      expect(updated).toBeNull();
      expect(getCache).not.toHaveBeenCalled();
      expect(cache.get).not.toHaveBeenCalled();
      expect(cache.delete).not.toHaveBeenCalled();
    });
  });

  describe('updateTwoFactorEnrollment', () => {
    const ACK_HASH = 'acknowledgement-nonce-hash';
    const FINAL_HASH = 'finalization-nonce-hash';

    async function createEnrollingUser(
      email: string,
      overrides: Partial<t.IUser> = {},
    ): Promise<{ id: string; pendingBackupCodes: NonNullable<t.IUser['pendingBackupCodes']> }> {
      const user = await User.create({
        name: 'Enrolling User',
        email,
        provider: 'local',
        twoFactorEnabled: false,
        pendingTotpSecret: 'pending-secret',
        pendingBackupCodes: [{ codeHash: 'staged-hash', used: false }],
        ...overrides,
      });
      const id = user._id.toString();
      const stored = await User.findById(user._id).select('+pendingBackupCodes').lean<t.IUser>();
      return { id, pendingBackupCodes: stored?.pendingBackupCodes ?? [] };
    }

    function readEnrollment(userId: string) {
      return User.findById(userId)
        .select(
          '+totpSecret +backupCodes +pendingTotpSecret +pendingBackupCodes +twoFactorAcknowledgementNonceHash +twoFactorFinalizationNonceHash',
        )
        .lean<t.IUser>();
    }

    test('stages rotated backup codes and an acknowledgement nonce without enabling 2FA', async () => {
      const { id, pendingBackupCodes } = await createEnrollingUser('stage-2fa@example.com');

      const updated = await methods.updateTwoFactorEnrollment(
        id,
        { pendingTotpSecret: 'pending-secret', pendingBackupCodes },
        {
          pendingBackupCodes: [{ codeHash: 'deliverable-hash', used: false, usedAt: null }],
          twoFactorAcknowledgementNonceHash: ACK_HASH,
          twoFactorFinalizationNonceHash: null,
        },
      );
      const stored = await readEnrollment(id);

      expect(updated).not.toBeNull();
      expect(stored?.twoFactorEnabled).toBe(false);
      expect(stored?.totpSecret).toBeFalsy();
      expect(stored?.pendingTotpSecret).toBe('pending-secret');
      expect(stored?.pendingBackupCodes).toMatchObject([{ codeHash: 'deliverable-hash' }]);
      expect(stored?.twoFactorAcknowledgementNonceHash).toBe(ACK_HASH);
      expect(stored?.twoFactorFinalizationNonceHash).toBeNull();
    });

    test('updates legacy enrolling users whose two-factor flag is missing', async () => {
      const { id, pendingBackupCodes } = await createEnrollingUser('legacy-2fa@example.com');
      const objectId = new mongoose.Types.ObjectId(id);
      await User.collection.updateOne({ _id: objectId }, { $unset: { twoFactorEnabled: '' } });

      const legacyUser = await User.collection.findOne({ _id: objectId });
      expect(legacyUser).not.toHaveProperty('twoFactorEnabled');

      const updated = await methods.updateTwoFactorEnrollment(
        id,
        { pendingTotpSecret: 'pending-secret', pendingBackupCodes },
        { twoFactorAcknowledgementNonceHash: ACK_HASH },
      );
      const stored = await readEnrollment(id);

      expect(updated).not.toBeNull();
      expect(stored?.twoFactorAcknowledgementNonceHash).toBe(ACK_HASH);
    });

    test('a second confirmation on the stale snapshot loses the race and writes nothing', async () => {
      const { id, pendingBackupCodes } = await createEnrollingUser('confirm-race@example.com');
      const guard = { pendingTotpSecret: 'pending-secret', pendingBackupCodes };

      const first = await methods.updateTwoFactorEnrollment(id, guard, {
        pendingBackupCodes: [{ codeHash: 'first-hash', used: false, usedAt: null }],
        twoFactorAcknowledgementNonceHash: 'first-ack',
      });
      const second = await methods.updateTwoFactorEnrollment(id, guard, {
        pendingBackupCodes: [{ codeHash: 'second-hash', used: false, usedAt: null }],
        twoFactorAcknowledgementNonceHash: 'second-ack',
      });
      const stored = await readEnrollment(id);

      expect(first).not.toBeNull();
      expect(second).toBeNull();
      expect(stored?.pendingBackupCodes).toMatchObject([{ codeHash: 'first-hash' }]);
      expect(stored?.twoFactorAcknowledgementNonceHash).toBe('first-ack');
    });

    test('consumes the acknowledgement nonce exactly once and keeps 2FA disabled', async () => {
      const { id } = await createEnrollingUser('ack-2fa@example.com', {
        twoFactorAcknowledgementNonceHash: ACK_HASH,
      });

      const first = await methods.updateTwoFactorEnrollment(
        id,
        { twoFactorAcknowledgementNonceHash: ACK_HASH },
        {
          twoFactorAcknowledgementNonceHash: null,
          twoFactorFinalizationNonceHash: FINAL_HASH,
        },
      );
      const replay = await methods.updateTwoFactorEnrollment(
        id,
        { twoFactorAcknowledgementNonceHash: ACK_HASH },
        {
          twoFactorAcknowledgementNonceHash: null,
          twoFactorFinalizationNonceHash: 'replayed-finalization-hash',
        },
      );
      const stored = await readEnrollment(id);

      expect(first).not.toBeNull();
      expect(replay).toBeNull();
      expect(stored?.twoFactorEnabled).toBe(false);
      expect(stored?.twoFactorFinalizationNonceHash).toBe(FINAL_HASH);
    });

    test('promotes the pending enrollment once and clears every enrollment field', async () => {
      const { id, pendingBackupCodes } = await createEnrollingUser('finalize-2fa@example.com', {
        twoFactorFinalizationNonceHash: FINAL_HASH,
        expiresAt: new Date(Date.now() + 604800 * 1000),
      });
      const guard = {
        pendingTotpSecret: 'pending-secret',
        pendingBackupCodes,
        twoFactorFinalizationNonceHash: FINAL_HASH,
      };
      const promotion = {
        totpSecret: 'pending-secret',
        backupCodes: pendingBackupCodes,
        twoFactorEnabled: true,
        pendingTotpSecret: null,
        pendingBackupCodes: [],
        twoFactorAcknowledgementNonceHash: null,
        twoFactorFinalizationNonceHash: null,
      };

      const promoted = await methods.updateTwoFactorEnrollment(id, guard, promotion);
      const replay = await methods.updateTwoFactorEnrollment(id, guard, promotion);
      const stored = await readEnrollment(id);

      expect(promoted).not.toBeNull();
      expect(promoted).toMatchObject({
        name: 'Enrolling User',
        email: 'finalize-2fa@example.com',
        provider: 'local',
        twoFactorEnabled: true,
      });
      expect(promoted?.createdAt).toBeInstanceOf(Date);
      expect(replay).toBeNull();
      expect(stored).toMatchObject({
        twoFactorEnabled: true,
        totpSecret: 'pending-secret',
        pendingTotpSecret: null,
        pendingBackupCodes: [],
        twoFactorAcknowledgementNonceHash: null,
        twoFactorFinalizationNonceHash: null,
      });
      expect(stored?.backupCodes).toMatchObject([{ codeHash: 'staged-hash' }]);
      expect(stored?.expiresAt).toBeUndefined();
    });

    test('persists the enrollment cutoff that retires pre-enrollment access tokens', async () => {
      const { id, pendingBackupCodes } = await createEnrollingUser('cutoff-2fa@example.com', {
        twoFactorFinalizationNonceHash: FINAL_HASH,
      });
      const twoFactorEnrolledAt = new Date();

      const promoted = await methods.updateTwoFactorEnrollment(
        id,
        {
          pendingTotpSecret: 'pending-secret',
          pendingBackupCodes,
          twoFactorFinalizationNonceHash: FINAL_HASH,
        },
        {
          totpSecret: 'pending-secret',
          backupCodes: pendingBackupCodes,
          twoFactorEnabled: true,
          twoFactorEnrolledAt,
          pendingTotpSecret: null,
          pendingBackupCodes: [],
          twoFactorAcknowledgementNonceHash: null,
          twoFactorFinalizationNonceHash: null,
        },
      );
      const stored = await readEnrollment(id);

      expect(promoted).not.toBeNull();
      /** A path the schema does not declare is dropped in silence, so assert the round trip. */
      expect(stored?.twoFactorEnrolledAt).toBeInstanceOf(Date);
      expect(stored?.twoFactorEnrolledAt?.getTime()).toBe(twoFactorEnrolledAt.getTime());
    });

    test('leaves the enrollment cutoff null until a promotion writes it', async () => {
      const { id } = await createEnrollingUser('no-cutoff-2fa@example.com');

      const stored = await readEnrollment(id);

      expect(stored?.twoFactorEnrolledAt).toBeNull();
    });

    const concurrentTransitions: Array<[string, Partial<t.IUser>]> = [
      ['regenerated secret', { pendingTotpSecret: 'different-secret' }],
      [
        'regenerated backup codes',
        { pendingBackupCodes: [{ codeHash: 'different-hash', used: false }] },
      ],
      ['federated provider transition', { provider: 'openid' }],
      ['already-enabled transition', { twoFactorEnabled: true }],
      ['cleared finalization nonce', { twoFactorFinalizationNonceHash: null }],
    ];

    test.each(concurrentTransitions)(
      'does not promote after a concurrent %s',
      async (name, concurrentUpdate) => {
        const { id, pendingBackupCodes } = await createEnrollingUser(
          `raced-2fa-${name.replace(/ /g, '-')}@example.com`,
          { twoFactorFinalizationNonceHash: FINAL_HASH },
        );
        await User.findByIdAndUpdate(id, { $set: concurrentUpdate });

        const promoted = await methods.updateTwoFactorEnrollment(
          id,
          {
            pendingTotpSecret: 'pending-secret',
            pendingBackupCodes,
            twoFactorFinalizationNonceHash: FINAL_HASH,
          },
          {
            totpSecret: 'pending-secret',
            backupCodes: pendingBackupCodes,
            twoFactorEnabled: true,
            pendingTotpSecret: null,
            pendingBackupCodes: [],
            twoFactorAcknowledgementNonceHash: null,
            twoFactorFinalizationNonceHash: null,
          },
        );
        const stored = await readEnrollment(id);

        expect(promoted).toBeNull();
        expect(stored?.totpSecret).toBeFalsy();
        expect(stored?.twoFactorEnabled).toBe(concurrentUpdate.twoFactorEnabled === true);
      },
    );

    test('never exposes nonce state on an unprojected read', async () => {
      const { id } = await createEnrollingUser('nonce-projection@example.com', {
        twoFactorAcknowledgementNonceHash: ACK_HASH,
        twoFactorFinalizationNonceHash: FINAL_HASH,
      });

      const user = await methods.getUserById(id);

      expect(user).not.toBeNull();
      expect(user).not.toHaveProperty('twoFactorAcknowledgementNonceHash');
      expect(user).not.toHaveProperty('twoFactorFinalizationNonceHash');
      expect(user).not.toHaveProperty('pendingTotpSecret');
    });

    test('invalidates cached auth user documents after a successful enrollment write', async () => {
      enableAuthUserDocCache();
      const { id, pendingBackupCodes } = await createEnrollingUser('cached-2fa@example.com');
      const cache = {
        get: jest.fn().mockResolvedValue(['cached-auth-document']),
        delete: jest.fn().mockResolvedValue(true),
      };
      const methodsWithCache = createUserMethods(mongoose, {
        getCache: jest.fn().mockReturnValue(cache),
      });

      await methodsWithCache.updateTwoFactorEnrollment(
        id,
        { pendingTotpSecret: 'pending-secret', pendingBackupCodes },
        { twoFactorAcknowledgementNonceHash: ACK_HASH },
      );

      expect(cache.delete).toHaveBeenCalledWith('cached-auth-document');
      expect(cache.delete).toHaveBeenCalledWith(`${AUTH_USER_DOC_BY_ID_PREFIX}:${id}`);
    });

    test('leaves the auth user document cache untouched when the guard loses', async () => {
      enableAuthUserDocCache();
      const { id } = await createEnrollingUser('cached-2fa-miss@example.com');
      const cache = {
        get: jest.fn().mockResolvedValue(['cached-auth-document']),
        delete: jest.fn().mockResolvedValue(true),
      };
      const methodsWithCache = createUserMethods(mongoose, {
        getCache: jest.fn().mockReturnValue(cache),
      });

      const result = await methodsWithCache.updateTwoFactorEnrollment(
        id,
        { pendingTotpSecret: 'stale-secret' },
        { twoFactorAcknowledgementNonceHash: ACK_HASH },
      );

      expect(result).toBeNull();
      expect(cache.delete).not.toHaveBeenCalled();
    });
  });

  describe('getUserById', () => {
    test('should get user by ID', async () => {
      const user = await User.create({
        name: 'Test User',
        email: 'test@example.com',
        provider: 'local',
      });

      const found = await methods.getUserById(user._id?.toString() || '');

      expect(found).toBeDefined();
      expect(found?.name).toBe('Test User');
    });

    test('should apply field selection', async () => {
      const user = await User.create({
        name: 'Test User',
        email: 'test@example.com',
        provider: 'local',
        username: 'testuser',
      });

      const found = await methods.getUserById(user._id?.toString() || '', 'name email');

      expect(found).toBeDefined();
      expect(found?.name).toBe('Test User');
      expect(found?.email).toBe('test@example.com');
      expect(found?.username).toBeUndefined();
    });

    test('should return null for non-existent ID', async () => {
      const fakeId = new mongoose.Types.ObjectId();
      const found = await methods.getUserById(fakeId.toString());

      expect(found).toBeNull();
    });
  });

  describe('acceptTerms', () => {
    test('sets termsAccepted and stamps termsAcceptedAt on first acceptance', async () => {
      const user = await User.create({
        name: 'Terms User',
        email: 'terms@example.com',
        provider: 'local',
      });

      const before = Date.now();
      const updated = await methods.acceptTerms(user._id?.toString() ?? '');
      const after = Date.now();

      expect(updated?.termsAccepted).toBe(true);
      expect(updated?.termsAcceptedAt).toBeInstanceOf(Date);
      const stamped = (updated?.termsAcceptedAt as Date).getTime();
      expect(stamped).toBeGreaterThanOrEqual(before - 1000);
      expect(stamped).toBeLessThanOrEqual(after + 1000);
    });

    test('preserves the original termsAcceptedAt on repeat acceptance', async () => {
      const originalAcceptedAt = new Date('2026-01-01T00:00:00.000Z');
      const user = await User.create({
        name: 'Repeat User',
        email: 'repeat@example.com',
        provider: 'local',
        termsAccepted: true,
        termsAcceptedAt: originalAcceptedAt,
      });

      const updated = await methods.acceptTerms(user._id?.toString() ?? '');

      expect(updated?.termsAccepted).toBe(true);
      expect((updated?.termsAcceptedAt as Date).getTime()).toBe(originalAcceptedAt.getTime());
    });

    test('backfills termsAcceptedAt for a legacy accepted user without a timestamp', async () => {
      const user = await User.create({
        name: 'Legacy User',
        email: 'legacy@example.com',
        provider: 'local',
        termsAccepted: true,
      });

      const updated = await methods.acceptTerms(user._id?.toString() ?? '');

      expect(updated?.termsAccepted).toBe(true);
      expect(updated?.termsAcceptedAt).toBeInstanceOf(Date);
    });

    test('returns null for non-existent user', async () => {
      const fakeId = new mongoose.Types.ObjectId();
      const result = await methods.acceptTerms(fakeId.toString());

      expect(result).toBeNull();
    });

    test('stamps a fresh termsAcceptedAt when accepting after a terms reset', async () => {
      const user = await User.create({
        name: 'Reset User',
        email: 'reset-terms@example.com',
        provider: 'local',
      });
      const userId = user._id?.toString() ?? '';
      const first = await methods.acceptTerms(userId);

      await User.updateOne(
        { _id: userId },
        { $set: { termsAccepted: false, termsAcceptedAt: null } },
      );
      const reaccepted = await methods.acceptTerms(userId);

      expect(reaccepted?.termsAccepted).toBe(true);
      expect(reaccepted?.termsAcceptedAt).toBeInstanceOf(Date);
      expect((reaccepted?.termsAcceptedAt as Date).getTime()).toBeGreaterThanOrEqual(
        (first?.termsAcceptedAt as Date).getTime(),
      );
    });

    test('stamps termsAcceptedAt for a legacy document missing the field entirely', async () => {
      const legacyId = new mongoose.Types.ObjectId();
      await User.collection.insertOne({
        _id: legacyId,
        name: 'Pre-Terms User',
        email: 'pre-terms@example.com',
        provider: 'local',
      });

      const updated = await methods.acceptTerms(legacyId.toString());

      expect(updated?.termsAccepted).toBe(true);
      expect(updated?.termsAcceptedAt).toBeInstanceOf(Date);
    });

    test('converges on a single termsAcceptedAt under concurrent acceptance', async () => {
      const user = await User.create({
        name: 'Concurrent User',
        email: 'concurrent-terms@example.com',
        provider: 'local',
      });
      const userId = user._id?.toString() ?? '';

      const results = await Promise.all(
        Array.from({ length: 5 }, () => methods.acceptTerms(userId)),
      );

      expect(results.every((result) => result?.termsAccepted === true)).toBe(true);
      const stampedTimes = new Set(
        results.map((result) => (result?.termsAcceptedAt as Date).getTime()),
      );
      expect(stampedTimes.size).toBe(1);

      const repeat = await methods.acceptTerms(userId);
      expect((repeat?.termsAcceptedAt as Date).getTime()).toBe([...stampedTimes][0]);
    });

    test('should invalidate cached auth user documents on acceptance', async () => {
      enableAuthUserDocCache();
      const user = await User.create({
        name: 'Cached Terms User',
        email: 'cached-terms@example.com',
        provider: 'openid',
      });
      const indexKey = `${AUTH_USER_DOC_BY_ID_PREFIX}:${user._id?.toString()}`;
      const cache = {
        get: jest.fn().mockResolvedValue(['auth-cache-key-a']),
        delete: jest.fn().mockResolvedValue(true),
      };
      const getCache = jest.fn().mockReturnValue(cache);
      const methodsWithCache = createUserMethods(mongoose, { getCache });

      await methodsWithCache.acceptTerms(user._id?.toString() ?? '');

      expect(getCache).toHaveBeenCalledWith(CacheKeys.AUTH_USER_DOC);
      expect(cache.get).toHaveBeenCalledWith(indexKey);
      expect(cache.delete).toHaveBeenCalledWith('auth-cache-key-a');
      expect(cache.delete).toHaveBeenCalledWith(indexKey);
    });
  });

  describe('deleteUserById', () => {
    test('should delete user by ID', async () => {
      const user = await User.create({
        name: 'To Delete',
        email: 'delete@example.com',
        provider: 'local',
      });

      const result = await methods.deleteUserById(user._id?.toString() || '');

      expect(result.deletedCount).toBe(1);
      expect(result.message).toBe('User was deleted successfully.');

      const found = await User.findById(user._id);
      expect(found).toBeNull();
    });

    test('should return zero count for non-existent user', async () => {
      const fakeId = new mongoose.Types.ObjectId();
      const result = await methods.deleteUserById(fakeId.toString());

      expect(result.deletedCount).toBe(0);
      expect(result.message).toBe('No user found with that ID.');
    });
  });

  describe('agent trigger account-deletion fence', () => {
    test('blocks trigger admission until the owning deletion attempt releases it', async () => {
      const user = await User.create({
        name: 'Trigger Fence',
        email: 'trigger-fence@example.com',
        provider: 'local',
      });
      const userId = user._id.toString();
      const startedAt = new Date('2026-08-17T12:00:00.000Z');

      await expect(methods.isAgentTriggerPrincipalActive(userId)).resolves.toBe(true);
      await expect(methods.beginAgentTriggerUserDeletion(userId, startedAt)).resolves.toBe(
        'acquired',
      );
      await expect(methods.isAgentTriggerPrincipalActive(userId)).resolves.toBe(false);
      await expect(
        methods.beginAgentTriggerUserDeletion(userId, new Date(startedAt.getTime() + 1)),
      ).resolves.toBe('in_progress');
      await expect(
        methods.cancelAgentTriggerUserDeletion(userId, new Date(startedAt.getTime() + 1)),
      ).resolves.toBe(false);
      await expect(methods.cancelAgentTriggerUserDeletion(userId, startedAt)).resolves.toBe(true);
      await expect(methods.isAgentTriggerPrincipalActive(userId)).resolves.toBe(true);
    });

    test('reports a missing principal without creating a deletion fence', async () => {
      const userId = new mongoose.Types.ObjectId().toString();

      await expect(methods.beginAgentTriggerUserDeletion(userId, new Date())).resolves.toBe(
        'missing',
      );
      await expect(methods.isAgentTriggerPrincipalActive(userId)).resolves.toBe(false);
    });

    test('requires explicit stale-fence recovery and preserves successor ownership', async () => {
      const user = await User.create({
        name: 'Stale Trigger Fence',
        email: 'stale-trigger-fence@example.com',
        provider: 'local',
      });
      const userId = user._id.toString();
      const abandonedAt = new Date('2026-08-17T12:00:00.000Z');
      const takeoverAt = new Date(abandonedAt.getTime() + USER_DELETION_FENCE_STALE_MS + 1);

      await expect(methods.beginAgentTriggerUserDeletion(userId, abandonedAt)).resolves.toBe(
        'acquired',
      );
      await expect(methods.beginAgentTriggerUserDeletion(userId, takeoverAt)).resolves.toBe(
        'in_progress',
      );
      await expect(
        methods.recoverStaleAgentTriggerUserDeletion(
          userId,
          new Date(abandonedAt.getTime() + USER_DELETION_FENCE_STALE_MS - 1),
        ),
      ).resolves.toBe('in_progress');
      await expect(methods.recoverStaleAgentTriggerUserDeletion(userId, takeoverAt)).resolves.toBe(
        'acquired',
      );
      await expect(methods.cancelAgentTriggerUserDeletion(userId, abandonedAt)).resolves.toBe(
        false,
      );
      await expect(methods.isAgentTriggerPrincipalActive(userId)).resolves.toBe(false);
      await expect(methods.cancelAgentTriggerUserDeletion(userId, takeoverAt)).resolves.toBe(true);
      await expect(methods.isAgentTriggerPrincipalActive(userId)).resolves.toBe(true);
    });

    test('rejects invalid deletion-fence timestamps', async () => {
      const userId = new mongoose.Types.ObjectId().toString();

      await expect(
        methods.beginAgentTriggerUserDeletion(userId, new Date(Number.NaN)),
      ).rejects.toThrow('startedAt must be a valid Date');
      await expect(
        methods.recoverStaleAgentTriggerUserDeletion(userId, new Date(Number.NaN)),
      ).rejects.toThrow('recoveredAt must be a valid Date');
    });
  });

  describe('subagent admission fence', () => {
    test('closes admission until the deletion that took the fence releases it', async () => {
      const user = await User.create({
        name: 'Subagent Fence',
        email: 'subagent-fence@example.com',
        provider: 'local',
      });
      const userId = user._id.toString();
      const fencedUntil = new Date(Date.now() + 60_000);

      await expect(methods.isSubagentOwnerAdmissible(userId)).resolves.toBe(true);
      await methods.fenceSubagentAdmission(userId, 'deletion-a', fencedUntil);
      await expect(methods.isSubagentOwnerAdmissible(userId)).resolves.toBe(false);

      /** Each overlapping deletion holds its own fence, so admission reopens only
       * once the last one finishes — in either completion order. */
      await methods.fenceSubagentAdmission(userId, 'deletion-b', fencedUntil);
      await methods.releaseSubagentAdmission(userId, 'deletion-a');
      await expect(methods.isSubagentOwnerAdmissible(userId)).resolves.toBe(false);

      await methods.releaseSubagentAdmission(userId, 'deletion-b');
      await expect(methods.isSubagentOwnerAdmissible(userId)).resolves.toBe(true);
    });

    test('keeps admission closed when the later deletion finishes first', async () => {
      const user = await User.create({
        name: 'Reverse Fence',
        email: 'reverse-fence@example.com',
        provider: 'local',
      });
      const userId = user._id.toString();
      const fencedUntil = new Date(Date.now() + 60_000);

      await methods.fenceSubagentAdmission(userId, 'deletion-a', fencedUntil);
      await methods.fenceSubagentAdmission(userId, 'deletion-b', fencedUntil);

      /** The deletion that started second finishes first; the first is still running. */
      await methods.releaseSubagentAdmission(userId, 'deletion-b');
      await expect(methods.isSubagentOwnerAdmissible(userId)).resolves.toBe(false);

      await methods.releaseSubagentAdmission(userId, 'deletion-a');
      await expect(methods.isSubagentOwnerAdmissible(userId)).resolves.toBe(true);
    });

    test('prunes an expired fence when the next deletion takes one', async () => {
      const user = await User.create({
        name: 'Pruned Fence',
        email: 'pruned-fence@example.com',
        provider: 'local',
      });
      const userId = user._id.toString();

      await methods.fenceSubagentAdmission(userId, 'abandoned', new Date(Date.now() - 1));
      await methods.fenceSubagentAdmission(userId, 'deletion-a', new Date(Date.now() + 60_000));

      const stored = await User.findById(userId).select('+subagentAdmissionFences').lean();
      expect(stored?.subagentAdmissionFences).toHaveLength(1);
      expect(stored?.subagentAdmissionFences?.[0]?.token).toBe('deletion-a');
    });

    test('reopens admission once an abandoned fence expires', async () => {
      const user = await User.create({
        name: 'Expired Fence',
        email: 'expired-fence@example.com',
        provider: 'local',
      });
      const userId = user._id.toString();

      await methods.fenceSubagentAdmission(userId, 'deletion-a', new Date(Date.now() - 1));
      await expect(methods.isSubagentOwnerAdmissible(userId)).resolves.toBe(true);
    });

    test('refuses an excess deletion instead of discarding an active fence', async () => {
      const user = await User.create({
        name: 'Saturated Fence',
        email: 'saturated-fence@example.com',
        provider: 'local',
      });
      const userId = user._id.toString();
      const fencedUntil = new Date(Date.now() + 60_000);

      for (let index = 0; index < 32; index += 1) {
        await methods.fenceSubagentAdmission(userId, `deletion-${index}`, fencedUntil);
      }
      await expect(
        methods.fenceSubagentAdmission(userId, 'deletion-overflow', fencedUntil),
      ).rejects.toThrow('Too many concurrent bulk deletions');

      /** The first deletion still owns its fence, so admission stays closed for it. */
      const stored = await User.findById(userId).select('+subagentAdmissionFences').lean();
      expect(stored?.subagentAdmissionFences).toHaveLength(32);
      expect(stored?.subagentAdmissionFences?.[0]?.token).toBe('deletion-0');
      await expect(methods.isSubagentOwnerAdmissible(userId)).resolves.toBe(false);
    });

    test('invalidates the cached auth document when a refused fence still pruned', async () => {
      enableAuthUserDocCache();
      const user = await User.create({
        name: 'Refused Fence',
        email: 'refused-fence@example.com',
        provider: 'local',
      });
      const userId = user._id?.toString() ?? '';
      const indexKey = `${AUTH_USER_DOC_BY_ID_PREFIX}:${userId}`;
      const fencedUntil = new Date(Date.now() + 60_000);
      /** A saturated owner that has since abandoned one fence: the next attempt prunes
       * the expired entry and is then refused by the cap, so the two writes disagree. */
      await User.updateOne(
        { _id: userId },
        {
          $set: {
            subagentAdmissionFences: [
              ...Array.from({ length: 32 }, (_unused, index) => ({
                token: `deletion-${index}`,
                expiresAt: fencedUntil,
              })),
              { token: 'abandoned', expiresAt: new Date(Date.now() - 1) },
            ],
          },
        },
      );

      const cache = {
        get: jest.fn().mockResolvedValue(['auth-cache-key-a']),
        delete: jest.fn().mockResolvedValue(true),
      };
      const methodsWithCache = createUserMethods(mongoose, {
        getCache: jest.fn().mockReturnValue(cache),
      });

      await expect(
        methodsWithCache.fenceSubagentAdmission(userId, 'deletion-overflow', fencedUntil),
      ).rejects.toThrow('Too many concurrent bulk deletions');
      const stored = await User.findById(userId).select('+subagentAdmissionFences').lean();
      expect(stored?.subagentAdmissionFences).toHaveLength(32);
      /** The prune committed, so leaving the cached document in place would serve the
       * pruned fence until its own TTL expired. */
      expect(cache.delete).toHaveBeenCalledWith('auth-cache-key-a');
      expect(cache.delete).toHaveBeenCalledWith(indexKey);
    });

    test('refuses an unbounded or invalid fence', async () => {
      const userId = new mongoose.Types.ObjectId().toString();

      await expect(
        methods.fenceSubagentAdmission(userId, 'deletion-a', new Date(Number.NaN)),
      ).rejects.toThrow('fencedUntil must be a valid Date');
      await expect(
        methods.fenceSubagentAdmission(userId, '', new Date(Date.now() + 60_000)),
      ).rejects.toThrow('bounded owner token');
    });
  });

  describe('countUsers', () => {
    test('should count all users', async () => {
      await User.create([
        { name: 'User 1', email: 'user1@example.com', provider: 'local' },
        { name: 'User 2', email: 'user2@example.com', provider: 'local' },
        { name: 'User 3', email: 'user3@example.com', provider: 'openid' },
      ]);

      const count = await methods.countUsers();

      expect(count).toBe(3);
    });

    test('should count users with filter', async () => {
      await User.create([
        { name: 'User 1', email: 'user1@example.com', provider: 'local' },
        { name: 'User 2', email: 'user2@example.com', provider: 'local' },
        { name: 'User 3', email: 'user3@example.com', provider: 'openid' },
      ]);

      const count = await methods.countUsers({ provider: 'local' });

      expect(count).toBe(2);
    });

    test('should return zero for empty collection', async () => {
      const count = await methods.countUsers();

      expect(count).toBe(0);
    });
  });

  describe('searchUsers', () => {
    beforeEach(async () => {
      await User.create([
        { name: 'John Doe', email: 'john@example.com', username: 'johnd', provider: 'local' },
        { name: 'Jane Smith', email: 'jane@example.com', username: 'janes', provider: 'local' },
        {
          name: 'Bob Johnson',
          email: 'bob@example.com',
          username: 'bobbyj',
          provider: 'local',
        },
        {
          name: 'Alice Wonder',
          email: 'alice@test.com',
          username: 'alice',
          provider: 'openid',
        },
      ]);
    });

    test('should search by name', async () => {
      const results = await methods.searchUsers({ searchPattern: 'John' });

      expect(results).toHaveLength(2); // John Doe and Bob Johnson
    });

    test('should search by email', async () => {
      const results = await methods.searchUsers({ searchPattern: 'example.com' });

      expect(results).toHaveLength(3);
    });

    test('should search by username', async () => {
      const results = await methods.searchUsers({ searchPattern: 'alice' });

      expect(results).toHaveLength(1);
      expect((results[0] as unknown as t.IUser)?.username).toBe('alice');
    });

    test('should be case-insensitive', async () => {
      const results = await methods.searchUsers({ searchPattern: 'JOHN' });

      expect(results.length).toBeGreaterThan(0);
    });

    test('should respect limit', async () => {
      const results = await methods.searchUsers({ searchPattern: 'example', limit: 2 });

      expect(results).toHaveLength(2);
    });

    test('should return empty array for empty search pattern', async () => {
      const results = await methods.searchUsers({ searchPattern: '' });

      expect(results).toEqual([]);
    });

    test('should return empty array for whitespace-only pattern', async () => {
      const results = await methods.searchUsers({ searchPattern: '   ' });

      expect(results).toEqual([]);
    });

    test('should treat regex metacharacters as literal search text', async () => {
      await User.create({
        name: 'Literal .* User',
        email: 'literal-star@test.com',
        username: 'literal-star',
        provider: 'local',
      });

      const results = await methods.searchUsers({ searchPattern: '.*' });

      expect(results).toHaveLength(1);
      expect((results[0] as unknown as t.IUser).name).toBe('Literal .* User');
    });

    test('should handle invalid regex syntax as literal search text', async () => {
      await User.create({
        name: 'Regex [invalid User',
        email: 'regex-invalid@test.com',
        username: 'regex-invalid',
        provider: 'local',
      });

      const results = await methods.searchUsers({ searchPattern: '[invalid' });

      expect(results).toHaveLength(1);
      expect((results[0] as unknown as t.IUser).name).toBe('Regex [invalid User');
    });

    test('should apply field selection', async () => {
      const results = await methods.searchUsers({
        searchPattern: 'john',
        fieldsToSelect: 'name email',
      });

      expect(results.length).toBeGreaterThan(0);
      expect(results[0]).toHaveProperty('name');
      expect(results[0]).toHaveProperty('email');
      expect(results[0]).not.toHaveProperty('username');
    });

    test('should sort by relevance (exact match first)', async () => {
      const results = await methods.searchUsers({ searchPattern: 'alice' });

      /** 'alice' username should score highest due to exact match */
      expect((results[0] as unknown as t.IUser).username).toBe('alice');
    });
  });

  describe('toggleUserMemories', () => {
    test('should enable memories for user', async () => {
      const user = await User.create({
        name: 'Test User',
        email: 'test@example.com',
        provider: 'local',
      });

      const updated = await methods.toggleUserMemories(user._id?.toString() || '', true);

      expect(updated).toBeDefined();
      expect(updated?.personalization?.memories).toBe(true);
    });

    test('should disable memories for user', async () => {
      const user = await User.create({
        name: 'Test User',
        email: 'test@example.com',
        provider: 'local',
        personalization: { memories: true },
      });

      const updated = await methods.toggleUserMemories(user._id?.toString() || '', false);

      expect(updated).toBeDefined();
      expect(updated?.personalization?.memories).toBe(false);
    });

    test('should update personalization.memories field', async () => {
      const user = await User.create({
        name: 'Test User',
        email: 'test@example.com',
        provider: 'local',
      });

      /** Toggle memories to true */
      const updated = await methods.toggleUserMemories(user._id?.toString() || '', true);

      expect(updated?.personalization).toBeDefined();
      expect(updated?.personalization?.memories).toBe(true);

      /** Toggle back to false */
      const updatedAgain = await methods.toggleUserMemories(user._id?.toString() || '', false);
      expect(updatedAgain?.personalization?.memories).toBe(false);
    });

    test('should return null for non-existent user', async () => {
      const fakeId = new mongoose.Types.ObjectId();
      const result = await methods.toggleUserMemories(fakeId.toString(), true);

      expect(result).toBeNull();
    });

    test('should invalidate cached auth user documents when memories preference changes', async () => {
      enableAuthUserDocCache();
      const user = await User.create({
        name: 'Cached Memory User',
        email: 'cached-memory@example.com',
        provider: 'openid',
        personalization: { memories: true },
      });
      const indexKey = `${AUTH_USER_DOC_BY_ID_PREFIX}:${user._id?.toString()}`;
      const cache = {
        get: jest.fn().mockResolvedValue(['auth-cache-key-a']),
        set: jest.fn().mockResolvedValue(true),
        delete: jest.fn().mockResolvedValue(true),
      };
      const getCache = jest.fn().mockReturnValue(cache);
      const methodsWithCache = createUserMethods(mongoose, { getCache });

      await methodsWithCache.toggleUserMemories(user._id?.toString() ?? '', false);

      expect(getCache).toHaveBeenCalledWith(CacheKeys.AUTH_USER_DOC);
      expect(cache.get).toHaveBeenCalledWith(indexKey);
      expect(cache.delete).toHaveBeenCalledWith('auth-cache-key-a');
      expect(cache.delete).toHaveBeenCalledWith(indexKey);
    });
  });

  describe('updateUserStatefulCodeEnvironment', () => {
    test('updates the workspace default without changing memory preferences', async () => {
      const user = await User.create({
        email: 'stateful-preference@example.com',
        provider: 'local',
        personalization: { memories: false, statefulCodeEnvironment: 'user' },
      });

      const updated = await methods.updateUserStatefulCodeEnvironment(
        user._id?.toString() ?? '',
        'agent-user',
      );

      expect(updated?.personalization).toMatchObject({
        memories: false,
        statefulCodeEnvironment: 'agent-user',
      });
    });

    test('returns null for a missing user', async () => {
      const userId = new mongoose.Types.ObjectId().toString();

      await expect(
        methods.updateUserStatefulCodeEnvironment(userId, 'conversation'),
      ).resolves.toBeNull();
    });

    test('invalidates cached auth user documents', async () => {
      enableAuthUserDocCache();
      const user = await User.create({
        email: 'cached-stateful-preference@example.com',
        provider: 'openid',
      });
      const userId = user._id?.toString() ?? '';
      const indexKey = `${AUTH_USER_DOC_BY_ID_PREFIX}:${userId}`;
      const cache = {
        get: jest.fn().mockResolvedValue(['auth-cache-key-a']),
        delete: jest.fn().mockResolvedValue(true),
      };
      const methodsWithCache = createUserMethods(mongoose, {
        getCache: jest.fn().mockReturnValue(cache),
      });

      await methodsWithCache.updateUserStatefulCodeEnvironment(userId, 'conversation');

      expect(cache.get).toHaveBeenCalledWith(indexKey);
      expect(cache.delete).toHaveBeenCalledWith('auth-cache-key-a');
      expect(cache.delete).toHaveBeenCalledWith(indexKey);
    });
  });

  describe('Email Normalization Edge Cases', () => {
    test('should handle email with multiple spaces', async () => {
      await User.create({
        name: 'Test User',
        email: 'test@example.com',
        provider: 'local',
      });

      const found = await methods.findUser({ email: '    test@example.com    ' });

      expect(found).toBeDefined();
      expect(found?.email).toBe('test@example.com');
    });

    test('should handle mixed case with international characters', async () => {
      await User.create({
        name: 'Test User',
        email: 'user@example.com',
        provider: 'local',
      });

      const found = await methods.findUser({ email: 'USER@EXAMPLE.COM' });

      expect(found).toBeDefined();
    });

    test('should handle email normalization in complex $or queries', async () => {
      const user1 = await User.create({
        name: 'User One',
        email: 'user1@example.com',
        provider: 'openid',
        openidId: 'openid-1',
      });

      await User.create({
        name: 'User Two',
        email: 'user2@example.com',
        provider: 'openid',
        openidId: 'openid-2',
      });

      /** Search with mixed case email in $or */
      const found = await methods.findUser({
        $or: [{ openidId: 'nonexistent' }, { email: 'USER1@EXAMPLE.COM' }],
      });

      expect(found).toBeDefined();
      expect(found?._id?.toString()).toBe(user1._id?.toString());
    });

    test('should not normalize non-string email values', async () => {
      await User.create({
        name: 'Test User',
        email: 'test@example.com',
        provider: 'local',
      });

      /** Using regex for email (should not be normalized) */
      const found = await methods.findUser({ email: /test@example\.com/i });

      expect(found).toBeDefined();
      expect(found?.email).toBe('test@example.com');
    });

    test('should handle OpenID provider migration scenario', async () => {
      /** Simulate user stored with lowercase email */
      await User.create({
        name: 'John Doe',
        email: 'john.doe@company.com',
        provider: 'openid',
        openidId: 'old-provider-id',
      });

      /**
       * New OpenID provider returns email with different casing
       * This simulates the exact bug reported in the GitHub issue
       */
      const emailFromNewProvider = 'John.Doe@Company.COM';

      const found = await methods.findUser({ email: emailFromNewProvider });

      expect(found).toBeDefined();
      expect(found?.email).toBe('john.doe@company.com');
      expect(found?.name).toBe('John Doe');
    });

    test('should handle SAML provider email normalization', async () => {
      await User.create({
        name: 'SAML User',
        email: 'saml.user@enterprise.com',
        provider: 'saml',
        samlId: 'saml-123',
      });

      /** SAML providers sometimes return emails in different formats */
      const found = await methods.findUser({ email: '  SAML.USER@ENTERPRISE.COM  ' });

      expect(found).toBeDefined();
      expect(found?.provider).toBe('saml');
    });
  });

  describe('findUsers with options', () => {
    beforeEach(async () => {
      await User.create([
        { name: 'Alice', email: 'alice@example.com', provider: 'local' },
        { name: 'Bob', email: 'bob@example.com', provider: 'local' },
        { name: 'Charlie', email: 'charlie@example.com', provider: 'local' },
        { name: 'Diana', email: 'diana@example.com', provider: 'local' },
        { name: 'Eve', email: 'eve@example.com', provider: 'local' },
      ]);
    });

    test('limit restricts the number of returned documents', async () => {
      const users = await methods.findUsers({}, null, { limit: 2 });
      expect(users).toHaveLength(2);
    });

    test('offset skips the first N documents', async () => {
      const all = await methods.findUsers({}, 'name', { sort: { name: 1 } });
      const skipped = await methods.findUsers({}, 'name', { offset: 2, sort: { name: 1 } });

      expect(skipped).toHaveLength(3);
      expect(skipped[0].name).toBe(all[2].name);
    });

    test('sort orders results by the specified field', async () => {
      const asc = await methods.findUsers({}, 'name', { sort: { name: 1 } });
      const desc = await methods.findUsers({}, 'name', { sort: { name: -1 } });

      expect(asc[0].name).toBe('Alice');
      expect(asc[4].name).toBe('Eve');
      expect(desc[0].name).toBe('Eve');
      expect(desc[4].name).toBe('Alice');
    });

    test('limit + offset returns the correct page', async () => {
      const sorted = await methods.findUsers({}, 'name', { sort: { name: 1 } });
      const page2 = await methods.findUsers({}, 'name', {
        limit: 2,
        offset: 2,
        sort: { name: 1 },
      });

      expect(page2).toHaveLength(2);
      expect(page2[0].name).toBe(sorted[2].name);
      expect(page2[1].name).toBe(sorted[3].name);
    });

    test('limit of 0 does not restrict results', async () => {
      const users = await methods.findUsers({}, null, { limit: 0 });
      expect(users).toHaveLength(5);
    });

    test('returns all documents when no options provided', async () => {
      const users = await methods.findUsers({});
      expect(users).toHaveLength(5);
    });
  });
});
