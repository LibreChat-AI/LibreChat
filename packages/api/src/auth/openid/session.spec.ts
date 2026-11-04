import type { OpenIDSessionRefreshDeps } from './session';
import type { RefreshTokenBridgeIdentity } from './types';
import { createOpenIDSessionRefreshService } from './session';
import { createOpenIDSessionCache } from './sessions';

/** Covers only the session-authorization gate in the inline (no-flight) refresh grant. */
describe('OpenID session refresh authorization', () => {
  function setup({ enforcement = false }: { enforcement?: boolean } = {}) {
    const authorization = {
      findOpenIDSession: jest.fn(),
      findOpenIDSessionById: jest.fn(),
      findOpenIDSubject: jest.fn(),
      findOpenIDBinding: jest.fn(),
      findOpenIDBindingBySid: jest.fn(),
    };
    const deps = {
      jwt: { decode: jest.fn(), verify: jest.fn() },
      cookies: { parse: jest.fn(() => ({})) },
      crypto: {
        createHash: jest.fn(() => ({ update: jest.fn(() => ({ digest: jest.fn(() => 'hash') })) })),
      },
      openIdClient: {
        refreshTokenGrant: jest.fn().mockResolvedValue({ access_token: 'new-access' }),
      },
      logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
      defaultRefreshTokenExpiry: 1000,
      isEnabled: jest.fn(() => false),
      math: jest.fn((_value: string | undefined, fallback: number) => fallback),
      createAuthIdentityContext: jest.fn(),
      isOpenIDSessionIdentityMatch: jest.fn(() => true),
      createOpenIDRefreshIdentityTuple: jest.fn(() => null),
      createRefreshTokenBridgeIdentity: jest.fn((): RefreshTokenBridgeIdentity | null => null),
      serializeAuthIdentityTuple: jest.fn(() => 'tuple'),
      buildOpenIDRefreshParams: jest.fn(() => ({})),
      setRefreshTokenCookie: jest.fn(),
      setOpenIDMarkerCookies: jest.fn(),
      storeOpenIdSession: jest.fn().mockResolvedValue(true),
      normalizeExpiresIn: jest.fn(() => undefined),
      upsertSession: jest.fn(),
      deleteSession: jest.fn(),
      getOpenIdConfig: jest.fn(() => ({})),
      OPENID_REFRESH_BRIDGE_GRACE_MS: 1000,
      storeRefreshTokenBridge: jest.fn(),
      deleteRefreshTokenBridges: jest.fn(),
      acquireOpenIDRefreshFlight: jest.fn(),
      completeOpenIDRefreshFlight: jest.fn(),
      createOpenIDRefreshFlightKey: jest.fn(() => null),
      createRefreshTokenBridgeFlightKey: jest.fn(() => null),
      failOpenIDRefreshFlight: jest.fn(),
      waitForOpenIDRefreshFlight: jest.fn(),
      assertOpenIDRefreshFlightAvailable: jest.fn().mockResolvedValue(true),
      assertOpenIDRefreshSessionGenerationAvailable: jest.fn().mockResolvedValue(true),
      withOpenIDRefreshFlightLease: jest.fn(({ operation }) =>
        operation({
          assertLeaseOwned: jest.fn().mockResolvedValue(true),
          markLeaseSettled: jest.fn(),
        }),
      ),
      getOpenIdClientId: jest.fn(() => 'client'),
      sessionAuthorization: {
        authorization,
        enforcement,
        timeoutMs: 50,
        cache: createOpenIDSessionCache(),
      },
    } satisfies OpenIDSessionRefreshDeps;
    const service = createOpenIDSessionRefreshService(deps);
    const req = {
      session: {
        openidTokens: {
          refreshToken: 'refresh',
          browserRefreshToken: 'refresh',
          accessToken: 'old-access',
          openidSessionId: 'session-1',
        },
        save: (callback: (error?: Error | null) => void) => callback(null),
      },
    };
    const res = { headersSent: false, cookie: jest.fn(), clearCookie: jest.fn() };
    const user = { _id: 'user', openidIssuer: 'issuer', openidId: 'subject', tenantId: 'tenant' };
    return { deps, service, req, res, user, authorization };
  }

  it('denies the refresh before the grant when the session is already revoked', async () => {
    const { deps, service, req, res, user, authorization } = setup({ enforcement: true });
    authorization.findOpenIDSessionById.mockResolvedValue({
      subject: 'subject',
      issuer: 'issuer',
      clientId: 'client',
      revokedAt: new Date(),
    });
    authorization.findOpenIDSubject.mockResolvedValue(null);
    await expect(
      service.refreshOpenIDSession(req, res, user, 'access_token', undefined, {
        forceRefresh: true,
      }),
    ).rejects.toThrow('OpenID session authorization denied');
    expect(deps.openIdClient.refreshTokenGrant).not.toHaveBeenCalled();
  });

  it('fails the refresh before the grant when authorization is unavailable', async () => {
    const { deps, service, req, res, user, authorization } = setup({ enforcement: true });
    authorization.findOpenIDSessionById.mockImplementation(() => new Promise(() => {}));
    authorization.findOpenIDSubject.mockImplementation(() => new Promise(() => {}));
    await expect(
      service.refreshOpenIDSession(req, res, user, 'access_token', undefined, {
        forceRefresh: true,
      }),
    ).rejects.toThrow('temporarily unavailable');
    expect(deps.openIdClient.refreshTokenGrant).not.toHaveBeenCalled();
  });

  it('denies the inline grant and rolls back the express session it just wrote', async () => {
    const { deps, service, req, res, user, authorization } = setup({ enforcement: true });
    authorization.findOpenIDSessionById
      .mockResolvedValueOnce({
        subject: 'subject',
        issuer: 'issuer',
        clientId: 'client',
        firstLoginIat: 100,
      })
      .mockResolvedValueOnce({
        subject: 'subject',
        issuer: 'issuer',
        clientId: 'client',
        revokedAt: new Date(),
      });
    authorization.findOpenIDSubject.mockResolvedValue(null);
    authorization.findOpenIDBinding.mockResolvedValue({ id: 'b' });
    await expect(
      service.refreshOpenIDSession(req, res, user, 'access_token', undefined, {
        forceRefresh: true,
      }),
    ).rejects.toThrow('OpenID session authorization denied');
    expect(req.session.openidTokens).toBeUndefined();
    expect(deps.setRefreshTokenCookie).not.toHaveBeenCalled();
  });

  it('denies a rotated grant, clears the browser cookies and removes the durable session it published', async () => {
    const { deps, service, req, res, user, authorization } = setup({ enforcement: true });
    deps.openIdClient.refreshTokenGrant.mockResolvedValue({
      access_token: 'new-access',
      refresh_token: 'new-refresh',
    });
    deps.createRefreshTokenBridgeIdentity.mockReturnValue({ userId: 'user', tenantId: 'tenant' });
    authorization.findOpenIDSessionById
      .mockResolvedValueOnce({
        subject: 'subject',
        issuer: 'issuer',
        clientId: 'client',
        firstLoginIat: 100,
      })
      .mockResolvedValueOnce({
        subject: 'subject',
        issuer: 'issuer',
        clientId: 'client',
        revokedAt: new Date(),
      });
    authorization.findOpenIDSubject.mockResolvedValue(null);
    authorization.findOpenIDBinding.mockResolvedValue({ id: 'b' });
    await expect(
      service.refreshOpenIDSession(req, res, user, 'access_token', undefined, {
        forceRefresh: true,
      }),
    ).rejects.toThrow('OpenID session authorization denied');
    expect(deps.setRefreshTokenCookie).toHaveBeenCalledWith(res, 'new-refresh', expect.any(Date));
    expect(res.clearCookie).toHaveBeenCalled();
    expect(deps.deleteSession).toHaveBeenCalledWith({ refreshToken: 'new-refresh' });
  });

  it('stores the rotated refresh token and publishes nothing when authorization is unavailable after the grant', async () => {
    const { deps, service, req, res, user, authorization } = setup({ enforcement: true });
    deps.openIdClient.refreshTokenGrant.mockResolvedValue({
      access_token: 'new-access',
      refresh_token: 'new-refresh',
    });
    authorization.findOpenIDSessionById
      .mockResolvedValueOnce({
        subject: 'subject',
        issuer: 'issuer',
        clientId: 'client',
        firstLoginIat: 100,
      })
      .mockImplementationOnce(() => new Promise(() => {}));
    authorization.findOpenIDSubject.mockResolvedValue(null);
    authorization.findOpenIDBinding.mockResolvedValue({ id: 'b' });
    await expect(
      service.refreshOpenIDSession(req, res, user, 'access_token', undefined, {
        forceRefresh: true,
      }),
    ).rejects.toThrow('temporarily unavailable');
    expect(req.session.openidTokens.refreshToken).toBe('new-refresh');
    expect(deps.setRefreshTokenCookie).toHaveBeenCalledWith(res, 'new-refresh', expect.any(Date));
  });

  it('refreshes normally when enforcement is off', async () => {
    const { service, req, res, user } = setup({ enforcement: false });
    const result = await service.refreshOpenIDSession(req, res, user, 'access_token', undefined, {
      forceRefresh: true,
    });
    expect(result?.access_token).toBe('new-access');
    expect(req.session.openidTokens.accessToken).toBe('new-access');
  });
});
