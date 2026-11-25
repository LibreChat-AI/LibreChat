jest.mock('@librechat/data-schemas', () => ({
  logger: {
    error: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    info: jest.fn(),
  },
  DEFAULT_REFRESH_TOKEN_EXPIRY: 604800000,
  encryptV2: jest.fn(async (value) => `encrypted:${value}`),
  decryptV2: jest.fn(async (value) => value.replace(/^encrypted:/, '')),
}));

jest.mock('@librechat/api', () => ({
  ...jest.requireActual('@librechat/api'),
  math: jest.fn((_value, fallback) => fallback),
  createRefreshTokenBridgeIdentity: ({ userId, tenantId, openidIssuer }) => ({
    userId: userId?.trim(),
    tenantId: tenantId?.trim() || undefined,
    openidIssuer:
      openidIssuer?.trim().replace('/.well-known/openid-configuration', '').replace(/\/+$/, '') ||
      undefined,
  }),
}));

jest.mock('~/models', () => ({
  deleteRefreshTokenBridges: jest.fn(),
  upsertRefreshTokenBridge: jest.fn(),
  findRefreshTokenBridge: jest.fn(),
}));

const { encryptV2, decryptV2 } = require('@librechat/data-schemas');
const { math } = require('@librechat/api');
const db = require('~/models');
const {
  createRefreshTokenBridgeFlightKey,
  deleteAllRefreshTokenBridges,
  deleteRefreshTokenBridges,
  storeRefreshTokenBridge,
  getRefreshTokenBridge,
  __internals,
} = require('./RefreshTokenBridge');

describe('RefreshTokenBridge', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    db.upsertRefreshTokenBridge.mockResolvedValue({});
    db.findRefreshTokenBridge.mockResolvedValue(null);
    db.deleteRefreshTokenBridges.mockResolvedValue({ acknowledged: true, deletedCount: 1 });
  });

  describe('storeRefreshTokenBridge', () => {
    it('stores an encrypted Mongo bridge with required fields', async () => {
      const before = Date.now();

      await storeRefreshTokenBridge({
        oldRefreshToken: 'rt-old',
        newRefreshToken: 'rt-new',
        userId: 'user-123',
      });

      expect(encryptV2).toHaveBeenCalledWith('rt-new');
      expect(db.upsertRefreshTokenBridge).toHaveBeenCalledWith({
        oldRefreshTokenHash: __internals.hashRefreshToken('rt-old'),
        encryptedNewRefreshToken: 'encrypted:rt-new',
        userId: 'user-123',
        tenantId: undefined,
        openidIssuer: undefined,
        version: expect.any(String),
        expiresAt: expect.any(Date),
      });
      const stored = db.upsertRefreshTokenBridge.mock.calls[0][0];
      expect(JSON.stringify(stored)).not.toContain('"rt-new"');
      expect(stored.expiresAt.getTime()).toBeGreaterThanOrEqual(before + 604800000 - 1000);
    });

    it('stores optional tenant and issuer context', async () => {
      await storeRefreshTokenBridge({
        oldRefreshToken: 'rt-old',
        newRefreshToken: 'rt-new',
        userId: ' user-123 ',
        tenantId: ' tenant-1 ',
        openidIssuer: 'https://issuer.example.com/.well-known/openid-configuration',
      });

      expect(db.upsertRefreshTokenBridge).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'user-123',
          tenantId: 'tenant-1',
          openidIssuer: 'https://issuer.example.com',
        }),
      );
    });

    it('does not store a bridge without required fields', async () => {
      await storeRefreshTokenBridge({
        oldRefreshToken: 'rt-old',
        userId: 'user-123',
      });

      expect(db.upsertRefreshTokenBridge).not.toHaveBeenCalled();
    });

    it('honors an explicit ttl override', async () => {
      const before = Date.now();

      await storeRefreshTokenBridge({
        oldRefreshToken: 'rt-old',
        newRefreshToken: 'rt-new',
        userId: 'user-123',
        ttl: 1000,
      });

      const stored = db.upsertRefreshTokenBridge.mock.calls[0][0];
      expect(stored.expiresAt.getTime()).toBeGreaterThanOrEqual(before + 1000);
      expect(stored.expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + 1000);
    });

    it('derives the default ttl from REFRESH_TOKEN_EXPIRY', async () => {
      await storeRefreshTokenBridge({
        oldRefreshToken: 'rt-old',
        newRefreshToken: 'rt-new',
        userId: 'user-123',
      });

      expect(math).toHaveBeenCalledWith(process.env.REFRESH_TOKEN_EXPIRY, 604800000);
    });
  });

  describe('coordination and revocation', () => {
    it('creates a stable opaque flight key scoped to token and identity', () => {
      const key = createRefreshTokenBridgeFlightKey({
        oldRefreshToken: 'rt-old',
        userId: ' user-123 ',
        tenantId: ' tenant-1 ',
        openidIssuer: 'https://issuer.example.com/',
      });

      expect(key).toHaveLength(64);
      expect(key).not.toContain('rt-old');
      expect(key).toBe(
        createRefreshTokenBridgeFlightKey({
          oldRefreshToken: 'rt-old',
          userId: 'user-123',
          tenantId: 'tenant-1',
          openidIssuer: 'https://issuer.example.com',
        }),
      );
    });

    it('deletes bridge hashes for all distinct logout tokens', async () => {
      await deleteRefreshTokenBridges({
        refreshTokens: ['cookie-token', 'session-token', 'cookie-token'],
        userId: ' user-123 ',
        tenantId: ' tenant-1 ',
      });

      expect(db.deleteRefreshTokenBridges).toHaveBeenCalledWith({
        oldRefreshTokenHashes: [
          __internals.hashRefreshToken('cookie-token'),
          __internals.hashRefreshToken('session-token'),
        ],
        userId: 'user-123',
        tenantId: 'tenant-1',
      });
    });

    it('deletes every predecessor bridge for a logout identity', async () => {
      await deleteAllRefreshTokenBridges({ userId: ' user-123 ', tenantId: ' tenant-1 ' });

      expect(db.deleteRefreshTokenBridges).toHaveBeenCalledWith({
        userId: 'user-123',
        tenantId: 'tenant-1',
      });
    });
  });

  describe('getRefreshTokenBridge', () => {
    it('retrieves and decrypts a matching bridge', async () => {
      db.findRefreshTokenBridge.mockResolvedValue({
        encryptedNewRefreshToken: 'encrypted:rt-new',
        userId: 'user-123',
        tenantId: 'tenant-1',
        openidIssuer: 'https://issuer.example.com',
        createdAt: new Date(Date.now() - 100),
      });

      const result = await getRefreshTokenBridge({
        oldRefreshToken: 'rt-old',
        userId: ' user-123 ',
        tenantId: ' tenant-1 ',
        openidIssuer: 'https://issuer.example.com/.well-known/openid-configuration',
      });

      expect(db.findRefreshTokenBridge).toHaveBeenCalledWith({
        oldRefreshTokenHash: __internals.hashRefreshToken('rt-old'),
        userId: 'user-123',
        tenantId: 'tenant-1',
      });
      expect(decryptV2).toHaveBeenCalledWith('encrypted:rt-new');
      expect(result).toBe('rt-new');
    });

    it('returns null when bridge does not exist', async () => {
      await expect(
        getRefreshTokenBridge({
          oldRefreshToken: 'rt-nonexistent',
          userId: 'user-123',
        }),
      ).resolves.toBeNull();
    });

    it('returns null when stored issuer does not match', async () => {
      db.findRefreshTokenBridge.mockResolvedValue({
        encryptedNewRefreshToken: 'encrypted:rt-new',
        userId: 'user-123',
        openidIssuer: 'https://issuer1.example.com',
        createdAt: new Date(),
      });

      const result = await getRefreshTokenBridge({
        oldRefreshToken: 'rt-old',
        userId: 'user-123',
        openidIssuer: 'https://issuer2.example.com',
      });

      expect(result).toBeNull();
      expect(decryptV2).not.toHaveBeenCalled();
    });

    it('returns null when only the expected issuer is present', async () => {
      db.findRefreshTokenBridge.mockResolvedValue({
        encryptedNewRefreshToken: 'encrypted:rt-new',
        userId: 'user-123',
        createdAt: new Date(),
      });

      const result = await getRefreshTokenBridge({
        oldRefreshToken: 'rt-old',
        userId: 'user-123',
        openidIssuer: 'https://issuer.example.com',
      });

      expect(result).toBeNull();
      expect(decryptV2).not.toHaveBeenCalled();
    });

    it('returns null when only the stored issuer is present', async () => {
      db.findRefreshTokenBridge.mockResolvedValue({
        encryptedNewRefreshToken: 'encrypted:rt-new',
        userId: 'user-123',
        openidIssuer: 'https://issuer.example.com',
        createdAt: new Date(),
      });

      const result = await getRefreshTokenBridge({
        oldRefreshToken: 'rt-old',
        userId: 'user-123',
      });

      expect(result).toBeNull();
      expect(decryptV2).not.toHaveBeenCalled();
    });

    it('normalizes the stored issuer before validation', async () => {
      db.findRefreshTokenBridge.mockResolvedValue({
        encryptedNewRefreshToken: 'encrypted:rt-new',
        userId: 'user-123',
        openidIssuer: 'https://issuer.example.com/.well-known/openid-configuration',
        createdAt: new Date(),
      });

      const result = await getRefreshTokenBridge({
        oldRefreshToken: 'rt-old',
        userId: 'user-123',
        openidIssuer: 'https://issuer.example.com/',
      });

      expect(decryptV2).toHaveBeenCalledWith('encrypted:rt-new');
      expect(result).toBe('rt-new');
    });
  });
});
