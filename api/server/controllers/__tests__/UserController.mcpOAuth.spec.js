const mockUpdateUserPlugins = jest.fn();
const mockFindToken = jest.fn();
const mockDeleteUserPluginAuth = jest.fn();
const mockGetAppConfig = jest.fn();
const mockInvalidateCachedTools = jest.fn();
const mockGetLogStores = jest.fn();
const mockGetMCPManager = jest.fn();
const mockGetFlowStateManager = jest.fn();
const mockGetMCPServersRegistry = jest.fn();
const mockPersistMCPAuthorizationFenceRetry = jest.fn();
const mockClearMCPAuthorizationFenceRetry = jest.fn();

jest.mock('@librechat/data-schemas', () => ({
  ...jest.requireActual('@librechat/data-schemas'),
  logger: { error: jest.fn(), info: jest.fn(), warn: jest.fn() },
  getTenantId: jest.fn(),
  webSearchKeys: [],
}));

jest.mock('librechat-data-provider', () => ({
  ...jest.requireActual('librechat-data-provider'),
  Tools: {},
  Constants: { mcp_delimiter: '_mcp_', mcp_prefix: 'mcp_' },
  FileSources: {},
}));

jest.mock('@librechat/api', () => ({
  ...jest.requireActual('@librechat/api'),
  MCPOAuthHandler: {
    generateFlowId: jest.fn((userId, serverName, tenantId) => {
      const flowId = `${userId}:${serverName}`;
      return tenantId ? `tenant:${encodeURIComponent(tenantId)}:${flowId}` : flowId;
    }),
    generateTokenFlowId: jest.fn((userId, serverName, tenantId) => {
      const flowId = `${userId}:${serverName}`;
      return tenantId ? `tenant:${encodeURIComponent(tenantId)}:${flowId}` : flowId;
    }),
    deleteFlowAndStateMapping: jest.fn().mockResolvedValue(undefined),
    revokeOAuthToken: jest.fn(),
  },
  MCPTokenStorage: {
    getClientInfoAndMetadata: jest.fn(),
    getTokens: jest.fn(),
    assertCredentialSetBinding: jest.fn(),
    deleteUserTokens: jest.fn().mockResolvedValue(undefined),
  },
  normalizeHttpError: jest.fn((error) => error),
  extractWebSearchEnvVars: jest.fn((params) => params.keys),
  getAppConfigOptionsFromUser: jest.fn((user) => {
    const hasSourceIdentity =
      user != null && Object.prototype.hasOwnProperty.call(user, 'idOnTheSource');
    return {
      role: user?.role,
      userId: user?.id,
      idOnTheSource: user?.id && hasSourceIdentity ? (user.idOnTheSource ?? null) : undefined,
      tenantId: user?.tenantId,
    };
  }),
  needsRefresh: jest.fn(),
  getNewS3URL: jest.fn(),
}));

jest.mock('~/models', () => ({
  updateUserPlugins: (...args) => mockUpdateUserPlugins(...args),
  findToken: mockFindToken,
  deleteTokens: jest.fn(),
}));

jest.mock('~/server/services/PluginService', () => ({
  updateUserPluginAuth: jest.fn(),
  deleteUserPluginAuth: (...args) => mockDeleteUserPluginAuth(...args),
}));

jest.mock('~/server/services/twoFactorService', () => ({
  verifyOTPOrBackupCode: jest.fn(),
}));

jest.mock('~/server/services/AuthService', () => ({
  verifyEmail: jest.fn(),
  resendVerificationEmail: jest.fn(),
}));

jest.mock('~/config', () => ({
  getMCPManager: (...args) => mockGetMCPManager(...args),
  getFlowStateManager: (...args) => mockGetFlowStateManager(...args),
  getMCPServersRegistry: (...args) => mockGetMCPServersRegistry(...args),
}));

jest.mock('~/server/services/Config/getCachedTools', () => ({
  invalidateCachedTools: (...args) => mockInvalidateCachedTools(...args),
}));

jest.mock('~/server/services/MCPAuthorizationFenceRetry', () => ({
  persistMCPAuthorizationFenceRetry: (...args) => mockPersistMCPAuthorizationFenceRetry(...args),
  clearMCPAuthorizationFenceRetry: (...args) => mockClearMCPAuthorizationFenceRetry(...args),
}));

jest.mock('~/server/services/Files/process', () => ({
  processDeleteRequest: jest.fn().mockResolvedValue({ deletedFileIds: [], failedFileIds: [] }),
}));

jest.mock('~/server/services/Agents/triggers', () => ({
  drainAgentTriggerDeliveriesForUser: jest.fn(),
  prepareAgentTriggerUserPurge: jest.fn(),
  cancelAgentTriggerUserPurge: jest.fn(),
  purgeAgentTriggerDeliveriesForUser: jest.fn(),
}));

jest.mock('~/server/services/Endpoints/agents/subagentThreadStore', () => ({
  cancelAndDrainForOwner: jest.fn(),
}));

jest.mock('~/server/services/Config', () => ({
  getAppConfig: (...args) => mockGetAppConfig(...args),
}));

jest.mock('~/cache', () => ({
  getLogStores: (...args) => mockGetLogStores(...args),
}));

const { logger, getTenantId } = require('@librechat/data-schemas');
const { MCPTokenStorage, MCPOAuthHandler } = require('@librechat/api');
const { updateUserPluginsController } = require('~/server/controllers/UserController');

function createResponse() {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  res.send = jest.fn().mockReturnValue(res);
  return res;
}

function createRequest() {
  return {
    user: {
      id: 'user-1',
      _id: 'user-1',
      plugins: [],
      role: 'USER',
    },
    body: {
      pluginKey: 'mcp_test-server',
      action: 'uninstall',
      auth: {},
    },
  };
}

function setupMCPMocks() {
  const flowManager = {
    acquireLease: jest.fn().mockResolvedValue({
      generation: 1,
      release: jest.fn().mockResolvedValue(undefined),
    }),
    deleteFlow: jest.fn().mockResolvedValue(true),
  };
  const mcpManager = {
    disconnectUserConnection: jest.fn().mockResolvedValue(),
  };
  const registry = {
    getServerConfig: jest.fn().mockResolvedValue({
      url: 'https://example.com/mcp',
      oauth: {},
      oauth_headers: {},
    }),
    getOAuthServers: jest.fn().mockResolvedValue(new Set(['test-server'])),
    getAllowedDomains: jest.fn().mockReturnValue([]),
    getAllowedAddresses: jest.fn().mockReturnValue(null),
  };

  // Revocation reads the merged config's mcpSettings allowlists (not the registry getters).
  mockGetAppConfig.mockResolvedValue({
    mcpSettings: { allowedDomains: [], allowedAddresses: null },
  });
  mockUpdateUserPlugins.mockResolvedValue();
  mockDeleteUserPluginAuth.mockResolvedValue();
  mockInvalidateCachedTools.mockResolvedValue();
  mockGetLogStores.mockReturnValue({});
  mockGetFlowStateManager.mockReturnValue(flowManager);
  mockGetMCPManager.mockReturnValue(mcpManager);
  mockGetMCPServersRegistry.mockReturnValue(registry);

  return { flowManager, mcpManager, registry };
}

const credentialSetId = 'credential-set-a';
const storedOAuthBinding = {
  server_url: 'https://example.com/mcp',
  token_endpoint: 'https://example.com/token',
  revocation_endpoint: 'https://example.com/revoke',
  client_source: 'dynamic',
  credential_set_id: credentialSetId,
};

beforeEach(() => {
  jest.clearAllMocks();
  mockPersistMCPAuthorizationFenceRetry.mockResolvedValue('retry-v1');
  mockClearMCPAuthorizationFenceRetry.mockResolvedValue(undefined);
  getTenantId.mockReturnValue(undefined);
  mockFindToken.mockImplementation(async ({ type }) => ({
    token: `encrypted-${type}`,
    metadata: { credential_set_id: credentialSetId },
  }));
});

describe('updateUserPluginsController MCP OAuth cleanup', () => {
  it('does not mutate credentials when durable fence preparation fails', async () => {
    setupMCPMocks();
    const { updateUserPluginAuth } = require('~/server/services/PluginService');
    const error = new Error('retry storage unavailable');
    mockPersistMCPAuthorizationFenceRetry.mockRejectedValueOnce(error);
    const req = createRequest();
    req.body = {
      pluginKey: 'mcp_test-server',
      action: 'install',
      auth: { API_KEY: 'new-key' },
    };

    const res = createResponse();
    await updateUserPluginsController(req, res);

    expect(updateUserPluginAuth).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(500);
    expect(logger.error).toHaveBeenCalledWith('[updateUserPluginsController]', error);
  });

  it('advances the fence after a partial MCP credential batch commits', async () => {
    setupMCPMocks();
    const { updateUserPluginAuth } = require('~/server/services/PluginService');
    const laterFailure = Object.assign(new Error('second field failed'), { status: 400 });
    updateUserPluginAuth.mockResolvedValueOnce({}).mockResolvedValueOnce(laterFailure);
    const req = createRequest();
    req.body = {
      pluginKey: 'mcp_test-server',
      action: 'install',
      auth: { API_KEY: 'new-key', ACCOUNT: 'new-account' },
    };

    const res = createResponse();
    await updateUserPluginsController(req, res);

    expect(mockPersistMCPAuthorizationFenceRetry.mock.invocationCallOrder[0]).toBeLessThan(
      updateUserPluginAuth.mock.invocationCallOrder[0],
    );
    expect(mockInvalidateCachedTools).toHaveBeenCalledWith({
      userId: 'user-1',
      serverName: 'test-server',
    });
    expect(mockClearMCPAuthorizationFenceRetry).toHaveBeenCalledWith(
      { userId: 'user-1', serverName: 'test-server' },
      'retry-v1',
    );
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('invalidates the shared tool generation even when local disconnect fails', async () => {
    const { mcpManager } = setupMCPMocks();
    mcpManager.disconnectUserConnection.mockRejectedValue(new Error('local dispose failed'));
    MCPTokenStorage.getClientInfoAndMetadata.mockResolvedValue(null);

    const res = createResponse();
    await updateUserPluginsController(createRequest(), res);

    expect(mockInvalidateCachedTools).toHaveBeenCalledWith({
      userId: 'user-1',
      serverName: 'test-server',
    });
    expect(mockInvalidateCachedTools.mock.invocationCallOrder[0]).toBeLessThan(
      mcpManager.disconnectUserConnection.mock.invocationCallOrder[0],
    );
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('fails the credential update response when the shared generation fence cannot move', async () => {
    const { mcpManager } = setupMCPMocks();
    const fenceError = new Error('Redis unavailable');
    mockInvalidateCachedTools.mockRejectedValue(fenceError);
    MCPTokenStorage.getClientInfoAndMetadata.mockResolvedValue(null);

    const res = createResponse();
    await updateUserPluginsController(createRequest(), res);

    expect(mcpManager.disconnectUserConnection).toHaveBeenCalledWith('user-1', 'test-server');
    expect(res.status).toHaveBeenCalledWith(500);
    expect(logger.error).toHaveBeenCalledWith('[updateUserPluginsController]', fenceError);
  });

  it('clears stored OAuth token state when client metadata is missing', async () => {
    const { flowManager, mcpManager } = setupMCPMocks();
    MCPTokenStorage.getClientInfoAndMetadata.mockResolvedValue(null);

    const res = createResponse();
    await updateUserPluginsController(createRequest(), res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(MCPTokenStorage.getClientInfoAndMetadata).toHaveBeenCalledWith({
      userId: 'user-1',
      serverName: 'test-server',
      findToken: expect.any(Function),
    });
    expect(mcpManager.disconnectUserConnection.mock.invocationCallOrder[0]).toBeLessThan(
      MCPTokenStorage.getClientInfoAndMetadata.mock.invocationCallOrder[0],
    );
    expect(MCPTokenStorage.deleteUserTokens).toHaveBeenCalledWith({
      userId: 'user-1',
      serverName: 'test-server',
      deleteToken: expect.any(Function),
    });
    expect(flowManager.deleteFlow).toHaveBeenCalledWith('user-1:test-server', 'mcp_get_tokens');
    expect(MCPOAuthHandler.deleteFlowAndStateMapping).toHaveBeenCalledWith(
      'user-1:test-server',
      flowManager,
    );
    expect(MCPOAuthHandler.revokeOAuthToken).not.toHaveBeenCalled();
    expect(mcpManager.disconnectUserConnection).toHaveBeenCalledWith('user-1', 'test-server');
  });

  it('still clears OAuth flow state when stored token deletion fails', async () => {
    const { flowManager } = setupMCPMocks();
    const cleanupError = new Error('DB down');
    MCPTokenStorage.getClientInfoAndMetadata.mockResolvedValue(null);
    MCPTokenStorage.deleteUserTokens.mockRejectedValueOnce(cleanupError);

    const res = createResponse();
    await updateUserPluginsController(createRequest(), res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(flowManager.deleteFlow).toHaveBeenCalledWith('user-1:test-server', 'mcp_get_tokens');
    expect(MCPOAuthHandler.deleteFlowAndStateMapping).toHaveBeenCalledWith(
      'user-1:test-server',
      flowManager,
    );
    expect(logger.warn).toHaveBeenCalledWith(
      '[clearStoredMCPOAuthState] Failed to delete MCP OAuth tokens for test-server:',
      cleanupError,
    );
  });

  it('logs all flow cleanup failures without failing MCP OAuth cleanup', async () => {
    const { flowManager } = setupMCPMocks();
    const getTokensFlowError = new Error('get tokens flow cache down');
    const oauthFlowError = new Error('oauth flow cache down');
    MCPTokenStorage.getClientInfoAndMetadata.mockResolvedValue(null);
    flowManager.deleteFlow.mockRejectedValueOnce(getTokensFlowError);
    MCPOAuthHandler.deleteFlowAndStateMapping.mockRejectedValueOnce(oauthFlowError);

    const res = createResponse();
    await updateUserPluginsController(createRequest(), res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(flowManager.deleteFlow).toHaveBeenCalledWith('user-1:test-server', 'mcp_get_tokens');
    expect(MCPOAuthHandler.deleteFlowAndStateMapping).toHaveBeenCalledWith(
      'user-1:test-server',
      flowManager,
    );
    expect(logger.warn).toHaveBeenCalledWith(
      '[clearStoredMCPOAuthState] Failed to clear MCP OAuth flow state for test-server:',
      getTokensFlowError,
    );
    expect(logger.warn).toHaveBeenCalledWith(
      '[clearStoredMCPOAuthState] Failed to clear MCP OAuth flow state for test-server:',
      oauthFlowError,
    );
  });

  it('clears stored OAuth token state when client metadata cannot be loaded', async () => {
    const { flowManager } = setupMCPMocks();
    MCPTokenStorage.getClientInfoAndMetadata.mockRejectedValue(new Error('invalid client info'));

    const res = createResponse();
    await updateUserPluginsController(createRequest(), res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(logger.warn).toHaveBeenCalledWith(
      '[maybeUninstallOAuthMCP] Unable to load OAuth client metadata for test-server; clearing local MCP OAuth state only.',
      expect.any(Error),
    );
    expect(MCPTokenStorage.deleteUserTokens).toHaveBeenCalledWith({
      userId: 'user-1',
      serverName: 'test-server',
      deleteToken: expect.any(Function),
    });
    expect(flowManager.deleteFlow).toHaveBeenCalledWith('user-1:test-server', 'mcp_get_tokens');
    expect(MCPOAuthHandler.deleteFlowAndStateMapping).toHaveBeenCalledWith(
      'user-1:test-server',
      flowManager,
    );
    expect(MCPTokenStorage.getTokens).not.toHaveBeenCalled();
    expect(MCPOAuthHandler.revokeOAuthToken).not.toHaveBeenCalled();
  });

  it('clears tenant-scoped and legacy OAuth flow state when tenant context exists', async () => {
    const { flowManager } = setupMCPMocks();
    getTenantId.mockReturnValue('tenant-a');
    MCPTokenStorage.getClientInfoAndMetadata.mockResolvedValue(null);

    const res = createResponse();
    await updateUserPluginsController(createRequest(), res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(flowManager.deleteFlow).toHaveBeenCalledWith(
      'tenant:tenant-a:user-1:test-server',
      'mcp_get_tokens',
    );
    expect(MCPOAuthHandler.deleteFlowAndStateMapping).toHaveBeenCalledWith(
      'tenant:tenant-a:user-1:test-server',
      flowManager,
    );
    expect(flowManager.deleteFlow).toHaveBeenCalledWith('user-1:test-server', 'mcp_get_tokens');
    expect(MCPOAuthHandler.deleteFlowAndStateMapping).toHaveBeenCalledWith(
      'user-1:test-server',
      flowManager,
    );
  });

  it('clears stored OAuth token state when server config is missing', async () => {
    const { flowManager, registry } = setupMCPMocks();
    registry.getServerConfig.mockResolvedValue(undefined);

    const res = createResponse();
    await updateUserPluginsController(createRequest(), res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(MCPTokenStorage.deleteUserTokens).toHaveBeenCalledWith({
      userId: 'user-1',
      serverName: 'test-server',
      deleteToken: expect.any(Function),
    });
    expect(flowManager.deleteFlow).toHaveBeenCalledWith('user-1:test-server', 'mcp_get_tokens');
    expect(MCPOAuthHandler.deleteFlowAndStateMapping).toHaveBeenCalledWith(
      'user-1:test-server',
      flowManager,
    );
    expect(MCPTokenStorage.getClientInfoAndMetadata).not.toHaveBeenCalled();
    expect(MCPOAuthHandler.revokeOAuthToken).not.toHaveBeenCalled();
  });

  it('clears stored OAuth token state when server no longer requires OAuth', async () => {
    const { flowManager, registry } = setupMCPMocks();
    registry.getOAuthServers.mockResolvedValue(new Set());

    const res = createResponse();
    await updateUserPluginsController(createRequest(), res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(MCPTokenStorage.deleteUserTokens).toHaveBeenCalledWith({
      userId: 'user-1',
      serverName: 'test-server',
      deleteToken: expect.any(Function),
    });
    expect(flowManager.deleteFlow).toHaveBeenCalledWith('user-1:test-server', 'mcp_get_tokens');
    expect(MCPOAuthHandler.deleteFlowAndStateMapping).toHaveBeenCalledWith(
      'user-1:test-server',
      flowManager,
    );
    expect(MCPTokenStorage.getClientInfoAndMetadata).not.toHaveBeenCalled();
    expect(MCPOAuthHandler.revokeOAuthToken).not.toHaveBeenCalled();
  });

  it('clears stored OAuth token state when token loading fails before provider revocation', async () => {
    const { flowManager } = setupMCPMocks();
    MCPTokenStorage.getClientInfoAndMetadata.mockResolvedValue({
      clientInfo: { client_id: 'client-1' },
      clientMetadata: storedOAuthBinding,
    });
    MCPTokenStorage.getTokens.mockRejectedValue(new Error('token lookup failed'));

    const res = createResponse();
    await updateUserPluginsController(createRequest(), res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(MCPTokenStorage.getTokens).toHaveBeenCalledWith({
      userId: 'user-1',
      serverName: 'test-server',
      findToken: expect.any(Function),
    });
    expect(logger.warn).toHaveBeenCalledWith(
      '[maybeUninstallOAuthMCP] Unable to load OAuth tokens for test-server; clearing local token state.',
      expect.any(Error),
    );
    expect(MCPTokenStorage.deleteUserTokens).toHaveBeenCalledWith({
      userId: 'user-1',
      serverName: 'test-server',
      deleteToken: expect.any(Function),
    });
    expect(flowManager.deleteFlow).toHaveBeenCalledWith('user-1:test-server', 'mcp_get_tokens');
    expect(MCPOAuthHandler.deleteFlowAndStateMapping).toHaveBeenCalledWith(
      'user-1:test-server',
      flowManager,
    );
    expect(MCPOAuthHandler.revokeOAuthToken).not.toHaveBeenCalled();
  });

  it('revokes provider tokens before clearing local token state when token data is available', async () => {
    setupMCPMocks();
    MCPTokenStorage.getClientInfoAndMetadata.mockResolvedValue({
      clientInfo: { client_id: 'client-1', client_secret: 'secret-1' },
      clientMetadata: {
        ...storedOAuthBinding,
        revocation_endpoint: 'https://example.com/revoke',
      },
    });
    MCPTokenStorage.getTokens.mockResolvedValue({
      access_token: 'access-token',
      refresh_token: 'refresh-token',
      credential_set_id: credentialSetId,
    });
    MCPOAuthHandler.revokeOAuthToken.mockResolvedValue();

    const res = createResponse();
    await updateUserPluginsController(createRequest(), res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(MCPTokenStorage.getTokens).toHaveBeenCalledWith({
      userId: 'user-1',
      serverName: 'test-server',
      findToken: expect.any(Function),
    });
    expect(MCPTokenStorage.assertCredentialSetBinding).toHaveBeenCalledWith(
      'test-server',
      credentialSetId,
      expect.objectContaining({ credential_set_id: credentialSetId }),
    );
    expect(MCPOAuthHandler.revokeOAuthToken).toHaveBeenCalledWith(
      'test-server',
      'access-token',
      'access',
      {
        serverUrl: 'https://example.com/mcp',
        clientId: 'client-1',
        clientSecret: 'secret-1',
        revocationEndpoint: 'https://example.com/revoke',
        revocationEndpointAuthMethodsSupported: undefined,
      },
      {},
      [],
      null,
    );
    expect(MCPOAuthHandler.revokeOAuthToken).toHaveBeenCalledWith(
      'test-server',
      'refresh-token',
      'refresh',
      {
        serverUrl: 'https://example.com/mcp',
        clientId: 'client-1',
        clientSecret: 'secret-1',
        revocationEndpoint: 'https://example.com/revoke',
        revocationEndpointAuthMethodsSupported: undefined,
      },
      {},
      [],
      null,
    );
    expect(MCPTokenStorage.deleteUserTokens).toHaveBeenCalledWith({
      userId: 'user-1',
      serverName: 'test-server',
      deleteToken: expect.any(Function),
    });
  });

  it('revokes only the access token when refresh token data is absent', async () => {
    setupMCPMocks();
    MCPTokenStorage.getClientInfoAndMetadata.mockResolvedValue({
      clientInfo: { client_id: 'client-1', client_secret: 'secret-1' },
      clientMetadata: storedOAuthBinding,
    });
    MCPTokenStorage.getTokens.mockResolvedValue({
      access_token: 'access-token',
      credential_set_id: credentialSetId,
    });
    MCPOAuthHandler.revokeOAuthToken.mockResolvedValue();

    const res = createResponse();
    await updateUserPluginsController(createRequest(), res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(MCPOAuthHandler.revokeOAuthToken).toHaveBeenCalledTimes(1);
    expect(MCPOAuthHandler.revokeOAuthToken).toHaveBeenCalledWith(
      'test-server',
      'access-token',
      'access',
      expect.objectContaining({ clientId: 'client-1' }),
      {},
      [],
      null,
    );
    expect(MCPTokenStorage.deleteUserTokens).toHaveBeenCalledWith({
      userId: 'user-1',
      serverName: 'test-server',
      deleteToken: expect.any(Function),
    });
  });

  it('revokes only the refresh token when access token data is absent', async () => {
    setupMCPMocks();
    MCPTokenStorage.getClientInfoAndMetadata.mockResolvedValue({
      clientInfo: { client_id: 'client-1', client_secret: 'secret-1' },
      clientMetadata: storedOAuthBinding,
    });
    MCPTokenStorage.getTokens.mockResolvedValue({
      refresh_token: 'refresh-token',
      credential_set_id: credentialSetId,
    });
    MCPOAuthHandler.revokeOAuthToken.mockResolvedValue();

    const res = createResponse();
    await updateUserPluginsController(createRequest(), res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(MCPOAuthHandler.revokeOAuthToken).toHaveBeenCalledTimes(1);
    expect(MCPOAuthHandler.revokeOAuthToken).toHaveBeenCalledWith(
      'test-server',
      'refresh-token',
      'refresh',
      expect.objectContaining({ clientId: 'client-1' }),
      {},
      [],
      null,
    );
    expect(MCPTokenStorage.deleteUserTokens).toHaveBeenCalledWith({
      userId: 'user-1',
      serverName: 'test-server',
      deleteToken: expect.any(Function),
    });
  });
});
