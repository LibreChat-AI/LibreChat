import { logger } from '@librechat/data-schemas';
import type * as t from '~/mcp/types';
import {
  setMCPToolsChangedHandler,
  setMCPToolsChangedRevisionHandler,
  getMCPToolCatalogGeneration,
} from '~/mcp/toolsChanged';
import { STANDARD_MCP_CAPABILITY_PROFILE } from '~/mcp/capabilities';
import { ConnectionsRepository } from '~/mcp/ConnectionsRepository';
import { MCPConnectionFactory } from '~/mcp/MCPConnectionFactory';
import { MCPConnection } from '~/mcp/connection';

// Mock external dependencies
jest.mock('@librechat/data-schemas', () => ({
  logger: {
    debug: jest.fn(),
    error: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
  },
}));

jest.mock('../MCPConnectionFactory', () => ({
  MCPConnectionFactory: {
    create: jest.fn(),
  },
}));

jest.mock('../connection');

// Mock the registry
const mockShouldEnableSSRFProtection = jest.fn().mockReturnValue(false);
const mockGetAllowedDomains = jest.fn().mockReturnValue(null);
const mockGetAllowedAddresses = jest.fn().mockReturnValue(null);
const mockRegistryInstance = {
  getServerConfig: jest.fn(),
  getAllServerConfigs: jest.fn(),
  shouldEnableSSRFProtection: mockShouldEnableSSRFProtection,
  getAllowedDomains: mockGetAllowedDomains,
  getAllowedAddresses: mockGetAllowedAddresses,
  getMCPAppsPolicy: jest.fn().mockReturnValue({ enabled: true, legacyHtmlEnabled: true }),
  resolveAllowlists: jest.fn(async () => ({
    allowedDomains: mockGetAllowedDomains(),
    allowedAddresses: mockGetAllowedAddresses(),
    useSSRFProtection: mockShouldEnableSSRFProtection(),
    mcpApps: { enabled: true, legacyHtmlEnabled: true },
  })),
};

jest.mock('../registry/MCPServersRegistry', () => ({
  MCPServersRegistry: {
    getInstance: () => mockRegistryInstance,
  },
}));

const mockLogger = logger as jest.Mocked<typeof logger>;

// Use mocked registry instance
const mockRegistry = mockRegistryInstance as jest.Mocked<typeof mockRegistryInstance>;

describe('ConnectionsRepository', () => {
  let repository: ConnectionsRepository;
  let mockServerConfigs: Record<string, t.ParsedServerConfig>;
  let mockConnection: jest.Mocked<MCPConnection>;

  beforeEach(() => {
    setMCPToolsChangedHandler(null);
    mockServerConfigs = {
      server1: { url: 'http://localhost:3001', type: 'sse' },
      server2: { command: 'test-command', args: ['--test'], type: 'stdio' },
      server3: { url: 'ws://localhost:8080', type: 'websocket' },
    };

    // Setup mock registry
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    mockRegistry.getServerConfig = jest.fn((serverName: string, ownerId?: string) =>
      Promise.resolve(mockServerConfigs[serverName] || undefined),
    ) as jest.Mock;

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    mockRegistry.getAllServerConfigs = jest.fn((ownerId?: string) =>
      Promise.resolve(mockServerConfigs),
    ) as jest.Mock;

    mockConnection = {
      client: {
        getServerCapabilities: jest.fn().mockReturnValue({ tools: {} }),
      },
      isConnected: jest.fn().mockResolvedValue(true),
      disconnect: jest.fn().mockResolvedValue(undefined),
      dispose: jest.fn().mockResolvedValue(undefined),
      fetchToolsSnapshot: jest.fn().mockResolvedValue({ tools: [], complete: true }),
      reserveToolsPublicationRevision: jest.fn().mockResolvedValue({}),
      refreshToolList: jest.fn().mockResolvedValue(undefined),
      createdAt: Date.now(),
      isStale: jest.fn().mockReturnValue(false),
      /* A real connection is an EventEmitter and the repository subscribes to it. */
      on: jest.fn(),
      removeAllListeners: jest.fn(),
    } as unknown as jest.Mocked<MCPConnection>;

    (MCPConnectionFactory.create as jest.Mock).mockResolvedValue(mockConnection);

    // Create repository with undefined ownerId (app-level)
    repository = new ConnectionsRepository(undefined);

    jest.clearAllMocks();
  });

  afterEach(() => {
    setMCPToolsChangedHandler(null);
    setMCPToolsChangedRevisionHandler(null);
    jest.clearAllMocks();
  });

  describe('has', () => {
    it('should return true for existing server', async () => {
      expect(await repository.has('server1')).toBe(true);
    });

    it('should return false for non-existing server', async () => {
      expect(await repository.has('nonexistent')).toBe(false);
    });
  });

  describe('get', () => {
    it('should return existing connected connection', async () => {
      mockConnection.isConnected.mockResolvedValue(true);
      repository['connections'].set('server1', mockConnection);

      const result = await repository.get('server1');

      expect(result).toBe(mockConnection);
      expect(MCPConnectionFactory.create).not.toHaveBeenCalled();
    });

    it('should create new connection if none exists', async () => {
      const result = await repository.get('server1');

      expect(result).toBe(mockConnection);
      expect(MCPConnectionFactory.create).toHaveBeenCalledWith(
        {
          serverName: 'server1',
          serverConfig: mockServerConfigs.server1,
          useSSRFProtection: false,
          allowedDomains: null,
          allowedAddresses: null,
          dbSourced: false,
          capabilityProfile: STANDARD_MCP_CAPABILITY_PROFILE,
        },
        undefined,
      );
      expect(repository['connections'].get('server1')).toBe(mockConnection);
      expect(mockConnection.fetchToolsSnapshot).toHaveBeenCalledTimes(1);
      expect(mockConnection.refreshToolList).not.toHaveBeenCalled();
    });

    it('creates an operator connection only for the expected current config', async () => {
      const expectedConfig = mockServerConfigs.server1;

      await expect(repository.get('server1', { expectedConfig })).resolves.toBe(mockConnection);

      expect(MCPConnectionFactory.create).toHaveBeenCalledWith(
        expect.objectContaining({ serverConfig: expectedConfig }),
        undefined,
      );
    });

    it('rejects a stale expected config without evicting the current pooled connection', async () => {
      repository['connections'].set('server1', mockConnection);
      const staleConfig = { ...mockServerConfigs.server1, url: 'http://localhost:3999' };

      await expect(repository.get('server1', { expectedConfig: staleConfig })).rejects.toThrow(
        'changed during connection checkout',
      );

      expect(repository.getPooledConnection('server1')).toBe(mockConnection);
      expect(mockConnection.dispose).not.toHaveBeenCalled();
    });

    it('disposes a new connection when the current config changes before publication', async () => {
      let releaseCreation!: () => void;
      let markCreationStarted!: () => void;
      const creationHeld = new Promise<void>((resolve) => {
        releaseCreation = resolve;
      });
      const creationStarted = new Promise<void>((resolve) => {
        markCreationStarted = resolve;
      });
      (MCPConnectionFactory.create as jest.Mock).mockImplementationOnce(async () => {
        markCreationStarted();
        await creationHeld;
        return mockConnection;
      });

      const load = repository.get('server1', { expectedConfig: mockServerConfigs.server1 });
      await creationStarted;
      mockServerConfigs.server1 = { ...mockServerConfigs.server1, url: 'http://localhost:3999' };
      releaseCreation();

      await expect(load).rejects.toThrow('changed during connection checkout');
      expect(mockConnection.dispose).toHaveBeenCalledTimes(1);
      expect(repository.getPooledConnection('server1')).toBeUndefined();
    });

    it('refuses an app connection for a server declaring chat-only headers', async () => {
      mockServerConfigs.server1 = {
        ...mockServerConfigs.server1,
        requestHeaders: { 'X-Workspace': 'workspace-1' },
      } as t.ParsedServerConfig;

      const result = await repository.get('server1');

      /** A shared session would carry these into its own `initialize` and
       *  `tools/list`, which every later catalog read reuses. */
      expect(result).toBeNull();
      expect(MCPConnectionFactory.create).not.toHaveBeenCalled();
    });

    it('still creates a user-owned connection for a server declaring chat-only headers', async () => {
      mockServerConfigs.server1 = {
        ...mockServerConfigs.server1,
        requestHeaders: { 'X-Workspace': 'workspace-1' },
      } as t.ParsedServerConfig;
      const userRepository = new ConnectionsRepository('user-1');

      const result = await userRepository.get('server1');

      expect(result).toBe(mockConnection);
      expect(MCPConnectionFactory.create).toHaveBeenCalledTimes(1);
    });

    it('serializes concurrent creation so only one connection is retained', async () => {
      const [first, second] = await Promise.all([
        repository.get('server1'),
        repository.get('server1'),
      ]);

      expect(first).toBe(mockConnection);
      expect(second).toBe(mockConnection);
      expect(MCPConnectionFactory.create).toHaveBeenCalledTimes(1);
      expect(mockConnection.on).toHaveBeenCalledTimes(1);
    });

    it('awaits initial app tool publication before returning a new connection', async () => {
      let releasePublication: (() => void) | undefined;
      const publication = new Promise<void>((resolve) => {
        releasePublication = resolve;
      });
      const handler = jest.fn(() => publication);
      setMCPToolsChangedHandler(handler);

      let loaded = false;
      const load = repository.get('server1').then((connection) => {
        loaded = true;
        return connection;
      });
      await new Promise((resolve) => setImmediate(resolve));

      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          serverName: 'server1',
          tools: [],
          publicationGeneration: getMCPToolCatalogGeneration(mockServerConfigs.server1),
        }),
      );
      expect(loaded).toBe(false);

      releasePublication?.();
      await expect(load).resolves.toBe(mockConnection);
    });

    /** An app-level write that carries no revision cannot be ordered and is dropped, so the
     * ordering reserved for this snapshot has to reach the publication (#14857). */
    it('publishes the initial app snapshot under the revision it was fetched with', async () => {
      mockConnection.fetchToolsSnapshot.mockResolvedValue({
        tools: [],
        complete: true,
        publicationRevision: '4',
      });
      const handler = jest.fn();
      setMCPToolsChangedHandler(handler);

      await repository.get('server1');

      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({ serverName: 'server1', publicationRevision: '4' }),
      );
    });

    it('reserves ordering for a server that advertises no tools capability', async () => {
      (mockConnection.client.getServerCapabilities as jest.Mock).mockReturnValue({});
      mockConnection.reserveToolsPublicationRevision = jest
        .fn()
        .mockResolvedValue({ publicationRevision: '9' });
      const handler = jest.fn();
      setMCPToolsChangedHandler(handler);

      await repository.get('server1');

      expect(mockConnection.fetchToolsSnapshot).not.toHaveBeenCalled();
      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({ serverName: 'server1', tools: [], publicationRevision: '9' }),
      );
    });

    /** An unordered publication is dropped in silence, so a server left with no way to order
     * its empty catalog has to retry rather than leave the previous one advertised. */
    it('retries an empty catalog it could not reserve ordering for', async () => {
      (mockConnection.client.getServerCapabilities as jest.Mock).mockReturnValue({});
      mockConnection.reserveToolsPublicationRevision = jest
        .fn()
        .mockResolvedValue({ orderingUnavailable: true });
      const handler = jest.fn();
      setMCPToolsChangedHandler(handler);

      await repository.get('server1');

      expect(mockConnection.refreshToolList).toHaveBeenCalledTimes(1);
      expect(handler).not.toHaveBeenCalled();
    });

    it('retries a fetched catalog it could not reserve ordering for', async () => {
      mockConnection.fetchToolsSnapshot.mockResolvedValue({
        tools: [],
        complete: true,
        orderingUnavailable: true,
      });
      const handler = jest.fn();
      setMCPToolsChangedHandler(handler);

      await repository.get('server1');

      expect(mockConnection.refreshToolList).toHaveBeenCalledTimes(1);
      expect(handler).not.toHaveBeenCalled();
    });

    it('can defer the initial app tool refresh for startup synchronization', async () => {
      await repository.get('server1', { refreshTools: false });

      expect(mockConnection.fetchToolsSnapshot).not.toHaveBeenCalled();
      expect(mockConnection.refreshToolList).not.toHaveBeenCalled();
    });

    it('queues the connection retry path when the initial app snapshot is incomplete', async () => {
      mockConnection.fetchToolsSnapshot.mockResolvedValue({ tools: [], complete: false });

      await repository.get('server1');

      expect(mockConnection.refreshToolList).toHaveBeenCalledTimes(1);
    });

    it('does not publish an initial snapshot superseded by a list-changed refresh', async () => {
      let toolsChanged: ((tools: t.MCPTool[]) => void) | undefined;
      mockConnection.on.mockImplementation((event, listener) => {
        if (event === 'toolsChanged') {
          toolsChanged = listener as (tools: t.MCPTool[]) => void;
        }
        return mockConnection;
      });
      let releaseInitialSnapshot:
        | ((snapshot: { tools: t.MCPTool[]; complete: boolean }) => void)
        | undefined;
      mockConnection.fetchToolsSnapshot.mockReturnValue(
        new Promise((resolve) => {
          releaseInitialSnapshot = resolve;
        }),
      );
      const handler = jest.fn().mockResolvedValue(undefined);
      setMCPToolsChangedHandler(handler);

      const load = repository.get('server1');
      await new Promise((resolve) => setImmediate(resolve));
      toolsChanged?.([{ name: 'current', inputSchema: { type: 'object' } } as t.MCPTool]);
      releaseInitialSnapshot?.({
        tools: [{ name: 'stale', inputSchema: { type: 'object' } } as t.MCPTool],
        complete: true,
      });
      await load;

      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({ tools: [expect.objectContaining({ name: 'current' })] }),
      );
      expect(handler).not.toHaveBeenCalledWith(
        expect.objectContaining({ tools: [expect.objectContaining({ name: 'stale' })] }),
      );
    });

    it('publishes an empty snapshot without listing tools when the server lacks the capability', async () => {
      const handler = jest.fn().mockResolvedValue(undefined);
      setMCPToolsChangedHandler(handler);
      (mockConnection.client.getServerCapabilities as jest.Mock).mockReturnValue({ resources: {} });

      await repository.get('server1');

      expect(mockConnection.fetchToolsSnapshot).not.toHaveBeenCalled();
      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({ serverName: 'server1', tools: [] }),
      );
    });

    it('should create new connection if existing connection is not connected', async () => {
      const oldConnection = {
        isConnected: jest.fn().mockResolvedValue(false),
        disconnect: jest.fn().mockResolvedValue(undefined),
        dispose: jest.fn().mockResolvedValue(undefined),
      } as unknown as jest.Mocked<MCPConnection>;
      repository['connections'].set('server1', oldConnection);

      const result = await repository.get('server1');

      expect(result).toBe(mockConnection);
      expect(oldConnection.dispose).toHaveBeenCalled();
      expect(MCPConnectionFactory.create).toHaveBeenCalledWith(
        {
          serverName: 'server1',
          serverConfig: mockServerConfigs.server1,
          useSSRFProtection: false,
          allowedDomains: null,
          allowedAddresses: null,
          dbSourced: false,
          capabilityProfile: STANDARD_MCP_CAPABILITY_PROFILE,
        },
        undefined,
      );
    });

    it('should recreate connection when existing connection is stale', async () => {
      const connectionCreatedAt = Date.now();
      const configCachedAt = connectionCreatedAt + 10000; // Config updated 10 seconds after connection was created

      const staleConnection = {
        isConnected: jest.fn().mockResolvedValue(true),
        disconnect: jest.fn().mockResolvedValue(undefined),
        dispose: jest.fn().mockResolvedValue(undefined),
        createdAt: connectionCreatedAt,
        isStale: jest.fn().mockReturnValue(true),
      } as unknown as jest.Mocked<MCPConnection>;

      // Update server config with updatedAt timestamp
      const configWithCachedAt = {
        ...mockServerConfigs.server1,
        updatedAt: configCachedAt,
      };
      mockRegistry.getServerConfig.mockResolvedValueOnce(configWithCachedAt);

      repository['connections'].set('server1', staleConnection);

      const result = await repository.get('server1');

      // Verify stale check was called with the config's updatedAt timestamp
      expect(staleConnection.isStale).toHaveBeenCalledWith(configCachedAt);

      // Verify old connection was disconnected
      expect(staleConnection.dispose).toHaveBeenCalled();

      // Verify new connection was created
      expect(MCPConnectionFactory.create).toHaveBeenCalledWith(
        {
          serverName: 'server1',
          serverConfig: configWithCachedAt,
          useSSRFProtection: false,
          allowedDomains: null,
          allowedAddresses: null,
          dbSourced: false,
          capabilityProfile: STANDARD_MCP_CAPABILITY_PROFILE,
        },
        undefined,
      );

      // Verify new connection is returned
      expect(result).toBe(mockConnection);

      // Verify the new connection replaced the stale one in the repository
      expect(repository['connections'].get('server1')).toBe(mockConnection);
      expect(repository['connections'].get('server1')).not.toBe(staleConnection);
    });

    it('should return existing connection when it is not stale', async () => {
      const connectionCreatedAt = Date.now();
      const configCachedAt = connectionCreatedAt - 10000; // Config is older than connection

      const freshConnection = {
        isConnected: jest.fn().mockResolvedValue(true),
        disconnect: jest.fn().mockResolvedValue(undefined),
        dispose: jest.fn().mockResolvedValue(undefined),
        createdAt: connectionCreatedAt,
        isStale: jest.fn().mockReturnValue(false),
      } as unknown as jest.Mocked<MCPConnection>;

      // Update server config with updatedAt timestamp
      const configWithCachedAt = {
        ...mockServerConfigs.server1,
        updatedAt: configCachedAt,
      };
      mockRegistry.getServerConfig.mockResolvedValueOnce(configWithCachedAt);

      repository['connections'].set('server1', freshConnection);

      const result = await repository.get('server1');

      // Verify stale check was called
      expect(freshConnection.isStale).toHaveBeenCalledWith(configCachedAt);

      // Verify connection was not disconnected
      expect(freshConnection.dispose).not.toHaveBeenCalled();

      // Verify no new connection was created
      expect(MCPConnectionFactory.create).not.toHaveBeenCalled();

      // Verify existing connection is returned
      expect(result).toBe(freshConnection);

      // Verify repository still has the same connection
      expect(repository['connections'].get('server1')).toBe(freshConnection);
    });

    it('uses the repository cleanup path when a loaded server config is removed', async () => {
      repository['connections'].set('server1', mockConnection);
      delete mockServerConfigs.server1;

      await expect(repository.get('server1')).resolves.toBeNull();

      expect(mockConnection.removeAllListeners).toHaveBeenCalledWith('toolsChanged');
      expect(mockConnection.dispose).toHaveBeenCalled();
      expect(repository['connections'].has('server1')).toBe(false);
    });
    //todo revist later when async getAll(): in packages/api/src/mcp/ConnectionsRepository.ts is refactored
    it.skip('should throw error for non-existent server configuration', async () => {
      await expect(repository.get('nonexistent')).rejects.toThrow(
        '[MCP][nonexistent] Server not found in configuration',
      );
    });

    it('should handle MCPConnectionFactory.create errors', async () => {
      const createError = new Error('Connection creation failed');
      (MCPConnectionFactory.create as jest.Mock).mockRejectedValue(createError);

      await expect(repository.get('server1')).rejects.toThrow('Connection creation failed');
    });
  });

  describe('getMany', () => {
    it('should return connections for multiple servers', async () => {
      const result = await repository.getMany(['server1', 'server3']);

      expect(result).toBeInstanceOf(Map);
      expect(result.size).toBe(2);
      expect(result.get('server1')).toBe(mockConnection);
      expect(result.get('server3')).toBe(mockConnection);
    });
  });

  describe('getLoaded', () => {
    it('should return connections for loaded servers only', async () => {
      // Load one connection
      await repository.get('server1');

      const result = await repository.getLoaded();

      expect(result).toBeInstanceOf(Map);
      expect(result.size).toBe(1);
      expect(result.get('server1')).toBe(mockConnection);
    });

    it('should return empty map when no connections are loaded', async () => {
      const result = await repository.getLoaded();

      expect(result).toBeInstanceOf(Map);
      expect(result.size).toBe(0);
    });
  });

  describe('getAll', () => {
    it('should return connections for all configured servers', async () => {
      const result = await repository.getAll();

      expect(result).toBeInstanceOf(Map);
      expect(result.size).toBe(3);
      expect(result.get('server1')).toBe(mockConnection);
      expect(result.get('server2')).toBe(mockConnection);
      expect(result.get('server3')).toBe(mockConnection);
    });

    it('continues loading later servers when one connection fails', async () => {
      (MCPConnectionFactory.create as jest.Mock).mockImplementation(
        ({ serverName }: { serverName: string }) => {
          if (serverName === 'server1') {
            return Promise.reject(new Error('server unavailable'));
          }
          return Promise.resolve(mockConnection);
        },
      );

      const result = await repository.getAll({ continueOnError: true });

      expect(result.has('server1')).toBe(false);
      expect(result.get('server2')).toBe(mockConnection);
      expect(result.get('server3')).toBe(mockConnection);
      expect(mockLogger.warn).toHaveBeenCalledWith('[MCP] Failed to establish connection');
      expect(JSON.stringify(mockLogger.warn.mock.calls)).not.toContain('server1');
      expect(JSON.stringify(mockLogger.warn.mock.calls)).not.toContain('server unavailable');
    });
  });

  describe('disconnect', () => {
    it('should disconnect and remove existing connection', async () => {
      repository['connections'].set('server1', mockConnection);

      await repository.disconnect('server1');

      expect(mockConnection.dispose).toHaveBeenCalled();
      expect(repository['connections'].has('server1')).toBe(false);
    });

    it('should handle disconnect error gracefully', async () => {
      const disconnectError = new Error('Disconnect failed');
      mockConnection.dispose.mockRejectedValue(disconnectError);
      repository['connections'].set('server1', mockConnection);

      await repository.disconnect('server1');

      expect(mockConnection.dispose).toHaveBeenCalled();
      expect(repository['connections'].has('server1')).toBe(false);
      expect(mockLogger.error).toHaveBeenCalledWith('[MCP] Error disposing');
      expect(JSON.stringify(mockLogger.error.mock.calls)).not.toContain(disconnectError.message);
      expect(JSON.stringify(mockLogger.error.mock.calls)).not.toContain('server1');
    });
  });

  describe('disconnectAll', () => {
    it('should disconnect all active connections', async () => {
      const mockConnection1 = {
        disconnect: jest.fn().mockResolvedValue(undefined),
        dispose: jest.fn().mockResolvedValue(undefined),
      } as unknown as jest.Mocked<MCPConnection>;
      const mockConnection2 = {
        disconnect: jest.fn().mockResolvedValue(undefined),
        dispose: jest.fn().mockResolvedValue(undefined),
      } as unknown as jest.Mocked<MCPConnection>;
      const mockConnection3 = {
        disconnect: jest.fn().mockResolvedValue(undefined),
        dispose: jest.fn().mockResolvedValue(undefined),
      } as unknown as jest.Mocked<MCPConnection>;

      repository['connections'].set('server1', mockConnection1);
      repository['connections'].set('server2', mockConnection2);
      repository['connections'].set('server3', mockConnection3);

      const promises = repository.disconnectAll();

      expect(promises).toHaveLength(1);
      expect(Array.isArray(promises)).toBe(true);
      await Promise.all(promises);
      expect(mockConnection1.dispose).toHaveBeenCalledTimes(1);
      expect(mockConnection2.dispose).toHaveBeenCalledTimes(1);
      expect(mockConnection3.dispose).toHaveBeenCalledTimes(1);
    });

    it('drains and disposes a connection whose creation finishes during shutdown', async () => {
      let releaseCreation: ((connection: MCPConnection) => void) | undefined;
      (MCPConnectionFactory.create as jest.Mock).mockReturnValue(
        new Promise((resolve) => {
          releaseCreation = resolve;
        }),
      );

      const load = repository.get('server1');
      await new Promise((resolve) => setImmediate(resolve));
      const shutdown = Promise.all(repository.disconnectAll());
      releaseCreation?.(mockConnection);

      await expect(load).resolves.toBeNull();
      await shutdown;
      expect(mockConnection.dispose).toHaveBeenCalledTimes(1);
      await expect(repository.get('server1')).resolves.toBeNull();
      expect(MCPConnectionFactory.create).toHaveBeenCalledTimes(1);
    });
  });

  describe('Connection policy (isAllowedToConnectToServer)', () => {
    describe('App-level repository (ownerId = undefined)', () => {
      beforeEach(() => {
        repository = new ConnectionsRepository(undefined);
      });

      it('should allow connection to regular servers (startup !== false, !requiresOAuth)', async () => {
        mockServerConfigs.regularServer = {
          type: 'stdio',
          command: 'test',
          args: [],
          startup: true,
          requiresOAuth: false,
        };

        expect(await repository.has('regularServer')).toBe(true);
      });

      it('should allow connection when startup is undefined and requiresOAuth is false', async () => {
        mockServerConfigs.defaultServer = {
          type: 'stdio',
          command: 'test',
          args: [],
          requiresOAuth: false,
        };

        expect(await repository.has('defaultServer')).toBe(true);
      });

      it('should NOT allow app connections to public user-managed servers', async () => {
        mockServerConfigs.publicServer = {
          type: 'streamable-http',
          url: 'https://public.example.com/mcp',
          source: 'user',
          requiresOAuth: false,
        };

        expect(await repository.has('publicServer')).toBe(false);
      });

      it('should NOT allow connection to OAuth servers', async () => {
        mockServerConfigs.oauthServer = {
          type: 'streamable-http',
          url: 'http://example.com',
          requiresOAuth: true,
        };

        expect(await repository.has('oauthServer')).toBe(false);
      });

      it('should NOT allow connection to disabled servers (startup: false)', async () => {
        mockServerConfigs.disabledServer = {
          type: 'stdio',
          command: 'test',
          args: [],
          startup: false,
          requiresOAuth: false,
        };

        expect(await repository.has('disabledServer')).toBe(false);
      });

      it('should NOT allow connection to OAuth servers that are also disabled', async () => {
        mockServerConfigs.oauthDisabledServer = {
          type: 'streamable-http',
          url: 'http://example.com',
          startup: false,
          requiresOAuth: true,
        };

        expect(await repository.has('oauthDisabledServer')).toBe(false);
      });

      it('should NOT allow connection to servers with customUserVars', async () => {
        mockServerConfigs.customVarServer = {
          type: 'stdio',
          command: 'npx',
          args: ['-y', '@test/mcp-stdio-server'],
          env: { API_KEY: '{{MY_KEY}}' },
          customUserVars: {
            MY_KEY: { title: 'API Key', description: 'Your API key' },
          },
        };

        expect(await repository.has('customVarServer')).toBe(false);
      });

      it('should NOT allow connection when customUserVars is defined, even when startup is explicitly true', async () => {
        mockServerConfigs.customVarStartupServer = {
          type: 'stdio',
          command: 'npx',
          args: ['-y', '@test/mcp-stdio-server'],
          env: { TOKEN: '{{USER_TOKEN}}' },
          startup: true,
          requiresOAuth: false,
          customUserVars: {
            USER_TOKEN: { title: 'Token', description: 'Your token' },
          },
        };

        expect(await repository.has('customVarStartupServer')).toBe(false);
      });

      it('should NOT allow connection to OBO servers', async () => {
        mockServerConfigs.oboServer = {
          type: 'streamable-http',
          url: 'http://example.com',
          obo: {
            scopes: 'api://mcp-server-id/Mcp.Tools.ReadWrite',
          },
        };

        expect(await repository.has('oboServer')).toBe(false);
      });

      it('should disconnect existing connection when server becomes not allowed', async () => {
        // Initially setup as regular server
        mockServerConfigs.changingServer = {
          type: 'stdio',
          command: 'test',
          args: [],
          requiresOAuth: false,
        };

        // Create connection
        const connection = await repository.get('changingServer');
        expect(connection).toBe(mockConnection);
        expect(repository['connections'].has('changingServer')).toBe(true);

        // Change config to require OAuth (app-level can't connect)
        mockServerConfigs.changingServer = {
          type: 'streamable-http',
          url: 'http://example.com',
          requiresOAuth: true,
        };

        // Check if connection is allowed
        const allowed = await repository.has('changingServer');

        expect(allowed).toBe(false);
        expect(mockConnection.dispose).toHaveBeenCalled();
      });
    });

    describe('User-level repository (ownerId = userId)', () => {
      beforeEach(() => {
        repository = new ConnectionsRepository('user123');
      });

      it('should allow connection to regular servers', async () => {
        mockServerConfigs.regularServer = {
          type: 'stdio',
          command: 'test',
          args: [],
          startup: true,
          requiresOAuth: false,
        };

        expect(await repository.has('regularServer')).toBe(true);
      });

      it('should lazily allow user connections to public user-managed servers', async () => {
        mockServerConfigs.publicServer = {
          type: 'streamable-http',
          url: 'https://public.example.com/mcp',
          source: 'user',
          requiresOAuth: false,
        };

        expect(await repository.has('publicServer')).toBe(true);
      });

      it('should allow connection to OAuth servers', async () => {
        mockServerConfigs.oauthServer = {
          type: 'streamable-http',
          url: 'http://example.com',
          requiresOAuth: true,
        };

        expect(await repository.has('oauthServer')).toBe(true);
      });

      it('should allow connection to disabled servers (startup: false)', async () => {
        mockServerConfigs.disabledServer = {
          type: 'stdio',
          command: 'test',
          args: [],
          startup: false,
          requiresOAuth: false,
        };

        expect(await repository.has('disabledServer')).toBe(true);
      });

      it('should allow connection to OAuth servers that are also disabled', async () => {
        mockServerConfigs.oauthDisabledServer = {
          type: 'streamable-http',
          url: 'http://example.com',
          startup: false,
          requiresOAuth: true,
        };

        expect(await repository.has('oauthDisabledServer')).toBe(true);
      });

      it('should allow connection to servers with customUserVars', async () => {
        mockServerConfigs.customVarServer = {
          type: 'stdio',
          command: 'npx',
          args: ['-y', '@test/mcp-stdio-server'],
          env: { API_KEY: '{{MY_KEY}}' },
          customUserVars: {
            MY_KEY: { title: 'API Key', description: 'Your API key' },
          },
        };

        expect(await repository.has('customVarServer')).toBe(true);
      });

      it('should allow connection to OBO servers', async () => {
        mockServerConfigs.oboServer = {
          type: 'streamable-http',
          url: 'http://example.com',
          obo: {
            scopes: 'api://mcp-server-id/Mcp.Tools.ReadWrite',
          },
        };

        expect(await repository.has('oboServer')).toBe(true);
      });

      it('should return null from get() when server config does not exist', async () => {
        const connection = await repository.get('nonexistent');
        expect(connection).toBeNull();
      });
    });
  });
});
