const mockController = {
  readMCPResource: jest.fn(),
  listMCPResources: jest.fn(),
  listMCPResourceTemplates: jest.fn(),
  appToolCall: jest.fn(),
  validateMCPApp: jest.fn(),
  serveMCPSandbox: jest.fn(),
  requireMCPAppsEnabled: jest.fn(),
};

jest.mock('@librechat/data-schemas', () => ({
  logger: { error: jest.fn() },
  getTenantId: jest.fn(),
}));
jest.mock('@librechat/api', () => ({
  createAuthIdentityContext: jest.fn(),
  createMCPAppsController: jest.fn(() => mockController),
  prepareMCPAuthorizationMutation: jest.fn(),
}));
jest.mock('~/config', () => ({
  getMCPManager: jest.fn(),
  getFlowStateManager: jest.fn(),
  getMCPServersRegistry: jest.fn(),
}));
jest.mock('~/server/services/Config', () => ({
  getAppConfig: jest.fn(),
  invalidateCachedTools: jest.fn(),
}));
jest.mock('~/server/services/OpenIDSessionRefresh', () => ({
  createOpenIDSessionTokenProvider: jest.fn(),
}));
jest.mock('~/models', () => ({
  findPluginAuthsByKeys: jest.fn(),
  findToken: jest.fn(),
  createToken: jest.fn(),
  updateToken: jest.fn(),
  deleteTokens: jest.fn(),
}));
jest.mock('~/cache', () => ({ getLogStores: jest.fn() }));
jest.mock('~/server/services/MCPAuthorizationFenceRetry', () => ({
  clearMCPAuthorizationFenceRetry: jest.fn(),
  persistMCPAuthorizationFenceRetry: jest.fn(),
}));

const fs = require('fs');
const { CacheKeys } = require('librechat-data-provider');
const { getTenantId } = require('@librechat/data-schemas');
const {
  createAuthIdentityContext,
  createMCPAppsController,
  prepareMCPAuthorizationMutation,
} = require('@librechat/api');
const { getMCPManager, getFlowStateManager, getMCPServersRegistry } = require('~/config');
const { getAppConfig, invalidateCachedTools } = require('~/server/services/Config');
const { createOpenIDSessionTokenProvider } = require('~/server/services/OpenIDSessionRefresh');
const models = require('~/models');
const { getLogStores } = require('~/cache');
const {
  clearMCPAuthorizationFenceRetry,
  persistMCPAuthorizationFenceRetry,
} = require('~/server/services/MCPAuthorizationFenceRetry');

describe('MCP Apps controller wiring', () => {
  const originalAncestors = process.env.MCP_SANDBOX_FRAME_ANCESTORS;

  beforeEach(() => jest.clearAllMocks());
  afterEach(() => {
    if (originalAncestors === undefined) {
      delete process.env.MCP_SANDBOX_FRAME_ANCESTORS;
    } else {
      process.env.MCP_SANDBOX_FRAME_ANCESTORS = originalAncestors;
    }
  });

  it('exports the typed controller handlers and binds server dependencies', async () => {
    process.env.MCP_SANDBOX_FRAME_ANCESTORS = 'https://host.example.com';
    const ensureConfigServers = jest.fn().mockResolvedValue({ srv: { type: 'sse' } });
    const getAllServerConfigs = jest.fn().mockResolvedValue({ srv: { type: 'sse' } });
    const recoverServerConfig = jest.fn().mockResolvedValue({ type: 'sse' });
    const isAppServerConfig = jest.fn().mockResolvedValue(true);
    const resolveCachedAppServerConfig = jest.fn().mockResolvedValue({
      serverConfig: { type: 'sse' },
      connectionOwner: 'operator',
    });
    getLogStores.mockReturnValue('flow-store');
    getFlowStateManager.mockReturnValue('flow-manager');
    getMCPServersRegistry.mockReturnValue({
      ensureConfigServers,
      getAllServerConfigs,
      recoverServerConfig,
      isAppServerConfig,
      resolveCachedAppServerConfig,
    });
    getAppConfig.mockResolvedValue({ mcpSettings: { apps: true } });
    getTenantId.mockReturnValue('tenant-1');
    createAuthIdentityContext.mockReturnValue('identity-context');
    createOpenIDSessionTokenProvider.mockReturnValue('provider');

    jest.isolateModules(() => {
      expect(require('./mcpApps')).toBe(mockController);
    });

    expect(createMCPAppsController).toHaveBeenCalledTimes(1);
    const dependencies = createMCPAppsController.mock.calls[0][0];
    const request = {
      user: { id: 'user-1', role: 'USER', tenantId: 'tenant-1' },
      config: {
        mcpSettings: {
          catalogRecovery: {
            authorizationFenceRetryMs: [0, 25],
            authorizationFenceTimeoutMs: 750,
          },
        },
      },
    };
    const response = {};

    expect(dependencies.getManager).toBe(getMCPManager);
    const appOperationBudget = {};
    getMCPManager.mockReturnValueOnce({ appOperationBudget });
    expect(dependencies.getOperationBudget()).toBe(appOperationBudget);
    expect(dependencies.readSandboxFile).toBe(fs.readFileSync);
    expect(dependencies.sandboxFrameAncestors).toBe('https://host.example.com');
    expect(dependencies.getFlowManager()).toBe('flow-manager');
    expect(getLogStores).toHaveBeenCalledWith(CacheKeys.FLOWS);
    await expect(dependencies.getAppConfig(request)).resolves.toEqual({
      mcpSettings: { apps: true },
    });
    expect(getAppConfig).toHaveBeenCalledWith({
      role: 'USER',
      userId: 'user-1',
      tenantId: 'tenant-1',
      failClosed: true,
    });
    await expect(dependencies.getSandboxCspLimits()).resolves.toEqual({
      maxSourcesPerDirective: 32,
      maxSerializedLength: 4096,
    });
    expect(getAppConfig).toHaveBeenCalledWith({ baseOnly: true, failClosed: true });
    await expect(dependencies.ensureConfigServers({ srv: { type: 'sse' } })).resolves.toEqual({
      srv: { type: 'sse' },
    });
    expect(ensureConfigServers).toHaveBeenCalledWith({ srv: { type: 'sse' } });
    await expect(
      dependencies.getAllServerConfigs('user-1', { srv: { type: 'sse' } }, 'USER'),
    ).resolves.toEqual({ srv: { type: 'sse' } });
    expect(getAllServerConfigs).toHaveBeenCalledWith('user-1', { srv: { type: 'sse' } }, 'USER');
    await expect(
      dependencies.recoverServerConfig('srv', { type: 'sse', inspectionFailed: true }, 'user-1'),
    ).resolves.toEqual({ type: 'sse' });
    expect(recoverServerConfig).toHaveBeenCalledWith(
      'srv',
      { type: 'sse', inspectionFailed: true },
      'user-1',
    );
    await expect(dependencies.isAppServerConfig('srv', { type: 'sse' })).resolves.toBe(true);
    expect(isAppServerConfig).toHaveBeenCalledWith('srv', { type: 'sse' });
    const cachedArgs = {
      serverName: 'srv',
      userId: 'user-1',
      role: 'USER',
      mcpConfig: {},
    };
    await expect(dependencies.resolveCachedAppServerConfig(cachedArgs)).resolves.toEqual({
      serverConfig: { type: 'sse' },
      connectionOwner: 'operator',
    });
    expect(resolveCachedAppServerConfig).toHaveBeenCalledWith(cachedArgs);
    expect(dependencies.findPluginAuthsByKeys).toBe(models.findPluginAuthsByKeys);
    expect(dependencies.tokenMethods).toEqual({
      findToken: models.findToken,
      createToken: models.createToken,
      updateToken: models.updateToken,
      deleteTokens: models.deleteTokens,
    });
    const onOAuthCredentialsChanging = dependencies.createOAuthCredentialsChanging(request);
    const scope = { userId: 'user-1', serverName: 'srv' };
    await onOAuthCredentialsChanging(scope);
    expect(prepareMCPAuthorizationMutation).toHaveBeenCalledWith(scope, {
      invalidateRecoveryGeneration: invalidateCachedTools,
      persistPublicationRetry: persistMCPAuthorizationFenceRetry,
      clearPublicationRetry: clearMCPAuthorizationFenceRetry,
      clearLocalRecovery: expect.any(Function),
      retryDelaysMs: [0, 25],
      attemptTimeoutMs: 750,
    });
    const publicationDependencies = prepareMCPAuthorizationMutation.mock.calls[0][1];
    const manager = { clearCatalogRecoveryState: jest.fn() };
    getMCPManager.mockReturnValue(manager);
    publicationDependencies.clearLocalRecovery('user-1', 'srv', 'generation-2');
    expect(manager.clearCatalogRecoveryState).toHaveBeenCalledWith('user-1', 'srv', 'generation-2');
    expect(dependencies.createUpstreamTokenProvider(request, response, request.user)).toBe(
      'provider',
    );
    expect(createOpenIDSessionTokenProvider).toHaveBeenCalledWith({
      req: request,
      res: response,
      user: request.user,
      identityContext: 'identity-context',
      tokenPreference: 'access_token',
    });
    expect(createAuthIdentityContext).toHaveBeenCalledWith({
      user: request.user,
      tenantId: 'tenant-1',
    });
  });
});
