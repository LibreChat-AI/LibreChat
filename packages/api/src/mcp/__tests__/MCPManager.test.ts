import { EventEmitter } from 'events';
import { logger } from '@librechat/data-schemas';
import {
  CallToolResultSchema,
  ReadResourceResultSchema,
  ListResourcesResultSchema,
  ListResourceTemplatesResultSchema,
  McpError,
  ErrorCode,
} from '@modelcontextprotocol/sdk/types.js';
import type { TMCPAppsPolicy } from 'librechat-data-provider';
import type { IUser } from '@librechat/data-schemas';
import type { GraphTokenResolver } from '~/utils/graph';
import type * as t from '~/mcp/types';
import {
  getMCPConnectionPoolKey,
  getMCPUserConnectionPoolKey,
  MCP_APPS_CAPABILITY_PROFILE,
  STANDARD_MCP_CAPABILITY_PROFILE,
} from '~/mcp/capabilities';
import { OboTokenResolutionError, detectOAuthRequirement, resolveOboToken } from '~/mcp/oauth';
import { executionFixture, readTool } from '~/schedules/authorization/execution.helper';
import { createMCPRequestContext, cleanupMCPRequestContext } from '~/mcp/request';
import { MCPServersInitializer } from '~/mcp/registry/MCPServersInitializer';
import { MCPServerInspector } from '~/mcp/registry/MCPServerInspector';
import { ConnectionsRepository } from '~/mcp/ConnectionsRepository';
import { MCPConnectionFactory } from '~/mcp/MCPConnectionFactory';
import { MCPAuthenticationRejectedError } from '~/mcp/errors';
import { OpenIDReauthRequiredError } from '~/utils/oidc';
import { isMCPDomainAllowed } from '~/auth/domain';
import * as toolsChanged from '~/mcp/toolsChanged';
import { MCPConnection } from '~/mcp/connection';
import { MCPManager } from '~/mcp/MCPManager';
import * as graphUtils from '~/utils/graph';
import { processMCPEnv } from '~/utils/env';

// Mock external dependencies
jest.mock('@librechat/data-schemas', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

jest.mock('~/utils/graph', () => ({
  ...jest.requireActual('~/utils/graph'),
  preProcessGraphTokens: jest.fn(),
}));

jest.mock('~/mcp/oauth', () => ({
  ...jest.requireActual('~/mcp/oauth'),
  detectOAuthRequirement: jest.fn(),
  resolveOboToken: jest.fn(),
}));

/** Only `processMCPEnv` is a deliberate seam — the cases below drive it to hand
 *  the manager a specific processed config. Everything else stays real:
 *  `~/mcp/utils` reads `ALLOWED_BODY_FIELDS` from here at module scope, so a
 *  replacing factory breaks the suite at import time. */
jest.mock('~/utils/env', () => ({
  ...jest.requireActual('~/utils/env'),
  processMCPEnv: jest.fn((params) => params.options),
}));

jest.mock('~/auth/domain', () => ({
  isMCPDomainAllowed: jest.fn().mockResolvedValue(true),
}));

const fakeClient = (
  request: jest.Mock,
  capabilities: object | null = { resources: {}, tools: {} },
) =>
  ({
    request,
    getServerCapabilities: () => capabilities ?? undefined,
    readResource: (params: unknown, options?: unknown) =>
      request({ method: 'resources/read', params }, ReadResourceResultSchema, options),
    listResources: (params: unknown, options?: unknown) =>
      request(
        { method: 'resources/list', params: params ?? {} },
        ListResourcesResultSchema,
        options,
      ),
    listResourceTemplates: (params: unknown, options?: unknown) =>
      request(
        { method: 'resources/templates/list', params: params ?? {} },
        ListResourceTemplatesResultSchema,
        options,
      ),
    callTool: (params: unknown, resultSchema?: unknown, options?: unknown) =>
      request({ method: 'tools/call', params }, resultSchema ?? CallToolResultSchema, options),
  }) as unknown as MCPConnection['client'];

const mockShouldEnableSSRFProtection = jest.fn().mockReturnValue(false);
const mockGetAllowedDomains = jest.fn().mockReturnValue(null);
const mockGetAllowedAddresses = jest.fn().mockReturnValue(null);
const mockRegistryInstance = {
  getServerConfig: jest.fn(),
  isAppServerConfig: jest.fn(),
  getAllServerConfigs: jest.fn(),
  getOAuthServers: jest.fn(),
  shouldEnableSSRFProtection: mockShouldEnableSSRFProtection,
  getAllowedDomains: mockGetAllowedDomains,
  getAllowedAddresses: mockGetAllowedAddresses,
  getMCPAppsPolicy: jest.fn().mockReturnValue({ enabled: true, legacyHtmlEnabled: true }),
  // Mirrors the real per-request resolver by reading the base-allowlist mocks above, so
  // existing tests that override getAllowedDomains/shouldEnableSSRFProtection still apply.
  resolveAllowlists: jest.fn(async () => ({
    allowedDomains: mockGetAllowedDomains(),
    allowedAddresses: mockGetAllowedAddresses(),
    useSSRFProtection: mockShouldEnableSSRFProtection(),
    mcpApps: { enabled: true, legacyHtmlEnabled: true } as TMCPAppsPolicy,
  })),
};

jest.mock('~/mcp/registry/MCPServersRegistry', () => ({
  MCPServersRegistry: {
    getInstance: () => mockRegistryInstance,
  },
}));

jest.mock('~/mcp/registry/MCPServersInitializer', () => ({
  MCPServersInitializer: {
    initialize: jest.fn(),
  },
}));

jest.mock('~/mcp/registry/MCPServerInspector');
jest.mock('~/mcp/ConnectionsRepository');
jest.mock('~/mcp/MCPConnectionFactory');

const mockLogger = logger as jest.Mocked<typeof logger>;
const mockResolveOboToken = resolveOboToken as jest.MockedFunction<typeof resolveOboToken>;
const mockDetectOAuthRequirement = detectOAuthRequirement as jest.MockedFunction<
  typeof detectOAuthRequirement
>;
const mockProcessMCPEnv = processMCPEnv as jest.MockedFunction<typeof processMCPEnv>;
const mockIsMCPDomainAllowed = isMCPDomainAllowed as jest.MockedFunction<typeof isMCPDomainAllowed>;

describe('MCPManager', () => {
  const userId = 'test-user-123';
  const serverName = 'test_server';

  beforeEach(() => {
    // Reset MCPManager singleton state
    (MCPManager as unknown as { instance: null }).instance = null;
    jest.clearAllMocks();

    // Set up default mock implementations
    (MCPServersInitializer.initialize as jest.Mock).mockResolvedValue(undefined);
    (mockRegistryInstance.getAllServerConfigs as jest.Mock).mockResolvedValue({});
    (mockRegistryInstance.getServerConfig as jest.Mock).mockResolvedValue({
      type: 'stdio',
      command: 'test',
      args: [],
      source: 'yaml',
    });
    (mockRegistryInstance.isAppServerConfig as jest.Mock).mockResolvedValue(true);
    (mockRegistryInstance.shouldEnableSSRFProtection as jest.Mock).mockReturnValue(false);
    (mockRegistryInstance.getAllowedDomains as jest.Mock).mockReturnValue(null);
    (mockRegistryInstance.getAllowedAddresses as jest.Mock).mockReturnValue(null);
    mockProcessMCPEnv.mockImplementation((params) => params.options);
    jest.mocked(graphUtils.preProcessGraphTokens).mockImplementation(async (config) => config);
    mockIsMCPDomainAllowed.mockResolvedValue(true);
    mockDetectOAuthRequirement.mockResolvedValue({
      requiresOAuth: false,
      method: 'no-metadata-found',
    });
  });

  function mockAppConnections(
    appConnectionsConfig: Partial<ConnectionsRepository>,
  ): jest.MockedClass<typeof ConnectionsRepository> {
    const mock = {
      has: jest.fn().mockResolvedValue(false),
      get: jest.fn().mockResolvedValue({} as unknown as MCPConnection),
      getPooledConnection: jest.fn().mockReturnValue(undefined),
      getAll: jest.fn().mockResolvedValue(new Map()),
      getMany: jest.fn().mockResolvedValue(new Map()),
      ...appConnectionsConfig,
    };
    return (
      ConnectionsRepository as jest.MockedClass<typeof ConnectionsRepository>
    ).mockImplementation(() => mock as unknown as ConnectionsRepository);
  }

  function newMCPServersConfig(serverNameOverride?: string): t.MCPServers {
    return {
      [serverNameOverride ?? serverName]: {
        type: 'stdio',
        command: 'test',
        args: [],
      },
    };
  }

  describe('getAppToolFunctions', () => {
    it('exposes shared operator sessions only to the standard profile', async () => {
      const loaded = new Map([['shared', {} as MCPConnection]]);
      const getLoaded = jest.fn().mockResolvedValue(loaded);
      mockAppConnections({ getLoaded });

      const manager = await MCPManager.createInstance(newMCPServersConfig());

      await expect(manager.getLoadedAppConnections(STANDARD_MCP_CAPABILITY_PROFILE)).resolves.toBe(
        loaded,
      );
      await expect(manager.getLoadedAppConnections(MCP_APPS_CAPABILITY_PROFILE)).resolves.toEqual(
        new Map(),
      );
      expect(getLoaded).toHaveBeenCalledTimes(1);
    });

    it('should return empty object when no servers have tool functions', async () => {
      (mockRegistryInstance.getAllServerConfigs as jest.Mock).mockResolvedValue({
        server1: { type: 'stdio', command: 'test', args: [] },
        server2: { type: 'stdio', command: 'test2', args: [] },
      });

      const manager = await MCPManager.createInstance(newMCPServersConfig());
      const result = await manager.getAppToolFunctions();

      expect(result).toEqual({});
    });

    it('does not open live connections while collecting the startup snapshot', async () => {
      const getAll = jest.fn().mockResolvedValue(new Map());
      mockAppConnections({ getAll });
      (mockRegistryInstance.getAllServerConfigs as jest.Mock).mockResolvedValue({});

      const manager = await MCPManager.createInstance(newMCPServersConfig());
      await manager.getAppToolFunctions();

      expect(getAll).not.toHaveBeenCalled();
    });

    it('should collect tool functions from multiple servers', async () => {
      const toolFunctions1 = {
        tool1_mcp_server1: {
          type: 'function' as const,
          function: {
            name: 'tool1_mcp_server1',
            description: 'Tool 1',
            parameters: { type: 'object' as const },
          },
        },
      };

      const toolFunctions2 = {
        tool2_mcp_server2: {
          type: 'function' as const,
          function: {
            name: 'tool2_mcp_server2',
            description: 'Tool 2',
            parameters: { type: 'object' as const },
          },
        },
      };

      (mockRegistryInstance.getAllServerConfigs as jest.Mock).mockResolvedValue({
        server1: {
          type: 'stdio',
          command: 'test',
          args: [],
          toolFunctions: toolFunctions1,
        },
        server2: {
          type: 'stdio',
          command: 'test2',
          args: [],
          toolFunctions: toolFunctions2,
        },
      });

      const manager = await MCPManager.createInstance(newMCPServersConfig());
      const result = await manager.getAppToolFunctions();

      expect(result).toEqual({
        ...toolFunctions1,
        ...toolFunctions2,
      });
    });

    it('should handle servers with null or undefined toolFunctions', async () => {
      const toolFunctions1 = {
        tool1_mcp_server1: {
          type: 'function' as const,
          function: {
            name: 'tool1_mcp_server1',
            description: 'Tool 1',
            parameters: { type: 'object' as const },
          },
        },
      };

      (mockRegistryInstance.getAllServerConfigs as jest.Mock).mockResolvedValue({
        server1: {
          type: 'stdio',
          command: 'test',
          args: [],
          toolFunctions: toolFunctions1,
        },
        server2: {
          type: 'stdio',
          command: 'test2',
          args: [],
          toolFunctions: null,
        },
        server3: {
          type: 'stdio',
          command: 'test3',
          args: [],
        },
      });

      const manager = await MCPManager.createInstance(newMCPServersConfig());
      const result = await manager.getAppToolFunctions();

      expect(result).toEqual(toolFunctions1);
    });

    it('excludes public user-managed servers from the app catalog', async () => {
      const operatorKey = 'operator_tool_mcp_operator';
      const publicKey = 'public_tool_mcp_public';
      (mockRegistryInstance.getAllServerConfigs as jest.Mock).mockResolvedValue({
        operator: {
          type: 'stdio',
          command: 'operator',
          source: 'yaml',
          toolFunctions: {
            [operatorKey]: { type: 'function', function: { name: operatorKey } },
          },
        },
        public: {
          type: 'streamable-http',
          url: 'https://public.example.com/mcp',
          source: 'user',
          toolFunctions: {
            [publicKey]: { type: 'function', function: { name: publicKey } },
          },
        },
      });

      const manager = await MCPManager.createInstance(newMCPServersConfig());

      await expect(manager.getAppToolFunctions()).resolves.toEqual({
        [operatorKey]: { type: 'function', function: { name: operatorKey } },
      });
    });
  });

  describe('withUserConnectionLease', () => {
    it('retains a public checkout until its metadata read completes', async () => {
      const connection = {} as MCPConnection;
      let finishRead: (() => void) | undefined;
      const read = new Promise<void>((resolve) => {
        finishRead = resolve;
      });
      mockAppConnections({});
      const manager = await MCPManager.createInstance(newMCPServersConfig());
      jest.spyOn(manager, 'getUserConnection').mockResolvedValue(connection);
      const lifecycle = manager as unknown as {
        waitForConnectionBorrowersToDrain: (connection: MCPConnection) => Promise<void>;
      };

      const checkout = manager.withUserConnectionLease(
        { serverName, user: { id: userId } as IUser },
        async () => {
          await read;
          return 'snapshot';
        },
      );
      await new Promise((resolve) => setImmediate(resolve));

      let drained = false;
      const drain = lifecycle.waitForConnectionBorrowersToDrain(connection).then(() => {
        drained = true;
      });
      await new Promise((resolve) => setImmediate(resolve));
      expect(drained).toBe(false);

      finishRead?.();
      await expect(checkout).resolves.toBe('snapshot');
      await drain;
      expect(drained).toBe(true);
    });

    it('rejoins recovery registered between public checkout and lease acquisition', async () => {
      const staleConnection = {} as MCPConnection;
      const recoveredConnection = {} as MCPConnection;
      let finishCheckout: ((connection: MCPConnection) => void) | undefined;
      const checkout = new Promise<MCPConnection>((resolve) => {
        finishCheckout = resolve;
      });
      let finishRecovery: (() => void) | undefined;
      const recovery = new Promise<void>((resolve) => {
        finishRecovery = resolve;
      });
      mockAppConnections({});
      const manager = await MCPManager.createInstance(newMCPServersConfig());
      jest
        .spyOn(manager, 'getUserConnection')
        .mockReturnValueOnce(checkout)
        .mockResolvedValue(recoveredConnection);
      const internals = manager as unknown as {
        oauthRecoveries: WeakMap<MCPConnection, { promise: Promise<void> }>;
      };
      const operation = jest.fn().mockResolvedValue('snapshot');

      const result = manager.withUserConnectionLease(
        { serverName, user: { id: userId } as IUser },
        operation,
      );
      finishCheckout?.(staleConnection);
      internals.oauthRecoveries.set(staleConnection, { promise: recovery });
      await new Promise((resolve) => setImmediate(resolve));

      expect(operation).not.toHaveBeenCalled();

      internals.oauthRecoveries.delete(staleConnection);
      finishRecovery?.();

      await expect(result).resolves.toBe('snapshot');
      expect(operation).toHaveBeenCalledWith(recoveredConnection);
    });
  });

  describe('connectAppServers', () => {
    it('opens only operator app connections and refreshes their current catalogs', async () => {
      const connection = new MCPConnection({
        serverName: 'dynamic',
        serverConfig: { type: 'streamable-http', url: 'http://localhost/mcp' },
        useSSRFProtection: false,
      });
      const refreshToolList = jest
        .spyOn(connection, 'refreshToolList')
        .mockResolvedValue(undefined);
      const getMany = jest.fn().mockResolvedValue(new Map([['dynamic', connection]]));
      mockAppConnections({ getMany });
      (mockRegistryInstance.getAllServerConfigs as jest.Mock).mockResolvedValue({
        dynamic: {
          type: 'streamable-http',
          url: 'http://localhost/mcp',
          source: 'yaml',
        },
        public: {
          type: 'streamable-http',
          url: 'https://public.example.com/mcp',
          source: 'user',
        },
      });

      const manager = await MCPManager.createInstance(newMCPServersConfig());
      await manager.connectAppServers();

      expect(getMany).toHaveBeenCalledWith(['dynamic'], {
        continueOnError: true,
        refreshTools: false,
      });
      expect(refreshToolList).toHaveBeenCalledTimes(1);
    });
  });

  describe('disconnectAppServers', () => {
    it('waits for every loaded app connection to disconnect', async () => {
      const disconnectAll = jest.fn().mockReturnValue([Promise.resolve(), Promise.resolve()]);
      mockAppConnections({ disconnectAll });

      const manager = await MCPManager.createInstance(newMCPServersConfig());
      await manager.disconnectAppServers();

      expect(disconnectAll).toHaveBeenCalledTimes(1);
    });
  });

  describe('formatInstructionsForContext', () => {
    it('should return empty string when no servers have instructions', async () => {
      (mockRegistryInstance.getAllServerConfigs as jest.Mock).mockResolvedValue({
        server1: { type: 'stdio', command: 'test', args: [] },
        server2: { type: 'stdio', command: 'test2', args: [] },
      });

      const manager = await MCPManager.createInstance(newMCPServersConfig());
      const result = await manager.formatInstructionsForContext();

      expect(result).toBe('');
    });

    it('should format instructions from multiple servers', async () => {
      (mockRegistryInstance.getAllServerConfigs as jest.Mock).mockResolvedValue({
        github: {
          type: 'sse',
          url: 'https://api.github.com',
          serverInstructions: 'Use GitHub API with care',
        },
        files: {
          type: 'stdio',
          command: 'node',
          args: ['files.js'],
          serverInstructions: 'Only read/write files in allowed directories',
        },
      });

      const manager = await MCPManager.createInstance(newMCPServersConfig());
      const result = await manager.formatInstructionsForContext();

      expect(result).toContain('# MCP Server Instructions');
      expect(result).toContain('## github MCP Server Instructions');
      expect(result).toContain('Use GitHub API with care');
      expect(result).toContain('## files MCP Server Instructions');
      expect(result).toContain('Only read/write files in allowed directories');
    });

    it('should filter instructions by server names when provided', async () => {
      (mockRegistryInstance.getAllServerConfigs as jest.Mock).mockResolvedValue({
        github: {
          type: 'sse',
          url: 'https://api.github.com',
          serverInstructions: 'Use GitHub API with care',
        },
        files: {
          type: 'stdio',
          command: 'node',
          args: ['files.js'],
          serverInstructions: 'Only read/write files in allowed directories',
        },
        database: {
          type: 'stdio',
          command: 'node',
          args: ['db.js'],
          serverInstructions: 'Be careful with database operations',
        },
      });

      const manager = await MCPManager.createInstance(newMCPServersConfig());
      const result = await manager.formatInstructionsForContext(['github', 'database']);

      expect(result).toContain('## github MCP Server Instructions');
      expect(result).toContain('Use GitHub API with care');
      expect(result).toContain('## database MCP Server Instructions');
      expect(result).toContain('Be careful with database operations');
      expect(result).not.toContain('files');
      expect(result).not.toContain('Only read/write files in allowed directories');
    });

    it('should handle servers with null or undefined instructions', async () => {
      (mockRegistryInstance.getAllServerConfigs as jest.Mock).mockResolvedValue({
        github: {
          type: 'sse',
          url: 'https://api.github.com',
          serverInstructions: 'Use GitHub API with care',
        },
        files: {
          type: 'stdio',
          command: 'node',
          args: ['files.js'],
          serverInstructions: null,
        },
        database: {
          type: 'stdio',
          command: 'node',
          args: ['db.js'],
        },
      });

      const manager = await MCPManager.createInstance(newMCPServersConfig());
      const result = await manager.formatInstructionsForContext();

      expect(result).toContain('## github MCP Server Instructions');
      expect(result).toContain('Use GitHub API with care');
      expect(result).not.toContain('files');
      expect(result).not.toContain('database');
    });

    it('should return empty string when filtered servers have no instructions', async () => {
      (mockRegistryInstance.getAllServerConfigs as jest.Mock).mockResolvedValue({
        github: {
          type: 'sse',
          url: 'https://api.github.com',
          serverInstructions: 'Use GitHub API with care',
        },
        files: {
          type: 'stdio',
          command: 'node',
          args: ['files.js'],
        },
      });

      const manager = await MCPManager.createInstance(newMCPServersConfig());
      const result = await manager.formatInstructionsForContext(['files']);

      expect(result).toBe('');
    });
  });

  describe('getServerToolFunctions', () => {
    it('should catch and handle errors gracefully', async () => {
      (MCPServerInspector.getToolCatalog as jest.Mock) = jest.fn(() => {
        throw new Error('Connection failed');
      });

      mockAppConnections({
        has: jest.fn().mockResolvedValue(true),
      });

      const manager = await MCPManager.createInstance(newMCPServersConfig());

      const result = await manager.getServerToolFunctions(userId, serverName);

      expect(result).toBeNull();
      expect(mockLogger.warn).toHaveBeenCalledWith(
        `[getServerToolFunctions] Error getting tool functions for server ${serverName}`,
        expect.any(Error),
      );
    });

    it('should catch synchronous errors from the profile pool lookup', async () => {
      (MCPServerInspector.getToolCatalog as jest.Mock) = jest.fn().mockResolvedValue({ tools: {} });

      mockAppConnections({
        get: jest.fn().mockResolvedValue(null),
      });

      const manager = await MCPManager.createInstance(newMCPServersConfig());

      const userConnections = (
        manager as unknown as { userConnections: Map<string, Map<string, MCPConnection>> }
      ).userConnections;
      const spy = jest.spyOn(userConnections, 'get').mockImplementation(() => {
        throw new Error('Failed to get user connections');
      });

      const result = await manager.getServerToolFunctions(userId, serverName);

      expect(result).toBeNull();
      expect(mockLogger.warn).toHaveBeenCalledWith(
        `[getServerToolFunctions] Error getting tool functions for server ${serverName}`,
        expect.any(Error),
      );
      expect(spy).toHaveBeenCalled();
    });

    it('should return tools successfully when no errors occur', async () => {
      const expectedTools: t.LCAvailableTools = {
        [`test_tool_mcp_${serverName}`]: {
          type: 'function',
          function: {
            name: `test_tool_mcp_${serverName}`,
            description: 'Test tool',
            parameters: { type: 'object' },
          },
        },
      };

      (MCPServerInspector.getToolCatalog as jest.Mock) = jest
        .fn()
        .mockResolvedValue({ tools: expectedTools });

      mockAppConnections({
        has: jest.fn().mockResolvedValue(true),
      });

      const manager = await MCPManager.createInstance(newMCPServersConfig());

      const result = await manager.getServerToolFunctions(userId, serverName);

      expect(result).toEqual(expectedTools);
      expect(mockLogger.warn).not.toHaveBeenCalled();
    });

    it('leases a cached user connection while reading its tool metadata', async () => {
      let finishInspection: ((tools: t.LCAvailableTools) => void) | undefined;
      const inspection = new Promise<t.LCAvailableTools>((resolve) => {
        finishInspection = resolve;
      });
      const connection = {} as MCPConnection;
      (MCPServerInspector.getToolCatalog as jest.Mock) = jest
        .fn()
        .mockReturnValue(inspection.then((tools) => ({ tools })));
      mockAppConnections({
        get: jest.fn().mockResolvedValue(null),
      });

      const manager = await MCPManager.createInstance(newMCPServersConfig());
      const lifecycle = manager as unknown as {
        userConnections: Map<string, Map<string, MCPConnection>>;
        waitForConnectionBorrowersToDrain: (connection: MCPConnection) => Promise<void>;
      };
      lifecycle.userConnections.set(
        userId,
        new Map([
          [getMCPConnectionPoolKey(serverName, STANDARD_MCP_CAPABILITY_PROFILE), connection],
        ]),
      );

      const toolsPromise = manager.getServerToolFunctions(userId, serverName);
      await new Promise((resolve) => setImmediate(resolve));
      let drained = false;
      const drainPromise = lifecycle.waitForConnectionBorrowersToDrain(connection).then(() => {
        drained = true;
      });
      await new Promise((resolve) => setImmediate(resolve));

      expect(drained).toBe(false);

      finishInspection?.({});
      await expect(toolsPromise).resolves.toEqual({});
      await drainPromise;
      expect(drained).toBe(true);
    });

    it('rejoins recovery after leasing cached tool metadata', async () => {
      const staleConnection = {} as MCPConnection;
      const recoveredConnection = {} as MCPConnection;
      let resolveRecovery: (() => void) | undefined;
      const recovery = new Promise<void>((resolve) => {
        resolveRecovery = resolve;
      });
      (MCPServerInspector.getToolCatalog as jest.Mock) = jest.fn().mockResolvedValue({ tools: {} });
      mockAppConnections({
        get: jest.fn().mockResolvedValue(null),
      });

      const manager = await MCPManager.createInstance(newMCPServersConfig());
      const internals = manager as unknown as {
        oauthRecoveries: WeakMap<
          MCPConnection,
          { promise: Promise<void>; allowsTakeover: boolean }
        >;
        userConnections: Map<string, Map<string, MCPConnection>>;
      };
      internals.userConnections.set(
        userId,
        new Map([
          [getMCPConnectionPoolKey(serverName, STANDARD_MCP_CAPABILITY_PROFILE), staleConnection],
        ]),
      );
      internals.oauthRecoveries.set(staleConnection, {
        promise: recovery,
        allowsTakeover: true,
      });

      const toolsPromise = manager.getServerToolFunctions(userId, serverName);
      await new Promise((resolve) => setImmediate(resolve));

      expect(MCPServerInspector.getToolCatalog).not.toHaveBeenCalled();

      internals.userConnections.set(
        userId,
        new Map([
          [
            getMCPConnectionPoolKey(serverName, STANDARD_MCP_CAPABILITY_PROFILE),
            recoveredConnection,
          ],
        ]),
      );
      internals.oauthRecoveries.delete(staleConnection);
      resolveRecovery?.();

      await expect(toolsPromise).resolves.toEqual({});
      expect(MCPServerInspector.getToolCatalog).toHaveBeenCalledWith(
        serverName,
        recoveredConnection,
      );
    });

    it('should include specific server name in error messages', async () => {
      const specificServerName = 'github_mcp_server';

      (MCPServerInspector.getToolCatalog as jest.Mock) = jest.fn(() => {
        throw new Error('Server specific error');
      });

      mockAppConnections({
        has: jest.fn().mockResolvedValue(true),
      });

      const manager = await MCPManager.createInstance(newMCPServersConfig(specificServerName));

      const result = await manager.getServerToolFunctions(userId, specificServerName);

      expect(result).toBeNull();
      expect(mockLogger.warn).toHaveBeenCalledWith(
        `[getServerToolFunctions] Error getting tool functions for server ${specificServerName}`,
        expect.any(Error),
      );
    });

    it('uses a user connection when an effective overlay shadows an app server', async () => {
      const overlayConfig: t.ParsedServerConfig = {
        type: 'streamable-http',
        url: 'https://tenant.example.com/mcp',
        source: 'yaml',
        startup: false,
      };
      const overlayConnection = {} as MCPConnection;
      const expectedTools: t.LCAvailableTools = {
        overlay_mcp_test_server: {
          type: 'function',
          function: {
            name: 'overlay_mcp_test_server',
            description: 'Overlay tool',
            parameters: { type: 'object' },
          },
        },
      };
      const appGet = jest.fn().mockResolvedValue({} as MCPConnection);
      mockAppConnections({ get: appGet });
      (mockRegistryInstance.isAppServerConfig as jest.Mock).mockResolvedValue(false);
      (MCPServerInspector.getToolCatalog as jest.Mock).mockResolvedValue({ tools: expectedTools });

      const manager = await MCPManager.createInstance(newMCPServersConfig());
      const internals = manager as unknown as {
        userConnections: Map<string, Map<string, MCPConnection>>;
      };
      internals.userConnections.set(
        userId,
        new Map([
          [getMCPConnectionPoolKey(serverName, STANDARD_MCP_CAPABILITY_PROFILE), overlayConnection],
        ]),
      );

      await expect(
        manager.getServerToolFunctionsSnapshot(userId, serverName, overlayConfig),
      ).resolves.toEqual({ tools: expectedTools, publicationGeneration: undefined });
      expect(appGet).not.toHaveBeenCalled();
      expect(MCPServerInspector.getToolCatalog).toHaveBeenCalledWith(serverName, overlayConnection);
    });
  });

  describe('callTool - Activity Tracking', () => {
    const mockUser = { id: 'activity-user' } as IUser;
    const mockFlowManager = {} as Parameters<MCPManager['callTool']>[0]['flowManager'];
    const serverConfig: t.SSEOptions = {
      type: 'sse',
      url: 'https://api.example.com',
    };

    function createConnection(): MCPConnection {
      return {
        capabilityProfile: STANDARD_MCP_CAPABILITY_PROFILE,
        isConnected: jest.fn().mockResolvedValue(true),
        setRequestHeaders: jest.fn(),
        timeout: 30000,
        client: {
          request: jest.fn().mockResolvedValue({
            content: [{ type: 'text', text: 'Tool result' }],
            isError: false,
          }),
        },
      } as unknown as MCPConnection;
    }

    function getManagerInternals(manager: MCPManager): {
      userConnections: Map<string, Map<string, MCPConnection>>;
      updateUserLastActivity: (trackedUserId: string) => void;
    } {
      return manager as unknown as {
        userConnections: Map<string, Map<string, MCPConnection>>;
        updateUserLastActivity: (trackedUserId: string) => void;
      };
    }

    beforeEach(() => {
      (graphUtils.preProcessGraphTokens as jest.Mock).mockImplementation(
        async (options) => options,
      );
    });

    it('updates activity when a cached connection is replaced during an in-flight call', async () => {
      const manager = new MCPManager();
      const activeConnection = createConnection();
      const replacementConnection = createConnection();
      const internals = getManagerInternals(manager);
      internals.userConnections.set(
        mockUser.id,
        new Map([
          [
            getMCPConnectionPoolKey(serverName, STANDARD_MCP_CAPABILITY_PROFILE),
            replacementConnection,
          ],
        ]),
      );
      jest.spyOn(manager, 'getConnection').mockResolvedValue(activeConnection);
      const updateActivity = jest.spyOn(internals, 'updateUserLastActivity');

      await manager.callTool({
        user: mockUser,
        serverName,
        serverConfig,
        toolName: 'test_tool',
        provider: 'openai',
        flowManager: mockFlowManager,
      });

      expect(updateActivity).toHaveBeenCalledWith(mockUser.id);
    });

    it('does not create activity entries for app-shared connections', async () => {
      const manager = new MCPManager();
      const appConnection = createConnection();
      const internals = getManagerInternals(manager);
      jest.spyOn(manager, 'getConnection').mockResolvedValue(appConnection);
      const updateActivity = jest.spyOn(internals, 'updateUserLastActivity');

      await manager.callTool({
        user: mockUser,
        serverName,
        serverConfig,
        toolName: 'test_tool',
        provider: 'openai',
        flowManager: mockFlowManager,
      });

      expect(updateActivity).not.toHaveBeenCalled();
      expect(manager.getConnectionStats().activityEntries).toBe(0);
    });
  });

  describe('callTool - scheduled authority boundary', () => {
    async function setupScheduled(stage: 'invoke' | 'resume' = 'invoke') {
      const fixture = await executionFixture(stage);
      const request = jest.fn().mockResolvedValue({ content: [{ type: 'text', text: 'read' }] });
      const snapshot = jest.fn().mockResolvedValue({ tools: [readTool], complete: true });
      const connection = {
        capabilityProfile: STANDARD_MCP_CAPABILITY_PROFILE,
        isConnected: jest.fn().mockResolvedValue(true),
        setRequestHeaders: jest.fn(),
        fetchToolsSnapshot: snapshot,
        timeout: 30_000,
        client: fakeClient(request, { tools: {} }),
      } as unknown as MCPConnection;
      const manager = new MCPManager();
      jest.spyOn(manager, 'getConnection').mockResolvedValue(connection);
      (graphUtils.preProcessGraphTokens as jest.Mock).mockImplementation(
        async (options) => options,
      );
      const call = (agentId = 'root') =>
        manager.callTool({
          user: fixture.user,
          serverName: 'warehouse',
          serverConfig: fixture.config,
          toolName: 'query',
          provider: 'openai',
          flowManager: {} as Parameters<MCPManager['callTool']>[0]['flowManager'],
          scheduledMCPInvocation: fixture.invocation(agentId),
        });
      return { fixture, request, snapshot, call };
    }

    it.each(['root', 'child'])('dispatches an authorized %s read once', async (agentId) => {
      const { request, call } = await setupScheduled();
      await call(agentId);
      expect(request.mock.calls.filter(([input]) => input.method === 'tools/call')).toHaveLength(1);
    });

    it.each(['revoke', 'expire', 'deny'] as const)(
      'never dispatches after %s, including deliberate retries',
      async (mutation) => {
        const { fixture, request, call } = await setupScheduled('resume');
        await fixture[mutation]();
        await expect(call()).rejects.toMatchObject({ failure: { automaticReplay: false } });
        await expect(call()).rejects.toMatchObject({ failure: { automaticReplay: false } });
        expect(request).not.toHaveBeenCalled();
      },
    );

    it('rejects misleading mutating metadata and changed definitions without reaching tools/call', async () => {
      const { request, snapshot, call } = await setupScheduled();
      snapshot.mockResolvedValue({
        tools: [
          {
            ...readTool,
            description: 'Read only!',
            annotations: { readOnlyHint: true },
            inputSchema: { type: 'object', properties: { write: { type: 'boolean' } } },
          },
        ],
        complete: true,
      });
      await expect(call()).rejects.toMatchObject({ failure: { reason: 'tool_policy_denied' } });
      expect(request).not.toHaveBeenCalled();
    });

    it('fences consent revoked during live tools/list immediately before dispatch', async () => {
      const { fixture, request, snapshot, call } = await setupScheduled();
      snapshot.mockImplementation(async () => {
        await fixture.revoke();
        return { tools: [readTool], complete: true };
      });
      await expect(call()).rejects.toMatchObject({ failure: { reason: 'consent_revoked' } });
      expect(request).not.toHaveBeenCalled();
    });

    it('attributes a protected catalog credential rejection without dispatch or provider text', async () => {
      const { request, snapshot, call } = await setupScheduled();
      snapshot.mockResolvedValue({
        tools: [],
        complete: false,
        authenticationError: Object.assign(new Error('Bearer PRIVATE'), { status: 401 }),
      });
      let failure: unknown;
      try {
        await call('child');
      } catch (error) {
        failure = error;
      }
      expect(failure).toMatchObject({
        failure: {
          reason: 'credential_rejected',
          status: 'mcp_reauth_required',
          automaticReplay: false,
        },
        outcomes: [expect.objectContaining({ agentId: 'child' })],
      });
      expect(String(failure)).not.toContain('PRIVATE');
      expect(request).not.toHaveBeenCalled();
    });

    it('never automatically replays a protected call after resource bearer rejection', async () => {
      const { request, call } = await setupScheduled();
      request.mockRejectedValue(Object.assign(new Error('HTTP 401'), { status: 401 }));
      await expect(call()).rejects.toMatchObject({
        failure: {
          reason: 'credential_rejected',
          status: 'mcp_reauth_required',
          automaticReplay: false,
        },
        outcomes: [expect.objectContaining({ agentId: 'root' })],
      });
      expect(request).toHaveBeenCalledTimes(1);
    });
  });

  describe('callTool - cancellation logging', () => {
    const mockUser = { id: 'cancel-user' } as IUser;
    const mockFlowManager = {} as Parameters<MCPManager['callTool']>[0]['flowManager'];
    const serverConfig: t.SSEOptions = {
      type: 'sse',
      url: 'https://api.example.com',
    };

    /** Rejects the way the MCP SDK does once a request's signal aborts. */
    function createAbortingConnection(): MCPConnection {
      return {
        isConnected: jest.fn().mockResolvedValue(true),
        setRequestHeaders: jest.fn(),
        timeout: 30000,
        client: {
          request: jest.fn(
            (_request: unknown, _schema: unknown, options: { signal?: AbortSignal }) =>
              new Promise((_resolve, reject) => {
                options.signal?.addEventListener('abort', () => reject(options.signal?.reason), {
                  once: true,
                });
              }),
          ),
        },
      } as unknown as MCPConnection;
    }

    beforeEach(() => {
      (graphUtils.preProcessGraphTokens as jest.Mock).mockImplementation(
        async (options) => options,
      );
      (logger.error as jest.Mock).mockClear();
      (logger.debug as jest.Mock).mockClear();
    });

    async function callAndAbort(connection: MCPConnection): Promise<unknown> {
      const manager = new MCPManager();
      jest.spyOn(manager, 'getConnection').mockResolvedValue(connection);
      const controller = new AbortController();
      const call = manager.callTool({
        user: mockUser,
        serverName,
        serverConfig,
        toolName: 'test_tool',
        provider: 'openai',
        flowManager: mockFlowManager,
        options: { signal: controller.signal },
      });
      await new Promise((resolve) => setImmediate(resolve));
      controller.abort();
      return call.catch((error) => error);
    }

    it('logs a user-aborted tool call at debug rather than as a failure', async () => {
      await callAndAbort(createAbortingConnection());

      expect(logger.error).not.toHaveBeenCalledWith(
        expect.stringContaining('Tool call failed'),
        expect.anything(),
      );
      expect(logger.debug).toHaveBeenCalledWith(
        expect.stringContaining('Tool call cancelled by user abort'),
      );
    });

    it('keeps a real failure racing the Stop at error level', async () => {
      const connection = {
        isConnected: jest.fn().mockResolvedValue(true),
        setRequestHeaders: jest.fn(),
        timeout: 30000,
        client: {
          request: jest.fn(
            (_request: unknown, _schema: unknown, options: { signal?: AbortSignal }) =>
              new Promise((_resolve, reject) => {
                options.signal?.addEventListener(
                  'abort',
                  () => reject(new Error('upstream 503 from the MCP server')),
                  { once: true },
                );
              }),
          ),
        },
      } as unknown as MCPConnection;

      await callAndAbort(connection);

      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('Tool call failed'),
        expect.anything(),
      );
    });
  });

  describe('callTool - declared App document acquisition', () => {
    const user = { id: 'app-user' } as IUser;
    const flowManager = {} as Parameters<MCPManager['callTool']>[0]['flowManager'];
    const serverConfig: t.SSEOptions = {
      type: 'sse',
      url: 'https://api.example.com',
    };
    const resourceUri = 'ui://app';
    const toolResult = {
      content: [
        { type: 'text' as const, text: 'ordinary output' },
        {
          type: 'resource' as const,
          resource: {
            uri: resourceUri,
            mimeType: 'text/html;profile=mcp-app',
            text: '<p>embedded result</p>',
          },
        },
      ],
      structuredContent: { count: 1 },
      _meta: { result: 'meta' },
      isError: false,
    };

    function connectionFor(request: jest.Mock): MCPConnection {
      return {
        createdAt: 1,
        toolListVersion: 0,
        isConnected: jest.fn().mockResolvedValue(true),
        setRequestHeaders: jest.fn(),
        getMCPAppRuntimeTarget: jest.fn(() => ({ type: 'sse', url: serverConfig.url })),
        timeout: 1234,
        fetchOrderedToolsSnapshot: jest.fn().mockResolvedValue({
          tools: [
            {
              name: 'app_tool',
              inputSchema: { type: 'object' },
              _meta: { ui: { resourceUri } },
            },
          ],
          complete: true,
        }),
        client: fakeClient(request),
      } as unknown as MCPConnection;
    }

    async function callWith(
      connection: MCPConnection,
      signal?: AbortSignal,
      mcpApps: Parameters<MCPManager['callTool']>[0]['mcpApps'] | null = {
        enabled: true,
        legacyHtmlEnabled: true,
      },
    ) {
      const manager = new MCPManager(undefined, undefined, {
        create: jest.fn(() => 'binding'),
        verify: jest.fn(() => true),
      });
      jest.spyOn(manager, 'getConnection').mockResolvedValue(connection);
      return manager.callTool({
        user,
        serverName,
        serverConfig,
        toolName: 'app_tool',
        provider: 'openai',
        flowManager,
        options: { signal },
        ...(mcpApps ? { mcpApps } : {}),
      });
    }

    it('reads the exact declared document once and preserves the original result separately', async () => {
      const request = jest.fn(async ({ method }: { method: string }) => {
        if (method === 'tools/call') {
          return toolResult;
        }
        return {
          contents: [
            { uri: 'ui://other', mimeType: 'text/html;profile=mcp-app', text: '<p>other</p>' },
            { uri: resourceUri, mimeType: 'text/plain', text: 'wrong mime' },
            {
              uri: resourceUri,
              mimeType: 'text/html;profile=mcp-app',
              text: '<p>resources/read document</p>',
              _meta: { ui: { csp: { connectDomains: ['https://content.example'] } } },
            },
          ],
        };
      });

      const [, artifacts] = await callWith(connectionFor(request));
      const app = artifacts?.ui_resources?.data?.[0];
      const calls = request.mock.calls as unknown as Array<
        [{ method: string; params?: unknown }, unknown, { timeout?: number }]
      >;

      expect(calls.map(([request]) => request.method)).toEqual(['tools/call', 'resources/read']);
      expect(calls[1][0].params).toEqual({ uri: resourceUri });
      expect(calls[1][2]).toMatchObject({ timeout: 1234 });
      expect(app).toMatchObject({
        uri: resourceUri,
        text: '<p>resources/read document</p>',
        csp: { connectDomains: ['https://content.example'] },
        structuredContent: { count: 1 },
        resultMeta: { result: 'meta' },
      });
      expect(app?.content).toBe(toolResult.content);
    });

    it('keeps canonical tool output and a bound retryable URI when document reading fails', async () => {
      const request = jest.fn(async ({ method }: { method: string }) => {
        if (method === 'tools/call') {
          return toolResult;
        }
        throw new Error('resource unavailable');
      });

      const [text, artifacts] = await callWith(connectionFor(request));

      expect(text).toContain('ordinary output');
      expect(artifacts?.ui_resources?.data).toEqual([
        expect.objectContaining({
          uri: resourceUri,
          mimeType: 'text/html;profile=mcp-app',
          serverBinding: 'binding',
          content: toolResult.content,
        }),
      ]);
      expect(artifacts?.ui_resources?.data?.[0]).not.toHaveProperty('text');
      expect(
        request.mock.calls.filter(([request]) => request.method === 'tools/call'),
      ).toHaveLength(1);
    });

    it('retains a bound URI without retrying the tool when the shared App budget is full', async () => {
      const limits = { maxBytes: 4 * 1024 * 1024, timeoutMs: 30_000, maxActive: 1 };
      const manager = new MCPManager(undefined, undefined, {
        create: jest.fn(() => 'binding'),
        verify: jest.fn(() => true),
      });
      const request = jest.fn(async ({ method }: { method: string }) => {
        if (method === 'tools/call') return toolResult;
        throw new Error('resource read must not start when capacity is full');
      });
      jest.spyOn(manager, 'getConnection').mockResolvedValue(connectionFor(request));
      let finish!: () => void;
      const occupied = manager.appOperationBudget.run(
        new AbortController().signal,
        () =>
          new Promise<void>((resolve) => {
            finish = resolve;
          }),
        limits,
      );

      const [text, artifacts] = await manager.callTool({
        user,
        serverName,
        serverConfig,
        toolName: 'app_tool',
        provider: 'openai',
        flowManager,
        mcpApps: { enabled: true, legacyHtmlEnabled: true, operationLimits: limits },
      });
      expect(text).toContain('ordinary output');
      expect(artifacts?.ui_resources?.data?.[0]).toMatchObject({
        uri: resourceUri,
        serverBinding: 'binding',
        content: toolResult.content,
      });
      expect(request.mock.calls.map(([call]) => call.method)).toEqual(['tools/call']);
      finish();
      await occupied;
    });

    it('retains the bound URI if the read returns no usable matching App document', async () => {
      const request = jest.fn(async ({ method }: { method: string }) =>
        method === 'tools/call'
          ? toolResult
          : { contents: [{ uri: resourceUri, mimeType: 'text/plain', text: 'not an app' }] },
      );
      const [text, artifacts] = await callWith(connectionFor(request));
      expect(text).toContain('ordinary output');
      expect(artifacts?.ui_resources?.data?.[0]).toMatchObject({
        uri: resourceUri,
        serverBinding: 'binding',
        content: toolResult.content,
      });
      expect(artifacts?.ui_resources?.data?.[0]?.text).toBeUndefined();
      expect(request.mock.calls.filter(([call]) => call.method === 'tools/call')).toHaveLength(1);
    });

    it('does not read or attach the App when Apps policy denies it', async () => {
      const request = jest.fn().mockResolvedValue(toolResult);
      const connection = connectionFor(request);
      const [, artifacts] = await callWith(connection, undefined, {
        enabled: false,
        legacyHtmlEnabled: false,
      });

      expect(request).toHaveBeenCalledTimes(1);
      expect(connection.fetchOrderedToolsSnapshot).not.toHaveBeenCalled();
      expect(artifacts?.ui_resources).toBeUndefined();
    });

    it('keeps canonical tool output when no Apps policy was admitted', async () => {
      const request = jest.fn().mockResolvedValue(toolResult);
      const connection = connectionFor(request);

      const [text, artifacts] = await callWith(connection, undefined, null);

      expect(text).toContain('ordinary output');
      expect(request).toHaveBeenCalledTimes(1);
      expect(connection.fetchOrderedToolsSnapshot).not.toHaveBeenCalled();
      expect(artifacts?.ui_resources).toBeUndefined();
    });

    it('keeps canonical tool output when the declared resource read is aborted', async () => {
      let readStarted: (() => void) | undefined;
      const started = new Promise<void>((resolve) => {
        readStarted = resolve;
      });
      const request = jest.fn(
        ({ method }: { method: string }, _schema: unknown, options: { signal?: AbortSignal }) => {
          if (method === 'tools/call') {
            return Promise.resolve(toolResult);
          }
          readStarted?.();
          return new Promise((_resolve, reject) => {
            options.signal?.addEventListener('abort', () => reject(options.signal?.reason), {
              once: true,
            });
          });
        },
      );
      const controller = new AbortController();
      const call = callWith(connectionFor(request), controller.signal);
      await started;
      controller.abort(new DOMException('stopped', 'AbortError'));

      await expect(call).resolves.toEqual(
        expect.arrayContaining([expect.stringContaining('ordinary output')]),
      );
      expect(
        request.mock.calls.filter(([request]) => request.method === 'tools/call'),
      ).toHaveLength(1);
    });

    it('keeps canonical tool output when metadata discovery is aborted', async () => {
      let snapshotStarted: (() => void) | undefined;
      const started = new Promise<void>((resolve) => {
        snapshotStarted = resolve;
      });
      const request = jest.fn().mockResolvedValue(toolResult);
      const connection = connectionFor(request);
      (connection.fetchOrderedToolsSnapshot as jest.Mock).mockImplementation(
        (_deadline: unknown, signal?: AbortSignal) => {
          snapshotStarted?.();
          return new Promise((_resolve, reject) => {
            signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
          });
        },
      );
      const controller = new AbortController();
      const call = callWith(connection, controller.signal);
      await started;
      controller.abort(new DOMException('stopped', 'AbortError'));

      await expect(call).resolves.toEqual(
        expect.arrayContaining([expect.stringContaining('ordinary output')]),
      );
      expect(request).toHaveBeenCalledTimes(1);
    });

    it('does not reuse declared App metadata after an incomplete catalog refresh', async () => {
      const request = jest.fn(async ({ method }: { method: string }) => {
        if (method === 'tools/call') {
          return toolResult;
        }
        return {
          contents: [
            {
              uri: resourceUri,
              mimeType: 'text/html;profile=mcp-app',
              text: '<p>resources/read document</p>',
            },
          ],
        };
      });
      const connection = connectionFor(request);
      const manager = new MCPManager(undefined, undefined, {
        create: jest.fn(() => 'binding'),
        verify: jest.fn(() => true),
      });
      jest.spyOn(manager, 'getConnection').mockResolvedValue(connection);

      const first = await manager.callTool({
        user,
        serverName,
        serverConfig,
        toolName: 'app_tool',
        provider: 'openai',
        flowManager,
        mcpApps: { enabled: true, legacyHtmlEnabled: true },
      });
      connection.toolListVersion += 1;
      (connection.fetchOrderedToolsSnapshot as jest.Mock).mockResolvedValueOnce({
        tools: [],
        complete: false,
      });
      const second = await manager.callTool({
        user,
        serverName,
        serverConfig,
        toolName: 'app_tool',
        provider: 'openai',
        flowManager,
        mcpApps: { enabled: true, legacyHtmlEnabled: true },
      });

      expect(first[1]?.ui_resources?.data).toHaveLength(1);
      expect(second[1]?.ui_resources).toBeUndefined();
      expect(request.mock.calls.map(([request]) => (request as { method: string }).method)).toEqual(
        ['tools/call', 'resources/read', 'tools/call'],
      );
    });

    it('uses the admitted policy without a post-call policy read', async () => {
      const request = jest.fn().mockResolvedValue(toolResult);
      mockRegistryInstance.resolveAllowlists.mockClear();

      await callWith(connectionFor(request));

      expect(mockRegistryInstance.resolveAllowlists).not.toHaveBeenCalled();
    });
  });

  describe('callTool - Graph Token Integration', () => {
    const mockUser: Partial<IUser> = {
      id: 'user-123',
      provider: 'openid',
      openidId: 'oidc-sub-456',
    };

    const mockFlowManager = {
      getState: jest.fn(),
      setState: jest.fn(),
      clearState: jest.fn(),
    };

    const mockConnection = {
      isConnected: jest.fn().mockResolvedValue(true),
      refreshToolList: jest.fn().mockResolvedValue(undefined),
      disconnect: jest.fn().mockResolvedValue(undefined),
      on: jest.fn(),
      setRequestHeaders: jest.fn(),
      timeout: 30000,
      client: {
        request: jest.fn().mockResolvedValue({
          content: [{ type: 'text', text: 'Tool result' }],
          isError: false,
        }),
      },
    } as unknown as MCPConnection;

    const mockGraphTokenResolver: GraphTokenResolver = jest.fn().mockResolvedValue({
      access_token: 'resolved-graph-token',
      token_type: 'Bearer',
      expires_in: 3600,
      scope: 'https://graph.microsoft.com/.default',
    });

    function createServerConfigWithGraphPlaceholder(): t.SSEOptions {
      return {
        type: 'sse',
        url: 'https://api.example.com',
        headers: {
          Authorization: 'Bearer {{LIBRECHAT_GRAPH_ACCESS_TOKEN}}',
          'Content-Type': 'application/json',
        },
      };
    }

    beforeEach(() => {
      jest.clearAllMocks();

      // Mock preProcessGraphTokens to simulate token resolution
      (graphUtils.preProcessGraphTokens as jest.Mock).mockImplementation(
        async (options, graphOptions) => {
          if (
            options.headers?.Authorization?.includes('{{LIBRECHAT_GRAPH_ACCESS_TOKEN}}') &&
            graphOptions.graphTokenResolver
          ) {
            return {
              ...options,
              headers: {
                ...options.headers,
                Authorization: 'Bearer resolved-graph-token',
              },
            };
          }
          return options;
        },
      );
      (MCPConnectionFactory.create as jest.Mock).mockResolvedValue(mockConnection);
    });

    it('should call preProcessGraphTokens with graphTokenResolver when provided', async () => {
      const serverConfig = createServerConfigWithGraphPlaceholder();

      mockAppConnections({
        get: jest.fn().mockResolvedValue(mockConnection),
      });

      (mockRegistryInstance.getServerConfig as jest.Mock).mockResolvedValue(serverConfig);

      const manager = await MCPManager.createInstance(newMCPServersConfig());

      await manager.callTool({
        user: mockUser as IUser,
        serverName,
        toolName: 'test_tool',
        provider: 'openai',
        flowManager: mockFlowManager as unknown as Parameters<
          typeof manager.callTool
        >[0]['flowManager'],
        graphTokenResolver: mockGraphTokenResolver,
      });

      expect(graphUtils.preProcessGraphTokens).toHaveBeenCalledWith(
        serverConfig,
        expect.objectContaining({
          user: mockUser,
          graphTokenResolver: mockGraphTokenResolver,
        }),
      );
    });

    it('should resolve graph token placeholders in headers before tool call', async () => {
      const serverConfig = createServerConfigWithGraphPlaceholder();

      mockAppConnections({
        get: jest.fn().mockResolvedValue(mockConnection),
      });

      (mockRegistryInstance.getServerConfig as jest.Mock).mockResolvedValue(serverConfig);

      const manager = await MCPManager.createInstance(newMCPServersConfig());

      await manager.callTool({
        user: mockUser as IUser,
        serverName,
        toolName: 'test_tool',
        provider: 'openai',
        flowManager: mockFlowManager as unknown as Parameters<
          typeof manager.callTool
        >[0]['flowManager'],
        graphTokenResolver: mockGraphTokenResolver,
      });

      // Verify the connection received the resolved headers
      expect(mockConnection.setRequestHeaders).toHaveBeenCalledWith(
        expect.objectContaining({
          Authorization: 'Bearer resolved-graph-token',
        }),
      );
    });

    it('should attach a recovery handler without reprocessing resolved config', async () => {
      const rawServerConfig = {
        type: 'sse',
        url: 'https://api.example.com/{{LIBRECHAT_USER_ID}}',
        headers: {
          Authorization: 'Bearer {{USER_TOKEN}}',
        },
        requiresOAuth: true,
        oauth: {
          authorization_url: 'https://auth.example.com/authorize',
        },
      } as t.ParsedServerConfig;
      const processedServerConfig = {
        ...rawServerConfig,
        url: 'https://api.example.com/user-123',
        headers: {
          Authorization: 'Bearer ${SHOULD_NOT_EXPAND}',
        },
      };
      const authError = new Error('Non-200 status code (401)');
      const connection = Object.assign(new EventEmitter(), {
        client: {
          request: jest
            .fn()
            .mockRejectedValueOnce(authError)
            .mockResolvedValueOnce({
              content: [{ type: 'text', text: 'Recovered result' }],
              isError: false,
            }),
        },
        connect: jest.fn().mockResolvedValue(undefined),
        getLastConnectionCheckError: jest.fn().mockReturnValue(undefined),
        isConnected: jest.fn().mockResolvedValue(true),
        isOAuthAuthenticationError: jest.fn((error: unknown) => error === authError),
        setRequestHeaders: jest.fn(),
        timeout: 30000,
        url: processedServerConfig.url,
      }) as unknown as MCPConnection;
      mockProcessMCPEnv.mockReturnValue(processedServerConfig);
      (MCPConnectionFactory.attachRequestOAuthHandler as jest.Mock).mockImplementation(
        (_basic, _oauth, currentConnection: MCPConnection) => {
          const listener = () => currentConnection.emit('oauthHandled');
          currentConnection.on('oauthReauthenticationRequired', listener);
          return () => currentConnection.off('oauthReauthenticationRequired', listener);
        },
      );
      mockAppConnections({
        get: jest.fn().mockResolvedValue(connection),
      });
      (mockRegistryInstance.getServerConfig as jest.Mock).mockResolvedValue(rawServerConfig);

      const manager = await MCPManager.createInstance(newMCPServersConfig());
      jest.spyOn(manager, 'getConnection').mockResolvedValue(connection);
      const oauthStart = jest.fn();

      await manager.callTool({
        user: mockUser as IUser,
        serverName,
        toolName: 'test_tool',
        provider: 'openai',
        oauthStart,
        flowManager: mockFlowManager as unknown as Parameters<
          typeof manager.callTool
        >[0]['flowManager'],
      });

      /** callTool resolves the config once; handler attachment does not process it again. */
      expect(mockProcessMCPEnv).toHaveBeenCalledTimes(1);
      expect(MCPConnectionFactory.attachRequestOAuthHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          serverConfig: processedServerConfig,
          skipEnvProcessing: true,
        }),
        expect.objectContaining({
          oauthStart: expect.any(Function),
          user: mockUser,
        }),
        connection,
      );
      const generationSpy = jest
        .spyOn(toolsChanged, 'getMCPToolsChangedGeneration')
        .mockResolvedValue('request-peer-generation');
      try {
        const oauthOptions = (MCPConnectionFactory.attachRequestOAuthHandler as jest.Mock).mock
          .calls[0][1];
        await expect(oauthOptions.onOAuthCredentialsInvalidated()).resolves.toBe(
          'request-peer-generation',
        );
        expect(generationSpy).toHaveBeenCalledWith({ userId: mockUser.id, serverName });
      } finally {
        generationSpy.mockRestore();
      }
      expect(connection.listenerCount('oauthReauthenticationRequired')).toBe(0);
    });

    it('should leave graph token placeholders sandboxed for user-sourced configs', async () => {
      const serverConfig: t.ParsedServerConfig = {
        type: 'sse',
        url: 'https://api.example.com',
        headers: {
          Authorization: 'Bearer {{LIBRECHAT_GRAPH_ACCESS_TOKEN}}',
        },
        source: 'user',
        dbId: 'user-server-id',
      };

      mockAppConnections({
        get: jest.fn().mockResolvedValue(mockConnection),
      });

      (mockRegistryInstance.getServerConfig as jest.Mock).mockResolvedValue(serverConfig);

      const manager = await MCPManager.createInstance(newMCPServersConfig());

      await manager.callTool({
        user: mockUser as IUser,
        serverName,
        toolName: 'test_tool',
        provider: 'openai',
        flowManager: mockFlowManager as unknown as Parameters<
          typeof manager.callTool
        >[0]['flowManager'],
        graphTokenResolver: mockGraphTokenResolver,
      });

      expect(graphUtils.preProcessGraphTokens).not.toHaveBeenCalled();
      expect(mockConnection.setRequestHeaders).toHaveBeenCalledWith(
        expect.objectContaining({
          Authorization: 'Bearer {{LIBRECHAT_GRAPH_ACCESS_TOKEN}}',
        }),
      );
    });

    it('should pass options unchanged when no graphTokenResolver is provided', async () => {
      const serverConfig: t.SSEOptions = {
        type: 'sse',
        url: 'https://api.example.com',
        headers: {
          Authorization: 'Bearer static-token',
        },
      };

      // Reset mock to return options unchanged
      (graphUtils.preProcessGraphTokens as jest.Mock).mockImplementation(
        async (options) => options,
      );

      mockAppConnections({
        get: jest.fn().mockResolvedValue(mockConnection),
      });

      (mockRegistryInstance.getServerConfig as jest.Mock).mockResolvedValue(serverConfig);

      const manager = await MCPManager.createInstance(newMCPServersConfig());

      await manager.callTool({
        user: mockUser as IUser,
        serverName,
        toolName: 'test_tool',
        provider: 'openai',
        flowManager: mockFlowManager as unknown as Parameters<
          typeof manager.callTool
        >[0]['flowManager'],
        // No graphTokenResolver provided
      });

      // Verify preProcessGraphTokens was still called (to check for placeholders)
      expect(graphUtils.preProcessGraphTokens).toHaveBeenCalledWith(
        serverConfig,
        expect.objectContaining({
          user: mockUser,
          graphTokenResolver: undefined,
        }),
      );
    });

    it('should handle graph token resolution failure gracefully', async () => {
      const serverConfig = createServerConfigWithGraphPlaceholder();

      // Simulate resolution failure - returns original value unchanged
      (graphUtils.preProcessGraphTokens as jest.Mock).mockImplementation(
        async (options) => options,
      );

      mockAppConnections({
        get: jest.fn().mockResolvedValue(mockConnection),
      });

      (mockRegistryInstance.getServerConfig as jest.Mock).mockResolvedValue(serverConfig);

      const manager = await MCPManager.createInstance(newMCPServersConfig());

      // Should not throw, even when token resolution fails
      await expect(
        manager.callTool({
          user: mockUser as IUser,
          serverName,
          toolName: 'test_tool',
          provider: 'openai',
          flowManager: mockFlowManager as unknown as Parameters<
            typeof manager.callTool
          >[0]['flowManager'],
          graphTokenResolver: mockGraphTokenResolver,
        }),
      ).resolves.toBeDefined();

      // Headers should contain the unresolved placeholder
      expect(mockConnection.setRequestHeaders).toHaveBeenCalledWith(
        expect.objectContaining({
          Authorization: 'Bearer {{LIBRECHAT_GRAPH_ACCESS_TOKEN}}',
        }),
      );
    });

    it('should resolve graph tokens in env variables', async () => {
      const serverConfig: t.StdioOptions = {
        type: 'stdio',
        command: 'node',
        args: ['server.js'],
        env: {
          GRAPH_TOKEN: '{{LIBRECHAT_GRAPH_ACCESS_TOKEN}}',
          OTHER_VAR: 'static-value',
        },
      };

      // Mock resolution for env variables
      (graphUtils.preProcessGraphTokens as jest.Mock).mockImplementation(async (options) => {
        if (options.env?.GRAPH_TOKEN?.includes('{{LIBRECHAT_GRAPH_ACCESS_TOKEN}}')) {
          return {
            ...options,
            env: {
              ...options.env,
              GRAPH_TOKEN: 'resolved-graph-token',
            },
          };
        }
        return options;
      });

      mockAppConnections({
        get: jest.fn().mockResolvedValue(mockConnection),
      });

      (mockRegistryInstance.getServerConfig as jest.Mock).mockResolvedValue(serverConfig);

      const manager = await MCPManager.createInstance(newMCPServersConfig());

      await manager.callTool({
        user: mockUser as IUser,
        serverName,
        toolName: 'test_tool',
        provider: 'openai',
        flowManager: mockFlowManager as unknown as Parameters<
          typeof manager.callTool
        >[0]['flowManager'],
        graphTokenResolver: mockGraphTokenResolver,
      });

      expect(graphUtils.preProcessGraphTokens).toHaveBeenCalledWith(
        serverConfig,
        expect.objectContaining({
          graphTokenResolver: mockGraphTokenResolver,
        }),
      );
    });

    it('should resolve graph tokens in URL', async () => {
      const serverConfig: t.SSEOptions = {
        type: 'sse',
        url: 'https://api.example.com?token={{LIBRECHAT_GRAPH_ACCESS_TOKEN}}',
      };

      // Mock resolution for URL
      (graphUtils.preProcessGraphTokens as jest.Mock).mockImplementation(async (options) => {
        if (options.url?.includes('{{LIBRECHAT_GRAPH_ACCESS_TOKEN}}')) {
          return {
            ...options,
            url: 'https://api.example.com?token=resolved-graph-token',
          };
        }
        return options;
      });

      mockAppConnections({
        get: jest.fn().mockResolvedValue(mockConnection),
      });

      (mockRegistryInstance.getServerConfig as jest.Mock).mockResolvedValue(serverConfig);

      const manager = await MCPManager.createInstance(newMCPServersConfig());

      await manager.callTool({
        user: mockUser as IUser,
        serverName,
        toolName: 'test_tool',
        provider: 'openai',
        flowManager: mockFlowManager as unknown as Parameters<
          typeof manager.callTool
        >[0]['flowManager'],
        graphTokenResolver: mockGraphTokenResolver,
      });

      expect(graphUtils.preProcessGraphTokens).toHaveBeenCalledWith(
        serverConfig,
        expect.objectContaining({
          graphTokenResolver: mockGraphTokenResolver,
        }),
      );
    });

    it('should pass scopes from environment variable to preProcessGraphTokens', async () => {
      const originalEnv = process.env.GRAPH_API_SCOPES;
      process.env.GRAPH_API_SCOPES = 'custom.scope.read custom.scope.write';

      const serverConfig = createServerConfigWithGraphPlaceholder();

      mockAppConnections({
        get: jest.fn().mockResolvedValue(mockConnection),
      });

      (mockRegistryInstance.getServerConfig as jest.Mock).mockResolvedValue(serverConfig);

      const manager = await MCPManager.createInstance(newMCPServersConfig());

      await manager.callTool({
        user: mockUser as IUser,
        serverName,
        toolName: 'test_tool',
        provider: 'openai',
        flowManager: mockFlowManager as unknown as Parameters<
          typeof manager.callTool
        >[0]['flowManager'],
        graphTokenResolver: mockGraphTokenResolver,
      });

      expect(graphUtils.preProcessGraphTokens).toHaveBeenCalledWith(
        serverConfig,
        expect.objectContaining({
          scopes: 'custom.scope.read custom.scope.write',
        }),
      );

      // Restore environment
      if (originalEnv !== undefined) {
        process.env.GRAPH_API_SCOPES = originalEnv;
      } else {
        delete process.env.GRAPH_API_SCOPES;
      }
    });

    it('should work correctly when config has no graph token placeholders', async () => {
      const serverConfig: t.SSEOptions = {
        type: 'sse',
        url: 'https://api.example.com',
        headers: {
          Authorization: 'Bearer static-token',
        },
      };

      // Mock to return unchanged options when no placeholders
      (graphUtils.preProcessGraphTokens as jest.Mock).mockImplementation(
        async (options) => options,
      );

      mockAppConnections({
        get: jest.fn().mockResolvedValue(mockConnection),
      });

      (mockRegistryInstance.getServerConfig as jest.Mock).mockResolvedValue(serverConfig);

      const manager = await MCPManager.createInstance(newMCPServersConfig());

      const result = await manager.callTool({
        user: mockUser as IUser,
        serverName,
        toolName: 'test_tool',
        provider: 'openai',
        flowManager: mockFlowManager as unknown as Parameters<
          typeof manager.callTool
        >[0]['flowManager'],
        graphTokenResolver: mockGraphTokenResolver,
      });

      expect(result).toBeDefined();
      expect(mockConnection.setRequestHeaders).toHaveBeenCalledWith(
        expect.objectContaining({
          Authorization: 'Bearer static-token',
        }),
      );
    });
  });

  describe('callTool - runtime OAuth recovery', () => {
    const mockUser = { id: 'oauth-user' } as IUser;
    const mockFlowManager = {} as Parameters<MCPManager['callTool']>[0]['flowManager'];
    const serverConfig: t.StreamableHTTPOptions = {
      type: 'streamable-http',
      url: 'https://mcp.example.com',
      requiresOAuth: true,
      oauth: {
        authorization_url: 'https://auth.example.com/authorize',
      },
    };
    const toolResult = {
      content: [{ type: 'text', text: 'Recovered result' }],
      isError: false,
    };

    function createConnection(request: jest.Mock) {
      const emitter = new EventEmitter();
      return Object.assign(emitter, {
        capabilityProfile: STANDARD_MCP_CAPABILITY_PROFILE,
        client: { request },
        connect: jest.fn().mockResolvedValue(undefined),
        disconnect: jest.fn().mockResolvedValue(undefined),
        dispose: jest.fn().mockResolvedValue(undefined),
        getLastConnectionCheckError: jest.fn().mockReturnValue(undefined),
        isConnected: jest.fn().mockResolvedValue(true),
        isOAuthAuthenticationError: jest.fn((error: unknown) => {
          return error instanceof Error && error.message.includes('401');
        }),
        usesOAuth: jest.fn().mockReturnValue(true),
        setRequestHeaders: jest.fn(),
        timeout: 30000,
        url: serverConfig.url,
      }) as unknown as MCPConnection;
    }

    function attachOAuthHandler(
      handler: (connection: MCPConnection) => void = (connection) => {
        connection.emit('oauthHandled');
      },
    ) {
      (MCPConnectionFactory.attachRequestOAuthHandler as jest.Mock).mockImplementation(
        (_basic, _oauth, connection: MCPConnection) => {
          const listener = () => handler(connection);
          connection.on('oauthReauthenticationRequired', listener);
          return () => connection.off('oauthReauthenticationRequired', listener);
        },
      );
    }

    async function callTool(
      manager: MCPManager,
      signal?: AbortSignal,
      oauthStart: t.OAuthStartHandler = jest.fn(),
      requestScopedConnections?: t.RequestScopedMCPConnectionStore,
      oauthEnd?: () => Promise<void>,
    ) {
      return manager.callTool({
        user: mockUser,
        serverName,
        toolName: 'oauth_tool',
        provider: 'openai',
        oauthStart,
        oauthEnd,
        flowManager: mockFlowManager,
        requestScopedConnections,
        options: signal ? { signal } : undefined,
      });
    }

    async function createManager(connection: MCPConnection) {
      mockAppConnections({});
      const manager = await MCPManager.createInstance(newMCPServersConfig());
      jest.spyOn(manager, 'getConnection').mockResolvedValue(connection);
      return manager;
    }

    beforeEach(() => {
      (mockRegistryInstance.getServerConfig as jest.Mock).mockResolvedValue(serverConfig);
      mockProcessMCPEnv.mockReturnValue(serverConfig);
    });

    it('refreshes, rebuilds, and retries a rejected tool request once', async () => {
      const authError = new Error('Non-200 status code (401)');
      const request = jest.fn().mockRejectedValueOnce(authError).mockResolvedValueOnce(toolResult);
      const connection = createConnection(request);
      attachOAuthHandler();
      const manager = await createManager(connection);

      await expect(callTool(manager)).resolves.toBeDefined();

      expect(connection.connect).toHaveBeenCalledTimes(1);
      expect(request).toHaveBeenCalledTimes(2);
      expect(request.mock.calls[1]).toEqual(request.mock.calls[0]);
    });

    it.each([true, false])(
      'preserves first JSON-RPC failure without stored-OAuth replay for enrolled=%s',
      async (enrolled) => {
        const failure = new McpError(ErrorCode.InternalError, 'HTTP 401 invalid_token');
        const request = jest.fn().mockRejectedValueOnce(failure).mockResolvedValueOnce(toolResult);
        const connection = createConnection(request);
        attachOAuthHandler();
        const manager = await createManager(connection);
        const authorize = jest.fn(async () => undefined);
        const identity = {
          scheduleId: 's',
          ownerId: mockUser.id,
          tenantId: null,
          agentId: 'root',
          invocationMode: 'delegated' as const,
        };
        const result = manager.callTool({
          user: mockUser,
          serverName,
          toolName: 'oauth_tool',
          provider: 'openai',
          flowManager: mockFlowManager,
          oauthStart: jest.fn(),
          scheduledMCPInvocation: { identity, enrolled, agentId: 'root', authorize },
        });
        if (enrolled) await expect(result).rejects.toBe(failure);
        else await expect(result).resolves.toBeDefined();
        expect(request).toHaveBeenCalledTimes(enrolled ? 1 : 2);
        expect(authorize).toHaveBeenCalledTimes(enrolled ? 1 : 2);
        expect(connection.connect).toHaveBeenCalledTimes(enrolled ? 0 : 1);
      },
    );

    it('carries the request credential through a delayed 401 after the connection rotates', async () => {
      let credential = 'credential-a';
      const request = jest
        .fn()
        .mockImplementationOnce(async () => {
          credential = 'credential-b';
          throw new Error('Non-200 status code (401)');
        })
        .mockResolvedValueOnce(toolResult);
      const connection = createConnection(request);
      connection.getOAuthCredentialSetId = jest.fn(() => credential);
      const events: unknown[] = [];
      connection.on('oauthReauthenticationRequired', (event) => events.push(event));
      attachOAuthHandler();
      const manager = await createManager(connection);
      await expect(callTool(manager)).resolves.toBeDefined();
      expect(events).toEqual([
        expect.objectContaining({ rejectedCredentialSetId: 'credential-a' }),
      ]);
      expect(credential).toBe('credential-b');
    });

    it.each(['credential-a', null])(
      'preserves the recorded transport identity %s',
      async (rejected) => {
        const connection = createConnection(jest.fn().mockResolvedValue(toolResult));
        const error = new Error('Non-200 status code (401)');
        (connection.isConnected as jest.Mock).mockResolvedValueOnce(false);
        (connection.getLastConnectionCheckError as jest.Mock).mockReturnValue(error);
        connection.getOAuthCredentialSetId = jest.fn(() => 'credential-b');
        connection.getLastConnectionCheckCredentialSetId = jest.fn(() => rejected);
        const events: unknown[] = [];
        connection.on('oauthReauthenticationRequired', (event) => events.push(event));
        attachOAuthHandler();
        const manager = await createManager(connection);
        await expect(callTool(manager)).resolves.toBeDefined();
        expect(events).toEqual([expect.objectContaining({ rejectedCredentialSetId: rejected })]);
      },
    );

    it('joins recovery registered between cached checkout and lease acquisition', async () => {
      const request = jest.fn().mockResolvedValue(toolResult);
      const connection = createConnection(request);
      const manager = await createManager(connection);
      let resolveConnection: ((connection: MCPConnection) => void) | undefined;
      const firstCheckout = new Promise<MCPConnection>((resolve) => {
        resolveConnection = resolve;
      });
      (manager.getConnection as jest.Mock)
        .mockReset()
        .mockReturnValueOnce(firstCheckout)
        .mockResolvedValue(connection);
      let resolveRecovery: (() => void) | undefined;
      const recovery = new Promise<void>((resolve) => {
        resolveRecovery = resolve;
      });
      const internals = manager as unknown as {
        oauthRecoveries: WeakMap<
          MCPConnection,
          { promise: Promise<void>; allowsTakeover: boolean }
        >;
      };

      const toolPromise = callTool(manager);
      resolveConnection?.(connection);
      internals.oauthRecoveries.set(connection, { promise: recovery, allowsTakeover: true });
      await new Promise((resolve) => setImmediate(resolve));

      expect(request).not.toHaveBeenCalled();
      expect(manager.getConnection).toHaveBeenCalledTimes(1);

      internals.oauthRecoveries.delete(connection);
      resolveRecovery?.();

      await expect(toolPromise).resolves.toBeDefined();
      expect(manager.getConnection).toHaveBeenCalledTimes(2);
      expect(request).toHaveBeenCalledTimes(1);
    });

    it('reacquires the cached connection after claiming a failed checkout recovery', async () => {
      const staleRequest = jest.fn();
      const recoveredRequest = jest.fn().mockResolvedValue(toolResult);
      const staleConnection = createConnection(staleRequest);
      const recoveredConnection = createConnection(recoveredRequest);
      const manager = await createManager(staleConnection);
      (manager.getConnection as jest.Mock)
        .mockReset()
        .mockResolvedValueOnce(staleConnection)
        .mockResolvedValue(recoveredConnection);
      let rejectRecovery: ((error: Error) => void) | undefined;
      const recovery = new Promise<void>((_resolve, reject) => {
        rejectRecovery = reject;
      });
      const internals = manager as unknown as {
        oauthRecoveries: WeakMap<
          MCPConnection,
          { promise: Promise<void>; allowsTakeover: boolean }
        >;
      };
      internals.oauthRecoveries.set(staleConnection, {
        promise: recovery,
        allowsTakeover: true,
      });

      const toolPromise = callTool(manager);
      await new Promise((resolve) => setImmediate(resolve));
      rejectRecovery?.(new Error('Shared recovery failed'));

      await expect(toolPromise).resolves.toBeDefined();
      expect(manager.getConnection).toHaveBeenCalledTimes(2);
      expect(staleRequest).not.toHaveBeenCalled();
      expect(recoveredRequest).toHaveBeenCalledTimes(1);
    });

    it('disposes a recovered connection that was evicted before recovery', async () => {
      const authError = new Error('Non-200 status code (401)');
      const request = jest.fn();
      const connection = createConnection(request);
      attachOAuthHandler();
      const manager = await createManager(connection);
      const lifecycle = manager as unknown as {
        disposeEvictedConnection: (connection: MCPConnection, logPrefix: string) => Promise<void>;
      };
      request
        .mockImplementationOnce(async () => {
          await lifecycle.disposeEvictedConnection(connection, '[MCP][evicted]');
          throw authError;
        })
        .mockResolvedValueOnce(toolResult);

      await expect(callTool(manager)).resolves.toBeDefined();

      expect(connection.connect).toHaveBeenCalledTimes(1);
      expect(connection.dispose).toHaveBeenCalledTimes(1);
      expect(request).toHaveBeenCalledTimes(2);
    });

    it('preserves recovery eviction when another borrower releases last', async () => {
      const authError = new Error('Non-200 status code (401)');
      const request = jest.fn();
      const connection = createConnection(request);
      attachOAuthHandler();
      const manager = await createManager(connection);
      const lifecycle = manager as unknown as {
        disposeEvictedConnection: (connection: MCPConnection, logPrefix: string) => Promise<void>;
        retainConnection: (connection: MCPConnection) => void;
        releaseConnection: (connection: MCPConnection) => Promise<void>;
      };
      request
        .mockImplementationOnce(async () => {
          lifecycle.retainConnection(connection);
          await lifecycle.disposeEvictedConnection(connection, '[MCP][evicted]');
          throw authError;
        })
        .mockResolvedValueOnce(toolResult);

      const toolPromise = callTool(manager);
      await new Promise((resolve) => setImmediate(resolve));

      expect(connection.connect).not.toHaveBeenCalled();
      expect(connection.dispose).not.toHaveBeenCalled();

      await lifecycle.releaseConnection(connection);
      await expect(toolPromise).resolves.toBeDefined();

      expect(connection.connect).toHaveBeenCalledTimes(1);
      expect(connection.dispose).toHaveBeenCalledTimes(1);
      expect(request).toHaveBeenCalledTimes(2);
    });

    it('preserves eviction requested during a recovery lease gap', async () => {
      const connection = createConnection(jest.fn());
      const manager = await createManager(connection);
      const lifecycle = manager as unknown as {
        disposeEvictedConnection: (connection: MCPConnection, logPrefix: string) => Promise<void>;
        holdDeferredConnectionDisposal: (connection: MCPConnection) => void;
        releaseDeferredConnectionDisposal: (connection: MCPConnection) => Promise<void>;
        retainConnection: (connection: MCPConnection) => void;
        releaseConnection: (connection: MCPConnection) => Promise<void>;
      };

      lifecycle.holdDeferredConnectionDisposal(connection);
      await lifecycle.disposeEvictedConnection(connection, '[MCP][evicted]');

      expect(connection.dispose).not.toHaveBeenCalled();

      lifecycle.retainConnection(connection);
      await lifecycle.releaseDeferredConnectionDisposal(connection);
      await lifecycle.releaseConnection(connection);

      expect(connection.dispose).toHaveBeenCalledTimes(1);
    });

    it('defers final borrower disposal until the recovery hold is released', async () => {
      const connection = createConnection(jest.fn());
      const manager = await createManager(connection);
      const lifecycle = manager as unknown as {
        disposeEvictedConnection: (connection: MCPConnection, logPrefix: string) => Promise<void>;
        holdDeferredConnectionDisposal: (connection: MCPConnection) => void;
        releaseDeferredConnectionDisposal: (connection: MCPConnection) => Promise<void>;
        retainConnection: (connection: MCPConnection) => void;
        releaseConnection: (connection: MCPConnection) => Promise<void>;
      };

      lifecycle.holdDeferredConnectionDisposal(connection);
      lifecycle.retainConnection(connection);
      await lifecycle.disposeEvictedConnection(connection, '[MCP][evicted]');
      await lifecycle.releaseConnection(connection);

      expect(connection.dispose).not.toHaveBeenCalled();

      await lifecycle.releaseDeferredConnectionDisposal(connection);

      expect(connection.dispose).toHaveBeenCalledTimes(1);
    });

    it('recovers an OAuth failure found by the connection preflight check', async () => {
      const authError = new Error('Non-200 status code (401)');
      const request = jest.fn().mockResolvedValueOnce(toolResult);
      const connection = createConnection(request);
      (connection.isConnected as jest.Mock).mockResolvedValue(false);
      (connection.getLastConnectionCheckError as jest.Mock).mockReturnValue(authError);
      attachOAuthHandler();
      const manager = await createManager(connection);

      await expect(callTool(manager)).resolves.toBeDefined();

      expect(connection.connect).toHaveBeenCalledTimes(1);
      expect(request).toHaveBeenCalledTimes(1);
    });

    it('recovers when OAuth was detected from the resolved connection config', async () => {
      const authError = new Error('Non-200 status code (401)');
      const request = jest.fn().mockRejectedValueOnce(authError).mockResolvedValueOnce(toolResult);
      const connection = createConnection(request);
      const runtimeConfig: t.ParsedServerConfig = {
        type: 'streamable-http',
        url: 'https://api.example.com/users/{{LIBRECHAT_USER_ID}}/mcp',
        source: 'yaml',
      };
      (mockRegistryInstance.getServerConfig as jest.Mock).mockResolvedValue(runtimeConfig);
      mockProcessMCPEnv.mockReturnValue({
        ...runtimeConfig,
        url: 'https://api.example.com/users/oauth-user/mcp',
      });
      attachOAuthHandler();
      const manager = await createManager(connection);

      await expect(callTool(manager)).resolves.toBeDefined();

      expect(MCPConnectionFactory.attachRequestOAuthHandler).toHaveBeenCalledTimes(1);
      expect(connection.connect).toHaveBeenCalledTimes(1);
      expect(request).toHaveBeenCalledTimes(2);
    });

    it('keeps the request OAuth handler attached through reconnect-time OAuth', async () => {
      const authError = new Error('Non-200 status code (401)');
      const request = jest.fn().mockRejectedValueOnce(authError).mockResolvedValueOnce(toolResult);
      const connection = createConnection(request);
      (connection.connect as jest.Mock)
        .mockImplementationOnce(async () => {
          const emitted = connection.emit('oauthReauthenticationRequired', {
            serverName,
            error: authError,
            serverUrl: serverConfig.url,
            userId: mockUser.id,
          });
          if (!emitted) {
            throw new Error('Reconnect OAuth handler missing');
          }
          throw new Error('Connection not established');
        })
        .mockResolvedValueOnce(undefined);
      const oauthHandler = jest.fn((currentConnection: MCPConnection) => {
        currentConnection.emit('oauthHandled');
      });
      attachOAuthHandler(oauthHandler);
      const manager = await createManager(connection);

      await expect(callTool(manager)).resolves.toBeDefined();

      expect(oauthHandler).toHaveBeenCalledTimes(2);
      expect(connection.connect).toHaveBeenCalledTimes(2);
      expect(request).toHaveBeenCalledTimes(2);
      expect(connection.listenerCount('oauthReauthenticationRequired')).toBe(0);
    });

    it('escalates to interactive OAuth when reconnect rejects a silently refreshed token', async () => {
      const authError = new Error('Non-200 status code (401)');
      const reconnectError = new Error('Connection not established');
      const request = jest.fn().mockRejectedValueOnce(authError).mockResolvedValueOnce(toolResult);
      const connection = createConnection(request);
      (connection.connect as jest.Mock)
        .mockImplementationOnce(async () => {
          connection.emit('oauthHandled', 'silent-refresh');
          throw reconnectError;
        })
        .mockResolvedValueOnce(undefined);
      const recoveryEvents: Array<{ skipSilentRefresh?: boolean }> = [];
      (MCPConnectionFactory.attachRequestOAuthHandler as jest.Mock).mockImplementation(
        (_basic, _oauth, currentConnection: MCPConnection) => {
          const listener = (data: { skipSilentRefresh?: boolean }) => {
            recoveryEvents.push(data);
            currentConnection.emit(
              'oauthHandled',
              data.skipSilentRefresh ? 'interactive' : 'silent-refresh',
            );
          };
          currentConnection.on('oauthReauthenticationRequired', listener);
          return () => currentConnection.off('oauthReauthenticationRequired', listener);
        },
      );
      const manager = await createManager(connection);

      await expect(callTool(manager)).resolves.toBeDefined();

      expect(recoveryEvents).toHaveLength(2);
      expect(recoveryEvents[0].skipSilentRefresh).toBeUndefined();
      expect(recoveryEvents[1].skipSilentRefresh).toBe(true);
      expect(connection.connect).toHaveBeenCalledTimes(2);
      expect(request).toHaveBeenCalledTimes(2);
      expect(connection.listenerCount('oauthReauthenticationRequired')).toBe(0);
    });

    it('does not start a second recovery when the retried request is rejected', async () => {
      const firstError = new Error('Non-200 status code (401)');
      const secondError = new Error('Non-200 status code (401) again');
      const request = jest
        .fn()
        .mockRejectedValueOnce(firstError)
        .mockRejectedValueOnce(secondError);
      const connection = createConnection(request);
      attachOAuthHandler();
      const manager = await createManager(connection);

      await expect(callTool(manager)).rejects.toBe(secondError);

      expect(connection.connect).toHaveBeenCalledTimes(1);
      expect(request).toHaveBeenCalledTimes(2);
    });

    it('returns the original error when OAuth recovery fails', async () => {
      const authError = new Error('Non-200 status code (401)');
      const request = jest.fn().mockRejectedValueOnce(authError);
      const connection = createConnection(request);
      attachOAuthHandler((currentConnection) => {
        currentConnection.emit('oauthFailed', new Error('Refresh rejected'));
      });
      const manager = await createManager(connection);

      await expect(callTool(manager)).rejects.toBe(authError);

      expect(connection.connect).not.toHaveBeenCalled();
      expect(request).toHaveBeenCalledTimes(1);
    });

    it('does not recover or retry non-authentication failures', async () => {
      const toolError = new Error('Tool execution failed');
      const request = jest.fn().mockRejectedValueOnce(toolError);
      const connection = createConnection(request);
      attachOAuthHandler();
      const manager = await createManager(connection);

      await expect(callTool(manager)).rejects.toBe(toolError);

      expect(MCPConnectionFactory.attachRequestOAuthHandler).not.toHaveBeenCalled();
      expect(connection.connect).not.toHaveBeenCalled();
      expect(request).toHaveBeenCalledTimes(1);
    });

    it('shares one OAuth handler and connection rebuild across concurrent rejected calls', async () => {
      const authError = new Error('Non-200 status code (401)');
      const request = jest
        .fn()
        .mockRejectedValueOnce(authError)
        .mockRejectedValueOnce(authError)
        .mockResolvedValue(toolResult);
      const connection = createConnection(request);
      let finishConnect: (() => void) | undefined;
      (connection.connect as jest.Mock).mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            finishConnect = resolve;
          }),
      );
      const oauthHandler = jest.fn((currentConnection: MCPConnection) => {
        currentConnection.emit('oauthHandled');
      });
      attachOAuthHandler(oauthHandler);
      const manager = await createManager(connection);

      const firstCall = callTool(manager);
      const secondCall = callTool(manager);
      await new Promise((resolve) => setImmediate(resolve));
      finishConnect?.();

      await expect(Promise.all([firstCall, secondCall])).resolves.toHaveLength(2);
      expect(MCPConnectionFactory.attachRequestOAuthHandler).toHaveBeenCalledTimes(1);
      expect(oauthHandler).toHaveBeenCalledTimes(1);
      expect(connection.connect).toHaveBeenCalledTimes(1);
      expect(request).toHaveBeenCalledTimes(4);
      expect(connection.listenerCount('oauthReauthenticationRequired')).toBe(0);
    });

    it('lets an aborted runtime waiter leave without cancelling the recovery owner', async () => {
      const authError = new Error('Non-200 status code (401)');
      const request = jest.fn().mockRejectedValue(authError);
      const connection = createConnection(request);
      attachOAuthHandler(() => undefined);
      const manager = await createManager(connection);
      const controller = new AbortController();
      const abortReason = new Error('waiter aborted');

      const ownerCall = callTool(manager);
      await new Promise((resolve) => setImmediate(resolve));
      const waiterCall = callTool(manager, controller.signal);
      await new Promise((resolve) => setImmediate(resolve));

      expect(MCPConnectionFactory.attachRequestOAuthHandler).toHaveBeenCalledTimes(1);
      controller.abort(abortReason);

      await expect(waiterCall).rejects.toBe(abortReason);
      expect(connection.listenerCount('oauthReauthenticationRequired')).toBe(1);

      connection.emit('oauthFailed', new Error('Recovery owner aborted'));

      await expect(ownerCall).rejects.toBe(authError);
      expect(connection.connect).not.toHaveBeenCalled();
      expect(request).toHaveBeenCalledTimes(1);
      expect(connection.listenerCount('oauthReauthenticationRequired')).toBe(0);
    });

    it('lets an aborted recovery owner leave while a live waiter completes recovery', async () => {
      const authError = new Error('Non-200 status code (401)');
      const request = jest.fn().mockRejectedValueOnce(authError).mockResolvedValueOnce(toolResult);
      const connection = createConnection(request);
      attachOAuthHandler(() => undefined);
      const manager = await createManager(connection);
      const controller = new AbortController();
      const abortReason = new Error('owner aborted');

      const ownerCall = callTool(manager, controller.signal);
      await new Promise((resolve) => setImmediate(resolve));
      const waiterCall = callTool(manager);
      await new Promise((resolve) => setImmediate(resolve));

      controller.abort(abortReason);

      await expect(ownerCall).rejects.toBe(abortReason);
      expect(connection.listenerCount('oauthReauthenticationRequired')).toBe(1);

      connection.emit('oauthHandled');

      await expect(waiterCall).resolves.toBeDefined();
      expect(MCPConnectionFactory.attachRequestOAuthHandler).toHaveBeenCalledTimes(1);
      expect(
        (MCPConnectionFactory.attachRequestOAuthHandler as jest.Mock).mock.calls[0][1].signal,
      ).toBeUndefined();
      expect(connection.connect).toHaveBeenCalledTimes(1);
      expect(request).toHaveBeenCalledTimes(2);
      expect(connection.listenerCount('oauthReauthenticationRequired')).toBe(0);
    });

    it('relays an active recovery prompt to a joining request', async () => {
      const authError = new Error('Non-200 status code (401)');
      const request = jest.fn().mockRejectedValueOnce(authError).mockResolvedValue(toolResult);
      const connection = createConnection(request);
      const ownerOAuthStart = jest.fn().mockResolvedValue(undefined);
      const waiterOAuthStart = jest.fn().mockResolvedValue(undefined);
      (MCPConnectionFactory.attachRequestOAuthHandler as jest.Mock).mockImplementation(
        (_basic, oauth: { oauthStart?: t.OAuthStartHandler }, currentConnection: MCPConnection) => {
          const listener = () => {
            void oauth.oauthStart?.('https://auth.example.com/pending');
          };
          currentConnection.on('oauthReauthenticationRequired', listener);
          return () => currentConnection.off('oauthReauthenticationRequired', listener);
        },
      );
      const manager = await createManager(connection);

      const ownerCall = callTool(manager, undefined, ownerOAuthStart);
      await new Promise((resolve) => setImmediate(resolve));
      expect(ownerOAuthStart).toHaveBeenCalledWith('https://auth.example.com/pending', undefined);

      const waiterCall = callTool(manager, undefined, waiterOAuthStart);
      await new Promise((resolve) => setImmediate(resolve));
      expect(waiterOAuthStart).toHaveBeenCalledWith('https://auth.example.com/pending', undefined);

      connection.emit('oauthHandled');

      await expect(Promise.all([ownerCall, waiterCall])).resolves.toHaveLength(2);
      expect(MCPConnectionFactory.attachRequestOAuthHandler).toHaveBeenCalledTimes(1);
      expect(connection.connect).toHaveBeenCalledTimes(1);
      expect(request).toHaveBeenCalledTimes(3);
    });

    it('relays OAuth completion to live waiters without failing recovery on notification errors', async () => {
      const authError = new Error('Non-200 status code (401)');
      const request = jest.fn().mockRejectedValueOnce(authError).mockResolvedValue(toolResult);
      const connection = createConnection(request);
      const ownerOAuthStart = jest.fn().mockResolvedValue(undefined);
      const waiterOAuthStart = jest.fn().mockResolvedValue(undefined);
      const ownerOAuthEnd = jest.fn().mockRejectedValue(new Error('owner response is stale'));
      const waiterOAuthEnd = jest.fn().mockResolvedValue(undefined);
      let completeOAuth: (() => void) | undefined;
      const completionGate = new Promise<void>((resolve) => {
        completeOAuth = resolve;
      });
      (MCPConnectionFactory.attachRequestOAuthHandler as jest.Mock).mockImplementation(
        (
          _basic,
          oauth: {
            oauthStart?: t.OAuthStartHandler;
            oauthEnd?: () => Promise<void>;
          },
          currentConnection: MCPConnection,
        ) => {
          const listener = async () => {
            await oauth.oauthStart?.('https://auth.example.com/pending');
            await completionGate;
            try {
              await oauth.oauthEnd?.();
              currentConnection.emit('oauthHandled');
            } catch (error) {
              currentConnection.emit('oauthFailed', error);
            }
          };
          currentConnection.on('oauthReauthenticationRequired', listener);
          return () => currentConnection.off('oauthReauthenticationRequired', listener);
        },
      );
      const manager = await createManager(connection);

      const ownerCall = callTool(manager, undefined, ownerOAuthStart, undefined, ownerOAuthEnd);
      await new Promise((resolve) => setImmediate(resolve));
      const waiterCall = callTool(manager, undefined, waiterOAuthStart, undefined, waiterOAuthEnd);
      await new Promise((resolve) => setImmediate(resolve));

      completeOAuth?.();

      await expect(Promise.all([ownerCall, waiterCall])).resolves.toHaveLength(2);
      expect(ownerOAuthEnd).toHaveBeenCalledTimes(1);
      expect(waiterOAuthEnd).toHaveBeenCalledTimes(1);
      expect(connection.connect).toHaveBeenCalledTimes(1);
      expect(request).toHaveBeenCalledTimes(3);
    });

    it('defers request-context cleanup until shared recovery settles', async () => {
      const authError = new Error('Non-200 status code (401)');
      const request = jest.fn().mockRejectedValueOnce(authError).mockResolvedValueOnce(toolResult);
      const connection = createConnection(request);
      attachOAuthHandler(() => undefined);
      const manager = await createManager(connection);
      const requestContext = createMCPRequestContext();
      requestContext.connections.set(
        getMCPUserConnectionPoolKey(mockUser.id, serverName, STANDARD_MCP_CAPABILITY_PROFILE),
        connection,
      );

      const toolPromise = callTool(manager, undefined, jest.fn(), requestContext);
      await new Promise((resolve) => setImmediate(resolve));

      await cleanupMCPRequestContext(requestContext);
      expect(connection.dispose).not.toHaveBeenCalled();
      expect(requestContext.connections.size).toBe(0);

      connection.emit('oauthHandled');

      await expect(toolPromise).resolves.toBeDefined();
      expect(connection.connect).toHaveBeenCalledTimes(1);
      expect(connection.dispose).toHaveBeenCalledTimes(1);
      expect(request).toHaveBeenCalledTimes(2);
    });

    it('retries transient reconnect failures within the recovery budget', async () => {
      const authError = new Error('Non-200 status code (401)');
      const transientError = new Error('Connection reset');
      const request = jest.fn().mockRejectedValueOnce(authError).mockResolvedValueOnce(toolResult);
      const connection = createConnection(request);
      (connection.connect as jest.Mock)
        .mockRejectedValueOnce(transientError)
        .mockResolvedValueOnce(undefined);
      attachOAuthHandler();
      const manager = await createManager(connection);
      const retryPolicy = manager as unknown as {
        waitForOAuthReconnectRetry: (attempt: number) => Promise<void>;
      };
      const waitForRetry = jest
        .spyOn(retryPolicy, 'waitForOAuthReconnectRetry')
        .mockResolvedValue(undefined);

      await expect(callTool(manager)).resolves.toBeDefined();

      expect(waitForRetry).toHaveBeenCalledWith(1);
      expect(connection.connect).toHaveBeenCalledTimes(2);
      expect(request).toHaveBeenCalledTimes(2);
    });

    it('disposes a recovered connection explicitly disconnected during recovery', async () => {
      const authError = new Error('Non-200 status code (401)');
      const request = jest.fn().mockRejectedValueOnce(authError).mockResolvedValueOnce(toolResult);
      const connection = createConnection(request);
      attachOAuthHandler(() => undefined);
      const manager = await createManager(connection);
      const internals = manager as unknown as {
        userConnections: Map<string, Map<string, MCPConnection>>;
      };
      internals.userConnections.set(
        mockUser.id,
        new Map([
          [getMCPConnectionPoolKey(serverName, STANDARD_MCP_CAPABILITY_PROFILE), connection],
        ]),
      );

      const toolPromise = callTool(manager);
      await new Promise((resolve) => setImmediate(resolve));

      await manager.disconnectUserConnection(mockUser.id, serverName);
      expect(internals.userConnections.get(mockUser.id)).toBeUndefined();
      expect(connection.dispose).not.toHaveBeenCalled();

      connection.emit('oauthHandled');

      await expect(toolPromise).resolves.toBeDefined();
      expect(connection.connect).toHaveBeenCalledTimes(1);
      expect(connection.dispose).toHaveBeenCalledTimes(1);
      expect(request).toHaveBeenCalledTimes(2);
      expect(connection.listenerCount('oauthReauthenticationRequired')).toBe(0);
    });

    it('keeps recovery disposal owned after the request owner aborts', async () => {
      const authError = new Error('Non-200 status code (401)');
      const request = jest.fn().mockRejectedValueOnce(authError);
      const connection = createConnection(request);
      attachOAuthHandler(() => undefined);
      const manager = await createManager(connection);
      const lifecycle = manager as unknown as {
        disposeEvictedConnection: (connection: MCPConnection, logPrefix: string) => Promise<void>;
      };
      const controller = new AbortController();
      const abortReason = new Error('request aborted');

      const ownerCall = callTool(manager, controller.signal);
      await new Promise((resolve) => setImmediate(resolve));
      controller.abort(abortReason);

      await expect(ownerCall).rejects.toBe(abortReason);
      await lifecycle.disposeEvictedConnection(connection, '[MCP][evicted]');
      expect(connection.dispose).not.toHaveBeenCalled();

      connection.emit('oauthHandled');
      await new Promise((resolve) => setImmediate(resolve));

      expect(connection.connect).toHaveBeenCalledTimes(1);
      expect(connection.dispose).toHaveBeenCalledTimes(1);
      expect(connection.listenerCount('oauthReauthenticationRequired')).toBe(0);
    });

    it('defers ephemeral disposal until an aborted OAuth recovery settles', async () => {
      const authError = new Error('Non-200 status code (401)');
      const request = jest.fn().mockRejectedValueOnce(authError);
      const connection = createConnection(request);
      attachOAuthHandler(() => undefined);
      const manager = await createManager(connection);
      const ephemeralConfig: t.StreamableHTTPOptions = {
        ...serverConfig,
        url: 'https://mcp.example.com/{{LIBRECHAT_BODY_CONVERSATIONID}}',
      };
      (mockRegistryInstance.getServerConfig as jest.Mock).mockResolvedValue(ephemeralConfig);
      mockProcessMCPEnv.mockReturnValue({
        ...ephemeralConfig,
        url: 'https://mcp.example.com/conversation-1',
      });
      const controller = new AbortController();
      const abortReason = new Error('request aborted');

      const toolCall = manager.callTool({
        user: mockUser,
        serverName,
        toolName: 'oauth_tool',
        provider: 'openai',
        oauthStart: jest.fn(),
        flowManager: mockFlowManager,
        requestBody: { conversationId: 'conversation-1' },
        options: { signal: controller.signal },
      });
      await new Promise((resolve) => setImmediate(resolve));
      controller.abort(abortReason);

      await expect(toolCall).rejects.toBe(abortReason);
      expect(connection.dispose).not.toHaveBeenCalled();

      connection.emit('oauthHandled');
      await new Promise((resolve) => setImmediate(resolve));

      expect(connection.connect).toHaveBeenCalledTimes(1);
      expect(connection.dispose).toHaveBeenCalledTimes(1);
      expect(connection.listenerCount('oauthReauthenticationRequired')).toBe(0);
    });

    it('lets a live waiter recover after the recovery owner fails', async () => {
      const authError = new Error('Non-200 status code (401)');
      const request = jest
        .fn()
        .mockRejectedValueOnce(authError)
        .mockRejectedValueOnce(authError)
        .mockResolvedValueOnce(toolResult);
      const connection = createConnection(request);
      let attachmentCount = 0;
      (MCPConnectionFactory.attachRequestOAuthHandler as jest.Mock).mockImplementation(
        (_basic, _oauth, currentConnection: MCPConnection) => {
          const currentAttachment = ++attachmentCount;
          const listener = () => {
            if (currentAttachment === 2) {
              currentConnection.emit('oauthHandled');
            }
          };
          currentConnection.on('oauthReauthenticationRequired', listener);
          return () => currentConnection.off('oauthReauthenticationRequired', listener);
        },
      );
      const manager = await createManager(connection);

      const ownerCall = callTool(manager);
      await new Promise((resolve) => setImmediate(resolve));
      const waiterCall = callTool(manager);
      await new Promise((resolve) => setImmediate(resolve));

      expect(MCPConnectionFactory.attachRequestOAuthHandler).toHaveBeenCalledTimes(1);

      connection.emit('oauthFailed', new Error('Recovery owner aborted'));

      await expect(ownerCall).rejects.toBe(authError);
      await expect(waiterCall).resolves.toBeDefined();
      expect(MCPConnectionFactory.attachRequestOAuthHandler).toHaveBeenCalledTimes(2);
      expect(connection.connect).toHaveBeenCalledTimes(1);
      expect(request).toHaveBeenCalledTimes(3);
      expect(connection.listenerCount('oauthReauthenticationRequired')).toBe(0);
    });

    it('restarts checkout when a post-request recovery waiter claims takeover', async () => {
      const authError = new Error('Non-200 status code (401)');
      const staleRequest = jest.fn().mockRejectedValue(authError);
      const recoveredRequest = jest.fn().mockResolvedValue(toolResult);
      const staleConnection = createConnection(staleRequest);
      const recoveredConnection = createConnection(recoveredRequest);
      attachOAuthHandler(() => undefined);
      const manager = await createManager(staleConnection);
      let currentConnection = staleConnection;
      (manager.getConnection as jest.Mock).mockImplementation(async () => currentConnection);

      const ownerCall = callTool(manager);
      const waiterCall = callTool(manager);
      await new Promise((resolve) => setImmediate(resolve));

      expect(MCPConnectionFactory.attachRequestOAuthHandler).toHaveBeenCalledTimes(1);
      currentConnection = recoveredConnection;
      staleConnection.emit('oauthFailed', new Error('Recovery owner failed'));

      await expect(ownerCall).rejects.toBe(authError);
      await expect(waiterCall).resolves.toBeDefined();
      expect(staleRequest).toHaveBeenCalledTimes(2);
      expect(recoveredRequest).toHaveBeenCalledTimes(1);
      expect(staleConnection.connect).not.toHaveBeenCalled();
      expect(recoveredConnection.connect).not.toHaveBeenCalled();
      expect(staleConnection.listenerCount('oauthReauthenticationRequired')).toBe(0);
    });

    it('caps waiter takeover after a shared recovery keeps failing', async () => {
      const authError = new Error('Non-200 status code (401)');
      const request = jest.fn().mockRejectedValue(authError);
      const connection = createConnection(request);
      let attachmentCount = 0;
      (MCPConnectionFactory.attachRequestOAuthHandler as jest.Mock).mockImplementation(
        (_basic, _oauth, currentConnection: MCPConnection) => {
          attachmentCount += 1;
          const listener = () => {
            currentConnection.emit('oauthFailed', new Error('OAuth denied'));
          };
          currentConnection.on('oauthReauthenticationRequired', listener);
          return () => currentConnection.off('oauthReauthenticationRequired', listener);
        },
      );
      const manager = await createManager(connection);

      const calls = [callTool(manager), callTool(manager), callTool(manager), callTool(manager)];
      const results = await Promise.allSettled(calls);

      expect(results.every((result) => result.status === 'rejected')).toBe(true);
      expect(attachmentCount).toBe(2);
      expect(connection.connect).not.toHaveBeenCalled();
      expect(connection.listenerCount('oauthReauthenticationRequired')).toBe(0);
    });

    it('allows only one checkout waiter to claim a failed recovery takeover', async () => {
      const authError = new Error('Non-200 status code (401)');
      const request = jest.fn().mockRejectedValue(authError);
      const connection = createConnection(request);
      attachOAuthHandler((currentConnection) => {
        currentConnection.emit('oauthFailed', new Error('OAuth denied'));
      });
      const manager = await createManager(connection);
      let rejectRecovery: ((error: Error) => void) | undefined;
      const recovery = new Promise<void>((_resolve, reject) => {
        rejectRecovery = reject;
      });
      const internals = manager as unknown as {
        oauthRecoveries: WeakMap<
          MCPConnection,
          { promise: Promise<void>; allowsTakeover: boolean; takeoverClaimed?: boolean }
        >;
      };
      internals.oauthRecoveries.set(connection, {
        promise: recovery,
        allowsTakeover: true,
      });

      const calls = [callTool(manager), callTool(manager), callTool(manager), callTool(manager)];
      await new Promise((resolve) => setImmediate(resolve));
      internals.oauthRecoveries.delete(connection);
      rejectRecovery?.(new Error('Shared recovery failed'));
      const results = await Promise.allSettled(calls);

      expect(results.every((result) => result.status === 'rejected')).toBe(true);
      expect(request).toHaveBeenCalledTimes(1);
      expect(MCPConnectionFactory.attachRequestOAuthHandler).toHaveBeenCalledTimes(1);
      expect(connection.listenerCount('oauthReauthenticationRequired')).toBe(0);
    });
  });

  describe('getUserConnection - recovery lifecycle', () => {
    const mockUser = { id: 'recovery-user' } as IUser;
    const serverConfig: t.StreamableHTTPOptions = {
      type: 'streamable-http',
      url: 'https://mcp.example.com',
      requiresOAuth: false,
    };

    it('forwards the OAuth credential mutation callback to the connection factory', async () => {
      mockAppConnections({
        has: jest.fn().mockResolvedValue(false),
      });
      const connection = {
        isConnected: jest.fn().mockResolvedValue(true),
        refreshToolList: jest.fn().mockResolvedValue({ tools: [] }),
        on: jest.fn(),
      } as unknown as MCPConnection;
      (MCPConnectionFactory.create as jest.Mock).mockResolvedValue(connection);
      const manager = await MCPManager.createInstance(newMCPServersConfig());
      const onOAuthCredentialsChanged = jest.fn().mockResolvedValue(undefined);
      const oauthConfig = { ...serverConfig, requiresOAuth: true };

      await manager.getUserConnection({
        serverName,
        user: mockUser,
        serverConfig: oauthConfig,
        flowManager: {} as Parameters<typeof manager.getUserConnection>[0]['flowManager'],
        onOAuthCredentialsChanged,
      });

      expect(MCPConnectionFactory.create).toHaveBeenCalledWith(
        expect.objectContaining({ serverName }),
        expect.objectContaining({
          useOAuth: true,
          onOAuthCredentialsChanged,
        }),
      );
    });

    it('detects direct-bearer mode when the Authorization template lives in requestHeaders', async () => {
      mockAppConnections({
        has: jest.fn().mockResolvedValue(false),
      });
      const connection = {
        isConnected: jest.fn().mockResolvedValue(true),
        refreshToolList: jest.fn().mockResolvedValue({ tools: [] }),
        on: jest.fn(),
      } as unknown as MCPConnection;
      (MCPConnectionFactory.create as jest.Mock).mockResolvedValue(connection);
      (graphUtils.preProcessGraphTokens as jest.Mock).mockImplementation(async (config) => config);
      const manager = await MCPManager.createInstance(newMCPServersConfig());
      const upstreamTokenProvider = jest.fn().mockResolvedValue({ access_token: 'live-token' });

      await manager.getUserConnection({
        serverName,
        user: { id: 'direct-user', provider: 'openid', openidId: 'direct-subject' } as IUser,
        serverConfig: {
          ...serverConfig,
          source: 'yaml',
          requestHeaders: { Authorization: 'Bearer {{LIBRECHAT_OPENID_ACCESS_TOKEN}}' },
        } as t.ParsedServerConfig,
        flowManager: {} as Parameters<typeof manager.getUserConnection>[0]['flowManager'],
        upstreamTokenProvider,
      });

      /** The manager's own bearer decisions read the config directly, so the map
       *  has to be folded in before them or a 401 never reaches recovery. */
      expect(upstreamTokenProvider).toHaveBeenCalled();
      const createCalls = (MCPConnectionFactory.create as jest.Mock).mock.calls;
      const [basic] = createCalls[createCalls.length - 1];
      expect(basic.directBearerSourceConfig).toBeDefined();
      expect(basic.serverConfig.headers).toEqual({ Authorization: 'Bearer live-token' });
      expect(basic.serverConfig).not.toHaveProperty('requestHeaders');
      expect(basic.serverDefinition.requestHeaders).toEqual({
        Authorization: 'Bearer {{LIBRECHAT_OPENID_ACCESS_TOKEN}}',
      });
      const published = jest.fn();
      toolsChanged.setMCPToolsChangedHandler(published);
      try {
        const listener = (connection.on as jest.Mock).mock.calls.find(
          ([event]) => event === 'toolsChanged',
        )?.[1];
        listener([]);
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(published).toHaveBeenCalledWith(
          expect.objectContaining({
            serverConfig: basic.serverDefinition,
          }),
        );
      } finally {
        toolsChanged.setMCPToolsChangedHandler(null);
      }
    });

    it('waits for an active recovery before reusing a cached connection', async () => {
      mockAppConnections({
        has: jest.fn().mockResolvedValue(false),
      });
      const manager = await MCPManager.createInstance(newMCPServersConfig());
      const connection = {
        isConnected: jest.fn().mockResolvedValue(true),
      } as unknown as MCPConnection;
      let resolveRecovery: (() => void) | undefined;
      const recovery = new Promise<void>((resolve) => {
        resolveRecovery = resolve;
      });
      const internals = manager as unknown as {
        oauthRecoveries: WeakMap<
          MCPConnection,
          { promise: Promise<void>; allowsTakeover: boolean }
        >;
        userConnections: Map<string, Map<string, MCPConnection>>;
      };
      internals.userConnections.set(
        mockUser.id,
        new Map([
          [getMCPConnectionPoolKey(serverName, STANDARD_MCP_CAPABILITY_PROFILE), connection],
        ]),
      );
      internals.oauthRecoveries.set(connection, { promise: recovery, allowsTakeover: true });

      const connectionPromise = manager.getUserConnection({
        serverName,
        user: mockUser,
        serverConfig,
      });
      await new Promise((resolve) => setImmediate(resolve));

      expect(connection.isConnected).not.toHaveBeenCalled();

      resolveRecovery?.();

      await expect(connectionPromise).resolves.toBe(connection);
      expect(connection.isConnected).toHaveBeenCalledTimes(1);
      expect(MCPConnectionFactory.create).not.toHaveBeenCalled();
    });

    it('rechecks recovery after yielding to load connection configuration', async () => {
      mockAppConnections({
        has: jest.fn().mockResolvedValue(false),
      });
      let resolveConfig: ((config: t.ParsedServerConfig) => void) | undefined;
      (mockRegistryInstance.getServerConfig as jest.Mock).mockReturnValue(
        new Promise<t.ParsedServerConfig>((resolve) => {
          resolveConfig = resolve;
        }),
      );
      const manager = await MCPManager.createInstance(newMCPServersConfig());
      let recovered = false;
      const connection = {
        disconnect: jest.fn().mockResolvedValue(undefined),
        isConnected: jest.fn().mockImplementation(async () => recovered),
        isStale: jest.fn().mockReturnValue(false),
      } as unknown as MCPConnection;
      let resolveRecovery: (() => void) | undefined;
      const recovery = new Promise<void>((resolve) => {
        resolveRecovery = resolve;
      });
      const internals = manager as unknown as {
        oauthRecoveries: WeakMap<
          MCPConnection,
          { promise: Promise<void>; allowsTakeover: boolean }
        >;
        userConnections: Map<string, Map<string, MCPConnection>>;
      };
      internals.userConnections.set(
        mockUser.id,
        new Map([
          [getMCPConnectionPoolKey(serverName, STANDARD_MCP_CAPABILITY_PROFILE), connection],
        ]),
      );

      const connectionPromise = manager.getUserConnection({
        serverName,
        user: mockUser,
      });
      await new Promise((resolve) => setImmediate(resolve));

      internals.oauthRecoveries.set(connection, { promise: recovery, allowsTakeover: true });
      resolveConfig?.(serverConfig);
      await new Promise((resolve) => setImmediate(resolve));

      expect(connection.disconnect).not.toHaveBeenCalled();
      expect(MCPConnectionFactory.create).not.toHaveBeenCalled();

      recovered = true;
      resolveRecovery?.();

      await expect(connectionPromise).resolves.toBe(connection);
      expect(connection.isConnected).toHaveBeenCalledTimes(1);
      expect(connection.disconnect).not.toHaveBeenCalled();
      expect(MCPConnectionFactory.create).not.toHaveBeenCalled();
    });

    it('replaces stale configuration without waiting for obsolete recovery', async () => {
      mockAppConnections({
        has: jest.fn().mockResolvedValue(false),
      });
      const manager = await MCPManager.createInstance(newMCPServersConfig());
      const staleConnection = {
        disconnect: jest.fn().mockResolvedValue(undefined),
        dispose: jest.fn().mockResolvedValue(undefined),
        isConnected: jest.fn().mockResolvedValue(false),
        isStale: jest.fn().mockReturnValue(true),
      } as unknown as MCPConnection;
      const replacementConnection = {
        dispose: jest.fn().mockResolvedValue(undefined),
        isConnected: jest.fn().mockResolvedValue(true),
        on: jest.fn(),
        refreshToolList: jest.fn().mockResolvedValue(undefined),
      } as unknown as MCPConnection;
      const recovery = new Promise<void>(() => undefined);
      const internals = manager as unknown as {
        oauthRecoveries: WeakMap<
          MCPConnection,
          { promise: Promise<void>; allowsTakeover: boolean }
        >;
        retainConnection: (connection: MCPConnection) => void;
        releaseConnection: (connection: MCPConnection) => Promise<void>;
        userConnections: Map<string, Map<string, MCPConnection>>;
      };
      internals.userConnections.set(
        mockUser.id,
        new Map([
          [getMCPConnectionPoolKey(serverName, STANDARD_MCP_CAPABILITY_PROFILE), staleConnection],
        ]),
      );
      internals.retainConnection(staleConnection);
      internals.oauthRecoveries.set(staleConnection, {
        promise: recovery,
        allowsTakeover: true,
      });
      (MCPConnectionFactory.create as jest.Mock).mockResolvedValue(replacementConnection);
      const updatedConfig = { ...serverConfig, updatedAt: Date.now() };

      await expect(
        manager.getUserConnection({
          serverName,
          user: mockUser,
          serverConfig: updatedConfig,
        }),
      ).resolves.toBe(replacementConnection);

      expect(staleConnection.dispose).not.toHaveBeenCalled();
      expect(MCPConnectionFactory.create).toHaveBeenCalledTimes(1);

      await internals.releaseConnection(staleConnection);
      expect(staleConnection.dispose).toHaveBeenCalledTimes(1);
    });

    it('lets an aborted waiter leave without cancelling the shared recovery', async () => {
      mockAppConnections({
        has: jest.fn().mockResolvedValue(false),
      });
      const manager = await MCPManager.createInstance(newMCPServersConfig());
      const connection = {
        isConnected: jest.fn().mockResolvedValue(true),
      } as unknown as MCPConnection;
      const recovery = new Promise<void>(() => undefined);
      const internals = manager as unknown as {
        oauthRecoveries: WeakMap<
          MCPConnection,
          { promise: Promise<void>; allowsTakeover: boolean }
        >;
        userConnections: Map<string, Map<string, MCPConnection>>;
      };
      internals.userConnections.set(
        mockUser.id,
        new Map([
          [getMCPConnectionPoolKey(serverName, STANDARD_MCP_CAPABILITY_PROFILE), connection],
        ]),
      );
      internals.oauthRecoveries.set(connection, { promise: recovery, allowsTakeover: true });
      const controller = new AbortController();
      const abortReason = new Error('request aborted');

      const connectionPromise = manager.getUserConnection({
        serverName,
        user: mockUser,
        serverConfig,
        signal: controller.signal,
      });
      controller.abort(abortReason);

      await expect(connectionPromise).rejects.toBe(abortReason);
      expect(internals.oauthRecoveries.get(connection)?.promise).toBe(recovery);
      expect(connection.isConnected).not.toHaveBeenCalled();
    });

    it('evicts an inactive cached connection without disconnecting current borrowers', async () => {
      const unusableConnection = {
        disconnect: jest.fn().mockResolvedValue(undefined),
        dispose: jest.fn().mockResolvedValue(undefined),
        isConnected: jest.fn().mockResolvedValue(false),
      } as unknown as MCPConnection;
      const replacementConnection = {
        dispose: jest.fn().mockResolvedValue(undefined),
        isConnected: jest.fn().mockResolvedValue(true),
        on: jest.fn(),
        refreshToolList: jest.fn().mockResolvedValue(undefined),
      } as unknown as MCPConnection;
      mockAppConnections({
        has: jest.fn().mockResolvedValue(false),
      });
      (MCPConnectionFactory.create as jest.Mock).mockResolvedValue(replacementConnection);

      const manager = await MCPManager.createInstance(newMCPServersConfig());
      const lifecycle = manager as unknown as {
        retainConnection: (connection: MCPConnection) => void;
        releaseConnection: (connection: MCPConnection) => Promise<void>;
      };
      (
        manager as unknown as { userConnections: Map<string, Map<string, MCPConnection>> }
      ).userConnections.set(
        mockUser.id,
        new Map([
          [
            getMCPConnectionPoolKey(serverName, STANDARD_MCP_CAPABILITY_PROFILE),
            unusableConnection,
          ],
        ]),
      );
      lifecycle.retainConnection(unusableConnection);

      await expect(
        manager.getUserConnection({
          serverName,
          user: mockUser,
          serverConfig,
        }),
      ).resolves.toBe(replacementConnection);

      expect(unusableConnection.dispose).not.toHaveBeenCalled();
      await lifecycle.releaseConnection(unusableConnection);
      expect(unusableConnection.dispose).toHaveBeenCalledTimes(1);
    });

    it('disposes an inactive cached connection immediately when it has no borrowers', async () => {
      const unusableConnection = {
        disconnect: jest.fn().mockResolvedValue(undefined),
        dispose: jest.fn().mockResolvedValue(undefined),
        isConnected: jest.fn().mockResolvedValue(false),
      } as unknown as MCPConnection;
      const replacementConnection = {
        dispose: jest.fn().mockResolvedValue(undefined),
        isConnected: jest.fn().mockResolvedValue(true),
        on: jest.fn(),
        refreshToolList: jest.fn().mockResolvedValue(undefined),
      } as unknown as MCPConnection;
      mockAppConnections({
        has: jest.fn().mockResolvedValue(false),
      });
      (MCPConnectionFactory.create as jest.Mock).mockResolvedValue(replacementConnection);

      const manager = await MCPManager.createInstance(newMCPServersConfig());
      (
        manager as unknown as { userConnections: Map<string, Map<string, MCPConnection>> }
      ).userConnections.set(
        mockUser.id,
        new Map([
          [
            getMCPConnectionPoolKey(serverName, STANDARD_MCP_CAPABILITY_PROFILE),
            unusableConnection,
          ],
        ]),
      );

      await expect(
        manager.getUserConnection({
          serverName,
          user: mockUser,
          serverConfig,
        }),
      ).resolves.toBe(replacementConnection);

      expect(unusableConnection.dispose).toHaveBeenCalledTimes(1);
    });

    it('evicts an inactive request connection without disconnecting current borrowers', async () => {
      const requestConnection = {
        disconnect: jest.fn().mockResolvedValue(undefined),
        dispose: jest.fn().mockResolvedValue(undefined),
        isConnected: jest.fn().mockResolvedValue(false),
      } as unknown as MCPConnection;
      const replacementConnection = {
        dispose: jest.fn().mockResolvedValue(undefined),
        isConnected: jest.fn().mockResolvedValue(true),
        on: jest.fn(),
        refreshToolList: jest.fn().mockResolvedValue(undefined),
      } as unknown as MCPConnection;
      const requestScopedConnections: t.RequestScopedMCPConnectionStore = {
        connections: new Map([
          [
            getMCPUserConnectionPoolKey(mockUser.id, serverName, STANDARD_MCP_CAPABILITY_PROFILE),
            requestConnection,
          ],
        ]),
        pending: new Map(),
      };
      const bodyScopedConfig: t.ParsedServerConfig = {
        type: 'streamable-http',
        url: 'https://mcp.example.com/{{LIBRECHAT_BODY_MESSAGEID}}',
        source: 'yaml',
        requiresOAuth: false,
      };
      mockAppConnections({
        has: jest.fn().mockResolvedValue(false),
      });
      mockProcessMCPEnv.mockImplementation(({ options, body }) => ({
        ...options,
        ...('url' in options && {
          url: options.url?.replace('{{LIBRECHAT_BODY_MESSAGEID}}', body?.messageId ?? ''),
        }),
      }));
      (MCPConnectionFactory.create as jest.Mock).mockResolvedValue(replacementConnection);

      const manager = await MCPManager.createInstance(newMCPServersConfig());
      const lifecycle = manager as unknown as {
        retainConnection: (connection: MCPConnection) => void;
        releaseConnection: (connection: MCPConnection) => Promise<void>;
      };
      lifecycle.retainConnection(requestConnection);

      await expect(
        manager.getUserConnection({
          serverName,
          user: mockUser,
          serverConfig: bodyScopedConfig,
          requestBody: { messageId: 'message-1' },
          requestScopedConnections,
        }),
      ).resolves.toBe(replacementConnection);

      expect(requestConnection.dispose).not.toHaveBeenCalled();
      await lifecycle.releaseConnection(requestConnection);
      expect(requestConnection.dispose).toHaveBeenCalledTimes(1);
    });

    it('propagates a failed recovery before checking the cached connection', async () => {
      mockAppConnections({
        has: jest.fn().mockResolvedValue(false),
      });
      const manager = await MCPManager.createInstance(newMCPServersConfig());
      const connection = {
        isConnected: jest.fn().mockResolvedValue(true),
      } as unknown as MCPConnection;
      const recoveryError = new Error('OAuth denied');
      const recovery = Promise.reject(recoveryError);
      const internals = manager as unknown as {
        oauthRecoveries: WeakMap<
          MCPConnection,
          { promise: Promise<void>; allowsTakeover: boolean }
        >;
        userConnections: Map<string, Map<string, MCPConnection>>;
      };
      internals.userConnections.set(
        mockUser.id,
        new Map([
          [getMCPConnectionPoolKey(serverName, STANDARD_MCP_CAPABILITY_PROFILE), connection],
        ]),
      );
      internals.oauthRecoveries.set(connection, { promise: recovery, allowsTakeover: true });

      await expect(
        manager.getUserConnection({
          serverName,
          user: mockUser,
          serverConfig,
        }),
      ).rejects.toBe(recoveryError);

      expect(connection.isConnected).not.toHaveBeenCalled();
      expect(MCPConnectionFactory.create).not.toHaveBeenCalled();
    });
  });

  describe('callTool - OBO Integration', () => {
    const mockUser: Partial<IUser> = {
      id: 'user-123',
      provider: 'openid',
      openidId: 'oidc-sub-456',
    };

    const mockFlowManager = {
      getState: jest.fn(),
      setState: jest.fn(),
      clearState: jest.fn(),
    };

    const mockConnection = {
      isConnected: jest.fn().mockResolvedValue(true),
      setRequestHeaders: jest.fn(),
      setOAuthTokens: jest.fn(),
      timeout: 30000,
      client: {
        request: jest.fn().mockResolvedValue({
          content: [{ type: 'text', text: 'Tool result' }],
          isError: false,
        }),
      },
    } as unknown as MCPConnection;

    const mockOboTokenResolver = jest.fn();
    const mockUpstreamTokenProvider = jest.fn().mockResolvedValue({
      access_token: 'live-access-token',
      id_token: 'live-id-token',
      expires_at: Math.floor(Date.now() / 1000) + 3600,
    });

    const serverConfig: t.SSEOptions & { obo: { scopes: string } } = {
      type: 'sse',
      url: 'https://api.example.com',
      headers: {
        Authorization: 'Bearer bootstrap-token',
      },
      obo: {
        scopes: 'api://mcp-server-id/Mcp.Tools.ReadWrite',
      },
    };

    beforeEach(() => {
      mockResolveOboToken.mockReset();
      mockUpstreamTokenProvider.mockClear();
    });

    it('should bypass shared app connections for OBO servers and use a user-scoped connection', async () => {
      const sharedAppConnection = {
        isConnected: jest.fn().mockResolvedValue(true),
        setRequestHeaders: jest.fn(),
        setOAuthTokens: jest.fn(),
        timeout: 30000,
        client: {
          request: jest.fn().mockResolvedValue({
            content: [{ type: 'text', text: 'Shared tool result' }],
            isError: false,
          }),
        },
      } as unknown as MCPConnection;

      const userConnection = {
        isConnected: jest.fn().mockResolvedValue(true),
        setRequestHeaders: jest.fn(),
        setOAuthTokens: jest.fn(),
        timeout: 30000,
        client: {
          request: jest.fn().mockResolvedValue({
            content: [{ type: 'text', text: 'User tool result' }],
            isError: false,
          }),
        },
      } as unknown as MCPConnection;

      const appConnections = {
        get: jest.fn().mockResolvedValue(sharedAppConnection),
      };

      mockResolveOboToken.mockResolvedValue({
        access_token: 'fresh-obo-token',
        token_type: 'Bearer',
        obtained_at: Date.now(),
        expires_at: Date.now() + 3600_000,
      });

      mockAppConnections(appConnections);
      (mockRegistryInstance.getServerConfig as jest.Mock).mockResolvedValue(serverConfig);

      const manager = await MCPManager.createInstance(newMCPServersConfig());
      const getUserConnectionSpy = jest
        .spyOn(manager, 'getUserConnection')
        .mockResolvedValue(userConnection);

      await manager.callTool({
        user: mockUser as IUser,
        serverName,
        toolName: 'test_tool',
        provider: 'openai',
        flowManager: mockFlowManager as unknown as Parameters<
          typeof manager.callTool
        >[0]['flowManager'],
        oboTokenResolver: mockOboTokenResolver,
        upstreamTokenProvider: mockUpstreamTokenProvider,
      });

      expect(appConnections.get).not.toHaveBeenCalled();
      expect(getUserConnectionSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          serverName,
          connectionTarget: { serverConfig, connectionOwner: 'operator' },
          user: mockUser,
        }),
      );
      expect(userConnection.setRequestHeaders as jest.Mock).toHaveBeenCalledWith(
        expect.objectContaining({
          Authorization: 'Bearer fresh-obo-token',
        }),
      );
      expect(sharedAppConnection.setRequestHeaders as jest.Mock).not.toHaveBeenCalled();
      expect(userConnection.client.request as jest.Mock).toHaveBeenCalled();
      expect(sharedAppConnection.client.request as jest.Mock).not.toHaveBeenCalled();
    });

    it('should replace Authorization with the refreshed OBO token on each tool call', async () => {
      mockResolveOboToken.mockResolvedValue({
        access_token: 'fresh-obo-token',
        token_type: 'Bearer',
        obtained_at: Date.now(),
        expires_at: Date.now() + 3600_000,
      });

      const appConnections = {
        get: jest.fn().mockResolvedValue(mockConnection),
      };

      mockAppConnections(appConnections);

      (mockRegistryInstance.getServerConfig as jest.Mock).mockResolvedValue(serverConfig);

      const manager = await MCPManager.createInstance(newMCPServersConfig());
      const getUserConnectionSpy = jest
        .spyOn(manager, 'getUserConnection')
        .mockResolvedValue(mockConnection);

      await manager.callTool({
        user: mockUser as IUser,
        serverName,
        toolName: 'test_tool',
        provider: 'openai',
        flowManager: mockFlowManager as unknown as Parameters<
          typeof manager.callTool
        >[0]['flowManager'],
        oboTokenResolver: mockOboTokenResolver,
        upstreamTokenProvider: mockUpstreamTokenProvider,
      });

      expect(mockResolveOboToken).toHaveBeenCalledWith(
        mockUser,
        serverConfig.obo,
        mockOboTokenResolver,
        mockUpstreamTokenProvider,
        undefined,
        false,
      );
      expect(appConnections.get).not.toHaveBeenCalled();
      expect(getUserConnectionSpy).toHaveBeenCalled();
      expect(mockConnection.setRequestHeaders).toHaveBeenCalledWith(
        expect.objectContaining({
          Authorization: 'Bearer fresh-obo-token',
        }),
      );
      expect(mockConnection.client.request).toHaveBeenCalled();
    });

    it.each([undefined, new Error('owner stopped'), 'stopped'])(
      'detaches a cancelled tool from an uncooperative OBO exchange (%s)',
      async (reason) => {
        const controller = new AbortController();
        mockResolveOboToken.mockImplementationOnce(() => {
          queueMicrotask(() => controller.abort(reason));
          return new Promise(() => {});
        });
        mockAppConnections({ get: jest.fn().mockResolvedValue(mockConnection) });
        (mockRegistryInstance.getServerConfig as jest.Mock).mockResolvedValue(serverConfig);
        const manager = await MCPManager.createInstance(newMCPServersConfig());
        jest.spyOn(manager, 'getUserConnection').mockResolvedValue(mockConnection);
        await expect(
          manager.callTool({
            user: mockUser as IUser,
            serverName,
            toolName: 'test_tool',
            provider: 'openai',
            options: { signal: controller.signal },
            oboTokenResolver: mockOboTokenResolver,
            upstreamTokenProvider: mockUpstreamTokenProvider,
            flowManager: mockFlowManager as unknown as Parameters<
              typeof manager.callTool
            >[0]['flowManager'],
          }),
        ).rejects.toMatchObject({ name: 'AbortError' });
        expect(mockConnection.client.request).not.toHaveBeenCalled();
      },
    );

    it('lazily resolves the upstream provider for an OBO tool call', async () => {
      mockResolveOboToken.mockImplementationOnce(async (_user, _config, _exchange, provider) => {
        await provider();
        return {
          access_token: 'fresh-obo-token',
          token_type: 'Bearer',
          obtained_at: Date.now(),
          expires_at: Date.now() + 3600_000,
        };
      });
      mockAppConnections({ get: jest.fn().mockResolvedValue(mockConnection) });
      (mockRegistryInstance.getServerConfig as jest.Mock).mockResolvedValue(serverConfig);
      const manager = await MCPManager.createInstance(newMCPServersConfig());
      jest.spyOn(manager, 'getUserConnection').mockResolvedValue(mockConnection);
      const upstreamTokenProviderResolver = jest.fn().mockResolvedValue(mockUpstreamTokenProvider);

      await manager.callTool({
        user: mockUser as IUser,
        serverName,
        toolName: 'test_tool',
        provider: 'openai',
        flowManager: mockFlowManager as unknown as Parameters<
          typeof manager.callTool
        >[0]['flowManager'],
        oboTokenResolver: mockOboTokenResolver,
        upstreamTokenProviderResolver,
      });

      expect(upstreamTokenProviderResolver).toHaveBeenCalledTimes(1);
      expect(upstreamTokenProviderResolver).toHaveBeenCalledWith(
        expect.objectContaining({
          target: { mcpServer: serverName, scopes: serverConfig.obo?.scopes },
        }),
      );
      expect(mockResolveOboToken).toHaveBeenCalledWith(
        mockUser,
        serverConfig.obo,
        mockOboTokenResolver,
        expect.any(Function),
        undefined,
        false,
      );
    });

    it('does not resolve an OBO provider for a non-OBO tool call', async () => {
      const directConfig = {
        type: 'streamable-http',
        url: 'https://direct.example.com',
        headers: { Authorization: 'Bearer static-token' },
      } as t.ParsedServerConfig;
      mockAppConnections({ get: jest.fn().mockResolvedValue(mockConnection) });
      (mockRegistryInstance.getServerConfig as jest.Mock).mockResolvedValue(directConfig);
      const manager = await MCPManager.createInstance(newMCPServersConfig());
      jest.spyOn(manager, 'getUserConnection').mockResolvedValue(mockConnection);
      const upstreamTokenProviderResolver = jest.fn();

      await manager.callTool({
        user: mockUser as IUser,
        serverName,
        serverConfig: directConfig,
        toolName: 'test_tool',
        provider: 'openai',
        flowManager: mockFlowManager as unknown as Parameters<
          typeof manager.callTool
        >[0]['flowManager'],
        upstreamTokenProviderResolver,
      });

      expect(upstreamTokenProviderResolver).not.toHaveBeenCalled();
    });

    it('passes the OBO-cleaned config into runtime header processing', async () => {
      const mixedConfig = {
        ...serverConfig,
        source: 'yaml' as const,
        headers: {
          Authorization: 'Bearer {{LIBRECHAT_OPENID_ACCESS_TOKEN}}',
          'X-Service': 'private-mcp',
        },
      };
      mockResolveOboToken.mockResolvedValue({
        access_token: 'fresh-obo-token',
        token_type: 'Bearer',
        obtained_at: Date.now(),
        expires_at: Date.now() + 3600_000,
      });
      (mockRegistryInstance.getServerConfig as jest.Mock).mockResolvedValue(mixedConfig);

      const manager = await MCPManager.createInstance(newMCPServersConfig());
      jest.spyOn(manager, 'getUserConnection').mockResolvedValue(mockConnection);

      await manager.callTool({
        user: mockUser as IUser,
        serverName,
        toolName: 'test_tool',
        provider: 'openai',
        flowManager: mockFlowManager as unknown as Parameters<
          typeof manager.callTool
        >[0]['flowManager'],
        oboTokenResolver: mockOboTokenResolver,
        upstreamTokenProvider: mockUpstreamTokenProvider,
      });

      expect(mockProcessMCPEnv).toHaveBeenCalledWith(
        expect.objectContaining({
          options: expect.objectContaining({
            headers: { 'X-Service': 'private-mcp' },
          }),
        }),
      );
      expect(mockConnection.setRequestHeaders).toHaveBeenCalledWith({
        'X-Service': 'private-mcp',
        Authorization: 'Bearer fresh-obo-token',
      });
    });

    it('should fail closed with a retryable message when per-call OBO refresh has a transient failure', async () => {
      mockResolveOboToken.mockRejectedValue(
        new OboTokenResolutionError(
          'exchange_failed',
          'Temporary OBO token exchange failure.',
          true,
        ),
      );

      const appConnections = {
        get: jest.fn().mockResolvedValue(mockConnection),
      };

      mockAppConnections(appConnections);

      (mockRegistryInstance.getServerConfig as jest.Mock).mockResolvedValue(serverConfig);

      const manager = await MCPManager.createInstance(newMCPServersConfig());
      const getUserConnectionSpy = jest
        .spyOn(manager, 'getUserConnection')
        .mockResolvedValue(mockConnection);

      await expect(
        manager.callTool({
          user: mockUser as IUser,
          serverName,
          toolName: 'test_tool',
          provider: 'openai',
          flowManager: mockFlowManager as unknown as Parameters<
            typeof manager.callTool
          >[0]['flowManager'],
          oboTokenResolver: mockOboTokenResolver,
          upstreamTokenProvider: mockUpstreamTokenProvider,
        }),
      ).rejects.toMatchObject({
        message: expect.stringContaining('Temporary OBO token exchange failure.'),
      });

      expect(appConnections.get).not.toHaveBeenCalled();
      expect(getUserConnectionSpy).toHaveBeenCalled();
      expect(mockConnection.setRequestHeaders).not.toHaveBeenCalled();
      expect(mockConnection.client.request).not.toHaveBeenCalled();
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.stringContaining('[test_tool] Tool call failed'),
        expect.anything(),
      );
    });

    it('should fail closed with a re-authentication message when per-call OBO refresh has a permanent failure', async () => {
      mockResolveOboToken.mockRejectedValue(
        new OboTokenResolutionError(
          'exchange_failed',
          'The identity provider rejected the OBO token exchange.',
        ),
      );

      const appConnections = {
        get: jest.fn().mockResolvedValue(mockConnection),
      };

      mockAppConnections(appConnections);

      (mockRegistryInstance.getServerConfig as jest.Mock).mockResolvedValue(serverConfig);

      const manager = await MCPManager.createInstance(newMCPServersConfig());
      const getUserConnectionSpy = jest
        .spyOn(manager, 'getUserConnection')
        .mockResolvedValue(mockConnection);

      await expect(
        manager.callTool({
          user: mockUser as IUser,
          serverName,
          toolName: 'test_tool',
          provider: 'openai',
          flowManager: mockFlowManager as unknown as Parameters<
            typeof manager.callTool
          >[0]['flowManager'],
          oboTokenResolver: mockOboTokenResolver,
          upstreamTokenProvider: mockUpstreamTokenProvider,
        }),
      ).rejects.toMatchObject({
        message: expect.stringContaining('verify the configured OBO scopes'),
      });

      expect(appConnections.get).not.toHaveBeenCalled();
      expect(getUserConnectionSpy).toHaveBeenCalled();
      expect(mockConnection.setRequestHeaders).not.toHaveBeenCalled();
      expect(mockConnection.client.request).not.toHaveBeenCalled();
    });

    it('should fail with an internal error when upstreamTokenProvider is omitted on an OBO call', async () => {
      const appConnections = {
        get: jest.fn().mockResolvedValue(mockConnection),
      };

      mockAppConnections(appConnections);
      (mockRegistryInstance.getServerConfig as jest.Mock).mockResolvedValue(serverConfig);

      const manager = await MCPManager.createInstance(newMCPServersConfig());
      jest.spyOn(manager, 'getUserConnection').mockResolvedValue(mockConnection);

      await expect(
        manager.callTool({
          user: mockUser as IUser,
          serverName,
          toolName: 'test_tool',
          provider: 'openai',
          flowManager: mockFlowManager as unknown as Parameters<
            typeof manager.callTool
          >[0]['flowManager'],
          oboTokenResolver: mockOboTokenResolver,
          /** upstreamTokenProvider intentionally omitted */
        }),
      ).rejects.toMatchObject({
        cause: expect.objectContaining({ reason: 'missing_upstream_provider', retryable: false }),
      });
      expect(mockResolveOboToken).not.toHaveBeenCalled();
    });

    it.each([true, false])(
      'does not replay an enrolled OBO JSON-RPC invalid_token failure, enrolled=%s',
      async (enrolled) => {
        const failure = new McpError(ErrorCode.InternalError, 'invalid_token');
        const request = jest
          .fn()
          .mockRejectedValueOnce(failure)
          .mockResolvedValueOnce({ content: [{ type: 'text', text: 'retried' }] });
        const connection = {
          isConnected: jest.fn().mockResolvedValue(true),
          setRequestHeaders: jest.fn(),
          setOAuthTokens: jest.fn(),
          isOAuthAuthenticationError: jest.fn().mockReturnValue(true),
          timeout: 30000,
          client: { request },
        } as unknown as MCPConnection;
        mockResolveOboToken.mockResolvedValue({
          access_token: 'current-token',
          token_type: 'Bearer',
          obtained_at: Date.now(),
          expires_at: Date.now() + 3600_000,
        });
        mockAppConnections({ get: jest.fn().mockResolvedValue(connection) });
        (mockRegistryInstance.getServerConfig as jest.Mock).mockResolvedValue(serverConfig);
        const manager = await MCPManager.createInstance(newMCPServersConfig());
        jest.spyOn(manager, 'getUserConnection').mockResolvedValue(connection);
        const authorize = jest.fn(async () => undefined);
        const identity = {
          scheduleId: 's',
          ownerId: String(mockUser.id),
          tenantId: null,
          agentId: 'root',
          invocationMode: 'delegated' as const,
        };
        const result = manager.callTool({
          user: mockUser as IUser,
          serverName,
          toolName: 'test_tool',
          provider: 'openai',
          flowManager: mockFlowManager as unknown as Parameters<
            typeof manager.callTool
          >[0]['flowManager'],
          oboTokenResolver: mockOboTokenResolver,
          upstreamTokenProvider: mockUpstreamTokenProvider,
          scheduledMCPInvocation: { identity, enrolled, agentId: 'root', authorize },
        });
        if (enrolled) await expect(result).rejects.toBe(failure);
        else await expect(result).resolves.toBeDefined();
        expect(request).toHaveBeenCalledTimes(enrolled ? 1 : 2);
        expect(authorize).toHaveBeenCalledTimes(enrolled ? 1 : 2);
        expect(mockResolveOboToken).toHaveBeenCalledTimes(enrolled ? 1 : 2);
      },
    );

    it('re-exchanges past the token cache when the server rejects the bearer mid-call', async () => {
      const authError = new Error('HTTP 401 Unauthorized');
      const rejectingConnection = {
        isConnected: jest.fn().mockResolvedValue(true),
        setRequestHeaders: jest.fn(),
        setOAuthTokens: jest.fn(),
        isOAuthAuthenticationError: jest.fn().mockReturnValue(true),
        timeout: 30000,
        client: {
          request: jest
            .fn()
            .mockRejectedValueOnce(authError)
            .mockResolvedValueOnce({
              content: [{ type: 'text', text: 'Tool result' }],
              isError: false,
            }),
        },
      } as unknown as MCPConnection;

      mockResolveOboToken
        .mockResolvedValueOnce({
          access_token: 'rejected-obo-token',
          token_type: 'Bearer',
          obtained_at: Date.now(),
          expires_at: Date.now() + 3600_000,
        })
        .mockResolvedValueOnce({
          access_token: 'reminted-obo-token',
          token_type: 'Bearer',
          obtained_at: Date.now(),
          expires_at: Date.now() + 3600_000,
        });

      mockAppConnections({ get: jest.fn().mockResolvedValue(rejectingConnection) });
      (mockRegistryInstance.getServerConfig as jest.Mock).mockResolvedValue(serverConfig);

      const manager = await MCPManager.createInstance(newMCPServersConfig());
      jest.spyOn(manager, 'getUserConnection').mockResolvedValue(rejectingConnection);

      await manager.callTool({
        user: mockUser as IUser,
        serverName,
        toolName: 'test_tool',
        provider: 'openai',
        flowManager: mockFlowManager as unknown as Parameters<
          typeof manager.callTool
        >[0]['flowManager'],
        oboTokenResolver: mockOboTokenResolver,
        upstreamTokenProvider: mockUpstreamTokenProvider,
      });

      /** The rejected token is still inside its cached lifetime, so the cache is bypassed. */
      expect(mockResolveOboToken).toHaveBeenNthCalledWith(
        2,
        mockUser,
        serverConfig.obo,
        mockOboTokenResolver,
        mockUpstreamTokenProvider,
        undefined,
        true,
      );
      expect(rejectingConnection.setRequestHeaders as jest.Mock).toHaveBeenLastCalledWith(
        expect.objectContaining({ Authorization: 'Bearer reminted-obo-token' }),
      );
      /**
       * A legacy SSE event stream reads its bearer from `oauthTokens` at transport
       * construction and never sees runtime request headers, so leaving the rejected
       * credential there would 401 the next rebuild and retire a recovered connection.
       */
      expect(rejectingConnection.setOAuthTokens as jest.Mock).toHaveBeenLastCalledWith(
        expect.objectContaining({ access_token: 'reminted-obo-token' }),
      );
      expect((rejectingConnection.client.request as jest.Mock).mock.calls).toHaveLength(2);
    });

    it('does not retry a non-auth failure', async () => {
      const toolError = new Error('tool blew up');
      const failingConnection = {
        isConnected: jest.fn().mockResolvedValue(true),
        setRequestHeaders: jest.fn(),
        setOAuthTokens: jest.fn(),
        isOAuthAuthenticationError: jest.fn().mockReturnValue(false),
        timeout: 30000,
        client: { request: jest.fn().mockRejectedValue(toolError) },
      } as unknown as MCPConnection;

      mockResolveOboToken.mockResolvedValue({
        access_token: 'fresh-obo-token',
        token_type: 'Bearer',
        obtained_at: Date.now(),
        expires_at: Date.now() + 3600_000,
      });

      mockAppConnections({ get: jest.fn().mockResolvedValue(failingConnection) });
      (mockRegistryInstance.getServerConfig as jest.Mock).mockResolvedValue(serverConfig);

      const manager = await MCPManager.createInstance(newMCPServersConfig());
      jest.spyOn(manager, 'getUserConnection').mockResolvedValue(failingConnection);

      await expect(
        manager.callTool({
          user: mockUser as IUser,
          serverName,
          toolName: 'test_tool',
          provider: 'openai',
          flowManager: mockFlowManager as unknown as Parameters<
            typeof manager.callTool
          >[0]['flowManager'],
          oboTokenResolver: mockOboTokenResolver,
          upstreamTokenProvider: mockUpstreamTokenProvider,
        }),
      ).rejects.toThrow('tool blew up');

      expect(mockResolveOboToken).toHaveBeenCalledTimes(1);
      expect((failingConnection.client.request as jest.Mock).mock.calls).toHaveLength(1);
    });
  });

  describe('direct OpenID bearer recovery', () => {
    const serverName = 'direct-bearer-server';
    const serverConfig = {
      type: 'streamable-http' as const,
      url: 'https://api.example.com/mcp',
      source: 'yaml' as const,
      headers: { Authorization: 'Bearer {{LIBRECHAT_OPENID_ACCESS_TOKEN}}' },
    };
    const user = {
      id: 'direct-user',
      provider: 'openid',
      openidId: 'direct-subject',
    } as IUser;

    it.each(['headers', 'requestHeaders'] as const)(
      'refreshes %s without replaying a rejected tool call or losing its declaration',
      async (headerMap) => {
        const declared: t.ParsedServerConfig = {
          ...serverConfig,
          headers: undefined,
          [headerMap]: serverConfig.headers,
          ...(headerMap === 'requestHeaders' && {
            apiKey: {
              source: 'admin' as const,
              authorization_type: 'bearer' as const,
              key: 'catalog-key',
            },
          }),
        };
        const rejection = Object.assign(new Error('HTTP 401 Unauthorized'), { status: 401 });
        const connection = {
          isConnected: jest.fn().mockResolvedValue(true),
          setRequestHeaders: jest.fn(),
          stopReconnecting: jest.fn(),
          isOAuthAuthenticationError: jest.fn().mockReturnValue(true),
          timeout: 30000,
          client: { request: jest.fn().mockRejectedValue(rejection) },
        } as unknown as MCPConnection;
        const replacement = {
          isConnected: jest.fn().mockResolvedValue(true),
        } as unknown as MCPConnection;
        const upstreamTokenProvider = jest
          .fn()
          .mockResolvedValueOnce({ access_token: 'current-token' })
          .mockResolvedValueOnce({ access_token: 'refreshed-token' });

        (graphUtils.preProcessGraphTokens as jest.Mock).mockImplementation(
          async (config) => config,
        );
        (mockRegistryInstance.getServerConfig as jest.Mock).mockResolvedValue(declared);
        const manager = await MCPManager.createInstance(newMCPServersConfig());
        const getUserConnection = jest
          .spyOn(manager, 'getUserConnection')
          .mockResolvedValueOnce(connection)
          .mockResolvedValueOnce(replacement);

        await expect(
          manager.callTool({
            user,
            serverName,
            toolName: 'mutating_tool',
            provider: 'openai',
            flowManager: {} as Parameters<typeof manager.callTool>[0]['flowManager'],
            upstreamTokenProvider,
          }),
        ).rejects.toMatchObject({
          code: 'MCP_AUTHENTICATION_REJECTED',
          connectionRefreshed: true,
        } satisfies Partial<MCPAuthenticationRejectedError>);

        expect(connection.client.request).toHaveBeenCalledTimes(1);
        expect(upstreamTokenProvider).toHaveBeenNthCalledWith(2, {
          forceRefresh: true,
          signal: expect.any(AbortSignal),
        });
        expect(connection.stopReconnecting).toHaveBeenCalled();
        expect(getUserConnection).toHaveBeenLastCalledWith(
          expect.objectContaining({
            forceNew: true,
            serverConfig: declared,
            directBearerRecoveryState: expect.objectContaining({ attempted: true }),
            directBearerResolvedConfig: expect.objectContaining({
              headers: { Authorization: 'Bearer refreshed-token' },
            }),
          }),
        );
      },
    );

    it('preserves a JSON-RPC tool failure that mentions downstream authentication', async () => {
      const toolError = new McpError(ErrorCode.InternalError, 'downstream HTTP 401 invalid_token');
      const connection = {
        isConnected: jest.fn().mockResolvedValue(true),
        setRequestHeaders: jest.fn(),
        stopReconnecting: jest.fn(),
        timeout: 30000,
        client: { request: jest.fn().mockRejectedValue(toolError) },
      } as unknown as MCPConnection;
      const upstreamTokenProvider = jest.fn().mockResolvedValue({ access_token: 'valid-token' });
      (graphUtils.preProcessGraphTokens as jest.Mock).mockImplementation(async (config) => config);
      const manager = await MCPManager.createInstance(newMCPServersConfig());
      const checkout = jest.spyOn(manager, 'getConnection').mockResolvedValue(connection);
      await expect(
        manager.callTool({
          user,
          serverName,
          serverConfig,
          toolName: 'mutating_tool',
          provider: 'openai',
          flowManager: {} as Parameters<typeof manager.callTool>[0]['flowManager'],
          upstreamTokenProvider,
        }),
      ).rejects.toBe(toolError);
      expect(checkout).toHaveBeenCalledTimes(1);
      expect(connection.stopReconnecting).not.toHaveBeenCalled();
      expect(upstreamTokenProvider).not.toHaveBeenCalledWith({ forceRefresh: true });
    });

    it('reuses a recovered checkout bearer for the first tool request without another session read', async () => {
      const makeConnection = () =>
        ({
          isConnected: jest.fn().mockResolvedValue(true),
          isStale: jest.fn().mockReturnValue(false),
          setRequestHeaders: jest.fn(),
          on: jest.fn(),
          removeAllListeners: jest.fn(),
          dispose: jest.fn().mockResolvedValue(undefined),
          timeout: 30000,
          refreshToolList: jest.fn().mockResolvedValue({ tools: [], complete: true }),
          client: {
            request: jest.fn().mockResolvedValue({ content: [{ type: 'text', text: 'done' }] }),
          },
        }) as unknown as MCPConnection;
      const rejected = makeConnection();
      const replacement = makeConnection();
      (rejected.refreshToolList as jest.Mock).mockResolvedValue({
        tools: [],
        complete: false,
        authenticationError: Object.assign(new Error('unauthorized'), { status: 401 }),
      });
      const upstreamTokenProvider = jest
        .fn()
        .mockResolvedValueOnce({ access_token: 'stale-token' })
        .mockResolvedValueOnce({ access_token: 'fresh-token' });
      (graphUtils.preProcessGraphTokens as jest.Mock).mockImplementation(async (config) => config);
      mockAppConnections({ has: jest.fn().mockResolvedValue(false) });
      (mockRegistryInstance.getServerConfig as jest.Mock).mockResolvedValue(serverConfig);
      (MCPConnectionFactory.create as jest.Mock)
        .mockResolvedValueOnce(rejected)
        .mockResolvedValueOnce(replacement);
      const manager = await MCPManager.createInstance(newMCPServersConfig());
      await manager.callTool({
        user,
        serverName,
        serverConfig,
        toolName: 'mutating_tool',
        provider: 'openai',
        flowManager: {} as Parameters<typeof manager.callTool>[0]['flowManager'],
        upstreamTokenProvider,
      });
      expect(upstreamTokenProvider.mock.calls).toEqual([
        [{ forceRefresh: false }],
        [{ forceRefresh: true }],
      ]);
      expect(replacement.setRequestHeaders).toHaveBeenCalledWith({
        Authorization: 'Bearer fresh-token',
      });
      expect(rejected.client.request).not.toHaveBeenCalled();
      expect(replacement.client.request).toHaveBeenCalledTimes(1);
    });

    it('shares a checkout recovery budget with the rejected tool call', async () => {
      const rejection = Object.assign(new Error('HTTP 401 Unauthorized'), { status: 401 });
      const connection = {
        isConnected: jest.fn().mockResolvedValue(true),
        setRequestHeaders: jest.fn(),
        stopReconnecting: jest.fn(),
        isOAuthAuthenticationError: jest.fn().mockReturnValue(true),
        timeout: 30000,
        client: { request: jest.fn().mockRejectedValue(rejection) },
      } as unknown as MCPConnection;
      const upstreamTokenProvider = jest.fn().mockResolvedValue({ access_token: 'fresh-token' });

      (graphUtils.preProcessGraphTokens as jest.Mock).mockImplementation(async (config) => config);
      (mockRegistryInstance.getServerConfig as jest.Mock).mockResolvedValue(serverConfig);
      const manager = await MCPManager.createInstance(newMCPServersConfig());
      const getUserConnection = jest
        .spyOn(manager, 'getUserConnection')
        .mockImplementation(async (options) => {
          options.directBearerRecoveryState!.attempted = true;
          return connection;
        });

      await expect(
        manager.callTool({
          user,
          serverName,
          toolName: 'mutating_tool',
          provider: 'openai',
          flowManager: {} as Parameters<typeof manager.callTool>[0]['flowManager'],
          upstreamTokenProvider,
        }),
      ).rejects.toMatchObject({
        code: 'MCP_AUTHENTICATION_REJECTED',
        connectionRefreshed: false,
      } satisfies Partial<MCPAuthenticationRejectedError>);

      expect(connection.client.request).toHaveBeenCalledTimes(1);
      expect(connection.stopReconnecting).not.toHaveBeenCalled();
      expect(getUserConnection).toHaveBeenCalledTimes(1);
      expect(upstreamTokenProvider).toHaveBeenCalledTimes(1);
      expect(upstreamTokenProvider).not.toHaveBeenCalledWith({ forceRefresh: true });
    });

    it('propagates direct recovery registered during the base cached checkout', async () => {
      let finishConnectionCheck: ((connected: boolean) => void) | undefined;
      const connectionCheck = new Promise<boolean>((resolve) => {
        finishConnectionCheck = resolve;
      });
      const connection = {
        capabilityProfile: STANDARD_MCP_CAPABILITY_PROFILE,
        isConnected: jest.fn().mockReturnValueOnce(connectionCheck).mockResolvedValue(true),
        isStale: jest.fn().mockReturnValue(false),
      } as unknown as MCPConnection;
      let finishRecovery: (() => void) | undefined;
      const recovery = new Promise<void>((resolve) => {
        finishRecovery = resolve;
      });

      mockAppConnections({ has: jest.fn().mockResolvedValue(false) });
      (mockRegistryInstance.getServerConfig as jest.Mock).mockResolvedValue(serverConfig);
      const manager = await MCPManager.createInstance(newMCPServersConfig());
      const internals = manager as unknown as {
        userConnections: Map<string, Map<string, MCPConnection>>;
        oauthRecoveries: WeakMap<
          MCPConnection,
          {
            promise: Promise<void>;
            allowsTakeover: boolean;
            directBearerRecoveryConsumed: boolean;
            directBearerRecoveryState?: t.DirectBearerRecoveryState;
          }
        >;
      };
      internals.userConnections.set(
        user.id,
        new Map([
          [getMCPConnectionPoolKey(serverName, STANDARD_MCP_CAPABILITY_PROFILE), connection],
        ]),
      );
      const directBearerRecoveryState: t.DirectBearerRecoveryState = { attempted: false };
      const sharedState: t.DirectBearerRecoveryState = { attempted: true };

      const checkout = manager.getUserConnection({
        serverName,
        serverConfig,
        user,
        directBearerRecoveryState,
      });
      while ((connection.isConnected as jest.Mock).mock.calls.length === 0) {
        await new Promise((resolve) => setImmediate(resolve));
      }
      internals.oauthRecoveries.set(connection, {
        promise: recovery,
        allowsTakeover: false,
        directBearerRecoveryConsumed: true,
        directBearerRecoveryState: sharedState,
      });
      finishConnectionCheck?.(true);
      await new Promise((resolve) => setImmediate(resolve));

      expect(directBearerRecoveryState.attempted).toBe(true);
      internals.oauthRecoveries.delete(connection);
      sharedState.resolvedConfig = {
        ...serverConfig,
        headers: { Authorization: 'Bearer recovered-token' },
      };
      finishRecovery?.();

      await expect(checkout).resolves.toBe(connection);
      expect(connection.isConnected).toHaveBeenCalledTimes(2);
      expect(directBearerRecoveryState.resolvedConfig).toBe(sharedState.resolvedConfig);
    });

    it.each([false, true])(
      'propagates a connection leader recovery budget to a pending checkout joiner (request-scoped=%s)',
      async (requestScoped) => {
        const rejection = Object.assign(new Error('HTTP 401 Unauthorized'), { status: 401 });
        const checkoutConfig = requestScoped
          ? {
              ...serverConfig,
              headers: {
                ...serverConfig.headers,
                'X-Conversation': '{{LIBRECHAT_BODY_CONVERSATIONID}}',
              },
            }
          : serverConfig;
        const requestScopedConnections = requestScoped
          ? {
              connections: new Map<string, unknown>(),
              pending: new Map<string, Promise<unknown>>(),
            }
          : undefined;
        const connection = {
          isConnected: jest.fn().mockResolvedValue(true),
          isStale: jest.fn().mockReturnValue(false),
          setRequestHeaders: jest.fn(),
          stopReconnecting: jest.fn(),
          isOAuthAuthenticationError: jest.fn().mockReturnValue(true),
          refreshToolList: jest.fn().mockResolvedValue({ tools: [], complete: true }),
          on: jest.fn(),
          removeAllListeners: jest.fn(),
          dispose: jest.fn().mockResolvedValue(undefined),
          timeout: 30000,
          client: { request: jest.fn().mockRejectedValue(rejection) },
        } as unknown as MCPConnection;
        const upstreamTokenProvider = jest.fn().mockResolvedValue({ access_token: 'fresh-token' });
        let releaseCreation: (() => void) | undefined;
        const creationGate = new Promise<void>((resolve) => {
          releaseCreation = resolve;
        });

        (graphUtils.preProcessGraphTokens as jest.Mock).mockImplementation(
          async (config) => config,
        );
        (mockRegistryInstance.getServerConfig as jest.Mock).mockResolvedValue(checkoutConfig);
        mockAppConnections({ has: jest.fn().mockResolvedValue(false) });
        (MCPConnectionFactory.create as jest.Mock).mockImplementation(
          async (basic: t.BasicConnectionOptions) => {
            basic.directBearerRecoveryState!.attempted = true;
            await creationGate;
            return connection;
          },
        );
        const manager = await MCPManager.createInstance(newMCPServersConfig());
        const invocation = () =>
          manager.callTool({
            user,
            serverName,
            serverConfig: checkoutConfig,
            toolName: 'mutating_tool',
            provider: 'openai',
            requestBody: requestScoped ? { conversationId: 'conversation-1' } : undefined,
            requestScopedConnections,
            flowManager: {} as Parameters<typeof manager.callTool>[0]['flowManager'],
            upstreamTokenProvider,
          });

        const leader = invocation();
        while ((MCPConnectionFactory.create as jest.Mock).mock.calls.length === 0) {
          await new Promise((resolve) => setImmediate(resolve));
        }
        const joiner = invocation();
        await new Promise((resolve) => setImmediate(resolve));
        releaseCreation?.();

        await Promise.all([
          expect(leader).rejects.toMatchObject({
            code: 'MCP_AUTHENTICATION_REJECTED',
            connectionRefreshed: false,
          }),
          expect(joiner).rejects.toMatchObject({
            code: 'MCP_AUTHENTICATION_REJECTED',
            connectionRefreshed: false,
          }),
        ]);
        expect(MCPConnectionFactory.create).toHaveBeenCalledTimes(1);
        expect(connection.client.request).toHaveBeenCalledTimes(2);
        expect(upstreamTokenProvider).toHaveBeenCalledTimes(1);
        expect(upstreamTokenProvider).not.toHaveBeenCalledWith({ forceRefresh: true });
      },
    );

    it('propagates an active direct recovery budget to a checkout waiter', async () => {
      const rejection = Object.assign(new Error('HTTP 401 Unauthorized'), { status: 401 });
      const oldConnection = {
        isConnected: jest.fn().mockResolvedValue(false),
      } as unknown as MCPConnection;
      const replacement = {
        isConnected: jest.fn().mockResolvedValue(true),
        setRequestHeaders: jest.fn(),
        stopReconnecting: jest.fn(),
        isOAuthAuthenticationError: jest.fn().mockReturnValue(true),
        timeout: 30000,
        client: { request: jest.fn().mockRejectedValue(rejection) },
      } as unknown as MCPConnection;
      const upstreamTokenProvider = jest.fn().mockResolvedValue({ access_token: 'fresh-token' });

      (graphUtils.preProcessGraphTokens as jest.Mock).mockImplementation(async (config) => config);
      (mockRegistryInstance.getServerConfig as jest.Mock).mockResolvedValue(serverConfig);
      const manager = await MCPManager.createInstance(newMCPServersConfig());
      jest
        .spyOn(manager, 'getConnection')
        .mockResolvedValueOnce(oldConnection)
        .mockResolvedValueOnce(replacement);
      (
        manager as unknown as {
          oauthRecoveries: WeakMap<
            MCPConnection,
            {
              promise: Promise<void>;
              allowsTakeover: boolean;
              directBearerRecoveryConsumed: boolean;
            }
          >;
        }
      ).oauthRecoveries.set(oldConnection, {
        promise: Promise.resolve(),
        allowsTakeover: false,
        directBearerRecoveryConsumed: true,
      });

      await expect(
        manager.callTool({
          user,
          serverName,
          serverConfig,
          toolName: 'mutating_tool',
          provider: 'openai',
          flowManager: {} as Parameters<typeof manager.callTool>[0]['flowManager'],
          upstreamTokenProvider,
        }),
      ).rejects.toMatchObject({
        code: 'MCP_AUTHENTICATION_REJECTED',
        connectionRefreshed: false,
      });
      expect(replacement.client.request).toHaveBeenCalledTimes(1);
      expect(replacement.stopReconnecting).not.toHaveBeenCalled();
      expect(upstreamTokenProvider).not.toHaveBeenCalledWith({ forceRefresh: true });
    });

    it('installs an ephemeral replacement in the request-scoped store without leaking the old connection', async () => {
      const rejection = Object.assign(new Error('HTTP 401 Unauthorized'), { status: 401 });
      const scopedConfig = {
        ...serverConfig,
        headers: {
          Authorization: 'Bearer {{LIBRECHAT_OPENID_ACCESS_TOKEN}}',
          'X-Conversation': '{{LIBRECHAT_BODY_CONVERSATIONID}}',
        },
      };
      const connection = {
        capabilityProfile: STANDARD_MCP_CAPABILITY_PROFILE,
        isConnected: jest.fn().mockResolvedValue(true),
        setRequestHeaders: jest.fn(),
        stopReconnecting: jest.fn(),
        isOAuthAuthenticationError: jest.fn().mockReturnValue(true),
        timeout: 30000,
        client: { request: jest.fn().mockRejectedValue(rejection) },
      } as unknown as MCPConnection;
      const replacement = {
        isConnected: jest.fn().mockResolvedValue(true),
      } as unknown as MCPConnection;
      const requestScopedConnections = {
        connections: new Map([
          [
            getMCPUserConnectionPoolKey(user.id, serverName, STANDARD_MCP_CAPABILITY_PROFILE),
            connection,
          ],
        ]),
        pending: new Map(),
      };
      const upstreamTokenProvider = jest
        .fn()
        .mockResolvedValueOnce({ access_token: 'current-token' })
        .mockResolvedValueOnce({ access_token: 'refreshed-token' });

      (graphUtils.preProcessGraphTokens as jest.Mock).mockImplementation(async (config) => config);
      (mockRegistryInstance.getServerConfig as jest.Mock).mockResolvedValue(scopedConfig);
      const manager = await MCPManager.createInstance(newMCPServersConfig());
      const disposeEvicted = jest
        .spyOn(
          manager as unknown as {
            disposeEvictedConnection: (
              connection: MCPConnection,
              logPrefix: string,
            ) => Promise<void>;
          },
          'disposeEvictedConnection',
        )
        .mockResolvedValue(undefined);
      jest
        .spyOn(manager, 'getUserConnection')
        .mockResolvedValueOnce(connection)
        .mockImplementationOnce(async () => {
          requestScopedConnections.connections.set(
            getMCPUserConnectionPoolKey(user.id, serverName, STANDARD_MCP_CAPABILITY_PROFILE),
            replacement,
          );
          return replacement;
        });

      await expect(
        manager.callTool({
          user,
          serverName,
          serverConfig: scopedConfig,
          toolName: 'mutating_tool',
          provider: 'openai',
          requestBody: { conversationId: 'conversation-1' } as Parameters<
            typeof manager.callTool
          >[0]['requestBody'],
          requestScopedConnections,
          flowManager: {} as Parameters<typeof manager.callTool>[0]['flowManager'],
          upstreamTokenProvider,
        }),
      ).rejects.toMatchObject({ code: 'MCP_AUTHENTICATION_REJECTED' });

      expect(disposeEvicted).toHaveBeenCalledWith(
        connection,
        expect.stringContaining('Request-scoped'),
      );
      expect(
        requestScopedConnections.connections.get(
          getMCPUserConnectionPoolKey(user.id, serverName, STANDARD_MCP_CAPABILITY_PROFILE),
        ),
      ).toBe(replacement);
      expect(connection.client.request).toHaveBeenCalledTimes(1);
    });

    it.each(['before', 'refresh', 'drain'] as const)(
      'stops direct-bearer recovery when cancelled during %s',
      async (abortAt) => {
        const controller = new AbortController();
        const cancelled = new Error('request stopped');
        const connection = {
          capabilityProfile: STANDARD_MCP_CAPABILITY_PROFILE,
          stopReconnecting: jest.fn(),
        } as unknown as MCPConnection;
        const upstreamTokenProvider = jest.fn(async () => {
          if (abortAt === 'refresh') {
            controller.abort(cancelled);
          }
          return { access_token: 'fresh-token' };
        });
        const manager = await MCPManager.createInstance(newMCPServersConfig());
        const getUserConnection = jest.spyOn(manager, 'getUserConnection');
        const internals = manager as unknown as {
          waitForConnectionBorrowersToDrain: (connection: MCPConnection) => Promise<void>;
          recoverDirectOpenIDBearerConnection: (args: {
            connection: MCPConnection;
            serverName: string;
            serverConfig: t.ParsedServerConfig;
            user: IUser;
            flowManager: Parameters<typeof manager.callTool>[0]['flowManager'];
            upstreamTokenProvider: NonNullable<
              Parameters<typeof manager.callTool>[0]['upstreamTokenProvider']
            >;
            signal: AbortSignal;
          }) => Promise<void>;
        };
        jest.spyOn(internals, 'waitForConnectionBorrowersToDrain').mockImplementation(async () => {
          if (abortAt === 'drain') {
            controller.abort(cancelled);
          }
        });
        if (abortAt === 'before') {
          controller.abort(cancelled);
        }

        await expect(
          internals.recoverDirectOpenIDBearerConnection({
            connection,
            serverName,
            serverConfig,
            user,
            flowManager: {} as Parameters<typeof manager.callTool>[0]['flowManager'],
            upstreamTokenProvider,
            signal: controller.signal,
          }),
        ).rejects.toBe(cancelled);
        await new Promise((resolve) => setImmediate(resolve));

        expect(upstreamTokenProvider).toHaveBeenCalledTimes(abortAt === 'before' ? 0 : 1);
        expect(getUserConnection).not.toHaveBeenCalled();
      },
    );

    it.each(['refresh', 'drain', 'initialize'] as const)(
      'keeps shared recovery alive after its leader aborts during %s',
      async (stage) => {
        const leaderAbort = new AbortController();
        const waiterAbort = new AbortController();
        let entered!: () => void;
        let finish!: () => void;
        const started = new Promise<void>((resolve) => {
          entered = resolve;
        });
        const gate = new Promise<void>((resolve) => {
          finish = resolve;
        });
        const pause = async () => {
          entered();
          await gate;
        };
        const connection = {
          capabilityProfile: STANDARD_MCP_CAPABILITY_PROFILE,
          stopReconnecting: jest.fn(),
        } as unknown as MCPConnection;
        const replacement = {} as MCPConnection;
        const upstreamTokenProvider = jest.fn(async () => {
          if (stage === 'refresh') {
            await pause();
          }
          return { access_token: 'fresh-token' };
        });
        const manager = await MCPManager.createInstance(newMCPServersConfig());
        jest
          .spyOn(
            manager as unknown as {
              waitForConnectionBorrowersToDrain: (connection: MCPConnection) => Promise<void>;
            },
            'waitForConnectionBorrowersToDrain',
          )
          .mockImplementation(async () => {
            if (stage === 'drain') {
              await pause();
            }
          });
        const getConnection = jest
          .spyOn(manager, 'getUserConnection')
          .mockImplementation(async (options) => {
            if (stage === 'initialize') {
              await pause();
            }
            options.signal?.throwIfAborted();
            return replacement;
          });
        const options = {
          connection,
          serverName,
          serverConfig,
          user,
          flowManager: {} as Parameters<typeof manager.callTool>[0]['flowManager'],
          upstreamTokenProvider,
        };
        const leader = manager['recoverDirectOpenIDBearerConnection']({
          ...options,
          signal: leaderAbort.signal,
        });
        const leaderOutcome = leader.catch((error: Error) => error);
        await started;
        const waiter = manager['recoverDirectOpenIDBearerConnection']({
          ...options,
          signal: waiterAbort.signal,
        });
        leaderAbort.abort(new Error('leader stopped'));
        await expect(leaderOutcome).resolves.toMatchObject({ message: 'leader stopped' });
        finish();
        await expect(waiter).resolves.toBeUndefined();
        expect(upstreamTokenProvider).toHaveBeenCalledTimes(1);
        expect(getConnection).toHaveBeenCalledTimes(1);
        expect(getConnection.mock.calls[0][0].signal?.aborted).toBe(false);
      },
    );

    it.each([true, false])(
      'accounts for a borrower before it can join recovery (joins=%s)',
      async (joins) => {
        const manager = await MCPManager.createInstance(newMCPServersConfig());
        const connection = {
          capabilityProfile: STANDARD_MCP_CAPABILITY_PROFILE,
          stopReconnecting: jest.fn(),
        } as unknown as MCPConnection;
        const controller = new AbortController();
        let finish!: () => void;
        let entered!: () => void;
        const gate = new Promise<void>((resolve) => {
          finish = resolve;
        });
        const started = new Promise<void>((resolve) => {
          entered = resolve;
        });
        const upstreamTokenProvider = jest.fn(async () => {
          entered();
          await gate;
          return { access_token: 'fresh-token' };
        });
        const getConnection = jest
          .spyOn(manager, 'getUserConnection')
          .mockResolvedValue({} as MCPConnection);
        manager['retainConnection'](connection);
        const options = {
          connection,
          serverName,
          serverConfig,
          user,
          upstreamTokenProvider,
          flowManager: {} as Parameters<typeof manager.callTool>[0]['flowManager'],
        };
        const leader = manager['recoverDirectOpenIDBearerConnection']({
          ...options,
          signal: controller.signal,
        });
        const outcome = leader.catch((error: Error) => error);
        await started;
        controller.abort(new Error('leader stopped'));
        await expect(outcome).resolves.toMatchObject({ message: 'leader stopped' });
        const waiter = joins ? manager['recoverDirectOpenIDBearerConnection'](options) : undefined;
        await manager['releaseConnection'](connection);
        finish();
        if (waiter) {
          await expect(waiter).resolves.toBeUndefined();
        }
        await new Promise((resolve) => setImmediate(resolve));
        expect(getConnection).toHaveBeenCalledTimes(joins ? 1 : 0);
        expect(upstreamTokenProvider).toHaveBeenCalledTimes(1);
      },
    );

    it('fences a delayed direct-bearer replacement when the server config mutates', async () => {
      const connection = {
        capabilityProfile: STANDARD_MCP_CAPABILITY_PROFILE,
        stopReconnecting: jest.fn(),
      } as unknown as MCPConnection;
      let finishRefresh: ((tokens: { access_token: string }) => void) | undefined;
      const forcedRefresh = new Promise<{ access_token: string }>((resolve) => {
        finishRefresh = resolve;
      });
      const upstreamTokenProvider = jest.fn().mockReturnValue(forcedRefresh);

      const manager = await MCPManager.createInstance(newMCPServersConfig());
      const getUserConnection = jest.spyOn(manager, 'getUserConnection');
      const recovery = (
        manager as unknown as {
          recoverDirectOpenIDBearerConnection: (args: {
            connection: MCPConnection;
            serverName: string;
            serverConfig: t.ParsedServerConfig;
            user: IUser;
            flowManager: Parameters<typeof manager.callTool>[0]['flowManager'];
            upstreamTokenProvider: NonNullable<
              Parameters<typeof manager.callTool>[0]['upstreamTokenProvider']
            >;
          }) => Promise<void>;
        }
      ).recoverDirectOpenIDBearerConnection({
        connection,
        serverName,
        serverConfig,
        user,
        flowManager: {} as Parameters<typeof manager.callTool>[0]['flowManager'],
        upstreamTokenProvider,
      });
      while (upstreamTokenProvider.mock.calls.length === 0) {
        await new Promise((resolve) => setImmediate(resolve));
      }

      await manager.disconnectUserConnection(user.id, serverName);
      finishRefresh?.({ access_token: 'fresh-token' });

      await expect(recovery).rejects.toThrow('cancelled during teardown');
      expect(getUserConnection).not.toHaveBeenCalled();
      expect(connection.stopReconnecting).toHaveBeenCalledTimes(1);
    });
  });

  describe('MCP App operations', () => {
    const user = { id: 'user-123', role: 'ADMIN' } as IUser & { id: string };
    const flowManager = {} as Parameters<MCPManager['readResource']>[0]['flowManager'];
    const appBindingCodec = {
      create: jest.fn(() => 'binding'),
      verify: jest.fn(() => true),
    };
    const createAppManager = (configs: t.MCPServers) =>
      MCPManager.createInstance(configs, { appBindingCodec });
    const defaultOAuthCredentialsChanging = jest.fn(async () => async () => undefined);

    const context = (
      serverName: string,
      config: t.ParsedServerConfig,
      extra: Partial<Parameters<MCPManager['readResource']>[0]> = {},
    ) => ({
      serverName,
      serverBinding: 'binding',
      user,
      connectionTarget: {
        serverConfig: config,
        connectionOwner: config.requiresOAuth ? ('principal' as const) : ('operator' as const),
      },
      allowlists: {
        allowedDomains: null,
        allowedAddresses: null,
        useSSRFProtection: false,
      },
      flowManager,
      onOAuthCredentialsChanging: defaultOAuthCredentialsChanging,
      ...extra,
    });

    const connection = (request: jest.Mock, tools = [{ name: 'do_thing', _meta: {} }]) =>
      ({
        capabilityProfile: MCP_APPS_CAPABILITY_PROFILE,
        createdAt: 1,
        toolListVersion: 1,
        isConnected: jest.fn().mockResolvedValue(true),
        getLastConnectionCheckError: jest.fn(),
        isOAuthAuthenticationError: jest.fn((error: { status?: number }) => error?.status === 401),
        usesOAuth: jest.fn().mockReturnValue(false),
        setRequestHeaders: jest.fn(),
        getMCPAppRuntimeTarget: jest.fn(() => ({
          type: 'sse',
          url: 'https://example.com/mcp',
        })),
        fetchOrderedToolsSnapshot: jest.fn().mockResolvedValue({ tools, complete: true }),
        timeout: 30_000,
        client: fakeClient(request),
      }) as unknown as MCPConnection;

    const newOAuthConnection = (request: jest.Mock) =>
      Object.assign(connection(request), {
        isStale: jest.fn().mockReturnValue(false),
        refreshToolList: jest.fn().mockResolvedValue(undefined),
        on: jest.fn(),
        removeAllListeners: jest.fn(),
        dispose: jest.fn().mockResolvedValue(undefined),
      });

    const standardOAuthConfig = {
      source: 'yaml',
      type: 'sse',
      url: 'https://example.com/mcp',
      requiresOAuth: true,
      oauth: { client_id: 'client' },
    } as t.ParsedServerConfig;

    const prepareFreshOAuthAppOperation = ({
      request,
      publish,
      renewalCurrent = true,
    }: {
      request: jest.Mock;
      publish: jest.Mock;
      renewalCurrent?: boolean;
    }) => {
      mockAppConnections({ has: jest.fn().mockResolvedValue(false) });
      const appConnection = newOAuthConnection(request);
      const onOAuthCredentialsChanging = jest.fn().mockResolvedValue(publish);
      const generation = jest
        .spyOn(toolsChanged, 'getMCPToolsChangedGeneration')
        .mockResolvedValue('generation-a');
      const renewal = jest
        .spyOn(toolsChanged, 'renewMCPToolsChangedGeneration')
        .mockResolvedValue(renewalCurrent);
      (MCPConnectionFactory.create as jest.Mock).mockImplementation(
        async (_basic: t.BasicConnectionOptions, options: t.OAuthConnectionOptions) => {
          const publishPrepared = await options.onOAuthCredentialsChanging?.({
            userId: user.id,
            serverName: 'srv',
          });
          await publishPrepared?.();
          return appConnection;
        },
      );
      return {
        appConnection,
        onOAuthCredentialsChanging,
        renewal,
        restore: () => {
          generation.mockRestore();
          renewal.mockRestore();
        },
      };
    };

    it.each([
      {
        name: 'OBO',
        config: {
          source: 'yaml',
          type: 'sse',
          url: 'https://example.com/mcp',
          obo: { audience: 'api://mcp' },
        },
        message: /OBO token resolution/,
      },
      {
        name: 'Graph',
        config: {
          source: 'yaml',
          type: 'sse',
          url: 'https://example.com/mcp',
          headers: { Authorization: 'Bearer {{LIBRECHAT_GRAPH_ACCESS_TOKEN}}' },
        },
        message: /Graph API token resolution/,
      },
      {
        name: 'BODY',
        config: {
          source: 'yaml',
          type: 'sse',
          url: 'https://example.com/{{LIBRECHAT_BODY_CONVERSATIONID}}/mcp',
        },
        message: /request body field/,
      },
    ])(
      'rejects unsupported $name configuration before connection checkout',
      async ({ config, message }) => {
        const manager = await createAppManager(newMCPServersConfig());
        const getConnection = jest.spyOn(manager, 'getConnection');

        await expect(
          manager.readResource({
            ...context('srv', config as t.ParsedServerConfig),
            uri: 'data://catalog/42',
          }),
        ).rejects.toThrow(message);
        expect(getConnection).not.toHaveBeenCalled();
      },
    );

    it('uses the supplied authorized server config without another registry lookup', async () => {
      const config = {
        source: 'yaml',
        type: 'sse',
        url: 'https://example.com/mcp',
      } as t.ParsedServerConfig;
      const request = jest.fn().mockResolvedValue({ resources: [] });
      const appConnection = connection(request);
      const manager = await createAppManager(newMCPServersConfig());
      const getConnection = jest.spyOn(manager, 'getConnection').mockResolvedValue(appConnection);

      await expect(manager.listResources(context('srv', config))).resolves.toEqual({
        resources: [],
      });

      expect(mockRegistryInstance.getAllServerConfigs).not.toHaveBeenCalled();
      expect(getConnection).toHaveBeenCalledWith(
        expect.objectContaining({
          connectionTarget: { serverConfig: config, connectionOwner: 'operator' },
        }),
      );
    });

    it('validates a binding from the supplied target without checking out a connection', async () => {
      const config = {
        source: 'yaml',
        type: 'sse',
        url: 'https://example.com/mcp',
      } as t.ParsedServerConfig;
      const manager = await createAppManager(newMCPServersConfig());
      const getConnection = jest.spyOn(manager, 'getConnection');

      await expect(manager.validateAppBinding(context('srv', config))).resolves.toEqual({
        valid: true,
      });

      expect(getConnection).not.toHaveBeenCalled();
      expect(appBindingCodec.verify).toHaveBeenCalledWith(
        'binding',
        expect.objectContaining({
          serverName: 'srv',
          userId: user.id,
          connectionTarget: { serverConfig: config, connectionOwner: 'operator' },
          runtimeTarget: { type: 'sse', url: 'https://example.com/mcp' },
        }),
      );
    });

    it('uses the normal checkout path for an existing standard OAuth connection', async () => {
      const config = {
        source: 'yaml',
        type: 'sse',
        url: 'https://example.com/mcp',
        requiresOAuth: true,
        oauth: { client_id: 'client' },
      } as t.ParsedServerConfig;
      const request = jest.fn().mockResolvedValue({ resources: [] });
      const appConnection = connection(request);
      const manager = await createAppManager(newMCPServersConfig());
      const getConnection = jest.spyOn(manager, 'getConnection').mockResolvedValue(appConnection);
      const onOAuthCredentialsChanging = jest.fn(async () => async () => 'generation-b');

      await manager.listResources(context('srv', config, { onOAuthCredentialsChanging }));

      expect(getConnection).toHaveBeenCalledWith(
        expect.objectContaining({
          user,
          connectionTarget: { serverConfig: config, connectionOwner: 'principal' },
          flowManager,
          onOAuthCredentialsChanging,
        }),
      );
      expect(request).toHaveBeenCalledWith(
        expect.objectContaining({ method: 'resources/list' }),
        ListResourcesResultSchema,
        expect.any(Object),
      );
    });

    it('uses the shared OAuth recovery owner and retries an App operation once', async () => {
      const unauthorized = Object.assign(new Error('Unauthorized'), { status: 401 });
      const request = jest
        .fn()
        .mockRejectedValueOnce(unauthorized)
        .mockResolvedValueOnce({ resources: [] });
      const appConnection = connection(request);
      const manager = await createAppManager(newMCPServersConfig());
      jest.spyOn(manager, 'getConnection').mockResolvedValue(appConnection);
      const recoverOAuth = jest
        .spyOn(
          manager as unknown as {
            recoverOAuthConnection: (...args: unknown[]) => Promise<void>;
          },
          'recoverOAuthConnection',
        )
        .mockResolvedValue();

      await expect(manager.listResources(context('srv', standardOAuthConfig))).resolves.toEqual({
        resources: [],
      });

      expect(recoverOAuth).toHaveBeenCalledWith(
        appConnection,
        unauthorized,
        'srv',
        user.id,
        expect.any(Function),
        undefined,
        undefined,
        flowManager,
        undefined,
        true,
      );
      expect(request).toHaveBeenCalledTimes(2);
    });

    it('adopts the authorization generation published by a fresh App OAuth connection', async () => {
      const request = jest.fn().mockResolvedValue({ resources: [] });
      const publish = jest.fn().mockResolvedValue('generation-b');
      const { onOAuthCredentialsChanging, renewal, restore } = prepareFreshOAuthAppOperation({
        request,
        publish,
      });

      try {
        const manager = await createAppManager(newMCPServersConfig());
        await expect(
          manager.listResources(
            context('srv', standardOAuthConfig, { onOAuthCredentialsChanging }),
          ),
        ).resolves.toEqual({ resources: [] });

        expect(onOAuthCredentialsChanging).toHaveBeenCalledWith({
          userId: user.id,
          serverName: 'srv',
        });
        expect(publish).toHaveBeenCalledTimes(1);
        expect(renewal).toHaveBeenCalledWith({
          userId: user.id,
          serverName: 'srv',
          publicationGeneration: 'generation-b',
        });
        expect(request).toHaveBeenCalledTimes(1);
      } finally {
        restore();
      }
    });

    it('does not run an App operation after a foreign rotation fences its fresh OAuth connection', async () => {
      const request = jest.fn();
      const { appConnection, onOAuthCredentialsChanging, restore } = prepareFreshOAuthAppOperation({
        request,
        publish: jest.fn().mockResolvedValue('generation-b'),
        renewalCurrent: false,
      });

      try {
        const manager = await createAppManager(newMCPServersConfig());
        await expect(
          manager.listResources(
            context('srv', standardOAuthConfig, { onOAuthCredentialsChanging }),
          ),
        ).rejects.toThrow('Publication lease is no longer current');

        expect(appConnection.dispose).toHaveBeenCalled();
        expect(request).not.toHaveBeenCalled();
      } finally {
        restore();
      }
    });

    it('does not run an App operation when OAuth authorization publication fails', async () => {
      const request = jest.fn();
      const publicationError = new Error('authorization publication unavailable');
      const { onOAuthCredentialsChanging, restore } = prepareFreshOAuthAppOperation({
        request,
        publish: jest.fn().mockRejectedValue(publicationError),
      });

      try {
        const manager = await createAppManager(newMCPServersConfig());
        await expect(
          manager.listResources(
            context('srv', standardOAuthConfig, { onOAuthCredentialsChanging }),
          ),
        ).rejects.toBe(publicationError);
        expect(request).not.toHaveBeenCalled();
      } finally {
        restore();
      }
    });

    it('forwards an opaque auxiliary URI to the same authenticated server without local template inference', async () => {
      const config = {
        source: 'yaml',
        type: 'sse',
        url: 'https://example.com/mcp',
      } as t.ParsedServerConfig;
      const request = jest.fn().mockResolvedValue({
        contents: [{ uri: 'data://catalog/part%2Fleaf', text: 'leaf' }],
      });
      const appConnection = connection(request);
      const manager = await createAppManager(newMCPServersConfig());
      jest.spyOn(manager, 'getConnection').mockResolvedValue(appConnection);

      await manager.readResource({
        ...context('srv', config),
        uri: 'data://catalog/part%2Fleaf',
      });

      expect(request).toHaveBeenCalledTimes(1);
      expect(request).toHaveBeenCalledWith(
        {
          method: 'resources/read',
          params: { uri: 'data://catalog/part%2Fleaf' },
        },
        ReadResourceResultSchema,
        expect.objectContaining({ timeout: 30_000 }),
      );
    });

    it('binds the authenticated user and role, forwards cancellation, and awaits activity renewal', async () => {
      const config = {
        source: 'yaml',
        type: 'sse',
        url: 'https://example.com/mcp',
        headers: { 'X-User': '{{LIBRECHAT_USER_ID}}' },
      } as t.ParsedServerConfig;
      const request = jest.fn().mockResolvedValue({ resources: [] });
      const appConnection = connection(request);
      const manager = await createAppManager(newMCPServersConfig());
      jest.spyOn(manager, 'getConnection').mockResolvedValue(appConnection);
      const activity = jest
        .spyOn(
          manager as unknown as { updateUserLastActivity: (userId: string) => Promise<void> },
          'updateUserLastActivity',
        )
        .mockResolvedValue();
      (
        manager as unknown as {
          userConnections: Map<string, Map<string, MCPConnection>>;
        }
      ).userConnections.set(
        user.id,
        new Map([[getMCPConnectionPoolKey('srv', MCP_APPS_CAPABILITY_PROFILE), appConnection]]),
      );
      const signal = new AbortController().signal;

      await manager.listResources({ ...context('srv', config, { signal }), cursor: 'next' });

      expect(manager.getConnection).toHaveBeenCalledWith(
        expect.objectContaining({
          user,
          connectionTarget: { serverConfig: config, connectionOwner: 'operator' },
          signal,
        }),
      );
      expect(request).toHaveBeenCalledWith(
        expect.objectContaining({ method: 'resources/list', params: { cursor: 'next' } }),
        ListResourcesResultSchema,
        expect.objectContaining({ signal }),
      );
      expect(activity).toHaveBeenCalledWith(user.id);
    });

    it('releases the connection lease when an SDK operation fails', async () => {
      const config = {
        source: 'yaml',
        type: 'sse',
        url: 'https://example.com/mcp',
      } as t.ParsedServerConfig;
      const failure = new Error('provider unavailable');
      const appConnection = connection(jest.fn().mockRejectedValue(failure));
      const manager = await createAppManager(newMCPServersConfig());
      jest.spyOn(manager, 'getConnection').mockResolvedValue(appConnection);
      const retain = jest.spyOn(
        manager as unknown as { retainConnection: (value: MCPConnection) => void },
        'retainConnection',
      );
      const release = jest.spyOn(
        manager as unknown as { releaseConnection: (value: MCPConnection) => Promise<void> },
        'releaseConnection',
      );

      await expect(
        manager.readResource({ ...context('srv', config), uri: 'data://catalog/42' }),
      ).rejects.toBe(failure);
      expect(retain).toHaveBeenCalledWith(appConnection);
      expect(release).toHaveBeenCalledWith(appConnection);
    });

    it('uses the existing direct OpenID recovery coordinator and retries once after releasing', async () => {
      const config = {
        source: 'yaml',
        type: 'sse',
        url: 'https://example.com/mcp',
        headers: { Authorization: 'Bearer {{LIBRECHAT_OPENID_ACCESS_TOKEN}}' },
      } as t.ParsedServerConfig;
      const request = jest
        .fn()
        .mockRejectedValueOnce(Object.assign(new Error('Unauthorized'), { status: 401 }))
        .mockResolvedValueOnce({ resources: [] });
      const appConnection = connection(request);
      const manager = await createAppManager(newMCPServersConfig());
      jest.spyOn(manager, 'getConnection').mockResolvedValue(appConnection);
      const release = jest.spyOn(
        manager as unknown as { releaseConnection: (value: MCPConnection) => Promise<void> },
        'releaseConnection',
      );
      const recover = jest
        .spyOn(
          manager as unknown as {
            recoverDirectOpenIDBearerConnection: (args: object) => Promise<void>;
          },
          'recoverDirectOpenIDBearerConnection',
        )
        .mockResolvedValue();
      const upstreamTokenProvider = jest.fn().mockResolvedValue({ access_token: 'current-token' });

      await manager.listResources({
        ...context('srv', config, { upstreamTokenProvider }),
      });

      expect(recover).toHaveBeenCalledWith(
        expect.objectContaining({
          connection: appConnection,
          serverName: 'srv',
          serverConfig: config,
          user,
          upstreamTokenProvider,
        }),
      );
      expect(release.mock.invocationCallOrder[0]).toBeLessThan(request.mock.invocationCallOrder[1]);
      expect(request).toHaveBeenCalledTimes(2);
    });

    it('reacquires after lifecycle eviction while direct OpenID refresh is in flight', async () => {
      const config = {
        source: 'yaml',
        type: 'sse',
        url: 'https://example.com/mcp',
        headers: { Authorization: 'Bearer {{LIBRECHAT_OPENID_ACCESS_TOKEN}}' },
      } as t.ParsedServerConfig;
      const stale = Object.assign(
        connection(
          jest.fn().mockRejectedValue(Object.assign(new Error('Unauthorized'), { status: 401 })),
        ),
        {
          dispose: jest.fn().mockResolvedValue(undefined),
          removeAllListeners: jest.fn(),
          stopReconnecting: jest.fn(),
        },
      );
      const replacementRequest = jest.fn().mockResolvedValue({ resources: [] });
      const replacement = connection(replacementRequest);
      const manager = await createAppManager(newMCPServersConfig());
      jest
        .spyOn(manager, 'getConnection')
        .mockResolvedValueOnce(stale)
        .mockResolvedValueOnce(replacement);
      const createReplacement = jest
        .spyOn(manager, 'getUserConnection')
        .mockResolvedValue(replacement);
      (
        manager as unknown as {
          userConnections: Map<string, Map<string, MCPConnection>>;
        }
      ).userConnections.set(
        user.id,
        new Map([[getMCPConnectionPoolKey('srv', MCP_APPS_CAPABILITY_PROFILE), stale]]),
      );
      let refreshStarted!: () => void;
      const started = new Promise<void>((resolve) => {
        refreshStarted = resolve;
      });
      let finishRefresh!: (tokens: { access_token: string }) => void;
      const refresh = new Promise<{ access_token: string }>((resolve) => {
        finishRefresh = resolve;
      });
      const upstreamTokenProvider = jest
        .fn()
        .mockResolvedValueOnce({ access_token: 'stale-token' })
        .mockImplementationOnce(() => {
          refreshStarted();
          return refresh;
        });

      const result = manager.listResources({
        ...context('srv', config, { upstreamTokenProvider }),
      });
      await started;
      await manager.disconnectUserConnection(user.id, 'srv', { reason: 'lifecycle' });
      expect(stale.dispose).toHaveBeenCalledTimes(1);
      finishRefresh({ access_token: 'fresh-token' });

      await expect(result).resolves.toEqual({ resources: [] });
      expect(createReplacement).toHaveBeenCalledWith(
        expect.objectContaining({ forceNew: true, serverName: 'srv', user }),
      );
      expect(replacementRequest).toHaveBeenCalledTimes(1);
    });

    it('enforces app tool visibility and returns the standard raw call result', async () => {
      const config = {
        source: 'yaml',
        type: 'sse',
        url: 'https://example.com/mcp',
      } as t.ParsedServerConfig;
      const visibleRequest = jest.fn().mockResolvedValue({
        content: [{ type: 'text', text: 'done' }],
      });
      const visibleConnection = connection(visibleRequest);
      const manager = await createAppManager(newMCPServersConfig());
      jest.spyOn(manager, 'getConnection').mockResolvedValue(visibleConnection);
      const signal = new AbortController().signal;

      await expect(
        manager.appToolCall({
          ...context('srv', config, { signal }),
          toolName: 'do_thing',
          toolArguments: { value: 1 },
        }),
      ).resolves.toEqual({ content: [{ type: 'text', text: 'done' }] });
      expect(visibleConnection.fetchOrderedToolsSnapshot).toHaveBeenCalledWith(undefined, signal);

      (MCPManager as unknown as { instance: null }).instance = null;
      const hiddenRequest = jest.fn();
      const hiddenManager = await createAppManager(newMCPServersConfig());
      jest
        .spyOn(hiddenManager, 'getConnection')
        .mockResolvedValue(
          connection(hiddenRequest, [
            { name: 'do_thing', _meta: { ui: { visibility: ['model'] } } },
          ]),
        );

      await expect(
        hiddenManager.appToolCall({
          ...context('srv', config),
          toolName: 'do_thing',
          toolArguments: {},
        }),
      ).rejects.toMatchObject({ code: ErrorCode.InvalidRequest });
      expect(hiddenRequest).not.toHaveBeenCalled();
    });

    it.each([
      { name: 'incomplete', snapshot: { tools: [], complete: false } },
      { name: 'empty', snapshot: { tools: [], complete: true } },
    ])(
      'does not authorize an App tool from stale cache after a $name catalog refresh',
      async ({ snapshot }) => {
        const config = {
          source: 'yaml',
          type: 'sse',
          url: 'https://example.com/mcp',
        } as t.ParsedServerConfig;
        const request = jest.fn().mockResolvedValue({ content: [{ type: 'text', text: 'done' }] });
        const appConnection = connection(request);
        const snapshots = appConnection.fetchOrderedToolsSnapshot as jest.Mock;
        const manager = await createAppManager(newMCPServersConfig());
        jest.spyOn(manager, 'getConnection').mockResolvedValue(appConnection);

        await expect(
          manager.appToolCall({
            ...context('srv', config),
            toolName: 'do_thing',
            toolArguments: {},
          }),
        ).resolves.toEqual({ content: [{ type: 'text', text: 'done' }] });

        appConnection.toolListVersion += 1;
        snapshots.mockResolvedValueOnce(snapshot);
        await expect(
          manager.appToolCall({
            ...context('srv', config),
            toolName: 'do_thing',
            toolArguments: {},
          }),
        ).rejects.toMatchObject({ code: ErrorCode.InvalidRequest });

        snapshots.mockResolvedValueOnce({
          tools: [{ name: 'do_thing', _meta: {} }],
          complete: true,
        });
        await expect(
          manager.appToolCall({
            ...context('srv', config),
            toolName: 'do_thing',
            toolArguments: {},
          }),
        ).resolves.toEqual({ content: [{ type: 'text', text: 'done' }] });
        expect(request).toHaveBeenCalledTimes(2);
      },
    );
  });

  describe('getConnection', () => {
    const mockUser: Partial<IUser> = {
      id: 'user-123',
      provider: 'openid',
      openidId: 'oidc-sub-456',
    };

    it('should continue using shared app connections for non-OBO servers', async () => {
      const appConnection = {
        isConnected: jest.fn().mockResolvedValue(true),
      } as unknown as MCPConnection;

      const appConnections = {
        get: jest.fn().mockResolvedValue(appConnection),
      };

      const nonOboConfig: t.SSEOptions = {
        type: 'sse',
        url: 'https://api.example.com',
      };

      mockAppConnections(appConnections);
      (mockRegistryInstance.getServerConfig as jest.Mock).mockResolvedValue(nonOboConfig);

      const manager = await MCPManager.createInstance(newMCPServersConfig());
      const getUserConnectionSpy = jest.spyOn(manager, 'getUserConnection');

      const connection = await manager.getConnection({
        serverName,
        user: mockUser as IUser,
      });

      expect(connection).toBe(appConnection);
      expect(appConnections.get).toHaveBeenCalledWith(serverName, {
        expectedConfig: nonOboConfig,
      });
      expect(getUserConnectionSpy).not.toHaveBeenCalled();
    });

    it('uses a profile-separated user session for Apps on an operator server', async () => {
      const appConnections = {
        get: jest.fn().mockResolvedValue({} as MCPConnection),
      };
      const userConnection = {} as MCPConnection;
      const operatorConfig: t.SSEOptions = {
        type: 'sse',
        url: 'https://api.example.com',
      };
      mockAppConnections(appConnections);
      (mockRegistryInstance.getServerConfig as jest.Mock).mockResolvedValue(operatorConfig);

      const manager = await MCPManager.createInstance(newMCPServersConfig());
      const getUserConnectionSpy = jest
        .spyOn(manager, 'getUserConnection')
        .mockResolvedValue(userConnection);

      await expect(
        manager.getConnection({
          serverName,
          user: mockUser as IUser,
          capabilityProfile: MCP_APPS_CAPABILITY_PROFILE,
        }),
      ).resolves.toBe(userConnection);
      expect(appConnections.get).not.toHaveBeenCalled();
      expect(getUserConnectionSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          capabilityProfile: MCP_APPS_CAPABILITY_PROFILE,
          connectionTarget: {
            serverConfig: operatorConfig,
            connectionOwner: 'operator',
          },
        }),
      );
    });

    it('keeps a static request-header overlay off its same-named shared app connection', async () => {
      const appConnections = {
        get: jest.fn(),
        has: jest.fn().mockResolvedValue(true),
      };
      mockAppConnections(appConnections);
      const candidate = {
        isConnected: jest.fn().mockResolvedValue(true),
        refreshToolList: jest.fn().mockResolvedValue({ tools: [], complete: true }),
        on: jest.fn(),
      } as unknown as MCPConnection;
      (MCPConnectionFactory.create as jest.Mock).mockResolvedValue(candidate);
      const declared: t.ParsedServerConfig = {
        type: 'streamable-http',
        url: 'https://api.example.com/mcp',
        source: 'yaml',
        requestHeaders: { 'X-Workspace': 'chat-only' },
      };
      const manager = await MCPManager.createInstance(newMCPServersConfig());
      await expect(
        manager.getConnection({
          serverName,
          user: mockUser as IUser,
          serverConfig: declared,
        }),
      ).resolves.toBe(candidate);
      expect(appConnections.get).not.toHaveBeenCalled();
      expect(appConnections.has).not.toHaveBeenCalled();
      expect(MCPConnectionFactory.create).toHaveBeenCalledWith(
        expect.objectContaining({
          serverDefinition: declared,
          serverConfig: expect.objectContaining({ headers: { 'X-Workspace': 'chat-only' } }),
        }),
        expect.any(Object),
      );
    });

    it('should use user-scoped connections for trusted runtime context placeholders', async () => {
      const appConnection = {
        isConnected: jest.fn().mockResolvedValue(true),
      } as unknown as MCPConnection;
      const userConnection = {
        isConnected: jest.fn().mockResolvedValue(true),
      } as unknown as MCPConnection;
      const appConnections = {
        get: jest.fn().mockResolvedValue(appConnection),
      };
      const runtimeHeaderConfig: t.ParsedServerConfig = {
        type: 'streamable-http',
        url: 'https://api.example.com/mcp',
        source: 'yaml',
        headers: {
          'X-LibreChat-User-Email': '{{LIBRECHAT_USER_EMAIL}}',
        },
      };

      mockAppConnections(appConnections);
      (mockRegistryInstance.getServerConfig as jest.Mock).mockResolvedValue(runtimeHeaderConfig);

      const manager = await MCPManager.createInstance(newMCPServersConfig());
      const getUserConnectionSpy = jest
        .spyOn(manager, 'getUserConnection')
        .mockResolvedValue(userConnection);

      const connection = await manager.getConnection({
        serverName,
        user: mockUser as IUser,
      });

      expect(connection).toBe(userConnection);
      expect(appConnections.get).not.toHaveBeenCalled();
      expect(getUserConnectionSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          serverName,
          connectionTarget: {
            serverConfig: runtimeHeaderConfig,
            connectionOwner: 'operator',
          },
          user: mockUser,
        }),
      );
    });

    it('uses the admitted principal target when it shadows an operator server name', async () => {
      const principalConfig = {
        type: 'sse',
        url: 'https://principal.example.com',
        source: 'config',
      } as t.ParsedServerConfig;
      const userConnection = {} as MCPConnection;
      const appConnections = { get: jest.fn() };
      mockAppConnections(appConnections);
      const manager = await MCPManager.createInstance(newMCPServersConfig());
      const getUserConnection = jest
        .spyOn(manager, 'getUserConnection')
        .mockResolvedValue(userConnection);

      await expect(
        manager.getConnection({
          serverName,
          user: mockUser as IUser,
          connectionTarget: {
            serverConfig: principalConfig,
            connectionOwner: 'principal',
          },
        }),
      ).resolves.toBe(userConnection);

      expect(appConnections.get).not.toHaveBeenCalled();
      expect(getUserConnection).toHaveBeenCalledWith(
        expect.objectContaining({
          connectionTarget: {
            serverConfig: principalConfig,
            connectionOwner: 'principal',
          },
        }),
      );
    });
  });

  describe('discoverServerTools', () => {
    const mockTools = [
      { name: 'tool1', description: 'First tool', inputSchema: { type: 'object' } },
      { name: 'tool2', description: 'Second tool', inputSchema: { type: 'object' } },
    ];

    const mockConnection = {
      isConnected: jest.fn().mockResolvedValue(true),
      fetchTools: jest.fn().mockResolvedValue(mockTools),
      fetchToolsSnapshot: jest.fn().mockResolvedValue({ tools: mockTools, complete: true }),
      fetchOrderedToolsSnapshot: jest.fn().mockResolvedValue({ tools: mockTools, complete: true }),
      disconnect: jest.fn().mockResolvedValue(undefined),
      dispose: jest.fn().mockResolvedValue(undefined),
    } as unknown as MCPConnection;

    beforeEach(() => {
      (MCPConnectionFactory.discoverTools as jest.Mock) = jest.fn();
    });

    it.each([64, 6 * 1024 * 1024])(
      'passes the user-scoped %i byte limit to App-profile discovery',
      async (maxBytes) => {
        const operationLimits = { maxBytes, timeoutMs: 45_000, maxActive: 8 };
        mockRegistryInstance.resolveAllowlists.mockResolvedValueOnce({
          allowedDomains: null,
          allowedAddresses: null,
          useSSRFProtection: false,
          mcpApps: { enabled: true, legacyHtmlEnabled: true, operationLimits },
        });
        (MCPConnectionFactory.discoverTools as jest.Mock).mockResolvedValue({
          tools: mockTools,
          connection: null,
          oauthRequired: false,
          oauthUrl: null,
        });
        const manager = await MCPManager.createInstance(newMCPServersConfig());
        await manager.discoverServerTools({
          serverName,
          user: { id: 'discovery-user', role: 'ADMIN' } as IUser,
          capabilityProfile: MCP_APPS_CAPABILITY_PROFILE,
        });

        expect(mockRegistryInstance.resolveAllowlists).toHaveBeenCalledWith({
          userId: 'discovery-user',
          role: 'ADMIN',
        });
        expect(MCPConnectionFactory.discoverTools).toHaveBeenCalledWith(
          expect.objectContaining({
            capabilityProfile: MCP_APPS_CAPABILITY_PROFILE,
            operationLimits,
          }),
          expect.any(Object),
        );
      },
    );

    it('does not apply App limits to standard-profile discovery', async () => {
      const operationLimits = { maxBytes: 64, timeoutMs: 45_000, maxActive: 8 };
      mockAppConnections({ get: jest.fn().mockResolvedValue(null) });
      mockRegistryInstance.resolveAllowlists.mockResolvedValueOnce({
        allowedDomains: null,
        allowedAddresses: null,
        useSSRFProtection: false,
        mcpApps: { enabled: true, legacyHtmlEnabled: true, operationLimits },
      });
      (MCPConnectionFactory.discoverTools as jest.Mock).mockResolvedValue({
        tools: mockTools,
        connection: null,
        oauthRequired: false,
        oauthUrl: null,
      });
      const manager = await MCPManager.createInstance(newMCPServersConfig());
      await manager.discoverServerTools({
        serverName,
        capabilityProfile: STANDARD_MCP_CAPABILITY_PROFILE,
      });
      expect((MCPConnectionFactory.discoverTools as jest.Mock).mock.calls[0][0]).not.toHaveProperty(
        'operationLimits',
      );
    });

    it('keeps the declared OAuth identity while stripping discovery headers', async () => {
      const declared: t.ParsedServerConfig = {
        type: 'streamable-http',
        url: 'https://mcp.example.com',
        source: 'yaml',
        requiresOAuth: true,
        requestHeaders: { 'X-Conversation': '{{LIBRECHAT_BODY_CONVERSATIONID}}' },
      };
      mockRegistryInstance.getServerConfig.mockResolvedValue(declared);
      (MCPConnectionFactory.discoverTools as jest.Mock).mockResolvedValue({
        tools: mockTools,
        connection: null,
        oauthRequired: false,
        oauthUrl: null,
      });
      const manager = await MCPManager.createInstance(newMCPServersConfig());
      await manager.discoverServerTools({
        serverName,
        user: { id: 'oauth-user' } as IUser,
        flowManager: {} as Parameters<typeof manager.discoverServerTools>[0]['flowManager'],
      });
      const [basic] = (MCPConnectionFactory.discoverTools as jest.Mock).mock.calls[0];
      expect(basic.serverDefinition).toBe(declared);
      expect(basic.serverConfig).not.toHaveProperty('requestHeaders');
    });

    it('should return tools from existing app connection when available', async () => {
      mockAppConnections({
        get: jest.fn().mockResolvedValue(mockConnection),
      });

      const manager = await MCPManager.createInstance(newMCPServersConfig());
      const result = await manager.discoverServerTools({ serverName });

      expect(result.tools).toEqual(mockTools);
      expect(result.oauthRequired).toBe(false);
      expect(result.oauthUrl).toBeNull();
      expect(MCPConnectionFactory.discoverTools).not.toHaveBeenCalled();
    });

    it('gives a budgeted caller an abort signal for the app-connection probe and snapshot', async () => {
      mockAppConnections({
        get: jest.fn().mockResolvedValue(mockConnection),
      });
      const deadlineMs = Date.now() + 3000;

      const manager = await MCPManager.createInstance(newMCPServersConfig());
      const result = await manager.discoverServerTools({ serverName, deadlineMs });

      expect(result.tools).toEqual(mockTools);
      expect(mockConnection.isConnected).toHaveBeenCalledWith(expect.any(AbortSignal));
      expect(mockConnection.fetchOrderedToolsSnapshot).toHaveBeenCalledWith(
        deadlineMs,
        expect.any(AbortSignal),
      );
    });

    it('lets the caller signal cancel app-connection work even without a deadline', async () => {
      mockAppConnections({
        get: jest.fn().mockResolvedValue(mockConnection),
      });
      const controller = new AbortController();

      const manager = await MCPManager.createInstance(newMCPServersConfig());
      await manager.discoverServerTools({ serverName, signal: controller.signal });

      expect(mockConnection.isConnected).toHaveBeenCalledWith(controller.signal);
      expect(mockConnection.fetchOrderedToolsSnapshot).toHaveBeenCalledWith(
        undefined,
        controller.signal,
      );
    });

    it('does not start discovery fallback for a caller whose signal already aborted', async () => {
      const isConnected = jest.fn().mockResolvedValue(false);
      mockAppConnections({
        get: jest.fn().mockResolvedValue({ ...mockConnection, isConnected }),
      });
      const controller = new AbortController();
      controller.abort();

      const manager = await MCPManager.createInstance(newMCPServersConfig());
      const result = await manager.discoverServerTools({ serverName, signal: controller.signal });

      expect(result.tools).toBeNull();
      expect(MCPConnectionFactory.discoverTools).not.toHaveBeenCalled();
    });

    it('forwards the caller signal into non-OAuth fallback discovery', async () => {
      mockAppConnections({
        get: jest.fn().mockResolvedValue(null),
      });
      (MCPConnectionFactory.discoverTools as jest.Mock).mockResolvedValue({
        tools: mockTools,
        connection: null,
        oauthRequired: false,
        oauthUrl: null,
      });
      const controller = new AbortController();

      const manager = await MCPManager.createInstance(newMCPServersConfig());
      await manager.discoverServerTools({ serverName, signal: controller.signal });

      expect(MCPConnectionFactory.discoverTools).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ signal: controller.signal }),
      );
    });

    it('does not reuse an app connection for a tenant-scoped config override', async () => {
      const configOverride = {
        type: 'streamable-http' as const,
        url: 'https://tenant.example.com/mcp',
        source: 'config' as const,
      };
      const appConnections = { get: jest.fn().mockResolvedValue(mockConnection) };
      mockAppConnections(appConnections);
      (mockRegistryInstance.getServerConfig as jest.Mock).mockResolvedValue(configOverride);
      (mockRegistryInstance.isAppServerConfig as jest.Mock).mockResolvedValue(false);
      (MCPConnectionFactory.discoverTools as jest.Mock).mockResolvedValue({
        tools: mockTools,
        connection: null,
        oauthRequired: false,
        oauthUrl: null,
      });

      const manager = await MCPManager.createInstance(newMCPServersConfig());
      const result = await manager.discoverServerTools({
        serverName,
        user: { id: 'tenant-user' } as IUser,
        configServers: { [serverName]: configOverride },
      });

      expect(result.tools).toEqual(mockTools);
      expect(mockRegistryInstance.getServerConfig).toHaveBeenCalledWith(serverName, 'tenant-user', {
        [serverName]: configOverride,
      });
      expect(appConnections.get).not.toHaveBeenCalled();
      expect(MCPConnectionFactory.discoverTools).toHaveBeenCalledWith(
        expect.objectContaining({ serverConfig: configOverride }),
        expect.objectContaining({ user: expect.objectContaining({ id: 'tenant-user' }) }),
      );
    });

    it('should use MCPConnectionFactory.discoverTools when no app connection available', async () => {
      const discoveryConnection = {
        disconnect: jest.fn().mockResolvedValue(undefined),
        dispose: jest.fn().mockResolvedValue(undefined),
      } as unknown as MCPConnection;
      mockAppConnections({
        get: jest.fn().mockResolvedValue(null),
      });

      (mockRegistryInstance.getServerConfig as jest.Mock).mockResolvedValue({
        type: 'stdio',
        command: 'test',
        args: [],
      });

      (MCPConnectionFactory.discoverTools as jest.Mock).mockResolvedValue({
        tools: mockTools,
        connection: discoveryConnection,
        oauthRequired: false,
        oauthUrl: null,
      });

      const manager = await MCPManager.createInstance(newMCPServersConfig());
      const result = await manager.discoverServerTools({ serverName });

      expect(result.tools).toEqual(mockTools);
      expect(result.oauthRequired).toBe(false);
      expect(MCPConnectionFactory.discoverTools).toHaveBeenCalled();
      expect(discoveryConnection.dispose).toHaveBeenCalledTimes(1);
    });

    it('classifies a dynamically detected authentication challenge as OAuth', async () => {
      mockAppConnections({
        get: jest.fn().mockResolvedValue(null),
      });
      (mockRegistryInstance.getServerConfig as jest.Mock).mockResolvedValue({
        type: 'streamable-http',
        url: 'https://api.example.com/mcp',
      });
      (MCPConnectionFactory.discoverTools as jest.Mock).mockResolvedValue({
        tools: null,
        connection: null,
        oauthRequired: true,
        oauthUrl: null,
      });

      const manager = await MCPManager.createInstance(newMCPServersConfig());
      const result = await manager.discoverServerTools({ serverName });

      expect(result.oauthRequired).toBe(true);
      expect(result.authenticationKind).toBe('oauth');
    });

    it('keeps an authentication challenge server-managed when OAuth is explicitly disabled', async () => {
      mockAppConnections({
        get: jest.fn().mockResolvedValue(null),
      });
      (mockRegistryInstance.getServerConfig as jest.Mock).mockResolvedValue({
        type: 'streamable-http',
        url: 'https://api.example.com/mcp',
        requiresOAuth: false,
      });
      (MCPConnectionFactory.discoverTools as jest.Mock).mockResolvedValue({
        tools: null,
        connection: null,
        oauthRequired: true,
        oauthUrl: null,
      });

      const manager = await MCPManager.createInstance(newMCPServersConfig());
      const result = await manager.discoverServerTools({ serverName });

      expect(result.oauthRequired).toBe(true);
      expect(result.authenticationKind).toBe('server');
    });

    it('should forward runtime context to discoverTools in the non-OAuth path', async () => {
      const mockUser = { id: 'user123', email: 'test@example.com' } as unknown as IUser;
      const customUserVars = { MY_CUSTOM_KEY: 'c527bd0abc123' };
      const graphTokenResolver = jest.fn();

      mockAppConnections({
        get: jest.fn().mockResolvedValue(null),
      });

      (mockRegistryInstance.getServerConfig as jest.Mock).mockResolvedValue({
        type: 'streamable-http',
        url: 'https://my-mcp.server.com?key={{MY_CUSTOM_KEY}}',
      });

      (MCPConnectionFactory.discoverTools as jest.Mock).mockResolvedValue({
        tools: mockTools,
        connection: null,
        oauthRequired: false,
        oauthUrl: null,
      });

      const manager = await MCPManager.createInstance(newMCPServersConfig());
      await manager.discoverServerTools({
        serverName,
        user: mockUser,
        customUserVars,
        requestBody: { conversationId: 'conv-123' } as t.ToolDiscoveryOptions['requestBody'],
        graphTokenResolver,
        connectionTimeout: 10000,
      });

      expect(MCPConnectionFactory.discoverTools).toHaveBeenCalledWith(
        expect.objectContaining({
          serverName,
          serverConfig: expect.objectContaining({
            url: 'https://my-mcp.server.com?key={{MY_CUSTOM_KEY}}',
          }),
        }),
        expect.objectContaining({
          user: mockUser,
          customUserVars,
          requestBody: { conversationId: 'conv-123' },
          graphTokenResolver,
          connectionTimeout: 10000,
        }),
      );
    });

    it('should not discover BODY-scoped servers without request body context', async () => {
      mockAppConnections({
        get: jest.fn().mockResolvedValue(null),
      });

      (mockRegistryInstance.getServerConfig as jest.Mock).mockResolvedValue({
        type: 'streamable-http',
        url: 'https://api.example.com/messages/{{LIBRECHAT_BODY_MESSAGEID}}/mcp',
        source: 'yaml',
      });

      const manager = await MCPManager.createInstance(newMCPServersConfig());
      const result = await manager.discoverServerTools({ serverName });

      expect(result).toEqual({ tools: null, oauthRequired: false, oauthUrl: null });
      expect(MCPConnectionFactory.discoverTools).not.toHaveBeenCalled();
      expect(mockLogger.warn).toHaveBeenCalledWith(
        '[MCP][Discovery] Runtime request fields are missing',
        { missingBodyFieldCount: 1 },
      );
      expect(JSON.stringify(mockLogger.warn.mock.calls)).not.toContain('messageId');
      expect(JSON.stringify(mockLogger.warn.mock.calls)).not.toContain(serverName);
    });

    it('should return null tools when server config not found', async () => {
      mockAppConnections({
        get: jest.fn().mockResolvedValue(null),
      });

      (mockRegistryInstance.getServerConfig as jest.Mock).mockResolvedValue(null);

      const manager = await MCPManager.createInstance(newMCPServersConfig());
      const result = await manager.discoverServerTools({ serverName });

      expect(result.tools).toBeNull();
      expect(result.oauthRequired).toBe(false);
      expect(mockLogger.warn).toHaveBeenCalledWith(
        '[MCP][Discovery] Server configuration not found',
      );
    });

    it('should treat configured oauth as OAuth when requiresOAuth is unset', async () => {
      mockAppConnections({
        get: jest.fn().mockResolvedValue(null),
      });

      (mockRegistryInstance.getServerConfig as jest.Mock).mockResolvedValue({
        type: 'sse',
        url: 'https://api.example.com',
        oauth: {
          authorization_url: 'https://auth.example.com/oauth/authorize',
          token_url: 'https://auth.example.com/oauth/token',
        },
      });

      const manager = await MCPManager.createInstance(newMCPServersConfig());
      const result = await manager.discoverServerTools({ serverName });

      expect(result.tools).toBeNull();
      expect(result.oauthRequired).toBe(true);
      expect(result.authenticationKind).toBe('oauth');
      expect(MCPConnectionFactory.discoverTools).not.toHaveBeenCalled();
    });

    it('should return OAuth info when server requires OAuth but no user provided', async () => {
      mockAppConnections({
        get: jest.fn().mockResolvedValue(null),
      });

      (mockRegistryInstance.getServerConfig as jest.Mock).mockResolvedValue({
        type: 'sse',
        url: 'https://api.example.com',
        requiresOAuth: true,
      });

      const manager = await MCPManager.createInstance(newMCPServersConfig());
      const result = await manager.discoverServerTools({ serverName });

      expect(result.tools).toBeNull();
      expect(result.oauthRequired).toBe(true);
      expect(result.authenticationKind).toBe('oauth');
      expect(mockLogger.warn).toHaveBeenCalledWith(
        '[MCP][Discovery] OAuth server requires a user and flow manager',
      );
    });

    it('should discover tools with OAuth when user and flowManager provided', async () => {
      const mockUser = { id: 'user123', email: 'test@example.com' } as unknown as IUser;
      const mockFlowManager = {
        createFlow: jest.fn(),
        getFlowState: jest.fn(),
        deleteFlow: jest.fn(),
      };

      mockAppConnections({
        get: jest.fn().mockResolvedValue(null),
      });

      (mockRegistryInstance.getServerConfig as jest.Mock).mockResolvedValue({
        type: 'sse',
        url: 'https://api.example.com',
        requiresOAuth: true,
      });

      (MCPConnectionFactory.discoverTools as jest.Mock).mockResolvedValue({
        tools: mockTools,
        connection: null,
        oauthRequired: true,
        oauthUrl: 'https://auth.example.com/authorize',
      });

      const onDiscoveryDetached = jest.fn();
      const onOAuthCredentialsAdopted = jest.fn();
      const manager = await MCPManager.createInstance(newMCPServersConfig());
      const result = await manager.discoverServerTools({
        serverName,
        user: mockUser,
        flowManager: mockFlowManager as unknown as t.ToolDiscoveryOptions['flowManager'],
        graphTokenResolver: jest.fn(),
        onDiscoveryDetached,
        onOAuthCredentialsAdopted,
      });

      expect(result.tools).toEqual(mockTools);
      expect(result.oauthRequired).toBe(true);
      expect(result.oauthUrl).toBe('https://auth.example.com/authorize');
      expect(result.authenticationKind).toBe('oauth');
      expect(MCPConnectionFactory.discoverTools).toHaveBeenCalledWith(
        expect.objectContaining({ serverName }),
        expect.objectContaining({
          user: mockUser,
          useOAuth: true,
          graphTokenResolver: expect.any(Function),
          onDiscoveryDetached,
          onOAuthCredentialsAdopted,
        }),
      );
      const generationSpy = jest
        .spyOn(toolsChanged, 'getMCPToolsChangedGeneration')
        .mockResolvedValue('discovery-peer-generation');
      try {
        const oauthOptions = (MCPConnectionFactory.discoverTools as jest.Mock).mock.calls[0][1];
        await expect(oauthOptions.onOAuthCredentialsInvalidated()).resolves.toBe(
          'discovery-peer-generation',
        );
        expect(generationSpy).toHaveBeenCalledWith({ userId: mockUser.id, serverName });
      } finally {
        generationSpy.mockRestore();
      }
    });
  });

  describe('getUserConnection - useOAuth derivation', () => {
    const mockUser = { id: userId, email: 'test@example.com' } as unknown as IUser;
    const mockFlowManager = {
      createFlow: jest.fn(),
      getFlowState: jest.fn(),
      deleteFlow: jest.fn(),
    };
    const mockConnection = {
      isConnected: jest.fn().mockResolvedValue(true),
      isStale: jest.fn().mockReturnValue(false),
      disconnect: jest.fn().mockResolvedValue(undefined),
      refreshToolList: jest.fn().mockResolvedValue(undefined),
      on: jest.fn(),
    } as unknown as MCPConnection;
    const newUserConnection = () =>
      ({
        isConnected: jest.fn().mockResolvedValue(true),
        isStale: jest.fn().mockReturnValue(false),
        refreshToolList: jest.fn().mockResolvedValue(undefined),
        on: jest.fn(),
        removeAllListeners: jest.fn(),
        dispose: jest.fn().mockResolvedValue(undefined),
      }) as unknown as MCPConnection;

    it('keeps concurrent standard and Apps sessions distinct and disconnects both', async () => {
      const serverConfig: t.ParsedServerConfig = {
        type: 'streamable-http',
        url: 'https://mcp.example.com/mcp',
        source: 'yaml',
        startup: false,
      };
      const created = new Map<string, MCPConnection>();
      mockAppConnections({ has: jest.fn().mockResolvedValue(false) });
      (mockRegistryInstance.getServerConfig as jest.Mock).mockResolvedValue(serverConfig);
      (mockRegistryInstance.isAppServerConfig as jest.Mock).mockResolvedValue(false);
      (MCPConnectionFactory.create as jest.Mock).mockImplementation(
        async (basic: t.BasicConnectionOptions) => {
          const capabilityProfile = basic.capabilityProfile ?? STANDARD_MCP_CAPABILITY_PROFILE;
          const connection = Object.assign(newUserConnection(), {
            serverName,
            capabilityProfile,
          });
          created.set(capabilityProfile, connection);
          return connection;
        },
      );

      const manager = await MCPManager.createInstance(newMCPServersConfig());
      const [standard, apps] = await Promise.all([
        manager.getConnection({
          serverName,
          user: mockUser,
          capabilityProfile: STANDARD_MCP_CAPABILITY_PROFILE,
        }),
        manager.getConnection({
          serverName,
          user: mockUser,
          capabilityProfile: MCP_APPS_CAPABILITY_PROFILE,
        }),
      ]);

      expect(standard).toBe(created.get(STANDARD_MCP_CAPABILITY_PROFILE));
      expect(apps).toBe(created.get(MCP_APPS_CAPABILITY_PROFILE));
      expect(standard).not.toBe(apps);
      expect(MCPConnectionFactory.create).toHaveBeenCalledTimes(2);
      expect(manager.getUserConnections(userId)?.get(serverName)).toBe(standard);
      expect(manager.getUserConnections(userId, MCP_APPS_CAPABILITY_PROFILE)?.get(serverName)).toBe(
        apps,
      );

      await expect(
        manager.getConnection({
          serverName,
          user: mockUser,
          capabilityProfile: STANDARD_MCP_CAPABILITY_PROFILE,
        }),
      ).resolves.toBe(standard);
      await expect(
        manager.getConnection({
          serverName,
          user: mockUser,
          capabilityProfile: MCP_APPS_CAPABILITY_PROFILE,
        }),
      ).resolves.toBe(apps);
      expect(MCPConnectionFactory.create).toHaveBeenCalledTimes(2);

      await manager.disconnectUserConnection(userId, serverName);

      expect(standard.dispose).toHaveBeenCalledTimes(1);
      expect(apps.dispose).toHaveBeenCalledTimes(1);
      expect(manager.getUserConnections(userId)).toBeUndefined();
    });

    /** An OAuth server whose connection build refreshes credentials, fencing the catalog mid-build. */
    const refreshingOAuthServer = () => {
      const connection = newUserConnection();
      const serverConfig: t.ParsedServerConfig = {
        type: 'streamable-http',
        url: 'https://oauth-mcp.example.com/mcp',
        source: 'yaml',
        startup: false,
        requiresOAuth: true,
      };
      mockAppConnections({ has: jest.fn().mockResolvedValue(false) });
      (mockRegistryInstance.getServerConfig as jest.Mock).mockResolvedValue(serverConfig);
      (MCPConnectionFactory.create as jest.Mock).mockImplementation(
        async (_basic: t.BasicConnectionOptions, options: t.OAuthConnectionOptions) => {
          const publish = await options.onOAuthCredentialsChanging?.({ userId, serverName });
          await publish?.();
          return connection;
        },
      );
      return {
        connection,
        serverConfig,
        flowManager: mockFlowManager as unknown as t.UserMCPConnectionOptions['flowManager'],
      };
    };

    const adoptingOAuthServer = (
      adopt: (options: t.OAuthConnectionOptions) => Promise<void> | void,
    ) => {
      const connection = newUserConnection();
      const serverConfig: t.ParsedServerConfig = {
        type: 'streamable-http',
        url: 'https://oauth-mcp.example.com/mcp',
        source: 'yaml',
        startup: false,
        requiresOAuth: true,
      };
      mockAppConnections({ has: jest.fn().mockResolvedValue(false) });
      (mockRegistryInstance.getServerConfig as jest.Mock).mockResolvedValue(serverConfig);
      (MCPConnectionFactory.create as jest.Mock).mockImplementation(
        async (_basic: t.BasicConnectionOptions, options: t.OAuthConnectionOptions) => {
          await adopt(options);
          return connection;
        },
      );
      return {
        connection,
        serverConfig,
        flowManager: mockFlowManager as unknown as t.UserMCPConnectionOptions['flowManager'],
      };
    };

    it('should pass useOAuth for servers with configured oauth and no requiresOAuth value', async () => {
      mockAppConnections({
        has: jest.fn().mockResolvedValue(false),
      });

      (mockRegistryInstance.getServerConfig as jest.Mock).mockResolvedValue({
        type: 'sse',
        url: 'https://oauth-mcp.example.com',
        oauth: {
          authorization_url: 'https://auth.example.com/oauth/authorize',
          token_url: 'https://auth.example.com/oauth/token',
        },
      });

      (MCPConnectionFactory.create as jest.Mock).mockResolvedValue(mockConnection);

      const manager = await MCPManager.createInstance(newMCPServersConfig());
      await manager.getUserConnection({
        serverName,
        user: mockUser,
        flowManager: mockFlowManager as unknown as t.UserMCPConnectionOptions['flowManager'],
      });

      expect(MCPConnectionFactory.create).toHaveBeenCalledWith(
        expect.objectContaining({ serverName }),
        expect.objectContaining({ useOAuth: true }),
      );
    });

    it('should not pass useOAuth for servers with requiresOAuth: false', async () => {
      mockAppConnections({
        has: jest.fn().mockResolvedValue(false),
      });

      (mockRegistryInstance.getServerConfig as jest.Mock).mockResolvedValue({
        type: 'streamable-http',
        url: 'http://private-mcp.svc:5446/mcp',
        requiresOAuth: false,
        oauth: {
          authorization_url: 'https://auth.example.com/oauth/authorize',
          token_url: 'https://auth.example.com/oauth/token',
        },
      });

      (MCPConnectionFactory.create as jest.Mock).mockResolvedValue(mockConnection);

      const manager = await MCPManager.createInstance(newMCPServersConfig());
      await manager.getUserConnection({
        serverName,
        user: mockUser,
      });

      expect(MCPConnectionFactory.create).toHaveBeenCalledWith(
        expect.objectContaining({ serverName }),
        expect.not.objectContaining({ useOAuth: true }),
      );
    });

    it('routes tool-list snapshots from user connections to the user-scoped publisher', async () => {
      const serverConfig: t.ParsedServerConfig = {
        type: 'streamable-http',
        url: 'https://mcp.example.com/{{LIBRECHAT_BODY_CONVERSATIONID}}',
        source: 'yaml',
        requiresOAuth: false,
      };
      const tools: t.MCPTool[] = [{ name: 'dynamic', inputSchema: { type: 'object' } }];
      const notifySpy = jest
        .spyOn(toolsChanged, 'notifyMCPToolsChanged')
        .mockResolvedValue(undefined);
      mockAppConnections({ has: jest.fn().mockResolvedValue(false) });
      (mockRegistryInstance.getServerConfig as jest.Mock).mockResolvedValue(serverConfig);
      mockProcessMCPEnv.mockImplementation(({ options }) => ({
        ...options,
        url: 'https://mcp.example.com/conversation-1',
      }));
      (MCPConnectionFactory.create as jest.Mock).mockResolvedValue(mockConnection);

      try {
        const manager = await MCPManager.createInstance(newMCPServersConfig());
        await manager.getUserConnection({
          serverName,
          user: mockUser,
          requestBody: { conversationId: 'conversation-1' },
        });

        const listener = (mockConnection.on as jest.Mock).mock.calls.find(
          ([eventName]) => eventName === 'toolsChanged',
        )?.[1];
        expect(listener).toEqual(expect.any(Function));
        listener(tools);

        expect(notifySpy).toHaveBeenCalledWith({
          tools,
          userId,
          serverName,
          serverConfig,
          capabilityProfile: STANDARD_MCP_CAPABILITY_PROFILE,
        });
      } finally {
        notifySpy.mockRestore();
      }
    });

    it('refreshes a newly recreated durable user connection after subscribing', async () => {
      mockAppConnections({ has: jest.fn().mockResolvedValue(false) });
      (mockRegistryInstance.getServerConfig as jest.Mock).mockResolvedValue({
        type: 'streamable-http',
        url: 'https://mcp.example.com/mcp',
        source: 'yaml',
        startup: false,
      });
      (MCPConnectionFactory.create as jest.Mock).mockResolvedValue(mockConnection);

      const manager = await MCPManager.createInstance(newMCPServersConfig());
      await manager.getUserConnection({ serverName, user: mockUser });

      expect(mockConnection.on).toHaveBeenCalledWith('toolsChanged', expect.any(Function));
      expect(mockConnection.refreshToolList).toHaveBeenCalledTimes(1);
    });

    it.each(['headers', 'requestHeaders'] as const)(
      'recovers an initial tools/list rejection with %s and preserves the replacement identity',
      async (headerMap) => {
        const authenticationError = Object.assign(new Error('unauthorized'), { status: 401 });
        const rejectedConnection = newUserConnection();
        const replacementConnection = newUserConnection();
        (rejectedConnection.refreshToolList as jest.Mock).mockResolvedValue({
          tools: [],
          complete: false,
          authenticationError,
        });
        (replacementConnection.refreshToolList as jest.Mock).mockResolvedValue({
          tools: [],
          complete: false,
          authenticationError,
        });
        const directBearerConfig: t.ParsedServerConfig = {
          type: 'streamable-http',
          url: 'https://mcp.example.com/mcp',
          source: 'yaml',
          ...(headerMap === 'requestHeaders' && {
            apiKey: {
              source: 'admin' as const,
              authorization_type: 'bearer' as const,
              key: 'catalog-key',
            },
          }),
          [headerMap]: {
            Authorization: 'Bearer {{LIBRECHAT_OPENID_ACCESS_TOKEN}}',
            'X-Conversation': '{{LIBRECHAT_BODY_CONVERSATIONID}}',
          },
        };
        const upstreamTokenProvider = jest
          .fn()
          .mockResolvedValueOnce({ access_token: 'stale-token' })
          .mockResolvedValueOnce({ access_token: 'fresh-token' })
          .mockResolvedValueOnce({ access_token: 'fresh-token' });
        mockAppConnections({ has: jest.fn().mockResolvedValue(false) });
        (mockRegistryInstance.getServerConfig as jest.Mock).mockResolvedValue(directBearerConfig);
        (MCPConnectionFactory.create as jest.Mock)
          .mockResolvedValueOnce(rejectedConnection)
          .mockResolvedValueOnce(replacementConnection);

        const manager = await MCPManager.createInstance(newMCPServersConfig());
        await expect(
          manager.getUserConnection({
            serverName,
            user: mockUser,
            requestBody: { conversationId: 'conversation-1' },
            upstreamTokenProvider,
          }),
        ).rejects.toMatchObject({
          code: 'MCP_AUTHENTICATION_REJECTED',
          connectionRefreshed: false,
        } satisfies Partial<MCPAuthenticationRejectedError>);

        expect(rejectedConnection.dispose).toHaveBeenCalledTimes(1);
        expect(MCPConnectionFactory.create).toHaveBeenCalledTimes(2);
        expect(MCPConnectionFactory.create).toHaveBeenLastCalledWith(
          expect.objectContaining({
            ephemeralConnection: true,
            directBearerRecoveryState: expect.objectContaining({ attempted: true }),
          }),
          expect.any(Object),
        );
        expect(upstreamTokenProvider.mock.calls).toEqual([
          [{ forceRefresh: false }],
          [{ forceRefresh: true }],
        ]);
        expect(MCPConnectionFactory.create).toHaveBeenLastCalledWith(
          expect.objectContaining({
            serverDefinition: directBearerConfig,
            directBearerSourceConfig: expect.objectContaining({
              headers: {
                Authorization: 'Bearer {{LIBRECHAT_OPENID_ACCESS_TOKEN}}',
                'X-Conversation': '{{LIBRECHAT_BODY_CONVERSATIONID}}',
              },
            }),
            serverConfig: expect.objectContaining({
              headers: expect.objectContaining({ Authorization: 'Bearer fresh-token' }),
            }),
          }),
          expect.any(Object),
        );
      },
    );

    it.each([false, true])(
      'does not publish a cancelled initial catalog (request-scoped=%s)',
      async (requestScoped) => {
        const controller = new AbortController();
        const candidate = newUserConnection();
        let finishCatalog: (() => void) | undefined;
        (candidate.refreshToolList as jest.Mock).mockReturnValue(
          new Promise<void>((resolve) => {
            finishCatalog = resolve;
          }),
        );
        const config: t.ParsedServerConfig = {
          type: 'streamable-http',
          url: 'https://mcp.example.com',
          source: 'yaml',
          headers: {
            Authorization: 'Bearer {{LIBRECHAT_OPENID_ACCESS_TOKEN}}',
            ...(requestScoped && { 'X-Conversation': '{{LIBRECHAT_BODY_CONVERSATIONID}}' }),
          },
        };
        const store = { connections: new Map(), pending: new Map() };
        mockAppConnections({ has: jest.fn().mockResolvedValue(false) });
        (graphUtils.preProcessGraphTokens as jest.Mock).mockImplementation(
          async (options) => options,
        );
        (MCPConnectionFactory.create as jest.Mock).mockResolvedValue(candidate);
        const manager = await MCPManager.createInstance(newMCPServersConfig());
        const creating = manager.getUserConnection({
          serverName,
          serverConfig: config,
          user: mockUser,
          signal: controller.signal,
          requestBody: { conversationId: 'conversation-1' },
          requestScopedConnections: requestScoped ? store : undefined,
          upstreamTokenProvider: jest.fn().mockResolvedValue({ access_token: 'token' }),
        });
        const outcome = creating.catch((error: Error) => error);
        for (
          let attempt = 0;
          attempt < 20 && !(candidate.refreshToolList as jest.Mock).mock.calls.length;
          attempt++
        ) {
          await new Promise((resolve) => setImmediate(resolve));
        }
        expect(candidate.refreshToolList).toHaveBeenCalledWith(controller.signal);
        controller.abort(new Error('request stopped'));
        finishCatalog?.();
        await expect(outcome).resolves.toMatchObject({ message: 'request stopped' });
        expect(candidate.dispose).toHaveBeenCalledTimes(1);
        expect(manager.getUserConnections(mockUser.id)?.has(serverName)).not.toBe(true);
        expect(store.connections.size).toBe(0);
      },
    );

    it.each(
      [
        { stage: 'initialize', cancelJoiner: false, mutate: false },
        { stage: 'catalog', cancelJoiner: false, mutate: false },
        { stage: 'initialize', cancelJoiner: true, mutate: false },
        { stage: 'catalog', cancelJoiner: true, mutate: false },
        { stage: 'initialize', cancelJoiner: false, mutate: true },
        { stage: 'catalog', cancelJoiner: false, mutate: true },
      ].flatMap((scenario) => ['direct', 'oauth', 'custom'].map((mode) => ({ ...scenario, mode }))),
    )(
      'isolates a stopped $mode creation leader during $stage (cancelJoiner=$cancelJoiner, mutate=$mutate)',
      async ({ stage, cancelJoiner, mutate, mode }) => {
        const leaderAbort = new AbortController();
        const joinerAbort = new AbortController();
        const candidate = newUserConnection();
        const replacement = newUserConnection();
        let entered!: () => void;
        const started = new Promise<void>((resolve) => {
          entered = resolve;
        });
        const waitForAbort = () =>
          new Promise<never>((_, reject) => {
            leaderAbort.signal.addEventListener('abort', () => reject(leaderAbort.signal.reason), {
              once: true,
            });
            entered();
          });
        if (stage === 'catalog') {
          (candidate.refreshToolList as jest.Mock).mockImplementationOnce(waitForAbort);
        }
        const config: t.ParsedServerConfig = {
          type: 'streamable-http',
          url: 'https://mcp.example.com',
          source: 'yaml',
          headers: {
            Authorization:
              mode === 'direct' ? 'Bearer {{LIBRECHAT_OPENID_ACCESS_TOKEN}}' : '{{MCP_API_KEY}}',
          },
          ...(mode === 'oauth' && { oauth: { client_id: 'test-client' }, requiresOAuth: true }),
        };
        mockAppConnections({ has: jest.fn().mockResolvedValue(false) });
        (graphUtils.preProcessGraphTokens as jest.Mock).mockImplementation(
          async (options) => options,
        );
        (MCPConnectionFactory.create as jest.Mock)
          .mockReset()
          .mockImplementationOnce((basic: t.BasicConnectionOptions) => {
            basic.directBearerRecoveryState!.attempted = mode === 'direct';
            return stage === 'initialize' ? waitForAbort() : Promise.resolve(candidate);
          })
          .mockResolvedValue(replacement);
        const manager = await MCPManager.createInstance(newMCPServersConfig());
        const opts = {
          serverName,
          serverConfig: config,
          user: mockUser,
          upstreamTokenProvider: jest.fn().mockResolvedValue({ access_token: 'token' }),
          customUserVars: { MCP_API_KEY: 'custom-key' },
          flowManager: {} as Parameters<typeof manager.callTool>[0]['flowManager'],
        };
        const leader = manager.getUserConnection({ ...opts, signal: leaderAbort.signal });
        const leaderOutcome = leader.catch((error: Error) => error);
        await started;
        const joiner = manager.getUserConnection({ ...opts, signal: joinerAbort.signal });
        const joinerOutcome = joiner.catch((error: Error) => error);
        await new Promise((resolve) => setImmediate(resolve));
        if (cancelJoiner) {
          joinerAbort.abort(new Error('joiner stopped'));
        }
        if (mutate) {
          await manager.disconnectUserConnection(mockUser.id, serverName);
        }
        leaderAbort.abort(new Error('leader stopped'));
        await expect(leaderOutcome).resolves.toMatchObject({ message: 'leader stopped' });
        if (cancelJoiner || mutate) {
          await expect(joinerOutcome).resolves.toMatchObject({
            message: cancelJoiner
              ? 'joiner stopped'
              : expect.stringContaining('cancelled during teardown'),
          });
          expect(MCPConnectionFactory.create).toHaveBeenCalledTimes(1);
        } else {
          await expect(joinerOutcome).resolves.toBe(replacement);
          expect(MCPConnectionFactory.create).toHaveBeenCalledTimes(2);
          expect(MCPConnectionFactory.create).toHaveBeenLastCalledWith(
            expect.objectContaining({
              directBearerRecoveryState: expect.objectContaining({ attempted: mode === 'direct' }),
            }),
            expect.objectContaining({ signal: joinerAbort.signal }),
          );
        }
        if (stage === 'catalog') {
          expect(candidate.dispose).toHaveBeenCalledTimes(1);
        }
      },
    );

    it('honors a direct bearer recovery budget consumed during factory initialization', async () => {
      const authenticationError = Object.assign(new Error('unauthorized'), { status: 401 });
      const connection = newUserConnection();
      (connection.refreshToolList as jest.Mock).mockResolvedValue({
        tools: [],
        complete: false,
        authenticationError,
      });
      const directBearerConfig: t.ParsedServerConfig = {
        type: 'streamable-http',
        url: 'https://mcp.example.com/mcp',
        source: 'yaml',
        headers: { Authorization: 'Bearer {{LIBRECHAT_OPENID_ACCESS_TOKEN}}' },
      };
      const upstreamTokenProvider = jest.fn().mockResolvedValue({ access_token: 'stale-token' });
      mockAppConnections({ has: jest.fn().mockResolvedValue(false) });
      (mockRegistryInstance.getServerConfig as jest.Mock).mockResolvedValue(directBearerConfig);
      (MCPConnectionFactory.create as jest.Mock).mockImplementation(
        async (basic: t.BasicConnectionOptions) => {
          basic.directBearerRecoveryState!.attempted = true;
          return connection;
        },
      );

      const manager = await MCPManager.createInstance(newMCPServersConfig());
      await expect(
        manager.getUserConnection({
          serverName,
          user: mockUser,
          upstreamTokenProvider,
        }),
      ).rejects.toMatchObject({
        code: 'MCP_AUTHENTICATION_REJECTED',
        connectionRefreshed: false,
      } satisfies Partial<MCPAuthenticationRejectedError>);

      expect(MCPConnectionFactory.create).toHaveBeenCalledTimes(1);
      expect(upstreamTokenProvider).toHaveBeenCalledTimes(1);
      expect(upstreamTokenProvider).not.toHaveBeenCalledWith({ forceRefresh: true });
    });

    it('fails closed when initial tools/list rejects without a live provider', async () => {
      const authenticationError = Object.assign(new Error('unauthorized'), { status: 401 });
      const connection = newUserConnection();
      (connection.refreshToolList as jest.Mock).mockResolvedValue({
        tools: [],
        complete: false,
        authenticationError,
      });
      const directBearerConfig: t.ParsedServerConfig = {
        type: 'streamable-http',
        url: 'https://mcp.example.com/mcp',
        source: 'yaml',
        headers: { Authorization: 'Bearer {{LIBRECHAT_OPENID_ACCESS_TOKEN}}' },
      };
      mockAppConnections({ has: jest.fn().mockResolvedValue(false) });
      (mockRegistryInstance.getServerConfig as jest.Mock).mockResolvedValue(directBearerConfig);
      (MCPConnectionFactory.create as jest.Mock).mockResolvedValue(connection);

      const manager = await MCPManager.createInstance(newMCPServersConfig());
      await expect(
        manager.getUserConnection({
          serverName,
          user: mockUser,
        }),
      ).rejects.toBeInstanceOf(OpenIDReauthRequiredError);

      expect(MCPConnectionFactory.create).toHaveBeenCalledTimes(1);
      expect(connection.dispose).toHaveBeenCalledTimes(1);
    });

    it.each(['serverConfig', 'connectionTarget'] as const)(
      'registers a forced creation synchronously for a supplied %s',
      async (targetKind) => {
        const config: t.ParsedServerConfig = {
          type: 'streamable-http',
          url: 'https://mcp.example.com/mcp',
          source: 'user',
          dbId: 'server-1',
        };
        const connection = newUserConnection();
        mockAppConnections({ has: jest.fn().mockResolvedValue(false) });
        (MCPConnectionFactory.create as jest.Mock).mockResolvedValue(connection);

        const manager = await MCPManager.createInstance(newMCPServersConfig());
        const target =
          targetKind === 'serverConfig'
            ? { serverConfig: config }
            : {
                connectionTarget: {
                  serverConfig: config,
                  connectionOwner: 'principal' as const,
                },
              };
        const creation = manager.getUserConnection({
          serverName,
          user: mockUser,
          forceNew: true,
          ...target,
        });
        const activeCreations = (
          manager as unknown as {
            activeConnectionCreations: Map<string, Set<unknown>>;
          }
        ).activeConnectionCreations;

        const poolKey = getMCPUserConnectionPoolKey(
          userId,
          serverName,
          STANDARD_MCP_CAPABILITY_PROFILE,
        );
        expect(activeCreations.get(poolKey)?.size).toBe(1);
        await expect(creation).resolves.toBe(connection);
        expect(activeCreations.has(poolKey)).toBe(false);
      },
    );

    it.each([false, true])(
      'cancels and disposes a pending connection during mutation teardown (forceNew=%s)',
      async (forceNew) => {
        const pendingConnection = newUserConnection();
        const neverReached = newUserConnection();
        let resolveConnection: ((connection: MCPConnection) => void) | undefined;
        const factoryResult = new Promise<MCPConnection>((resolve) => {
          resolveConnection = resolve;
        });
        mockAppConnections({ has: jest.fn().mockResolvedValue(false) });
        (mockRegistryInstance.getServerConfig as jest.Mock).mockResolvedValue({
          type: 'streamable-http',
          url: 'https://mcp.example.com/old',
          source: 'user',
          dbId: 'server-1',
        });
        (MCPConnectionFactory.create as jest.Mock)
          .mockReturnValueOnce(factoryResult)
          .mockResolvedValue(neverReached);

        const manager = await MCPManager.createInstance(newMCPServersConfig());
        const creation = manager.getUserConnection({ serverName, user: mockUser, forceNew });
        while ((MCPConnectionFactory.create as jest.Mock).mock.calls.length === 0) {
          await new Promise((resolve) => setImmediate(resolve));
        }

        await manager.disconnectUserConnection(userId, serverName);
        resolveConnection?.(pendingConnection);

        await expect(creation).rejects.toThrow('Connection creation was cancelled during teardown');
        expect(pendingConnection.removeAllListeners).toHaveBeenCalledWith('toolsChanged');
        expect(pendingConnection.dispose).toHaveBeenCalledTimes(1);
        expect(manager.getUserConnections(userId)?.has(serverName) ?? false).toBe(false);
        /** A committed mutation invalidates what the caller resolved, so nothing re-establishes. */
        expect(MCPConnectionFactory.create).toHaveBeenCalledTimes(1);
      },
    );

    it('resolves both callers when a forced replacement races a plain creation', async () => {
      const original = newUserConnection();
      const replacement = newUserConnection();
      mockAppConnections({ has: jest.fn().mockResolvedValue(false) });
      (mockRegistryInstance.getServerConfig as jest.Mock).mockResolvedValue({
        type: 'streamable-http',
        url: 'https://mcp.example.com/mcp',
        source: 'user',
        dbId: 'server-1',
      });
      (MCPConnectionFactory.create as jest.Mock).mockResolvedValue(original);

      const manager = await MCPManager.createInstance(newMCPServersConfig());
      await manager.getUserConnection({ serverName, user: mockUser });

      (MCPConnectionFactory.create as jest.Mock).mockResolvedValue(replacement);
      const results = await Promise.allSettled([
        manager.getUserConnection({ serverName, user: mockUser, forceNew: true }),
        manager.getUserConnection({ serverName, user: mockUser }),
      ]);

      expect(results.map((result) => result.status)).toEqual(['fulfilled', 'fulfilled']);
      expect(manager.getUserConnections(userId)?.get(serverName)).toBe(replacement);
      expect(original.dispose).toHaveBeenCalledTimes(1);
    });

    it('tears down idle users with a lifecycle teardown', async () => {
      mockAppConnections({ has: jest.fn().mockResolvedValue(false) });
      (mockRegistryInstance.getServerConfig as jest.Mock).mockResolvedValue({
        type: 'streamable-http',
        url: 'https://mcp.example.com/mcp',
        source: 'user',
        dbId: 'server-1',
      });
      (MCPConnectionFactory.create as jest.Mock).mockResolvedValue(newUserConnection());

      const manager = await MCPManager.createInstance(newMCPServersConfig());
      await manager.getUserConnection({ serverName, user: mockUser });
      const internals = manager as unknown as {
        userLastActivity: Map<string, number>;
        checkIdleConnections(currentUserId?: string): void;
      };
      internals.userLastActivity.set(userId, 0);
      const disconnectSpy = jest
        .spyOn(manager, 'disconnectUserConnections')
        .mockResolvedValue(undefined);

      internals.checkIdleConnections();

      expect(disconnectSpy).toHaveBeenCalledWith(userId, { reason: 'lifecycle' });
      disconnectSpy.mockRestore();
    });

    it('re-establishes a creation cancelled by a user-wide lifecycle teardown', async () => {
      const cancelledConnection = newUserConnection();
      const reestablishedConnection = newUserConnection();
      let resolveConnection: ((connection: MCPConnection) => void) | undefined;
      const factoryResult = new Promise<MCPConnection>((resolve) => {
        resolveConnection = resolve;
      });
      mockAppConnections({ has: jest.fn().mockResolvedValue(false) });
      (mockRegistryInstance.getServerConfig as jest.Mock).mockResolvedValue({
        type: 'streamable-http',
        url: 'https://mcp.example.com/mcp',
        source: 'user',
        dbId: 'server-1',
      });
      (MCPConnectionFactory.create as jest.Mock)
        .mockReturnValueOnce(factoryResult)
        .mockResolvedValue(reestablishedConnection);

      const manager = await MCPManager.createInstance(newMCPServersConfig());
      const creation = manager.getUserConnection({ serverName, user: mockUser });
      while ((MCPConnectionFactory.create as jest.Mock).mock.calls.length === 0) {
        await new Promise((resolve) => setImmediate(resolve));
      }

      await manager.disconnectUserConnections(userId, { reason: 'lifecycle' });
      resolveConnection?.(cancelledConnection);

      await expect(creation).resolves.toBe(reestablishedConnection);
      expect(cancelledConnection.dispose).toHaveBeenCalledTimes(1);
      expect(manager.getUserConnections(userId)?.get(serverName)).toBe(reestablishedConnection);
    });
    it('fails a caller-resolved creation fenced by a credential mutation', async () => {
      const fencedConnection = newUserConnection();
      const neverReached = newUserConnection();
      const serverConfig: t.ParsedServerConfig = {
        type: 'streamable-http',
        url: 'https://mcp.example.com/mcp',
        source: 'user',
        dbId: 'server-1',
      };
      let resolveConnection: ((connection: MCPConnection) => void) | undefined;
      const factoryResult = new Promise<MCPConnection>((resolve) => {
        resolveConnection = resolve;
      });
      mockAppConnections({ has: jest.fn().mockResolvedValue(false) });
      (mockRegistryInstance.getServerConfig as jest.Mock).mockResolvedValue(serverConfig);
      (MCPConnectionFactory.create as jest.Mock)
        .mockReturnValueOnce(factoryResult)
        .mockResolvedValue(neverReached);

      const manager = await MCPManager.createInstance(newMCPServersConfig());
      /** Callers resolve the config and credentials per request and hand them in; a mutation
       *  teardown invalidates both, and only the caller can resolve them again. */
      const creation = manager.getUserConnection({
        serverName,
        user: mockUser,
        serverConfig,
        customUserVars: { API_KEY: 'revoked-key' },
      });
      while ((MCPConnectionFactory.create as jest.Mock).mock.calls.length === 0) {
        await new Promise((resolve) => setImmediate(resolve));
      }

      await manager.disconnectUserConnection(userId, serverName);
      resolveConnection?.(fencedConnection);

      await expect(creation).rejects.toThrow('Connection creation was cancelled during teardown');
      expect(fencedConnection.dispose).toHaveBeenCalledTimes(1);
      expect(MCPConnectionFactory.create).toHaveBeenCalledTimes(1);
      expect(manager.getUserConnections(userId)?.has(serverName) ?? false).toBe(false);
    });

    it('keeps the activity timestamp for a connection installed during a user-wide teardown', async () => {
      const otherServer = 'other_server';
      const installedConnection = newUserConnection();
      let resolveDispose: (() => void) | undefined;
      (installedConnection.dispose as jest.Mock).mockReturnValue(
        new Promise<void>((resolve) => {
          resolveDispose = () => resolve();
        }),
      );
      const fencedConnection = newUserConnection();
      const reestablishedConnection = newUserConnection();
      let resolveConnection: ((connection: MCPConnection) => void) | undefined;
      const factoryResult = new Promise<MCPConnection>((resolve) => {
        resolveConnection = resolve;
      });
      mockAppConnections({ has: jest.fn().mockResolvedValue(false) });
      (mockRegistryInstance.getServerConfig as jest.Mock).mockResolvedValue({
        type: 'streamable-http',
        url: 'https://mcp.example.com/mcp',
        source: 'user',
        dbId: 'server-1',
      });
      (MCPConnectionFactory.create as jest.Mock)
        .mockResolvedValueOnce(installedConnection)
        .mockReturnValueOnce(factoryResult)
        .mockResolvedValue(reestablishedConnection);

      const manager = await MCPManager.createInstance(newMCPServersConfig());
      await manager.getUserConnection({ serverName, user: mockUser });
      const creation = manager.getUserConnection({ serverName: otherServer, user: mockUser });
      while ((MCPConnectionFactory.create as jest.Mock).mock.calls.length < 2) {
        await new Promise((resolve) => setImmediate(resolve));
      }

      /** The sweep is still disposing the first connection when the fenced one re-establishes. */
      const teardown = manager.disconnectUserConnections(userId, { reason: 'lifecycle' });
      resolveConnection?.(fencedConnection);
      await expect(creation).resolves.toBe(reestablishedConnection);
      resolveDispose?.();
      await teardown;

      const internals = manager as unknown as { userLastActivity: Map<string, number> };
      expect(manager.getUserConnections(userId)?.get(otherServer)).toBe(reestablishedConnection);
      expect(internals.userLastActivity.has(userId)).toBe(true);
    });

    it('does not re-establish a lifecycle-fenced creation whose caller aborted', async () => {
      const fencedConnection = newUserConnection();
      const neverReached = newUserConnection();
      let resolveConnection: ((connection: MCPConnection) => void) | undefined;
      const factoryResult = new Promise<MCPConnection>((resolve) => {
        resolveConnection = resolve;
      });
      mockAppConnections({ has: jest.fn().mockResolvedValue(false) });
      (mockRegistryInstance.getServerConfig as jest.Mock).mockResolvedValue({
        type: 'streamable-http',
        url: 'https://mcp.example.com/mcp',
        source: 'user',
        dbId: 'server-1',
      });
      (MCPConnectionFactory.create as jest.Mock)
        .mockReturnValueOnce(factoryResult)
        .mockResolvedValue(neverReached);

      const manager = await MCPManager.createInstance(newMCPServersConfig());
      const controller = new AbortController();
      const creation = manager.getUserConnection({
        serverName,
        user: mockUser,
        signal: controller.signal,
      });
      while ((MCPConnectionFactory.create as jest.Mock).mock.calls.length === 0) {
        await new Promise((resolve) => setImmediate(resolve));
      }

      controller.abort();
      await manager.disconnectUserConnection(userId, serverName, { reason: 'lifecycle' });
      resolveConnection?.(fencedConnection);

      await expect(creation).rejects.toThrow('Connection creation was cancelled during teardown');
      expect(fencedConnection.dispose).toHaveBeenCalledTimes(1);
      expect(MCPConnectionFactory.create).toHaveBeenCalledTimes(1);
      expect(manager.getUserConnections(userId)?.has(serverName) ?? false).toBe(false);
    });

    it('cancels pending tool publications before it starts disposing', async () => {
      const connection = newUserConnection();
      const cancelSpy = jest.spyOn(toolsChanged, 'cancelMCPToolsChanged');
      mockAppConnections({ has: jest.fn().mockResolvedValue(false) });
      (mockRegistryInstance.getServerConfig as jest.Mock).mockResolvedValue({
        type: 'streamable-http',
        url: 'https://mcp.example.com/mcp',
        source: 'user',
        dbId: 'server-1',
      });
      (MCPConnectionFactory.create as jest.Mock).mockResolvedValue(connection);

      try {
        const manager = await MCPManager.createInstance(newMCPServersConfig());
        await manager.getUserConnection({ serverName, user: mockUser });
        cancelSpy.mockClear();

        await manager.disconnectUserConnection(userId, serverName);

        /** A creation re-established while disposal is still awaited publishes its own catalog;
         *  a cancellation issued after that point would drop the replacement's pending change. */
        expect(cancelSpy).toHaveBeenNthCalledWith(1, {
          userId,
          serverName,
          capabilityProfile: STANDARD_MCP_CAPABILITY_PROFILE,
        });
        expect(cancelSpy).toHaveBeenNthCalledWith(2, {
          userId,
          serverName,
          capabilityProfile: MCP_APPS_CAPABILITY_PROFILE,
        });
        expect(cancelSpy).toHaveBeenCalledTimes(2);
        expect(cancelSpy.mock.invocationCallOrder[0]).toBeLessThan(
          (connection.dispose as jest.Mock).mock.invocationCallOrder[0],
        );
      } finally {
        cancelSpy.mockRestore();
      }
    });

    it('clears catalog recovery suppression for mutations but preserves it for lifecycle cleanup', async () => {
      const manager = await MCPManager.createInstance(newMCPServersConfig());
      const clearRecoveryState = jest.spyOn(manager.getCatalogRecoveryTracker(), 'clear');

      await manager.disconnectUserConnection(userId, serverName, { reason: 'lifecycle' });
      expect(clearRecoveryState).not.toHaveBeenCalled();

      await manager.disconnectUserConnection(userId, serverName);
      expect(clearRecoveryState).toHaveBeenNthCalledWith(
        1,
        userId,
        serverName,
        undefined,
        undefined,
      );
      expect(clearRecoveryState).toHaveBeenNthCalledWith(
        2,
        userId,
        serverName,
        undefined,
        STANDARD_MCP_CAPABILITY_PROFILE,
      );
      expect(clearRecoveryState).toHaveBeenNthCalledWith(
        3,
        userId,
        serverName,
        undefined,
        MCP_APPS_CAPABILITY_PROFILE,
      );
      expect(clearRecoveryState).toHaveBeenCalledTimes(3);
    });

    it('fails a creation that a lifecycle teardown keeps cancelling on every attempt', async () => {
      mockAppConnections({ has: jest.fn().mockResolvedValue(false) });
      (mockRegistryInstance.getServerConfig as jest.Mock).mockResolvedValue({
        type: 'streamable-http',
        url: 'https://mcp.example.com/mcp',
        source: 'user',
        dbId: 'server-1',
      });
      const manager = await MCPManager.createInstance(newMCPServersConfig());
      (MCPConnectionFactory.create as jest.Mock).mockReset();
      (MCPConnectionFactory.create as jest.Mock).mockImplementation(async () => {
        const connection = newUserConnection();
        await manager.disconnectUserConnection(userId, serverName, { reason: 'lifecycle' });
        return connection;
      });

      await expect(manager.getUserConnection({ serverName, user: mockUser })).rejects.toThrow(
        'Connection creation was cancelled during teardown',
      );
      expect(MCPConnectionFactory.create).toHaveBeenCalledTimes(4);
      expect(manager.getUserConnections(userId)?.has(serverName) ?? false).toBe(false);
    });

    it('disposes the tracked durable connection before a forced replacement', async () => {
      const previousConnection = newUserConnection();
      const replacementConnection = newUserConnection();
      mockAppConnections({ has: jest.fn().mockResolvedValue(false) });
      (mockRegistryInstance.getServerConfig as jest.Mock).mockResolvedValue({
        type: 'streamable-http',
        url: 'https://mcp.example.com/mcp',
        source: 'yaml',
        startup: false,
      });
      (MCPConnectionFactory.create as jest.Mock)
        .mockResolvedValueOnce(previousConnection)
        .mockResolvedValueOnce(replacementConnection);

      const manager = await MCPManager.createInstance(newMCPServersConfig());
      await manager.getUserConnection({ serverName, user: mockUser });
      const result = await manager.getUserConnection({
        serverName,
        user: mockUser,
        forceNew: true,
      });

      expect(previousConnection.removeAllListeners).toHaveBeenCalledWith('toolsChanged');
      expect(previousConnection.dispose).toHaveBeenCalledTimes(1);
      expect((previousConnection.dispose as jest.Mock).mock.invocationCallOrder[0]).toBeLessThan(
        (MCPConnectionFactory.create as jest.Mock).mock.invocationCallOrder[1],
      );
      expect(result).toBe(replacementConnection);
      expect(manager.getUserConnections(userId)?.get(serverName)).toBe(replacementConnection);
    });

    it('serializes an ordinary load with multiple queued forced replacements', async () => {
      const initial = newUserConnection();
      const firstReplacement = newUserConnection();
      const secondReplacement = newUserConnection();
      let resolveFirst: ((connection: MCPConnection) => void) | undefined;
      let resolveSecond: ((connection: MCPConnection) => void) | undefined;
      const firstFactoryResult = new Promise<MCPConnection>((resolve) => {
        resolveFirst = resolve;
      });
      const secondFactoryResult = new Promise<MCPConnection>((resolve) => {
        resolveSecond = resolve;
      });
      mockAppConnections({ has: jest.fn().mockResolvedValue(false) });
      (mockRegistryInstance.getServerConfig as jest.Mock).mockResolvedValue({
        type: 'streamable-http',
        url: 'https://mcp.example.com/mcp',
        source: 'yaml',
        startup: false,
      });
      (MCPConnectionFactory.create as jest.Mock)
        .mockResolvedValueOnce(initial)
        .mockReturnValueOnce(firstFactoryResult)
        .mockReturnValueOnce(secondFactoryResult);

      const manager = await MCPManager.createInstance(newMCPServersConfig());
      await manager.getUserConnection({ serverName, user: mockUser });
      const firstForced = manager.getUserConnection({ serverName, user: mockUser, forceNew: true });
      while ((MCPConnectionFactory.create as jest.Mock).mock.calls.length < 2) {
        await new Promise((resolve) => setImmediate(resolve));
      }
      const ordinary = manager.getUserConnection({ serverName, user: mockUser });
      const secondForced = manager.getUserConnection({
        serverName,
        user: mockUser,
        forceNew: true,
      });

      resolveFirst?.(firstReplacement);
      await expect(firstForced).resolves.toBe(firstReplacement);
      await expect(ordinary).resolves.toBe(firstReplacement);
      while ((MCPConnectionFactory.create as jest.Mock).mock.calls.length < 3) {
        await new Promise((resolve) => setImmediate(resolve));
      }
      resolveSecond?.(secondReplacement);

      await expect(secondForced).resolves.toBe(secondReplacement);
      expect(MCPConnectionFactory.create).toHaveBeenCalledTimes(3);
      expect(firstReplacement.dispose).toHaveBeenCalledTimes(1);
      expect(manager.getUserConnections(userId)?.get(serverName)).toBe(secondReplacement);
    });

    it('disposes a retained disconnected connection before recreating it', async () => {
      const createConnection = (connected: boolean) =>
        ({
          isConnected: jest.fn().mockResolvedValue(connected),
          isStale: jest.fn().mockReturnValue(false),
          disconnect: jest.fn().mockResolvedValue(undefined),
          refreshToolList: jest.fn().mockResolvedValue(undefined),
          on: jest.fn(),
          removeAllListeners: jest.fn(),
          dispose: jest.fn().mockResolvedValue(undefined),
        }) as unknown as MCPConnection;
      const disconnectedConnection = createConnection(false);
      const replacementConnection = createConnection(true);
      (disconnectedConnection.isConnected as jest.Mock)
        .mockResolvedValueOnce(true)
        .mockResolvedValue(false);
      mockAppConnections({ has: jest.fn().mockResolvedValue(false) });
      (mockRegistryInstance.getServerConfig as jest.Mock).mockResolvedValue({
        type: 'streamable-http',
        url: 'https://mcp.example.com/mcp',
        source: 'yaml',
        startup: false,
      });
      (MCPConnectionFactory.create as jest.Mock)
        .mockResolvedValueOnce(disconnectedConnection)
        .mockResolvedValueOnce(replacementConnection);

      const manager = await MCPManager.createInstance(newMCPServersConfig());
      await manager.getUserConnection({ serverName, user: mockUser });
      const result = await manager.getUserConnection({ serverName, user: mockUser });

      expect(disconnectedConnection.removeAllListeners).toHaveBeenCalledWith('toolsChanged');
      expect(disconnectedConnection.dispose).toHaveBeenCalledTimes(1);
      expect(
        (disconnectedConnection.dispose as jest.Mock).mock.invocationCallOrder[0],
      ).toBeLessThan((MCPConnectionFactory.create as jest.Mock).mock.invocationCallOrder[1]);
      expect(result).toBe(replacementConnection);
      expect(manager.getUserConnections(userId)?.get(serverName)).toBe(replacementConnection);
    });

    it('binds durable tool publications to the generation captured before connection creation', async () => {
      const generationSpy = jest
        .spyOn(toolsChanged, 'getMCPToolsChangedGeneration')
        .mockResolvedValue('generation-a');
      const notifySpy = jest
        .spyOn(toolsChanged, 'notifyMCPToolsChanged')
        .mockResolvedValue(undefined);
      const serverConfig: t.ParsedServerConfig = {
        type: 'streamable-http',
        url: 'https://mcp.example.com/mcp',
        source: 'yaml',
        startup: false,
      };
      mockAppConnections({
        has: jest.fn().mockResolvedValue(false),
        get: jest.fn().mockResolvedValue(null),
      });
      (mockRegistryInstance.getServerConfig as jest.Mock).mockResolvedValue(serverConfig);
      (MCPConnectionFactory.create as jest.Mock).mockResolvedValue(mockConnection);
      const expectedToolFunctions: t.LCAvailableTools = {
        [`current_mcp_${serverName}`]: {
          type: 'function',
          function: {
            name: `current_mcp_${serverName}`,
            description: '',
            parameters: { type: 'object' },
          },
        },
      };
      (MCPServerInspector.getToolCatalog as jest.Mock).mockResolvedValue({
        tools: expectedToolFunctions,
      });

      try {
        const manager = await MCPManager.createInstance(newMCPServersConfig());
        await manager.getUserConnection({ serverName, user: mockUser });
        const listener = (mockConnection.on as jest.Mock).mock.calls.find(
          ([eventName]) => eventName === 'toolsChanged',
        )?.[1];
        const tools: t.MCPTool[] = [{ name: 'current', inputSchema: { type: 'object' } }];
        listener(tools);
        const deadlineMs = Date.now() + 3000;
        const snapshot = await manager.getServerToolFunctionsSnapshot(
          userId,
          serverName,
          undefined,
          {
            deadlineMs,
          },
        );

        expect(generationSpy).toHaveBeenCalledWith({ userId, serverName });
        expect(snapshot).toEqual({
          tools: expectedToolFunctions,
          publicationGeneration: 'generation-a',
        });
        expect(MCPServerInspector.getToolCatalog).toHaveBeenCalledWith(
          serverName,
          mockConnection,
          deadlineMs,
          expect.any(AbortSignal),
        );
        expect(notifySpy).toHaveBeenCalledWith({
          tools,
          userId,
          serverName,
          serverConfig,
          publicationGeneration: 'generation-a',
          capabilityProfile: STANDARD_MCP_CAPABILITY_PROFILE,
        });
      } finally {
        generationSpy.mockRestore();
        notifySpy.mockRestore();
      }
    });

    it('rejects a live snapshot after another replica rotates its publication generation', async () => {
      const generationSpy = jest
        .spyOn(toolsChanged, 'getMCPToolsChangedGeneration')
        .mockResolvedValueOnce('generation-a')
        .mockResolvedValue('generation-b');
      const connection = {
        isConnected: jest.fn().mockResolvedValue(true),
        isStale: jest.fn().mockReturnValue(false),
        refreshToolList: jest.fn().mockResolvedValue(undefined),
        on: jest.fn(),
        removeAllListeners: jest.fn(),
        dispose: jest.fn().mockResolvedValue(undefined),
      } as unknown as MCPConnection;
      const serverConfig: t.ParsedServerConfig = {
        type: 'streamable-http',
        url: 'https://mcp.example.com/mcp',
        source: 'user',
        dbId: 'server-1',
      };
      mockAppConnections({ has: jest.fn().mockResolvedValue(false) });
      (mockRegistryInstance.getServerConfig as jest.Mock).mockResolvedValue(serverConfig);
      (MCPConnectionFactory.create as jest.Mock).mockResolvedValue(connection);

      try {
        const manager = await MCPManager.createInstance(newMCPServersConfig());
        await manager.getUserConnection({ serverName, user: mockUser });

        await expect(
          manager.getServerToolFunctionsSnapshot(userId, serverName, serverConfig),
        ).resolves.toEqual({ tools: null });
        expect(MCPServerInspector.getToolCatalog).not.toHaveBeenCalled();
        expect(connection.dispose).toHaveBeenCalledTimes(1);
      } finally {
        generationSpy.mockRestore();
      }
    });

    it('rejects an old-config connection even when Redis generation rotation failed', async () => {
      const generationSpy = jest
        .spyOn(toolsChanged, 'getMCPToolsChangedGeneration')
        .mockResolvedValue('generation-a');
      const connection = {
        isConnected: jest.fn().mockResolvedValue(true),
        isStale: jest.fn().mockReturnValue(false),
        refreshToolList: jest.fn().mockResolvedValue(undefined),
        on: jest.fn(),
        removeAllListeners: jest.fn(),
        dispose: jest.fn().mockResolvedValue(undefined),
      } as unknown as MCPConnection;
      const oldConfig: t.ParsedServerConfig = {
        type: 'streamable-http',
        url: 'https://old.example.com/mcp',
        source: 'user',
        dbId: 'server-1',
      };
      const committedConfig: t.ParsedServerConfig = {
        ...oldConfig,
        url: 'https://new.example.com/mcp',
      };
      mockAppConnections({ has: jest.fn().mockResolvedValue(false) });
      (mockRegistryInstance.getServerConfig as jest.Mock).mockResolvedValue(oldConfig);
      (MCPConnectionFactory.create as jest.Mock).mockResolvedValue(connection);

      try {
        const manager = await MCPManager.createInstance(newMCPServersConfig());
        await manager.getUserConnection({ serverName, user: mockUser, serverConfig: oldConfig });

        await expect(
          manager.getServerToolFunctionsSnapshot(userId, serverName, committedConfig),
        ).resolves.toEqual({ tools: null });
        expect(MCPServerInspector.getToolCatalog).not.toHaveBeenCalled();
        expect(connection.dispose).toHaveBeenCalledTimes(1);
      } finally {
        generationSpy.mockRestore();
      }
    });

    it('rejects a connection for a deleted config even when Redis generation rotation failed', async () => {
      const generationSpy = jest
        .spyOn(toolsChanged, 'getMCPToolsChangedGeneration')
        .mockResolvedValue('generation-a');
      const connection = {
        isConnected: jest.fn().mockResolvedValue(true),
        isStale: jest.fn().mockReturnValue(false),
        refreshToolList: jest.fn().mockResolvedValue(undefined),
        on: jest.fn(),
        removeAllListeners: jest.fn(),
        dispose: jest.fn().mockResolvedValue(undefined),
      } as unknown as MCPConnection;
      const oldConfig: t.ParsedServerConfig = {
        type: 'streamable-http',
        url: 'https://old.example.com/mcp',
        source: 'user',
        dbId: 'server-1',
      };
      mockAppConnections({ has: jest.fn().mockResolvedValue(false) });
      (mockRegistryInstance.getServerConfig as jest.Mock).mockResolvedValue(oldConfig);
      (MCPConnectionFactory.create as jest.Mock).mockResolvedValue(connection);

      try {
        const manager = await MCPManager.createInstance(newMCPServersConfig());
        await manager.getUserConnection({ serverName, user: mockUser, serverConfig: oldConfig });
        (mockRegistryInstance.getServerConfig as jest.Mock).mockResolvedValue(null);

        await expect(manager.getServerToolFunctionsSnapshot(userId, serverName)).resolves.toEqual({
          tools: null,
        });
        expect(MCPServerInspector.getToolCatalog).not.toHaveBeenCalled();
        expect(connection.dispose).toHaveBeenCalledTimes(1);
      } finally {
        generationSpy.mockRestore();
      }
    });

    it('renews the publication lease when an active durable connection is reused', async () => {
      const generationSpy = jest
        .spyOn(toolsChanged, 'getMCPToolsChangedGeneration')
        .mockResolvedValue('generation-a');
      const renewalSpy = jest
        .spyOn(toolsChanged, 'renewMCPToolsChangedGeneration')
        .mockResolvedValue(true);
      const serverConfig: t.ParsedServerConfig = {
        type: 'streamable-http',
        url: 'https://mcp.example.com/mcp',
        source: 'yaml',
        startup: false,
      };
      mockAppConnections({ has: jest.fn().mockResolvedValue(false) });
      (mockRegistryInstance.getServerConfig as jest.Mock).mockResolvedValue(serverConfig);
      (MCPConnectionFactory.create as jest.Mock).mockResolvedValue(mockConnection);

      try {
        const manager = await MCPManager.createInstance(newMCPServersConfig());
        await manager.getUserConnection({ serverName, user: mockUser });
        const internals = manager as unknown as {
          toolPublicationLeaseRefreshes: WeakMap<MCPConnection, number>;
        };
        renewalSpy.mockClear();
        internals.toolPublicationLeaseRefreshes.set(mockConnection, 0);

        await manager.getUserConnection({ serverName, user: mockUser });

        expect(renewalSpy).toHaveBeenCalledWith({
          userId,
          serverName,
          publicationGeneration: 'generation-a',
        });
        expect(renewalSpy).toHaveBeenCalledTimes(1);
      } finally {
        generationSpy.mockRestore();
        renewalSpy.mockRestore();
      }
    });

    it('disposes and rejects a reused connection after lease renewal loses ownership', async () => {
      const generationSpy = jest
        .spyOn(toolsChanged, 'getMCPToolsChangedGeneration')
        .mockResolvedValue('generation-a');
      const renewalSpy = jest
        .spyOn(toolsChanged, 'renewMCPToolsChangedGeneration')
        .mockResolvedValue(true);
      const connection = {
        isConnected: jest.fn().mockResolvedValue(true),
        isStale: jest.fn().mockReturnValue(false),
        refreshToolList: jest.fn().mockResolvedValue(undefined),
        on: jest.fn(),
        removeAllListeners: jest.fn(),
        dispose: jest.fn().mockResolvedValue(undefined),
      } as unknown as MCPConnection;
      const serverConfig: t.ParsedServerConfig = {
        type: 'streamable-http',
        url: 'https://mcp.example.com/mcp',
        source: 'yaml',
        startup: false,
      };
      mockAppConnections({ has: jest.fn().mockResolvedValue(false) });
      (mockRegistryInstance.getServerConfig as jest.Mock).mockResolvedValue(serverConfig);
      (MCPConnectionFactory.create as jest.Mock).mockResolvedValue(connection);

      try {
        const manager = await MCPManager.createInstance(newMCPServersConfig());
        await manager.getUserConnection({ serverName, user: mockUser });
        const internals = manager as unknown as {
          toolPublicationLeaseRefreshes: WeakMap<MCPConnection, number>;
        };
        internals.toolPublicationLeaseRefreshes.set(connection, 0);
        renewalSpy.mockResolvedValue(false);

        await expect(manager.getUserConnection({ serverName, user: mockUser })).rejects.toThrow(
          'Publication lease is no longer current',
        );

        expect(connection.removeAllListeners).toHaveBeenCalledWith('toolsChanged');
        expect(connection.dispose).toHaveBeenCalled();
        expect(manager.getUserConnections(userId)?.has(serverName) ?? false).toBe(false);
      } finally {
        generationSpy.mockRestore();
        renewalSpy.mockRestore();
      }
    });

    it('leases a new connection under the generation its own credential refresh published', async () => {
      const generationSpy = jest
        .spyOn(toolsChanged, 'getMCPToolsChangedGeneration')
        .mockResolvedValue('generation-a');
      const renewalSpy = jest
        .spyOn(toolsChanged, 'renewMCPToolsChangedGeneration')
        .mockResolvedValue(true);
      const { serverConfig, flowManager } = refreshingOAuthServer();

      try {
        const manager = await MCPManager.createInstance(newMCPServersConfig());
        await manager.getUserConnection({
          serverName,
          user: mockUser,
          flowManager,
          serverConfig,
          onOAuthCredentialsChanging: async () => async () => 'generation-b',
        });

        expect(renewalSpy).toHaveBeenCalledWith({
          userId,
          serverName,
          publicationGeneration: 'generation-b',
        });
      } finally {
        generationSpy.mockRestore();
        renewalSpy.mockRestore();
      }
    });

    it('still fences a new connection when a rotation follows its own credential refresh', async () => {
      const generationSpy = jest
        .spyOn(toolsChanged, 'getMCPToolsChangedGeneration')
        .mockResolvedValue('generation-a');
      const renewalSpy = jest
        .spyOn(toolsChanged, 'renewMCPToolsChangedGeneration')
        .mockResolvedValue(false);
      const { serverConfig, flowManager, connection } = refreshingOAuthServer();

      try {
        const manager = await MCPManager.createInstance(newMCPServersConfig());
        await expect(
          manager.getUserConnection({
            serverName,
            user: mockUser,
            flowManager,
            serverConfig,
            onOAuthCredentialsChanging: async () => async () => 'generation-b',
          }),
        ).rejects.toThrow('Publication lease is no longer current');

        expect(renewalSpy).toHaveBeenCalledWith({
          userId,
          serverName,
          publicationGeneration: 'generation-b',
        });
        expect(connection.dispose).toHaveBeenCalled();
        expect(manager.getUserConnections(userId)?.has(serverName) ?? false).toBe(false);
      } finally {
        generationSpy.mockRestore();
        renewalSpy.mockRestore();
      }
    });

    it('leases a new connection under the carried generation while it is the one currently stored', async () => {
      const generationSpy = jest
        .spyOn(toolsChanged, 'getMCPToolsChangedGeneration')
        .mockResolvedValue('generation-a');
      const renewalSpy = jest
        .spyOn(toolsChanged, 'renewMCPToolsChangedGeneration')
        .mockResolvedValue(true);
      const { serverConfig, flowManager } = adoptingOAuthServer(async (options) => {
        generationSpy.mockResolvedValue('generation-b');
        await options.onOAuthCredentialsAdopted?.('generation-b');
      });

      try {
        const manager = await MCPManager.createInstance(newMCPServersConfig());
        await manager.getUserConnection({ serverName, user: mockUser, flowManager, serverConfig });

        expect(renewalSpy).toHaveBeenCalledWith({
          userId,
          serverName,
          publicationGeneration: 'generation-b',
        });
      } finally {
        generationSpy.mockRestore();
        renewalSpy.mockRestore();
      }
    });

    it('keeps its captured generation when the carried one is no longer stored', async () => {
      const generationSpy = jest
        .spyOn(toolsChanged, 'getMCPToolsChangedGeneration')
        .mockResolvedValue('generation-a');
      const renewalSpy = jest
        .spyOn(toolsChanged, 'renewMCPToolsChangedGeneration')
        .mockResolvedValue(true);
      const { serverConfig, flowManager } = adoptingOAuthServer((options) =>
        options.onOAuthCredentialsAdopted?.('generation-b'),
      );

      try {
        const manager = await MCPManager.createInstance(newMCPServersConfig());
        await manager.getUserConnection({ serverName, user: mockUser, flowManager, serverConfig });

        expect(renewalSpy).toHaveBeenCalledWith({
          userId,
          serverName,
          publicationGeneration: 'generation-a',
        });
        expect(renewalSpy).not.toHaveBeenCalledWith(
          expect.objectContaining({ publicationGeneration: 'generation-b' }),
        );
      } finally {
        generationSpy.mockRestore();
        renewalSpy.mockRestore();
      }
    });

    it('lets an ephemeral flow owner carry the peer generation to persistent waiters', async () => {
      const generationSpy = jest
        .spyOn(toolsChanged, 'getMCPToolsChangedGeneration')
        .mockResolvedValue('peer-generation');
      let captured: string | void;
      const { serverConfig, flowManager } = adoptingOAuthServer(async (options) => {
        captured = await options.onOAuthCredentialsInvalidated?.();
      });
      try {
        const manager = await MCPManager.createInstance(newMCPServersConfig());
        await manager.getUserConnection({
          serverName,
          user: mockUser,
          flowManager,
          serverConfig,
          ephemeralConnection: true,
        });
        expect(captured!).toBe('peer-generation');
      } finally {
        generationSpy.mockRestore();
      }
    });

    it('re-captures the generation before re-reading credentials a change invalidated', async () => {
      const generationSpy = jest
        .spyOn(toolsChanged, 'getMCPToolsChangedGeneration')
        .mockResolvedValue('generation-a');
      const renewalSpy = jest
        .spyOn(toolsChanged, 'renewMCPToolsChangedGeneration')
        .mockResolvedValue(true);
      const { serverConfig, flowManager } = adoptingOAuthServer(async (options) => {
        generationSpy.mockResolvedValue('generation-c');
        await options.onOAuthCredentialsInvalidated?.();
      });

      try {
        const manager = await MCPManager.createInstance(newMCPServersConfig());
        await manager.getUserConnection({ serverName, user: mockUser, flowManager, serverConfig });

        expect(renewalSpy).toHaveBeenCalledWith({
          userId,
          serverName,
          publicationGeneration: 'generation-c',
        });
      } finally {
        generationSpy.mockRestore();
        renewalSpy.mockRestore();
      }
    });

    it('does not return a reused connection cancelled while its lease renewal is pending', async () => {
      const generationSpy = jest
        .spyOn(toolsChanged, 'getMCPToolsChangedGeneration')
        .mockResolvedValue('generation-a');
      const renewalSpy = jest
        .spyOn(toolsChanged, 'renewMCPToolsChangedGeneration')
        .mockResolvedValue(true);
      let resolveRenewal: ((renewed: boolean) => void) | undefined;
      const pendingRenewal = new Promise<boolean>((resolve) => {
        resolveRenewal = resolve;
      });
      const connection = {
        isConnected: jest.fn().mockResolvedValue(true),
        isStale: jest.fn().mockReturnValue(false),
        refreshToolList: jest.fn().mockResolvedValue(undefined),
        on: jest.fn(),
        removeAllListeners: jest.fn(),
        dispose: jest.fn().mockResolvedValue(undefined),
      } as unknown as MCPConnection;
      const serverConfig: t.ParsedServerConfig = {
        type: 'streamable-http',
        url: 'https://mcp.example.com/mcp',
        source: 'yaml',
        startup: false,
      };
      mockAppConnections({ has: jest.fn().mockResolvedValue(false) });
      (mockRegistryInstance.getServerConfig as jest.Mock).mockResolvedValue(serverConfig);
      (MCPConnectionFactory.create as jest.Mock).mockResolvedValue(connection);

      try {
        const manager = await MCPManager.createInstance(newMCPServersConfig());
        await manager.getUserConnection({ serverName, user: mockUser });
        const internals = manager as unknown as {
          toolPublicationLeaseRefreshes: WeakMap<MCPConnection, number>;
        };
        internals.toolPublicationLeaseRefreshes.set(connection, 0);
        renewalSpy.mockClear();
        renewalSpy.mockReturnValue(pendingRenewal);

        const reuse = manager.getUserConnection({ serverName, user: mockUser });
        while (renewalSpy.mock.calls.length === 0) {
          await new Promise((resolve) => setImmediate(resolve));
        }
        await manager.disconnectUserConnection(userId, serverName);
        resolveRenewal?.(true);

        await expect(reuse).rejects.toThrow('Connection creation was cancelled during teardown');
        expect(connection.dispose).toHaveBeenCalled();
      } finally {
        generationSpy.mockRestore();
        renewalSpy.mockRestore();
      }
    });

    it('should detect OAuth after resolving trusted runtime URL placeholders', async () => {
      const runtimeUrlConfig: t.ParsedServerConfig = {
        type: 'streamable-http',
        url: 'https://api.example.com/users/{{LIBRECHAT_USER_ID}}/mcp',
        source: 'yaml',
      };
      mockAppConnections({
        has: jest.fn().mockResolvedValue(false),
      });
      (mockRegistryInstance.getServerConfig as jest.Mock).mockResolvedValue(runtimeUrlConfig);
      mockProcessMCPEnv.mockImplementation(({ options, user }) => ({
        ...options,
        ...('url' in options && {
          url: options.url?.replace('{{LIBRECHAT_USER_ID}}', user?.id ?? ''),
        }),
      }));
      mockDetectOAuthRequirement.mockResolvedValue({
        requiresOAuth: true,
        method: 'protected-resource-metadata',
      });
      (MCPConnectionFactory.create as jest.Mock).mockResolvedValue(mockConnection);

      const manager = await MCPManager.createInstance(newMCPServersConfig());
      await manager.getUserConnection({
        serverName,
        user: mockUser,
        flowManager: mockFlowManager as unknown as t.UserMCPConnectionOptions['flowManager'],
      });

      expect(mockDetectOAuthRequirement).toHaveBeenCalledWith(
        'https://api.example.com/users/test-user-123/mcp',
        null,
        null,
      );
      expect(MCPConnectionFactory.create).toHaveBeenCalledWith(
        expect.objectContaining({
          serverConfig: expect.objectContaining({
            requiresOAuth: true,
          }),
        }),
        expect.objectContaining({ useOAuth: true }),
      );
    });

    it('should reject disallowed runtime URLs before OAuth detection probes them', async () => {
      const runtimeUrlConfig: t.ParsedServerConfig = {
        type: 'streamable-http',
        url: 'https://{{LIBRECHAT_BODY_CONVERSATIONID}}.example.com/mcp',
        source: 'yaml',
      };
      mockAppConnections({
        has: jest.fn().mockResolvedValue(false),
      });
      (mockRegistryInstance.getServerConfig as jest.Mock).mockResolvedValue(runtimeUrlConfig);
      (mockRegistryInstance.getAllowedDomains as jest.Mock).mockReturnValue(['*.example.com']);
      mockProcessMCPEnv.mockImplementation(({ options, body }) => ({
        ...options,
        ...('url' in options && {
          url: options.url?.replace(
            '{{LIBRECHAT_BODY_CONVERSATIONID}}',
            body?.conversationId ?? '',
          ),
        }),
      }));
      mockIsMCPDomainAllowed.mockResolvedValue(false);

      const manager = await MCPManager.createInstance(newMCPServersConfig());
      await expect(
        manager.getUserConnection({
          serverName,
          user: mockUser,
          requestBody: { conversationId: 'evil.com/path' },
          flowManager: mockFlowManager as unknown as t.UserMCPConnectionOptions['flowManager'],
        }),
      ).rejects.toThrow('not allowed by the configured domain policy');

      expect(mockDetectOAuthRequirement).not.toHaveBeenCalled();
      expect(MCPConnectionFactory.create).not.toHaveBeenCalled();
    });

    it('should reject resolved runtime URLs that fail MCP domain policy', async () => {
      const runtimeUrlConfig: t.ParsedServerConfig = {
        type: 'streamable-http',
        url: 'https://{{LIBRECHAT_BODY_CONVERSATIONID}}.example.com/mcp',
        source: 'yaml',
        requiresOAuth: false,
      };
      mockAppConnections({
        has: jest.fn().mockResolvedValue(false),
      });
      (mockRegistryInstance.getServerConfig as jest.Mock).mockResolvedValue(runtimeUrlConfig);
      (mockRegistryInstance.getAllowedDomains as jest.Mock).mockReturnValue(['*.example.com']);
      mockProcessMCPEnv.mockImplementation(({ options, body }) => ({
        ...options,
        ...('url' in options && {
          url: options.url?.replace(
            '{{LIBRECHAT_BODY_CONVERSATIONID}}',
            body?.conversationId ?? '',
          ),
        }),
      }));
      mockIsMCPDomainAllowed.mockResolvedValue(false);

      const manager = await MCPManager.createInstance(newMCPServersConfig());
      await expect(
        manager.getUserConnection({
          serverName,
          user: mockUser,
          requestBody: { conversationId: 'evil.com/path' },
        }),
      ).rejects.toThrow('not allowed by the configured domain policy');

      expect(mockIsMCPDomainAllowed).toHaveBeenCalledWith(
        expect.objectContaining({
          url: 'https://evil.com/path.example.com/mcp',
        }),
        ['*.example.com'],
        null,
      );
      expect(MCPConnectionFactory.create).not.toHaveBeenCalled();
    });

    it('should validate resolved runtime URLs without passing resolved configs to the factory', async () => {
      const runtimeUrlConfig: t.ParsedServerConfig = {
        type: 'streamable-http',
        url: 'https://{{LIBRECHAT_BODY_CONVERSATIONID}}.example.com/mcp',
        source: 'yaml',
        requiresOAuth: false,
      };
      mockAppConnections({
        has: jest.fn().mockResolvedValue(false),
      });
      (mockRegistryInstance.getServerConfig as jest.Mock).mockResolvedValue(runtimeUrlConfig);
      (mockRegistryInstance.getAllowedDomains as jest.Mock).mockReturnValue(['*.example.com']);
      mockProcessMCPEnv.mockImplementation(({ options, body }) => ({
        ...options,
        ...('url' in options && {
          url: options.url?.replace(
            '{{LIBRECHAT_BODY_CONVERSATIONID}}',
            body?.conversationId ?? '',
          ),
        }),
      }));
      mockIsMCPDomainAllowed.mockResolvedValue(true);
      (MCPConnectionFactory.create as jest.Mock).mockResolvedValue(mockConnection);

      const manager = await MCPManager.createInstance(newMCPServersConfig());
      await manager.getUserConnection({
        serverName,
        user: mockUser,
        requestBody: { conversationId: 'tenant-a' },
      });

      expect(mockIsMCPDomainAllowed).toHaveBeenCalledWith(
        expect.objectContaining({
          url: 'https://tenant-a.example.com/mcp',
        }),
        ['*.example.com'],
        null,
      );
      expect(MCPConnectionFactory.create).toHaveBeenCalledWith(
        expect.objectContaining({
          serverConfig: expect.objectContaining({
            url: 'https://{{LIBRECHAT_BODY_CONVERSATIONID}}.example.com/mcp',
          }),
        }),
        expect.objectContaining({
          requestBody: { conversationId: 'tenant-a' },
        }),
      );
    });

    it('should keep graph placeholders unresolved for user-sourced connection configs', async () => {
      const graphConfig: t.ParsedServerConfig = {
        type: 'streamable-http',
        url: 'https://api.example.com/mcp',
        source: 'user',
        dbId: 'user-server-id',
        requiresOAuth: false,
        headers: {
          Authorization: 'Bearer {{LIBRECHAT_GRAPH_ACCESS_TOKEN}}',
        },
      };
      mockAppConnections({
        has: jest.fn().mockResolvedValue(false),
      });
      (mockRegistryInstance.getServerConfig as jest.Mock).mockResolvedValue(graphConfig);
      (MCPConnectionFactory.create as jest.Mock).mockResolvedValue(mockConnection);

      const manager = await MCPManager.createInstance(newMCPServersConfig());
      await manager.getUserConnection({
        serverName,
        user: mockUser,
        graphTokenResolver: jest.fn(),
      });

      expect(graphUtils.preProcessGraphTokens).not.toHaveBeenCalled();
      expect(MCPConnectionFactory.create).toHaveBeenCalledWith(
        expect.objectContaining({
          serverConfig: expect.objectContaining({
            headers: {
              Authorization: 'Bearer {{LIBRECHAT_GRAPH_ACCESS_TOKEN}}',
            },
          }),
        }),
        expect.any(Object),
      );
    });

    it('should not cache connections when request body placeholders affect the URL', async () => {
      const bodyUrlConfig: t.ParsedServerConfig = {
        type: 'streamable-http',
        url: 'https://api.example.com/messages/{{LIBRECHAT_BODY_MESSAGEID}}/mcp',
        source: 'yaml',
        requiresOAuth: false,
      };
      const firstConnection = {
        isConnected: jest.fn().mockResolvedValue(true),
        on: jest.fn(),
      } as unknown as MCPConnection;
      const secondConnection = {
        isConnected: jest.fn().mockResolvedValue(true),
        on: jest.fn(),
      } as unknown as MCPConnection;

      mockAppConnections({
        has: jest.fn().mockResolvedValue(false),
      });
      (mockRegistryInstance.getServerConfig as jest.Mock).mockResolvedValue(bodyUrlConfig);
      mockProcessMCPEnv.mockImplementation(({ options, body }) => ({
        ...options,
        ...('url' in options && {
          url: options.url?.replace('{{LIBRECHAT_BODY_MESSAGEID}}', body?.messageId ?? ''),
        }),
      }));
      (MCPConnectionFactory.create as jest.Mock)
        .mockResolvedValueOnce(firstConnection)
        .mockResolvedValueOnce(secondConnection);

      const manager = await MCPManager.createInstance(newMCPServersConfig());
      const first = await manager.getUserConnection({
        serverName,
        user: mockUser,
        requestBody: { messageId: 'message-1' },
      });
      const second = await manager.getUserConnection({
        serverName,
        user: mockUser,
        requestBody: { messageId: 'message-2' },
      });

      expect(first).toBe(firstConnection);
      expect(second).toBe(secondConnection);
      expect(MCPConnectionFactory.create).toHaveBeenCalledTimes(2);
    });

    it('isolates an unattended probe from a live user connection', async () => {
      const config: t.ParsedServerConfig = {
        type: 'streamable-http',
        url: 'https://api.example.com/mcp',
        source: 'user',
        requiresOAuth: false,
      };
      const live = {
        isConnected: jest.fn().mockResolvedValue(true),
        refreshToolList: jest.fn().mockResolvedValue({ tools: [], complete: true }),
        on: jest.fn(),
        disconnect: jest.fn(),
        dispose: jest.fn().mockResolvedValue(undefined),
      } as unknown as MCPConnection;
      const probe = {
        isConnected: jest.fn().mockResolvedValue(true),
        on: jest.fn(),
      } as unknown as MCPConnection;
      mockAppConnections({ has: jest.fn().mockResolvedValue(false) });
      (mockRegistryInstance.getServerConfig as jest.Mock).mockResolvedValue(config);
      (MCPConnectionFactory.create as jest.Mock)
        .mockResolvedValueOnce(live)
        .mockResolvedValueOnce(probe);
      const manager = await MCPManager.createInstance(newMCPServersConfig());
      expect(await manager.getUserConnection({ serverName, user: mockUser })).toBe(live);
      const requestScopedConnections: t.RequestScopedMCPConnectionStore = {
        connections: new Map(),
        pending: new Map(),
      };
      expect(
        await manager.getUserConnection({
          serverName,
          user: mockUser,
          ephemeralConnection: true,
          requestScopedConnections,
        }),
      ).toBe(probe);
      expect(await manager.getUserConnection({ serverName, user: mockUser })).toBe(live);
      expect(live.disconnect).not.toHaveBeenCalled();
      expect(
        requestScopedConnections.connections.get(
          getMCPUserConnectionPoolKey(mockUser.id, serverName, STANDARD_MCP_CAPABILITY_PROFILE),
        ),
      ).toBe(probe);
    });

    it('should reuse BODY-scoped connections within a request-scoped connection store', async () => {
      const bodyUrlConfig: t.ParsedServerConfig = {
        type: 'streamable-http',
        url: 'https://api.example.com/messages/{{LIBRECHAT_BODY_MESSAGEID}}/mcp',
        source: 'yaml',
        requiresOAuth: false,
      };
      const requestScopedConnection = {
        isConnected: jest.fn().mockResolvedValue(true),
        on: jest.fn(),
      } as unknown as MCPConnection;
      const requestScopedConnections: t.RequestScopedMCPConnectionStore = {
        connections: new Map(),
        pending: new Map(),
      };

      mockAppConnections({
        has: jest.fn().mockResolvedValue(false),
      });
      (mockRegistryInstance.getServerConfig as jest.Mock).mockResolvedValue(bodyUrlConfig);
      mockProcessMCPEnv.mockImplementation(({ options, body }) => ({
        ...options,
        ...('url' in options && {
          url: options.url?.replace('{{LIBRECHAT_BODY_MESSAGEID}}', body?.messageId ?? ''),
        }),
      }));
      (MCPConnectionFactory.create as jest.Mock).mockResolvedValue(requestScopedConnection);

      const manager = await MCPManager.createInstance(newMCPServersConfig());
      const first = await manager.getUserConnection({
        serverName,
        user: mockUser,
        requestBody: { messageId: 'message-1' },
        requestScopedConnections,
      });
      const second = await manager.getUserConnection({
        serverName,
        user: mockUser,
        requestBody: { messageId: 'message-1' },
        requestScopedConnections,
      });

      expect(first).toBe(requestScopedConnection);
      expect(second).toBe(requestScopedConnection);
      expect(MCPConnectionFactory.create).toHaveBeenCalledTimes(1);
      expect(
        requestScopedConnections.connections.get(
          getMCPUserConnectionPoolKey(mockUser.id, serverName, STANDARD_MCP_CAPABILITY_PROFILE),
        ),
      ).toBe(requestScopedConnection);
    });

    it('rechecks the request-scoped owner after a late connection replacement', async () => {
      let finishProbe: ((connected: boolean) => void) | undefined;
      const oldConnection = {
        isConnected: jest.fn().mockReturnValue(
          new Promise<boolean>((resolve) => {
            finishProbe = resolve;
          }),
        ),
        isStale: jest.fn().mockReturnValue(false),
      } as unknown as MCPConnection;
      const replacement = newUserConnection();
      const store = {
        connections: new Map([
          [
            getMCPUserConnectionPoolKey(mockUser.id, serverName, STANDARD_MCP_CAPABILITY_PROFILE),
            oldConnection,
          ],
        ]),
        pending: new Map(),
      };
      const manager = await MCPManager.createInstance(newMCPServersConfig());
      const checkout = manager.getUserConnection({
        serverName,
        user: mockUser,
        serverConfig: {
          type: 'streamable-http',
          url: 'https://mcp.example.com',
          source: 'yaml',
          headers: { 'X-Conversation': '{{LIBRECHAT_BODY_CONVERSATIONID}}' },
        },
        requestBody: { conversationId: 'conversation-1' },
        requestScopedConnections: store,
      });
      await new Promise((resolve) => setImmediate(resolve));
      expect(oldConnection.isConnected).toHaveBeenCalledTimes(1);
      store.connections.set(
        getMCPUserConnectionPoolKey(mockUser.id, serverName, STANDARD_MCP_CAPABILITY_PROFILE),
        replacement,
      );
      finishProbe?.(true);
      await expect(checkout).resolves.toBe(replacement);
      expect(MCPConnectionFactory.create).not.toHaveBeenCalled();
    });

    it('does not create a connection in a request-scoped store after cleanup starts', async () => {
      const bodyUrlConfig: t.ParsedServerConfig = {
        type: 'streamable-http',
        url: 'https://api.example.com/messages/{{LIBRECHAT_BODY_MESSAGEID}}/mcp',
        source: 'yaml',
        requiresOAuth: false,
      };
      const requestScopedConnections: t.RequestScopedMCPConnectionStore = {
        connections: new Map(),
        pending: new Map(),
        cleanupStarted: true,
      };
      mockAppConnections({ has: jest.fn().mockResolvedValue(false) });

      const manager = await MCPManager.createInstance(newMCPServersConfig());

      await expect(
        manager.getUserConnection({
          serverName,
          user: mockUser,
          serverConfig: bodyUrlConfig,
          requestBody: { messageId: 'message-1' },
          requestScopedConnections,
        }),
      ).rejects.toThrow('Request-scoped connection context is closed');
      expect(MCPConnectionFactory.create).not.toHaveBeenCalled();
      expect(requestScopedConnections.connections.size).toBe(0);
      expect(requestScopedConnections.pending.size).toBe(0);
    });

    it.each(['cleanup', 'mutation'] as const)(
      'disposes a request-scoped connection that finishes after %s',
      async (teardown) => {
        const bodyUrlConfig: t.ParsedServerConfig = {
          type: 'streamable-http',
          url: 'https://api.example.com/messages/{{LIBRECHAT_BODY_MESSAGEID}}/mcp',
          source: 'yaml',
          requiresOAuth: false,
        };
        const lateConnection = {
          dispose: jest.fn().mockResolvedValue(undefined),
          isConnected: jest.fn().mockResolvedValue(true),
          on: jest.fn(),
          refreshToolList: jest.fn().mockResolvedValue(undefined),
        } as unknown as MCPConnection;
        let finishCreation: ((connection: MCPConnection) => void) | undefined;
        const creation = new Promise<MCPConnection>((resolve) => {
          finishCreation = resolve;
        });
        const requestScopedConnections: t.RequestScopedMCPConnectionStore = {
          connections: new Map(),
          pending: new Map(),
          cleanupStarted: false,
        };
        mockAppConnections({ has: jest.fn().mockResolvedValue(false) });
        (graphUtils.preProcessGraphTokens as jest.Mock).mockImplementation(
          async (config) => config,
        );
        mockProcessMCPEnv.mockImplementation(({ options, body }) => ({
          ...options,
          ...('url' in options && {
            url: options.url?.replace('{{LIBRECHAT_BODY_MESSAGEID}}', body?.messageId ?? ''),
          }),
        }));
        (MCPConnectionFactory.create as jest.Mock).mockReturnValue(creation);
        const manager = await MCPManager.createInstance(newMCPServersConfig());

        const connectionPromise = manager.getUserConnection({
          serverName,
          user: mockUser,
          serverConfig: bodyUrlConfig,
          requestBody: { messageId: 'message-1' },
          requestScopedConnections,
        });
        for (
          let attempt = 0;
          attempt < 20 && !(MCPConnectionFactory.create as jest.Mock).mock.calls.length;
          attempt++
        ) {
          await new Promise((resolve) => setImmediate(resolve));
        }
        expect(MCPConnectionFactory.create).toHaveBeenCalledTimes(1);
        if (teardown === 'cleanup') {
          requestScopedConnections.cleanupStarted = true;
        } else {
          await manager.disconnectUserConnection(mockUser.id, serverName);
        }
        finishCreation?.(lateConnection);

        await expect(connectionPromise).rejects.toThrow(
          teardown === 'cleanup'
            ? 'Request-scoped connection context is closed'
            : 'cancelled during teardown',
        );
        expect(lateConnection.dispose).toHaveBeenCalledTimes(1);
        expect(requestScopedConnections.connections.size).toBe(0);
        expect(requestScopedConnections.pending.size).toBe(0);
      },
    );

    it('should not clear server cooldowns for ephemeral runtime connections', async () => {
      const bodyUrlConfig: t.ParsedServerConfig = {
        type: 'streamable-http',
        url: 'https://api.example.com/messages/{{LIBRECHAT_BODY_MESSAGEID}}/mcp',
        source: 'yaml',
        requiresOAuth: false,
      };
      const clearCooldownSpy = jest.spyOn(MCPConnection, 'clearCooldown');

      mockAppConnections({
        has: jest.fn().mockResolvedValue(false),
      });
      (mockRegistryInstance.getServerConfig as jest.Mock).mockResolvedValue(bodyUrlConfig);
      mockProcessMCPEnv.mockImplementation(({ options, body }) => ({
        ...options,
        ...('url' in options && {
          url: options.url?.replace('{{LIBRECHAT_BODY_MESSAGEID}}', body?.messageId ?? ''),
        }),
      }));
      (MCPConnectionFactory.create as jest.Mock).mockResolvedValue(mockConnection);

      try {
        const manager = await MCPManager.createInstance(newMCPServersConfig());
        await manager.getUserConnection({
          serverName,
          user: mockUser,
          requestBody: { messageId: 'message-1' },
        });

        expect(clearCooldownSpy).not.toHaveBeenCalled();
      } finally {
        clearCooldownSpy.mockRestore();
      }
    });

    it('should still clear server cooldowns for explicit forceNew connections', async () => {
      const staticConfig: t.ParsedServerConfig = {
        type: 'streamable-http',
        url: 'https://api.example.com/mcp',
        source: 'yaml',
        requiresOAuth: false,
      };
      const clearCooldownSpy = jest.spyOn(MCPConnection, 'clearCooldown');

      mockAppConnections({
        has: jest.fn().mockResolvedValue(false),
      });
      (mockRegistryInstance.getServerConfig as jest.Mock).mockResolvedValue(staticConfig);
      (MCPConnectionFactory.create as jest.Mock).mockResolvedValue(mockConnection);

      try {
        const manager = await MCPManager.createInstance(newMCPServersConfig());
        await manager.getUserConnection({
          serverName,
          user: mockUser,
          forceNew: true,
        });

        expect(clearCooldownSpy).toHaveBeenCalledWith(serverName);
      } finally {
        clearCooldownSpy.mockRestore();
      }
    });

    it('should reject BODY-scoped connections without request body context', async () => {
      const bodyUrlConfig: t.ParsedServerConfig = {
        type: 'streamable-http',
        url: 'https://api.example.com/messages/{{LIBRECHAT_BODY_MESSAGEID}}/mcp',
        source: 'yaml',
        requiresOAuth: false,
      };

      mockAppConnections({
        has: jest.fn().mockResolvedValue(false),
      });
      (mockRegistryInstance.getServerConfig as jest.Mock).mockResolvedValue(bodyUrlConfig);

      const manager = await MCPManager.createInstance(newMCPServersConfig());
      await expect(
        manager.getUserConnection({
          serverName,
          user: mockUser,
        }),
      ).rejects.toThrow('Request body field(s) required');

      expect(MCPConnectionFactory.create).not.toHaveBeenCalled();
    });

    it('should reject BODY-scoped connections when a referenced body field is missing', async () => {
      const bodyUrlConfig: t.ParsedServerConfig = {
        type: 'streamable-http',
        url: 'https://api.example.com/messages/{{LIBRECHAT_BODY_MESSAGEID}}/mcp',
        source: 'yaml',
        requiresOAuth: false,
      };

      mockAppConnections({
        has: jest.fn().mockResolvedValue(false),
      });
      (mockRegistryInstance.getServerConfig as jest.Mock).mockResolvedValue(bodyUrlConfig);

      const manager = await MCPManager.createInstance(newMCPServersConfig());
      await expect(
        manager.getUserConnection({
          serverName,
          user: mockUser,
          requestBody: { conversationId: 'conv-123' },
        }),
      ).rejects.toThrow('messageId');

      expect(MCPConnectionFactory.create).not.toHaveBeenCalled();
    });

    it('should throw when OAuth server lacks flowManager', async () => {
      mockAppConnections({
        has: jest.fn().mockResolvedValue(false),
      });

      (mockRegistryInstance.getServerConfig as jest.Mock).mockResolvedValue({
        type: 'sse',
        url: 'https://oauth-mcp.example.com',
        requiresOAuth: true,
      });

      const manager = await MCPManager.createInstance(newMCPServersConfig());
      await expect(
        manager.getUserConnection({
          serverName,
          user: mockUser,
        }),
      ).rejects.toThrow('requires a flowManager');
    });
  });
});
