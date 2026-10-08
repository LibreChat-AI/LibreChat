import { Permissions, PermissionTypes } from 'librechat-data-provider';
import type { IUser } from '@librechat/data-schemas';
import type { OboTokenResolver, UpstreamTokenProvider } from './obo';
import {
  createLazyOboUpstreamTokenProvider,
  isOboConfigStillTrusted,
  resolveOboToken,
  selectMCPUpstreamTokenProvider,
} from './obo';

jest.mock('@librechat/data-schemas', () => ({
  logger: {
    warn: jest.fn(),
    error: jest.fn(),
    info: jest.fn(),
  },
}));

jest.mock('~/utils/oidc', () => ({
  isOpenIDTokenValid: jest.fn(),
  extractOpenIDTokenInfo: jest.fn(),
}));

import { isOpenIDTokenValid, extractOpenIDTokenInfo } from '~/utils/oidc';

const mockIsOpenIDTokenValid = isOpenIDTokenValid as jest.Mock;
const mockExtractOpenIDTokenInfo = extractOpenIDTokenInfo as jest.Mock;

const farFutureExp = Math.floor(Date.now() / 1000) + 3600;

const liveTokens = {
  access_token: 'live-access-token',
  id_token: 'live-id-token',
  refresh_token: 'live-refresh-token',
  expires_at: farFutureExp,
};

const liveProvider: UpstreamTokenProvider = jest.fn().mockResolvedValue(liveTokens);
const nullProvider: UpstreamTokenProvider = jest.fn().mockResolvedValue(null);

describe('selectMCPUpstreamTokenProvider', () => {
  it.each([false, true])(
    'keeps explicit credentials regardless of deferred OBO lookup (%s)',
    (deferred) => {
      const createSessionProvider = jest.fn();
      expect(
        selectMCPUpstreamTokenProvider({
          upstreamTokenProvider: liveProvider,
          upstreamTokenProviderResolver: deferred ? jest.fn() : undefined,
          createSessionProvider,
        }),
      ).toBe(liveProvider);
      expect(createSessionProvider).not.toHaveBeenCalled();
    },
  );

  it('creates browser credentials only when no deferred OBO source is present', () => {
    const createSessionProvider = jest.fn().mockReturnValue(liveProvider);
    expect(
      selectMCPUpstreamTokenProvider({
        upstreamTokenProviderResolver: jest.fn(),
        createSessionProvider,
      }),
    ).toBeUndefined();
    expect(createSessionProvider).not.toHaveBeenCalled();
    expect(selectMCPUpstreamTokenProvider({ createSessionProvider })).toBe(liveProvider);
    expect(createSessionProvider).toHaveBeenCalledTimes(1);
  });
});

describe('resolveOboToken', () => {
  const mockUser: Partial<IUser> = {
    id: 'user-123',
    provider: 'openid',
    openidId: 'oidc-sub-456',
    email: 'test@example.com',
    name: 'Test User',
  };

  const oboConfig = { scopes: 'api://mcp-server-id/Mcp.Tools.ReadWrite' };

  const mockResolver: OboTokenResolver = jest.fn().mockResolvedValue({
    access_token: 'exchanged-mcp-token',
    expires_in: 3600,
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockIsOpenIDTokenValid.mockReturnValue(true);
    /** Default: no federated-token fallback unless a test opts in. */
    mockExtractOpenIDTokenInfo.mockReturnValue(null);
    (liveProvider as jest.Mock).mockResolvedValue(liveTokens);
    (mockResolver as jest.Mock).mockResolvedValue({
      access_token: 'exchanged-mcp-token',
      expires_in: 3600,
    });
  });

  it.each([undefined, new Error('stopped by owner')])(
    'preserves pending lookup cancellation (%s)',
    async (reason) => {
      const controller = new AbortController();
      const lookup = jest.fn(() => new Promise<UpstreamTokenProvider>(() => {}));
      const result = resolveOboToken(
        mockUser as IUser,
        oboConfig,
        mockResolver,
        createLazyOboUpstreamTokenProvider(lookup, controller.signal),
      );
      await Promise.resolve();
      controller.abort(reason);
      await expect(result).rejects.toMatchObject({ name: 'AbortError' });
      expect(mockResolver).not.toHaveBeenCalled();
      expect(jest.requireMock('@librechat/data-schemas').logger.error).not.toHaveBeenCalled();
    },
  );

  it('stops waiting for token retrieval that ignores cancellation', async () => {
    const controller = new AbortController();
    let started!: () => void;
    const retrieving = new Promise<void>((resolve) => {
      started = resolve;
    });
    const provider = jest.fn(() => {
      started();
      return new Promise<null>(() => {});
    });
    const result = resolveOboToken(
      mockUser as IUser,
      oboConfig,
      mockResolver,
      createLazyOboUpstreamTokenProvider(async () => provider, controller.signal),
    );
    await retrieving;
    controller.abort();
    await expect(result).rejects.toMatchObject({ name: 'AbortError' });
    expect(mockResolver).not.toHaveBeenCalled();
  });

  it('preserves cancellation during token retrieval and exchange', async () => {
    const abort = new DOMException('Stopped', 'AbortError');
    const provider = jest.fn().mockRejectedValue(abort);
    await expect(
      resolveOboToken(mockUser as IUser, oboConfig, mockResolver, provider),
    ).rejects.toBe(abort);
    (mockResolver as jest.Mock).mockRejectedValueOnce(abort);
    await expect(
      resolveOboToken(mockUser as IUser, oboConfig, mockResolver, liveProvider),
    ).rejects.toBe(abort);
    expect(jest.requireMock('@librechat/data-schemas').logger.error).not.toHaveBeenCalled();
  });

  it('retries failed lookups but shares each in-flight attempt', async () => {
    const lookup = jest
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error('unavailable'), { status: 503 }))
      .mockResolvedValue(liveProvider);
    const provider = createLazyOboUpstreamTokenProvider(lookup);
    const failed = await Promise.allSettled([provider(), provider()]);
    expect(failed.map((result) => result.status)).toEqual(['rejected', 'rejected']);
    expect(lookup).toHaveBeenCalledTimes(1);
    await expect(
      resolveOboToken(mockUser as IUser, oboConfig, mockResolver, provider),
    ).resolves.toMatchObject({ access_token: 'exchanged-mcp-token' });
    expect(lookup).toHaveBeenCalledTimes(2);
  });

  it.each([false, true])('preserves lookup failure retryability (%s)', async (retryable) => {
    const lookup = jest
      .fn()
      .mockRejectedValue(
        Object.assign(new Error('credential lookup failed'), { status: retryable ? 503 : 401 }),
      );
    await expect(
      resolveOboToken(
        mockUser as IUser,
        oboConfig,
        mockResolver,
        createLazyOboUpstreamTokenProvider(lookup),
      ),
    ).rejects.toMatchObject({ reason: 'session_refresh_failed', retryable });
    expect(mockResolver).not.toHaveBeenCalled();
  });

  it('does not fall back to a snapshot when durable credential lookup returns no provider', async () => {
    mockExtractOpenIDTokenInfo.mockReturnValue({ accessToken: 'stale-snapshot' });
    const lookup = jest.fn().mockResolvedValue(undefined);
    await expect(
      resolveOboToken(
        mockUser as IUser,
        oboConfig,
        mockResolver,
        createLazyOboUpstreamTokenProvider(lookup),
      ),
    ).rejects.toMatchObject({ reason: 'missing_upstream_provider', retryable: false });
    expect(mockExtractOpenIDTokenInfo).not.toHaveBeenCalled();
    expect(mockResolver).not.toHaveBeenCalled();
  });

  it('does not look up credentials after cancellation', async () => {
    const controller = new AbortController();
    controller.abort();
    const lookup = jest.fn();
    await expect(createLazyOboUpstreamTokenProvider(lookup, controller.signal)()).rejects.toThrow();
    expect(lookup).not.toHaveBeenCalled();
  });

  it('shares lookup while obtaining fresh tokens on every invocation', async () => {
    const lookup = jest.fn().mockResolvedValue(liveProvider);
    const provider = createLazyOboUpstreamTokenProvider(lookup);
    await Promise.all([provider(), provider()]);
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(liveProvider).toHaveBeenCalledTimes(2);
  });

  it('throws missing_upstream_token when provider returns null and no federated fallback', async () => {
    await expect(
      resolveOboToken(mockUser as IUser, oboConfig, mockResolver, nullProvider),
    ).rejects.toMatchObject({
      reason: 'missing_upstream_token',
      retryable: false,
    });
    expect(mockResolver).not.toHaveBeenCalled();
  });

  it('falls back to user.federatedTokens for the OBO exchange when provider returns null', async () => {
    /** OIDC remote-agent flow: bearer token on the user, no Express session. */
    mockExtractOpenIDTokenInfo.mockReturnValue({
      accessToken: 'federated-access-token',
      idToken: 'federated-id-token',
      expiresAt: farFutureExp,
      userId: 'oidc-sub-456',
    });
    mockIsOpenIDTokenValid.mockReturnValue(true);

    const result = await resolveOboToken(mockUser as IUser, oboConfig, mockResolver, nullProvider);

    expect(mockExtractOpenIDTokenInfo).toHaveBeenCalledWith(mockUser);
    expect(mockResolver).toHaveBeenCalledWith(
      mockUser,
      'federated-access-token',
      'api://mcp-server-id/Mcp.Tools.ReadWrite',
      true,
      undefined,
    );
    expect(result.access_token).toBe('exchanged-mcp-token');
  });

  it('bypasses the resolver cache when forceRefresh is set', async () => {
    /**
     * A downstream 401 can arrive while the credential is still inside its cached
     * lifetime (revoked, or its scopes invalidated), so a cached read would hand
     * back the same rejected bearer.
     */
    await resolveOboToken(
      mockUser as IUser,
      oboConfig,
      mockResolver,
      liveProvider,
      undefined,
      true,
    );

    expect(mockResolver).toHaveBeenCalledWith(
      mockUser,
      'live-access-token',
      'api://mcp-server-id/Mcp.Tools.ReadWrite',
      false,
      undefined,
    );
  });

  it('throws missing_upstream_token when federated fallback token is invalid', async () => {
    mockExtractOpenIDTokenInfo.mockReturnValue({
      accessToken: 'federated-access-token',
      expiresAt: farFutureExp,
    });
    mockIsOpenIDTokenValid.mockReturnValue(false);

    await expect(
      resolveOboToken(mockUser as IUser, oboConfig, mockResolver, nullProvider),
    ).rejects.toMatchObject({
      reason: 'missing_upstream_token',
      retryable: false,
    });
    expect(mockResolver).not.toHaveBeenCalled();
  });

  it('throws session_refresh_failed when provider rejects', async () => {
    const failingProvider: UpstreamTokenProvider = jest
      .fn()
      .mockRejectedValue(new Error('invalid_grant'));

    await expect(
      resolveOboToken(mockUser as IUser, oboConfig, mockResolver, failingProvider),
    ).rejects.toMatchObject({
      reason: 'session_refresh_failed',
      retryable: false,
      userMessage: expect.stringContaining('Please sign in again'),
    });
    expect(mockResolver).not.toHaveBeenCalled();
  });

  it('marks transient session refresh failures as retryable', async () => {
    const failingProvider: UpstreamTokenProvider = jest
      .fn()
      .mockRejectedValue(Object.assign(new Error('service unavailable'), { status: 503 }));

    await expect(
      resolveOboToken(mockUser as IUser, oboConfig, mockResolver, failingProvider),
    ).rejects.toMatchObject({
      reason: 'session_refresh_failed',
      retryable: true,
      userMessage: 'Temporary sign-in session refresh failure.',
    });
    expect(mockResolver).not.toHaveBeenCalled();
  });

  it('throws missing_upstream_token when isOpenIDTokenValid returns false (live token expired)', async () => {
    mockIsOpenIDTokenValid.mockReturnValue(false);

    await expect(
      resolveOboToken(mockUser as IUser, oboConfig, mockResolver, liveProvider),
    ).rejects.toMatchObject({
      reason: 'missing_upstream_token',
      retryable: false,
    });
    expect(mockResolver).not.toHaveBeenCalled();
  });

  it('throws missing_upstream_access_token when live tokens lack an access_token', async () => {
    (liveProvider as jest.Mock).mockResolvedValueOnce({
      access_token: undefined,
      id_token: 'live-id-token',
      expires_at: farFutureExp,
    });
    /** isOpenIDTokenValid is mocked to true here to isolate the access_token guard */
    mockIsOpenIDTokenValid.mockReturnValue(true);

    await expect(
      resolveOboToken(mockUser as IUser, oboConfig, mockResolver, liveProvider),
    ).rejects.toMatchObject({
      reason: 'missing_upstream_access_token',
      retryable: false,
    });
  });

  it('uses live token from provider for the OBO exchange and returns MCPOAuthTokens', async () => {
    mockIsOpenIDTokenValid.mockReturnValue(true);

    const beforeCall = Date.now();
    const result = await resolveOboToken(mockUser as IUser, oboConfig, mockResolver, liveProvider);
    const afterCall = Date.now();

    expect(liveProvider).toHaveBeenCalledTimes(1);
    expect(mockResolver).toHaveBeenCalledWith(
      mockUser,
      'live-access-token',
      'api://mcp-server-id/Mcp.Tools.ReadWrite',
      true,
      undefined,
    );

    expect(result.access_token).toBe('exchanged-mcp-token');
    expect(result.token_type).toBe('Bearer');
    expect(result.obtained_at).toBeGreaterThanOrEqual(beforeCall);
    expect(result.obtained_at).toBeLessThanOrEqual(afterCall);
    expect(result.expires_at).toBe(result.obtained_at + 3570 * 1000);
  });

  it('defaults expires_in to 3600 when not provided by resolver', async () => {
    const resolverNoExpiry: OboTokenResolver = jest.fn().mockResolvedValue({
      access_token: 'exchanged-token',
    });

    const result = await resolveOboToken(
      mockUser as IUser,
      oboConfig,
      resolverNoExpiry,
      liveProvider,
    );

    expect(result.expires_at).toBe(result.obtained_at + 3570 * 1000);
  });

  it('throws when resolver returns no access_token', async () => {
    const emptyResolver: OboTokenResolver = jest.fn().mockResolvedValue({});
    await expect(
      resolveOboToken(mockUser as IUser, oboConfig, emptyResolver, liveProvider),
    ).rejects.toMatchObject({
      reason: 'empty_exchange_response',
      retryable: false,
    });
  });

  it('preserves empty_exchange_response when the resolver rejects a malformed exchange', async () => {
    const malformedError = Object.assign(
      new Error('The identity provider returned no access token for the OBO exchange'),
      {
        oboFailureReason: 'empty_exchange_response',
        retryable: false,
      },
    );
    const emptyResolver: OboTokenResolver = jest.fn().mockRejectedValue(malformedError);

    await expect(
      resolveOboToken(mockUser as IUser, oboConfig, emptyResolver, liveProvider),
    ).rejects.toMatchObject({
      reason: 'empty_exchange_response',
      retryable: false,
      userMessage: 'The identity provider returned no access token for the OBO exchange.',
    });
  });

  it('throws a retryable error when resolver reports a transient failure', async () => {
    const failingResolver: OboTokenResolver = jest
      .fn()
      .mockRejectedValue(Object.assign(new Error('temporary timeout'), { retryable: true }));

    await expect(
      resolveOboToken(mockUser as IUser, oboConfig, failingResolver, liveProvider),
    ).rejects.toMatchObject({
      reason: 'exchange_failed',
      retryable: true,
      userMessage: 'Temporary OBO token exchange failure.',
    });
  });

  it('throws a non-retryable error when resolver reports a permanent failure', async () => {
    const failingResolver: OboTokenResolver = jest
      .fn()
      .mockRejectedValue(new Error('invalid_grant: assertion invalid'));

    await expect(
      resolveOboToken(mockUser as IUser, oboConfig, failingResolver, liveProvider),
    ).rejects.toMatchObject({
      reason: 'exchange_failed',
      retryable: false,
      userMessage: 'The identity provider rejected the OBO token exchange.',
    });
  });

  it('uses the correct scopes from oboConfig', async () => {
    const customConfig = { scopes: 'api://other-app/Custom.Scope' };
    await resolveOboToken(mockUser as IUser, customConfig, mockResolver, liveProvider);

    expect(mockResolver).toHaveBeenCalledWith(
      mockUser,
      'live-access-token',
      'api://other-app/Custom.Scope',
      true,
      undefined,
    );
  });

  it('forwards identity context to the OBO resolver', async () => {
    const identityContext = {
      openidSubject: 'oidc-sub-456',
      tenantId: 'tenant-a',
      openidIssuer: 'https://issuer.example.com',
    };

    await resolveOboToken(
      mockUser as IUser,
      oboConfig,
      mockResolver,
      liveProvider,
      identityContext,
    );

    expect(mockResolver).toHaveBeenCalledWith(
      mockUser,
      'live-access-token',
      'api://mcp-server-id/Mcp.Tools.ReadWrite',
      true,
      identityContext,
    );
  });

  it('respects custom expires_in from resolver', async () => {
    const shortLivedResolver: OboTokenResolver = jest.fn().mockResolvedValue({
      access_token: 'short-lived-token',
      expires_in: 300,
    });

    const result = await resolveOboToken(
      mockUser as IUser,
      oboConfig,
      shortLivedResolver,
      liveProvider,
    );

    expect(result.expires_at).toBe(result.obtained_at + 270 * 1000);
  });

  it('respects absolute expires_at from cached resolver responses', async () => {
    const absoluteExpiresAt = Date.now() + 120 * 1000;
    const cachedResolver: OboTokenResolver = jest.fn().mockResolvedValue({
      access_token: 'cached-token',
      expires_in: 3600,
      expires_at: absoluteExpiresAt,
    });

    const result = await resolveOboToken(
      mockUser as IUser,
      oboConfig,
      cachedResolver,
      liveProvider,
    );

    expect(result.expires_at).toBe(absoluteExpiresAt - 30 * 1000);
  });

  /** A credential the IdP declares already spent must not reach the MCP connection: `callTool`
   *  checks only for an access token before setting the Authorization header. */
  it.each([0, -60])(
    'rejects an exchange response whose declared expiry has already elapsed: %s',
    async (expiresIn) => {
      const expiredResolver: OboTokenResolver = jest.fn().mockResolvedValue({
        access_token: 'already-expired-token',
        expires_in: expiresIn,
      });

      await expect(
        resolveOboToken(mockUser as IUser, oboConfig, expiredResolver, liveProvider),
      ).rejects.toMatchObject({ reason: 'exchange_failed', retryable: true });
    },
  );

  it('rejects an exchange response carrying an absolute expiry in the past', async () => {
    const expiredResolver: OboTokenResolver = jest.fn().mockResolvedValue({
      access_token: 'already-expired-token',
      expires_in: 3600,
      expires_at: Date.now() - 60_000,
    });

    await expect(
      resolveOboToken(mockUser as IUser, oboConfig, expiredResolver, liveProvider),
    ).rejects.toMatchObject({ reason: 'exchange_failed' });
  });

  it('keeps a positive expires_at lifetime for very short-lived OBO tokens', async () => {
    const shortLivedResolver: OboTokenResolver = jest.fn().mockResolvedValue({
      access_token: 'very-short-lived-token',
      expires_in: 10,
    });

    const result = await resolveOboToken(
      mockUser as IUser,
      oboConfig,
      shortLivedResolver,
      liveProvider,
    );

    expect(result.expires_at).toBe(result.obtained_at + 1000);
  });
});

describe('isOboConfigStillTrusted', () => {
  const adminPerms = {
    [PermissionTypes.MCP_SERVERS]: {
      [Permissions.CONFIGURE_OBO]: true,
    },
  };
  const userPerms = {
    [PermissionTypes.MCP_SERVERS]: {
      [Permissions.CONFIGURE_OBO]: false,
    },
  };
  const noOboPerms = {
    [PermissionTypes.MCP_SERVERS]: {},
  };

  it('returns false when authorId is missing', async () => {
    const result = await isOboConfigStillTrusted({
      authorId: undefined,
      getUserRoleByAuthorId: jest.fn(),
      getRolePermissions: jest.fn(),
    });
    expect(result).toBe(false);
  });

  it('returns false when the author has no role (deleted user)', async () => {
    const result = await isOboConfigStillTrusted({
      authorId: 'gone',
      getUserRoleByAuthorId: jest.fn().mockResolvedValue(null),
      getRolePermissions: jest.fn(),
    });
    expect(result).toBe(false);
  });

  it('returns false when role lookup throws', async () => {
    const result = await isOboConfigStillTrusted({
      authorId: 'u1',
      getUserRoleByAuthorId: jest.fn().mockResolvedValue('ADMIN'),
      getRolePermissions: jest.fn().mockRejectedValue(new Error('db down')),
    });
    expect(result).toBe(false);
  });

  it('returns false when the role lacks CONFIGURE_OBO sub-key (older deployment)', async () => {
    const result = await isOboConfigStillTrusted({
      authorId: 'u1',
      getUserRoleByAuthorId: jest.fn().mockResolvedValue('ADMIN'),
      getRolePermissions: jest.fn().mockResolvedValue(noOboPerms),
    });
    expect(result).toBe(false);
  });

  it('returns false when CONFIGURE_OBO is explicitly false', async () => {
    const result = await isOboConfigStillTrusted({
      authorId: 'u1',
      getUserRoleByAuthorId: jest.fn().mockResolvedValue('USER'),
      getRolePermissions: jest.fn().mockResolvedValue(userPerms),
    });
    expect(result).toBe(false);
  });

  it('returns true when the author still has CONFIGURE_OBO', async () => {
    const result = await isOboConfigStillTrusted({
      authorId: 'u1',
      getUserRoleByAuthorId: jest.fn().mockResolvedValue('ADMIN'),
      getRolePermissions: jest.fn().mockResolvedValue(adminPerms),
    });
    expect(result).toBe(true);
  });
});
