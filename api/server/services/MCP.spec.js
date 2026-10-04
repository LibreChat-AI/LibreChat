// Mock all dependencies - define mocks before imports
const mockGetTenantId = jest.fn();

jest.mock('@librechat/data-schemas', () => ({
  logger: {
    debug: jest.fn(),
    error: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
  },
  getTenantId: mockGetTenantId,
  decryptV2: jest.fn(async (value) => value.replace(/^enc:/, '')),
}));

// Create mock registry instance
const mockRegistryInstance = {
  getOAuthServers: jest.fn(() => Promise.resolve(new Set())),
  getAllServerConfigs: jest.fn(() => Promise.resolve({})),
  getServerConfig: jest.fn(() => Promise.resolve(null)),
  ensureConfigServers: jest.fn(() => Promise.resolve({})),
  resolveAllowlists: jest.fn(() =>
    Promise.resolve({ allowedDomains: null, allowedAddresses: null, useSSRFProtection: true }),
  ),
};

// Create isMCPDomainAllowed mock that can be configured per-test
const mockIsMCPDomainAllowed = jest.fn(() => Promise.resolve(true));

const mockGetAppConfig = jest.fn(() => Promise.resolve({}));

jest.mock('@librechat/api', () => {
  const actual = jest.requireActual('@librechat/api');
  return {
    ...actual,
    sendEvent: jest.fn(),
    get isMCPDomainAllowed() {
      return mockIsMCPDomainAllowed;
    },
    GenerationJobManager: {
      emitChunk: jest.fn(),
    },
  };
});

const { logger } = require('@librechat/data-schemas');
const {
  MCPOAuthHandler,
  GenerationJobManager,
  MCP_APPS_CAPABILITY_PROFILE,
  STANDARD_MCP_CAPABILITY_PROFILE,
} = require('@librechat/api');
const { CacheKeys, Constants, Permissions, PermissionTypes } = require('librechat-data-provider');
const D = Constants.mcp_delimiter;
const {
  createMCPTool,
  createMCPTools,
  createMCPPermissionContext,
  getMCPSetupData,
  createOAuthStart,
  checkOAuthFlowStatus,
  getServerConnectionStatus,
  createUnavailableToolStub,
} = require('./MCP');

jest.mock('./Config', () => ({
  loadCustomConfig: jest.fn(),
  get getAppConfig() {
    return mockGetAppConfig;
  },
}));

jest.mock('~/config', () => ({
  getMCPManager: jest.fn(),
  getFlowStateManager: jest.fn(),
  getOAuthReconnectionManager: jest.fn(),
  getMCPServersRegistry: jest.fn(() => mockRegistryInstance),
}));

jest.mock('~/cache', () => ({
  getLogStores: jest.fn(),
}));

jest.mock('~/models', () => ({
  findToken: jest.fn(),
  createToken: jest.fn(),
  updateToken: jest.fn(),
  deleteTokens: jest.fn(),
  getRoleByName: jest.fn(),
}));

jest.mock('./Tools/mcp', () => ({
  reinitMCPServer: jest.fn(),
}));

jest.mock('~/server/services/Schedules', () => ({
  recordMCPToolAuthFailure: jest.fn(async () => true),
}));

jest.mock('./GraphTokenService', () => ({
  getGraphApiToken: jest.fn(),
}));

jest.mock('./OboTokenService', () => ({
  exchangeOboToken: jest.fn(),
}));

jest.mock('./OboPolicyService', () => ({
  createOboTrustChecker: jest.fn(() => jest.fn()),
}));

describe('tests for the new helper functions used by the MCP connection status endpoints', () => {
  let mockGetMCPManager;
  let mockGetFlowStateManager;
  let mockGetLogStores;
  let mockGetOAuthReconnectionManager;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(MCPOAuthHandler, 'generateFlowId');
    mockGetTenantId.mockReturnValue(undefined);
    mockIsMCPDomainAllowed.mockResolvedValue(true);
    mockRegistryInstance.resolveAllowlists.mockResolvedValue({
      allowedDomains: null,
      allowedAddresses: null,
      useSSRFProtection: true,
    });

    mockGetMCPManager = require('~/config').getMCPManager;
    mockGetFlowStateManager = require('~/config').getFlowStateManager;
    mockGetLogStores = require('~/cache').getLogStores;
    mockGetOAuthReconnectionManager = require('~/config').getOAuthReconnectionManager;
  });

  describe('createOAuthStart', () => {
    const flowId = 'test-server:oauth_login:thread-1:run-1';
    const authUrl = 'https://auth.example.com/oauth?state=test';

    it('should create a login flow and emit the OAuth URL for the first request', async () => {
      const callback = jest.fn();
      const mockFlowManager = {
        getFlowState: jest.fn().mockResolvedValue(null),
        createFlowWithHandler: jest.fn(async (_flowId, _type, handler) => handler()),
      };

      const oauthStart = createOAuthStart({
        flowId,
        flowManager: mockFlowManager,
        callback,
      });

      await expect(oauthStart(authUrl)).resolves.toBe(true);

      expect(mockFlowManager.getFlowState).toHaveBeenCalledWith(flowId, 'oauth_login');
      expect(mockFlowManager.createFlowWithHandler).toHaveBeenCalledWith(
        flowId,
        'oauth_login',
        expect.any(Function),
      );
      expect(callback).toHaveBeenCalledWith(authUrl);
      expect(logger.debug).toHaveBeenCalledWith('Sent OAuth login request to client');
    });

    it('should replay the OAuth URL when the login flow already exists', async () => {
      const callback = jest.fn();
      const mockFlowManager = {
        getFlowState: jest.fn().mockResolvedValue({
          status: 'COMPLETED',
          result: true,
        }),
        createFlowWithHandler: jest.fn(),
      };

      const oauthStart = createOAuthStart({
        flowId,
        flowManager: mockFlowManager,
        callback,
      });

      await expect(oauthStart(authUrl)).resolves.toBe(true);

      expect(mockFlowManager.getFlowState).toHaveBeenCalledWith(flowId, 'oauth_login');
      expect(mockFlowManager.createFlowWithHandler).not.toHaveBeenCalled();
      expect(callback).toHaveBeenCalledWith(authUrl);
      expect(logger.debug).toHaveBeenCalledWith('Re-sent OAuth login request to client');
    });

    it('should replay the OAuth URL when flow creation is deduped internally', async () => {
      const callback = jest.fn();
      const mockFlowManager = {
        getFlowState: jest.fn().mockResolvedValue(null),
        createFlowWithHandler: jest.fn().mockResolvedValue(true),
      };

      const oauthStart = createOAuthStart({
        flowId,
        flowManager: mockFlowManager,
        callback,
      });

      await expect(oauthStart(authUrl)).resolves.toBe(true);

      expect(mockFlowManager.getFlowState).toHaveBeenCalledWith(flowId, 'oauth_login');
      expect(mockFlowManager.createFlowWithHandler).toHaveBeenCalledWith(
        flowId,
        'oauth_login',
        expect.any(Function),
      );
      expect(callback).toHaveBeenCalledWith(authUrl);
      expect(logger.debug).toHaveBeenCalledWith('Re-sent OAuth login request to client');
    });
  });

  describe('getMCPSetupData', () => {
    const mockUserId = 'user-123';
    const mockConfig = {
      server1: { type: 'stdio' },
      server2: { type: 'http' },
    };

    beforeEach(() => {
      mockGetMCPManager.mockReturnValue({
        getLoadedAppConnections: jest.fn(() => new Map()),
        getUserConnections: jest.fn(() => new Map()),
      });
      mockRegistryInstance.getOAuthServers.mockResolvedValue(new Set());
      mockRegistryInstance.getAllServerConfigs.mockResolvedValue(mockConfig);
    });

    it('should successfully return MCP setup data', async () => {
      const mockConfigWithOAuth = {
        server1: { type: 'stdio' },
        server2: { type: 'http', requiresOAuth: true },
        server3: { type: 'http', oauth: { client_id: 'configured-client' } },
      };
      mockRegistryInstance.getAllServerConfigs.mockResolvedValue(mockConfigWithOAuth);

      const mockAppConnections = new Map([['server1', { status: 'connected' }]]);
      const mockUserConnections = new Map([['server2', { status: 'disconnected' }]]);

      const mockMCPManager = {
        getLoadedAppConnections: jest.fn(() => Promise.resolve(mockAppConnections)),
        getUserConnections: jest.fn(() => mockUserConnections),
      };
      mockGetMCPManager.mockReturnValue(mockMCPManager);

      const result = await getMCPSetupData(mockUserId);

      expect(mockRegistryInstance.ensureConfigServers).toHaveBeenCalled();
      expect(mockRegistryInstance.getAllServerConfigs).toHaveBeenCalledWith(
        mockUserId,
        expect.any(Object),
      );
      expect(mockGetMCPManager).toHaveBeenCalledWith(mockUserId);
      expect(mockMCPManager.getLoadedAppConnections).toHaveBeenCalledWith(
        STANDARD_MCP_CAPABILITY_PROFILE,
      );
      expect(mockMCPManager.getUserConnections).toHaveBeenCalledWith(
        mockUserId,
        STANDARD_MCP_CAPABILITY_PROFILE,
      );

      expect(result.mcpConfig).toEqual(mockConfigWithOAuth);
      expect(result.appConnections).toEqual(mockAppConnections);
      expect(result.userConnections).toEqual(mockUserConnections);
      expect(result.oauthServers).toEqual(new Set(['server2', 'server3']));
    });

    it('should return empty data when no servers are configured', async () => {
      mockRegistryInstance.getAllServerConfigs.mockResolvedValue({});
      const result = await getMCPSetupData(mockUserId);
      expect(result.mcpConfig).toEqual({});
      expect(result.oauthServers).toEqual(new Set());
    });

    it('reuses request-loaded app configuration', async () => {
      const appConfig = { mcpConfig: { server1: { type: 'stdio' } } };
      mockGetAppConfig.mockClear();

      await getMCPSetupData(mockUserId, { role: 'user', appConfig });

      expect(mockGetAppConfig).not.toHaveBeenCalled();
      expect(mockRegistryInstance.ensureConfigServers).toHaveBeenCalledWith(appConfig.mcpConfig);
    });

    it('reports only the request-admitted Apps connection profile', async () => {
      const getLoadedAppConnections = jest.fn(() => Promise.resolve(new Map()));
      const appsConnections = new Map([['server1', { connectionState: 'connected' }]]);
      const getUserConnections = jest.fn(() => appsConnections);
      mockGetMCPManager.mockReturnValue({
        getLoadedAppConnections,
        getUserConnections,
      });

      const result = await getMCPSetupData(mockUserId, {
        appConfig: { mcpConfig: {}, mcpSettings: { apps: true } },
      });

      expect(getLoadedAppConnections).toHaveBeenCalledWith(MCP_APPS_CAPABILITY_PROFILE);
      expect(getUserConnections).toHaveBeenCalledWith(mockUserId, MCP_APPS_CAPABILITY_PROFILE);
      expect(result.appConnections).toEqual(new Map());
      expect(result.userConnections).toBe(appsConnections);
    });

    it('should handle null values from MCP manager gracefully', async () => {
      mockRegistryInstance.getAllServerConfigs.mockResolvedValue(mockConfig);

      const mockMCPManager = {
        getLoadedAppConnections: jest.fn(() => Promise.resolve(new Map())),
        getUserConnections: jest.fn(() => null),
      };
      mockGetMCPManager.mockReturnValue(mockMCPManager);
      mockRegistryInstance.getOAuthServers.mockResolvedValue(new Set());

      const result = await getMCPSetupData(mockUserId);

      expect(result).toEqual({
        mcpConfig: mockConfig,
        appConnections: new Map(),
        userConnections: new Map(),
        oauthServers: new Set(),
      });
    });
  });

  describe('checkOAuthFlowStatus', () => {
    const mockUserId = 'user-123';
    const mockServerName = 'test-server';
    const mockFlowId = 'flow-123';

    beforeEach(() => {
      const mockFlowsCache = {};
      const mockFlowManager = {
        getFlowState: jest.fn(),
      };

      mockGetLogStores.mockReturnValue(mockFlowsCache);
      mockGetFlowStateManager.mockReturnValue(mockFlowManager);
      MCPOAuthHandler.generateFlowId.mockReturnValue(mockFlowId);
    });

    it('should return false flags when no flow state exists', async () => {
      const mockFlowManager = { getFlowState: jest.fn(() => null) };
      mockGetFlowStateManager.mockReturnValue(mockFlowManager);

      const result = await checkOAuthFlowStatus(mockUserId, mockServerName);

      expect(mockGetLogStores).toHaveBeenCalledWith(CacheKeys.FLOWS);
      expect(MCPOAuthHandler.generateFlowId).toHaveBeenCalledWith(mockUserId, mockServerName);
      expect(mockFlowManager.getFlowState).toHaveBeenCalledWith(mockFlowId, 'mcp_oauth');
      expect(result).toEqual({ hasActiveFlow: false, hasFailedFlow: false });
    });

    it('should detect failed flow when status is FAILED', async () => {
      const mockFlowState = {
        status: 'FAILED',
        createdAt: Date.now() - 60000, // 1 minute ago
        ttl: 180000,
      };
      const mockFlowManager = { getFlowState: jest.fn(() => mockFlowState) };
      mockGetFlowStateManager.mockReturnValue(mockFlowManager);

      const result = await checkOAuthFlowStatus(mockUserId, mockServerName);

      expect(result).toEqual({ hasActiveFlow: false, hasFailedFlow: true });
      expect(logger.debug).toHaveBeenCalledWith(
        expect.stringContaining('Found failed OAuth flow'),
        expect.objectContaining({
          flowId: mockFlowId,
          status: 'FAILED',
        }),
      );
    });

    it('should treat aborted flow cleanup as neutral connection status', async () => {
      const mockFlowState = {
        status: 'FAILED',
        createdAt: Date.now() - 60000,
        ttl: 180000,
        error: 'Tool loading aborted',
      };
      const mockFlowManager = { getFlowState: jest.fn(() => mockFlowState) };
      mockGetFlowStateManager.mockReturnValue(mockFlowManager);

      const result = await checkOAuthFlowStatus(mockUserId, mockServerName);

      expect(result).toEqual({ hasActiveFlow: false, hasFailedFlow: false });
    });

    it('should detect failed flow when flow has timed out', async () => {
      const mockFlowState = {
        status: 'PENDING',
        createdAt: Date.now() - 200000, // 200 seconds ago (> 180s TTL)
        ttl: 180000,
      };
      const mockFlowManager = { getFlowState: jest.fn(() => mockFlowState) };
      mockGetFlowStateManager.mockReturnValue(mockFlowManager);

      const result = await checkOAuthFlowStatus(mockUserId, mockServerName);

      expect(result).toEqual({ hasActiveFlow: false, hasFailedFlow: true });
      expect(logger.debug).toHaveBeenCalledWith(
        expect.stringContaining('Found failed OAuth flow'),
        expect.objectContaining({
          timedOut: true,
        }),
      );
    });

    it('should detect failed flow when TTL not specified and flow exceeds default TTL', async () => {
      const mockFlowState = {
        status: 'PENDING',
        createdAt: Date.now() - 16 * 60 * 1000, // 16 minutes ago (past the PENDING_STALE_MS window)
        // ttl not specified, should fall back to the PENDING_STALE_MS default
      };
      const mockFlowManager = { getFlowState: jest.fn(() => mockFlowState) };
      mockGetFlowStateManager.mockReturnValue(mockFlowManager);

      const result = await checkOAuthFlowStatus(mockUserId, mockServerName);

      expect(result).toEqual({ hasActiveFlow: false, hasFailedFlow: true });
    });

    it('should detect active flow when status is PENDING and within TTL', async () => {
      const mockFlowState = {
        status: 'PENDING',
        createdAt: Date.now() - 60000, // 1 minute ago (< 180s TTL)
        ttl: 180000,
      };
      const mockFlowManager = { getFlowState: jest.fn(() => mockFlowState) };
      mockGetFlowStateManager.mockReturnValue(mockFlowManager);

      const result = await checkOAuthFlowStatus(mockUserId, mockServerName);

      expect(result).toEqual({ hasActiveFlow: true, hasFailedFlow: false });
      expect(logger.debug).toHaveBeenCalledWith(
        expect.stringContaining('Found active OAuth flow'),
        expect.objectContaining({
          flowId: mockFlowId,
        }),
      );
    });

    it('should check the tenant-scoped OAuth flow when tenant context exists', async () => {
      mockGetTenantId.mockReturnValue('tenant/a');
      MCPOAuthHandler.generateFlowId.mockReturnValue('tenant-flow-id');
      const mockFlowState = {
        status: 'PENDING',
        createdAt: Date.now() - 60000,
        ttl: 180000,
      };
      const mockFlowManager = { getFlowState: jest.fn(() => mockFlowState) };
      mockGetFlowStateManager.mockReturnValue(mockFlowManager);

      const result = await checkOAuthFlowStatus(mockUserId, mockServerName);

      expect(MCPOAuthHandler.generateFlowId).toHaveBeenCalledWith(
        mockUserId,
        mockServerName,
        'tenant/a',
      );
      expect(mockFlowManager.getFlowState).toHaveBeenCalledWith('tenant-flow-id', 'mcp_oauth');
      expect(result).toEqual({ hasActiveFlow: true, hasFailedFlow: false });
    });

    it('should not treat a completed flow as durable authorization', async () => {
      const mockFlowState = {
        status: 'COMPLETED',
        createdAt: Date.now() - 60000,
        ttl: 180000,
      };
      const mockFlowManager = { getFlowState: jest.fn(() => mockFlowState) };
      mockGetFlowStateManager.mockReturnValue(mockFlowManager);

      const result = await checkOAuthFlowStatus(mockUserId, mockServerName);

      expect(result).toEqual({ hasActiveFlow: false, hasFailedFlow: false });
    });

    it('should treat an old completed flow as neutral instead of timed out', async () => {
      const mockFlowState = {
        status: 'COMPLETED',
        createdAt: Date.now() - 200000,
        ttl: 180000,
      };
      const mockFlowManager = { getFlowState: jest.fn(() => mockFlowState) };
      mockGetFlowStateManager.mockReturnValue(mockFlowManager);

      const result = await checkOAuthFlowStatus(mockUserId, mockServerName);

      expect(result).toEqual({ hasActiveFlow: false, hasFailedFlow: false });
    });

    it('should handle errors gracefully', async () => {
      const mockError = new Error('Flow state error');
      const mockFlowManager = {
        getFlowState: jest.fn(() => {
          throw mockError;
        }),
      };
      mockGetFlowStateManager.mockReturnValue(mockFlowManager);

      const result = await checkOAuthFlowStatus(mockUserId, mockServerName);

      expect(result).toEqual({ hasActiveFlow: false, hasFailedFlow: false });
      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('Error checking OAuth flows'),
        mockError,
      );
    });
  });

  describe('getServerConnectionStatus', () => {
    const mockUserId = 'user-123';
    const mockServerName = 'test-server';
    const mockConfig = { updatedAt: Date.now() };

    beforeEach(() => {
      require('~/models').findToken.mockReset();
    });

    it('should return app connection state when available', async () => {
      const appConnections = new Map([
        [
          mockServerName,
          {
            connectionState: 'connected',
            isStale: jest.fn(() => false),
          },
        ],
      ]);
      const userConnections = new Map();
      const oauthServers = new Set();

      const result = await getServerConnectionStatus(
        mockUserId,
        mockServerName,
        mockConfig,
        appConnections,
        userConnections,
        oauthServers,
      );

      expect(result).toEqual({
        requiresOAuth: false,
        connectionState: 'connected',
        authorizationState: 'not_required',
      });
    });

    it('should fallback to user connection state when app connection not available', async () => {
      const appConnections = new Map();
      const userConnections = new Map([
        [
          mockServerName,
          {
            connectionState: 'connecting',
            isStale: jest.fn(() => false),
          },
        ],
      ]);
      const oauthServers = new Set();

      const result = await getServerConnectionStatus(
        mockUserId,
        mockServerName,
        mockConfig,
        appConnections,
        userConnections,
        oauthServers,
      );

      expect(result).toEqual({
        requiresOAuth: false,
        connectionState: 'connecting',
        authorizationState: 'not_required',
      });
    });

    it('should default to disconnected when no connections exist', async () => {
      const appConnections = new Map();
      const userConnections = new Map();
      const oauthServers = new Set();

      const result = await getServerConnectionStatus(
        mockUserId,
        mockServerName,
        mockConfig,
        appConnections,
        userConnections,
        oauthServers,
      );

      expect(result).toEqual({
        requiresOAuth: false,
        connectionState: 'disconnected',
        authorizationState: 'not_required',
      });
    });

    it('marks BODY placeholder servers as request-scoped while they are idle', async () => {
      const result = await getServerConnectionStatus(
        mockUserId,
        mockServerName,
        {
          ...mockConfig,
          source: 'yaml',
          headers: { 'X-Parent-Message': '{{LIBRECHAT_BODY_PARENTMESSAGEID}}' },
        },
        new Map(),
        new Map(),
        new Set(),
      );

      expect(result).toEqual({
        requiresOAuth: false,
        requestScoped: true,
        connectionState: 'disconnected',
        authorizationState: 'not_required',
      });
    });

    it('reports whether custom variables are configured for request-scoped servers', async () => {
      const config = {
        ...mockConfig,
        source: 'yaml',
        headers: { 'X-Conversation': '{{LIBRECHAT_BODY_CONVERSATIONID}}' },
        customUserVars: { API_KEY: { title: 'API key' } },
      };
      const connectionArgs = [new Map(), new Map(), new Set()];

      const missing = await getServerConnectionStatus(
        mockUserId,
        mockServerName,
        config,
        ...connectionArgs,
        { userMCPAuthMap: {} },
      );
      const configured = await getServerConnectionStatus(
        mockUserId,
        mockServerName,
        config,
        ...connectionArgs,
        {
          userMCPAuthMap: {
            [`${Constants.mcp_prefix}${mockServerName}`]: { API_KEY: 'secret' },
          },
        },
      );

      expect(missing.configurationState).toBe('needs_configuration');
      expect(configured.configurationState).toBe('configured');
    });

    it('should prioritize app connection over user connection', async () => {
      const appConnections = new Map([
        [
          mockServerName,
          {
            connectionState: 'connected',
            isStale: jest.fn(() => false),
          },
        ],
      ]);
      const userConnections = new Map([
        [
          mockServerName,
          {
            connectionState: 'disconnected',
            isStale: jest.fn(() => false),
          },
        ],
      ]);
      const oauthServers = new Set();

      const result = await getServerConnectionStatus(
        mockUserId,
        mockServerName,
        mockConfig,
        appConnections,
        userConnections,
        oauthServers,
      );

      expect(result).toEqual({
        requiresOAuth: false,
        connectionState: 'connected',
        authorizationState: 'not_required',
      });
    });

    it('should indicate OAuth requirement when server is in OAuth servers set', async () => {
      const appConnections = new Map();
      const userConnections = new Map();
      const oauthServers = new Set([mockServerName]);

      // Mock OAuthReconnectionManager
      const mockOAuthReconnectionManager = {
        isReconnecting: jest.fn(() => false),
      };
      mockGetOAuthReconnectionManager.mockReturnValue(mockOAuthReconnectionManager);

      const result = await getServerConnectionStatus(
        mockUserId,
        mockServerName,
        mockConfig,
        appConnections,
        userConnections,
        oauthServers,
      );

      expect(result.requiresOAuth).toBe(true);
    });

    it('should handle OAuth flow status when disconnected and requires OAuth with failed flow', async () => {
      const appConnections = new Map();
      const userConnections = new Map();
      const oauthServers = new Set([mockServerName]);

      // Mock OAuthReconnectionManager
      const mockOAuthReconnectionManager = {
        isReconnecting: jest.fn(() => false),
      };
      mockGetOAuthReconnectionManager.mockReturnValue(mockOAuthReconnectionManager);

      // Mock flow state to return failed flow
      const mockFlowManager = {
        getFlowState: jest.fn(() => ({
          status: 'FAILED',
          createdAt: Date.now() - 60000,
          ttl: 180000,
        })),
      };
      mockGetFlowStateManager.mockReturnValue(mockFlowManager);
      mockGetLogStores.mockReturnValue({});
      MCPOAuthHandler.generateFlowId.mockReturnValue('test-flow-id');

      const result = await getServerConnectionStatus(
        mockUserId,
        mockServerName,
        mockConfig,
        appConnections,
        userConnections,
        oauthServers,
      );

      expect(result).toEqual({
        requiresOAuth: true,
        connectionState: 'error',
        authorizationState: 'error',
      });
    });

    it('should handle OAuth flow status when disconnected and requires OAuth with active flow', async () => {
      const appConnections = new Map();
      const userConnections = new Map();
      const oauthServers = new Set([mockServerName]);

      // Mock OAuthReconnectionManager
      const mockOAuthReconnectionManager = {
        isReconnecting: jest.fn(() => false),
      };
      mockGetOAuthReconnectionManager.mockReturnValue(mockOAuthReconnectionManager);

      // Mock flow state to return active flow
      const mockFlowManager = {
        getFlowState: jest.fn(() => ({
          status: 'PENDING',
          createdAt: Date.now() - 60000, // 1 minute ago
          ttl: 180000, // 3 minutes TTL
        })),
      };
      mockGetFlowStateManager.mockReturnValue(mockFlowManager);
      mockGetLogStores.mockReturnValue({});
      MCPOAuthHandler.generateFlowId.mockReturnValue('test-flow-id');

      const result = await getServerConnectionStatus(
        mockUserId,
        mockServerName,
        mockConfig,
        appConnections,
        userConnections,
        oauthServers,
      );

      expect(result).toEqual({
        requiresOAuth: true,
        connectionState: 'connecting',
        authorizationState: 'authorizing',
      });
    });

    it('should require bound token storage after a completed OAuth flow on another pod', async () => {
      const appConnections = new Map();
      const userConnections = new Map();
      const oauthServers = new Set([mockServerName]);
      mockGetOAuthReconnectionManager.mockReturnValue({ isReconnecting: jest.fn(() => false) });
      mockGetFlowStateManager.mockReturnValue({
        getFlowState: jest.fn(() => ({
          status: 'COMPLETED',
          createdAt: Date.now() - 60000,
          result: { access_token: 'encrypted' },
        })),
      });
      mockGetLogStores.mockReturnValue({});
      const { findToken } = require('~/models');
      findToken.mockResolvedValue(null);

      const result = await getServerConnectionStatus(
        mockUserId,
        mockServerName,
        mockConfig,
        appConnections,
        userConnections,
        oauthServers,
      );

      expect(result).toEqual({
        requiresOAuth: true,
        connectionState: 'disconnected',
        authorizationState: 'needs_authorization',
      });
    });

    it('should derive readiness from bound token storage after the flow record expires', async () => {
      const appConnections = new Map();
      const userConnections = new Map();
      const oauthServers = new Set([mockServerName]);
      const { findToken } = require('~/models');
      const credentialSetId = 'credential-set-a';
      const config = { ...mockConfig, url: 'https://mcp.example.com/' };
      mockGetOAuthReconnectionManager.mockReturnValue({ isReconnecting: jest.fn(() => false) });
      mockGetFlowStateManager.mockReturnValue({ getFlowState: jest.fn(() => null) });
      mockGetLogStores.mockReturnValue({});
      findToken
        .mockResolvedValueOnce({
          expiresAt: new Date(Date.now() + 60000),
          metadata: { credential_set_id: credentialSetId },
        })
        .mockResolvedValueOnce({
          token: 'enc:{"client_id":"dynamic-client"}',
          metadata: {
            credential_set_id: credentialSetId,
            authorization_endpoint: 'https://auth.example.com/authorize',
            token_endpoint: 'https://auth.example.com/token',
            server_url: 'https://mcp.example.com/',
            client_source: 'dynamic',
          },
        });

      const result = await getServerConnectionStatus(
        mockUserId,
        mockServerName,
        config,
        appConnections,
        userConnections,
        oauthServers,
      );

      expect(result).toEqual({
        requiresOAuth: true,
        connectionState: 'connected',
        authorizationState: 'authorized',
      });
    });

    it('does not report rejected stored credentials as connected after the OAuth flow is gone', async () => {
      const { findToken } = require('~/models');
      const credentialSetId = 'rejected-generation';
      mockGetOAuthReconnectionManager.mockReturnValue({ isReconnecting: jest.fn(() => false) });
      mockGetFlowStateManager.mockReturnValue({ getFlowState: jest.fn(() => null) });
      mockGetLogStores.mockReturnValue({});
      findToken.mockImplementation(async ({ type }) => {
        if (type === 'mcp_oauth_client') {
          return {
            token: 'enc:{"client_id":"dynamic-client"}',
            metadata: {
              credential_set_id: credentialSetId,
              rejected_credential_set_id: credentialSetId,
              authorization_endpoint: 'https://auth.example.com/authorize',
              token_endpoint: 'https://auth.example.com/token',
              server_url: 'https://mcp.example.com/',
              client_source: 'dynamic',
            },
          };
        }
        return {
          expiresAt: new Date(Date.now() + 60000),
          metadata: { credential_set_id: credentialSetId },
        };
      });

      const result = await getServerConnectionStatus(
        mockUserId,
        mockServerName,
        { ...mockConfig, url: 'https://mcp.example.com/' },
        new Map(),
        new Map(),
        new Set([mockServerName]),
      );

      expect(result).toEqual({
        requiresOAuth: true,
        connectionState: 'disconnected',
        authorizationState: 'needs_authorization',
      });
    });

    it('should derive runtime-detected OAuth readiness from bound token storage', async () => {
      const appConnections = new Map();
      const userConnections = new Map();
      const oauthServers = new Set();
      const { findToken } = require('~/models');
      const credentialSetId = 'credential-set-a';
      const config = {
        ...mockConfig,
        source: 'yaml',
        url: 'https://mcp.example.com/users/{{LIBRECHAT_USER_ID}}/mcp',
      };
      mockGetOAuthReconnectionManager.mockReturnValue({ isReconnecting: jest.fn(() => false) });
      mockGetFlowStateManager.mockReturnValue({ getFlowState: jest.fn(() => null) });
      mockGetLogStores.mockReturnValue({});
      findToken
        .mockResolvedValueOnce({
          expiresAt: new Date(Date.now() + 60000),
          metadata: { credential_set_id: credentialSetId },
        })
        .mockResolvedValueOnce({
          token: 'enc:{"client_id":"dynamic-client"}',
          metadata: {
            credential_set_id: credentialSetId,
            authorization_endpoint: 'https://auth.example.com/authorize',
            token_endpoint: 'https://auth.example.com/token',
            server_url: `https://mcp.example.com/users/${mockUserId}/mcp`,
            client_source: 'dynamic',
          },
        });

      const result = await getServerConnectionStatus(
        mockUserId,
        mockServerName,
        config,
        appConnections,
        userConnections,
        oauthServers,
        { user: { id: mockUserId } },
      );

      expect(result).toEqual({
        requiresOAuth: true,
        connectionState: 'connected',
        authorizationState: 'authorized',
      });
    });

    it('should preserve OAuth status from a live runtime-resolved connection', async () => {
      const { findToken } = require('~/models');
      const appConnections = new Map();
      const userConnections = new Map([
        [
          mockServerName,
          {
            connectionState: 'connected',
            isStale: jest.fn(() => false),
            usesOAuth: jest.fn(() => true),
          },
        ],
      ]);

      const result = await getServerConnectionStatus(
        mockUserId,
        mockServerName,
        {
          ...mockConfig,
          source: 'yaml',
          url: 'https://mcp.example.com/{{LIBRECHAT_USER_ID}}/mcp',
        },
        appConnections,
        userConnections,
        new Set(),
      );

      expect(result).toEqual({
        requiresOAuth: true,
        connectionState: 'connected',
        authorizationState: 'authorized',
      });
      expect(findToken).not.toHaveBeenCalled();
    });

    it('should derive runtime-detected OAuth state from an active shared flow', async () => {
      const appConnections = new Map();
      const userConnections = new Map();
      const oauthServers = new Set();
      const config = {
        ...mockConfig,
        source: 'yaml',
        url: 'https://mcp.example.com/{{LIBRECHAT_BODY_CONVERSATIONID}}/mcp',
      };
      mockGetOAuthReconnectionManager.mockReturnValue({ isReconnecting: jest.fn(() => false) });
      mockGetFlowStateManager.mockReturnValue({
        getFlowState: jest.fn(() => ({
          status: 'PENDING',
          createdAt: Date.now() - 1000,
          ttl: 180000,
        })),
      });
      mockGetLogStores.mockReturnValue({});

      const result = await getServerConnectionStatus(
        mockUserId,
        mockServerName,
        config,
        appConnections,
        userConnections,
        oauthServers,
        { user: { id: mockUserId } },
      );

      expect(result).toEqual({
        requiresOAuth: true,
        requestScoped: true,
        connectionState: 'connecting',
        authorizationState: 'authorizing',
      });
    });

    it('should not inspect OAuth state for an explicitly non-OAuth runtime URL', async () => {
      const appConnections = new Map();
      const userConnections = new Map();
      const oauthServers = new Set();
      const { findToken } = require('~/models');
      const mockFlowManager = { getFlowState: jest.fn() };
      mockGetFlowStateManager.mockReturnValue(mockFlowManager);
      mockGetLogStores.mockReturnValue({});

      const result = await getServerConnectionStatus(
        mockUserId,
        mockServerName,
        {
          ...mockConfig,
          source: 'yaml',
          url: 'https://mcp.example.com/{{LIBRECHAT_USER_ID}}/mcp',
          requiresOAuth: false,
        },
        appConnections,
        userConnections,
        oauthServers,
      );

      expect(result).toEqual({
        requiresOAuth: false,
        connectionState: 'disconnected',
        authorizationState: 'not_required',
      });
      expect(mockFlowManager.getFlowState).not.toHaveBeenCalled();
      expect(findToken).not.toHaveBeenCalled();
    });

    it('should not report durable readiness when the runtime URL violates current policy', async () => {
      const appConnections = new Map();
      const userConnections = new Map();
      const oauthServers = new Set([mockServerName]);
      const { findToken } = require('~/models');
      const config = { ...mockConfig, url: 'https://blocked.example.com/' };
      mockGetOAuthReconnectionManager.mockReturnValue({ isReconnecting: jest.fn(() => false) });
      mockGetFlowStateManager.mockReturnValue({ getFlowState: jest.fn(() => null) });
      mockGetLogStores.mockReturnValue({});
      mockRegistryInstance.resolveAllowlists.mockResolvedValue({
        allowedDomains: ['allowed.example.com'],
        allowedAddresses: null,
        useSSRFProtection: false,
      });
      mockIsMCPDomainAllowed.mockResolvedValue(false);

      const result = await getServerConnectionStatus(
        mockUserId,
        mockServerName,
        config,
        appConnections,
        userConnections,
        oauthServers,
        { user: { id: mockUserId, role: 'user' } },
      );

      expect(result).toEqual({
        requiresOAuth: true,
        connectionState: 'disconnected',
        authorizationState: 'needs_authorization',
      });
      expect(mockRegistryInstance.resolveAllowlists).toHaveBeenCalledWith({
        userId: mockUserId,
        role: 'user',
      });
      expect(mockIsMCPDomainAllowed).toHaveBeenCalledWith(
        expect.objectContaining({ url: 'https://blocked.example.com/' }),
        ['allowed.example.com'],
        null,
      );
      expect(findToken).not.toHaveBeenCalled();
    });

    it('should validate durable readiness against the user-resolved runtime URL', async () => {
      const appConnections = new Map();
      const userConnections = new Map();
      const oauthServers = new Set([mockServerName]);
      const { findToken } = require('~/models');
      const credentialSetId = 'credential-set-a';
      const config = {
        ...mockConfig,
        source: 'yaml',
        url: 'https://mcp.example.com/users/{{LIBRECHAT_USER_ID}}/mcp',
      };
      mockGetOAuthReconnectionManager.mockReturnValue({ isReconnecting: jest.fn(() => false) });
      mockGetFlowStateManager.mockReturnValue({ getFlowState: jest.fn(() => null) });
      mockGetLogStores.mockReturnValue({});
      findToken
        .mockResolvedValueOnce({
          expiresAt: new Date(Date.now() + 60000),
          metadata: { credential_set_id: credentialSetId },
        })
        .mockResolvedValueOnce({
          token: 'enc:{"client_id":"dynamic-client"}',
          metadata: {
            credential_set_id: credentialSetId,
            authorization_endpoint: 'https://auth.example.com/authorize',
            token_endpoint: 'https://auth.example.com/token',
            server_url: `https://mcp.example.com/users/${mockUserId}/mcp`,
            client_source: 'dynamic',
          },
        });

      const result = await getServerConnectionStatus(
        mockUserId,
        mockServerName,
        config,
        appConnections,
        userConnections,
        oauthServers,
        { user: { id: mockUserId } },
      );

      expect(result).toEqual({
        requiresOAuth: true,
        connectionState: 'connected',
        authorizationState: 'authorized',
      });
    });

    it('should validate durable readiness against the Graph-resolved runtime URL', async () => {
      const appConnections = new Map();
      const userConnections = new Map();
      const oauthServers = new Set([mockServerName]);
      const { findToken } = require('~/models');
      const { getGraphApiToken } = require('./GraphTokenService');
      const credentialSetId = 'credential-set-a';
      const config = {
        ...mockConfig,
        source: 'yaml',
        url: 'https://mcp.example.com/{{LIBRECHAT_GRAPH_ACCESS_TOKEN}}/mcp',
      };
      const user = {
        id: mockUserId,
        provider: 'openid',
        openidId: 'openid-user',
        federatedTokens: {
          access_token: 'federated-access-token',
          expires_at: Math.floor(Date.now() / 1000) + 3600,
        },
      };
      getGraphApiToken.mockResolvedValue({
        access_token: 'resolved-graph-token',
        token_type: 'Bearer',
        expires_in: 3600,
        scope: 'https://graph.microsoft.com/.default',
      });
      mockGetOAuthReconnectionManager.mockReturnValue({ isReconnecting: jest.fn(() => false) });
      mockGetFlowStateManager.mockReturnValue({ getFlowState: jest.fn(() => null) });
      mockGetLogStores.mockReturnValue({});
      findToken
        .mockResolvedValueOnce({
          expiresAt: new Date(Date.now() + 60000),
          metadata: { credential_set_id: credentialSetId },
        })
        .mockResolvedValueOnce({
          token: 'enc:{"client_id":"dynamic-client"}',
          metadata: {
            credential_set_id: credentialSetId,
            authorization_endpoint: 'https://auth.example.com/authorize',
            token_endpoint: 'https://auth.example.com/token',
            server_url: 'https://mcp.example.com/resolved-graph-token/mcp',
            client_source: 'dynamic',
          },
        });

      const result = await getServerConnectionStatus(
        mockUserId,
        mockServerName,
        config,
        appConnections,
        userConnections,
        oauthServers,
        { user },
      );

      expect(result).toEqual({
        requiresOAuth: true,
        connectionState: 'connected',
        authorizationState: 'authorized',
      });
      expect(getGraphApiToken).toHaveBeenCalledWith(
        user,
        'federated-access-token',
        'https://graph.microsoft.com/.default',
        true,
      );
    });

    it('should not report durable readiness while required custom user variables are missing', async () => {
      const appConnections = new Map();
      const userConnections = new Map();
      const oauthServers = new Set([mockServerName]);
      const { findToken } = require('~/models');
      const credentialSetId = 'credential-set-a';
      const config = {
        ...mockConfig,
        url: 'https://mcp.example.com/',
        customUserVars: { API_KEY: { title: 'API key' } },
      };
      mockGetOAuthReconnectionManager.mockReturnValue({ isReconnecting: jest.fn(() => false) });
      mockGetFlowStateManager.mockReturnValue({ getFlowState: jest.fn(() => null) });
      mockGetLogStores.mockReturnValue({});
      findToken
        .mockResolvedValueOnce({
          expiresAt: new Date(Date.now() + 60000),
          metadata: { credential_set_id: credentialSetId },
        })
        .mockResolvedValueOnce({
          token: 'enc:{"client_id":"dynamic-client"}',
          metadata: {
            credential_set_id: credentialSetId,
            authorization_endpoint: 'https://auth.example.com/authorize',
            token_endpoint: 'https://auth.example.com/token',
            server_url: 'https://mcp.example.com/',
            client_source: 'dynamic',
          },
        });

      const result = await getServerConnectionStatus(
        mockUserId,
        mockServerName,
        config,
        appConnections,
        userConnections,
        oauthServers,
        { user: { id: mockUserId } },
      );

      expect(result).toEqual({
        requiresOAuth: true,
        connectionState: 'disconnected',
        authorizationState: 'needs_authorization',
      });
      expect(findToken).not.toHaveBeenCalled();
    });

    it('should reject stored authorization bound to an older server configuration', async () => {
      const appConnections = new Map();
      const userConnections = new Map();
      const oauthServers = new Set([mockServerName]);
      const { findToken } = require('~/models');
      const credentialSetId = 'credential-set-a';
      const config = {
        updatedAt: Date.now(),
        url: 'https://new-mcp.example.com/',
      };
      mockGetOAuthReconnectionManager.mockReturnValue({ isReconnecting: jest.fn(() => false) });
      mockGetFlowStateManager.mockReturnValue({ getFlowState: jest.fn(() => null) });
      mockGetLogStores.mockReturnValue({});
      findToken.mockImplementation(({ type }) => {
        if (type === 'mcp_oauth') {
          return {
            expiresAt: new Date(Date.now() + 60000),
            metadata: { credential_set_id: credentialSetId },
          };
        }
        if (type === 'mcp_oauth_client') {
          return {
            token: 'enc:{"client_id":"dynamic-client"}',
            metadata: {
              credential_set_id: credentialSetId,
              authorization_endpoint: 'https://auth.example.com/authorize',
              token_endpoint: 'https://auth.example.com/token',
              server_url: 'https://old-mcp.example.com/',
              client_source: 'dynamic',
            },
          };
        }
        return null;
      });

      const result = await getServerConnectionStatus(
        mockUserId,
        mockServerName,
        config,
        appConnections,
        userConnections,
        oauthServers,
      );

      expect(result).toEqual({
        requiresOAuth: true,
        connectionState: 'disconnected',
        authorizationState: 'needs_authorization',
      });
    });

    it('should handle OAuth flow status when disconnected and requires OAuth with no flow', async () => {
      const appConnections = new Map();
      const userConnections = new Map();
      const oauthServers = new Set([mockServerName]);

      // Mock OAuthReconnectionManager
      const mockOAuthReconnectionManager = {
        isReconnecting: jest.fn(() => false),
      };
      mockGetOAuthReconnectionManager.mockReturnValue(mockOAuthReconnectionManager);

      // Mock flow state to return no flow
      const mockFlowManager = {
        getFlowState: jest.fn(() => null),
      };
      mockGetFlowStateManager.mockReturnValue(mockFlowManager);
      mockGetLogStores.mockReturnValue({});
      MCPOAuthHandler.generateFlowId.mockReturnValue('test-flow-id');

      const result = await getServerConnectionStatus(
        mockUserId,
        mockServerName,
        mockConfig,
        appConnections,
        userConnections,
        oauthServers,
      );

      expect(result).toEqual({
        requiresOAuth: true,
        connectionState: 'disconnected',
        authorizationState: 'needs_authorization',
      });
    });

    it('should return connecting state when OAuth server is reconnecting', async () => {
      const appConnections = new Map();
      const userConnections = new Map();
      const oauthServers = new Set([mockServerName]);

      // Mock OAuthReconnectionManager to return true for isReconnecting
      const mockOAuthReconnectionManager = {
        isReconnecting: jest.fn(() => true),
      };
      mockGetOAuthReconnectionManager.mockReturnValue(mockOAuthReconnectionManager);

      const result = await getServerConnectionStatus(
        mockUserId,
        mockServerName,
        mockConfig,
        appConnections,
        userConnections,
        oauthServers,
      );

      expect(result).toEqual({
        requiresOAuth: true,
        connectionState: 'connecting',
        authorizationState: 'authorizing',
      });
      expect(mockOAuthReconnectionManager.isReconnecting).toHaveBeenCalledWith(
        mockUserId,
        mockServerName,
      );
    });

    it('should not check OAuth flow status when server is connected', async () => {
      const mockFlowManager = {
        getFlowState: jest.fn(),
      };
      mockGetFlowStateManager.mockReturnValue(mockFlowManager);
      mockGetLogStores.mockReturnValue({});

      const appConnections = new Map([
        [
          mockServerName,
          {
            connectionState: 'connected',
            isStale: jest.fn(() => false),
          },
        ],
      ]);
      const userConnections = new Map();
      const oauthServers = new Set([mockServerName]);

      const result = await getServerConnectionStatus(
        mockUserId,
        mockServerName,
        mockConfig,
        appConnections,
        userConnections,
        oauthServers,
      );

      expect(result).toEqual({
        requiresOAuth: true,
        connectionState: 'connected',
        authorizationState: 'authorized',
      });

      // Should not call flow manager since server is connected
      expect(mockFlowManager.getFlowState).not.toHaveBeenCalled();
    });

    it('should not check OAuth flow status when server does not require OAuth', async () => {
      const mockFlowManager = {
        getFlowState: jest.fn(),
      };
      mockGetFlowStateManager.mockReturnValue(mockFlowManager);
      mockGetLogStores.mockReturnValue({});

      const appConnections = new Map();
      const userConnections = new Map();
      const oauthServers = new Set(); // Server not in OAuth servers

      const result = await getServerConnectionStatus(
        mockUserId,
        mockServerName,
        mockConfig,
        appConnections,
        userConnections,
        oauthServers,
      );

      expect(result).toEqual({
        requiresOAuth: false,
        connectionState: 'disconnected',
        authorizationState: 'not_required',
      });

      // Should not call flow manager since server doesn't require OAuth
      expect(mockFlowManager.getFlowState).not.toHaveBeenCalled();
    });
  });
});

describe('User parameter passing tests', () => {
  let mockReinitMCPServer;
  let mockGetMCPManager;
  let mockGetFlowStateManager;
  let mockGetLogStores;

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetTenantId.mockReturnValue(undefined);
    mockReinitMCPServer = require('./Tools/mcp').reinitMCPServer;
    mockGetMCPManager = require('~/config').getMCPManager;
    mockGetFlowStateManager = require('~/config').getFlowStateManager;
    mockGetLogStores = require('~/cache').getLogStores;

    // Setup default mocks
    mockGetLogStores.mockReturnValue({});
    mockGetFlowStateManager.mockReturnValue({
      createFlowWithHandler: jest.fn(),
      failFlow: jest.fn(),
    });

    // Reset domain validation mock to default (allow all)
    mockIsMCPDomainAllowed.mockReset();
    mockIsMCPDomainAllowed.mockResolvedValue(true);

    // Reset registry mocks
    mockRegistryInstance.getServerConfig.mockReset();
    mockRegistryInstance.getServerConfig.mockResolvedValue(null);

    // Reset getAppConfig mock to default (no restrictions)
    mockGetAppConfig.mockReset();
    mockGetAppConfig.mockResolvedValue({});
  });

  describe('createMCPTools', () => {
    it('should pass user parameter to reinitMCPServer when calling reconnectServer internally', async () => {
      const mockUser = { id: 'test-user-123', name: 'Test User' };
      const mockRes = { write: jest.fn(), flush: jest.fn() };
      const mockSignal = new AbortController().signal;

      mockReinitMCPServer.mockResolvedValue({
        tools: [{ name: 'test-tool' }],
        availableTools: {
          [`test-tool${D}test-server`]: {
            function: {
              description: 'Test tool',
              parameters: { type: 'object', properties: {} },
            },
          },
        },
      });

      await createMCPTools({
        res: mockRes,
        user: mockUser,
        serverName: 'test-server',
        provider: 'openai',
        signal: mockSignal,
        userMCPAuthMap: {},
      });

      // Verify reinitMCPServer was called with the user
      expect(mockReinitMCPServer).toHaveBeenCalledWith(
        expect.objectContaining({
          user: mockUser,
          serverName: 'test-server',
        }),
      );
      expect(mockReinitMCPServer.mock.calls[0][0].user).toBe(mockUser);
    });

    it('fences resumable tool-loading OAuth events to the owning job epoch', async () => {
      const mockUser = { id: 'epoch-loading-user', name: 'Epoch Loading User' };
      const mockRes = { write: jest.fn(), flush: jest.fn() };
      const streamId = 'epoch-loading-stream';
      const jobCreatedAt = 1234;
      const flowManager = {
        getFlowState: jest.fn().mockResolvedValue(null),
        createFlowWithHandler: jest.fn(async (_flowId, _type, handler) => handler()),
        failFlow: jest.fn(),
      };
      mockGetFlowStateManager.mockReturnValue(flowManager);
      mockReinitMCPServer.mockImplementation(async ({ oauthStart }) => {
        await oauthStart('https://auth.example.com/loading');
        return { tools: [], availableTools: {} };
      });

      await createMCPTools({
        res: mockRes,
        user: mockUser,
        serverName: 'epoch-loading-server',
        provider: 'openai',
        userMCPAuthMap: {},
        config: { type: 'stdio' },
        streamId,
        jobCreatedAt,
      });

      expect(GenerationJobManager.emitChunk).toHaveBeenCalledTimes(2);
      expect(GenerationJobManager.emitChunk.mock.calls.map(([, event]) => event.event)).toEqual([
        'on_run_step',
        'on_run_step_delta',
      ]);
      for (const [emittedStreamId, , options] of GenerationJobManager.emitChunk.mock.calls) {
        expect(emittedStreamId).toBe(streamId);
        expect(options).toEqual({ expectedCreatedAt: jobCreatedAt });
      }
    });

    it('does not fail shared OAuth flows when tool loading is aborted', async () => {
      const mockUser = { id: 'tenant-user', name: 'Tenant User' };
      const mockRes = { write: jest.fn(), flush: jest.fn() };
      const abortController = new AbortController();
      const mockFlowManager = {
        createFlowWithHandler: jest.fn(),
        failFlow: jest.fn(),
      };
      mockGetFlowStateManager.mockReturnValue(mockFlowManager);

      let resolveReinit;
      mockReinitMCPServer.mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveReinit = resolve;
          }),
      );

      const createToolsPromise = createMCPTools({
        res: mockRes,
        user: mockUser,
        serverName: 'tenant-abort-server',
        provider: 'openai',
        signal: abortController.signal,
        userMCPAuthMap: {},
        config: { type: 'stdio' },
      });

      abortController.abort();
      resolveReinit({ tools: [], availableTools: {} });
      await createToolsPromise;

      expect(mockFlowManager.failFlow).not.toHaveBeenCalled();
    });

    it('should throw error if user is not provided', async () => {
      const mockRes = { write: jest.fn(), flush: jest.fn() };

      mockReinitMCPServer.mockResolvedValue({
        tools: [],
        availableTools: {},
      });

      // Call without user should throw error
      await expect(
        createMCPTools({
          res: mockRes,
          user: undefined,
          serverName: 'test-server',
          provider: 'openai',
          userMCPAuthMap: {},
        }),
      ).rejects.toThrow("Cannot read properties of undefined (reading 'id')");

      // Verify reinitMCPServer was not called due to early error
      expect(mockReinitMCPServer).not.toHaveBeenCalled();
    });
  });

  describe('createMCPTool', () => {
    it('preserves the full MCP tuple for the Assistants required-action sink', async () => {
      const mockUser = { id: 'assistants-app-user', role: 'USER' };
      const mockRes = { write: jest.fn(), flush: jest.fn() };
      const mcpApps = { enabled: true, legacyHtmlEnabled: true };
      const artifact = { ui_resources: { data: [{ uri: 'ui://app' }] } };
      const callTool = jest.fn().mockResolvedValue(['ordinary output', artifact]);
      const { getRoleByName } = require('~/models');
      getRoleByName.mockResolvedValue({
        permissions: {
          [PermissionTypes.MCP_SERVERS]: {
            [Permissions.USE]: true,
          },
        },
      });
      mockGetMCPManager.mockReturnValue({ callTool });

      const mcpTool = await createMCPTool({
        res: mockRes,
        user: mockUser,
        config: { url: 'https://assistants.example.com/mcp' },
        toolKey: `test-tool${D}test-server`,
        provider: 'assistants',
        mcpApps,
        userMCPAuthMap: {},
        availableTools: {
          [`test-tool${D}test-server`]: {
            function: {
              description: 'Cached tool',
              parameters: { type: 'object', properties: {} },
            },
          },
        },
      });

      await expect(mcpTool._call({})).resolves.toEqual(['ordinary output', artifact]);
      expect(callTool).toHaveBeenCalledWith(expect.objectContaining({ mcpApps }));
    });

    it('preserves a completed tool result when optional App enrichment observes cancellation', async () => {
      const mockUser = { id: 'completed-result-user', role: 'USER' };
      const mockRes = { write: jest.fn(), flush: jest.fn() };
      const abortController = new AbortController();
      const { getRoleByName } = require('~/models');
      getRoleByName.mockResolvedValue({
        permissions: {
          [PermissionTypes.MCP_SERVERS]: {
            [Permissions.USE]: true,
          },
        },
      });
      mockGetMCPManager.mockReturnValue({
        callTool: jest.fn().mockImplementation(async () => {
          abortController.abort();
          return ['ordinary output', undefined];
        }),
      });

      const mcpTool = await createMCPTool({
        res: mockRes,
        user: mockUser,
        config: { url: 'https://completed.example.com/mcp' },
        toolKey: `test-tool${D}test-server`,
        provider: 'openai',
        userMCPAuthMap: {},
        availableTools: {
          [`test-tool${D}test-server`]: {
            function: {
              description: 'Cached tool',
              parameters: { type: 'object', properties: {} },
            },
          },
        },
      });

      await expect(
        mcpTool.invoke(
          {},
          {
            signal: abortController.signal,
            configurable: { user: mockUser },
            metadata: { provider: 'openai', thread_id: 'thread-1', run_id: 'run-1' },
            toolCall: {},
          },
        ),
      ).resolves.toBe('ordinary output');
    });

    it('records a typed OBO failure against the scheduled generation before returning an error', async () => {
      const user = { id: 'scheduled-owner', role: 'USER' };
      const missing = new Error('Unattended provider not configured');
      const error = Object.assign(new Error('MCP tool error'), { cause: missing });
      const receipt = require('~/server/services/Schedules').recordMCPToolAuthFailure;
      require('~/models').getRoleByName.mockResolvedValue({
        permissions: { [PermissionTypes.MCP_SERVERS]: { [Permissions.USE]: true } },
      });
      mockGetMCPManager.mockReturnValue({ callTool: jest.fn().mockRejectedValue(error) });
      const tool = await createMCPTool({
        user,
        toolKey: `test-tool${D}test-server`,
        provider: 'openai',
        streamId: 'scheduled-conversation',
        jobCreatedAt: 42,
        config: { type: 'streamable-http', url: 'https://mcp.example.com' },
        availableTools: {
          [`test-tool${D}test-server`]: {
            function: { description: 'Test MCP', parameters: { type: 'object', properties: {} } },
          },
        },
      });
      await expect(
        tool.func({}, undefined, {
          configurable: { user },
          metadata: { provider: 'openai', thread_id: 'scheduled-conversation', run_id: 'run-1' },
          toolCall: {},
        }),
      ).rejects.toThrow();
      expect(receipt).toHaveBeenCalledWith({
        error,
        identity: undefined,
        streamId: 'scheduled-conversation',
        jobCreatedAt: 42,
        userId: 'scheduled-owner',
        serverName: 'test-server',
      });
    });

    it('carries captured schedule identity into the transport failure receipt', async () => {
      const {
        createScheduleMCPExecution,
        createMCPRequestContext,
        ScheduledMCPPolicyError,
      } = require('@librechat/api');
      const user = { id: 'scheduled-owner', tenantId: 'tenant', role: 'USER' };
      const identity = {
        scheduleId: 'schedule',
        ownerId: user.id,
        tenantId: 'tenant',
        agentId: 'root',
        invocationMode: 'delegated',
      };
      const context = createMCPRequestContext();
      const execution = createScheduleMCPExecution({
        storage: {
          readScheduleMCPConsent: async () => ({
            agentId: 'root',
            enabled: true,
            configRevision: 0,
            enrollment: null,
            compatible: true,
          }),
        },
        loadAuthorization: async () => {
          throw new Error('Unused legacy policy loader');
        },
      });
      await execution.attach(context, identity, 'invoke');
      const error = new ScheduledMCPPolicyError('consent_revoked', 'test-server', 'child');
      const receipt = require('~/server/services/Schedules').recordMCPToolAuthFailure;
      require('~/models').getRoleByName.mockResolvedValue({
        permissions: { [PermissionTypes.MCP_SERVERS]: { [Permissions.USE]: true } },
      });
      mockGetMCPManager.mockReturnValue({ callTool: jest.fn().mockRejectedValue(error) });
      const tool = await createMCPTool({
        agentId: 'child',
        user,
        toolKey: `test-tool${D}test-server`,
        provider: 'openai',
        streamId: 'scheduled-conversation',
        jobCreatedAt: 42,
        requestScopedConnections: context,
        config: { type: 'streamable-http', url: 'https://mcp.example.com' },
        availableTools: {
          [`test-tool${D}test-server`]: {
            function: { description: 'Test MCP', parameters: { type: 'object', properties: {} } },
          },
        },
      });
      // Model/run metadata cannot replace the tool-construction identity.
      const expectedIdentity = { ...identity };
      identity.scheduleId = 'mutated';
      await expect(
        tool.func({}, undefined, {
          configurable: {
            user,
            requestScopedConnections: createMCPRequestContext(),
            scheduleId: 'forged',
          },
          metadata: { provider: 'openai', thread_id: 'scheduled-conversation', run_id: 'run' },
          toolCall: {},
        }),
      ).rejects.toBe(error);
      expect(receipt).toHaveBeenCalledWith({
        error,
        identity: expectedIdentity,
        streamId: 'scheduled-conversation',
        jobCreatedAt: 42,
        userId: 'scheduled-owner',
        serverName: 'test-server',
      });
      expect(Object.isFrozen(receipt.mock.calls.at(-1)[0].identity)).toBe(true);
    });

    it('keeps shared OAuth recovery alive when one tool caller aborts', async () => {
      const mockUser = { id: 'shared-recovery-user', role: 'USER' };
      const mockRes = { write: jest.fn(), flush: jest.fn() };
      const ownerAbort = new AbortController();
      const waiterAbort = new AbortController();
      const flowManager = {
        getFlowState: jest.fn().mockResolvedValue(null),
        createFlowWithHandler: jest.fn(),
        failFlow: jest.fn(),
      };
      let completeRecovery;
      const sharedRecovery = new Promise((resolve) => {
        completeRecovery = resolve;
      });
      const callTool = jest.fn(({ options }) => {
        const signal = options?.signal;
        return new Promise((resolve, reject) => {
          const onAbort = () => {
            signal?.removeEventListener('abort', onAbort);
            reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'));
          };
          signal?.addEventListener('abort', onAbort, { once: true });
          sharedRecovery.then(() => {
            signal?.removeEventListener('abort', onAbort);
            resolve(['ok', null]);
          });
        });
      });
      const { getRoleByName } = require('~/models');
      getRoleByName.mockResolvedValue({
        permissions: {
          [PermissionTypes.MCP_SERVERS]: {
            [Permissions.USE]: true,
          },
        },
      });
      mockGetFlowStateManager.mockReturnValue(flowManager);
      mockGetMCPManager.mockReturnValue({ callTool });

      const mcpTool = await createMCPTool({
        res: mockRes,
        user: mockUser,
        config: { url: 'https://runtime-oauth.example.com/mcp' },
        toolKey: `test-tool${D}test-server`,
        provider: 'openai',
        userMCPAuthMap: {},
        availableTools: {
          [`test-tool${D}test-server`]: {
            function: {
              description: 'Cached tool',
              parameters: { type: 'object', properties: {} },
            },
          },
        },
      });
      const createConfig = (signal) => ({
        signal,
        configurable: { user: mockUser },
        metadata: { provider: 'openai', thread_id: 'thread-1', run_id: 'run-1' },
        toolCall: {},
      });

      const ownerCall = mcpTool.invoke({}, createConfig(ownerAbort.signal));
      const waiterCall = mcpTool.invoke({}, createConfig(waiterAbort.signal));
      await new Promise((resolve) => setImmediate(resolve));

      ownerAbort.abort(new DOMException('Aborted', 'AbortError'));

      await expect(ownerCall).rejects.toThrow('Aborted');
      expect(flowManager.failFlow).not.toHaveBeenCalled();

      completeRecovery();
      await expect(waiterCall).resolves.toBe('ok');
      expect(callTool).toHaveBeenCalledTimes(2);
    });

    it('logs a user-aborted tool call as debug, not as an MCP error', async () => {
      const mockUser = { id: 'cancel-user', role: 'USER' };
      const mockRes = { write: jest.fn(), flush: jest.fn() };
      const abortController = new AbortController();
      const { getRoleByName } = require('~/models');
      getRoleByName.mockResolvedValue({
        permissions: {
          [PermissionTypes.MCP_SERVERS]: {
            [Permissions.USE]: true,
          },
        },
      });
      mockGetMCPManager.mockReturnValue({
        callTool: jest.fn(
          ({ options }) =>
            new Promise((_resolve, reject) => {
              const signal = options?.signal;
              signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
            }),
        ),
      });

      const mcpTool = await createMCPTool({
        res: mockRes,
        user: mockUser,
        config: { url: 'https://cancel.example.com/mcp' },
        toolKey: `test-tool${D}test-server`,
        provider: 'openai',
        userMCPAuthMap: {},
        availableTools: {
          [`test-tool${D}test-server`]: {
            function: {
              description: 'Cached tool',
              parameters: { type: 'object', properties: {} },
            },
          },
        },
      });

      const call = mcpTool.invoke(
        {},
        {
          signal: abortController.signal,
          configurable: { user: mockUser },
          metadata: { provider: 'openai', thread_id: 'thread-1', run_id: 'run-1' },
          toolCall: {},
        },
      );
      await new Promise((resolve) => setImmediate(resolve));
      abortController.abort();
      await expect(call).rejects.toThrow();
      /** The wrapper rejects on abort while `_call` is still unwinding; let its
       *  catch run before asserting on what it logged. */
      await new Promise((resolve) => setImmediate(resolve));

      expect(logger.error).not.toHaveBeenCalledWith(
        expect.stringContaining('Error calling MCP tool'),
        expect.anything(),
      );
      expect(logger.debug).toHaveBeenCalledWith(
        expect.stringContaining('Tool call cancelled by user abort'),
      );
    });

    it('preserves AbortError from the MCP tool implementation', async () => {
      const mockUser = { id: 'cancel-user', role: 'USER' };
      const abortController = new AbortController();
      const abort = Object.assign(new Error('Stopped'), { name: 'AbortError' });
      const { getRoleByName } = require('~/models');
      getRoleByName.mockResolvedValue({
        permissions: {
          [PermissionTypes.MCP_SERVERS]: {
            [Permissions.USE]: true,
          },
        },
      });
      mockGetMCPManager.mockReturnValue({
        callTool: jest.fn(async () => {
          abortController.abort(abort);
          throw abort;
        }),
      });

      const mcpTool = await createMCPTool({
        user: mockUser,
        config: { url: 'https://cancel.example.com/mcp' },
        toolKey: `test-tool${D}test-server`,
        provider: 'openai',
        userMCPAuthMap: {},
        availableTools: {
          [`test-tool${D}test-server`]: {
            function: {
              description: 'Cached tool',
              parameters: { type: 'object', properties: {} },
            },
          },
        },
      });

      await expect(
        mcpTool.func({}, undefined, {
          signal: abortController.signal,
          configurable: { user: mockUser },
          metadata: { provider: 'openai', thread_id: 'thread-1', run_id: 'run-1' },
          toolCall: {},
        }),
      ).rejects.toBe(abort);
    });

    it('keeps a real failure racing the Stop at error level', async () => {
      const mockUser = { id: 'race-user', role: 'USER' };
      const mockRes = { write: jest.fn(), flush: jest.fn() };
      const abortController = new AbortController();
      const { getRoleByName } = require('~/models');
      getRoleByName.mockResolvedValue({
        permissions: {
          [PermissionTypes.MCP_SERVERS]: {
            [Permissions.USE]: true,
          },
        },
      });
      mockGetMCPManager.mockReturnValue({
        callTool: jest.fn(
          ({ options }) =>
            new Promise((_resolve, reject) => {
              options?.signal?.addEventListener(
                'abort',
                () => reject(new Error('upstream 503 from the MCP server')),
                { once: true },
              );
            }),
        ),
      });

      const mcpTool = await createMCPTool({
        res: mockRes,
        user: mockUser,
        config: { url: 'https://race.example.com/mcp' },
        toolKey: `test-tool${D}test-server`,
        provider: 'openai',
        userMCPAuthMap: {},
        availableTools: {
          [`test-tool${D}test-server`]: {
            function: {
              description: 'Cached tool',
              parameters: { type: 'object', properties: {} },
            },
          },
        },
      });

      const call = mcpTool.invoke(
        {},
        {
          signal: abortController.signal,
          configurable: { user: mockUser },
          metadata: { provider: 'openai', thread_id: 'thread-1', run_id: 'run-1' },
          toolCall: {},
        },
      );
      await new Promise((resolve) => setImmediate(resolve));
      abortController.abort();
      await expect(call).rejects.toThrow();
      await new Promise((resolve) => setImmediate(resolve));

      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('Error calling MCP tool'),
        expect.anything(),
      );
    });

    it.each(['OAuth flow initiated - return early', 'Pending OAuth flow reused - return early'])(
      'preserves runtime-detected OAuth for the internal signal: %s',
      async (oauthSignal) => {
        const mockUser = { id: 'runtime-oauth-user', role: 'USER' };
        const mockRes = { write: jest.fn(), flush: jest.fn() };
        const { getRoleByName } = require('~/models');
        getRoleByName.mockResolvedValue({
          permissions: {
            [PermissionTypes.MCP_SERVERS]: {
              [Permissions.USE]: true,
            },
          },
        });
        mockGetMCPManager.mockReturnValue({
          callTool: jest.fn().mockRejectedValue(new Error(oauthSignal)),
        });

        const mcpTool = await createMCPTool({
          res: mockRes,
          user: mockUser,
          config: { url: 'https://runtime-oauth.example.com/mcp' },
          toolKey: `test-tool${D}test-server`,
          provider: 'openai',
          userMCPAuthMap: {},
          availableTools: {
            [`test-tool${D}test-server`]: {
              function: {
                description: 'Cached tool',
                parameters: { type: 'object', properties: {} },
              },
            },
          },
        });

        await expect(
          mcpTool.invoke(
            {},
            {
              configurable: { user: mockUser },
              metadata: { provider: 'openai', thread_id: 'thread-1', run_id: 'run-1' },
              toolCall: {},
            },
          ),
        ).rejects.toThrow(
          '[MCP][test-server][test-tool] OAuth authentication required. Please check the server logs for the authentication URL.',
        );
      },
    );

    it('does not label forwarded-token failures as MCP OAuth', async () => {
      const mockUser = { id: 'forwarded-token-user', role: 'USER' };
      const mockRes = { write: jest.fn(), flush: jest.fn() };
      const { getRoleByName } = require('~/models');
      getRoleByName.mockResolvedValue({
        permissions: {
          [PermissionTypes.MCP_SERVERS]: {
            [Permissions.USE]: true,
          },
        },
      });
      mockGetMCPManager.mockReturnValue({
        callTool: jest.fn().mockRejectedValue(new Error('Non-200 status code (401)')),
      });

      const mcpTool = await createMCPTool({
        res: mockRes,
        user: mockUser,
        config: { requiresOAuth: false },
        toolKey: `test-tool${D}test-server`,
        provider: 'openai',
        userMCPAuthMap: {},
        availableTools: {
          [`test-tool${D}test-server`]: {
            function: {
              description: 'Cached tool',
              parameters: { type: 'object', properties: {} },
            },
          },
        },
      });

      await expect(
        mcpTool.invoke(
          {},
          {
            configurable: { user: mockUser },
            metadata: { provider: 'openai', thread_id: 'thread-1', run_id: 'run-1' },
            toolCall: {},
          },
        ),
      ).rejects.toThrow(
        '[MCP][test-server][test-tool] upstream authentication failed; MCP OAuth is not configured for this server.',
      );
    });

    it('preserves OpenIDReauthRequiredError through the OAuth error classification', async () => {
      const { OpenIDReauthRequiredError } = require('@librechat/api');
      const mockUser = { id: 'reauth-user', role: 'USER' };
      const mockRes = { write: jest.fn(), flush: jest.fn() };
      const { getRoleByName } = require('~/models');
      getRoleByName.mockResolvedValue({
        permissions: {
          [PermissionTypes.MCP_SERVERS]: {
            [Permissions.USE]: true,
          },
        },
      });
      const reauthError = new OpenIDReauthRequiredError(
        'OpenID token is expired or unavailable; re-authentication is required to resolve {{LIBRECHAT_OPENID_ACCESS_TOKEN}}.',
      );
      mockGetMCPManager.mockReturnValue({
        callTool: jest.fn().mockRejectedValue(reauthError),
      });

      const mcpTool = await createMCPTool({
        res: mockRes,
        user: mockUser,
        config: { requiresOAuth: false },
        toolKey: `test-tool${D}test-server`,
        provider: 'openai',
        userMCPAuthMap: {},
        availableTools: {
          [`test-tool${D}test-server`]: {
            function: {
              description: 'Cached tool',
              parameters: { type: 'object', properties: {} },
            },
          },
        },
      });

      await expect(
        mcpTool.invoke(
          {},
          {
            configurable: { user: mockUser },
            metadata: { provider: 'openai', thread_id: 'thread-1', run_id: 'run-1' },
            toolCall: {},
          },
        ),
      ).rejects.toBe(reauthError);
    });

    it('does not label OBO authentication failures as unconfigured MCP OAuth', async () => {
      const mockUser = { id: 'obo-user', role: 'USER' };
      const mockRes = { write: jest.fn(), flush: jest.fn() };
      const { getRoleByName } = require('~/models');
      getRoleByName.mockResolvedValue({
        permissions: {
          [PermissionTypes.MCP_SERVERS]: {
            [Permissions.USE]: true,
          },
        },
      });
      mockGetMCPManager.mockReturnValue({
        callTool: jest.fn().mockRejectedValue(new Error('Non-200 status code (401)')),
      });

      const mcpTool = await createMCPTool({
        res: mockRes,
        user: mockUser,
        config: { requiresOAuth: false, obo: {} },
        toolKey: `test-tool${D}test-server`,
        provider: 'openai',
        userMCPAuthMap: {},
        availableTools: {
          [`test-tool${D}test-server`]: {
            function: {
              description: 'Cached tool',
              parameters: { type: 'object', properties: {} },
            },
          },
        },
      });

      await expect(
        mcpTool.invoke(
          {},
          {
            configurable: { user: mockUser },
            metadata: { provider: 'openai', thread_id: 'thread-1', run_id: 'run-1' },
            toolCall: {},
          },
        ),
      ).rejects.toThrow(
        '[MCP][test-server][test-tool] OAuth authentication required. Please check the server logs for the authentication URL.',
      );
    });

    it('should pass user parameter to reinitMCPServer when tool not in cache', async () => {
      const mockUser = { id: 'test-user-456', email: 'test@example.com' };
      const mockRes = { write: jest.fn(), flush: jest.fn() };
      const mockSignal = new AbortController().signal;

      mockReinitMCPServer.mockResolvedValue({
        availableTools: {
          [`test-tool${D}test-server`]: {
            function: {
              description: 'Test tool',
              parameters: { type: 'object', properties: {} },
            },
          },
        },
      });

      // Call without availableTools to trigger reinit
      await createMCPTool({
        res: mockRes,
        user: mockUser,
        toolKey: `test-tool${D}test-server`,
        provider: 'openai',
        signal: mockSignal,
        userMCPAuthMap: {},
        availableTools: undefined, // Force reinit
      });

      // Verify reinitMCPServer was called with the user
      expect(mockReinitMCPServer).toHaveBeenCalledWith(
        expect.objectContaining({
          user: mockUser,
          serverName: 'test-server',
        }),
      );
      expect(mockReinitMCPServer.mock.calls[0][0].user).toBe(mockUser);
    });

    it('should report available tools discovered during single tool reinit', async () => {
      const mockUser = { id: 'user-discovery-callback', role: 'USER' };
      const mockRes = { write: jest.fn(), flush: jest.fn() };
      const onAvailableTools = jest.fn();
      const discoveredTools = {
        [`my-tool${D}my-server`]: {
          function: { description: 'My Tool', parameters: {} },
        },
        [`other-tool${D}my-server`]: {
          function: { description: 'Other Tool', parameters: {} },
        },
      };

      mockReinitMCPServer.mockResolvedValue({
        availableTools: discoveredTools,
      });

      const result = await createMCPTool({
        res: mockRes,
        user: mockUser,
        toolKey: `my-tool${D}my-server`,
        provider: 'openai',
        userMCPAuthMap: {},
        availableTools: undefined,
        onAvailableTools,
      });

      expect(result).toBeDefined();
      expect(onAvailableTools).toHaveBeenCalledWith(discoveredTools);
    });

    it('should not call reinitMCPServer when tool is in cache', async () => {
      const mockUser = { id: 'test-user-789' };
      const mockRes = { write: jest.fn(), flush: jest.fn() };

      const availableTools = {
        [`test-tool${D}test-server`]: {
          function: {
            description: 'Cached tool',
            parameters: { type: 'object', properties: {} },
          },
        },
      };

      await createMCPTool({
        res: mockRes,
        user: mockUser,
        toolKey: `test-tool${D}test-server`,
        provider: 'openai',
        userMCPAuthMap: {},
        availableTools: availableTools,
      });

      // Verify reinitMCPServer was NOT called since tool was in cache
      expect(mockReinitMCPServer).not.toHaveBeenCalled();
    });

    it('rejects a stripped-spelling entry without matching upstream identity', async () => {
      /** A stale key for a removed tool must degrade to the unavailable stub,
       *  not resolve onto a DIFFERENT sibling whose key coincides with the
       *  stripped spelling. */
      const mockUser = { id: 'stale-identity-user', role: 'USER' };
      const mockRes = { write: jest.fn(), flush: jest.fn() };
      mockReinitMCPServer.mockResolvedValue(null);

      const staleKey = `acme_acme_foo${D}acme`;
      const mcpTool = await createMCPTool({
        res: mockRes,
        user: mockUser,
        toolKey: staleKey,
        provider: 'openai',
        userMCPAuthMap: {},
        availableTools: {
          [`acme_foo${D}acme`]: {
            function: {
              name: `acme_foo${D}acme`,
              description: 'Different tool',
              parameters: { type: 'object', properties: {} },
            },
          },
        },
      });

      expect(mockReinitMCPServer).toHaveBeenCalled();
      expect(mcpTool.description).toBe(
        "This tool's MCP server is temporarily unavailable. Please try again shortly.",
      );
    });

    it('sends the raw upstream tool name when the key stripped a redundant server-name prefix', async () => {
      const mockUser = { id: 'stripped-prefix-user', role: 'USER' };
      const mockRes = { write: jest.fn(), flush: jest.fn() };
      const { getRoleByName } = require('~/models');
      getRoleByName.mockResolvedValue({
        permissions: {
          [PermissionTypes.MCP_SERVERS]: {
            [Permissions.USE]: true,
          },
        },
      });
      const callTool = jest.fn().mockResolvedValue(['ok', null]);
      mockGetMCPManager.mockReturnValue({ callTool });

      const strippedKey = `trace_top_time_consuming_operations${D}acme`;
      const mcpTool = await createMCPTool({
        res: mockRes,
        user: mockUser,
        toolKey: strippedKey,
        provider: 'openai',
        userMCPAuthMap: {},
        availableTools: {
          [strippedKey]: {
            serverToolName: 'acme_trace_top_time_consuming_operations',
            function: {
              name: strippedKey,
              description: 'Trace',
              parameters: { type: 'object', properties: {} },
            },
          },
        },
      });

      await mcpTool.invoke(
        {},
        {
          configurable: { user: mockUser },
          metadata: { provider: 'openai', thread_id: 'thread-1', run_id: 'run-1' },
          toolCall: {},
        },
      );

      expect(mcpTool.name).toBe(strippedKey);
      expect(callTool).toHaveBeenCalledWith(
        expect.objectContaining({
          serverName: 'acme',
          toolName: 'acme_trace_top_time_consuming_operations',
        }),
      );
    });

    it('resolves a legacy pre-strip tool key to the stripped definition without reinit', async () => {
      const mockUser = { id: 'legacy-prefix-user', role: 'USER' };
      const mockRes = { write: jest.fn(), flush: jest.fn() };
      const { getRoleByName } = require('~/models');
      getRoleByName.mockResolvedValue({
        permissions: {
          [PermissionTypes.MCP_SERVERS]: {
            [Permissions.USE]: true,
          },
        },
      });
      const callTool = jest.fn().mockResolvedValue(['ok', null]);
      mockGetMCPManager.mockReturnValue({ callTool });

      const strippedKey = `trace_top_time_consuming_operations${D}acme`;
      const legacyKey = `acme_trace_top_time_consuming_operations${D}acme`;
      const mcpTool = await createMCPTool({
        res: mockRes,
        user: mockUser,
        toolKey: legacyKey,
        provider: 'openai',
        userMCPAuthMap: {},
        availableTools: {
          [strippedKey]: {
            serverToolName: 'acme_trace_top_time_consuming_operations',
            function: {
              name: strippedKey,
              description: 'Trace',
              parameters: { type: 'object', properties: {} },
            },
          },
        },
      });

      expect(mockReinitMCPServer).not.toHaveBeenCalled();

      await mcpTool.invoke(
        {},
        {
          configurable: { user: mockUser },
          metadata: { provider: 'openai', thread_id: 'thread-1', run_id: 'run-1' },
          toolCall: {},
        },
      );

      /** The persisted spelling stays the instance name so `agent.tools` and
       *  `tool_options` keyed by it keep applying; only the upstream call
       *  uses the recorded raw name. */
      expect(mcpTool.name).toBe(legacyKey);
      expect(callTool).toHaveBeenCalledWith(
        expect.objectContaining({
          serverName: 'acme',
          toolName: 'acme_trace_top_time_consuming_operations',
        }),
      );
    });

    it('should reject tool execution when user lacks MCP server use permission', async () => {
      const mockUser = { id: 'mcp-denied-user', role: 'USER' };
      const mockRes = { write: jest.fn(), flush: jest.fn() };
      const { getRoleByName } = require('~/models');
      getRoleByName.mockResolvedValue({
        permissions: {
          [PermissionTypes.MCP_SERVERS]: {
            [Permissions.USE]: false,
          },
        },
      });

      const mcpTool = await createMCPTool({
        res: mockRes,
        user: mockUser,
        toolKey: `test-tool${D}test-server`,
        provider: 'openai',
        userMCPAuthMap: {},
        availableTools: {
          [`test-tool${D}test-server`]: {
            function: {
              description: 'Cached tool',
              parameters: { type: 'object', properties: {} },
            },
          },
        },
      });

      await expect(
        mcpTool.invoke(
          {},
          {
            configurable: {
              user: mockUser,
            },
            metadata: {
              provider: 'openai',
            },
            toolCall: {},
          },
        ),
      ).rejects.toThrow(
        '[MCP][test-server][test-tool] tool call failed: Forbidden: Insufficient MCP server permissions',
      );
      expect(mockGetMCPManager).not.toHaveBeenCalled();
    });

    it('fences resumable tool-call OAuth events to the owning job epoch', async () => {
      const mockUser = { id: 'epoch-tool-user', role: 'USER' };
      const mockRes = { write: jest.fn(), flush: jest.fn() };
      const streamId = 'epoch-tool-stream';
      const jobCreatedAt = 5678;
      const { getRoleByName } = require('~/models');
      getRoleByName.mockResolvedValue({
        permissions: {
          [PermissionTypes.MCP_SERVERS]: {
            [Permissions.USE]: true,
          },
        },
      });
      const flowManager = {
        getFlowState: jest.fn().mockResolvedValue(null),
        createFlowWithHandler: jest.fn(async (_flowId, _type, handler) => handler()),
        failFlow: jest.fn(),
      };
      mockGetFlowStateManager.mockReturnValue(flowManager);
      mockGetMCPManager.mockReturnValue({
        callTool: jest.fn(async ({ oauthStart, oauthEnd }) => {
          await oauthStart('https://auth.example.com/tool-call');
          await oauthEnd();
          return ['ok', null];
        }),
      });

      const mcpTool = await createMCPTool({
        res: mockRes,
        user: mockUser,
        toolKey: `test-tool${D}epoch-tool-server`,
        provider: 'openai',
        userMCPAuthMap: {},
        availableTools: {
          [`test-tool${D}epoch-tool-server`]: {
            function: {
              description: 'Epoch-fenced tool',
              parameters: { type: 'object', properties: {} },
            },
          },
        },
        streamId,
        jobCreatedAt,
      });

      await mcpTool.invoke(
        {},
        {
          configurable: { user: mockUser },
          metadata: {
            provider: 'openai',
            thread_id: 'thread-epoch',
            run_id: 'run-epoch',
          },
          toolCall: {
            id: 'tool-call-epoch',
            stepId: 'step-epoch',
            name: 'test-tool',
            type: 'tool_call',
          },
        },
      );

      expect(GenerationJobManager.emitChunk).toHaveBeenCalledTimes(2);
      for (const [emittedStreamId, , options] of GenerationJobManager.emitChunk.mock.calls) {
        expect(emittedStreamId).toBe(streamId);
        expect(options).toEqual({ expectedCreatedAt: jobCreatedAt });
      }
    });

    it('should reuse request-scoped MCP permission checks across tool executions', async () => {
      const mockUser = { id: 'mcp-allowed-user', role: 'USER' };
      const mockReq = { user: mockUser };
      const mockRes = { write: jest.fn(), flush: jest.fn() };
      const { getRoleByName } = require('~/models');
      getRoleByName.mockResolvedValue({
        permissions: {
          [PermissionTypes.MCP_SERVERS]: {
            [Permissions.USE]: true,
          },
        },
      });

      const mockCallTool = jest.fn().mockResolvedValue(['ok', null]);
      mockGetMCPManager.mockReturnValue({
        callTool: mockCallTool,
      });

      const availableTools = {
        [`search${D}test-server`]: {
          function: {
            description: 'Search tool',
            parameters: { type: 'object', properties: {} },
          },
        },
        [`fetch${D}test-server`]: {
          function: {
            description: 'Fetch tool',
            parameters: { type: 'object', properties: {} },
          },
        },
      };
      const mcpPermissionContext = createMCPPermissionContext(mockReq);

      const searchTool = await createMCPTool({
        mcpPermissionContext,
        res: mockRes,
        user: mockUser,
        toolKey: `search${D}test-server`,
        provider: 'openai',
        userMCPAuthMap: {},
        availableTools,
      });
      const fetchTool = await createMCPTool({
        mcpPermissionContext,
        res: mockRes,
        user: mockUser,
        toolKey: `fetch${D}test-server`,
        provider: 'openai',
        userMCPAuthMap: {},
        availableTools,
      });

      const invocationConfig = {
        configurable: {
          user: mockUser,
        },
        metadata: {
          provider: 'openai',
          thread_id: 'thread-1',
          run_id: 'run-1',
        },
        toolCall: {},
      };

      await expect(searchTool.invoke({}, invocationConfig)).resolves.toBe('ok');
      await expect(fetchTool.invoke({}, invocationConfig)).resolves.toBe('ok');

      expect(getRoleByName).toHaveBeenCalledTimes(1);
      expect(mockCallTool).toHaveBeenCalledTimes(2);
    });

    it('should pass the captured user to MCPManager.callTool when invocation config omits configurable.user', async () => {
      const mockUser = { id: 'captured-user', email: 'captured@example.com', role: 'USER' };
      const mockRes = { write: jest.fn(), flush: jest.fn() };
      const { getRoleByName } = require('~/models');
      getRoleByName.mockResolvedValue({
        permissions: {
          [PermissionTypes.MCP_SERVERS]: {
            [Permissions.USE]: true,
          },
        },
      });

      const mockCallTool = jest.fn().mockResolvedValue(['ok', null]);
      mockGetMCPManager.mockReturnValue({
        callTool: mockCallTool,
      });

      const mcpTool = await createMCPTool({
        res: mockRes,
        user: mockUser,
        toolKey: `test-tool${D}test-server`,
        provider: 'openai',
        userMCPAuthMap: {},
        availableTools: {
          [`test-tool${D}test-server`]: {
            function: {
              description: 'Cached tool',
              parameters: { type: 'object', properties: {} },
            },
          },
        },
      });

      await expect(
        mcpTool.invoke(
          {},
          {
            configurable: {
              user_id: mockUser.id,
            },
            metadata: {
              provider: 'openai',
              thread_id: 'thread-1',
              run_id: 'run-1',
            },
            toolCall: {},
          },
        ),
      ).resolves.toBe('ok');

      expect(mockCallTool).toHaveBeenCalledWith(
        expect.objectContaining({
          serverName: 'test-server',
          toolName: 'test-tool',
          user: mockUser,
        }),
      );
    });

    it('should pass captured request body when invocation config omits requestBody', async () => {
      const mockUser = { id: 'captured-body-user', email: 'captured@example.com', role: 'USER' };
      const requestBody = { conversationId: 'conv-123', messageId: 'msg-123' };
      const mockRes = { write: jest.fn(), flush: jest.fn() };
      const { getRoleByName } = require('~/models');
      getRoleByName.mockResolvedValue({
        permissions: {
          [PermissionTypes.MCP_SERVERS]: {
            [Permissions.USE]: true,
          },
        },
      });

      const mockCallTool = jest.fn().mockResolvedValue(['ok', null]);
      mockGetMCPManager.mockReturnValue({
        callTool: mockCallTool,
      });

      const mcpTool = await createMCPTool({
        res: mockRes,
        user: mockUser,
        requestBody,
        toolKey: `test-tool${D}test-server`,
        provider: 'openai',
        userMCPAuthMap: {},
        availableTools: {
          [`test-tool${D}test-server`]: {
            function: {
              description: 'Cached tool',
              parameters: { type: 'object', properties: {} },
            },
          },
        },
      });

      await expect(
        mcpTool.invoke(
          {},
          {
            configurable: {
              user: mockUser,
            },
            metadata: {
              provider: 'openai',
              thread_id: 'thread-1',
              run_id: 'run-1',
            },
            toolCall: {},
          },
        ),
      ).resolves.toBe('ok');

      expect(mockCallTool).toHaveBeenCalledWith(
        expect.objectContaining({
          serverName: 'test-server',
          toolName: 'test-tool',
          requestBody,
        }),
      );
    });

    it('forwards the pre-built upstream-token closure to callTool without receiving req', async () => {
      const mockUser = {
        id: 'obo-user',
        email: 'obo@example.com',
        role: 'USER',
        provider: 'openid',
      };
      const mockRes = { write: jest.fn(), flush: jest.fn() };
      const { getRoleByName } = require('~/models');
      getRoleByName.mockResolvedValue({
        permissions: {
          [PermissionTypes.MCP_SERVERS]: {
            [Permissions.USE]: true,
          },
        },
      });

      const sentinelClosure = async () => null;

      const mockCallTool = jest.fn().mockResolvedValue(['ok', null]);
      mockGetMCPManager.mockReturnValue({ callTool: mockCallTool });

      const mcpTool = await createMCPTool({
        res: mockRes,
        user: mockUser,
        toolKey: `test-tool${D}test-server`,
        provider: 'openai',
        userMCPAuthMap: {},
        upstreamTokenProvider: sentinelClosure,
        availableTools: {
          [`test-tool${D}test-server`]: {
            function: {
              description: 'Cached tool',
              parameters: { type: 'object', properties: {} },
            },
          },
        },
      });

      await expect(
        mcpTool.invoke(
          {},
          {
            configurable: { user: mockUser },
            metadata: { provider: 'openai', thread_id: 't1', run_id: 'r1' },
            toolCall: {},
          },
        ),
      ).resolves.toBe('ok');

      expect(mockCallTool).toHaveBeenCalledWith(
        expect.objectContaining({
          upstreamTokenProvider: sentinelClosure,
        }),
      );
    });

    it('should reject OBO tool execution when effective and captured users differ', async () => {
      const capturedUser = { id: 'captured-user', email: 'captured@example.com', role: 'USER' };
      const effectiveUser = { id: 'effective-user', email: 'effective@example.com', role: 'USER' };
      const mockRes = { write: jest.fn(), flush: jest.fn() };

      const mcpTool = await createMCPTool({
        res: mockRes,
        user: capturedUser,
        toolKey: `test-tool${D}obo-server`,
        provider: 'openai',
        userMCPAuthMap: {},
        config: {
          url: 'https://obo.example.com',
          obo: { scopes: 'api://obo-server/Mcp.Tools.ReadWrite' },
        },
        availableTools: {
          [`test-tool${D}obo-server`]: {
            function: {
              description: 'Cached OBO tool',
              parameters: { type: 'object', properties: {} },
            },
          },
        },
      });

      await expect(
        mcpTool.invoke(
          {},
          {
            configurable: { user: effectiveUser },
            metadata: { provider: 'openai', thread_id: 't1', run_id: 'r1' },
            toolCall: {},
          },
        ),
      ).rejects.toThrow('OBO tool call user mismatch');

      expect(mockGetMCPManager).not.toHaveBeenCalled();
    });

    it('should reject direct OpenID bearer execution when effective and captured users differ', async () => {
      const capturedUser = { id: 'captured-user', email: 'captured@example.com', role: 'USER' };
      const effectiveUser = { id: 'effective-user', email: 'effective@example.com', role: 'USER' };
      const mockRes = { write: jest.fn(), flush: jest.fn() };

      const mcpTool = await createMCPTool({
        res: mockRes,
        user: capturedUser,
        toolKey: `test-tool${D}direct-server`,
        provider: 'openai',
        userMCPAuthMap: {},
        config: {
          type: 'streamable-http',
          url: 'https://direct.example.com',
          source: 'yaml',
          headers: { Authorization: 'Bearer {{LIBRECHAT_OPENID_ACCESS_TOKEN}}' },
        },
        availableTools: {
          [`test-tool${D}direct-server`]: {
            function: {
              description: 'Cached direct bearer tool',
              parameters: { type: 'object', properties: {} },
            },
          },
        },
      });

      await expect(
        mcpTool.invoke(
          {},
          {
            configurable: { user: effectiveUser },
            metadata: { provider: 'openai', thread_id: 't1', run_id: 'r1' },
            toolCall: {},
          },
        ),
      ).rejects.toThrow('Direct OpenID bearer tool call user mismatch');

      expect(mockGetMCPManager).not.toHaveBeenCalled();
    });

    it('should reject OBO tool execution when an effective or captured user id is missing', async () => {
      const capturedUser = { email: 'captured@example.com', role: 'USER' };
      const effectiveUser = { id: 'effective-user', email: 'effective@example.com', role: 'USER' };
      const mockRes = { write: jest.fn(), flush: jest.fn() };

      const mcpTool = await createMCPTool({
        res: mockRes,
        user: capturedUser,
        toolKey: `test-tool${D}obo-server`,
        provider: 'openai',
        userMCPAuthMap: {},
        config: {
          url: 'https://obo.example.com',
          obo: { scopes: 'api://obo-server/Mcp.Tools.ReadWrite' },
        },
        availableTools: {
          [`test-tool${D}obo-server`]: {
            function: {
              description: 'Cached OBO tool',
              parameters: { type: 'object', properties: {} },
            },
          },
        },
      });

      await expect(
        mcpTool.invoke(
          {},
          {
            configurable: { user: effectiveUser },
            metadata: { provider: 'openai', thread_id: 't1', run_id: 'r1' },
            toolCall: {},
          },
        ),
      ).rejects.toThrow('OBO tool calls require matching captured and effective user ids');

      expect(mockGetMCPManager).not.toHaveBeenCalled();
    });

    it('should execute OBO tools when effective and captured user ids match', async () => {
      const capturedUser = { id: 'obo-user', email: 'captured@example.com', role: 'USER' };
      const effectiveUser = { id: 'obo-user', email: 'effective@example.com', role: 'USER' };
      const mockRes = { write: jest.fn(), flush: jest.fn() };
      const { getRoleByName } = require('~/models');
      getRoleByName.mockResolvedValue({
        permissions: {
          [PermissionTypes.MCP_SERVERS]: {
            [Permissions.USE]: true,
          },
        },
      });

      const mockCallTool = jest.fn().mockResolvedValue(['ok', null]);
      mockGetMCPManager.mockReturnValue({ callTool: mockCallTool });

      const mcpTool = await createMCPTool({
        res: mockRes,
        user: capturedUser,
        toolKey: `test-tool${D}obo-server`,
        provider: 'openai',
        userMCPAuthMap: {},
        upstreamTokenProvider: async () => null,
        config: {
          url: 'https://obo.example.com',
          obo: { scopes: 'api://obo-server/Mcp.Tools.ReadWrite' },
        },
        availableTools: {
          [`test-tool${D}obo-server`]: {
            function: {
              description: 'Cached OBO tool',
              parameters: { type: 'object', properties: {} },
            },
          },
        },
      });

      await expect(
        mcpTool.invoke(
          {},
          {
            configurable: {
              user: effectiveUser,
              user_id: 'third-user',
            },
            metadata: { provider: 'openai', thread_id: 't1', run_id: 'r1' },
            toolCall: {},
          },
        ),
      ).resolves.toBe('ok');

      expect(mockGetMCPManager).toHaveBeenCalledWith('obo-user');
      expect(mockCallTool).toHaveBeenCalledWith(
        expect.objectContaining({
          user: effectiveUser,
        }),
      );
    });
  });

  describe('reinitMCPServer (via reconnectServer)', () => {
    it('should always receive user parameter when called from createMCPTools', async () => {
      const mockUser = { id: 'user-001', role: 'admin' };
      const mockRes = { write: jest.fn(), flush: jest.fn() };

      // Track all calls to reinitMCPServer
      const reinitCalls = [];
      mockReinitMCPServer.mockImplementation((params) => {
        reinitCalls.push(params);
        return Promise.resolve({
          tools: [{ name: 'tool1' }, { name: 'tool2' }],
          availableTools: {
            [`tool1${D}server1`]: { function: { description: 'Tool 1', parameters: {} } },
            [`tool2${D}server1`]: { function: { description: 'Tool 2', parameters: {} } },
          },
        });
      });

      await createMCPTools({
        res: mockRes,
        user: mockUser,
        serverName: 'server1',
        provider: 'anthropic',
        userMCPAuthMap: {},
        streamId: 'scheduled-stream',
        jobCreatedAt: 42,
      });

      // Verify all calls to reinitMCPServer had the user
      expect(reinitCalls.length).toBeGreaterThan(0);
      reinitCalls.forEach((call) => {
        expect(call.user).toBe(mockUser);
        expect(call.user.id).toBe('user-001');
        expect(call.streamId).toBe('scheduled-stream');
        expect(call.jobCreatedAt).toBe(42);
      });
    });

    it('should always receive user parameter when called from createMCPTool', async () => {
      const mockUser = { id: 'user-002', permissions: ['read', 'write'] };
      const mockRes = { write: jest.fn(), flush: jest.fn() };

      // Track all calls to reinitMCPServer
      const reinitCalls = [];
      mockReinitMCPServer.mockImplementation((params) => {
        reinitCalls.push(params);
        return Promise.resolve({
          availableTools: {
            [`my-tool${D}my-server`]: {
              function: { description: 'My Tool', parameters: {} },
            },
          },
        });
      });

      await createMCPTool({
        res: mockRes,
        user: mockUser,
        toolKey: `my-tool${D}my-server`,
        provider: 'google',
        userMCPAuthMap: {},
        availableTools: undefined, // Force reinit
        streamId: 'resumed-stream',
        jobCreatedAt: 43,
      });

      // Verify the call to reinitMCPServer had the user
      expect(reinitCalls.length).toBe(1);
      expect(reinitCalls[0].user).toBe(mockUser);
      expect(reinitCalls[0].user.id).toBe('user-002');
      expect(reinitCalls[0].streamId).toBe('resumed-stream');
      expect(reinitCalls[0].jobCreatedAt).toBe(43);
    });
  });

  describe('Runtime domain validation', () => {
    it('should skip tool creation when domain is not allowed', async () => {
      const mockUser = { id: 'domain-test-user', role: 'user' };
      const mockRes = { write: jest.fn(), flush: jest.fn() };

      // Mock server config with URL (remote server)
      mockRegistryInstance.getServerConfig.mockResolvedValue({
        url: 'https://disallowed-domain.com/sse',
      });

      // Mock getAppConfig to return domain restrictions
      mockGetAppConfig.mockResolvedValue({
        mcpSettings: { allowedDomains: ['allowed-domain.com'] },
      });

      // Mock domain validation to return false (domain not allowed)
      mockIsMCPDomainAllowed.mockResolvedValueOnce(false);

      const result = await createMCPTool({
        res: mockRes,
        user: mockUser,
        toolKey: `test-tool${D}test-server`,
        provider: 'openai',
        userMCPAuthMap: {},
        availableTools: {
          [`test-tool${D}test-server`]: {
            function: {
              description: 'Test tool',
              parameters: { type: 'object', properties: {} },
            },
          },
        },
      });

      // Should return undefined for disallowed domain
      expect(result).toBeUndefined();

      // Should not call reinitMCPServer since domain check failed
      expect(mockReinitMCPServer).not.toHaveBeenCalled();

      // Verify getAppConfig was called with the user scope
      expect(mockGetAppConfig).toHaveBeenCalledWith({
        role: 'user',
        tenantId: undefined,
        userId: 'domain-test-user',
      });

      // Verify domain validation was called with correct parameters
      expect(mockIsMCPDomainAllowed).toHaveBeenCalledWith(
        { url: 'https://disallowed-domain.com/sse' },
        ['allowed-domain.com'],
        undefined,
      );
    });

    it('should allow tool creation when domain is allowed', async () => {
      const mockUser = { id: 'domain-test-user', role: 'admin' };
      const mockRes = { write: jest.fn(), flush: jest.fn() };

      // Mock server config with URL (remote server)
      mockRegistryInstance.getServerConfig.mockResolvedValue({
        url: 'https://allowed-domain.com/sse',
      });

      // Mock getAppConfig to return domain restrictions
      mockGetAppConfig.mockResolvedValue({
        mcpSettings: { allowedDomains: ['allowed-domain.com'] },
      });

      // Mock domain validation to return true (domain allowed)
      mockIsMCPDomainAllowed.mockResolvedValueOnce(true);

      const availableTools = {
        [`test-tool${D}test-server`]: {
          function: {
            description: 'Test tool',
            parameters: { type: 'object', properties: {} },
          },
        },
      };

      const result = await createMCPTool({
        res: mockRes,
        user: mockUser,
        toolKey: `test-tool${D}test-server`,
        provider: 'openai',
        userMCPAuthMap: {},
        availableTools,
      });

      // Should create tool successfully
      expect(result).toBeDefined();

      // Verify getAppConfig was called with the user scope
      expect(mockGetAppConfig).toHaveBeenCalledWith({
        role: 'admin',
        tenantId: undefined,
        userId: 'domain-test-user',
      });
    });

    it('should validate the resolved runtime URL for tool creation', async () => {
      const mockUser = { id: 'runtime-domain-user', role: 'user' };
      const requestBody = { conversationId: 'tenant-a' };
      const mockRes = { write: jest.fn(), flush: jest.fn() };

      mockRegistryInstance.getServerConfig.mockResolvedValue({
        type: 'streamable-http',
        url: 'https://{{LIBRECHAT_BODY_CONVERSATIONID}}.example.com/sse',
        source: 'yaml',
      });

      mockGetAppConfig.mockResolvedValue({
        mcpSettings: { allowedDomains: ['*.example.com'] },
      });

      mockIsMCPDomainAllowed.mockResolvedValueOnce(true);

      const result = await createMCPTool({
        res: mockRes,
        user: mockUser,
        requestBody,
        toolKey: `test-tool${D}test-server`,
        provider: 'openai',
        userMCPAuthMap: {},
        availableTools: {
          [`test-tool${D}test-server`]: {
            function: {
              description: 'Test tool',
              parameters: { type: 'object', properties: {} },
            },
          },
        },
      });

      expect(result).toBeDefined();
      expect(mockIsMCPDomainAllowed).toHaveBeenCalledWith(
        expect.objectContaining({
          url: 'https://tenant-a.example.com/sse',
        }),
        ['*.example.com'],
        undefined,
      );
    });

    it('loads the tool when the early domain gate meets an expired OpenID snapshot token', async () => {
      const mockUser = {
        id: 'expired-token-user',
        role: 'user',
        provider: 'openid',
        federatedTokens: {
          access_token: 'stale-token',
          expires_at: Math.floor(Date.now() / 1000) - 3600,
        },
      };
      const mockRes = { write: jest.fn(), flush: jest.fn() };

      const serverConfig = {
        type: 'streamable-http',
        url: 'https://mcp.example.com/mcp',
        source: 'yaml',
        requiresOAuth: false,
        headers: { Authorization: 'Bearer {{LIBRECHAT_OPENID_TOKEN}}' },
      };
      mockRegistryInstance.getServerConfig.mockResolvedValue(serverConfig);
      mockGetAppConfig.mockResolvedValue({
        mcpSettings: { allowedDomains: ['mcp.example.com'] },
      });
      mockIsMCPDomainAllowed.mockResolvedValueOnce(true);

      const upstreamTokenProvider = jest.fn().mockResolvedValue({ access_token: 'fresh-token' });

      const result = await createMCPTool({
        res: mockRes,
        user: mockUser,
        toolKey: `test-tool${D}test-server`,
        provider: 'openai',
        userMCPAuthMap: {},
        upstreamTokenProvider,
        availableTools: {
          [`test-tool${D}test-server`]: {
            function: {
              description: 'Test tool',
              parameters: { type: 'object', properties: {} },
            },
          },
        },
      });

      expect(result).toBeDefined();
      /** The gate decides from the URL, so it must not spend an IdP round trip per tool. */
      expect(upstreamTokenProvider).not.toHaveBeenCalled();
      const [validationConfig, domains, addresses] = mockIsMCPDomainAllowed.mock.calls[0];
      expect(validationConfig.url).toBe('https://mcp.example.com/mcp');
      expect(validationConfig.headers).toBeUndefined();
      expect([domains, addresses]).toEqual([['mcp.example.com'], undefined]);
      /** The connection path still receives the placeholder it can refresh. */
      expect(serverConfig.headers).toEqual({
        Authorization: 'Bearer {{LIBRECHAT_OPENID_TOKEN}}',
      });
    });

    it('still fails closed when the URL itself carries an unresolvable OpenID credential', async () => {
      const { OpenIDReauthRequiredError } = require('@librechat/api');
      const mockUser = {
        id: 'no-session-user',
        role: 'user',
        provider: 'openid',
        federatedTokens: {
          access_token: 'stale-token',
          expires_at: Math.floor(Date.now() / 1000) - 3600,
        },
      };
      const mockRes = { write: jest.fn(), flush: jest.fn() };

      mockRegistryInstance.getServerConfig.mockResolvedValue({
        type: 'streamable-http',
        url: 'https://mcp.example.com/mcp/{{LIBRECHAT_OPENID_ACCESS_TOKEN}}',
        source: 'yaml',
        requiresOAuth: false,
        headers: { Authorization: 'Bearer {{LIBRECHAT_OPENID_TOKEN}}' },
      });
      mockGetAppConfig.mockResolvedValue({
        mcpSettings: { allowedDomains: ['mcp.example.com'] },
      });

      const upstreamTokenProvider = jest.fn().mockResolvedValue(null);

      await expect(
        createMCPTool({
          res: mockRes,
          user: mockUser,
          toolKey: `test-tool${D}test-server`,
          provider: 'openai',
          userMCPAuthMap: {},
          upstreamTokenProvider,
          availableTools: {
            [`test-tool${D}test-server`]: {
              function: {
                description: 'Test tool',
                parameters: { type: 'object', properties: {} },
              },
            },
          },
        }),
      ).rejects.toThrow(OpenIDReauthRequiredError);
    });

    it('loads the batch path when the domain gate meets an expired OpenID snapshot token', async () => {
      const mockUser = {
        id: 'expired-token-batch-user',
        role: 'user',
        provider: 'openid',
        federatedTokens: {
          access_token: 'stale-token',
          expires_at: Math.floor(Date.now() / 1000) - 3600,
        },
      };
      const mockRes = { write: jest.fn(), flush: jest.fn() };

      mockGetAppConfig.mockResolvedValue({
        mcpSettings: { allowedDomains: ['mcp.example.com'] },
      });
      mockReinitMCPServer.mockResolvedValue({
        tools: [{ name: 'test-tool' }],
        availableTools: {
          [`test-tool${D}test-server`]: {
            function: {
              description: 'Test tool',
              parameters: { type: 'object', properties: {} },
            },
          },
        },
      });

      const upstreamTokenProvider = jest.fn().mockResolvedValue({ access_token: 'fresh-token' });

      const tools = await createMCPTools({
        res: mockRes,
        user: mockUser,
        serverName: 'test-server',
        provider: 'openai',
        userMCPAuthMap: {},
        upstreamTokenProvider,
        config: {
          type: 'streamable-http',
          url: 'https://mcp.example.com/mcp',
          source: 'yaml',
          requiresOAuth: false,
          headers: { Authorization: 'Bearer {{LIBRECHAT_OPENID_TOKEN}}' },
        },
      });

      expect(tools).toHaveLength(1);
      expect(upstreamTokenProvider).not.toHaveBeenCalled();
      const [validationConfig] = mockIsMCPDomainAllowed.mock.calls[0];
      expect(validationConfig.url).toBe('https://mcp.example.com/mcp');
      expect(validationConfig.headers).toBeUndefined();
      /** Recovery still owns the placeholder on the connection path. */
      expect(mockReinitMCPServer).toHaveBeenCalledWith(
        expect.objectContaining({ upstreamTokenProvider }),
      );
    });

    it('should skip domain validation for stdio transports (no URL)', async () => {
      const mockUser = { id: 'stdio-test-user' };
      const mockRes = { write: jest.fn(), flush: jest.fn() };

      // Mock server config without URL (stdio transport)
      mockRegistryInstance.getServerConfig.mockResolvedValue({
        command: 'npx',
        args: ['@modelcontextprotocol/server'],
      });

      // Mock getAppConfig (should not be called for stdio)
      mockGetAppConfig.mockResolvedValue({
        mcpSettings: { allowedDomains: ['restricted-domain.com'] },
      });

      const availableTools = {
        [`test-tool${D}test-server`]: {
          function: {
            description: 'Test tool',
            parameters: { type: 'object', properties: {} },
          },
        },
      };

      const result = await createMCPTool({
        res: mockRes,
        user: mockUser,
        toolKey: `test-tool${D}test-server`,
        provider: 'openai',
        userMCPAuthMap: {},
        availableTools,
      });

      // Should create tool successfully without domain check
      expect(result).toBeDefined();

      // Should not call getAppConfig or isMCPDomainAllowed for stdio transport (no URL)
      expect(mockGetAppConfig).not.toHaveBeenCalled();
      expect(mockIsMCPDomainAllowed).not.toHaveBeenCalled();
    });

    it('should return empty array from createMCPTools when domain is not allowed', async () => {
      const mockUser = { id: 'domain-test-user', role: 'user' };
      const mockRes = { write: jest.fn(), flush: jest.fn() };

      // Mock server config with URL (remote server)
      const serverConfig = { url: 'https://disallowed-domain.com/sse' };
      mockRegistryInstance.getServerConfig.mockResolvedValue(serverConfig);

      // Mock getAppConfig to return domain restrictions
      mockGetAppConfig.mockResolvedValue({
        mcpSettings: { allowedDomains: ['allowed-domain.com'] },
      });

      // Mock domain validation to return false (domain not allowed)
      mockIsMCPDomainAllowed.mockResolvedValueOnce(false);

      const result = await createMCPTools({
        res: mockRes,
        user: mockUser,
        serverName: 'test-server',
        provider: 'openai',
        userMCPAuthMap: {},
        config: serverConfig,
      });

      // Should return empty array for disallowed domain
      expect(result).toEqual([]);

      // Should not call reinitMCPServer since domain check failed early
      expect(mockReinitMCPServer).not.toHaveBeenCalled();

      // Verify getAppConfig was called with the user scope
      expect(mockGetAppConfig).toHaveBeenCalledWith({
        role: 'user',
        tenantId: undefined,
        userId: 'domain-test-user',
      });
    });

    it('should use user role when fetching domain restrictions', async () => {
      const adminUser = { id: 'admin-user', role: 'admin' };
      const regularUser = { id: 'regular-user', role: 'user' };
      const mockRes = { write: jest.fn(), flush: jest.fn() };

      mockRegistryInstance.getServerConfig.mockResolvedValue({
        url: 'https://some-domain.com/sse',
      });

      // Mock different responses based on role
      mockGetAppConfig
        .mockResolvedValueOnce({ mcpSettings: { allowedDomains: ['admin-allowed.com'] } })
        .mockResolvedValueOnce({ mcpSettings: { allowedDomains: ['user-allowed.com'] } });

      mockIsMCPDomainAllowed.mockResolvedValue(true);

      const availableTools = {
        [`test-tool${D}test-server`]: {
          function: {
            description: 'Test tool',
            parameters: { type: 'object', properties: {} },
          },
        },
      };

      // Call with admin user
      await createMCPTool({
        res: mockRes,
        user: adminUser,
        toolKey: `test-tool${D}test-server`,
        provider: 'openai',
        userMCPAuthMap: {},
        availableTools,
      });

      // Reset and call with regular user
      mockRegistryInstance.getServerConfig.mockResolvedValue({
        url: 'https://some-domain.com/sse',
      });

      await createMCPTool({
        res: mockRes,
        user: regularUser,
        toolKey: `test-tool${D}test-server`,
        provider: 'openai',
        userMCPAuthMap: {},
        availableTools,
      });

      // Verify getAppConfig was called with the correct user scopes
      expect(mockGetAppConfig).toHaveBeenNthCalledWith(1, {
        role: 'admin',
        tenantId: undefined,
        userId: 'admin-user',
      });
      expect(mockGetAppConfig).toHaveBeenNthCalledWith(2, {
        role: 'user',
        tenantId: undefined,
        userId: 'regular-user',
      });
    });
  });

  describe('createUnavailableToolStub', () => {
    it('should return a tool whose _call returns a valid CONTENT_AND_ARTIFACT two-tuple', async () => {
      const stub = createUnavailableToolStub('myTool', 'myServer');
      // invoke() goes through langchain's base tool, which checks responseFormat.
      // CONTENT_AND_ARTIFACT requires [content, artifact] — a bare string would throw:
      //   "Tool response format is "content_and_artifact" but the output was not a two-tuple"
      const result = await stub.invoke({});
      // If we reach here without throwing, the two-tuple format is correct.
      // invoke() returns the content portion of [content, artifact] as a string.
      expect(result).toContain('temporarily unavailable');
    });
  });

  describe('negative tool cache and throttle interaction', () => {
    it('should cache tool as missing even when throttled (cross-user dedup)', async () => {
      const mockUser = { id: 'throttle-test-user' };
      const mockRes = { write: jest.fn(), flush: jest.fn() };

      // First call: reconnect succeeds but tool not found
      mockReinitMCPServer.mockResolvedValueOnce({
        availableTools: {},
      });

      await createMCPTool({
        res: mockRes,
        user: mockUser,
        toolKey: `missing-tool${D}cache-dedup-server`,
        provider: 'openai',
        userMCPAuthMap: {},
        availableTools: undefined,
      });

      // Second call within 10s for DIFFERENT tool on same server:
      // reconnect is throttled (returns null), tool is still cached as missing.
      // This is intentional: the cache acts as cross-user dedup since the
      // throttle is per-user-per-server and can't prevent N different users
      // from each triggering their own reconnect.
      const result2 = await createMCPTool({
        res: mockRes,
        user: mockUser,
        toolKey: `other-tool${D}cache-dedup-server`,
        provider: 'openai',
        userMCPAuthMap: {},
        availableTools: undefined,
      });

      expect(result2).toBeDefined();
      expect(result2.name).toContain('other-tool');
      expect(mockReinitMCPServer).toHaveBeenCalledTimes(1);
    });

    it('should prevent user B from triggering reconnect when user A already cached the tool', async () => {
      const userA = { id: 'cache-user-A' };
      const userB = { id: 'cache-user-B' };
      const mockRes = { write: jest.fn(), flush: jest.fn() };

      // User A: real reconnect, tool not found → cached
      mockReinitMCPServer.mockResolvedValueOnce({
        availableTools: {},
      });

      await createMCPTool({
        res: mockRes,
        user: userA,
        toolKey: `shared-tool${D}cross-user-server`,
        provider: 'openai',
        userMCPAuthMap: {},
        availableTools: undefined,
      });

      expect(mockReinitMCPServer).toHaveBeenCalledTimes(1);

      // User B requests the SAME tool within 10s.
      // The negative cache is keyed by toolKey (no user prefix), so user B
      // gets a cache hit and no reconnect fires. This is the cross-user
      // storm protection: without this, user B's unthrottled first request
      // would trigger a second reconnect to the same server.
      const result = await createMCPTool({
        res: mockRes,
        user: userB,
        toolKey: `shared-tool${D}cross-user-server`,
        provider: 'openai',
        userMCPAuthMap: {},
        availableTools: undefined,
      });

      expect(result).toBeDefined();
      expect(result.name).toContain('shared-tool');
      // reinitMCPServer still called only once — user B hit the cache
      expect(mockReinitMCPServer).toHaveBeenCalledTimes(1);
    });

    it('should prevent user B from triggering reconnect for throttle-cached tools', async () => {
      const userA = { id: 'storm-user-A' };
      const userB = { id: 'storm-user-B' };
      const mockRes = { write: jest.fn(), flush: jest.fn() };

      // User A: real reconnect for tool-1, tool not found → cached
      mockReinitMCPServer.mockResolvedValueOnce({
        availableTools: {},
      });

      await createMCPTool({
        res: mockRes,
        user: userA,
        toolKey: `tool-1${D}storm-server`,
        provider: 'openai',
        userMCPAuthMap: {},
        availableTools: undefined,
      });

      // User A: tool-2 on same server within 10s → throttled → cached from throttle
      await createMCPTool({
        res: mockRes,
        user: userA,
        toolKey: `tool-2${D}storm-server`,
        provider: 'openai',
        userMCPAuthMap: {},
        availableTools: undefined,
      });

      expect(mockReinitMCPServer).toHaveBeenCalledTimes(1);

      // User B requests tool-2 — gets cache hit from the throttle-cached entry.
      // Without this caching, user B would trigger a real reconnect since
      // user B has their own throttle key and hasn't reconnected yet.
      const result = await createMCPTool({
        res: mockRes,
        user: userB,
        toolKey: `tool-2${D}storm-server`,
        provider: 'openai',
        userMCPAuthMap: {},
        availableTools: undefined,
      });

      expect(result).toBeDefined();
      expect(result.name).toContain('tool-2');
      // Still only 1 real reconnect — user B was protected by the cache
      expect(mockReinitMCPServer).toHaveBeenCalledTimes(1);
    });

    it('should bypass the negative cache for request-scoped tools', async () => {
      const userA = { id: 'request-scoped-user-A' };
      const userB = { id: 'request-scoped-user-B' };
      const mockRes = { write: jest.fn(), flush: jest.fn() };
      const serverName = 'request-scoped-server';
      const toolKey = `tenant-tool${D}${serverName}`;

      mockRegistryInstance.getServerConfig.mockResolvedValue({
        type: 'streamable-http',
        url: 'https://api.example.com/{{LIBRECHAT_BODY_MESSAGEID}}/mcp',
        source: 'yaml',
      });

      mockReinitMCPServer
        .mockResolvedValueOnce({
          availableTools: {},
        })
        .mockResolvedValueOnce({
          availableTools: {
            [toolKey]: {
              function: { description: 'Tenant tool', parameters: {} },
            },
          },
        });

      await createMCPTool({
        res: mockRes,
        user: userA,
        requestBody: { messageId: 'message-a' },
        toolKey,
        provider: 'openai',
        userMCPAuthMap: {},
        availableTools: undefined,
      });

      const result = await createMCPTool({
        res: mockRes,
        user: userB,
        requestBody: { messageId: 'message-b' },
        toolKey,
        provider: 'openai',
        userMCPAuthMap: {},
        availableTools: undefined,
      });

      expect(result).toBeDefined();
      expect(result.name).toContain('tenant-tool');
      expect(mockReinitMCPServer).toHaveBeenCalledTimes(2);
    });
  });

  describe('createMCPTools throttle handling', () => {
    it('should return empty array with debug log when reconnect is throttled', async () => {
      const mockUser = { id: 'throttle-tools-user' };
      const mockRes = { write: jest.fn(), flush: jest.fn() };

      // First call: real reconnect
      mockReinitMCPServer.mockResolvedValueOnce({
        tools: [{ name: 'tool1' }],
        availableTools: {
          [`tool1${D}throttle-tools-server`]: {
            function: { description: 'Tool 1', parameters: {} },
          },
        },
      });

      await createMCPTools({
        res: mockRes,
        user: mockUser,
        serverName: 'throttle-tools-server',
        provider: 'openai',
        userMCPAuthMap: {},
      });

      // Second call within 10s — throttled
      const result = await createMCPTools({
        res: mockRes,
        user: mockUser,
        serverName: 'throttle-tools-server',
        provider: 'openai',
        userMCPAuthMap: {},
      });

      expect(result).toEqual([]);
      // reinitMCPServer called only once — second was throttled
      expect(mockReinitMCPServer).toHaveBeenCalledTimes(1);
      // Should log at debug level (not warn) for throttled case
      expect(logger.debug).toHaveBeenCalledWith(expect.stringContaining('Reconnect throttled'));
    });
  });

  describe('User parameter integrity', () => {
    it('should preserve user object properties through the call chain', async () => {
      const complexUser = {
        id: 'complex-user',
        name: 'John Doe',
        email: 'john@example.com',
        metadata: { subscription: 'premium', settings: { theme: 'dark' } },
      };
      const mockRes = { write: jest.fn(), flush: jest.fn() };

      let capturedUser = null;
      mockReinitMCPServer.mockImplementation((params) => {
        capturedUser = params.user;
        return Promise.resolve({
          tools: [{ name: 'test' }],
          availableTools: {
            [`test${D}server`]: { function: { description: 'Test', parameters: {} } },
          },
        });
      });

      await createMCPTools({
        res: mockRes,
        user: complexUser,
        serverName: 'server',
        provider: 'openai',
        userMCPAuthMap: {},
      });

      // Verify the complete user object was passed
      expect(capturedUser).toEqual(complexUser);
      expect(capturedUser.id).toBe('complex-user');
      expect(capturedUser.metadata.subscription).toBe('premium');
      expect(capturedUser.metadata.settings.theme).toBe('dark');
    });

    it('should throw error when user is null', async () => {
      const mockRes = { write: jest.fn(), flush: jest.fn() };

      mockReinitMCPServer.mockResolvedValue({
        tools: [],
        availableTools: {},
      });

      await expect(
        createMCPTools({
          res: mockRes,
          user: null,
          serverName: 'test-server',
          provider: 'openai',
          userMCPAuthMap: {},
        }),
      ).rejects.toThrow("Cannot read properties of null (reading 'id')");

      // Verify reinitMCPServer was not called due to early error
      expect(mockReinitMCPServer).not.toHaveBeenCalled();
    });
  });
});
