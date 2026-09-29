/**
 * Tests for merging Agent Plugins MCP servers into the configured servers.
 *
 * Plugin packages are third-party data, so a plugin must never displace a server
 * the operator declared in librechat.yaml, and a plugin-controlled server name
 * must never reach a prototype setter.
 */

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

const mockGetDeploymentPluginMcpServers = jest.fn();
const mockRegisterShutdownTask = jest.fn();
const mockSetHandler = jest.fn();

jest.mock('@librechat/api', () => ({
  get getDeploymentPluginMcpServers() {
    return mockGetDeploymentPluginMcpServers;
  },
  get registerShutdownTask() {
    return mockRegisterShutdownTask;
  },
  get setMCPToolsChangedHandler() {
    return mockSetHandler;
  },
  get setMCPToolsChangedGenerationHandler() {
    return mockSetHandler;
  },
  get setMCPToolsChangedGenerationRenewalHandler() {
    return mockSetHandler;
  },
  get setMCPToolsChangedRevisionHandler() {
    return mockSetHandler;
  },
}));

jest.mock('./Config/mcp', () => ({
  getMCPToolsCacheGeneration: jest.fn(),
  renewMCPToolsCacheGeneration: jest.fn(),
  getNextAppToolsPublicationRevision: jest.fn(),
  updateMCPServerTools: jest.fn(),
}));

jest.mock('./MCPAuthorizationFenceRetry', () => ({
  startMCPAuthorizationFenceRetryWorker: jest.fn(),
}));

const mockGetAppConfig = jest.fn();
const mockMergeAppTools = jest.fn();
const mockSyncStaticTools = jest.fn();

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
}));

const mockCreateMCPServersRegistry = jest.fn();
const mockCreateMCPManager = jest.fn();
const mockMCPManagerInstance = {
  getAppToolFunctions: jest.fn(),
  connectAppServers: jest.fn(),
  disconnectAppServers: jest.fn(),
};

jest.mock('~/config', () => ({
  get createMCPServersRegistry() {
    return mockCreateMCPServersRegistry;
  },
  get createMCPManager() {
    return mockCreateMCPManager;
  },
}));

const { logger } = require('@librechat/data-schemas');
const initializeMCPs = require('./initializeMCPs');

const pluginServer = { type: 'streamable-http', url: 'https://plugin.example.com/mcp' };

describe('initializeMCPs plugin server merge', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCreateMCPServersRegistry.mockReturnValue(undefined);
    mockCreateMCPManager.mockResolvedValue(mockMCPManagerInstance);
    mockMCPManagerInstance.getAppToolFunctions.mockResolvedValue({});
    mockMergeAppTools.mockResolvedValue(undefined);
    mockSyncStaticTools.mockResolvedValue(undefined);
    mockMCPManagerInstance.connectAppServers.mockResolvedValue(undefined);
    mockGetDeploymentPluginMcpServers.mockReturnValue({});
  });

  /** Returns the config object the manager was constructed with. */
  function managerConfig() {
    return mockCreateMCPManager.mock.calls[0][0];
  }

  it('adds plugin servers alongside configured ones', async () => {
    mockGetAppConfig.mockResolvedValue({ mcpConfig: { yamlServer: { type: 'stdio' } } });
    mockGetDeploymentPluginMcpServers.mockReturnValue({ pluginServer });

    await initializeMCPs();

    expect(Object.keys(managerConfig()).sort()).toEqual(['pluginServer', 'yamlServer']);
  });

  it('leaves the configured servers untouched when no plugins contribute', async () => {
    const mcpConfig = { yamlServer: { type: 'stdio' } };
    mockGetAppConfig.mockResolvedValue({ mcpConfig });

    await initializeMCPs();

    expect(managerConfig()).toBe(mcpConfig);
  });

  it('never displaces a server declared in librechat.yaml', async () => {
    const configured = { type: 'stdio', command: 'operator-owned' };
    mockGetAppConfig.mockResolvedValue({ mcpConfig: { shared: configured } });
    mockGetDeploymentPluginMcpServers.mockReturnValue({ shared: pluginServer });

    await initializeMCPs();

    expect(managerConfig().shared).toBe(configured);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('conflicts with a configured'),
    );
  });

  it('does not treat an inherited property name as a conflict', async () => {
    mockGetAppConfig.mockResolvedValue({ mcpConfig: {} });
    mockGetDeploymentPluginMcpServers.mockReturnValue({ toString: pluginServer });

    await initializeMCPs();

    expect(Object.hasOwn(managerConfig(), 'toString')).toBe(true);
    expect(managerConfig().toString).toBe(pluginServer);
    expect(logger.warn).not.toHaveBeenCalledWith(expect.stringContaining('conflicts'));
  });

  it('does not pollute the prototype through a plugin server name', async () => {
    mockGetAppConfig.mockResolvedValue({ mcpConfig: {} });
    mockGetDeploymentPluginMcpServers.mockReturnValue({ ['__proto__']: pluginServer });

    await initializeMCPs();

    expect({}.polluted).toBeUndefined();
    expect(Object.getPrototypeOf(managerConfig())).toBe(Object.prototype);
  });

  it('tolerates a null mcpConfig while still adding plugin servers', async () => {
    mockGetAppConfig.mockResolvedValue({ mcpConfig: null });
    mockGetDeploymentPluginMcpServers.mockReturnValue({ pluginServer });

    await initializeMCPs();

    expect(Object.keys(managerConfig())).toEqual(['pluginServer']);
  });
});
