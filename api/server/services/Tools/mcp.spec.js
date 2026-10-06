const { Constants } = require('librechat-data-provider');
const { logger } = require('@librechat/data-schemas');
const { STANDARD_MCP_CAPABILITY_PROFILE } = require('@librechat/api');

const mockGetConnection = jest.fn();
const mockDiscoverServerTools = jest.fn();
const mockGetGraphApiToken = jest.fn();
const mockUpdateMCPServerTools = jest.fn();
const mockGetMCPToolsCacheGeneration = jest.fn().mockResolvedValue('generation-current');
const mockGetToolPublicationGeneration = jest.fn().mockReturnValue('generation-current');
const mockLoadCatalogs = jest.fn();
const mockGetUserMCPAuthMap = jest.fn();
const mockFormatMCPServerTools = jest.fn();
const mockGetMCPServerTools = jest.fn();
const mockCacheMCPServerTools = jest.fn();
const mockGetServerToolFunctionsSnapshot = jest.fn();
const mockClearCatalogRecoveryState = jest.fn();
const mockInvalidateCachedTools = jest.fn();

jest.mock('@librechat/api', () => ({
  ...jest.requireActual('@librechat/api'),
  loadMCPServerCatalogs: (...args) => mockLoadCatalogs(...args),
  getUserMCPAuthMap: (...args) => mockGetUserMCPAuthMap(...args),
  formatMCPServerTools: (...args) => mockFormatMCPServerTools(...args),
}));

jest.mock('~/config', () => ({
  getMCPManager: jest.fn(() => ({
    getConnection: mockGetConnection,
    discoverServerTools: mockDiscoverServerTools,
    getServerToolFunctionsSnapshot: mockGetServerToolFunctionsSnapshot,
    getToolPublicationGeneration: mockGetToolPublicationGeneration,
    clearCatalogRecoveryState: mockClearCatalogRecoveryState,
  })),
  getMCPServersRegistry: jest.fn(() => ({ getServerConfig: jest.fn() })),
  getFlowStateManager: jest.fn(() => ({})),
}));
jest.mock('~/models', () => ({
  findToken: jest.fn(),
  createToken: jest.fn(),
  updateToken: jest.fn(),
  deleteTokens: jest.fn(),
  findPluginAuthsByKeys: jest.fn(),
}));
jest.mock('~/server/services/Config', () => ({
  updateMCPServerTools: mockUpdateMCPServerTools,
  getMCPToolsCacheGeneration: mockGetMCPToolsCacheGeneration,
  getMCPServerTools: mockGetMCPServerTools,
  cacheMCPServerTools: mockCacheMCPServerTools,
  invalidateCachedTools: mockInvalidateCachedTools,
}));
jest.mock('~/server/services/MCPAuthorizationFenceRetry', () => ({
  persistMCPAuthorizationFenceRetry: jest.fn().mockResolvedValue('retry-v1'),
  clearMCPAuthorizationFenceRetry: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('~/server/services/GraphTokenService', () => ({
  getGraphApiToken: mockGetGraphApiToken,
}));
jest.mock('~/cache', () => ({
  getLogStores: jest.fn(() => ({})),
}));
jest.mock('~/cache/getLogStores', () => jest.fn(() => ({})));
jest.mock('~/server/services/Schedules', () => ({
  recordMCPToolAuthFailure: jest.fn(async () => true),
}));

const { reinitMCPServer, loadMCPServerCatalogs } = require('./mcp');

describe('loadMCPServerCatalogs', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('wires batched auth and passive discovery without opening a managed connection', async () => {
    const user = { id: 'user-123' };
    const servers = [
      {
        serverName: 'config-only',
        serverConfig: { type: 'sse', url: 'https://config.example.com/sse' },
      },
      {
        serverName: 'user-server',
        serverConfig: { type: 'sse', url: 'https://user.example.com/sse' },
      },
    ];
    mockGetUserMCPAuthMap.mockResolvedValue({});
    mockDiscoverServerTools.mockResolvedValue({ tools: [] });
    mockFormatMCPServerTools.mockReturnValue({});
    const observedCredentialFence = jest.fn();
    let recoveryDeps;
    mockLoadCatalogs.mockImplementation(async (params, deps) => {
      recoveryDeps = deps;
      await deps.loadUserMCPAuthMap(
        user.id,
        servers.map(({ serverName }) => serverName),
      );
      await deps.discoverServerTools({
        user,
        serverName: 'config-only',
        configServers: { 'config-only': servers[0].serverConfig },
        onOAuthCredentialsChanging: observedCredentialFence,
      });
      deps.formatServerTools('config-only', []);
      await deps.getCachedServerTools(user.id, 'config-only', servers[0].serverConfig);
      await deps.getServerToolFunctionsSnapshot(user.id, 'config-only', servers[0].serverConfig, {
        deadlineMs: 123,
      });
      await deps.getRecoveryGeneration({ userId: user.id, serverName: 'config-only' });
      await deps.cacheServerTools({ serverName: 'config-only' });
      return { serverTools: new Map([['config-only', {}]]), serversWithoutTools: [] };
    });

    const upstreamTokenProvider = jest.fn();
    const oboIdentityContext = { appUserId: 'user-123' };
    const result = await loadMCPServerCatalogs({
      user,
      servers,
      upstreamTokenProvider,
      oboIdentityContext,
    });

    expect(mockGetUserMCPAuthMap).toHaveBeenCalledTimes(1);
    expect(mockGetMCPToolsCacheGeneration).toHaveBeenCalledWith({
      userId: user.id,
      serverName: 'config-only',
    });
    expect(mockGetUserMCPAuthMap).toHaveBeenCalledWith({
      userId: user.id,
      servers: ['config-only', 'user-server'],
      findPluginAuthsByKeys: require('~/models').findPluginAuthsByKeys,
    });
    expect(recoveryDeps.onOAuthCredentialsChanging).toEqual(expect.any(Function));
    expect(mockDiscoverServerTools).toHaveBeenCalledWith(
      expect.objectContaining({
        user,
        serverName: 'config-only',
        configServers: { 'config-only': servers[0].serverConfig },
        flowManager: expect.any(Object),
        tokenMethods: expect.any(Object),
        upstreamTokenProvider,
        oboIdentityContext,
        onOAuthCredentialsChanging: observedCredentialFence,
      }),
    );
    expect(mockGetConnection).not.toHaveBeenCalled();
    expect(mockGetMCPServerTools).toHaveBeenCalledWith(
      user.id,
      'config-only',
      servers[0].serverConfig,
    );
    expect(mockGetServerToolFunctionsSnapshot).toHaveBeenCalledWith(
      user.id,
      'config-only',
      servers[0].serverConfig,
      { deadlineMs: 123 },
    );
    expect(mockCacheMCPServerTools).toHaveBeenCalledWith({ serverName: 'config-only' });
    expect(result).toEqual({
      serverTools: new Map([['config-only', {}]]),
      serversWithoutTools: [],
    });
  });

  it('clears catalog recovery with the generation its credential fence published', async () => {
    let recoveryDeps;
    mockInvalidateCachedTools.mockResolvedValue('generation-2');
    mockLoadCatalogs.mockImplementation(async (params, deps) => {
      recoveryDeps = deps;
      return { serverTools: new Map(), serversWithoutTools: [] };
    });

    await loadMCPServerCatalogs({ user: { id: 'user-123' }, servers: [] });
    const publish = await recoveryDeps.onOAuthCredentialsChanging({
      userId: 'user-123',
      serverName: 'oauth-server',
    });

    await expect(publish()).resolves.toBe('generation-2');
    expect(mockClearCatalogRecoveryState).toHaveBeenCalledWith(
      'user-123',
      'oauth-server',
      'generation-2',
    );
  });
});

describe('reinitMCPServer — customUserVars gating (issue #10969)', () => {
  const user = { id: 'user-123' };
  const serverName = 'Thingy';
  const serverConfig = {
    type: 'streamable-http',
    url: 'https://thingy.example.com/mcp',
    customUserVars: {
      THINGY_TOKEN: { title: 'Thingy Access Token', description: 'Create this in Thingy' },
    },
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockUpdateMCPServerTools.mockResolvedValue({});
  });

  it('does not connect and exposes no tools when a required customUserVar is unset', async () => {
    const result = await reinitMCPServer({
      user,
      serverName,
      serverConfig,
      userMCPAuthMap: undefined,
    });

    expect(mockGetConnection).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      availableTools: null,
      success: false,
      tools: null,
      failureReason: 'missing_custom_user_vars',
      missingUserVars: ['THINGY_TOKEN'],
      oauthRequired: false,
      serverName,
    });
    expect(result.message).toContain('THINGY_TOKEN');
  });

  it('does not connect when the stored value for a required customUserVar is empty', async () => {
    const result = await reinitMCPServer({
      user,
      serverName,
      serverConfig,
      userMCPAuthMap: { [`${Constants.mcp_prefix}${serverName}`]: { THINGY_TOKEN: '' } },
    });

    expect(mockGetConnection).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
    expect(result.availableTools).toBeNull();
  });

  it('proceeds to connect once every required customUserVar is provided', async () => {
    mockGetConnection.mockResolvedValue({ fetchTools: jest.fn().mockResolvedValue([]) });

    await reinitMCPServer({
      user,
      serverName,
      serverConfig,
      userMCPAuthMap: {
        [`${Constants.mcp_prefix}${serverName}`]: { THINGY_TOKEN: 'secret-token' },
      },
    });

    expect(mockGetConnection).toHaveBeenCalledTimes(1);
    expect(mockGetConnection).toHaveBeenCalledWith(
      expect.objectContaining({
        serverName,
        customUserVars: { THINGY_TOKEN: 'secret-token' },
      }),
    );
  });

  it('updates the cache with an empty catalog after a successful connection', async () => {
    mockGetConnection.mockResolvedValue({ fetchTools: jest.fn().mockResolvedValue([]) });

    await reinitMCPServer({
      user,
      serverName,
      serverConfig: { type: 'streamable-http', url: 'https://thingy.example.com/mcp' },
      userMCPAuthMap: undefined,
    });

    expect(mockUpdateMCPServerTools).toHaveBeenCalledWith({
      userId: user.id,
      serverName,
      tools: [],
      serverConfig: { type: 'streamable-http', url: 'https://thingy.example.com/mcp' },
      publicationGeneration: 'generation-current',
      capabilityProfile: STANDARD_MCP_CAPABILITY_PROFILE,
    });
  });

  /** An app-level catalog write is dropped unless it carries the ordering reserved before its
   * own tools/list. When this path forwarded no revision, every publication was discarded and
   * agents were told the server had no tools at all (#14857). */
  it('publishes under the ordering its snapshot was fetched with', async () => {
    mockGetConnection.mockResolvedValue({
      fetchOrderedToolsSnapshot: jest.fn().mockResolvedValue({
        tools: [{ name: 'search', inputSchema: { type: 'object' } }],
        complete: true,
        publicationRevision: '7',
      }),
    });

    await reinitMCPServer({
      user,
      serverName,
      serverConfig: { type: 'streamable-http', url: 'https://thingy.example.com/mcp' },
    });

    expect(mockUpdateMCPServerTools).toHaveBeenCalledWith(
      expect.objectContaining({ serverName, publicationRevision: '7' }),
    );
  });

  it('asks the connection to republish a catalog it could not order', async () => {
    const refreshToolList = jest.fn().mockResolvedValue(undefined);
    mockGetConnection.mockResolvedValue({
      refreshToolList,
      fetchOrderedToolsSnapshot: jest.fn().mockResolvedValue({
        tools: [{ name: 'search', inputSchema: { type: 'object' } }],
        complete: true,
        orderingUnavailable: true,
      }),
    });

    const result = await reinitMCPServer({
      user,
      serverName,
      serverConfig: { type: 'streamable-http', url: 'https://thingy.example.com/mcp' },
    });

    expect(refreshToolList).toHaveBeenCalledTimes(1);
    expect(result.tools).toHaveLength(1);
  });

  it('preserves cached tools when live recovery returns an incomplete snapshot', async () => {
    const signal = new AbortController().signal;
    const fetchOrderedToolsSnapshot = jest.fn().mockResolvedValue({
      tools: [{ name: 'partial', inputSchema: { type: 'object' } }],
      complete: false,
    });
    mockGetConnection.mockResolvedValue({
      fetchOrderedToolsSnapshot,
    });

    const result = await reinitMCPServer({
      user,
      serverName,
      signal,
      serverConfig: { type: 'streamable-http', url: 'https://thingy.example.com/mcp' },
    });

    expect(result.tools).toBeNull();
    expect(fetchOrderedToolsSnapshot).toHaveBeenCalledTimes(1);
    expect(fetchOrderedToolsSnapshot).toHaveBeenCalledWith(undefined, signal);
    expect(mockUpdateMCPServerTools).not.toHaveBeenCalled();
  });

  it('discards a snapshot when another replica rotates its generation during discovery', async () => {
    mockGetMCPToolsCacheGeneration
      .mockResolvedValueOnce('generation-current')
      .mockResolvedValueOnce('generation-replaced');
    mockGetConnection.mockResolvedValue({
      fetchOrderedToolsSnapshot: jest.fn().mockResolvedValue({
        tools: [{ name: 'stale', inputSchema: { type: 'object' } }],
        complete: true,
      }),
    });

    const result = await reinitMCPServer({
      user,
      serverName,
      serverConfig: { type: 'streamable-http', url: 'https://thingy.example.com/mcp' },
    });

    expect(result.tools).toBeNull();
    expect(result.availableTools).toBeNull();
    expect(mockUpdateMCPServerTools).not.toHaveBeenCalled();
  });

  it('does not return tools when the guarded publication loses its generation race', async () => {
    mockGetConnection.mockResolvedValue({
      fetchOrderedToolsSnapshot: jest.fn().mockResolvedValue({
        tools: [{ name: 'stale', inputSchema: { type: 'object' } }],
        complete: true,
      }),
    });
    mockUpdateMCPServerTools.mockResolvedValue(null);

    const result = await reinitMCPServer({
      user,
      serverName,
      serverConfig: { type: 'streamable-http', url: 'https://thingy.example.com/mcp' },
    });

    expect(result.tools).toBeNull();
    expect(result.availableTools).toBeNull();
  });

  it('passes request body and Graph resolver into connection creation', async () => {
    mockGetConnection.mockResolvedValue({ fetchTools: jest.fn().mockResolvedValue([]) });
    const requestBody = { conversationId: 'conv-123', messageId: 'msg-123' };

    await reinitMCPServer({
      user,
      serverName,
      serverConfig: { type: 'streamable-http', url: 'https://thingy.example.com/mcp' },
      requestBody,
      userMCPAuthMap: undefined,
    });

    expect(mockGetConnection).toHaveBeenCalledWith(
      expect.objectContaining({
        requestBody,
        graphTokenResolver: mockGetGraphApiToken,
      }),
    );
  });

  it('forwards the pre-built upstreamTokenProvider closure into connection creation', async () => {
    mockGetConnection.mockResolvedValue({ fetchTools: jest.fn().mockResolvedValue([]) });
    const upstreamTokenProvider = jest.fn().mockResolvedValue(null);

    await reinitMCPServer({
      user,
      serverName,
      serverConfig: { type: 'streamable-http', url: 'https://thingy.example.com/mcp' },
      upstreamTokenProvider,
    });

    expect(mockGetConnection).toHaveBeenCalledWith(
      expect.objectContaining({ upstreamTokenProvider }),
    );
  });

  it('passes request body and Graph resolver into OAuth discovery fallback', async () => {
    mockGetConnection.mockRejectedValue(new Error('OAuth authentication required'));
    mockDiscoverServerTools.mockResolvedValue({ tools: [], oauthRequired: true, oauthUrl: null });
    const requestBody = { conversationId: 'conv-456', messageId: 'msg-456' };

    const result = await reinitMCPServer({
      user,
      serverName,
      serverConfig: { type: 'streamable-http', url: 'https://thingy.example.com/mcp' },
      requestBody,
      userMCPAuthMap: undefined,
    });

    expect(result).toMatchObject({
      success: false,
      failureReason: 'oauth_required',
      oauthRequired: true,
      oauthUrl: null,
    });
    expect(mockDiscoverServerTools).toHaveBeenCalledWith(
      expect.objectContaining({
        requestBody,
        graphTokenResolver: mockGetGraphApiToken,
      }),
    );
  });

  it('disposes ephemeral BODY-scoped connections after loading tools', async () => {
    const dispose = jest.fn().mockResolvedValue(undefined);
    const tools = [{ name: 'search', inputSchema: { type: 'object', properties: {} } }];
    const serverConfig = {
      type: 'streamable-http',
      url: 'https://thingy.example.com/messages/{{LIBRECHAT_BODY_MESSAGEID}}/mcp',
      source: 'yaml',
    };
    mockGetConnection.mockResolvedValue({
      dispose,
      fetchTools: jest.fn().mockResolvedValue(tools),
    });

    await reinitMCPServer({
      user,
      serverName,
      serverConfig,
      requestBody: { messageId: 'msg-789' },
      userMCPAuthMap: undefined,
    });

    expect(dispose).toHaveBeenCalledTimes(1);
    expect(mockUpdateMCPServerTools).toHaveBeenCalledWith(
      expect.objectContaining({
        tools,
        serverConfig,
      }),
    );
  });

  it('proceeds to connect when the server declares no customUserVars', async () => {
    mockGetConnection.mockResolvedValue({ fetchTools: jest.fn().mockResolvedValue([]) });

    await reinitMCPServer({
      user,
      serverName,
      serverConfig: { type: 'streamable-http', url: 'https://thingy.example.com/mcp' },
      userMCPAuthMap: undefined,
    });

    expect(mockGetConnection).toHaveBeenCalledTimes(1);
  });
});

describe('reinitMCPServer — recovery of a server that failed inspection', () => {
  const user = { id: 'user-123' };
  const serverName = 'Recovering';
  const stub = {
    type: 'streamable-http',
    url: 'https://recovering.example.com/mcp',
    source: 'yaml',
    inspectionFailed: true,
  };
  const { getMCPServersRegistry } = require('~/config');

  beforeEach(() => {
    mockUpdateMCPServerTools.mockResolvedValue({});
  });

  it('connects with the recovered config instead of the stub it read', async () => {
    const recovered = {
      type: 'streamable-http',
      url: 'https://recovering.example.com/mcp',
      source: 'yaml',
      requiresOAuth: false,
    };
    const recoverServerConfig = jest.fn().mockResolvedValue(recovered);
    getMCPServersRegistry.mockReturnValueOnce({ recoverServerConfig });
    mockGetConnection.mockResolvedValue({ fetchTools: jest.fn().mockResolvedValue([]) });

    const result = await reinitMCPServer({ user, serverName, serverConfig: stub });

    expect(recoverServerConfig).toHaveBeenCalledWith(serverName, stub, user.id);
    expect(mockGetConnection).toHaveBeenCalledWith(
      expect.objectContaining({ serverName, serverConfig: recovered }),
    );
    expect(result).toMatchObject({ success: true, serverName });
  });

  it('reports the server unreachable without connecting while it cannot be recovered', async () => {
    const recoverServerConfig = jest.fn().mockResolvedValue(undefined);
    getMCPServersRegistry.mockReturnValueOnce({ recoverServerConfig });

    const result = await reinitMCPServer({ user, serverName, serverConfig: stub });

    expect(mockGetConnection).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      availableTools: null,
      success: false,
      message: `MCP server '${serverName}' is still unreachable`,
      failureReason: 'unreachable',
      tools: null,
    });
  });
});

describe('scheduled MCP connection initialization', () => {
  beforeEach(() => jest.clearAllMocks());

  it.each(['consent_revoked', 'rbac_denied', 'credential_rejected'])(
    'retains the bound scheduled identity and %s during catalog initialization',
    async (reason) => {
      const {
        attachScheduledMCPBearer,
        createMCPRequestContext,
        ScheduledMCPBearerError,
      } = require('@librechat/api');
      const identity = {
        scheduleId: 'scheduled',
        ownerId: 'owner',
        tenantId: 'tenant',
        agentId: 'root',
        invocationMode: 'delegated',
      };
      const context = createMCPRequestContext();
      attachScheduledMCPBearer(context, identity);
      const failure = new ScheduledMCPBearerError(reason, 'Files', 'child');
      const receipt = require('~/server/services/Schedules').recordMCPToolAuthFailure;
      mockGetConnection.mockRejectedValueOnce(failure);
      await expect(
        reinitMCPServer({
          user: { id: 'owner', tenantId: 'tenant' },
          serverName: 'Files',
          serverConfig: {
            type: 'streamable-http',
            url: 'https://mcp.example.com',
            source: 'yaml',
            headers: { Authorization: 'Bearer {{LIBRECHAT_OPENID_ACCESS_TOKEN}}' },
          },
          requestScopedConnections: context,
          requestBody: { agent_id: 'untrusted-child' },
          streamId: 'scheduled-conversation',
          jobCreatedAt: 42,
        }),
      ).rejects.toBe(failure);
      expect(receipt).toHaveBeenCalledWith(
        expect.objectContaining({
          identity,
          error: failure,
          streamId: 'scheduled-conversation',
          jobCreatedAt: 42,
        }),
      );
    },
  );

  it.each(['consent_revoked', 'rbac_denied'])(
    'records the real post-connect catalog %s before initialization can return success',
    async (reason) => {
      const {
        createOAuthMCPServer,
      } = require('../../../../packages/api/src/mcp/__tests__/helpers/oauthTestServer');
      const { MongoMemoryServer } = require('mongodb-memory-server');
      const { createModels, createMethods } = require('@librechat/data-schemas');
      const database = new (require('mongoose').Mongoose)();
      const mongo = await MongoMemoryServer.create({ instance: { args: ['--nounixsocket'] } });
      await database.connect(mongo.getUri(), { autoIndex: false });
      createModels(database);
      const methods = createMethods(database);
      const principal = new database.Types.ObjectId();
      const owner = principal.toString();
      const scheduledFor = new Date('2026-10-04T00:00:00.000Z');
      const schedule = await methods.createSchedule({
        id: 'scheduled',
        user: principal,
        tenantId: 'tenant',
        agent_id: 'root',
        name: 'Read',
        prompt: 'Read',
        enabled: true,
        cadence: { frequency: 'daily', hour: 8, minute: 0 },
        timezone: 'UTC',
        target: 'new',
      });
      await methods.reserveStartedRun({
        scheduleId: schedule.id,
        user: principal,
        tenantId: 'tenant',
        scheduledFor,
        conversationId: 'catalog-run',
        capacitySlot: 0,
      });
      const {
        attachScheduledMCPBearer,
        cleanupMCPRequestContext,
        createMCPRequestContext,
        MCPConnection,
        MCPManager,
        MCPServersRegistry,
        ScheduledMCPBearerError,
        GenerationJobManager,
        InMemoryJobStore,
        InMemoryEventTransport,
        createSchedulesService,
      } = require('@librechat/api');
      const store = new InMemoryJobStore({ ttlAfterComplete: 0 });
      GenerationJobManager.configure({
        jobStore: store,
        eventTransport: new InMemoryEventTransport(),
        isRedis: false,
        cleanupOnComplete: true,
      });
      GenerationJobManager.initialize();
      const job = await GenerationJobManager.createJob('catalog-run', owner, 'catalog-run', {
        initialMetadata: {
          scheduleId: schedule.id,
          scheduledFor: scheduledFor.toISOString(),
          agent_id: 'root',
        },
      });
      // Match the authenticated tenant on the generation, as the host does.
      await store.updateJob(job.streamId, { tenantId: 'tenant' }, job.createdAt);
      const service = createSchedulesService({
        methods: {
          ...methods,
          getRoleByName: async () => null,
          getFiles: async () => [],
          extendFilesTTL: async () => 0,
        },
        preflightMCP: async () => [],
        getAppConfig: async () => undefined,
        findUserById: async () => null,
        findBalance: async () => null,
        upsertBalance: async () => null,
        initializeNullBalance: async () => null,
        resolveAgentFireAccess: async () => 'ok',
        getChatProject: async () => null,
        isUserDeleting: async () => false,
        enqueueAgentTrigger: async () => undefined,
        getTriggerDelivery: async () => null,
      });
      const server = await createOAuthMCPServer();
      server.issuedTokens.add('catalog-token');
      server.tokenIssueTimes.set('catalog-token', Date.now());
      const identity = {
        scheduleId: 'scheduled',
        ownerId: owner,
        tenantId: 'tenant',
        agentId: 'root',
        invocationMode: 'delegated',
      };
      const context = createMCPRequestContext();
      const failure = new ScheduledMCPBearerError(reason, 'Files', 'child');
      let denied = false;
      attachScheduledMCPBearer(context, identity, {
        bind: (captured) => ({
          identity: captured,
          reject: () => {},
          resolve: async (input) => {
            if (denied) throw failure;
            return { ...input.config, headers: { Authorization: 'Bearer catalog-token' } };
          },
        }),
      });
      const receipt = require('~/server/services/Schedules').recordMCPToolAuthFailure;
      receipt.mockImplementationOnce((input) => service.recordMCPToolAuthFailure(input));
      const manager = new MCPManager();
      const registry = jest.spyOn(MCPServersRegistry, 'getInstance').mockReturnValue({
        isAppServerConfig: async () => false,
        resolveAllowlists: async () => ({
          allowedDomains: ['127.0.0.1'],
          allowedAddresses: [`127.0.0.1:${server.port}`],
          useSSRFProtection: false,
        }),
      });
      let connection;
      mockGetConnection.mockImplementationOnce(async (options) => {
        connection = await manager.getConnection(options);
        denied = true;
        return connection;
      });
      try {
        await expect(
          reinitMCPServer({
            user: { id: owner, tenantId: 'tenant' },
            serverName: 'Files',
            serverConfig: {
              type: 'streamable-http',
              url: server.url,
              requiresOAuth: false,
              source: 'yaml',
              headers: { Authorization: 'Bearer {{LIBRECHAT_OPENID_ACCESS_TOKEN}}' },
            },
            requestScopedConnections: context,
            requestBody: { agent_id: 'untrusted' },
            streamId: 'catalog-run',
            jobCreatedAt: job.createdAt,
          }),
        ).rejects.toBe(failure);
        expect(connection).toBeDefined();
        expect(denied).toBe(true);
        expect(mockGetConnection).toHaveBeenCalledTimes(1);
        expect(receipt).toHaveBeenCalledTimes(1);
        expect(receipt).toHaveBeenCalledWith(
          expect.objectContaining({
            identity,
            error: failure,
            streamId: 'catalog-run',
            jobCreatedAt: job.createdAt,
          }),
        );
        expect(await methods.getScheduleRunAbortState(schedule.id, scheduledFor)).toMatchObject({
          status: 'started',
          mcp: failure.outcomes,
        });
        await store.updateJob(
          job.streamId,
          { status: 'complete', completedAt: Date.now() },
          job.createdAt,
        );
        await expect(
          service.recordScheduleOutcome({
            scheduleId: schedule.id,
            scheduledFor,
            streamId: job.streamId,
            jobCreatedAt: job.createdAt,
            conversationId: job.streamId,
            status: 'success',
          }),
        ).resolves.toBe(true);
        expect(await methods.getScheduleRunAbortState(schedule.id, scheduledFor)).toMatchObject({
          status: 'error',
          mcp: failure.outcomes,
        });
        expect(await methods.getScheduleById(schedule.id)).toMatchObject({
          enabled: false,
          disabledReason: failure.code,
          lastRun: { status: 'error', mcp: failure.outcomes },
        });
        expect(mockUpdateMCPServerTools).not.toHaveBeenCalled();
        expect(mockDiscoverServerTools).not.toHaveBeenCalled();
      } finally {
        await connection?.dispose();
        await cleanupMCPRequestContext(context);
        await manager.disconnectUserConnections(owner);
        registry.mockRestore();
        MCPConnection.clearCooldown('Files');
        await server.close();
        await GenerationJobManager.destroy();
        await database.disconnect();
        await mongo.stop();
      }
    },
  );

  it('records a typed missing OBO provider before any tool instance exists', async () => {
    const { OboTokenResolutionError } = require('@librechat/api');
    const failure = new OboTokenResolutionError('missing_upstream_provider', 'Provider missing');
    const receipt = require('~/server/services/Schedules').recordMCPToolAuthFailure;
    mockGetConnection.mockRejectedValueOnce(failure);

    await expect(
      reinitMCPServer({
        user: { id: 'owner' },
        serverName: 'Graph',
        serverConfig: {
          type: 'streamable-http',
          url: 'https://mcp.example.com',
          source: 'yaml',
          obo: { scopes: 'api://graph/.default' },
        },
        streamId: 'scheduled-conversation',
        jobCreatedAt: 42,
      }),
    ).rejects.toBe(failure);
    expect(receipt).toHaveBeenCalledTimes(1);
    expect(receipt).toHaveBeenCalledWith({
      error: failure,
      streamId: 'scheduled-conversation',
      jobCreatedAt: 42,
      userId: 'owner',
      serverName: 'Graph',
      identity: undefined,
    });
  });

  it('preserves the connection error when the receipt store fails', async () => {
    const { OboTokenResolutionError } = require('@librechat/api');
    const failure = new OboTokenResolutionError('missing_upstream_provider', 'Provider missing');
    const receipt = require('~/server/services/Schedules').recordMCPToolAuthFailure;
    receipt.mockRejectedValueOnce(new Error('Mongo unavailable'));
    mockGetConnection.mockRejectedValueOnce(failure);

    await expect(
      reinitMCPServer({
        user: { id: 'owner' },
        serverName: 'Graph',
        serverConfig: { type: 'streamable-http', url: 'https://mcp.example.com', source: 'yaml' },
        streamId: 'scheduled-conversation',
        jobCreatedAt: 42,
      }),
    ).rejects.toBe(failure);
  });

  it('does not construct the schedule facade for unrelated typed OBO failures', async () => {
    const { OboTokenResolutionError } = require('@librechat/api');
    const failure = new OboTokenResolutionError('session_refresh_failed', 'Retry later', true);
    const receipt = require('~/server/services/Schedules').recordMCPToolAuthFailure;
    mockGetConnection.mockRejectedValueOnce(failure);
    await expect(
      reinitMCPServer({
        user: { id: 'owner' },
        serverName: 'Graph',
        serverConfig: { type: 'streamable-http', url: 'https://mcp.example.com', source: 'yaml' },
        streamId: 'scheduled-conversation',
        jobCreatedAt: 42,
      }),
    ).rejects.toBe(failure);
    expect(receipt).not.toHaveBeenCalled();
  });
});

describe('reinitMCPServer — direct bearer authentication outcomes', () => {
  it('preserves a typed rejection instead of reducing it to a generic result', async () => {
    const { MCPAuthenticationRejectedError } = require('@librechat/api');
    const rejection = new MCPAuthenticationRejectedError('private-mcp', false);
    mockGetConnection.mockRejectedValue(rejection);

    await expect(
      reinitMCPServer({
        user: { id: 'user-123' },
        serverName: 'private-mcp',
        serverConfig: {
          type: 'streamable-http',
          url: 'https://mcp.example.com',
          source: 'yaml',
          headers: { Authorization: 'Bearer {{LIBRECHAT_OPENID_ACCESS_TOKEN}}' },
        },
      }),
    ).rejects.toBe(rejection);
  });

  it('propagates cancellation instead of hiding the server tool', async () => {
    const abort = new DOMException('Stopped', 'AbortError');
    const controller = new AbortController();
    controller.abort(abort);
    mockGetConnection.mockRejectedValue(abort);
    await expect(
      reinitMCPServer({
        user: { id: 'user-123' },
        serverName: 'example-mcp',
        signal: controller.signal,
        serverConfig: { type: 'streamable-http', url: 'https://mcp.example.com', source: 'yaml' },
      }),
    ).rejects.toBe(abort);
  });

  it.each([false, true])(
    'preserves a typed OBO resolution failure (retryable=%s)',
    async (retryable) => {
      const { OboTokenResolutionError } = require('@librechat/api');
      const rejection = new OboTokenResolutionError(
        'session_refresh_failed',
        'Sign-in expired.',
        retryable,
      );
      mockGetConnection.mockRejectedValue(rejection);

      await expect(
        reinitMCPServer({
          user: { id: 'user-123' },
          serverName: 'private-mcp',
          serverConfig: {
            type: 'streamable-http',
            url: 'https://mcp.example.com',
            source: 'yaml',
            obo: { scopes: 'api://mcp/.default' },
          },
        }),
      ).rejects.toBe(rejection);
    },
  );
});

describe('reinitMCPServer — runtime BODY placeholder pre-check (issue #14074)', () => {
  const user = { id: 'user-123' };
  const serverName = 'Thingy';
  const serverConfig = {
    type: 'streamable-http',
    url: 'https://thingy.example.com/mcp',
    source: 'yaml',
    headers: { 'X-Conversation-Id': '{{LIBRECHAT_BODY_CONVERSATIONID}}' },
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockUpdateMCPServerTools.mockResolvedValue({});
  });

  it('defers connection without failing when body placeholders cannot resolve outside a chat turn', async () => {
    const result = await reinitMCPServer({
      user,
      serverName,
      serverConfig,
      userMCPAuthMap: undefined,
    });

    expect(mockGetConnection).not.toHaveBeenCalled();
    expect(mockDiscoverServerTools).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      availableTools: null,
      success: true,
      connectionDeferred: true,
      tools: null,
      oauthRequired: false,
      serverName,
    });
    expect(result.message).toContain('first use in a chat turn');
  });

  it('treats an empty-string body field as missing', async () => {
    const result = await reinitMCPServer({
      user,
      serverName,
      serverConfig,
      requestBody: { conversationId: '  ' },
      userMCPAuthMap: undefined,
    });

    expect(mockGetConnection).not.toHaveBeenCalled();
    expect(result.success).toBe(true);
  });

  it('connects normally when the request body provides the placeholder fields', async () => {
    mockGetConnection.mockResolvedValue({
      dispose: jest.fn().mockResolvedValue(undefined),
      fetchTools: jest.fn().mockResolvedValue([]),
    });

    const result = await reinitMCPServer({
      user,
      serverName,
      serverConfig,
      requestBody: { conversationId: 'convo-1' },
      userMCPAuthMap: undefined,
    });

    expect(mockGetConnection).toHaveBeenCalledTimes(1);
    expect(result.connectionDeferred).toBeUndefined();
  });

  it('reports missing customUserVars before deferring on body placeholders', async () => {
    const result = await reinitMCPServer({
      user,
      serverName,
      serverConfig: {
        ...serverConfig,
        customUserVars: { THINGY_TOKEN: { title: 'Thingy Access Token' } },
      },
      userMCPAuthMap: undefined,
    });

    expect(result.success).toBe(false);
    expect(result.message).toContain('THINGY_TOKEN');
  });

  it('still treats unrelated connection errors as real failures', async () => {
    mockGetConnection.mockRejectedValue(new Error('ECONNREFUSED'));

    const result = await reinitMCPServer({
      user,
      serverName,
      serverConfig: { type: 'streamable-http', url: 'https://thingy.example.com/mcp' },
      userMCPAuthMap: undefined,
    });

    expect(mockDiscoverServerTools).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
    expect(result.failureReason).toBe('initialization_failed');
    expect(result.message).toBe(`Failed to reinitialize MCP server '${serverName}'`);
  });
});

describe('reinitMCPServer — OAuth attempt lifetime', () => {
  const user = { id: 'user-123' };
  const serverName = 'Thingy';
  const serverConfig = {
    type: 'streamable-http',
    url: 'https://thingy.example.com/mcp',
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockUpdateMCPServerTools.mockResolvedValue({});
  });

  it('returns the expiry supplied when a pending OAuth URL is replayed', async () => {
    const expiresAt = Date.now() + 45_000;
    mockGetConnection.mockImplementation(async ({ oauthStart }) => {
      await oauthStart('https://oauth.example.com/authorize', { expiresAt });
      await oauthStart('https://oauth.example.com/authorize');
      throw new Error('OAuth flow initiated - return early');
    });
    mockDiscoverServerTools.mockResolvedValue({ tools: [], oauthRequired: true, oauthUrl: null });

    const result = await reinitMCPServer({
      user,
      serverName,
      serverConfig,
    });

    expect(result).toMatchObject({
      success: true,
      oauthRequired: true,
      oauthUrl: 'https://oauth.example.com/authorize',
      oauthExpiresAt: expiresAt,
    });
  });
});

describe('reinitMCPServer — log hygiene', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('keeps user-created server and connection details out of discovery logs', async () => {
    const serverName = 'PRIVATE-MCP-SERVER-NAME';
    const privateUrl = 'https://private.example.test/PRIVATE-CONFIG-PATH';
    const privateError = `PRIVATE-CONNECTION-ERROR for ${privateUrl}`;
    const logSpies = ['debug', 'info', 'warn', 'error'].map((level) =>
      jest.spyOn(logger, level).mockImplementation(() => {}),
    );
    mockGetConnection.mockRejectedValue(new Error(privateError));

    const result = await reinitMCPServer({
      user: { id: 'user-123' },
      serverName,
      serverConfig: { type: 'streamable-http', url: privateUrl },
      userMCPAuthMap: undefined,
    });

    const loggedText = logSpies
      .flatMap((spy) => spy.mock.calls)
      .flat()
      .map((value) => String(value))
      .join('\n');

    expect(result.message).toContain(serverName);
    expect(loggedText).not.toContain(serverName);
    expect(loggedText).not.toContain(privateUrl);
    expect(loggedText).not.toContain(privateError);
    expect(logger.error).toHaveBeenCalledWith('[MCP Reinitialize] Error initializing MCP server');
  });
});
