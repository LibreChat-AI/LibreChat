jest.mock('~/strategies/openidStrategy');
jest.mock('~/cache/getLogStores');
jest.mock('@librechat/data-schemas', () => ({
  ...jest.requireActual('@librechat/data-schemas'),
  logger: {
    error: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
  },
}));

const client = require('openid-client');
const { getOpenIdConfig } = require('~/strategies/openidStrategy');
const getLogStores = require('~/cache/getLogStores');
const { exchangeOboToken, __internals } = require('./OboTokenService');

describe('OboTokenService', () => {
  let mockTokensCache;
  let mockOpenIdConfig;

  const mockUser = {
    openidId: 'oidc-sub-123',
    tenantId: 'tenant-a',
    openidIssuer: 'https://issuer-a.example.com',
    email: 'test@example.com',
    name: 'Test User',
  };

  const expectedCacheKey = (user, accessToken, scopes, identityContext) =>
    __internals.buildOboCacheKey({ user, accessToken, scopes, identityContext });

  beforeEach(() => {
    jest.clearAllMocks();

    mockTokensCache = {
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn().mockResolvedValue(undefined),
    };
    getLogStores.mockReturnValue(mockTokensCache);

    mockOpenIdConfig = {
      client_id: 'test-client-id',
      issuer: 'https://login.microsoftonline.com/tenant-id/v2.0',
    };
    getOpenIdConfig.mockReturnValue(mockOpenIdConfig);

    client.genericGrantRequest.mockResolvedValue({
      access_token: 'exchanged-obo-token',
      expires_in: 3600,
    });
  });

  describe('input validation', () => {
    it('should throw when user has no openidId', async () => {
      await expect(
        exchangeOboToken({ email: 'test@example.com' }, 'access-token', 'api://scope'),
      ).rejects.toThrow('User must be authenticated via OpenID to perform OBO token exchange');
    });

    it('should throw when accessToken is missing', async () => {
      await expect(exchangeOboToken(mockUser, '', 'api://scope')).rejects.toThrow(
        'Access token is required for OBO exchange',
      );
    });

    it('should throw when scopes are missing', async () => {
      await expect(exchangeOboToken(mockUser, 'access-token', '')).rejects.toThrow(
        'Scopes are required for OBO exchange',
      );
    });

    it('should throw when OpenID config is not available', async () => {
      getOpenIdConfig.mockReturnValue(null);

      await expect(exchangeOboToken(mockUser, 'access-token', 'api://scope')).rejects.toThrow(
        'OpenID configuration not available',
      );
    });
  });

  describe('cache behavior', () => {
    it('should return cached token when fromCache is true and cache hit', async () => {
      const cachedToken = {
        access_token: 'cached-obo-token',
        token_type: 'Bearer',
        expires_in: 1800,
        expires_at: Date.now() + 1800 * 1000,
        scope: 'api://mcp-server/Scope.Read',
      };
      mockTokensCache.get.mockResolvedValue(cachedToken);

      const result = await exchangeOboToken(
        mockUser,
        'access-token',
        'api://mcp-server/Scope.Read',
        true,
      );

      expect(result).toBe(cachedToken);
      expect(mockTokensCache.get).toHaveBeenCalledWith(
        expectedCacheKey(mockUser, 'access-token', 'api://mcp-server/Scope.Read'),
      );
      expect(client.genericGrantRequest).not.toHaveBeenCalled();
    });

    it('should ignore legacy cached tokens without absolute expiry', async () => {
      const cachedToken = {
        access_token: 'cached-obo-token',
        token_type: 'Bearer',
        expires_in: 1800,
        scope: 'api://mcp-server/Scope.Read',
      };
      mockTokensCache.get.mockResolvedValue(cachedToken);

      const result = await exchangeOboToken(
        mockUser,
        'access-token',
        'api://mcp-server/Scope.Read',
        true,
      );

      expect(result.access_token).toBe('exchanged-obo-token');
      expect(client.genericGrantRequest).toHaveBeenCalledTimes(1);
      expect(mockTokensCache.set).toHaveBeenCalledTimes(1);
    });

    it('should skip cache when fromCache is false', async () => {
      const cachedToken = { access_token: 'cached-obo-token' };
      mockTokensCache.get.mockResolvedValue(cachedToken);

      const result = await exchangeOboToken(
        mockUser,
        'access-token',
        'api://mcp-server/Scope.Read',
        false,
      );

      expect(mockTokensCache.get).not.toHaveBeenCalled();
      expect(client.genericGrantRequest).toHaveBeenCalled();
      expect(result.access_token).toBe('exchanged-obo-token');
    });

    it('should default fromCache to true', async () => {
      mockTokensCache.get.mockResolvedValue(null);

      await exchangeOboToken(mockUser, 'access-token', 'api://scope');

      expect(mockTokensCache.get).toHaveBeenCalledWith(
        expectedCacheKey(mockUser, 'access-token', 'api://scope'),
      );
    });
  });

  describe('OBO token exchange', () => {
    it('should call genericGrantRequest with jwt-bearer grant type', async () => {
      await exchangeOboToken(mockUser, 'user-access-token', 'api://mcp-server/Tools.ReadWrite');

      expect(client.genericGrantRequest).toHaveBeenCalledWith(
        mockOpenIdConfig,
        'urn:ietf:params:oauth:grant-type:jwt-bearer',
        {
          scope: 'api://mcp-server/Tools.ReadWrite',
          assertion: 'user-access-token',
          requested_token_use: 'on_behalf_of',
        },
      );
    });

    it('should return token response with correct structure', async () => {
      const result = await exchangeOboToken(
        mockUser,
        'access-token',
        'api://mcp-server/Tools.ReadWrite',
      );

      expect(result).toEqual({
        access_token: 'exchanged-obo-token',
        token_type: 'Bearer',
        expires_in: 3600,
        expires_at: expect.any(Number),
        scope: 'api://mcp-server/Tools.ReadWrite',
      });
    });

    it('should cache the exchanged token with a skewed TTL', async () => {
      client.genericGrantRequest.mockResolvedValue({
        access_token: 'new-obo-token',
        expires_in: 1800,
      });

      await exchangeOboToken(mockUser, 'access-token', 'api://scope');

      expect(mockTokensCache.set).toHaveBeenCalledWith(
        expectedCacheKey(mockUser, 'access-token', 'api://scope'),
        {
          access_token: 'new-obo-token',
          token_type: 'Bearer',
          expires_in: 1800,
          expires_at: expect.any(Number),
          scope: 'api://scope',
        },
        1770 * 1000,
      );
    });

    it('should default expires_in to 3600 when not in response', async () => {
      client.genericGrantRequest.mockResolvedValue({
        access_token: 'no-expiry-token',
      });

      const result = await exchangeOboToken(mockUser, 'access-token', 'api://scope');

      expect(result.expires_in).toBe(3600);
      expect(mockTokensCache.set).toHaveBeenCalledWith(
        expectedCacheKey(mockUser, 'access-token', 'api://scope'),
        expect.objectContaining({ expires_in: 3600 }),
        3570 * 1000,
      );
    });

    it('should not cache an exchange response without access_token', async () => {
      client.genericGrantRequest.mockResolvedValue({
        expires_in: 3600,
      });

      await expect(exchangeOboToken(mockUser, 'access-token', 'api://scope')).rejects.toThrow(
        'The identity provider returned no access token for the OBO exchange',
      );

      expect(mockTokensCache.set).not.toHaveBeenCalled();
    });

    it('should keep a positive TTL for very short-lived tokens', async () => {
      client.genericGrantRequest.mockResolvedValue({
        access_token: 'short-lived-token',
        expires_in: 10,
      });

      const result = await exchangeOboToken(mockUser, 'access-token', 'api://scope');

      expect(result.expires_in).toBe(10);
      expect(mockTokensCache.set).toHaveBeenCalledWith(
        expectedCacheKey(mockUser, 'access-token', 'api://scope'),
        expect.objectContaining({ access_token: 'short-lived-token', expires_in: 10 }),
        1000,
      );
    });

    it('should propagate errors from genericGrantRequest', async () => {
      client.genericGrantRequest.mockRejectedValue(
        new Error('invalid_grant: AADSTS50013: Assertion failed signature validation'),
      );

      await expect(exchangeOboToken(mockUser, 'bad-token', 'api://scope')).rejects.toThrow(
        'invalid_grant: AADSTS50013: Assertion failed signature validation',
      );
    });

    it('should retry once for transient Entra failures and succeed on the second attempt', async () => {
      const transientError = Object.assign(new Error('Service unavailable'), { status: 503 });
      const setTimeoutSpy = jest.spyOn(global, 'setTimeout').mockImplementation((callback) => {
        callback();
        return 0;
      });

      try {
        client.genericGrantRequest.mockRejectedValueOnce(transientError).mockResolvedValueOnce({
          access_token: 'retried-obo-token',
          expires_in: 1800,
        });

        const result = await exchangeOboToken(mockUser, 'access-token', 'api://scope');

        expect(client.genericGrantRequest).toHaveBeenCalledTimes(2);
        expect(result).toEqual({
          access_token: 'retried-obo-token',
          token_type: 'Bearer',
          expires_in: 1800,
          expires_at: expect.any(Number),
          scope: 'api://scope',
        });
      } finally {
        setTimeoutSpy.mockRestore();
      }
    });

    it('should not retry permanent OBO exchange failures', async () => {
      const permanentError = new Error(
        'invalid_grant: AADSTS50013: Assertion failed signature validation',
      );
      client.genericGrantRequest.mockRejectedValue(permanentError);

      await expect(exchangeOboToken(mockUser, 'bad-token', 'api://scope')).rejects.toThrow(
        'invalid_grant: AADSTS50013: Assertion failed signature validation',
      );

      expect(client.genericGrantRequest).toHaveBeenCalledTimes(1);
    });
  });

  describe('cache key isolation', () => {
    it('does not include the raw upstream assertion in cache keys', async () => {
      await exchangeOboToken(mockUser, 'sensitive-access-token', 'api://scope');

      expect(mockTokensCache.get.mock.calls[0][0]).not.toContain('sensitive-access-token');
      expect(mockTokensCache.set.mock.calls[0][0]).not.toContain('sensitive-access-token');
    });

    it('should use different cache keys for different scopes', async () => {
      await exchangeOboToken(mockUser, 'access-token', 'api://server-a/Scope.A');
      await exchangeOboToken(mockUser, 'access-token', 'api://server-b/Scope.B');

      expect(mockTokensCache.get).toHaveBeenCalledWith(
        expectedCacheKey(mockUser, 'access-token', 'api://server-a/Scope.A'),
      );
      expect(mockTokensCache.get).toHaveBeenCalledWith(
        expectedCacheKey(mockUser, 'access-token', 'api://server-b/Scope.B'),
      );
    });

    it('should use different cache keys for different users', async () => {
      const otherUser = { openidId: 'oidc-sub-456', email: 'other@example.com' };

      await exchangeOboToken(mockUser, 'access-token', 'api://scope');
      await exchangeOboToken(otherUser, 'access-token', 'api://scope');

      expect(mockTokensCache.get).toHaveBeenCalledWith(
        expectedCacheKey(mockUser, 'access-token', 'api://scope'),
      );
      expect(mockTokensCache.get).toHaveBeenCalledWith(
        expectedCacheKey(otherUser, 'access-token', 'api://scope'),
      );
    });

    it('should use different cache keys for different tenants with the same OpenID subject', async () => {
      const identityA = {
        openidSubject: 'shared-sub',
        tenantId: 'tenant-a',
        openidIssuer: 'https://issuer.example.com',
      };
      const identityB = {
        openidSubject: 'shared-sub',
        tenantId: 'tenant-b',
        openidIssuer: 'https://issuer.example.com',
      };
      const safeUser = { openidId: 'shared-sub', email: 'test@example.com' };

      await exchangeOboToken(safeUser, 'access-token', 'api://scope', true, identityA);
      await exchangeOboToken(safeUser, 'access-token', 'api://scope', true, identityB);

      expect(mockTokensCache.get).toHaveBeenCalledWith(
        expectedCacheKey(safeUser, 'access-token', 'api://scope', identityA),
      );
      expect(mockTokensCache.get).toHaveBeenCalledWith(
        expectedCacheKey(safeUser, 'access-token', 'api://scope', identityB),
      );
    });

    it('should use identity context when the forwarded user lacks OpenID fields', async () => {
      const identityContext = {
        openidSubject: 'context-sub',
        tenantId: 'tenant-a',
        openidIssuer: 'https://issuer.example.com',
      };
      const safeUser = { id: 'safe-user-id', email: 'test@example.com' };

      await exchangeOboToken(safeUser, 'access-token', 'api://scope', true, identityContext);

      expect(mockTokensCache.get).toHaveBeenCalledWith(
        expectedCacheKey(safeUser, 'access-token', 'api://scope', identityContext),
      );
      expect(client.genericGrantRequest).toHaveBeenCalledTimes(1);
    });

    it('should use different cache keys for different issuers with the same OpenID subject', async () => {
      const identityA = {
        openidSubject: 'shared-sub',
        tenantId: 'tenant-a',
        openidIssuer: 'https://issuer-a.example.com',
      };
      const identityB = {
        openidSubject: 'shared-sub',
        tenantId: 'tenant-a',
        openidIssuer: 'https://issuer-b.example.com',
      };
      const safeUser = { openidId: 'shared-sub', email: 'test@example.com' };

      await exchangeOboToken(safeUser, 'access-token', 'api://scope', true, identityA);
      await exchangeOboToken(safeUser, 'access-token', 'api://scope', true, identityB);

      expect(mockTokensCache.get).toHaveBeenCalledWith(
        expectedCacheKey(safeUser, 'access-token', 'api://scope', identityA),
      );
      expect(mockTokensCache.get).toHaveBeenCalledWith(
        expectedCacheKey(safeUser, 'access-token', 'api://scope', identityB),
      );
    });

    it('should use different cache keys when the upstream assertion rotates', async () => {
      await exchangeOboToken(mockUser, 'access-token-old', 'api://scope');
      await exchangeOboToken(mockUser, 'access-token-new', 'api://scope');

      expect(mockTokensCache.get).toHaveBeenCalledWith(
        expectedCacheKey(mockUser, 'access-token-old', 'api://scope'),
      );
      expect(mockTokensCache.get).toHaveBeenCalledWith(
        expectedCacheKey(mockUser, 'access-token-new', 'api://scope'),
      );
    });
  });

  describe('single-flight coalescing', () => {
    /** Yields long enough for both pending callers to advance past their cache lookup. */
    const flushMicrotasks = () => new Promise((resolve) => setImmediate(resolve));

    it('coalesces concurrent exchanges for the same key into one IdP call', async () => {
      let resolveGrant;
      client.genericGrantRequest.mockReturnValueOnce(
        new Promise((resolve) => {
          resolveGrant = resolve;
        }),
      );

      const callA = exchangeOboToken(mockUser, 'access-token', 'api://shared');
      const callB = exchangeOboToken(mockUser, 'access-token', 'api://shared');

      await flushMicrotasks();
      expect(client.genericGrantRequest).toHaveBeenCalledTimes(1);

      resolveGrant({ access_token: 'shared-obo-token', expires_in: 3600 });

      const [resultA, resultB] = await Promise.all([callA, callB]);
      expect(resultA).toEqual(resultB);
      expect(resultA.access_token).toBe('shared-obo-token');
      expect(client.genericGrantRequest).toHaveBeenCalledTimes(1);
      expect(mockTokensCache.set).toHaveBeenCalledTimes(1);
    });

    it('does not coalesce exchanges for different keys', async () => {
      await Promise.all([
        exchangeOboToken(mockUser, 'access-token', 'api://scope-a'),
        exchangeOboToken(mockUser, 'access-token', 'api://scope-b'),
      ]);

      expect(client.genericGrantRequest).toHaveBeenCalledTimes(2);
    });

    it('does not coalesce exchanges for rotated upstream assertions', async () => {
      await Promise.all([
        exchangeOboToken(mockUser, 'access-token-old', 'api://scope'),
        exchangeOboToken(mockUser, 'access-token-new', 'api://scope'),
      ]);

      expect(client.genericGrantRequest).toHaveBeenCalledTimes(2);
    });

    it('clears the in-flight slot after a successful exchange', async () => {
      await exchangeOboToken(mockUser, 'access-token', 'api://scope');
      expect(client.genericGrantRequest).toHaveBeenCalledTimes(1);

      await exchangeOboToken(mockUser, 'access-token', 'api://scope');
      expect(client.genericGrantRequest).toHaveBeenCalledTimes(2);
    });

    it('clears the in-flight slot after a failed exchange', async () => {
      client.genericGrantRequest
        .mockRejectedValueOnce(
          new Error('invalid_grant: AADSTS50013: Assertion failed signature validation'),
        )
        .mockResolvedValueOnce({ access_token: 'fresh-token', expires_in: 3600 });

      await expect(exchangeOboToken(mockUser, 'access-token', 'api://scope')).rejects.toThrow(
        'invalid_grant',
      );

      const result = await exchangeOboToken(mockUser, 'access-token', 'api://scope');
      expect(result.access_token).toBe('fresh-token');
      expect(client.genericGrantRequest).toHaveBeenCalledTimes(2);
    });

    it('bypasses in-flight coalescing when fromCache is false', async () => {
      let resolveFirst;
      client.genericGrantRequest
        .mockReturnValueOnce(
          new Promise((resolve) => {
            resolveFirst = resolve;
          }),
        )
        .mockResolvedValueOnce({ access_token: 'forced-fresh-token', expires_in: 3600 });

      const callA = exchangeOboToken(mockUser, 'access-token', 'api://scope', true);
      await flushMicrotasks();

      const callB = exchangeOboToken(mockUser, 'access-token', 'api://scope', false);
      expect(client.genericGrantRequest).toHaveBeenCalledTimes(2);

      resolveFirst({ access_token: 'in-flight-token', expires_in: 3600 });

      const [resultA, resultB] = await Promise.all([callA, callB]);
      expect(resultA.access_token).toBe('in-flight-token');
      expect(resultB.access_token).toBe('forced-fresh-token');
    });
  });
});
