import type { ProviderSessionAuthorizer } from './authorize';
import type { RefreshTokenset } from '~/auth/refresh';
import {
  buildAdminRefreshProviderSessionDeps,
  prepareAdminOpenIdRefresh,
  runAdminOpenIdRefreshGrant,
} from './adminRefreshDeps';

function makeAuthorizer(
  mode: 'off' | 'record' | 'enforce',
): jest.Mocked<ProviderSessionAuthorizer> {
  return {
    establish: jest.fn(),
    authorize: jest.fn(),
    preCheck: jest.fn(),
    getMode: jest.fn().mockResolvedValue(mode),
  };
}

describe('buildAdminRefreshProviderSessionDeps', () => {
  function makeBuildInput(authorizer: jest.Mocked<ProviderSessionAuthorizer>) {
    return {
      authorizer,
      getProviderSessionClient: jest.fn(),
      findProviderSessionBinding: jest.fn(),
      getRefreshTokenBridge: jest.fn(),
      storeRefreshTokenBridge: jest.fn(),
      deleteRefreshTokenBridges: jest.fn(),
      bridgeGraceMs: 60000,
      upsertSession: jest.fn(),
      deleteSession: jest.fn(),
    };
  }

  it('returns an empty object, touching nothing else, when the mode is off', async () => {
    const authorizer = makeAuthorizer('off');
    const input = makeBuildInput(authorizer);

    const deps = await buildAdminRefreshProviderSessionDeps(input);

    expect(deps).toEqual({});
    expect(input.findProviderSessionBinding).not.toHaveBeenCalled();
    expect(input.getProviderSessionClient).not.toHaveBeenCalled();
    expect(input.getRefreshTokenBridge).not.toHaveBeenCalled();
    expect(input.storeRefreshTokenBridge).not.toHaveBeenCalled();
  });

  it('wires the full binding/check/persistence deps when the mode is record or enforce', async () => {
    for (const mode of ['record', 'enforce'] as const) {
      const authorizer = makeAuthorizer(mode);
      const input = makeBuildInput(authorizer);

      const deps = await buildAdminRefreshProviderSessionDeps(input);

      expect(deps.findProviderSessionBinding).toBe(input.findProviderSessionBinding);
      expect(deps.preCheckProviderSession).toBe(authorizer.preCheck);
      expect(deps.authorizeProviderSession).toBe(authorizer.authorize);
      expect(deps.getMode).toBe(authorizer.getMode);
      expect(deps.getProviderSessionClient).toBe(input.getProviderSessionClient);
      expect(deps.upsertSession).toBe(input.upsertSession);
      expect(deps.deleteSession).toBe(input.deleteSession);
      expect(deps.getRefreshTokenBridge).toBe(input.getRefreshTokenBridge);
      expect(deps.storeRefreshTokenBridge).toBe(input.storeRefreshTokenBridge);
      expect(deps.deleteRefreshTokenBridges).toBe(input.deleteRefreshTokenBridges);
      expect(deps.bridgeGraceMs).toBe(input.bridgeGraceMs);
    }
  });

  it('propagates a config-load failure from getMode, mapping to ProviderSessionUnavailableError upstream', async () => {
    const loadError = new Error('config unavailable');
    const authorizer = makeAuthorizer('off');
    authorizer.getMode.mockRejectedValue(loadError);

    await expect(buildAdminRefreshProviderSessionDeps(makeBuildInput(authorizer))).rejects.toBe(
      loadError,
    );
  });
});

describe('prepareAdminOpenIdRefresh', () => {
  function makeBuildInput(mode: 'off' | 'record' | 'enforce') {
    return {
      authorizer: makeAuthorizer(mode),
      getProviderSessionClient: jest.fn(),
      findProviderSessionBinding: jest.fn().mockResolvedValue(null),
      getRefreshTokenBridge: jest.fn(),
      storeRefreshTokenBridge: jest.fn(),
      deleteRefreshTokenBridges: jest.fn(),
      bridgeGraceMs: 60000,
      upsertSession: jest.fn(),
      deleteSession: jest.fn(),
    };
  }

  it('returns the incoming token and a null ref when mode is off', async () => {
    const input = makeBuildInput('off');

    const result = await prepareAdminOpenIdRefresh('refresh-token', input);

    expect(result.grantRefreshToken).toBe('refresh-token');
    expect(result.binding).toEqual({ ref: null });
    expect(result.bridged).toBe(false);
    expect(result.providerSessionDeps).toEqual({});
  });

  it('carries the bound ref through to the returned binding under enforce', async () => {
    const ref = { issuer: 'https://issuer.example.com', clientId: 'test-client', sid: 'sid-1' };
    const input = makeBuildInput('enforce');
    input.findProviderSessionBinding.mockResolvedValue({ providerSession: ref });
    input.authorizer.preCheck.mockResolvedValue({ ok: true });

    const result = await prepareAdminOpenIdRefresh('refresh-token', input);

    expect(result.binding).toEqual({ ref });
    expect(result.grantRefreshToken).toBe('refresh-token');
  });

  it('throws before building deps a second time when preCheck denies', async () => {
    const input = makeBuildInput('enforce');
    input.authorizer.preCheck.mockResolvedValue({ ok: false, code: 'OPENID_SESSION_ENDED' });

    await expect(prepareAdminOpenIdRefresh('refresh-token', input)).rejects.toMatchObject({
      name: 'AdminRefreshError',
      code: 'OPENID_SESSION_ENDED',
      status: 401,
    });
  });

  it('swaps in a bridged token recovered from a prior attempt', async () => {
    const input = makeBuildInput('enforce');
    input.authorizer.preCheck.mockResolvedValue({ ok: true });
    input.findProviderSessionBinding.mockResolvedValue({ userId: 'user-1' });
    input.getRefreshTokenBridge.mockResolvedValue({ refreshToken: 'bridged-refresh' });

    const result = await prepareAdminOpenIdRefresh('refresh-token', input, {
      expectedIssuer: 'https://issuer.example.com',
    });

    expect(result.grantRefreshToken).toBe('bridged-refresh');
    expect(result.bridged).toBe(true);
    expect(result.identity).toEqual({
      userId: 'user-1',
      tenantId: undefined,
      openidIssuer: 'https://issuer.example.com',
    });
  });

  it('reads the provider-session binding once, sharing it between the precheck and the bridge resolution', async () => {
    const input = makeBuildInput('enforce');
    input.authorizer.preCheck.mockResolvedValue({ ok: true });
    input.findProviderSessionBinding.mockResolvedValue({ userId: 'user-1' });
    input.getRefreshTokenBridge.mockResolvedValue(null);

    await prepareAdminOpenIdRefresh('refresh-token', input);

    expect(input.findProviderSessionBinding).toHaveBeenCalledTimes(1);
  });
});

describe('runAdminOpenIdRefreshGrant', () => {
  function makeTokenset(overrides: Partial<RefreshTokenset> = {}): RefreshTokenset {
    return {
      access_token: 'access-token',
      refresh_token: 'rotated-refresh',
      claims: () => ({ sub: 'idp-sub' }),
      ...overrides,
    };
  }

  it('runs the grant directly when the resolved token was not bridged', async () => {
    const grant = jest.fn().mockResolvedValue(makeTokenset());
    const deps = {
      createRefreshTokenBridgeFlightKey: jest.fn(),
      acquireOpenIDRefreshFlight: jest.fn(),
      withOpenIDRefreshFlightLease: jest.fn(),
    };

    const result = await runAdminOpenIdRefreshGrant(
      grant,
      'presented-token',
      { bridged: false },
      deps,
    );

    expect(grant).toHaveBeenCalledTimes(1);
    expect(result.refresh_token).toBe('rotated-refresh');
    expect(deps.createRefreshTokenBridgeFlightKey).not.toHaveBeenCalled();
  });

  it('runs the grant directly when bridged but the flight deps are not wired', async () => {
    const grant = jest.fn().mockResolvedValue(makeTokenset());

    const result = await runAdminOpenIdRefreshGrant(
      grant,
      'presented-token',
      { bridged: true, identity: { userId: 'user-1' } },
      {},
    );

    expect(grant).toHaveBeenCalledTimes(1);
    expect(result.refresh_token).toBe('rotated-refresh');
  });

  it('runs the grant directly, without throwing, when bridged is true but the identity has no userId', async () => {
    const grant = jest.fn().mockResolvedValue(makeTokenset());
    const deps = {
      createRefreshTokenBridgeFlightKey: jest.fn(),
      acquireOpenIDRefreshFlight: jest.fn(),
      withOpenIDRefreshFlightLease: jest.fn(),
    };

    const result = await runAdminOpenIdRefreshGrant(
      grant,
      'presented-token',
      { bridged: true, identity: undefined },
      deps,
    );

    expect(grant).toHaveBeenCalledTimes(1);
    expect(result.refresh_token).toBe('rotated-refresh');
    expect(deps.createRefreshTokenBridgeFlightKey).not.toHaveBeenCalled();
  });

  it('runs the grant directly when a flight key is produced but acquireOpenIDRefreshFlight is not wired', async () => {
    const grant = jest.fn().mockResolvedValue(makeTokenset());
    const withOpenIDRefreshFlightLease = jest.fn();
    const deps = {
      createRefreshTokenBridgeFlightKey: jest.fn().mockReturnValue('flight-key'),
      withOpenIDRefreshFlightLease,
    };

    const result = await runAdminOpenIdRefreshGrant(
      grant,
      'presented-token',
      { bridged: true, identity: { userId: 'user-1' } },
      deps,
    );

    expect(grant).toHaveBeenCalledTimes(1);
    expect(result.refresh_token).toBe('rotated-refresh');
    expect(withOpenIDRefreshFlightLease).not.toHaveBeenCalled();
  });

  it('runs the grant directly when a flight key is produced but withOpenIDRefreshFlightLease is not wired', async () => {
    const grant = jest.fn().mockResolvedValue(makeTokenset());
    const acquireOpenIDRefreshFlight = jest.fn();
    const deps = {
      createRefreshTokenBridgeFlightKey: jest.fn().mockReturnValue('flight-key'),
      acquireOpenIDRefreshFlight,
    };

    const result = await runAdminOpenIdRefreshGrant(
      grant,
      'presented-token',
      { bridged: true, identity: { userId: 'user-1' } },
      deps,
    );

    expect(grant).toHaveBeenCalledTimes(1);
    expect(result.refresh_token).toBe('rotated-refresh');
    expect(acquireOpenIDRefreshFlight).not.toHaveBeenCalled();
  });

  it('runs the grant directly when createRefreshTokenBridgeFlightKey returns null, even though acquire/lease are wired', async () => {
    const grant = jest.fn().mockResolvedValue(makeTokenset());
    const acquireOpenIDRefreshFlight = jest.fn();
    const withOpenIDRefreshFlightLease = jest.fn();
    const deps = {
      createRefreshTokenBridgeFlightKey: jest.fn().mockReturnValue(null),
      acquireOpenIDRefreshFlight,
      withOpenIDRefreshFlightLease,
    };

    const result = await runAdminOpenIdRefreshGrant(
      grant,
      'presented-token',
      { bridged: true, identity: { userId: 'user-1' } },
      deps,
    );

    expect(grant).toHaveBeenCalledTimes(1);
    expect(result.refresh_token).toBe('rotated-refresh');
    expect(acquireOpenIDRefreshFlight).not.toHaveBeenCalled();
    expect(withOpenIDRefreshFlightLease).not.toHaveBeenCalled();
  });

  it('runs the winning grant inside the flight lease and publishes identity claims for a loser to reconstruct', async () => {
    const tokenset = makeTokenset({
      claims: () => ({ sub: 'idp-sub', iss: 'https://issuer.example.com' }),
    });
    const grant = jest.fn().mockResolvedValue(tokenset);
    const completeOpenIDRefreshFlight = jest.fn().mockResolvedValue(undefined);
    const withOpenIDRefreshFlightLease = jest
      .fn()
      .mockImplementation(({ operation }) => operation({ assertLeaseOwned: jest.fn() }));
    const deps = {
      createRefreshTokenBridgeFlightKey: jest.fn().mockReturnValue('flight-key'),
      acquireOpenIDRefreshFlight: jest
        .fn()
        .mockResolvedValue({ acquired: true, ownerId: 'owner-1' }),
      completeOpenIDRefreshFlight,
      waitForOpenIDRefreshFlight: jest.fn(),
      withOpenIDRefreshFlightLease,
    };

    const result = await runAdminOpenIdRefreshGrant(
      grant,
      'presented-token',
      { bridged: true, identity: { userId: 'user-1', tenantId: 'tenant-a' } },
      deps,
    );

    expect(grant).toHaveBeenCalledTimes(1);
    expect(deps.createRefreshTokenBridgeFlightKey).toHaveBeenCalledWith({
      oldRefreshToken: 'presented-token',
      userId: 'user-1',
      tenantId: 'tenant-a',
      openidIssuer: undefined,
    });
    expect(deps.acquireOpenIDRefreshFlight).toHaveBeenCalledWith({ key: 'flight-key' });
    expect(withOpenIDRefreshFlightLease).toHaveBeenCalledWith(
      expect.objectContaining({ key: 'flight-key', ownerId: 'owner-1' }),
    );
    expect(completeOpenIDRefreshFlight).toHaveBeenCalledWith({
      key: 'flight-key',
      ownerId: 'owner-1',
      tokens: {
        access_token: 'access-token',
        refresh_token: 'rotated-refresh',
        __identityClaims: { sub: 'idp-sub', iss: 'https://issuer.example.com' },
      },
    });
    expect(result.refresh_token).toBe('rotated-refresh');
  });

  it('completes the flight without throwing when completeOpenIDRefreshFlight is not wired', async () => {
    const tokenset = makeTokenset();
    const grant = jest.fn().mockResolvedValue(tokenset);
    const deps = {
      createRefreshTokenBridgeFlightKey: jest.fn().mockReturnValue('flight-key'),
      acquireOpenIDRefreshFlight: jest
        .fn()
        .mockResolvedValue({ acquired: true, ownerId: 'owner-1' }),
      withOpenIDRefreshFlightLease: jest
        .fn()
        .mockImplementation(({ operation }) => operation({ assertLeaseOwned: jest.fn() })),
    };

    const result = await runAdminOpenIdRefreshGrant(
      grant,
      'presented-token',
      { bridged: true, identity: { userId: 'user-1' } },
      deps,
    );

    expect(result.refresh_token).toBe('rotated-refresh');
  });

  it('coalesces two concurrent bridged retries into a single IdP grant: the loser waits and reconstructs the winner result', async () => {
    const grant = jest.fn().mockResolvedValue(makeTokenset());
    const resolvedClaims = { sub: 'idp-sub', iss: 'https://issuer.example.com' };
    const deps = {
      createRefreshTokenBridgeFlightKey: jest.fn().mockReturnValue('flight-key'),
      acquireOpenIDRefreshFlight: jest
        .fn()
        .mockResolvedValue({ acquired: false, ownerId: 'owner-2' }),
      withOpenIDRefreshFlightLease: jest.fn(),
      waitForOpenIDRefreshFlight: jest.fn().mockResolvedValue({
        access_token: 'winner-access',
        refresh_token: 'winner-refresh',
        __identityClaims: resolvedClaims,
      }),
    };

    const result = await runAdminOpenIdRefreshGrant(
      grant,
      'presented-token',
      { bridged: true, identity: { userId: 'user-1' } },
      deps,
    );

    expect(grant).not.toHaveBeenCalled();
    expect(deps.withOpenIDRefreshFlightLease).not.toHaveBeenCalled();
    expect(deps.waitForOpenIDRefreshFlight).toHaveBeenCalledWith({ key: 'flight-key' });
    expect(result.access_token).toBe('winner-access');
    expect(result.refresh_token).toBe('winner-refresh');
    expect(result.claims()).toEqual(resolvedClaims);
  });

  it('treats a missing waitForOpenIDRefreshFlight as unresolved and throws ProviderSessionUnavailableError', async () => {
    const grant = jest.fn();
    const deps = {
      createRefreshTokenBridgeFlightKey: jest.fn().mockReturnValue('flight-key'),
      acquireOpenIDRefreshFlight: jest
        .fn()
        .mockResolvedValue({ acquired: false, ownerId: 'owner-2' }),
      withOpenIDRefreshFlightLease: jest.fn(),
    };

    await expect(
      runAdminOpenIdRefreshGrant(
        grant,
        'presented-token',
        { bridged: true, identity: { userId: 'user-1' } },
        deps,
      ),
    ).rejects.toMatchObject({
      name: 'ProviderSessionUnavailableError',
      message: 'OpenID refresh coordination is temporarily unavailable',
    });
    expect(grant).not.toHaveBeenCalled();
  });

  it('throws ProviderSessionUnavailableError when the loser waits and the flight never resolves', async () => {
    const grant = jest.fn();
    const deps = {
      createRefreshTokenBridgeFlightKey: jest.fn().mockReturnValue('flight-key'),
      acquireOpenIDRefreshFlight: jest
        .fn()
        .mockResolvedValue({ acquired: false, ownerId: 'owner-2' }),
      withOpenIDRefreshFlightLease: jest.fn(),
      waitForOpenIDRefreshFlight: jest.fn().mockResolvedValue(null),
    };

    await expect(
      runAdminOpenIdRefreshGrant(
        grant,
        'presented-token',
        { bridged: true, identity: { userId: 'user-1' } },
        deps,
      ),
    ).rejects.toMatchObject({
      name: 'ProviderSessionUnavailableError',
      message: 'OpenID refresh coordination is temporarily unavailable',
    });
    expect(grant).not.toHaveBeenCalled();
  });
});
