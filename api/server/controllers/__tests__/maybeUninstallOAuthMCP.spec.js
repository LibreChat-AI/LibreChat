const mockGetTokens = jest.fn();
const mockDeleteUserTokens = jest.fn();
const mockGetClientInfoAndMetadata = jest.fn();
const mockAssertCredentialSetBinding = jest.fn((serverName, tokenCredentialSetId, metadata) => {
  if (!tokenCredentialSetId || tokenCredentialSetId !== metadata?.credential_set_id) {
    throw new Error(`credential set mismatch for ${serverName}`);
  }
});
const mockRevokeOAuthToken = jest.fn();
const mockGetServerConfig = jest.fn();
const mockGetOAuthServers = jest.fn();
const mockGetAllowedDomains = jest.fn();
const mockGetAllowedAddresses = jest.fn();
const mockDeleteFlow = jest.fn();
const mockDeleteFlowAndStateMapping = jest.fn();
const mockGetLogStores = jest.fn();
const mockFindToken = jest.fn();
const mockDeleteTokens = jest.fn();
const mockLoggerInfo = jest.fn();
const mockLoggerWarn = jest.fn();
const mockLoggerError = jest.fn();
const mockGetTenantId = jest.fn();

jest.mock('@librechat/data-schemas', () => ({
  ...jest.requireActual('@librechat/data-schemas'),
  logger: { info: mockLoggerInfo, warn: mockLoggerWarn, error: mockLoggerError },
  getTenantId: (...args) => mockGetTenantId(...args),
  webSearchKeys: [],
}));

jest.mock('@librechat/api', () => {
  return {
    ...jest.requireActual('@librechat/api'),
    MCPOAuthHandler: {
      revokeOAuthToken: (...args) => mockRevokeOAuthToken(...args),
      deleteFlowAndStateMapping: (...args) => mockDeleteFlowAndStateMapping(...args),
      generateFlowId: (userId, serverName, tenantId) => {
        const flowId = `${userId}:${serverName}`;
        return tenantId ? `tenant:${encodeURIComponent(tenantId)}:${flowId}` : flowId;
      },
      generateTokenFlowId: (userId, serverName, tenantId) => {
        const flowId = `${userId}:${serverName}`;
        return tenantId ? `tenant:${encodeURIComponent(tenantId)}:${flowId}` : flowId;
      },
    },
    isOAuthServer: (config) =>
      config.requiresOAuth !== false && (config.requiresOAuth || config.oauth != null),
    MCPTokenStorage: {
      getTokens: (...args) => mockGetTokens(...args),
      getClientInfoAndMetadata: (...args) => mockGetClientInfoAndMetadata(...args),
      assertCredentialSetBinding: (...args) => mockAssertCredentialSetBinding(...args),
      deleteUserTokens: (...args) => mockDeleteUserTokens(...args),
    },
    normalizeHttpError: jest.fn(),
    extractWebSearchEnvVars: jest.fn(),
    needsRefresh: jest.fn(),
    getNewS3URL: jest.fn(),
  };
});

jest.mock('librechat-data-provider', () => ({
  ...jest.requireActual('librechat-data-provider'),
  Tools: {},
  Constants: { mcp_delimiter: '::', mcp_prefix: 'mcp_' },
  FileSources: {},
  ResourceType: {},
}));

jest.mock('~/config', () => ({
  getMCPManager: jest.fn(),
  getFlowStateManager: jest.fn(() => ({
    acquireLease: jest.fn().mockResolvedValue({
      generation: 1,
      release: jest.fn().mockResolvedValue(undefined),
    }),
    deleteFlow: (...args) => mockDeleteFlow(...args),
  })),
  getMCPServersRegistry: jest.fn(() => ({
    getServerConfig: (...args) => mockGetServerConfig(...args),
    getOAuthServers: (...args) => mockGetOAuthServers(...args),
    getAllowedDomains: (...args) => mockGetAllowedDomains(...args),
    getAllowedAddresses: (...args) => mockGetAllowedAddresses(...args),
  })),
}));

jest.mock('~/cache', () => ({
  getLogStores: (...args) => mockGetLogStores(...args),
}));

jest.mock('~/server/services/PluginService', () => ({
  updateUserPluginAuth: jest.fn(),
  deleteUserPluginAuth: jest.fn(),
}));

jest.mock('~/server/services/twoFactorService', () => ({
  verifyOTPOrBackupCode: jest.fn(),
}));

jest.mock('~/server/services/AuthService', () => ({
  verifyEmail: jest.fn(),
  resendVerificationEmail: jest.fn(),
}));

jest.mock('~/server/services/Config/getCachedTools', () => ({
  invalidateCachedTools: jest.fn(),
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
  getAppConfig: jest.fn(),
}));

jest.mock('~/models', () => ({
  findToken: (...args) => mockFindToken(...args),
  deleteTokens: (...args) => mockDeleteTokens(...args),
  updateUser: jest.fn(),
  deleteAllUserSessions: jest.fn(),
  deleteAllSharedLinks: jest.fn(),
  updateUserPlugins: jest.fn(),
  deleteUserById: jest.fn(),
  deleteMessages: jest.fn(),
  deletePresets: jest.fn(),
  deleteUserKey: jest.fn(),
  getUserById: jest.fn(),
  deleteConvos: jest.fn(),
  deleteFiles: jest.fn(),
  getFiles: jest.fn(),
  deleteToolCalls: jest.fn(),
  deleteUserAgents: jest.fn(),
  deleteUserPrompts: jest.fn(),
  deleteTransactions: jest.fn(),
  deleteBalances: jest.fn(),
  deleteAllAgentApiKeys: jest.fn(),
  deleteAssistants: jest.fn(),
  deleteConversationTags: jest.fn(),
  deleteAllUserMemories: jest.fn(),
  deleteActions: jest.fn(),
  removeUserFromAllGroups: jest.fn(),
  deleteAclEntries: jest.fn(),
  getSoleOwnedResourceIds: jest.fn().mockResolvedValue([]),
}));

const { maybeUninstallOAuthMCP } = require('~/server/controllers/UserController');

const userId = 'user-123';
const pluginKey = 'mcp_acme';
const serverName = 'acme';

const serverConfig = {
  url: 'https://acme.example.com',
  oauth: {
    revocation_endpoint: 'https://acme.example.com/revoke',
    revocation_endpoint_auth_methods_supported: ['client_secret_basic'],
  },
  oauth_headers: { 'X-Tenant': 'acme' },
};

const parsedServerConfig = { ...serverConfig };

const appConfig = {
  mcpServers: { acme: serverConfig },
};

const clientInfo = { client_id: 'cid', client_secret: 'csec' };
const credentialSetId = 'credential-set-a';
const clientMetadata = {
  credential_set_id: credentialSetId,
  server_url: 'https://acme.example.com',
  token_endpoint: 'https://acme.example.com/token',
  client_source: 'dynamic',
  revocation_endpoint: 'https://acme.example.com/revoke',
  revocation_endpoint_auth_methods_supported: ['client_secret_basic'],
};

function setupOAuthServerFound() {
  mockGetServerConfig.mockResolvedValue(serverConfig);
  mockGetOAuthServers.mockResolvedValue(new Set([serverName]));
  mockGetAllowedDomains.mockReturnValue(['https://acme.example.com']);
  mockGetAllowedAddresses.mockReturnValue(null);
  mockGetClientInfoAndMetadata.mockResolvedValue({ clientInfo, clientMetadata });
  mockFindToken.mockImplementation(async ({ type }) => ({
    token: `encrypted-${type}`,
    metadata: { credential_set_id: credentialSetId },
  }));
}

describe('maybeUninstallOAuthMCP', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockAssertCredentialSetBinding.mockImplementation(
      (currentServerName, tokenCredentialSetId, metadata) => {
        if (!tokenCredentialSetId || tokenCredentialSetId !== metadata?.credential_set_id) {
          throw new Error(`credential set mismatch for ${currentServerName}`);
        }
      },
    );
    mockGetTenantId.mockReturnValue(undefined);
  });

  test('is a no-op when pluginKey is not an MCP key', async () => {
    await maybeUninstallOAuthMCP(userId, 'plugin_google_calendar', appConfig);

    expect(mockGetServerConfig).not.toHaveBeenCalled();
    expect(mockGetTokens).not.toHaveBeenCalled();
    expect(mockDeleteUserTokens).not.toHaveBeenCalled();
    expect(mockDeleteFlow).not.toHaveBeenCalled();
    expect(mockDeleteFlowAndStateMapping).not.toHaveBeenCalled();
  });

  test('clears stored state when the MCP server is not an OAuth server', async () => {
    mockGetServerConfig.mockResolvedValue(serverConfig);
    mockGetOAuthServers.mockResolvedValue(new Set(['other']));

    await maybeUninstallOAuthMCP(userId, pluginKey, appConfig);

    expect(mockGetClientInfoAndMetadata).not.toHaveBeenCalled();
    expect(mockGetTokens).not.toHaveBeenCalled();
    expect(mockDeleteUserTokens).toHaveBeenCalledTimes(1);
    expect(mockDeleteUserTokens.mock.calls[0][0]).toMatchObject({ userId, serverName });
    expect(mockDeleteFlow).toHaveBeenCalledTimes(1);
    expect(mockDeleteFlowAndStateMapping).toHaveBeenCalledTimes(1);
  });

  test('clears stored state when client info is missing', async () => {
    setupOAuthServerFound();
    mockGetClientInfoAndMetadata.mockResolvedValue(null);

    await maybeUninstallOAuthMCP(userId, pluginKey, appConfig);

    expect(mockGetTokens).not.toHaveBeenCalled();
    expect(mockDeleteUserTokens).toHaveBeenCalledTimes(1);
    expect(mockDeleteUserTokens.mock.calls[0][0]).toMatchObject({ userId, serverName });
    expect(mockDeleteFlow).toHaveBeenCalledTimes(1);
    expect(mockDeleteFlowAndStateMapping).toHaveBeenCalledTimes(1);
  });

  test('scopes metadata-missing cleanup to token records snapshotted before flow cancellation', async () => {
    setupOAuthServerFound();
    mockGetClientInfoAndMetadata.mockResolvedValue(null);
    mockFindToken.mockImplementation(async ({ type }) =>
      type === 'mcp_oauth' ? { token: 'encrypted-old-access' } : null,
    );
    mockDeleteUserTokens.mockImplementation(
      async ({ userId: ownerId, serverName: name, deleteToken }) => {
        const identifier = `mcp:${name}`;
        await deleteToken({
          userId: ownerId,
          type: 'mcp_oauth_client',
          identifier: `${identifier}:client`,
        });
        await deleteToken({ userId: ownerId, type: 'mcp_oauth', identifier });
        await deleteToken({
          userId: ownerId,
          type: 'mcp_oauth_refresh',
          identifier: `${identifier}:refresh`,
        });
      },
    );

    await maybeUninstallOAuthMCP(userId, pluginKey, appConfig);

    expect(mockDeleteTokens).toHaveBeenCalledTimes(1);
    expect(mockDeleteTokens).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'mcp_oauth',
        identifier: 'mcp:acme',
        token: 'encrypted-old-access',
      }),
    );
  });

  test('clears stored state when client info cannot be loaded', async () => {
    setupOAuthServerFound();
    mockGetClientInfoAndMetadata.mockRejectedValue(new Error('bad client data'));
    mockDeleteUserTokens.mockResolvedValue(undefined);
    mockDeleteFlow.mockResolvedValue(undefined);

    await maybeUninstallOAuthMCP(userId, pluginKey, appConfig);

    expect(mockGetTokens).not.toHaveBeenCalled();
    expect(mockDeleteUserTokens).toHaveBeenCalledTimes(1);
    expect(mockDeleteUserTokens.mock.calls[0][0]).toMatchObject({ userId, serverName });
    expect(mockDeleteFlow).toHaveBeenCalledTimes(1);
    expect(mockDeleteFlowAndStateMapping).toHaveBeenCalledTimes(1);
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      `[maybeUninstallOAuthMCP] Unable to load OAuth client metadata for ${serverName}; clearing local MCP OAuth state only.`,
      expect.any(Error),
    );
  });

  test('clears tenant-scoped and legacy flow state when tenant context exists', async () => {
    setupOAuthServerFound();
    mockGetTenantId.mockReturnValue('tenant-a');
    mockGetClientInfoAndMetadata.mockResolvedValue(null);

    await maybeUninstallOAuthMCP(userId, pluginKey, appConfig);

    expect(mockDeleteFlow).toHaveBeenCalledTimes(2);
    expect(mockDeleteFlow).toHaveBeenCalledWith('tenant:tenant-a:user-123:acme', 'mcp_get_tokens');
    expect(mockDeleteFlow).toHaveBeenCalledWith('user-123:acme', 'mcp_get_tokens');
    expect(mockDeleteFlowAndStateMapping).toHaveBeenCalledTimes(2);
    expect(mockDeleteFlowAndStateMapping).toHaveBeenCalledWith(
      'tenant:tenant-a:user-123:acme',
      expect.anything(),
    );
    expect(mockDeleteFlowAndStateMapping).toHaveBeenCalledWith('user-123:acme', expect.anything());
  });

  test('revokes both tokens and runs cleanup on happy path', async () => {
    setupOAuthServerFound();
    mockGetTokens.mockResolvedValue({
      access_token: 'access-abc',
      refresh_token: 'refresh-xyz',
      credential_set_id: credentialSetId,
    });
    mockRevokeOAuthToken.mockResolvedValue(undefined);
    mockFindToken.mockResolvedValue({
      token: 'encrypted-old-token',
      metadata: { credential_set_id: credentialSetId },
    });
    mockDeleteUserTokens.mockImplementation(async ({ deleteToken }) => {
      await deleteToken({ userId, type: 'mcp_oauth', identifier: `mcp:${serverName}` });
    });
    mockDeleteFlow.mockResolvedValue(undefined);

    await maybeUninstallOAuthMCP(userId, pluginKey, appConfig);

    expect(mockRevokeOAuthToken).toHaveBeenCalledTimes(2);
    expect(mockRevokeOAuthToken.mock.calls[0][1]).toBe('access-abc');
    expect(mockRevokeOAuthToken.mock.calls[0][2]).toBe('access');
    expect(mockRevokeOAuthToken.mock.calls[1][1]).toBe('refresh-xyz');
    expect(mockRevokeOAuthToken.mock.calls[1][2]).toBe('refresh');

    expect(mockDeleteUserTokens).toHaveBeenCalledTimes(1);
    expect(mockDeleteUserTokens.mock.calls[0][0]).toMatchObject({ userId, serverName });
    expect(mockDeleteTokens).toHaveBeenCalledWith(
      expect.objectContaining({ token: 'encrypted-old-token' }),
    );
    expect(mockDeleteTokens.mock.calls[0][0]).not.toHaveProperty('metadataCredentialSetId');

    expect(mockDeleteFlow).toHaveBeenCalledTimes(1);
    expect(mockDeleteFlow.mock.calls[0][1]).toBe('mcp_get_tokens');
    expect(mockDeleteFlowAndStateMapping).toHaveBeenCalledTimes(1);
    expect(mockDeleteFlowAndStateMapping).toHaveBeenCalledWith('user-123:acme', expect.anything());
  });

  test('uses a retained deleted-server config to revoke before clearing local state', async () => {
    setupOAuthServerFound();
    mockGetServerConfig.mockResolvedValue(null);
    mockGetOAuthServers.mockResolvedValue(new Set());
    mockGetTokens.mockResolvedValue({
      access_token: 'access-abc',
      credential_set_id: credentialSetId,
    });

    await maybeUninstallOAuthMCP(userId, pluginKey, appConfig, parsedServerConfig);

    expect(mockGetOAuthServers).not.toHaveBeenCalled();
    expect(mockRevokeOAuthToken).toHaveBeenCalledTimes(1);
    expect(mockDeleteUserTokens).toHaveBeenCalledTimes(1);
    expect(mockDeleteFlowAndStateMapping).toHaveBeenCalledTimes(1);
  });

  test('does not revoke tokens from a concurrently replaced credential generation', async () => {
    setupOAuthServerFound();
    mockGetTokens.mockResolvedValue({
      access_token: 'generation-b-access',
      refresh_token: 'generation-b-refresh',
      credential_set_id: 'credential-set-b',
    });

    await maybeUninstallOAuthMCP(userId, pluginKey, appConfig);

    expect(mockAssertCredentialSetBinding).toHaveBeenCalledWith(
      serverName,
      'credential-set-b',
      expect.objectContaining({ credential_set_id: credentialSetId }),
    );
    expect(mockRevokeOAuthToken).not.toHaveBeenCalled();
    expect(mockDeleteUserTokens).toHaveBeenCalledTimes(1);
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      `[maybeUninstallOAuthMCP] Unable to load OAuth tokens for ${serverName}; clearing local token state.`,
      expect.any(Error),
    );
  });

  test('uses the stored revocation binding instead of an edited server configuration', async () => {
    setupOAuthServerFound();
    mockGetServerConfig.mockResolvedValue({
      ...serverConfig,
      url: 'https://attacker.example.com/mcp',
      oauth: {
        revocation_endpoint: 'https://attacker.example.com/revoke',
        revocation_endpoint_auth_methods_supported: ['client_secret_post'],
      },
    });
    mockGetTokens.mockResolvedValue({
      access_token: 'access-abc',
      credential_set_id: credentialSetId,
    });
    mockRevokeOAuthToken.mockResolvedValue(undefined);

    await maybeUninstallOAuthMCP(userId, pluginKey, appConfig);

    expect(mockRevokeOAuthToken).toHaveBeenCalledWith(
      serverName,
      'access-abc',
      'access',
      expect.objectContaining({
        serverUrl: 'https://acme.example.com',
        revocationEndpoint: 'https://acme.example.com/revoke',
        revocationEndpointAuthMethodsSupported: ['client_secret_basic'],
      }),
      { 'X-Tenant': 'acme' },
      undefined,
      undefined,
    );
  });

  test('skips remote revocation for legacy metadata without a stored revocation endpoint', async () => {
    setupOAuthServerFound();
    mockGetClientInfoAndMetadata.mockResolvedValue({
      clientInfo,
      clientMetadata: {
        server_url: 'https://acme.example.com',
        token_endpoint: 'https://acme.example.com/token',
        client_source: 'dynamic',
      },
    });

    await maybeUninstallOAuthMCP(userId, pluginKey, appConfig);

    expect(mockGetTokens).not.toHaveBeenCalled();
    expect(mockRevokeOAuthToken).not.toHaveBeenCalled();
    expect(mockDeleteUserTokens).toHaveBeenCalledTimes(1);
  });

  test('skips revocation but still runs cleanup when token retrieval fails', async () => {
    setupOAuthServerFound();
    mockGetTokens.mockRejectedValue(new Error('missing'));
    mockDeleteUserTokens.mockResolvedValue(undefined);
    mockDeleteFlow.mockResolvedValue(undefined);

    await expect(maybeUninstallOAuthMCP(userId, pluginKey, appConfig)).resolves.toBeUndefined();

    expect(mockRevokeOAuthToken).not.toHaveBeenCalled();
    expect(mockDeleteUserTokens).toHaveBeenCalledTimes(1);
    expect(mockDeleteFlow).toHaveBeenCalledTimes(1);
    expect(mockDeleteFlowAndStateMapping).toHaveBeenCalledTimes(1);
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      `[maybeUninstallOAuthMCP] Unable to load OAuth tokens for ${serverName}; clearing local token state.`,
      expect.any(Error),
    );
  });

  test('skips revocation, logs warn, and still runs cleanup on unexpected token-retrieval error', async () => {
    setupOAuthServerFound();
    mockGetTokens.mockRejectedValue(new Error('boom: unreachable'));
    mockDeleteUserTokens.mockResolvedValue(undefined);
    mockDeleteFlow.mockResolvedValue(undefined);

    await expect(maybeUninstallOAuthMCP(userId, pluginKey, appConfig)).resolves.toBeUndefined();

    expect(mockRevokeOAuthToken).not.toHaveBeenCalled();
    expect(mockDeleteUserTokens).toHaveBeenCalledTimes(1);
    expect(mockDeleteFlow).toHaveBeenCalledTimes(1);
    expect(mockDeleteFlowAndStateMapping).toHaveBeenCalledTimes(1);
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      `[maybeUninstallOAuthMCP] Unable to load OAuth tokens for ${serverName}; clearing local token state.`,
      expect.any(Error),
    );
  });

  test('continues cleanup when only one token type is present', async () => {
    setupOAuthServerFound();
    mockGetTokens.mockResolvedValue({
      access_token: 'only-access',
      credential_set_id: credentialSetId,
    });
    mockRevokeOAuthToken.mockResolvedValue(undefined);
    mockDeleteUserTokens.mockResolvedValue(undefined);
    mockDeleteFlow.mockResolvedValue(undefined);

    await maybeUninstallOAuthMCP(userId, pluginKey, appConfig);

    expect(mockRevokeOAuthToken).toHaveBeenCalledTimes(1);
    expect(mockRevokeOAuthToken.mock.calls[0][2]).toBe('access');
    expect(mockDeleteUserTokens).toHaveBeenCalledTimes(1);
    expect(mockDeleteFlow).toHaveBeenCalledTimes(1);
    expect(mockDeleteFlowAndStateMapping).toHaveBeenCalledTimes(1);
  });

  test('still runs cleanup even when both revocation calls fail', async () => {
    setupOAuthServerFound();
    mockGetTokens.mockResolvedValue({
      access_token: 'a',
      refresh_token: 'r',
      credential_set_id: credentialSetId,
    });
    mockRevokeOAuthToken.mockRejectedValue(new Error('network down'));
    mockDeleteUserTokens.mockResolvedValue(undefined);
    mockDeleteFlow.mockResolvedValue(undefined);

    await expect(maybeUninstallOAuthMCP(userId, pluginKey, appConfig)).resolves.toBeUndefined();

    expect(mockRevokeOAuthToken).toHaveBeenCalledTimes(2);
    expect(mockDeleteUserTokens).toHaveBeenCalledTimes(1);
    expect(mockDeleteFlow).toHaveBeenCalledTimes(1);
    expect(mockDeleteFlowAndStateMapping).toHaveBeenCalledTimes(1);
    expect(mockLoggerError).toHaveBeenCalled();
  });
});
