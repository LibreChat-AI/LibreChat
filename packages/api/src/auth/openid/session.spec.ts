import type { OpenIDSessionRefreshDeps } from './session';
import { ProviderSessionUnavailableError } from './providerSession';
import { createOpenIDSessionRefreshService } from './session';

/** Provider-session coverage for both the inline renewal path and the flight-coordinated publication path. */
describe('OpenID session refresh: provider-session authorization', () => {
  const ISSUER = 'https://issuer.example.com';
  const CLIENT_ID = 'client-1';

  function buildSessionTokens(overrides: Record<string, unknown> = {}) {
    return {
      accessToken: 'old-access',
      idToken: 'old-id',
      refreshToken: 'refresh-token-1',
      browserRefreshToken: 'refresh-token-1',
      accessTokenExpiresAt: Math.floor(Date.now() / 1000) - 120,
      appUserId: 'user-1',
      openidSubject: 'sub-1',
      openidIssuer: ISSUER,
      ...overrides,
    };
  }

  function setup() {
    const deps = {
      jwt: {
        decode: jest.fn((token?: string) => {
          if (!token) return null;
          return { sub: 'sub-1', exp: Math.floor(Date.now() / 1000) + 3600 };
        }),
        verify: jest.fn(),
      },
      cookies: { parse: jest.fn(() => ({})) },
      crypto: {
        createHash: jest.fn(() => ({
          update: jest.fn(() => ({ digest: jest.fn(() => 'hashed') })),
        })),
      },
      openIdClient: {
        refreshTokenGrant: jest.fn().mockResolvedValue({
          access_token: 'new-access',
          id_token: 'new-id',
          refresh_token: 'refresh-token-1',
        }),
      },
      logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
      defaultRefreshTokenExpiry: 1000 * 60 * 60 * 24 * 90,
      isEnabled: jest.fn(() => true),
      math: jest.fn((_value: string | undefined, fallback: number) => fallback),
      createAuthIdentityContext: jest.fn(() => ({
        appUserId: 'user-1',
        openidSubject: 'sub-1',
        tenantId: undefined,
        openidIssuer: ISSUER,
      })),
      isOpenIDSessionIdentityMatch: jest.fn(() => true),
      createOpenIDRefreshIdentityTuple: jest.fn(() => null),
      createRefreshTokenBridgeIdentity: jest.fn(() => ({
        userId: 'user-1',
        tenantId: undefined,
        openidIssuer: ISSUER,
      })),
      createRefreshTokenBridgeFlightKey: jest.fn(() => null),
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
      storeRefreshTokenBridge: jest.fn().mockResolvedValue('bridge-version'),
      deleteRefreshTokenBridges: jest.fn().mockResolvedValue(null),
      acquireOpenIDRefreshFlight: jest.fn(),
      completeOpenIDRefreshFlight: jest.fn().mockResolvedValue({ status: 'completed' }),
      createOpenIDRefreshFlightKey: jest.fn((): string | null => null),
      failOpenIDRefreshFlight: jest.fn().mockResolvedValue(null),
      waitForOpenIDRefreshFlight: jest.fn(),
      assertOpenIDRefreshFlightAvailable: jest.fn().mockResolvedValue(true),
      assertOpenIDRefreshSessionGenerationAvailable: jest.fn().mockResolvedValue(true),
      withOpenIDRefreshFlightLease: jest.fn(({ operation }) =>
        operation({
          assertLeaseOwned: jest.fn().mockResolvedValue(true),
          markLeaseSettled: jest.fn(),
        }),
      ),
      providerSessionAuthorizer: {
        establish: jest.fn().mockResolvedValue({ ok: true }),
        authorize: jest.fn().mockResolvedValue({ ok: true }),
        preCheck: jest.fn().mockResolvedValue({ ok: true }),
        getMode: jest.fn().mockResolvedValue('enforce'),
      },
      getProviderSessionClient: jest.fn((): { issuer: string; clientId: string } | null => null),
    } satisfies OpenIDSessionRefreshDeps;
    const service = createOpenIDSessionRefreshService(deps);
    const user = { _id: 'user-1', provider: 'openid', openidId: 'sub-1' };
    return { deps, service, user };
  }

  function buildRequest(sessionTokens: Record<string, unknown>) {
    return {
      session: {
        openidTokens: sessionTokens,
        save: (callback: (error?: Error | null) => void) => callback(null),
        reload: (callback: (error?: Error | null) => void) => callback(null),
      },
    };
  }

  it('denies via preCheck before the IdP grant, and never calls refreshTokenGrant', async () => {
    const boundRef = { issuer: ISSUER, clientId: CLIENT_ID, sid: 'sid-1' };
    const { deps, service, user } = setup();
    deps.providerSessionAuthorizer.preCheck.mockResolvedValue({
      ok: false,
      code: 'OPENID_SESSION_ENDED',
    });
    const req = buildRequest(buildSessionTokens({ providerSession: boundRef }));

    await expect(
      service.refreshOpenIDSession(req, undefined, user, 'access_token', undefined, {
        forceRefresh: true,
      }),
    ).rejects.toMatchObject({ code: 'OPENID_SESSION_ENDED' });

    expect(deps.providerSessionAuthorizer.preCheck).toHaveBeenCalledWith(
      expect.objectContaining({ ref: boundRef }),
    );
    expect(deps.openIdClient.refreshTokenGrant).not.toHaveBeenCalled();
  });

  it('authorizes before the cookie sync on the inline renewal, and leaves the session untouched when denied', async () => {
    const boundRef = { issuer: ISSUER, clientId: CLIENT_ID, sid: 'sid-1' };
    const { deps, service, user } = setup();
    deps.providerSessionAuthorizer.authorize.mockResolvedValue({
      ok: false,
      code: 'OPENID_SESSION_ENDED',
    });
    const sessionTokens = buildSessionTokens({ providerSession: boundRef });
    const req = buildRequest(sessionTokens);

    await expect(
      service.refreshOpenIDSession(req, undefined, user, 'access_token', undefined, {
        forceRefresh: true,
      }),
    ).rejects.toMatchObject({ code: 'OPENID_SESSION_ENDED' });

    // The grant itself ran (preCheck passed); only the post-grant publication is denied.
    expect(deps.openIdClient.refreshTokenGrant).toHaveBeenCalledTimes(1);
    expect(deps.setRefreshTokenCookie).not.toHaveBeenCalled();
    expect(deps.storeRefreshTokenBridge).not.toHaveBeenCalled();
    // No cookie-clear / rollback: the session object is the same reference, untouched.
    expect(req.session.openidTokens).toBe(sessionTokens);
  });

  it('denies a renewal whose fresh claims confirm a different provider session', async () => {
    const boundRef = { issuer: ISSUER, clientId: CLIENT_ID, sid: 'sid-old' };
    const { deps, service, user } = setup();
    deps.getProviderSessionClient.mockReturnValue({ issuer: ISSUER, clientId: CLIENT_ID });
    deps.openIdClient.refreshTokenGrant.mockResolvedValue({
      access_token: 'new-access',
      id_token: 'new-id',
      refresh_token: 'refresh-token-1',
      claims: () => ({ sub: 'sub-1', sid: 'sid-new', iss: ISSUER }),
    });
    const req = buildRequest(buildSessionTokens({ providerSession: boundRef }));

    await expect(
      service.refreshOpenIDSession(req, undefined, user, 'access_token', undefined, {
        forceRefresh: true,
      }),
    ).rejects.toMatchObject({ code: 'OPENID_SESSION_ENDED' });

    // The conflict is caught before the final publication-time authorize call.
    expect(deps.providerSessionAuthorizer.authorize).not.toHaveBeenCalled();
  });

  it('keeps a legacy (never-bound) session unassociated across a bare renewal', async () => {
    const { deps, service, user } = setup();
    const req = buildRequest(buildSessionTokens());

    const result = await service.refreshOpenIDSession(
      req,
      undefined,
      user,
      'access_token',
      undefined,
      {
        forceRefresh: true,
      },
    );

    expect(result?.access_token).toBe('new-access');
    expect(deps.providerSessionAuthorizer.preCheck).toHaveBeenCalledWith(
      expect.objectContaining({ ref: null }),
    );
    expect(deps.providerSessionAuthorizer.authorize).toHaveBeenCalledWith(
      expect.objectContaining({ ref: null, legacy: true }),
    );
    expect(req.session.openidTokens?.providerSession).toBeUndefined();
  });

  it('confirms the bound ref across a bare renewal that carries no sid', async () => {
    const boundRef = { issuer: ISSUER, clientId: CLIENT_ID, sid: 'sid-1' };
    const { deps, service, user } = setup();
    const req = buildRequest(buildSessionTokens({ providerSession: boundRef }));

    await service.refreshOpenIDSession(req, undefined, user, 'access_token', undefined, {
      forceRefresh: true,
    });

    expect(deps.providerSessionAuthorizer.authorize).toHaveBeenCalledWith(
      expect.objectContaining({ ref: boundRef, legacy: false }),
    );
    expect(req.session.openidTokens?.providerSession).toEqual(boundRef);
  });

  it('stores the rotated-token bridge before authorize can reject with ProviderSessionUnavailableError', async () => {
    const boundRef = { issuer: ISSUER, clientId: CLIENT_ID, sid: 'sid-1' };
    const { deps, service, user } = setup();
    deps.openIdClient.refreshTokenGrant.mockResolvedValue({
      access_token: 'new-access',
      id_token: 'new-id',
      refresh_token: 'refresh-token-2',
    });
    let bridgeCallsBeforeAuthorize = -1;
    deps.providerSessionAuthorizer.authorize.mockImplementation(async () => {
      bridgeCallsBeforeAuthorize = deps.storeRefreshTokenBridge.mock.calls.length;
      throw new ProviderSessionUnavailableError('Provider session check unavailable');
    });
    const req = buildRequest(buildSessionTokens({ providerSession: boundRef }));

    await expect(
      service.refreshOpenIDSession(req, undefined, user, 'access_token', undefined, {
        forceRefresh: true,
      }),
    ).rejects.toBeInstanceOf(ProviderSessionUnavailableError);

    expect(bridgeCallsBeforeAuthorize).toBe(1);
    expect(deps.storeRefreshTokenBridge).toHaveBeenCalledWith(
      expect.objectContaining({
        oldRefreshToken: 'refresh-token-1',
        newRefreshToken: 'refresh-token-2',
        userId: 'user-1',
        providerSession: boundRef,
      }),
    );
    expect(deps.deleteRefreshTokenBridges).not.toHaveBeenCalled();
  });

  it('mode off: stores no pre-authorize bridge for a rotated token', async () => {
    const boundRef = { issuer: ISSUER, clientId: CLIENT_ID, sid: 'sid-1' };
    const { deps, service, user } = setup();
    deps.providerSessionAuthorizer.getMode.mockResolvedValue('off');
    deps.openIdClient.refreshTokenGrant.mockResolvedValue({
      access_token: 'new-access',
      id_token: 'new-id',
      refresh_token: 'refresh-token-2',
    });
    let bridgeCallsBeforeAuthorize = -1;
    deps.providerSessionAuthorizer.authorize.mockImplementation(async () => {
      bridgeCallsBeforeAuthorize = deps.storeRefreshTokenBridge.mock.calls.length;
      return { ok: true };
    });
    const req = buildRequest(buildSessionTokens({ providerSession: boundRef }));

    await service.refreshOpenIDSession(req, undefined, user, 'access_token', undefined, {
      forceRefresh: true,
    });

    expect(bridgeCallsBeforeAuthorize).toBe(0);
  });

  it('deletes the pre-authorize bridge when authorize denies the renewal', async () => {
    const boundRef = { issuer: ISSUER, clientId: CLIENT_ID, sid: 'sid-1' };
    const { deps, service, user } = setup();
    deps.openIdClient.refreshTokenGrant.mockResolvedValue({
      access_token: 'new-access',
      id_token: 'new-id',
      refresh_token: 'refresh-token-2',
    });
    deps.providerSessionAuthorizer.authorize.mockResolvedValue({
      ok: false,
      code: 'OPENID_SESSION_ENDED',
    });
    const req = buildRequest(buildSessionTokens({ providerSession: boundRef }));

    await expect(
      service.refreshOpenIDSession(req, undefined, user, 'access_token', undefined, {
        forceRefresh: true,
      }),
    ).rejects.toMatchObject({ code: 'OPENID_SESSION_ENDED' });

    expect(deps.storeRefreshTokenBridge).toHaveBeenCalledWith(
      expect.objectContaining({
        oldRefreshToken: 'refresh-token-1',
        newRefreshToken: 'refresh-token-2',
      }),
    );
    expect(deps.deleteRefreshTokenBridges).toHaveBeenCalledWith(
      expect.objectContaining({
        refreshTokens: ['refresh-token-1'],
        userId: 'user-1',
        version: 'bridge-version',
      }),
    );
  });

  it('never calls the provider-session authorizer or the IdP when the live token is still valid', async () => {
    const { deps, service, user } = setup();
    const req = buildRequest(
      buildSessionTokens({ accessTokenExpiresAt: Math.floor(Date.now() / 1000) + 3600 }),
    );

    const result = await service.refreshOpenIDSession(req, undefined, user, 'access_token');

    expect(result?.access_token).toBe('old-access');
    expect(deps.openIdClient.refreshTokenGrant).not.toHaveBeenCalled();
    expect(deps.providerSessionAuthorizer.preCheck).not.toHaveBeenCalled();
    expect(deps.providerSessionAuthorizer.authorize).not.toHaveBeenCalled();
  });

  it('carries the merged ref onto the flight result for a follower to re-authorize independently', async () => {
    const boundRef = { issuer: ISSUER, clientId: CLIENT_ID, sid: 'sid-1' };
    const { deps, service, user } = setup();
    deps.createOpenIDRefreshFlightKey.mockReturnValue('flight-key');
    deps.acquireOpenIDRefreshFlight.mockResolvedValue({
      acquired: true,
      ownerId: 'owner-1',
      key: 'flight-key',
    });
    const req = buildRequest(buildSessionTokens({ providerSession: boundRef }));

    await service.refreshOpenIDSession(req, undefined, user, 'access_token', undefined, {
      forceRefresh: true,
    });

    // The owner publishes through the same shared authorize() gate as any follower would.
    expect(deps.providerSessionAuthorizer.authorize).toHaveBeenCalledWith(
      expect.objectContaining({ ref: boundRef, legacy: false }),
    );
    expect(deps.completeOpenIDRefreshFlight).toHaveBeenCalledWith(
      expect.objectContaining({
        tokens: expect.objectContaining({ providerSession: boundRef }),
      }),
    );
  });

  it('denies a flight-coordinated publication without marking the flight ownership lost', async () => {
    const boundRef = { issuer: ISSUER, clientId: CLIENT_ID, sid: 'sid-1' };
    const { deps, service, user } = setup();
    deps.createOpenIDRefreshFlightKey.mockReturnValue('flight-key');
    deps.acquireOpenIDRefreshFlight.mockResolvedValue({
      acquired: true,
      ownerId: 'owner-1',
      key: 'flight-key',
    });
    deps.providerSessionAuthorizer.authorize.mockResolvedValue({
      ok: false,
      code: 'OPENID_SESSION_ENDED',
    });
    const req = buildRequest(buildSessionTokens({ providerSession: boundRef }));

    await expect(
      service.refreshOpenIDSession(req, undefined, user, 'access_token', undefined, {
        forceRefresh: true,
      }),
    ).rejects.toMatchObject({ code: 'OPENID_SESSION_ENDED' });

    expect(deps.completeOpenIDRefreshFlight).not.toHaveBeenCalled();
    expect(deps.failOpenIDRefreshFlight).toHaveBeenCalledWith(
      expect.objectContaining({ key: 'flight-key', ownerId: 'owner-1' }),
    );
    // Denial is not ownership loss: no rollback, no cookie clear.
    expect(deps.setRefreshTokenCookie).not.toHaveBeenCalled();
  });
});
