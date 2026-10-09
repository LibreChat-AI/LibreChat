const mockCreateOAuthReconnectionManager = jest.fn();
const mockGetAppConfig = jest.fn();
const mockPrepareMCPAuthorizationMutation = jest.fn();

jest.mock('@librechat/data-schemas', () => ({
  logger: { info: jest.fn(), error: jest.fn() },
  getTenantId: jest.fn(() => 'tenant-a'),
}));

jest.mock('@librechat/api', () => ({
  prepareMCPAuthorizationMutation: (...args) => mockPrepareMCPAuthorizationMutation(...args),
}));

jest.mock('librechat-data-provider', () => ({
  CacheKeys: { FLOWS: 'flows' },
}));

jest.mock('~/config', () => ({
  createOAuthReconnectionManager: (...args) => mockCreateOAuthReconnectionManager(...args),
  getFlowStateManager: jest.fn(() => ({ type: 'flow-manager' })),
  getMCPManager: jest.fn(() => ({ clearCatalogRecoveryState: jest.fn() })),
}));

jest.mock('~/models', () => ({
  findToken: jest.fn(),
  updateToken: jest.fn(),
  createToken: jest.fn(),
  deleteTokens: jest.fn(),
}));

jest.mock('~/cache', () => ({ getLogStores: jest.fn(() => ({})) }));

jest.mock('~/server/services/Config', () => ({
  getAppConfig: (...args) => mockGetAppConfig(...args),
  invalidateCachedTools: jest.fn(),
}));

jest.mock('~/server/services/MCPAuthorizationFenceRetry', () => ({
  clearMCPAuthorizationFenceRetry: jest.fn(),
  persistMCPAuthorizationFenceRetry: jest.fn(),
}));

const initializeOAuthReconnectManager = require('./initializeOAuthReconnectManager');

describe('initializeOAuthReconnectManager', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCreateOAuthReconnectionManager.mockResolvedValue(undefined);
    mockGetAppConfig.mockResolvedValue({
      mcpSettings: {
        catalogRecovery: {
          authorizationFenceRetryMs: [0, 25],
          authorizationFenceTimeoutMs: 750,
        },
      },
    });
    mockPrepareMCPAuthorizationMutation.mockResolvedValue(jest.fn());
  });

  it('resolves the effective user policy when a reconnect refresh prepares its write', async () => {
    await initializeOAuthReconnectManager();

    expect(mockGetAppConfig).not.toHaveBeenCalled();
    const prepareRefresh = mockCreateOAuthReconnectionManager.mock.calls[0][4];
    const scope = { userId: 'user-1', serverName: 'github' };
    await prepareRefresh(scope);

    expect(mockGetAppConfig).toHaveBeenCalledWith({ tenantId: 'tenant-a', userId: 'user-1' });
    expect(mockPrepareMCPAuthorizationMutation).toHaveBeenCalledWith(
      scope,
      expect.objectContaining({ retryDelaysMs: [0, 25], attemptTimeoutMs: 750 }),
    );
  });
});
