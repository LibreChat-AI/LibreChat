import type { OpenIDRefreshRecoveryDeps } from './recovery';
import { createOpenIDRefreshRecoveryService } from './recovery';

describe('OpenID authentication publication settlement', () => {
  function setup() {
    const deps = {
      jwt: { decode: jest.fn() },
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
  });
});
