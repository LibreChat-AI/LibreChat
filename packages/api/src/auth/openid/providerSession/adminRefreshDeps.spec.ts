import type { ProviderSessionAuthorizer } from './authorize';
import {
  buildAdminRefreshProviderSessionDeps,
  prepareAdminOpenIdRefresh,
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
    expect(result.releaseBridge).toBeUndefined();
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
    expect(result.releaseBridge).toBeInstanceOf(Function);
  });
});
