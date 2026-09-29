/**
 * Tests for initializeMCPs.js
 *
 * These tests verify that MCPServersRegistry and MCPManager are ALWAYS initialized,
 * even when no explicitly configured MCP servers exist. This is critical for the
 * "Dynamic MCP Server Management" feature (introduced in `0.8.2-rc1` release) which
 * allows users to add MCP servers via the UI without requiring explicit configuration.
 *
 * Bug fixed: Previously, MCPManager was only initialized when mcpServers existed
 * in librechat.yaml, causing "MCPManager has not been initialized" errors when
 * users tried to create MCP servers via the UI.
 */

// Mock dependencies before imports
jest.mock('mongoose', () => ({
  connection: { readyState: 1 },
}));

jest.mock('@librechat/data-schemas', () => ({
  logger: {
    debug: jest.fn(),
    error: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
  },
}));

// Mock config functions
const mockGetAppConfig = jest.fn();
const mockSyncStaticTools = jest.fn();
const mockMergeAppTools = jest.fn();
const mockInvalidateCachedTools = jest.fn();
const mockStartMCPAuthorizationFenceRetryWorker = jest.fn();

jest.mock('./MCPAuthorizationFenceRetry', () => ({
  get startMCPAuthorizationFenceRetryWorker() {
    return mockStartMCPAuthorizationFenceRetryWorker;
  },
}));

jest.mock('./Config', () => ({
  get getAppConfig() {
    return mockGetAppConfig;
  },
  get mergeAppTools() {
    return mockMergeAppTools;
  },
  get syncStaticTools() {
    return mockSyncStaticTools;
  },
  get invalidateCachedTools() {
    return mockInvalidateCachedTools;
  },
}));

// Mock MCP singletons
const mockCreateMCPServersRegistry = jest.fn();
const mockCreateMCPManager = jest.fn();
const mockMCPManagerInstance = {
  connectAppServers: jest.fn(),
  disconnectAppServers: jest.fn(),
  getAppToolFunctions: jest.fn(),
};

jest.mock('~/config', () => ({
  get createMCPServersRegistry() {
    return mockCreateMCPServersRegistry;
  },
  get createMCPManager() {
    return mockCreateMCPManager;
  },
}));

const mockSetMCPToolsChangedHandler = jest.fn();
const mockSetMCPToolsChangedGenerationHandler = jest.fn();
const mockSetMCPToolsChangedGenerationRenewalHandler = jest.fn();
const mockSetMCPToolsChangedRevisionHandler = jest.fn();
const mockRegisterShutdownTask = jest.fn();
const mockUpdateMCPServerTools = jest.fn();
const mockGetMCPToolsCacheGeneration = jest.fn();
const mockRenewMCPToolsCacheGeneration = jest.fn();
const mockGetNextAppToolsPublicationRevision = jest.fn();
const mockGetDeploymentPluginMcpServers = jest.fn(() => ({}));

jest.mock('@librechat/api', () => ({
  get registerShutdownTask() {
    return mockRegisterShutdownTask;
  },
  get getDeploymentPluginMcpServers() {
    return mockGetDeploymentPluginMcpServers;
  },
  get setMCPToolsChangedHandler() {
    return mockSetMCPToolsChangedHandler;
  },
  get setMCPToolsChangedGenerationHandler() {
    return mockSetMCPToolsChangedGenerationHandler;
  },
  get setMCPToolsChangedGenerationRenewalHandler() {
    return mockSetMCPToolsChangedGenerationRenewalHandler;
  },
  get setMCPToolsChangedRevisionHandler() {
    return mockSetMCPToolsChangedRevisionHandler;
  },
}));

jest.mock('./Config/mcp', () => ({
  get updateMCPServerTools() {
    return mockUpdateMCPServerTools;
  },
  get getMCPToolsCacheGeneration() {
    return mockGetMCPToolsCacheGeneration;
  },
  get renewMCPToolsCacheGeneration() {
    return mockRenewMCPToolsCacheGeneration;
  },
  get getNextAppToolsPublicationRevision() {
    return mockGetNextAppToolsPublicationRevision;
  },
}));

const { logger } = require('@librechat/data-schemas');
const initializeMCPs = require('./initializeMCPs');

describe('initializeMCPs', () => {
  beforeEach(() => {
    jest.clearAllMocks();

    // Default: successful initialization
    mockCreateMCPServersRegistry.mockReturnValue(undefined);
    mockCreateMCPManager.mockResolvedValue(mockMCPManagerInstance);
    mockMCPManagerInstance.getAppToolFunctions.mockResolvedValue({});
    mockMCPManagerInstance.connectAppServers.mockResolvedValue(undefined);
    mockMCPManagerInstance.disconnectAppServers.mockResolvedValue(undefined);
    mockSyncStaticTools.mockResolvedValue(undefined);
    mockMergeAppTools.mockResolvedValue(undefined);
  });

  describe('MCPServersRegistry initialization', () => {
    it('should ALWAYS initialize MCPServersRegistry even without configured servers', async () => {
      mockGetAppConfig.mockResolvedValue({
        mcpConfig: null, // No configured servers
        mcpSettings: { allowedDomains: ['localhost'] },
      });

      await initializeMCPs();

      expect(mockCreateMCPServersRegistry).toHaveBeenCalledTimes(1);
      expect(mockCreateMCPServersRegistry).toHaveBeenCalledWith(
        expect.anything(), // mongoose
        ['localhost'],
        undefined,
        expect.any(Function), // per-request allowlist resolver
      );
    });

    it('should pass allowedDomains from mcpSettings to registry', async () => {
      const allowedDomains = ['localhost', '*.example.com', 'trusted-mcp.com'];
      mockGetAppConfig.mockResolvedValue({
        mcpConfig: null,
        mcpSettings: { allowedDomains },
      });

      await initializeMCPs();

      expect(mockCreateMCPServersRegistry).toHaveBeenCalledWith(
        expect.anything(),
        allowedDomains,
        undefined,
        expect.any(Function),
      );
    });

    it('should handle undefined mcpSettings gracefully', async () => {
      mockGetAppConfig.mockResolvedValue({
        mcpConfig: null,
        // mcpSettings is undefined
      });

      await initializeMCPs();

      expect(mockCreateMCPServersRegistry).toHaveBeenCalledWith(
        expect.anything(),
        undefined,
        undefined,
        expect.any(Function),
      );
    });

    it('wires a per-request resolver that reads the merged (non-baseOnly) config', async () => {
      mockGetAppConfig.mockResolvedValue({
        mcpConfig: null,
        mcpSettings: { allowedDomains: ['yaml.com'] },
      });

      await initializeMCPs();

      const resolver = mockCreateMCPServersRegistry.mock.calls[0][3];
      expect(typeof resolver).toBe('function');

      // The resolver resolves the request's merged allowlists — not the boot YAML base.
      mockGetAppConfig.mockResolvedValue({
        mcpSettings: { allowedDomains: ['merged.com'], allowedAddresses: ['10.0.0.0/8'] },
      });
      const resolved = await resolver({ userId: 'u1', role: 'ADMIN' });

      expect(mockGetAppConfig).toHaveBeenLastCalledWith({ role: 'ADMIN', userId: 'u1' });
      expect(resolved).toEqual({
        allowedDomains: ['merged.com'],
        allowedAddresses: ['10.0.0.0/8'],
      });
    });

    it('should throw and log error if MCPServersRegistry initialization fails', async () => {
      const registryError = new Error('Registry initialization failed');
      mockCreateMCPServersRegistry.mockImplementation(() => {
        throw registryError;
      });
      mockGetAppConfig.mockResolvedValue({ mcpConfig: null });

      await expect(initializeMCPs()).rejects.toThrow('Registry initialization failed');
      expect(logger.error).toHaveBeenCalledWith(
        '[MCP] Failed to initialize MCPServersRegistry:',
        registryError,
      );
    });
  });

  describe('MCPManager initialization', () => {
    it('should ALWAYS initialize MCPManager even without configured servers', async () => {
      mockGetAppConfig.mockResolvedValue({
        mcpConfig: null, // No configured servers
      });

      await initializeMCPs();

      // MCPManager should be created with empty object when no configured servers
      expect(mockCreateMCPManager).toHaveBeenCalledTimes(1);
      expect(mockCreateMCPManager).toHaveBeenCalledWith(
        {},
        {
          catalogRecoveryMaxStateEntries: undefined,
          catalogRecoveryMaxDetachedDiscoveries: undefined,
        },
      );
    });

    it('should initialize MCPManager with configured servers when provided', async () => {
      const mcpServers = {
        'test-server': { type: 'sse', url: 'http://localhost:3001/sse' },
        'local-server': { type: 'stdio', command: 'node', args: ['server.js'] },
      };
      mockGetAppConfig.mockResolvedValue({ mcpConfig: mcpServers });

      await initializeMCPs();

      expect(mockCreateMCPManager).toHaveBeenCalledWith(mcpServers, {
        catalogRecoveryMaxStateEntries: undefined,
        catalogRecoveryMaxDetachedDiscoveries: undefined,
      });
    });

    it('sets process-wide recovery capacity from the base config', async () => {
      mockGetAppConfig.mockResolvedValue({
        mcpConfig: {},
        mcpSettings: {
          catalogRecovery: {
            maxStateEntries: 2500,
            maxDetachedDiscoveries: 8,
            authorizationFenceRetryIntervalMs: 15_000,
            authorizationFenceRetryBatchSize: 250,
            authorizationFenceTimeoutMs: 750,
          },
        },
      });

      await initializeMCPs();

      expect(mockCreateMCPManager).toHaveBeenCalledWith(
        {},
        {
          catalogRecoveryMaxStateEntries: 2500,
          catalogRecoveryMaxDetachedDiscoveries: 8,
        },
      );
      expect(mockStartMCPAuthorizationFenceRetryWorker).toHaveBeenCalledWith(
        mockInvalidateCachedTools,
        { intervalMs: 15_000, batchSize: 250, attemptTimeoutMs: 750 },
      );
    });

    it('should register app connections for graceful shutdown', async () => {
      mockGetAppConfig.mockResolvedValue({ mcpConfig: null });

      await initializeMCPs();

      expect(mockRegisterShutdownTask).toHaveBeenCalledWith(
        'MCP app connections',
        expect.any(Function),
      );
      const shutdown = mockRegisterShutdownTask.mock.calls[0][1];
      await shutdown();
      expect(mockMCPManagerInstance.disconnectAppServers).toHaveBeenCalledTimes(1);
    });

    it('should wire app publication revision allocation into the cache store', async () => {
      mockGetAppConfig.mockResolvedValue({ mcpConfig: null });
      mockGetNextAppToolsPublicationRevision.mockResolvedValue('9');

      await initializeMCPs();

      const allocateRevision = mockSetMCPToolsChangedRevisionHandler.mock.calls[0][0];
      await expect(
        allocateRevision({ serverName: 'dynamic', configGeneration: 'config-generation' }),
      ).resolves.toBe('9');
      expect(mockGetNextAppToolsPublicationRevision).toHaveBeenCalledWith(
        'dynamic',
        'config-generation',
      );
    });

    it('should throw and log error if MCPManager initialization fails', async () => {
      const managerError = new Error('Manager initialization failed');
      mockCreateMCPManager.mockRejectedValue(managerError);
      mockGetAppConfig.mockResolvedValue({ mcpConfig: null });

      await expect(initializeMCPs()).rejects.toThrow('Manager initialization failed');
      expect(logger.error).toHaveBeenCalledWith(
        '[MCP] Failed to initialize MCPManager:',
        managerError,
      );
    });
  });

  describe('Tool merging behavior', () => {
    it('should skip app catalog discovery when no configured servers exist', async () => {
      mockGetAppConfig.mockResolvedValue({
        mcpConfig: null, // No configured servers
        availableTools: { builtin: { type: 'function' } },
      });

      await initializeMCPs();

      expect(mockMCPManagerInstance.getAppToolFunctions).not.toHaveBeenCalled();
      expect(mockMergeAppTools).not.toHaveBeenCalled();
      expect(mockSyncStaticTools).toHaveBeenCalledWith({ builtin: { type: 'function' } });
      expect(mockMCPManagerInstance.connectAppServers).not.toHaveBeenCalled();
      expect(logger.debug).toHaveBeenCalledWith(
        '[MCP] No servers configured. MCPManager ready for UI-based servers.',
      );
    });

    it('should skip app catalog discovery when mcpConfig is empty', async () => {
      mockGetAppConfig.mockResolvedValue({
        mcpConfig: {}, // Empty object
      });

      await initializeMCPs();

      expect(mockMCPManagerInstance.getAppToolFunctions).not.toHaveBeenCalled();
      expect(mockMergeAppTools).not.toHaveBeenCalled();
      expect(mockSyncStaticTools).toHaveBeenCalledWith({});
      expect(mockMCPManagerInstance.connectAppServers).not.toHaveBeenCalled();
      expect(logger.debug).toHaveBeenCalledWith(
        '[MCP] No servers configured. MCPManager ready for UI-based servers.',
      );
    });

    it('should merge tools when configured servers exist', async () => {
      const mcpServers = {
        'test-server': { type: 'sse', url: 'http://localhost:3001/sse' },
      };
      const mcpTools = {
        tool1: jest.fn(),
        tool2: jest.fn(),
      };
      mockGetAppConfig.mockResolvedValue({ mcpConfig: mcpServers });
      mockMCPManagerInstance.getAppToolFunctions.mockResolvedValue(mcpTools);

      await initializeMCPs();

      expect(mockMCPManagerInstance.getAppToolFunctions).toHaveBeenCalledTimes(1);
      expect(mockMergeAppTools).toHaveBeenCalledWith(mcpTools, {});
      expect(mockMCPManagerInstance.connectAppServers).toHaveBeenCalledTimes(1);
      expect(mockMergeAppTools.mock.invocationCallOrder[0]).toBeLessThan(
        mockMCPManagerInstance.connectAppServers.mock.invocationCallOrder[0],
      );
      expect(logger.info).toHaveBeenCalledWith(
        '[MCP] Initialized with 1 configured server and 2 tools.',
      );
    });

    it('should handle null return from getAppToolFunctions', async () => {
      const mcpServers = { 'test-server': { type: 'sse', url: 'http://localhost:3001' } };
      mockGetAppConfig.mockResolvedValue({ mcpConfig: mcpServers });
      mockMCPManagerInstance.getAppToolFunctions.mockResolvedValue(null);

      await initializeMCPs();

      // Should use empty object fallback
      expect(mockMergeAppTools).toHaveBeenCalledWith({}, {});
      expect(logger.info).toHaveBeenCalledWith(
        '[MCP] Initialized with 1 configured server and 0 tools.',
      );
    });

    it('should connect app servers when startup cache synchronization fails', async () => {
      const mcpServers = { 'test-server': { type: 'sse', url: 'http://localhost:3001' } };
      mockGetAppConfig.mockResolvedValue({ mcpConfig: mcpServers });
      mockMergeAppTools.mockRejectedValueOnce(new Error('cache lock timed out'));

      await expect(initializeMCPs()).rejects.toThrow('cache lock timed out');

      expect(mockMCPManagerInstance.connectAppServers).toHaveBeenCalledTimes(1);
    });
  });

  describe('Initialization order', () => {
    it('should initialize Registry before Manager', async () => {
      const callOrder = [];

      mockCreateMCPServersRegistry.mockImplementation(() => {
        callOrder.push('registry');
      });
      mockCreateMCPManager.mockImplementation(async () => {
        callOrder.push('manager');
        return mockMCPManagerInstance;
      });
      mockGetAppConfig.mockResolvedValue({ mcpConfig: null });

      await initializeMCPs();

      expect(callOrder).toEqual(['registry', 'manager']);
    });

    it('should not attempt MCPManager initialization if Registry fails', async () => {
      mockCreateMCPServersRegistry.mockImplementation(() => {
        throw new Error('Registry failed');
      });
      mockGetAppConfig.mockResolvedValue({ mcpConfig: null });

      await expect(initializeMCPs()).rejects.toThrow('Registry failed');
      expect(mockCreateMCPManager).not.toHaveBeenCalled();
    });
  });

  describe('UI-based MCP server management support', () => {
    /**
     * This test documents the critical fix:
     * MCPManager must be initialized even without configured servers to support
     * the "Dynamic MCP Server Management" feature where users create
     * MCP servers via the UI.
     */
    it('should support UI-based server creation without explicit configuration', async () => {
      // Scenario: User has no MCP servers in librechat.yaml but wants to
      // add servers via the UI
      mockGetAppConfig.mockResolvedValue({
        mcpConfig: null,
        mcpSettings: undefined,
      });

      await initializeMCPs();

      // Both singletons must be initialized for UI-based management to work
      expect(mockCreateMCPServersRegistry).toHaveBeenCalledTimes(1);
      expect(mockCreateMCPManager).toHaveBeenCalledTimes(1);

      // Verify manager was created with empty config (not null/undefined)
      expect(mockCreateMCPManager).toHaveBeenCalledWith(
        {},
        {
          catalogRecoveryMaxStateEntries: undefined,
          catalogRecoveryMaxDetachedDiscoveries: undefined,
        },
      );
    });
  });
});

describe('refreshChangedServerTools', () => {
  const { refreshChangedServerTools } = require('./initializeMCPs');
  const event = {
    serverName: 'dynamic',
    serverConfig: { type: 'streamable-http', url: 'https://mcp.example.com' },
    tools: [{ name: 'tool', inputSchema: { type: 'object' } }],
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('publishes the complete refreshed snapshot in its original cache scope', async () => {
    await refreshChangedServerTools({ ...event, userId: 'user-1' });

    expect(mockUpdateMCPServerTools).toHaveBeenCalledWith({ ...event, userId: 'user-1' });
    expect(logger.info).toHaveBeenCalledWith(
      '[MCP][dynamic] Tool list changed; refreshed 1 tool for user user-1',
    );
  });

  it('publishes an empty app-level snapshot so removals take effect', async () => {
    await refreshChangedServerTools({ ...event, tools: [] });

    expect(mockUpdateMCPServerTools).toHaveBeenCalledWith({ ...event, tools: [] });
  });

  it('is registered as the tools-changed handler during initialization', async () => {
    mockGetAppConfig.mockResolvedValue({ mcpConfig: null, mcpSettings: {} });

    await initializeMCPs();

    expect(mockSetMCPToolsChangedHandler).toHaveBeenCalledWith(refreshChangedServerTools);
    expect(mockSetMCPToolsChangedGenerationHandler).toHaveBeenCalledWith(
      mockGetMCPToolsCacheGeneration,
    );
    expect(mockSetMCPToolsChangedGenerationRenewalHandler).toHaveBeenCalledWith(
      mockRenewMCPToolsCacheGeneration,
    );
  });
});
