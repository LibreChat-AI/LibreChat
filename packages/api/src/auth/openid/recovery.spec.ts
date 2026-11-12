import type { OpenIDRefreshRecoveryDeps } from './recovery';
import { createOpenIDRefreshRecoveryService } from './recovery';
import { isOpenIDSessionEndedError } from './errors';

describe('OpenID authentication publication settlement', () => {
  function setup() {
    const deps = {
      jwt: { decode: jest.fn() },
      cookies: { parse: jest.fn(() => ({})) },
      getJwtRefreshSecret: () => 'refresh-secret',
      findOpenIDUser: jest.fn(),
      findUser: jest.fn(),
      getOpenIdConfig: jest.fn(),
      getOpenIdEmail: jest.fn(),
      getOpenIdIssuer: jest.fn(),
      createAuthIdentityContext: jest.fn(),
      refreshOpenIDSession: jest.fn(),
      clearOpenIDAuthTokens: jest.fn(),
      deleteOpenIDSession: jest.fn(),
      createOpenIDRefreshFlightKey: jest.fn(),
      storeRefreshTokenBridge: jest.fn(),
      deleteRefreshTokenBridges: jest.fn(),
      waitForOpenIDRefreshFlight: jest.fn(),
      assertOpenIDRefreshSessionGenerationAvailable: jest.fn(),
      revokeOpenIDRefreshFlights: jest.fn(),
      bridgeGraceMs: 1000,
      logger: { debug: jest.fn(), warn: jest.fn() },
      createRefreshTokenBridgeFlightKey: jest.fn(() => 'publication'),
      acquireOpenIDRefreshFlight: jest.fn().mockResolvedValue({
        acquired: true,
        ownerId: 'owner',
      }),
      withOpenIDRefreshFlightLease: jest.fn(({ operation }) =>
        operation({
          assertLeaseOwned: jest.fn().mockResolvedValue(true),
          markLeaseSettled: jest.fn(),
        }),
      ),
      failOpenIDRefreshFlight: jest.fn().mockResolvedValue(null),
      completeOpenIDRefreshFlight: jest.fn().mockResolvedValue({ status: 'completed' }),
      getOpenIDAppAuthToken: jest.fn(() => 'app-token'),
      storeOpenIDSession: jest.fn().mockResolvedValue(undefined),
      assertOpenIDRefreshFlightAvailable: jest.fn().mockResolvedValue(true),
      setOpenIDAuthTokens: jest.fn(() => 'app-token'),
      getRefreshTokenExpiryMs: jest.fn(() => 1000 * 60 * 60 * 24 * 90),
      providerSessionAuthorizer: {
        establish: jest.fn().mockResolvedValue({ ok: true }),
        authorize: jest.fn().mockResolvedValue({ ok: true }),
        preCheck: jest.fn().mockResolvedValue({ ok: true }),
        getMode: jest.fn().mockResolvedValue('enforce'),
      },
      getProviderSessionClient: jest.fn(() => null),
    } satisfies OpenIDRefreshRecoveryDeps;
    const service = createOpenIDRefreshRecoveryService(deps);
    const input = {
      tokenset: { access_token: 'access', id_token: 'id', refresh_token: 'refresh' },
      user: { _id: 'user' },
      existingRefreshToken: 'refresh',
      req: {},
      res: {},
    };
    return { deps, service, input };
  }

  /** A session whose persisted record is gone: the store TTL elapsed, or an eviction removed it. */
  function missingSessionRequest() {
    return {
      session: {
        reload: (callback: (error: Error) => void) => callback(new Error('failed to load session')),
        save: (callback: (error?: Error | null) => void) => callback(null),
      },
    };
  }

  it('publishes into a new session when the persisted record expired', async () => {
    const { deps, service, input } = setup();
    await expect(
      service.sendOpenIDAuthResponse({ ...input, req: missingSessionRequest() }),
    ).resolves.toBe('app-token');
    expect(deps.completeOpenIDRefreshFlight).toHaveBeenCalledTimes(1);
    expect(deps.failOpenIDRefreshFlight).not.toHaveBeenCalled();
  });

  /**
   * Tolerating an absent record leaves the durable revoked publication flight as the only fence
   * against resurrecting a logged-out session, so both of its checks are pinned here: the
   * tombstone read that precedes the reload, and the completion that follows it.
   */
  it('refuses a revoked generation before reloading the expired session', async () => {
    const { deps, service, input } = setup();
    deps.acquireOpenIDRefreshFlight.mockResolvedValue({ acquired: false, ownerId: 'other' });
    deps.waitForOpenIDRefreshFlight.mockRejectedValue(
      new Error('OpenID refresh was revoked by logout'),
    );
    await expect(
      service.sendOpenIDAuthResponse({ ...input, req: missingSessionRequest() }),
    ).rejects.toThrow('revoked by logout');
    expect(deps.completeOpenIDRefreshFlight).not.toHaveBeenCalled();
    expect(deps.setOpenIDAuthTokens).not.toHaveBeenCalled();
  });

  it('withholds tokens when logout revokes the flight after the expired session reloaded', async () => {
    const { deps, service, input } = setup();
    deps.completeOpenIDRefreshFlight.mockResolvedValue(null);
    await expect(
      service.sendOpenIDAuthResponse({ ...input, req: missingSessionRequest() }),
    ).rejects.toThrow('revoked before completion');
    expect(deps.setOpenIDAuthTokens).not.toHaveBeenCalled();
    expect(deps.deleteOpenIDSession).toHaveBeenCalledWith('refresh');
    expect(deps.clearOpenIDAuthTokens).toHaveBeenCalled();
  });

  it('preserves the request error when failure settlement also fails', async () => {
    const { deps, service, input } = setup();
    const error = new Error('session unavailable');
    deps.getOpenIDAppAuthToken.mockImplementation(() => {
      throw error;
    });
    deps.failOpenIDRefreshFlight.mockRejectedValue(new Error('store unavailable'));
    await expect(service.sendOpenIDAuthResponse(input)).rejects.toBe(error);
    expect(deps.logger.warn).toHaveBeenCalled();
  });

  it('does not fail an indeterminate completion write', async () => {
    const { deps, service, input } = setup();
    const error = new Error('completion acknowledgement lost');
    deps.completeOpenIDRefreshFlight.mockImplementation(({ onWriteStart }) => {
      onWriteStart?.();
      return Promise.reject(error);
    });
    await expect(service.sendOpenIDAuthResponse(input)).rejects.toBe(error);
    expect(deps.failOpenIDRefreshFlight).not.toHaveBeenCalled();
  });

  it('settles completion preparation failures before the write starts', async () => {
    const { deps, service, input } = setup();
    const error = new Error('encryption failed');
    deps.completeOpenIDRefreshFlight.mockRejectedValue(error);
    await expect(service.sendOpenIDAuthResponse(input)).rejects.toBe(error);
    expect(deps.failOpenIDRefreshFlight).toHaveBeenCalledWith({
      key: 'publication',
      ownerId: 'owner',
      error,
    });
  });

  it('leaves successful publication completed', async () => {
    const { deps, service, input } = setup();
    await expect(service.sendOpenIDAuthResponse(input)).resolves.toBe('app-token');
    expect(deps.completeOpenIDRefreshFlight).toHaveBeenCalledTimes(1);
    expect(deps.failOpenIDRefreshFlight).not.toHaveBeenCalled();
  });

  it('derives the provider-session expiry from the injected refresh-token-expiry getter', async () => {
    const { deps, service, input } = setup();
    deps.getRefreshTokenExpiryMs.mockReturnValue(5000);
    const before = Date.now();

    await expect(service.sendOpenIDAuthResponse(input)).resolves.toBe('app-token');

    expect(deps.getRefreshTokenExpiryMs).toHaveBeenCalled();
    const { expiresAt } = deps.providerSessionAuthorizer.authorize.mock.calls[0][0];
    expect(expiresAt.getTime()).toBeGreaterThanOrEqual(before + 5000);
    expect(expiresAt.getTime()).toBeLessThan(before + 5000 + 1000);
  });

  describe('with a stale token set left in the Express session', () => {
    function buildStaleSession() {
      return {
        accessToken: 'stale-access',
        idToken: 'stale-id',
        refreshToken: 'stale-refresh',
        accessTokenExpiresAt: Math.floor(Date.now() / 1000) - 120,
      };
    }

    it('publishes the IdP token set at login instead of the stale session set', async () => {
      const { deps, service, input } = setup();
      const req = { session: { openidTokens: buildStaleSession() } };
      await expect(
        service.sendOpenIDAuthResponse({ ...input, req, discardSessionTokens: true }),
      ).resolves.toBe('app-token');
      expect(req.session.openidTokens).toBeUndefined();
      expect(deps.completeOpenIDRefreshFlight).toHaveBeenCalledWith(
        expect.objectContaining({
          tokens: expect.objectContaining({
            tokenset: expect.objectContaining({ access_token: 'access', refresh_token: 'refresh' }),
          }),
        }),
      );
      expect(deps.setOpenIDAuthTokens).toHaveBeenCalledWith(
        expect.objectContaining({ access_token: 'access', refresh_token: 'refresh' }),
        req,
        input.res,
        expect.objectContaining({ userId: 'user', existingRefreshToken: 'refresh' }),
      );
    });

    it('keeps adopting an advanced session on the refresh path', async () => {
      const { deps, service, input } = setup();
      const req = { session: { openidTokens: buildStaleSession() } };
      await expect(service.sendOpenIDAuthResponse({ ...input, req })).resolves.toBe('app-token');
      expect(deps.setOpenIDAuthTokens).toHaveBeenCalledWith(
        expect.objectContaining({ access_token: 'stale-access', refresh_token: 'stale-refresh' }),
        req,
        input.res,
        expect.objectContaining({ existingRefreshToken: 'stale-refresh' }),
      );
    });

    /**
     * A pending refresh's explicit `providerSession` is a stale request value: it was read
     * before another login advanced the Express session to a different provider session. Once
     * the session has advanced, publication must bind to the adopted session's own ref, not the
     * stale request's, or a still-live old SID could authorize publishing credentials whose real
     * SID was revoked.
     */
    describe('when the request carries an explicit providerSession and the session advanced', () => {
      const staleRequestRef = {
        issuer: 'https://idp.example.com',
        clientId: 'librechat',
        sid: 'sid-stale',
      };
      const adoptedSessionRef = {
        issuer: 'https://idp.example.com',
        clientId: 'librechat',
        sid: 'sid-adopted',
      };

      function buildAdvancedSessionRequest() {
        return {
          session: { openidTokens: { ...buildStaleSession(), providerSession: adoptedSessionRef } },
        };
      }

      it('authorizes and publishes against the adopted session ref, not the stale request ref', async () => {
        const { deps, service, input } = setup();
        const req = buildAdvancedSessionRequest();
        await expect(
          service.sendOpenIDAuthResponse({ ...input, req, providerSession: staleRequestRef }),
        ).resolves.toBe('app-token');

        expect(deps.providerSessionAuthorizer.authorize).toHaveBeenCalledWith(
          expect.objectContaining({ ref: adoptedSessionRef }),
        );
        expect(deps.storeOpenIDSession).toHaveBeenCalledWith(
          'user',
          'stale-refresh',
          undefined,
          'stale-refresh',
          expect.objectContaining({ providerSession: adoptedSessionRef }),
        );
        expect(deps.setOpenIDAuthTokens).toHaveBeenCalledWith(
          expect.anything(),
          req,
          input.res,
          expect.objectContaining({ providerSession: adoptedSessionRef }),
        );
      });

      it('ends the session when the adopted ref is denied, even though the stale request ref would be authorized', async () => {
        const { deps, service, input } = setup();
        deps.providerSessionAuthorizer.authorize.mockImplementation(({ ref }) =>
          Promise.resolve({ ok: ref?.sid !== adoptedSessionRef.sid }),
        );
        const req = buildAdvancedSessionRequest();

        const error = await service
          .sendOpenIDAuthResponse({ ...input, req, providerSession: staleRequestRef })
          .catch((caught: unknown) => caught);

        expect(isOpenIDSessionEndedError(error)).toBe(true);
        expect(deps.providerSessionAuthorizer.authorize).toHaveBeenCalledWith(
          expect.objectContaining({ ref: adoptedSessionRef }),
        );
        expect(deps.setOpenIDAuthTokens).not.toHaveBeenCalled();
        expect(deps.deleteOpenIDSession).toHaveBeenCalledWith('stale-refresh');
      });
    });
  });
});

/**
 * A logout can land in the window between a successful IdP refresh grant and the authorizer's
 * check on the provider session that grant is bound to. The prepared successor must not survive
 * that denial, and only an Express session still carrying the denied ref should be wiped.
 */
describe('sendOpenIDAuthResponse: provider-session denial after a successful grant', () => {
  function setup() {
    const deps = {
      jwt: { decode: jest.fn() },
      cookies: { parse: jest.fn(() => ({})) },
      getJwtRefreshSecret: () => 'refresh-secret',
      findOpenIDUser: jest.fn(),
      findUser: jest.fn(),
      getOpenIdConfig: jest.fn(),
      getOpenIdEmail: jest.fn(),
      getOpenIdIssuer: jest.fn(),
      createAuthIdentityContext: jest.fn(),
      refreshOpenIDSession: jest.fn(),
      clearOpenIDAuthTokens: jest.fn(),
      deleteOpenIDSession: jest.fn(),
      createOpenIDRefreshFlightKey: jest.fn(),
      storeRefreshTokenBridge: jest.fn().mockResolvedValue('bridge-v1'),
      deleteRefreshTokenBridges: jest.fn(),
      waitForOpenIDRefreshFlight: jest.fn(),
      assertOpenIDRefreshSessionGenerationAvailable: jest.fn(),
      revokeOpenIDRefreshFlights: jest.fn(),
      bridgeGraceMs: 1000,
      logger: { debug: jest.fn(), warn: jest.fn() },
      createRefreshTokenBridgeFlightKey: jest.fn(() => 'publication'),
      acquireOpenIDRefreshFlight: jest.fn().mockResolvedValue({
        acquired: true,
        ownerId: 'owner',
      }),
      withOpenIDRefreshFlightLease: jest.fn(({ operation }) =>
        operation({
          assertLeaseOwned: jest.fn().mockResolvedValue(true),
          markLeaseSettled: jest.fn(),
        }),
      ),
      failOpenIDRefreshFlight: jest.fn().mockResolvedValue(null),
      completeOpenIDRefreshFlight: jest.fn().mockResolvedValue({ status: 'completed' }),
      getOpenIDAppAuthToken: jest.fn(() => 'app-token'),
      storeOpenIDSession: jest.fn().mockResolvedValue(undefined),
      assertOpenIDRefreshFlightAvailable: jest.fn().mockResolvedValue(true),
      setOpenIDAuthTokens: jest.fn(() => 'app-token'),
      getRefreshTokenExpiryMs: jest.fn(() => 1000 * 60 * 60 * 24 * 90),
      providerSessionAuthorizer: {
        establish: jest.fn().mockResolvedValue({ ok: true }),
        authorize: jest.fn().mockResolvedValue({ ok: false }),
        preCheck: jest.fn().mockResolvedValue({ ok: true }),
        getMode: jest.fn().mockResolvedValue('enforce'),
      },
      getProviderSessionClient: jest.fn(() => null),
    } satisfies OpenIDRefreshRecoveryDeps;
    const service = createOpenIDRefreshRecoveryService(deps);
    const deniedRef = { issuer: 'https://idp.example.com', clientId: 'librechat', sid: 'sid-1' };
    const input = {
      tokenset: { access_token: 'access', id_token: 'id', refresh_token: 'new-refresh' },
      user: { _id: 'user' },
      existingRefreshToken: 'refresh',
      providerSession: deniedRef,
      req: {},
      res: {},
    };
    return { deps, service, input, deniedRef };
  }

  it('deletes the prepared session and the rotated bridge, and clears a matching session ref', async () => {
    const { deps, service, input, deniedRef } = setup();
    const req = { session: { openidTokens: { providerSession: deniedRef } } };

    const error = await service
      .sendOpenIDAuthResponse({ ...input, req })
      .catch((caught: unknown) => caught);

    expect(isOpenIDSessionEndedError(error)).toBe(true);
    expect(deps.deleteOpenIDSession).toHaveBeenCalledWith('new-refresh');
    expect(deps.deleteRefreshTokenBridges).toHaveBeenCalledWith({
      refreshTokens: ['refresh'],
      userId: 'user',
      tenantId: undefined,
      version: 'bridge-v1',
    });
    expect(deps.setOpenIDAuthTokens).not.toHaveBeenCalled();
    expect(req.session.openidTokens).toBeUndefined();
  });

  it('never wipes an Express session bound to a different provider session', async () => {
    const { deps, service, input } = setup();
    const otherRef = { issuer: 'https://idp.example.com', clientId: 'librechat', sid: 'sid-other' };
    const req = { session: { openidTokens: { providerSession: otherRef } } };

    const error = await service
      .sendOpenIDAuthResponse({ ...input, req })
      .catch((caught: unknown) => caught);

    expect(isOpenIDSessionEndedError(error)).toBe(true);
    expect(deps.deleteOpenIDSession).toHaveBeenCalledWith('new-refresh');
    expect(deps.deleteRefreshTokenBridges).toHaveBeenCalledWith({
      refreshTokens: ['refresh'],
      userId: 'user',
      tenantId: undefined,
      version: 'bridge-v1',
    });
    expect(deps.setOpenIDAuthTokens).not.toHaveBeenCalled();
    expect(req.session.openidTokens).toEqual({ providerSession: otherRef });
  });
});

/**
 * While back-channel logout is off, bridge recovery must carry whichever ref the marker or the
 * bridge itself already recorded forward unchanged, instead of discarding it, and must never
 * authorize against the database to do so.
 */
describe('OpenID refresh bridge recovery: provider session while mode is off', () => {
  function setup(overrides: Partial<OpenIDRefreshRecoveryDeps> = {}) {
    const deps = {
      jwt: { decode: jest.fn() },
      cookies: { parse: jest.fn(() => ({})) },
      getJwtRefreshSecret: () => 'refresh-secret',
      findOpenIDUser: jest.fn(),
      findUser: jest.fn(),
      getOpenIdConfig: jest.fn(),
      getOpenIdEmail: jest.fn(),
      getOpenIdIssuer: jest.fn(),
      createAuthIdentityContext: jest.fn(() => ({
        appUserId: 'user-1',
        openidSubject: 'sub-1',
      })),
      refreshOpenIDSession: jest.fn(),
      clearOpenIDAuthTokens: jest.fn(),
      deleteOpenIDSession: jest.fn(),
      createOpenIDRefreshFlightKey: jest.fn(),
      storeRefreshTokenBridge: jest.fn().mockResolvedValue('bridge-version'),
      deleteRefreshTokenBridges: jest.fn(),
      waitForOpenIDRefreshFlight: jest.fn(),
      assertOpenIDRefreshSessionGenerationAvailable: jest.fn(),
      revokeOpenIDRefreshFlights: jest.fn(),
      bridgeGraceMs: 1000,
      logger: { debug: jest.fn(), warn: jest.fn() },
      createRefreshTokenBridgeFlightKey: jest.fn(() => 'bridge-flight-key'),
      acquireOpenIDRefreshFlight: jest.fn().mockResolvedValue({
        acquired: true,
        ownerId: 'owner',
      }),
      withOpenIDRefreshFlightLease: jest.fn(({ operation }) =>
        operation({
          assertLeaseOwned: jest.fn().mockResolvedValue(true),
          markLeaseSettled: jest.fn(),
        }),
      ),
      failOpenIDRefreshFlight: jest.fn().mockResolvedValue(null),
      completeOpenIDRefreshFlight: jest.fn().mockResolvedValue({ status: 'completed' }),
      getOpenIDAppAuthToken: jest.fn(() => 'app-token'),
      storeOpenIDSession: jest.fn().mockResolvedValue(undefined),
      assertOpenIDRefreshFlightAvailable: jest.fn().mockResolvedValue(true),
      setOpenIDAuthTokens: jest.fn(() => 'app-token'),
      getRefreshTokenExpiryMs: jest.fn(() => 1000 * 60 * 60 * 24 * 90),
      providerSessionAuthorizer: {
        establish: jest.fn().mockResolvedValue({ ok: true }),
        authorize: jest.fn().mockResolvedValue({ ok: true }),
        preCheck: jest.fn().mockResolvedValue({ ok: true }),
        getMode: jest.fn().mockResolvedValue('off'),
      },
      getProviderSessionClient: jest.fn(() => null),
      ...overrides,
    } satisfies OpenIDRefreshRecoveryDeps;
    const service = createOpenIDRefreshRecoveryService(deps);
    return { deps, service };
  }

  function buildReq() {
    return {
      session: {
        save: (callback: (error?: Error | null) => void) => callback(null),
        reload: (callback: (error?: Error | null) => void) => callback(null),
      },
    };
  }

  const ref = { issuer: 'https://idp.example.com', clientId: 'librechat', sid: 'sid-1' };
  const bridgeUser = { _id: 'user-1', provider: 'openid', openidId: 'sub-1' };

  it('seeds the Express session with the bridge ref when the marker carries none', async () => {
    let captured: unknown;
    const { deps, service } = setup({
      refreshOpenIDSession: jest.fn(async (req) => {
        captured = (req as { session: { openidTokens?: { providerSession?: unknown } } }).session
          .openidTokens?.providerSession;
        throw new Error('stop-after-seed');
      }),
    });
    const req = buildReq();

    await expect(
      service.recoverOpenIDRefreshBridge({
        req: req as never,
        res: {} as never,
        refreshToken: 'cookie-refresh',
        bridgedRefreshToken: 'bridged-refresh',
        bridgeUser,
        bridgeProviderSession: ref,
        markerProviderSession: null,
      }),
    ).rejects.toThrow('stop-after-seed');

    expect(captured).toEqual(ref);
    expect(deps.providerSessionAuthorizer.authorize).not.toHaveBeenCalled();
    expect(deps.providerSessionAuthorizer.establish).not.toHaveBeenCalled();
  });

  it('seeds the Express session with the marker ref when it disagrees with the bridge, denying nothing', async () => {
    const markerRef = {
      issuer: 'https://idp.example.com',
      clientId: 'librechat',
      sid: 'sid-marker',
    };
    let captured: unknown;
    const { deps, service } = setup({
      refreshOpenIDSession: jest.fn(async (req) => {
        captured = (req as { session: { openidTokens?: { providerSession?: unknown } } }).session
          .openidTokens?.providerSession;
        throw new Error('stop-after-seed');
      }),
    });
    const req = buildReq();

    await expect(
      service.recoverOpenIDRefreshBridge({
        req: req as never,
        res: {} as never,
        refreshToken: 'cookie-refresh',
        bridgedRefreshToken: 'bridged-refresh',
        bridgeUser,
        bridgeProviderSession: ref,
        markerProviderSession: markerRef,
      }),
    ).rejects.toThrow('stop-after-seed');

    // Mode off never denies on a marker/bridge mismatch; the marker ref simply takes precedence.
    expect(captured).toEqual(markerRef);
    expect(deps.providerSessionAuthorizer.authorize).not.toHaveBeenCalled();
    expect(deps.providerSessionAuthorizer.establish).not.toHaveBeenCalled();
  });

  it('creates no binding when neither the marker nor the bridge has one', async () => {
    let captured: unknown;
    let sawProviderSessionKey = true;
    const { deps, service } = setup({
      refreshOpenIDSession: jest.fn(async (req) => {
        const openidTokens = (req as { session: { openidTokens?: Record<string, unknown> } })
          .session.openidTokens;
        sawProviderSessionKey = Boolean(openidTokens && 'providerSession' in openidTokens);
        captured = openidTokens?.providerSession;
        throw new Error('stop-after-seed');
      }),
    });
    const req = buildReq();

    await expect(
      service.recoverOpenIDRefreshBridge({
        req: req as never,
        res: {} as never,
        refreshToken: 'cookie-refresh',
        bridgedRefreshToken: 'bridged-refresh',
        bridgeUser,
        bridgeProviderSession: null,
        markerProviderSession: null,
      }),
    ).rejects.toThrow('stop-after-seed');

    expect(sawProviderSessionKey).toBe(false);
    expect(captured).toBeUndefined();
    expect(deps.providerSessionAuthorizer.authorize).not.toHaveBeenCalled();
    expect(deps.providerSessionAuthorizer.establish).not.toHaveBeenCalled();
  });
});
