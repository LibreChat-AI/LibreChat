/**
 * Tests for MCP OAuth race condition fixes:
 *
 * 1. Connection mutex coalesces concurrent getUserConnection() calls
 * 2. PENDING OAuth flows are reused, not deleted
 * 3. No-refresh-token expiry throws ReauthenticationRequiredError
 * 4. completeFlow recovers when flow state was deleted by a race
 * 5. monitorFlow retries once when flow state disappears mid-poll
 */

import { Keyv } from 'keyv';
import { logger } from '@librechat/data-schemas';
import type { OAuthTestServer } from './helpers/oauthTestServer';
import type { MCPOAuthTokens } from '~/mcp/oauth';
import { MCPTokenStorage, MCPOAuthHandler, ReauthenticationRequiredError } from '~/mcp/oauth';
import { MockKeyv, createOAuthMCPServer } from './helpers/oauthTestServer';
import { OAuthLifecycleRelay } from '~/mcp/oauth/pending';
import { FlowStateManager } from '~/flow/manager';

jest.mock('@librechat/data-schemas', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
  getTenantId: jest.fn(),
  SYSTEM_TENANT_ID: '__SYSTEM__',
  encryptV2: jest.fn(async (val: string) => `enc:${val}`),
  decryptV2: jest.fn(async (val: string) => val.replace(/^enc:/, '')),
}));

jest.mock('~/auth', () => ({
  createSSRFSafeUndiciConnect: jest.fn(() => undefined),
  isOAuthUrlAllowed: jest.fn(() => false),
  isSSRFTarget: jest.fn(() => false),
  resolveHostnameSSRF: jest.fn(async () => false),
}));

jest.mock('~/auth/domain', () => ({
  isMCPDomainAllowed: jest.fn().mockResolvedValue(true),
}));

jest.mock('~/mcp/mcpConfig', () => ({
  mcpConfig: { CONNECTION_CHECK_TTL: 0, USER_CONNECTION_IDLE_TIMEOUT: 30 * 60 * 1000 },
}));

const mockLogger = logger as jest.Mocked<typeof logger>;

describe('MCP OAuth Race Condition Fixes', () => {
  afterEach(() => {
    jest.clearAllMocks();
    jest.restoreAllMocks();
  });

  describe('Fix 1: Connection mutex coalesces concurrent attempts', () => {
    it('does not overwrite a newer prompt while inspecting stored flow state', async () => {
      const ownerOAuthStart = jest.fn().mockResolvedValue(undefined);
      const waiterOAuthStart = jest.fn().mockResolvedValue(undefined);
      let resolveFlow: ((flow: object) => void) | undefined;
      const flowManager = {
        getFlowState: jest.fn(
          () =>
            new Promise<object>((resolve) => {
              resolveFlow = resolve;
            }),
        ),
      };
      const relay = new OAuthLifecycleRelay({
        oauthStart: ownerOAuthStart,
        logPrefix: '[MCP][test]',
      });

      await relay.start('https://auth.example.com/old');
      const addWaiter = relay.add({
        oauthStart: waiterOAuthStart,
        flowManager: flowManager as never,
        userId: 'user-1',
        serverName: 'test-server',
      });

      expect(flowManager.getFlowState).toHaveBeenCalledTimes(1);
      await relay.start('https://auth.example.com/new');
      resolveFlow?.({
        createdAt: Date.now(),
        metadata: { authorizationUrl: 'https://auth.example.com/old' },
        status: 'PENDING',
      });
      await addWaiter;

      expect(waiterOAuthStart).toHaveBeenCalledTimes(1);
      expect(waiterOAuthStart).toHaveBeenCalledWith('https://auth.example.com/new', undefined);
    });

    it('should return the same pending promise for concurrent getUserConnection calls', async () => {
      const { UserConnectionManager } = await import('~/mcp/UserConnectionManager');

      class TestManager extends UserConnectionManager {
        public createCallCount = 0;

        getPendingConnections() {
          return this.pendingConnections;
        }
      }

      const manager = new TestManager();

      const mockConnection = {
        on: jest.fn(),
        isConnected: jest.fn().mockResolvedValue(true),
        refreshToolList: jest.fn().mockResolvedValue(undefined),
        disconnect: jest.fn().mockResolvedValue(undefined),
        isStale: jest.fn().mockReturnValue(false),
      };

      const mockAppConnections = { has: jest.fn().mockResolvedValue(false) };
      manager.appConnections = mockAppConnections as never;

      const mockConfig = {
        type: 'streamable-http',
        url: 'http://localhost:9999/',
        updatedAt: undefined,
        dbId: undefined,
      };

      const registrySpy = jest
        .spyOn(
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          require('~/mcp/registry/MCPServersRegistry').MCPServersRegistry,
          'getInstance',
        )
        .mockReturnValue({
          getServerConfig: jest.fn().mockResolvedValue(mockConfig),
          shouldEnableSSRFProtection: jest.fn().mockReturnValue(false),
          getAllowedDomains: jest.fn().mockReturnValue(null),
          getAllowedAddresses: jest.fn().mockReturnValue(null),
          resolveAllowlists: jest.fn().mockResolvedValue({
            allowedDomains: null,
            allowedAddresses: null,
            useSSRFProtection: false,
          }),
        });

      const { MCPConnectionFactory } = await import('~/mcp/MCPConnectionFactory');
      const createSpy = jest.spyOn(MCPConnectionFactory, 'create').mockImplementation(async () => {
        manager.createCallCount++;
        await new Promise((r) => setTimeout(r, 100));
        return mockConnection as never;
      });

      try {
        const store = new MockKeyv();
        const flowManager = new FlowStateManager(store as unknown as Keyv, {
          ttl: 30000,
          ci: true,
        });
        const user = { id: 'user-1' };
        const opts = {
          serverName: 'test-server',
          user: user as never,
          flowManager: flowManager as never,
        };

        const [conn1, conn2, conn3] = await Promise.all([
          manager.getUserConnection(opts),
          manager.getUserConnection(opts),
          manager.getUserConnection(opts),
        ]);

        expect(conn1).toBe(conn2);
        expect(conn2).toBe(conn3);
        expect(createSpy).toHaveBeenCalledTimes(1);
        expect(manager.createCallCount).toBe(1);
      } finally {
        createSpy.mockRestore();
        registrySpy.mockRestore();
      }
    });

    it('should re-issue the pending OAuth URL when joining an in-flight connection', async () => {
      const { UserConnectionManager } = await import('~/mcp/UserConnectionManager');

      class TestManager extends UserConnectionManager {}

      const manager = new TestManager();

      const mockConnection = {
        on: jest.fn(),
        isConnected: jest.fn().mockResolvedValue(true),
        refreshToolList: jest.fn().mockResolvedValue(undefined),
        disconnect: jest.fn().mockResolvedValue(undefined),
        isStale: jest.fn().mockReturnValue(false),
      };

      const mockAppConnections = { has: jest.fn().mockResolvedValue(false) };
      manager.appConnections = mockAppConnections as never;

      const mockConfig = {
        type: 'streamable-http',
        url: 'http://localhost:9999/',
        updatedAt: undefined,
        dbId: undefined,
      };

      const registrySpy = jest
        .spyOn(
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          require('~/mcp/registry/MCPServersRegistry').MCPServersRegistry,
          'getInstance',
        )
        .mockReturnValue({
          getServerConfig: jest.fn().mockResolvedValue(mockConfig),
          shouldEnableSSRFProtection: jest.fn().mockReturnValue(false),
          getAllowedDomains: jest.fn().mockReturnValue(null),
          getAllowedAddresses: jest.fn().mockReturnValue(null),
          resolveAllowlists: jest.fn().mockResolvedValue({
            allowedDomains: null,
            allowedAddresses: null,
            useSSRFProtection: false,
          }),
        });

      const { MCPConnectionFactory } = await import('~/mcp/MCPConnectionFactory');
      const createSpy = jest.spyOn(MCPConnectionFactory, 'create').mockImplementation(async () => {
        await new Promise((r) => setTimeout(r, 100));
        return mockConnection as never;
      });

      try {
        const store = new MockKeyv();
        const flowManager = new FlowStateManager(store as unknown as Keyv, {
          ttl: 30000,
          ci: true,
        });
        const user = { id: 'user-oauth' };
        const serverName = 'test-server';
        const authorizationUrl = 'https://auth.example.com/existing';
        await flowManager.initFlow(`${user.id}:${serverName}`, 'mcp_oauth', { authorizationUrl });

        const firstConnection = manager.getUserConnection({
          serverName,
          user: user as never,
          flowManager: flowManager as never,
        });
        const oauthStart = jest.fn().mockResolvedValue(undefined);
        const joinedConnection = manager.getUserConnection({
          serverName,
          user: user as never,
          flowManager: flowManager as never,
          oauthStart,
        });

        const [conn1, conn2] = await Promise.all([firstConnection, joinedConnection]);

        expect(conn1).toBe(conn2);
        expect(oauthStart).toHaveBeenCalledWith(
          authorizationUrl,
          expect.objectContaining({ expiresAt: expect.any(Number) }),
        );
        expect(createSpy).toHaveBeenCalledTimes(1);
      } finally {
        createSpy.mockRestore();
        registrySpy.mockRestore();
      }
    });

    it('should preserve pending OAuth expiry when joining after the prompt was emitted', async () => {
      const { UserConnectionManager } = await import('~/mcp/UserConnectionManager');

      class TestManager extends UserConnectionManager {}

      const manager = new TestManager();

      const mockConnection = {
        on: jest.fn(),
        isConnected: jest.fn().mockResolvedValue(true),
        refreshToolList: jest.fn().mockResolvedValue(undefined),
        disconnect: jest.fn().mockResolvedValue(undefined),
        isStale: jest.fn().mockReturnValue(false),
      };

      const mockAppConnections = { has: jest.fn().mockResolvedValue(false) };
      manager.appConnections = mockAppConnections as never;

      const mockConfig = {
        type: 'streamable-http',
        url: 'http://localhost:9999/',
        requiresOAuth: true,
        updatedAt: undefined,
        dbId: undefined,
      };

      const registrySpy = jest
        .spyOn(
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          require('~/mcp/registry/MCPServersRegistry').MCPServersRegistry,
          'getInstance',
        )
        .mockReturnValue({
          getServerConfig: jest.fn().mockResolvedValue(mockConfig),
          shouldEnableSSRFProtection: jest.fn().mockReturnValue(false),
          getAllowedDomains: jest.fn().mockReturnValue(null),
          getAllowedAddresses: jest.fn().mockReturnValue(null),
          resolveAllowlists: jest.fn().mockResolvedValue({
            allowedDomains: null,
            allowedAddresses: null,
            useSSRFProtection: false,
          }),
        });

      let releaseConnection: () => void = () => undefined;
      const connectionReleased = new Promise<void>((resolve) => {
        releaseConnection = resolve;
      });

      const { MCPConnectionFactory } = await import('~/mcp/MCPConnectionFactory');
      const authorizationUrl = 'https://auth.example.com/current';
      const createSpy = jest
        .spyOn(MCPConnectionFactory, 'create')
        .mockImplementation(async (_basicOptions, oauthOptions) => {
          if (oauthOptions && 'oauthStart' in oauthOptions) {
            await oauthOptions.oauthStart?.(authorizationUrl);
          }
          await connectionReleased;
          if (oauthOptions && 'oauthEnd' in oauthOptions) {
            await oauthOptions.oauthEnd?.();
          }
          return mockConnection as never;
        });

      try {
        const store = new MockKeyv();
        const flowManager = new FlowStateManager(store as unknown as Keyv, {
          ttl: 30000,
          ci: true,
        });
        const user = { id: 'user-oauth-emitted' };
        const serverName = 'test-server';
        await flowManager.initFlow(`${user.id}:${serverName}`, 'mcp_oauth', { authorizationUrl });

        const firstOAuthStart = jest.fn().mockResolvedValue(undefined);
        const firstOAuthEnd = jest.fn().mockRejectedValue(new Error('owner response is stale'));
        const firstConnection = manager.getUserConnection({
          serverName,
          user: user as never,
          flowManager: flowManager as never,
          oauthStart: firstOAuthStart,
          oauthEnd: firstOAuthEnd,
        });
        for (let i = 0; i < 20 && firstOAuthStart.mock.calls.length === 0; i++) {
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
        expect(firstOAuthStart).toHaveBeenCalledWith(authorizationUrl, undefined);

        const joinedOAuthStart = jest.fn().mockResolvedValue(undefined);
        const joinedOAuthEnd = jest.fn().mockResolvedValue(undefined);
        const joinedConnection = manager.getUserConnection({
          serverName,
          user: user as never,
          flowManager: flowManager as never,
          oauthStart: joinedOAuthStart,
          oauthEnd: joinedOAuthEnd,
        });

        for (let i = 0; i < 20 && joinedOAuthStart.mock.calls.length === 0; i++) {
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
        expect(joinedOAuthStart).toHaveBeenCalledWith(
          authorizationUrl,
          expect.objectContaining({ expiresAt: expect.any(Number) }),
        );

        releaseConnection();
        const [conn1, conn2] = await Promise.all([firstConnection, joinedConnection]);

        expect(conn1).toBe(conn2);
        expect(firstOAuthEnd).toHaveBeenCalledTimes(1);
        expect(joinedOAuthEnd).toHaveBeenCalledTimes(1);
        expect(createSpy).toHaveBeenCalledTimes(1);
      } finally {
        releaseConnection();
        createSpy.mockRestore();
        registrySpy.mockRestore();
      }
    });

    it('should not coalesce when forceNew is true', async () => {
      const { UserConnectionManager } = await import('~/mcp/UserConnectionManager');

      class TestManager extends UserConnectionManager {}

      const manager = new TestManager();

      let callCount = 0;
      const makeConnection = () => ({
        on: jest.fn(),
        isConnected: jest.fn().mockResolvedValue(true),
        refreshToolList: jest.fn().mockResolvedValue(undefined),
        disconnect: jest.fn().mockResolvedValue(undefined),
        removeAllListeners: jest.fn(),
        dispose: jest.fn().mockResolvedValue(undefined),
        isStale: jest.fn().mockReturnValue(false),
      });

      const mockAppConnections = { has: jest.fn().mockResolvedValue(false) };
      manager.appConnections = mockAppConnections as never;

      const mockConfig = {
        type: 'streamable-http',
        url: 'http://localhost:9999/',
        updatedAt: undefined,
        dbId: undefined,
      };

      const registrySpy = jest
        .spyOn(
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          require('~/mcp/registry/MCPServersRegistry').MCPServersRegistry,
          'getInstance',
        )
        .mockReturnValue({
          getServerConfig: jest.fn().mockResolvedValue(mockConfig),
          shouldEnableSSRFProtection: jest.fn().mockReturnValue(false),
          getAllowedDomains: jest.fn().mockReturnValue(null),
          getAllowedAddresses: jest.fn().mockReturnValue(null),
          resolveAllowlists: jest.fn().mockResolvedValue({
            allowedDomains: null,
            allowedAddresses: null,
            useSSRFProtection: false,
          }),
        });

      const { MCPConnectionFactory } = await import('~/mcp/MCPConnectionFactory');
      const createSpy = jest.spyOn(MCPConnectionFactory, 'create').mockImplementation(async () => {
        callCount++;
        await new Promise((r) => setTimeout(r, 50));
        return makeConnection() as never;
      });

      try {
        const store = new MockKeyv();
        const flowManager = new FlowStateManager(store as unknown as Keyv, {
          ttl: 30000,
          ci: true,
        });
        const user = { id: 'user-2' };

        const [conn1, conn2] = await Promise.all([
          manager.getUserConnection({
            serverName: 'test-server',
            forceNew: true,
            user: user as never,
            flowManager: flowManager as never,
          }),
          manager.getUserConnection({
            serverName: 'test-server',
            forceNew: true,
            user: user as never,
            flowManager: flowManager as never,
          }),
        ]);

        expect(callCount).toBe(2);
        expect(conn1).not.toBe(conn2);
        expect(conn1.removeAllListeners).toHaveBeenCalledWith('toolsChanged');
        expect(conn1.dispose).toHaveBeenCalledTimes(1);
      } finally {
        createSpy.mockRestore();
        registrySpy.mockRestore();
      }
    });

    it('waits for an ordinary pending connection before forcing its replacement', async () => {
      const { UserConnectionManager } = await import('~/mcp/UserConnectionManager');

      class TestManager extends UserConnectionManager {}

      const manager = new TestManager();
      const makeConnection = () => ({
        on: jest.fn(),
        isConnected: jest.fn().mockResolvedValue(true),
        refreshToolList: jest.fn().mockResolvedValue(undefined),
        disconnect: jest.fn().mockResolvedValue(undefined),
        removeAllListeners: jest.fn(),
        dispose: jest.fn().mockResolvedValue(undefined),
        isStale: jest.fn().mockReturnValue(false),
      });
      const firstConnection = makeConnection();
      const secondConnection = makeConnection();
      manager.appConnections = { has: jest.fn().mockResolvedValue(false) } as never;

      const registrySpy = jest
        .spyOn(
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          require('~/mcp/registry/MCPServersRegistry').MCPServersRegistry,
          'getInstance',
        )
        .mockReturnValue({
          getServerConfig: jest.fn().mockResolvedValue({
            type: 'streamable-http',
            url: 'http://localhost:9999/',
          }),
          resolveAllowlists: jest.fn().mockResolvedValue({
            allowedDomains: null,
            allowedAddresses: null,
            useSSRFProtection: false,
          }),
        });
      const { MCPConnectionFactory } = await import('~/mcp/MCPConnectionFactory');
      let releaseFirstCreation: () => void = () => undefined;
      const firstCreation = new Promise<void>((resolve) => {
        releaseFirstCreation = resolve;
      });
      const createSpy = jest
        .spyOn(MCPConnectionFactory, 'create')
        .mockImplementationOnce(async () => {
          await firstCreation;
          return firstConnection as never;
        })
        .mockResolvedValueOnce(secondConnection as never);
      const user = { id: 'ordinary-and-force-new-user' };

      try {
        const ordinary = manager.getUserConnection({
          serverName: 'test-server',
          user: user as never,
        });
        for (let attempt = 0; attempt < 20 && createSpy.mock.calls.length === 0; attempt++) {
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
        expect(createSpy).toHaveBeenCalledTimes(1);

        const forced = manager.getUserConnection({
          serverName: 'test-server',
          forceNew: true,
          user: user as never,
        });
        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(createSpy).toHaveBeenCalledTimes(1);

        releaseFirstCreation();
        const [ordinaryConnection, forcedConnection] = await Promise.all([ordinary, forced]);

        expect(ordinaryConnection).toBe(firstConnection);
        expect(forcedConnection).toBe(secondConnection);
        expect(createSpy).toHaveBeenCalledTimes(2);
        expect(firstConnection.removeAllListeners).toHaveBeenCalledWith('toolsChanged');
        expect(firstConnection.dispose).toHaveBeenCalledTimes(1);
      } finally {
        releaseFirstCreation();
        createSpy.mockRestore();
        registrySpy.mockRestore();
      }
    });

    it('waits for an in-flight forced replacement before creating an ordinary connection', async () => {
      const { UserConnectionManager } = await import('~/mcp/UserConnectionManager');

      class TestManager extends UserConnectionManager {}

      const manager = new TestManager();
      const replacementConnection = {
        on: jest.fn(),
        isConnected: jest.fn().mockResolvedValue(true),
        refreshToolList: jest.fn().mockResolvedValue(undefined),
        disconnect: jest.fn().mockResolvedValue(undefined),
        removeAllListeners: jest.fn(),
        dispose: jest.fn().mockResolvedValue(undefined),
        isStale: jest.fn().mockReturnValue(false),
      };
      manager.appConnections = { has: jest.fn().mockResolvedValue(false) } as never;

      const registrySpy = jest
        .spyOn(
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          require('~/mcp/registry/MCPServersRegistry').MCPServersRegistry,
          'getInstance',
        )
        .mockReturnValue({
          getServerConfig: jest.fn().mockResolvedValue({
            type: 'streamable-http',
            url: 'http://localhost:9999/',
          }),
          resolveAllowlists: jest.fn().mockResolvedValue({
            allowedDomains: null,
            allowedAddresses: null,
            useSSRFProtection: false,
          }),
        });
      const { MCPConnectionFactory } = await import('~/mcp/MCPConnectionFactory');
      let releaseReplacement: () => void = () => undefined;
      const replacementStarted = new Promise<void>((resolve) => {
        releaseReplacement = resolve;
      });
      const createSpy = jest.spyOn(MCPConnectionFactory, 'create').mockImplementation(async () => {
        await replacementStarted;
        return replacementConnection as never;
      });
      const user = { id: 'force-new-before-ordinary-user' };

      try {
        const forced = manager.getUserConnection({
          serverName: 'test-server',
          forceNew: true,
          user: user as never,
        });
        for (let attempt = 0; attempt < 20 && createSpy.mock.calls.length === 0; attempt++) {
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
        expect(createSpy).toHaveBeenCalledTimes(1);

        const ordinary = manager.getUserConnection({
          serverName: 'test-server',
          user: user as never,
        });
        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(createSpy).toHaveBeenCalledTimes(1);

        releaseReplacement();
        const [forcedConnection, ordinaryConnection] = await Promise.all([forced, ordinary]);

        expect(forcedConnection).toBe(replacementConnection);
        expect(ordinaryConnection).toBe(replacementConnection);
        expect(createSpy).toHaveBeenCalledTimes(1);
      } finally {
        releaseReplacement();
        createSpy.mockRestore();
        registrySpy.mockRestore();
      }
    });
  });

  describe('Fix 2: PENDING flow is reused, not deleted', () => {
    it('should join an existing PENDING flow via createFlow instead of deleting it', async () => {
      const store = new MockKeyv();
      const flowManager = new FlowStateManager(store as unknown as Keyv, { ttl: 30000, ci: true });

      const flowId = 'test-flow-pending';

      await flowManager.initFlow(flowId, 'mcp_oauth', {
        clientInfo: { client_id: 'test-client' },
      });

      const state = await flowManager.getFlowState(flowId, 'mcp_oauth');
      expect(state?.status).toBe('PENDING');

      const deleteSpy = jest.spyOn(flowManager, 'deleteFlow');

      const monitorPromise = flowManager.createFlow(flowId, 'mcp_oauth', {});

      await new Promise((r) => setTimeout(r, 500));

      await flowManager.completeFlow(flowId, 'mcp_oauth', {
        access_token: 'test-token',
        token_type: 'Bearer',
      } as never);

      const result = await monitorPromise;
      expect(result).toEqual(
        expect.objectContaining({ access_token: 'test-token', token_type: 'Bearer' }),
      );
      expect(deleteSpy).not.toHaveBeenCalled();

      deleteSpy.mockRestore();
    });

    it('should delete and recreate FAILED flows', async () => {
      const store = new MockKeyv();
      const flowManager = new FlowStateManager(store as unknown as Keyv, { ttl: 30000, ci: true });

      const flowId = 'test-flow-failed';
      await flowManager.initFlow(flowId, 'mcp_oauth', {});
      await flowManager.failFlow(flowId, 'mcp_oauth', 'previous error');

      const state = await flowManager.getFlowState(flowId, 'mcp_oauth');
      expect(state?.status).toBe('FAILED');

      await flowManager.deleteFlow(flowId, 'mcp_oauth');

      const afterDelete = await flowManager.getFlowState(flowId, 'mcp_oauth');
      expect(afterDelete).toBeUndefined();
    });
  });

  describe('Fix 3: completeFlow handles deleted state gracefully', () => {
    it('should return false when state was deleted by race', async () => {
      const store = new MockKeyv();
      const flowManager = new FlowStateManager(store as unknown as Keyv, { ttl: 30000, ci: true });

      const flowId = 'race-deleted-flow';

      await flowManager.initFlow(flowId, 'mcp_oauth', {});
      await flowManager.deleteFlow(flowId, 'mcp_oauth');

      const stateBeforeComplete = await flowManager.getFlowState(flowId, 'mcp_oauth');
      expect(stateBeforeComplete).toBeUndefined();

      const result = await flowManager.completeFlow(flowId, 'mcp_oauth', {
        access_token: 'recovered-token',
        token_type: 'Bearer',
      } as never);

      expect(result).toBe(false);

      const stateAfterComplete = await flowManager.getFlowState(flowId, 'mcp_oauth');
      expect(stateAfterComplete).toBeUndefined();

      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('flow not found'),
        expect.any(Object),
      );
    });

    it('should reject monitorFlow when state is deleted and not recoverable', async () => {
      const store = new MockKeyv();
      const flowManager = new FlowStateManager(store as unknown as Keyv, { ttl: 30000, ci: true });

      const flowId = 'monitor-retry-flow';

      await flowManager.initFlow(flowId, 'mcp_oauth', {});

      const monitorPromise = flowManager.createFlow(flowId, 'mcp_oauth', {});

      await new Promise((r) => setTimeout(r, 500));

      await flowManager.deleteFlow(flowId, 'mcp_oauth');

      await expect(monitorPromise).rejects.toThrow('Flow state not found');
    });
  });

  describe('State mapping cleanup on flow replacement', () => {
    it('should delete old state mapping when a flow is replaced', async () => {
      const store = new MockKeyv();
      const flowManager = new FlowStateManager<MCPOAuthTokens | null>(store as unknown as Keyv, {
        ttl: 30000,
        ci: true,
      });

      const flowId = 'user1:test-server';
      const oldState = 'old-random-state-abc123';
      const newState = 'new-random-state-xyz789';

      // Simulate initial flow with state mapping
      await flowManager.initFlow(flowId, 'mcp_oauth', { state: oldState });
      await MCPOAuthHandler.storeStateMapping(oldState, flowId, flowManager);

      // Old state should resolve
      const resolvedBefore = await MCPOAuthHandler.resolveStateToFlowId(oldState, flowManager);
      expect(resolvedBefore).toBe(flowId);

      // Replace the flow: delete old, create new, clean up old state mapping
      await flowManager.deleteFlow(flowId, 'mcp_oauth');
      await MCPOAuthHandler.deleteStateMapping(oldState, flowManager);
      await flowManager.initFlow(flowId, 'mcp_oauth', { state: newState });
      await MCPOAuthHandler.storeStateMapping(newState, flowId, flowManager);

      // Old state should no longer resolve
      const resolvedOld = await MCPOAuthHandler.resolveStateToFlowId(oldState, flowManager);
      expect(resolvedOld).toBeNull();

      // New state should resolve
      const resolvedNew = await MCPOAuthHandler.resolveStateToFlowId(newState, flowManager);
      expect(resolvedNew).toBe(flowId);
    });
  });

  describe('deleteFlowAndStateMapping (uninstall teardown)', () => {
    const createFlowManager = () => {
      const store = new MockKeyv();
      return new FlowStateManager<MCPOAuthTokens | null>(store as unknown as Keyv, {
        ttl: 30000,
        ci: true,
      });
    };

    it('deletes both the flow and its state mapping', async () => {
      const flowManager = createFlowManager();
      const flowId = 'user1:test-server';
      const state = 'random-state-abc123';

      await flowManager.initFlow(flowId, 'mcp_oauth', { state });
      await MCPOAuthHandler.storeStateMapping(state, flowId, flowManager);

      await MCPOAuthHandler.deleteFlowAndStateMapping(flowId, flowManager);

      expect(await MCPOAuthHandler.resolveStateToFlowId(state, flowManager)).toBeNull();
      expect(await flowManager.getFlowState(flowId, 'mcp_oauth')).toBeFalsy();
    });

    it('handles tenant-prefixed flow ids', async () => {
      const flowManager = createFlowManager();
      const flowId = 'tenant:acme:user1:test-server';
      const state = 'tenant-state-xyz789';

      await flowManager.initFlow(flowId, 'mcp_oauth', { state });
      await MCPOAuthHandler.storeStateMapping(state, flowId, flowManager);

      await MCPOAuthHandler.deleteFlowAndStateMapping(flowId, flowManager);

      expect(await MCPOAuthHandler.resolveStateToFlowId(state, flowManager)).toBeNull();
      expect(await flowManager.getFlowState(flowId, 'mcp_oauth')).toBeFalsy();
    });

    it('is a no-op when the flow is absent and leaves unrelated mappings intact', async () => {
      const flowManager = createFlowManager();
      const otherFlowId = 'user2:other-server';
      const otherState = 'other-state-def456';

      await flowManager.initFlow(otherFlowId, 'mcp_oauth', { state: otherState });
      await MCPOAuthHandler.storeStateMapping(otherState, otherFlowId, flowManager);

      await expect(
        MCPOAuthHandler.deleteFlowAndStateMapping('user1:missing-server', flowManager),
      ).resolves.toBeUndefined();

      expect(await MCPOAuthHandler.resolveStateToFlowId(otherState, flowManager)).toBe(otherFlowId);
    });

    it('deletes the flow before the state mapping', async () => {
      const flowManager = createFlowManager();
      const flowId = 'user1:test-server';
      const state = 'ordered-state-ghi789';

      await flowManager.initFlow(flowId, 'mcp_oauth', { state });
      await MCPOAuthHandler.storeStateMapping(state, flowId, flowManager);

      const calls: string[] = [];
      const guardedDeleteSpy = jest.spyOn(flowManager, 'deleteFlowIfCurrent');
      guardedDeleteSpy.mockImplementation(async (id, type) => {
        calls.push(`${type}:${id}`);
        return 'updated';
      });
      const deleteFlowSpy = jest.spyOn(flowManager, 'deleteFlow');
      deleteFlowSpy.mockImplementation(async (id, type) => {
        calls.push(`${type}:${id}`);
        return true;
      });

      await MCPOAuthHandler.deleteFlowAndStateMapping(flowId, flowManager);

      expect(calls).toEqual([`mcp_oauth:${flowId}`, `mcp_oauth_state:${state}`]);
    });

    it('still deletes the flow and rejects when the mapping delete hits a storage error', async () => {
      const flowManager = createFlowManager();
      const flowId = 'user1:test-server';
      const state = 'failing-state-jkl012';

      await flowManager.initFlow(flowId, 'mcp_oauth', { state });
      await MCPOAuthHandler.storeStateMapping(state, flowId, flowManager);

      const realDeleteFlow = flowManager.deleteFlow.bind(flowManager);
      jest.spyOn(flowManager, 'deleteFlow').mockImplementation(async (id, type) => {
        if (type === 'mcp_oauth_state') {
          return false;
        }
        return realDeleteFlow(id, type);
      });

      await expect(MCPOAuthHandler.deleteFlowAndStateMapping(flowId, flowManager)).rejects.toThrow(
        'Failed to fully delete OAuth flow',
      );

      /** The callback-capable flow must not survive token deletion */
      expect(await flowManager.getFlowState(flowId, 'mcp_oauth')).toBeFalsy();
    });

    it('still deletes the mapping and rejects when the flow delete hits a storage error', async () => {
      const flowManager = createFlowManager();
      const flowId = 'user1:test-server';
      const state = 'restore-state-mno345';

      await flowManager.initFlow(flowId, 'mcp_oauth', { state });
      await MCPOAuthHandler.storeStateMapping(state, flowId, flowManager);

      jest.spyOn(flowManager, 'deleteFlowIfCurrent').mockResolvedValue('missing');

      await expect(MCPOAuthHandler.deleteFlowAndStateMapping(flowId, flowManager)).rejects.toThrow(
        'Failed to fully delete OAuth flow',
      );

      /** The surviving flow must not stay callback-capable: its state no longer resolves */
      expect(await MCPOAuthHandler.resolveStateToFlowId(state, flowManager)).toBeNull();
      expect(await flowManager.getFlowState(flowId, 'mcp_oauth')).toBeTruthy();
    });

    it('does not blindly delete the flow when the metadata read hits a storage error', async () => {
      const flowManager = createFlowManager();
      const flowId = 'user1:test-server';
      const state = 'unreadable-state-pqr678';

      await flowManager.initFlow(flowId, 'mcp_oauth', { state });
      await MCPOAuthHandler.storeStateMapping(state, flowId, flowManager);

      jest
        .spyOn(flowManager, 'getFlowState')
        .mockRejectedValueOnce(new Error('read connection lost'));

      await expect(MCPOAuthHandler.deleteFlowAndStateMapping(flowId, flowManager)).rejects.toThrow(
        'read connection lost',
      );

      expect(await flowManager.getFlowState(flowId, 'mcp_oauth')).toBeTruthy();
    });

    it('still deletes the flow when metadata carries no state', async () => {
      const flowManager = createFlowManager();
      const flowId = 'user1:stateless-server';

      await flowManager.initFlow(flowId, 'mcp_oauth', { serverName: 'stateless-server' });

      await MCPOAuthHandler.deleteFlowAndStateMapping(flowId, flowManager);

      expect(await flowManager.getFlowState(flowId, 'mcp_oauth')).toBeFalsy();
    });
  });

  describe('Fix 4: ReauthenticationRequiredError for no-refresh-token', () => {
    it('should throw ReauthenticationRequiredError when access token expired and no refresh token', async () => {
      const expiredDate = new Date(Date.now() - 60000);

      const findToken = jest.fn().mockImplementation(async (filter: { type?: string }) => {
        if (filter.type === 'mcp_oauth') {
          return {
            token: 'enc:expired-access-token',
            expiresAt: expiredDate,
            createdAt: new Date(Date.now() - 120000),
          };
        }
        if (filter.type === 'mcp_oauth_refresh') {
          return null;
        }
        return null;
      });

      await expect(
        MCPTokenStorage.getTokens({
          userId: 'user-1',
          serverName: 'test-server',
          findToken,
        }),
      ).rejects.toThrow(ReauthenticationRequiredError);

      await expect(
        MCPTokenStorage.getTokens({
          userId: 'user-1',
          serverName: 'test-server',
          findToken,
        }),
      ).rejects.toThrow('Re-authentication required');
    });

    it('should throw ReauthenticationRequiredError when access token is missing and no refresh token', async () => {
      const findToken = jest.fn().mockResolvedValue(null);

      await expect(
        MCPTokenStorage.getTokens({
          userId: 'user-1',
          serverName: 'test-server',
          findToken,
        }),
      ).rejects.toThrow(ReauthenticationRequiredError);
    });

    it('should not throw when access token is valid', async () => {
      const futureDate = new Date(Date.now() + 3600000);
      const credentialSetId = 'valid-access-credential-set';

      const findToken = jest.fn().mockImplementation(async (filter: { type?: string }) => {
        if (filter.type === 'mcp_oauth') {
          return {
            token: 'enc:valid-access-token',
            expiresAt: futureDate,
            createdAt: new Date(),
            metadata: { credential_set_id: credentialSetId },
          };
        }
        if (filter.type === 'mcp_oauth_refresh') {
          return null;
        }
        if (filter.type === 'mcp_oauth_client') {
          return {
            token: 'enc:{"client_id":"test-client"}',
            metadata: {
              credential_set_id: credentialSetId,
              authorization_endpoint: 'https://auth.example.com/authorize',
              token_endpoint: 'https://auth.example.com/token',
              server_url: 'https://mcp.example.com/',
              client_source: 'dynamic',
            },
          };
        }
        return null;
      });

      const result = await MCPTokenStorage.getTokens({
        userId: 'user-1',
        serverName: 'test-server',
        findToken,
      });

      expect(result).not.toBeNull();
      expect(result?.access_token).toBe('valid-access-token');
    });
  });

  describe('E2E: OAuth-gated MCP server with no refresh tokens', () => {
    let server: OAuthTestServer;

    beforeEach(async () => {
      server = await createOAuthMCPServer({ tokenTTLMs: 60000 });
    });

    afterEach(async () => {
      await server.close();
    });

    it('should start OAuth-gated MCP server that validates Bearer tokens', async () => {
      const res = await fetch(server.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'initialize', id: 1 }),
      });

      expect(res.status).toBe(401);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe('invalid_token');
    });

    it('should issue tokens via authorization code exchange with no refresh token', async () => {
      const authRes = await fetch(`${server.url}authorize?redirect_uri=http://localhost&state=s1`, {
        redirect: 'manual',
      });

      expect(authRes.status).toBe(302);
      const location = authRes.headers.get('location') ?? '';
      const code = new URL(location).searchParams.get('code');
      expect(code).toBeTruthy();

      const tokenRes = await fetch(`${server.url}token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `grant_type=authorization_code&code=${code}`,
      });

      expect(tokenRes.status).toBe(200);
      const tokenBody = (await tokenRes.json()) as {
        access_token: string;
        token_type: string;
        refresh_token?: string;
      };
      expect(tokenBody.access_token).toBeTruthy();
      expect(tokenBody.token_type).toBe('Bearer');
      expect(tokenBody.refresh_token).toBeUndefined();
    });

    it('should allow MCP requests with valid Bearer token', async () => {
      const authRes = await fetch(`${server.url}authorize?redirect_uri=http://localhost&state=s1`, {
        redirect: 'manual',
      });
      const location = authRes.headers.get('location') ?? '';
      const code = new URL(location).searchParams.get('code');

      const tokenRes = await fetch(`${server.url}token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `grant_type=authorization_code&code=${code}`,
      });

      const { access_token } = (await tokenRes.json()) as { access_token: string };

      const mcpRes = await fetch(server.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          Authorization: `Bearer ${access_token}`,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          method: 'initialize',
          id: 1,
          params: {
            protocolVersion: '2025-03-26',
            capabilities: {},
            clientInfo: { name: 'test', version: '0.0.1' },
          },
        }),
      });

      expect(mcpRes.status).toBe(200);
    });

    it('should reject expired tokens with 401', async () => {
      const shortTTLServer = await createOAuthMCPServer({ tokenTTLMs: 500 });

      try {
        const authRes = await fetch(
          `${shortTTLServer.url}authorize?redirect_uri=http://localhost&state=s1`,
          { redirect: 'manual' },
        );
        const location = authRes.headers.get('location') ?? '';
        const code = new URL(location).searchParams.get('code');

        const tokenRes = await fetch(`${shortTTLServer.url}token`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: `grant_type=authorization_code&code=${code}`,
        });

        const { access_token } = (await tokenRes.json()) as { access_token: string };

        await new Promise((r) => setTimeout(r, 600));

        const mcpRes = await fetch(shortTTLServer.url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${access_token}`,
          },
          body: JSON.stringify({ jsonrpc: '2.0', method: 'ping', id: 2 }),
        });

        expect(mcpRes.status).toBe(401);
      } finally {
        await shortTTLServer.close();
      }
    });
  });
});
