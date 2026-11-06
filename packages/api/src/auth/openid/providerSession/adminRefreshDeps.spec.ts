import type { ProviderSessionAuthorizer } from './authorize';
import { buildAdminRefreshProviderSessionDeps } from './adminRefreshDeps';

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
