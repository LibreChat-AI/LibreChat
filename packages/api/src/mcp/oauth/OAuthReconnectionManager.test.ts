import { logger, TokenMethods } from '@librechat/data-schemas';
import type { IToken } from '@librechat/data-schemas';
import type { ParsedServerConfig } from '../..';
import { OAuthReconnectionManager } from './OAuthReconnectionManager';
import { OAuthReconnectionTracker } from './OAuthReconnectionTracker';
import { FlowStateManager, MCPConnection, MCPOptions } from '../..';
import { STANDARD_MCP_CAPABILITY_PROFILE } from '../capabilities';
import { MCPManager } from '../MCPManager';

jest.mock('@librechat/data-schemas', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

const mockRegistryInstance = {
  getServerConfig: jest.fn(),
  getOAuthServers: jest.fn(),
};

jest.mock('../MCPManager');
jest.mock('../../mcp/registry/MCPServersRegistry', () => ({
  MCPServersRegistry: {
    getInstance: () => mockRegistryInstance,
  },
}));

describe('OAuthReconnectionManager', () => {
  let flowManager: jest.Mocked<FlowStateManager<null>>;
  let tokenMethods: jest.Mocked<TokenMethods>;
  let mockMCPManager: jest.Mocked<MCPManager>;
  let reconnectionManager: OAuthReconnectionManager;

  beforeEach(() => {
    jest.clearAllMocks();

    // Reset singleton instance
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (OAuthReconnectionManager as any).instance = null;

    // Setup mock flow manager
    flowManager = {
      createFlow: jest.fn(),
      completeFlow: jest.fn(),
      failFlow: jest.fn(),
      deleteFlow: jest.fn(),
      getFlow: jest.fn(),
    } as unknown as jest.Mocked<FlowStateManager<null>>;

    // Setup mock token methods
    tokenMethods = {
      findToken: jest.fn(),
      createToken: jest.fn(),
      updateToken: jest.fn(),
      deleteToken: jest.fn(),
    } as unknown as jest.Mocked<TokenMethods>;

    // Setup mock MCP Manager
    mockMCPManager = {
      getOAuthServers: jest.fn(),
      getUserConnection: jest.fn(),
      getUserConnections: jest.fn(),
      disconnectUserConnection: jest.fn(),
    } as unknown as jest.Mocked<MCPManager>;

    (MCPManager.getInstance as jest.Mock).mockReturnValue(mockMCPManager);
    (mockRegistryInstance.getServerConfig as jest.Mock).mockResolvedValue({});
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('Singleton Pattern', () => {
    it('should create instance successfully', async () => {
      const instance = await OAuthReconnectionManager.createInstance(flowManager, tokenMethods);
      expect(instance).toBeInstanceOf(OAuthReconnectionManager);
    });

    it('should throw error when creating instance twice', async () => {
      await OAuthReconnectionManager.createInstance(flowManager, tokenMethods);
      await expect(
        OAuthReconnectionManager.createInstance(flowManager, tokenMethods),
      ).rejects.toThrow('OAuthReconnectionManager already initialized');
    });

    it('should throw error when getting instance before creation', () => {
      expect(() => OAuthReconnectionManager.getInstance()).toThrow(
        'OAuthReconnectionManager not initialized',
      );
    });
  });

  describe('isReconnecting', () => {
    let reconnectionTracker: OAuthReconnectionTracker;
    beforeEach(async () => {
      reconnectionTracker = new OAuthReconnectionTracker();
      reconnectionManager = await OAuthReconnectionManager.createInstance(
        flowManager,
        tokenMethods,
        reconnectionTracker,
      );
    });

    it('should return true when server is actively reconnecting', () => {
      const userId = 'user-123';
      const serverName = 'test-server';

      expect(reconnectionManager.isReconnecting(userId, serverName)).toBe(false);

      reconnectionTracker.setActive(userId, serverName);
      const result = reconnectionManager.isReconnecting(userId, serverName);
      expect(result).toBe(true);
    });

    it('should return false when server is not reconnecting', () => {
      const userId = 'user-123';
      const serverName = 'test-server';

      const result = reconnectionManager.isReconnecting(userId, serverName);
      expect(result).toBe(false);
    });
  });

  describe('clearReconnection', () => {
    let reconnectionTracker: OAuthReconnectionTracker;
    beforeEach(async () => {
      reconnectionTracker = new OAuthReconnectionTracker();
      reconnectionManager = await OAuthReconnectionManager.createInstance(
        flowManager,
        tokenMethods,
        reconnectionTracker,
      );
    });

    it('should clear both failed and active reconnection states', () => {
      const userId = 'user-123';
      const serverName = 'test-server';

      reconnectionTracker.setFailed(userId, serverName);
      reconnectionTracker.setActive(userId, serverName);

      reconnectionManager.clearReconnection(userId, serverName);

      expect(reconnectionManager.isReconnecting(userId, serverName)).toBe(false);
      expect(reconnectionTracker.isFailed(userId, serverName)).toBe(false);
      expect(reconnectionTracker.isActive(userId, serverName)).toBe(false);
    });
  });

  describe('reconnectServers', () => {
    let reconnectionTracker: OAuthReconnectionTracker;
    beforeEach(async () => {
      reconnectionTracker = new OAuthReconnectionTracker();
      reconnectionManager = await OAuthReconnectionManager.createInstance(
        flowManager,
        tokenMethods,
        reconnectionTracker,
      );
    });

    it('should reconnect eligible servers', async () => {
      const userId = 'user-123';
      const oauthServers = new Set(['server1', 'server2', 'server3']);
      (mockRegistryInstance.getOAuthServers as jest.Mock).mockResolvedValue(oauthServers);

      // server1: has failed reconnection
      reconnectionTracker.setFailed(userId, 'server1');

      // server2: already connected
      const mockConnection = {
        isConnected: jest.fn().mockResolvedValue(true),
      };
      const userConnections = new Map([['server2', mockConnection]]);
      mockMCPManager.getUserConnections.mockReturnValue(
        userConnections as unknown as Map<string, MCPConnection>,
      );

      // server3: has valid token and not connected
      tokenMethods.findToken.mockImplementation(async ({ identifier }) => {
        if (identifier === 'mcp:server3') {
          return {
            userId,
            identifier,
            expiresAt: new Date(Date.now() + 3600000), // 1 hour from now
          } as unknown as IToken;
        }
        return null;
      });

      // Mock successful reconnection
      const mockNewConnection = {
        isConnected: jest.fn().mockResolvedValue(true),
        disconnect: jest.fn(),
      };
      mockMCPManager.getUserConnection.mockResolvedValue(
        mockNewConnection as unknown as MCPConnection,
      );
      (mockRegistryInstance.getServerConfig as jest.Mock).mockResolvedValue({
        initTimeout: 5000,
      } as unknown as MCPOptions);

      await reconnectionManager.reconnectServers(userId);

      expect(mockRegistryInstance.getOAuthServers).toHaveBeenCalledWith(userId);

      // Verify server3 was marked as active
      expect(reconnectionTracker.isActive(userId, 'server3')).toBe(true);

      // Wait for async tryReconnect to complete
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Verify reconnection was attempted for server3
      expect(mockMCPManager.getUserConnection).toHaveBeenCalledWith({
        serverName: 'server3',
        user: { id: userId },
        capabilityProfile: STANDARD_MCP_CAPABILITY_PROFILE,
        serverConfig: { initTimeout: 5000 },
        flowManager,
        tokenMethods,
        forceNew: false,
        connectionTimeout: 5000,
        returnOnOAuth: true,
      });

      // Verify successful reconnection cleared the states
      expect(reconnectionTracker.isFailed(userId, 'server3')).toBe(false);
      expect(reconnectionTracker.isActive(userId, 'server3')).toBe(false);
    });

    it('should handle failed reconnection attempts', async () => {
      const userId = 'user-123';
      const oauthServers = new Set(['server1']);
      (mockRegistryInstance.getOAuthServers as jest.Mock).mockResolvedValue(oauthServers);

      // server1: has valid token
      tokenMethods.findToken.mockResolvedValue({
        userId,
        identifier: 'mcp:server1',
        expiresAt: new Date(Date.now() + 3600000),
      } as unknown as IToken);

      // Mock failed connection
      mockMCPManager.getUserConnection.mockRejectedValue(new Error('Connection failed'));
      (mockRegistryInstance.getServerConfig as jest.Mock).mockResolvedValue(
        {} as unknown as MCPOptions,
      );

      await reconnectionManager.reconnectServers(userId);

      // Wait for async tryReconnect to complete
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Verify failure handling
      expect(reconnectionTracker.isFailed(userId, 'server1')).toBe(true);
      expect(reconnectionTracker.isActive(userId, 'server1')).toBe(false);
      expect(mockMCPManager.disconnectUserConnection).toHaveBeenCalledWith(userId, 'server1', {
        reason: 'lifecycle',
        capabilityProfile: STANDARD_MCP_CAPABILITY_PROFILE,
      });
    });

    it('should not reconnect servers with expired tokens and no refresh token', async () => {
      const userId = 'user-123';
      const oauthServers = new Set(['server1']);
      (mockRegistryInstance.getOAuthServers as jest.Mock).mockResolvedValue(oauthServers);

      tokenMethods.findToken.mockImplementation(async ({ identifier }) => {
        if (identifier === 'mcp:server1') {
          return {
            userId,
            identifier,
            expiresAt: new Date(Date.now() - 3600000),
          } as unknown as IToken;
        }
        return null;
      });

      await reconnectionManager.reconnectServers(userId);

      // Verify no reconnection attempt was made
      expect(reconnectionTracker.isActive(userId, 'server1')).toBe(false);
      expect(mockMCPManager.getUserConnection).not.toHaveBeenCalled();
    });

    it('should reconnect servers with expired access token but valid refresh token', async () => {
      const userId = 'user-123';
      const oauthServers = new Set(['server1']);
      (mockRegistryInstance.getOAuthServers as jest.Mock).mockResolvedValue(oauthServers);

      tokenMethods.findToken.mockImplementation(async ({ identifier }) => {
        if (identifier === 'mcp:server1') {
          return {
            userId,
            identifier,
            expiresAt: new Date(Date.now() - 3600000),
          } as unknown as IToken;
        }
        if (identifier === 'mcp:server1:refresh') {
          return {
            userId,
            identifier,
          } as unknown as IToken;
        }
        return null;
      });

      const mockNewConnection = {
        isConnected: jest.fn().mockResolvedValue(true),
        disconnect: jest.fn(),
      };
      mockMCPManager.getUserConnection.mockResolvedValue(
        mockNewConnection as unknown as MCPConnection,
      );
      (mockRegistryInstance.getServerConfig as jest.Mock).mockResolvedValue(
        {} as unknown as MCPOptions,
      );

      await reconnectionManager.reconnectServers(userId);

      expect(reconnectionTracker.isActive(userId, 'server1')).toBe(true);

      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(mockMCPManager.getUserConnection).toHaveBeenCalledWith(
        expect.objectContaining({ serverName: 'server1' }),
      );
    });

    it('should reconnect when access token is TTL-deleted but refresh token exists', async () => {
      const userId = 'user-123';
      const oauthServers = new Set(['server1']);
      (mockRegistryInstance.getOAuthServers as jest.Mock).mockResolvedValue(oauthServers);

      tokenMethods.findToken.mockImplementation(async ({ identifier }) => {
        if (identifier === 'mcp:server1:refresh') {
          return {
            userId,
            identifier,
          } as unknown as IToken;
        }
        return null;
      });

      const mockNewConnection = {
        isConnected: jest.fn().mockResolvedValue(true),
        disconnect: jest.fn(),
      };
      mockMCPManager.getUserConnection.mockResolvedValue(
        mockNewConnection as unknown as MCPConnection,
      );
      (mockRegistryInstance.getServerConfig as jest.Mock).mockResolvedValue(
        {} as unknown as MCPOptions,
      );

      await reconnectionManager.reconnectServers(userId);

      expect(reconnectionTracker.isActive(userId, 'server1')).toBe(true);

      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(mockMCPManager.getUserConnection).toHaveBeenCalledWith(
        expect.objectContaining({ serverName: 'server1' }),
      );
    });

    it('should handle connection that returns but is not connected', async () => {
      const userId = 'user-123';
      const oauthServers = new Set(['server1']);
      (mockRegistryInstance.getOAuthServers as jest.Mock).mockResolvedValue(oauthServers);

      tokenMethods.findToken.mockResolvedValue({
        userId,
        identifier: 'mcp:server1',
        expiresAt: new Date(Date.now() + 3600000),
      } as unknown as IToken);

      // Mock connection that returns but is not connected
      const mockConnection = {
        isConnected: jest.fn().mockResolvedValue(false),
        disconnect: jest.fn(),
      };
      mockMCPManager.getUserConnection.mockResolvedValue(
        mockConnection as unknown as MCPConnection,
      );
      (mockRegistryInstance.getServerConfig as jest.Mock).mockResolvedValue(
        {} as unknown as MCPOptions,
      );

      await reconnectionManager.reconnectServers(userId);

      // Wait for async tryReconnect to complete
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Verify failure handling
      expect(mockConnection.disconnect).toHaveBeenCalled();
      expect(reconnectionTracker.isFailed(userId, 'server1')).toBe(true);
      expect(reconnectionTracker.isActive(userId, 'server1')).toBe(false);
      expect(mockMCPManager.disconnectUserConnection).toHaveBeenCalledWith(userId, 'server1', {
        reason: 'lifecycle',
        capabilityProfile: STANDARD_MCP_CAPABILITY_PROFILE,
      });
    });

    it('should handle MCPManager not available gracefully', async () => {
      const userId = 'user-123';

      // Reset singleton first
      (OAuthReconnectionManager as unknown as { instance: null }).instance = null;

      // Mock MCPManager.getInstance to throw (simulating no MCP manager available)
      (MCPManager.getInstance as jest.Mock).mockImplementation(() => {
        throw new Error('MCPManager has not been initialized.');
      });

      // Create a reconnection manager without MCPManager available
      const reconnectionTracker = new OAuthReconnectionTracker();
      const reconnectionManagerWithoutMCP = await OAuthReconnectionManager.createInstance(
        flowManager,
        tokenMethods,
        reconnectionTracker,
      );

      // Verify that the method does not throw and completes successfully
      await expect(reconnectionManagerWithoutMCP.reconnectServers(userId)).resolves.toBeUndefined();

      // Verify that the method returns early without attempting any reconnections
      expect(tokenMethods.findToken).not.toHaveBeenCalled();
      expect(mockMCPManager.getUserConnection).not.toHaveBeenCalled();
      expect(mockMCPManager.disconnectUserConnection).not.toHaveBeenCalled();
    });
  });

  describe('reconnectServer', () => {
    let reconnectionTracker: OAuthReconnectionTracker;
    beforeEach(async () => {
      reconnectionTracker = new OAuthReconnectionTracker();
      reconnectionManager = await OAuthReconnectionManager.createInstance(
        flowManager,
        tokenMethods,
        reconnectionTracker,
      );
    });

    it('should return true on successful reconnection', async () => {
      const userId = 'user-123';
      const serverName = 'server1';

      const mockConnection = {
        isConnected: jest.fn().mockResolvedValue(true),
        disconnect: jest.fn(),
      };
      mockMCPManager.getUserConnection.mockResolvedValue(
        mockConnection as unknown as MCPConnection,
      );
      (mockRegistryInstance.getServerConfig as jest.Mock).mockResolvedValue(
        {} as unknown as MCPOptions,
      );

      const result = await reconnectionManager.reconnectServer(userId, serverName);
      expect(result).toBe(true);
    });

    it('should defer request-scoped reconnection without reporting success', async () => {
      const userId = 'user-123';
      const serverName = 'request-scoped-server';

      reconnectionTracker.setFailed(userId, serverName);
      reconnectionTracker.setActive(userId, serverName);
      (mockRegistryInstance.getServerConfig as jest.Mock).mockResolvedValue({
        type: 'streamable-http',
        url: 'https://example.com/mcp',
        source: 'yaml',
        headers: {
          'X-Conversation-ID': '{{LIBRECHAT_BODY_CONVERSATIONID}}',
        },
      } as unknown as MCPOptions);

      const result = await reconnectionManager.reconnectServer(userId, serverName);

      expect(result).toBe(false);
      expect(reconnectionTracker.isFailed(userId, serverName)).toBe(false);
      expect(reconnectionTracker.isActive(userId, serverName)).toBe(false);
      expect(mockMCPManager.getUserConnection).not.toHaveBeenCalled();
      expect(mockMCPManager.disconnectUserConnection).not.toHaveBeenCalled();
    });

    it('should classify request scope from the effective config-tier overlay', async () => {
      const userId = 'user-123';
      const serverName = 'overlaid-server';
      const configServers: Record<string, ParsedServerConfig> = {
        [serverName]: {
          type: 'streamable-http',
          url: 'https://example.com/mcp',
          source: 'config',
          headers: {
            'X-Conversation-ID': '{{LIBRECHAT_BODY_CONVERSATIONID}}',
          },
        },
      };
      const effectiveConfig = {
        ...configServers[serverName],
        source: 'yaml',
      } as ParsedServerConfig;

      (mockRegistryInstance.getServerConfig as jest.Mock).mockImplementation(
        async (_name, _userId, candidates) =>
          candidates === configServers
            ? effectiveConfig
            : ({
                type: 'streamable-http',
                url: 'https://example.com/mcp',
                source: 'yaml',
              } as MCPOptions),
      );
      const result = await reconnectionManager.reconnectServer(userId, serverName, configServers);

      expect(result).toBe(false);
      expect(mockRegistryInstance.getServerConfig).toHaveBeenCalledWith(
        serverName,
        userId,
        configServers,
      );
      expect(mockMCPManager.getUserConnection).not.toHaveBeenCalled();
      expect(reconnectionTracker.isFailed(userId, serverName)).toBe(false);
      expect(reconnectionTracker.isActive(userId, serverName)).toBe(false);
    });

    it('should return false on failed reconnection', async () => {
      const userId = 'user-123';
      const serverName = 'server1';

      mockMCPManager.getUserConnection.mockRejectedValue(new Error('Connection failed'));
      (mockRegistryInstance.getServerConfig as jest.Mock).mockResolvedValue(
        {} as unknown as MCPOptions,
      );

      const result = await reconnectionManager.reconnectServer(userId, serverName);
      expect(result).toBe(false);
    });

    it('should return false when MCPManager is not available', async () => {
      const userId = 'user-123';
      const serverName = 'server1';

      (OAuthReconnectionManager as unknown as { instance: null }).instance = null;
      (MCPManager.getInstance as jest.Mock).mockImplementation(() => {
        throw new Error('MCPManager has not been initialized.');
      });

      const managerWithoutMCP = await OAuthReconnectionManager.createInstance(
        flowManager,
        tokenMethods,
        reconnectionTracker,
      );

      const result = await managerWithoutMCP.reconnectServer(userId, serverName);
      expect(result).toBe(false);
    });
  });

  describe('reconnection staggering', () => {
    let reconnectionTracker: OAuthReconnectionTracker;

    beforeEach(async () => {
      jest.useFakeTimers();
      reconnectionTracker = new OAuthReconnectionTracker();
      reconnectionManager = await OAuthReconnectionManager.createInstance(
        flowManager,
        tokenMethods,
        reconnectionTracker,
      );
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('should stagger reconnection attempts for multiple servers', async () => {
      const userId = 'user-123';
      const oauthServers = new Set(['server1', 'server2', 'server3']);
      (mockRegistryInstance.getOAuthServers as jest.Mock).mockResolvedValue(oauthServers);

      // All servers have valid tokens and are not connected
      tokenMethods.findToken.mockImplementation(async ({ identifier }) => {
        return {
          userId,
          identifier,
          expiresAt: new Date(Date.now() + 3600000),
        } as unknown as IToken;
      });

      const mockNewConnection = {
        isConnected: jest.fn().mockResolvedValue(true),
        disconnect: jest.fn(),
      };
      mockMCPManager.getUserConnection.mockResolvedValue(
        mockNewConnection as unknown as MCPConnection,
      );
      (mockRegistryInstance.getServerConfig as jest.Mock).mockResolvedValue(
        {} as unknown as MCPOptions,
      );

      await reconnectionManager.reconnectServers(userId);

      // Only the first server should have been attempted immediately
      expect(mockMCPManager.getUserConnection).toHaveBeenCalledTimes(1);
      expect(mockMCPManager.getUserConnection).toHaveBeenCalledWith(
        expect.objectContaining({ serverName: 'server1' }),
      );

      // After advancing all timers, all servers should have been attempted
      await jest.runAllTimersAsync();

      expect(mockMCPManager.getUserConnection).toHaveBeenCalledTimes(3);
      expect(mockMCPManager.getUserConnection).toHaveBeenCalledWith(
        expect.objectContaining({ serverName: 'server2' }),
      );
      expect(mockMCPManager.getUserConnection).toHaveBeenCalledWith(
        expect.objectContaining({ serverName: 'server3' }),
      );
    });
  });

  describe('fire-and-forget reconnect safety', () => {
    let reconnectionTracker: OAuthReconnectionTracker;

    beforeEach(async () => {
      reconnectionTracker = new OAuthReconnectionTracker();
      reconnectionManager = await OAuthReconnectionManager.createInstance(
        flowManager,
        tokenMethods,
        reconnectionTracker,
      );
    });

    /**
     * Regression test for discussion #12078: a registry rejection from
     * `getServerConfig` during a reconnect storm previously escaped as an
     * unhandled promise rejection (Node 15+ terminates the process). The
     * rejection must be caught and the tracker must be cleaned up so the
     * server does not stay stuck in `active` state for the full
     * `RECONNECTION_TIMEOUT_MS` window before retries become possible again.
     */
    it('should clean up tracker state when getServerConfig rejects', async () => {
      const userId = 'user-123';
      const oauthServers = new Set(['server1']);
      (mockRegistryInstance.getOAuthServers as jest.Mock).mockResolvedValue(oauthServers);

      tokenMethods.findToken.mockResolvedValue({
        userId,
        identifier: 'mcp:server1',
        expiresAt: new Date(Date.now() + 3600000),
      } as unknown as IToken);

      const boom = new Error('boom');
      (mockRegistryInstance.getServerConfig as jest.Mock).mockRejectedValue(boom);

      await expect(reconnectionManager.reconnectServers(userId)).resolves.toBeUndefined();

      // Flush any microtasks attached inside safeTryReconnect / tryReconnect
      await new Promise((resolve) => setImmediate(resolve));

      // The rejection must be reported (warn from the inner catch) and the
      // tracker must be returned to a state that allows future retries.
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Failed to reconnect'));
      expect(reconnectionTracker.isActive(userId, 'server1')).toBe(false);
      expect(reconnectionTracker.isFailed(userId, 'server1')).toBe(true);
      expect(mockMCPManager.disconnectUserConnection).toHaveBeenCalledWith(userId, 'server1', {
        reason: 'lifecycle',
        capabilityProfile: STANDARD_MCP_CAPABILITY_PROFILE,
      });
    });
  });

  describe('reconnection timeout behavior', () => {
    let reconnectionTracker: OAuthReconnectionTracker;

    beforeEach(async () => {
      jest.useFakeTimers();
      reconnectionTracker = new OAuthReconnectionTracker();
      reconnectionManager = await OAuthReconnectionManager.createInstance(
        flowManager,
        tokenMethods,
        reconnectionTracker,
      );
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('should handle timed out reconnections via isReconnecting check', () => {
      const userId = 'user-123';
      const serverName = 'test-server';
      const now = Date.now();
      jest.setSystemTime(now);

      // Set server as reconnecting
      reconnectionTracker.setActive(userId, serverName);
      expect(reconnectionManager.isReconnecting(userId, serverName)).toBe(true);

      // Advance time by 2 minutes 59 seconds - should still be reconnecting
      jest.advanceTimersByTime(2 * 60 * 1000 + 59 * 1000);
      expect(reconnectionManager.isReconnecting(userId, serverName)).toBe(true);

      // Advance time by 2 more seconds (total 3 minutes 1 second) - should be auto-cleaned
      jest.advanceTimersByTime(2000);
      expect(reconnectionManager.isReconnecting(userId, serverName)).toBe(false);
    });

    it('should not attempt to reconnect servers that have timed out during reconnection', async () => {
      const userId = 'user-123';
      const oauthServers = new Set(['server1', 'server2']);
      (mockRegistryInstance.getOAuthServers as jest.Mock).mockResolvedValue(oauthServers);

      const now = Date.now();
      jest.setSystemTime(now);

      // Set server1 as having been reconnecting for over 5 minutes
      reconnectionTracker.setActive(userId, 'server1');
      jest.advanceTimersByTime(6 * 60 * 1000); // 6 minutes

      // server2: has valid token and not connected
      tokenMethods.findToken.mockImplementation(async ({ identifier }) => {
        if (identifier === 'mcp:server2') {
          return {
            userId,
            identifier,
            expiresAt: new Date(Date.now() + 3600000),
          } as unknown as IToken;
        }
        return null;
      });

      // Mock successful reconnection
      const mockNewConnection = {
        isConnected: jest.fn().mockResolvedValue(true),
        disconnect: jest.fn(),
      };
      mockMCPManager.getUserConnection.mockResolvedValue(
        mockNewConnection as unknown as MCPConnection,
      );

      await reconnectionManager.reconnectServers(userId);

      // server1 should still be in active set, just not eligible for reconnection
      expect(reconnectionTracker.isActive(userId, 'server1')).toBe(true);
      expect(reconnectionTracker.isStillReconnecting(userId, 'server1')).toBe(false);

      // Only server2 should be marked as reconnecting
      expect(reconnectionTracker.isActive(userId, 'server2')).toBe(true);

      // Wait for async reconnection using runAllTimersAsync
      await jest.runAllTimersAsync();

      // Verify only server2 was reconnected
      expect(mockMCPManager.getUserConnection).toHaveBeenCalledTimes(1);
      expect(mockMCPManager.getUserConnection).toHaveBeenCalledWith(
        expect.objectContaining({
          serverName: 'server2',
        }),
      );
    });

    it('should properly track reconnection time for multiple sequential reconnect attempts', async () => {
      const userId = 'user-123';
      const serverName = 'server1';
      const oauthServers = new Set([serverName]);
      (mockRegistryInstance.getOAuthServers as jest.Mock).mockResolvedValue(oauthServers);

      const now = Date.now();
      jest.setSystemTime(now);

      // Setup valid token
      tokenMethods.findToken.mockResolvedValue({
        userId,
        identifier: `mcp:${serverName}`,
        expiresAt: new Date(Date.now() + 3600000),
      } as unknown as IToken);

      // First reconnect attempt - will fail
      mockMCPManager.getUserConnection.mockRejectedValueOnce(new Error('Connection failed'));
      (mockRegistryInstance.getServerConfig as jest.Mock).mockResolvedValue(
        {} as unknown as MCPOptions,
      );

      await reconnectionManager.reconnectServers(userId);
      await jest.runAllTimersAsync();

      // Server should be marked as failed
      expect(reconnectionTracker.isFailed(userId, serverName)).toBe(true);
      expect(reconnectionTracker.isActive(userId, serverName)).toBe(false);

      // Clear failed state to allow another attempt
      reconnectionManager.clearReconnection(userId, serverName);

      // Advance time by 3 minutes
      jest.advanceTimersByTime(3 * 60 * 1000);

      // Second reconnect attempt - will succeed
      const mockConnection = {
        isConnected: jest.fn().mockResolvedValue(true),
      };
      mockMCPManager.getUserConnection.mockResolvedValue(
        mockConnection as unknown as MCPConnection,
      );

      await reconnectionManager.reconnectServers(userId);

      // Server should be marked as active with new timestamp
      expect(reconnectionTracker.isActive(userId, serverName)).toBe(true);

      await jest.runAllTimersAsync();

      // After successful reconnection, should be cleared
      expect(reconnectionTracker.isActive(userId, serverName)).toBe(false);
      expect(reconnectionTracker.isFailed(userId, serverName)).toBe(false);
    });
  });
});
