import { logger, getTenantId, tenantStorage } from '@librechat/data-schemas';
import type { TokenMethods, IUser } from '@librechat/data-schemas';
import type { FlowStateManager } from '~/flow/manager';
import type { MCPOAuthTokens } from '~/mcp/oauth';
import type * as t from '~/mcp/types';
import {
  MCPOAuthHandler,
  MCPTokenStorage,
  OboTokenResolutionError,
  ReauthenticationRequiredError,
} from '~/mcp/oauth';
import { PENDING_STALE_MS, FlowStateNotFoundError } from '~/flow/manager';
import { MCPConnectionFactory } from '~/mcp/MCPConnectionFactory';
import { MCPAuthenticationRejectedError } from '~/mcp/errors';
import { getMCPServerGeneration } from '~/mcp/oauth/cleanup';
import { preProcessGraphTokens } from '~/utils/graph';
import { MCPConnection } from '~/mcp/connection';
import { processMCPEnv } from '~/utils';

jest.mock('~/mcp/connection');
jest.mock('~/mcp/oauth', () => ({
  ...jest.createMockFromModule<typeof import('~/mcp/oauth')>('~/mcp/oauth'),
  MCPTokenRefreshUnavailableError:
    jest.requireActual('~/mcp/oauth').MCPTokenRefreshUnavailableError,
  MCPTokenStorageUnavailableError:
    jest.requireActual('~/mcp/oauth').MCPTokenStorageUnavailableError,
}));
jest.mock('~/utils/graph', () => ({
  ...jest.requireActual('~/utils/graph'),
  preProcessGraphTokens: jest.fn(async (options) => options),
}));
jest.mock('~/utils', () => {
  const { isEnabled } = jest.requireActual('~/utils/common');
  const { math } = jest.requireActual('~/utils/math');
  return {
    isEnabled,
    math,
    processMCPEnv: jest.fn(),
  };
});
jest.mock('@librechat/data-schemas', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
  getTenantId: jest.fn(),
  tenantStorage: {
    getStore: jest.fn(),
    run: jest.fn((_context, fn: () => Promise<unknown>) => fn()),
  },
}));

const mockLogger = logger as jest.Mocked<typeof logger>;
const mockTenantStorage = tenantStorage as unknown as {
  getStore: jest.Mock;
  run: jest.Mock;
};
const mockProcessMCPEnv = processMCPEnv as jest.MockedFunction<typeof processMCPEnv>;
const mockPreProcessGraphTokens = preProcessGraphTokens as jest.MockedFunction<
  typeof preProcessGraphTokens
>;
const mockMCPConnection = MCPConnection as jest.MockedClass<typeof MCPConnection>;
const mockMCPOAuthHandler = MCPOAuthHandler as jest.Mocked<typeof MCPOAuthHandler>;
const mockMCPTokenStorage = MCPTokenStorage as jest.Mocked<typeof MCPTokenStorage>;

class InspectableMCPConnectionFactory extends MCPConnectionFactory {
  public constructor(
    basic: t.BasicConnectionOptions,
    options?: t.OAuthConnectionOptions | t.UserConnectionContext,
  ) {
    super(basic, options);
  }

  public async createConnectionForTest(): Promise<MCPConnection> {
    return await this.createConnection();
  }

  public async attemptToConnectForTest(connection: MCPConnection): Promise<void> {
    await this.attemptToConnect(connection);
  }

  public async getOAuthTokensForTest(): Promise<MCPOAuthTokens | null> {
    return await this.getOAuthTokens();
  }

  public async attemptSilentTokenRefreshForTest(
    rejected?: string | null,
  ): Promise<MCPOAuthTokens | null> {
    return await this.attemptSilentTokenRefresh(rejected);
  }

  public bindRequestRecoveryForTest(connection: MCPConnection): () => void {
    return this.handleOAuthEvents(connection, 'oauthReauthenticationRequired');
  }

  public async invalidateTokenFlowsForTest(tokens?: MCPOAuthTokens): Promise<void> {
    await this.invalidateGetTokensFlow(tokens);
  }

  public async handleOAuthRequiredForTest() {
    return await this.handleOAuthRequired();
  }

  public getRequestScopedOAuthState(): {
    signal?: AbortSignal;
    oauthStart?: (authURL: string) => Promise<void>;
    oauthEnd?: () => Promise<void>;
    returnOnOAuth?: boolean;
  } {
    return {
      signal: this.signal,
      oauthStart: this.oauthStart,
      oauthEnd: this.oauthEnd,
      returnOnOAuth: this.returnOnOAuth,
    };
  }

  public hasUpstreamTokenProviderForTest(): boolean {
    return this.upstreamTokenProvider != null;
  }
}

describe('MCPConnectionFactory', () => {
  let mockUser: IUser | undefined;
  let mockServerConfig: t.MCPOptions;
  let mockFlowManager: jest.Mocked<FlowStateManager<MCPOAuthTokens | null>>;
  let mockConnectionInstance: jest.Mocked<MCPConnection>;

  beforeEach(() => {
    jest.clearAllMocks();
    // Cached runtime handlers now delegate before attempting their own refresh,
    // so queued one-shot refresh results must not leak into the next test.
    mockMCPTokenStorage.forceRefreshTokens.mockReset();
    mockMCPTokenStorage.isRefreshTeardownActive.mockReset().mockReturnValue(false);
    // Clear process-local silent-refresh in-flight map so a leftover entry
    // from a prior test (e.g. one that errored before its `finally` ran)
    // cannot cause a later test to join a stale promise.
    (
      MCPConnectionFactory as unknown as { inflightSilentRefreshes: Map<string, unknown> }
    ).inflightSilentRefreshes.clear();
    mockUser = {
      id: 'user123',
      email: 'test@example.com',
    } as IUser;

    mockServerConfig = {
      command: 'node',
      args: ['server.js'],
      initTimeout: 5000,
    } as t.MCPOptions;

    mockFlowManager = {
      getLeaseGeneration: jest.fn().mockResolvedValue(0),
      acquireLease: jest.fn().mockResolvedValue({
        generation: 0,
        release: jest.fn().mockResolvedValue(undefined),
      }),
      initFlow: jest.fn().mockResolvedValue(undefined),
      createFlow: jest.fn(),
      createFlowWithHandler: jest.fn(),
      getFlowState: jest.fn(),
      completeFlow: jest.fn().mockResolvedValue(true),
      deleteFlow: jest.fn().mockResolvedValue(true),
    } as unknown as jest.Mocked<FlowStateManager<MCPOAuthTokens | null>>;

    mockConnectionInstance = {
      connect: jest.fn(),
      isConnected: jest.fn(),
      setOAuthTokens: jest.fn(),
      getOAuthCredentialSetId: jest.fn().mockReturnValue('rejected-generation'),
      setAuthorizationHeader: jest.fn(),
      stopReconnecting: jest.fn(),
      on: jest.fn().mockReturnValue(mockConnectionInstance),
      once: jest.fn().mockReturnValue(mockConnectionInstance),
      off: jest.fn().mockReturnValue(mockConnectionInstance),
      removeListener: jest.fn().mockReturnValue(mockConnectionInstance),
      emit: jest.fn(),
      dispose: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<MCPConnection>;

    mockMCPConnection.mockImplementation(() => mockConnectionInstance);
    mockPreProcessGraphTokens.mockImplementation(async (options) => options);
    mockProcessMCPEnv.mockReturnValue(mockServerConfig);
    mockMCPOAuthHandler.generateFlowId.mockImplementation(
      (userId: string, serverName: string, tenantId?: string) => {
        const flowId = `${userId}:${serverName}`;
        return tenantId ? `tenant:${encodeURIComponent(tenantId)}:${flowId}` : flowId;
      },
    );
    mockMCPOAuthHandler.generateTokenFlowId.mockImplementation(
      (userId: string, serverName: string, tenantId?: string) => {
        const flowId = mockMCPOAuthHandler.generateFlowId(userId, serverName);
        return tenantId ? `tenant:${encodeURIComponent(tenantId)}:${flowId}` : flowId;
      },
    );
    mockMCPOAuthHandler.buildStoredClientMetadata.mockImplementation(
      (metadata, resourceMetadata, serverUrl, clientSource) =>
        metadata && serverUrl && clientSource
          ? {
              ...metadata,
              server_url: serverUrl,
              client_source: clientSource,
              ...(resourceMetadata?.resource && { resource: resourceMetadata.resource }),
            }
          : undefined,
    );
    mockMCPOAuthHandler.assertStoredClientBinding.mockImplementation(() => undefined);
    /**
     * Automock returns `undefined` for a boolean predicate, which would read as
     * "the flow's RFC 8707 decision no longer matches the config" and retire every
     * pending flow. Default it to matching, the way the real implementation does when
     * neither the flow nor the config opts out.
     */
    mockMCPOAuthHandler.matchesResourceParameterDecision.mockReturnValue(true);
    mockMCPTokenStorage.isCurrentAccessToken.mockResolvedValue(true);
    mockMCPTokenStorage.getClientInfoAndMetadata.mockResolvedValue({
      clientInfo: { client_id: 'persisted-client' },
      clientMetadata: {
        server_url: 'https://api.example.com',
        credential_set_id: 'persisted-generation',
      },
    });
    mockTenantStorage.getStore.mockReturnValue(undefined);
    mockTenantStorage.run.mockImplementation((_context, fn: () => Promise<unknown>) => fn());
    (getTenantId as jest.Mock).mockReturnValue(undefined);
  });

  describe('Expired flow result recovery', () => {
    const expired = (): MCPOAuthTokens => ({
      access_token: 'expired-callback',
      token_type: 'Bearer',
      obtained_at: Date.now(),
      expires_at: Date.now() - 1000,
      credential_set_id: 'persisted-generation',
    });
    const factory = (signal?: AbortSignal) =>
      new InspectableMCPConnectionFactory(
        {
          serverName: 'test-server',
          serverConfig: { type: 'sse', url: 'https://api.example.com' },
        },
        {
          useOAuth: true,
          user: mockUser,
          flowManager: mockFlowManager,
          signal,
          tokenMethods: {
            findToken: jest.fn(),
            createToken: jest.fn(),
            replaceTokenIfCurrent: jest.fn(),
            updateToken: jest.fn(),
            deleteTokens: jest.fn(),
          },
        },
      );

    it.each(['getLeaseGeneration', 'acquireLease'] as const)(
      'does not turn a %s outage into missing authorization',
      async (operation) => {
        mockFlowManager.createFlowWithHandler.mockResolvedValue(expired());
        mockFlowManager[operation].mockRejectedValue(new Error('Redis unavailable'));
        await expect(factory().getOAuthTokensForTest()).rejects.toMatchObject({
          name: 'MCPTokenStorageUnavailableError',
        });
        expect(mockFlowManager.createFlowWithHandler).toHaveBeenCalledTimes(1);
        expect(mockMCPOAuthHandler.initiateOAuthFlow).not.toHaveBeenCalled();
      },
    );

    it('defers when teardown supersedes the publication fence', async () => {
      mockFlowManager.createFlowWithHandler.mockResolvedValue(expired());
      mockFlowManager.acquireLease.mockResolvedValue(null);
      await expect(factory().getOAuthTokensForTest()).rejects.toMatchObject({
        name: 'MCPTokenStorageUnavailableError',
      });
      expect(mockFlowManager.createFlowWithHandler).toHaveBeenCalledTimes(1);
    });

    it('preserves transient refresh failure instead of prompting again', async () => {
      const failure = Object.assign(new Error('Provider unavailable'), {
        name: 'MCPTokenRefreshUnavailableError',
      });
      mockFlowManager.createFlowWithHandler
        .mockResolvedValueOnce(expired())
        .mockRejectedValueOnce(failure);
      await expect(factory().getOAuthTokensForTest()).rejects.toBe(failure);
      expect(mockMCPOAuthHandler.initiateOAuthFlow).not.toHaveBeenCalled();
    });

    it('does not loop when the refreshed result is also expired', async () => {
      mockFlowManager.createFlowWithHandler.mockResolvedValue(expired());
      await expect(factory().getOAuthTokensForTest()).rejects.toMatchObject({
        name: 'MCPTokenRefreshUnavailableError',
      });
      expect(mockFlowManager.createFlowWithHandler).toHaveBeenCalledTimes(2);
      expect(mockMCPOAuthHandler.initiateOAuthFlow).not.toHaveBeenCalled();
    });

    it('releases the publication fence without redeeming after caller cancellation', async () => {
      const controller = new AbortController();
      const cancelled = new Error('Caller stopped');
      const release = jest.fn(async () => {
        controller.abort(cancelled);
      });
      mockFlowManager.createFlowWithHandler.mockResolvedValue(expired());
      mockFlowManager.acquireLease.mockResolvedValue({ generation: 0, release });
      await expect(factory(controller.signal).getOAuthTokensForTest()).rejects.toBe(cancelled);
      expect(release).toHaveBeenCalledTimes(1);
      expect(mockFlowManager.createFlowWithHandler).toHaveBeenCalledTimes(1);
      expect(mockMCPOAuthHandler.initiateOAuthFlow).not.toHaveBeenCalled();
    });

    it('does not add a fence or another read to usable flow results', async () => {
      const current = { ...expired(), expires_at: Date.now() + 60000 };
      mockFlowManager.createFlowWithHandler.mockResolvedValue(current);
      await expect(factory().getOAuthTokensForTest()).resolves.toEqual(current);
      expect(mockFlowManager.acquireLease).not.toHaveBeenCalled();
      expect(mockFlowManager.createFlowWithHandler).toHaveBeenCalledTimes(1);
    });
  });

  it('cancels pending retry backoff when the connection deadline expires', async () => {
    jest.useFakeTimers();
    try {
      const config = {
        command: 'node',
        args: ['server.js'],
        initTimeout: 100,
      } as t.MCPOptions;
      mockProcessMCPEnv.mockReturnValue(config);
      const factory = new InspectableMCPConnectionFactory({
        serverName: 'timed-out-server',
        serverConfig: config,
      });
      mockConnectionInstance.connect.mockRejectedValue(new Error('connection failed'));
      mockConnectionInstance.isConnected.mockResolvedValue(false);

      const attempt = factory.attemptToConnectForTest(mockConnectionInstance);
      const rejection = attempt.then(
        () => null,
        (error: Error) => error,
      );

      await jest.advanceTimersByTimeAsync(101);
      await expect(rejection).resolves.toMatchObject({
        message: 'Connection timeout after 100ms',
      });
      await jest.advanceTimersByTimeAsync(5000);

      expect(mockConnectionInstance.connect).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it('disposes a direct-bearer transport when cancellation races initialize', async () => {
    const controller = new AbortController();
    const config = {
      type: 'streamable-http' as const,
      url: 'https://mcp.example.com',
      source: 'yaml' as const,
      headers: { Authorization: 'Bearer {{LIBRECHAT_OPENID_ACCESS_TOKEN}}' },
    };
    mockProcessMCPEnv.mockImplementation(({ options }) => options);
    let finishConnect: (() => void) | undefined;
    mockConnectionInstance.connect.mockReturnValue(
      new Promise<void>((resolve) => {
        finishConnect = resolve;
      }),
    );
    const factory = new InspectableMCPConnectionFactory(
      { serverName: 'cancelled-direct', serverConfig: config },
      { user: mockUser, signal: controller.signal },
    );
    const connection = factory.createConnectionForTest();
    const outcome = connection.catch((error: Error) => error);
    await new Promise((resolve) => setImmediate(resolve));
    controller.abort(new Error('request stopped'));
    await expect(outcome).resolves.toMatchObject({ message: 'request stopped' });
    expect(mockConnectionInstance.dispose).toHaveBeenCalledTimes(1);
    finishConnect?.();
    await new Promise((resolve) => setImmediate(resolve));
    expect(mockConnectionInstance.connect).toHaveBeenCalledTimes(1);
  });

  it('aborts only the local waiter for a shared OAuth flow', async () => {
    const abortController = new AbortController();
    const abortReason = new Error('owner request aborted');
    const sseConfig = {
      url: 'https://api.example.com/mcp',
      type: 'sse' as const,
      requiresOAuth: true,
    } as t.SSEOptions;
    const pendingTokens = new Promise<MCPOAuthTokens | null>(() => undefined);
    const oauthStart = jest.fn().mockResolvedValue(undefined);

    mockProcessMCPEnv.mockReturnValue(sseConfig);
    mockFlowManager.getFlowState.mockResolvedValue({
      status: 'PENDING',
      type: 'mcp_oauth',
      metadata: {
        authorizationUrl: 'https://auth.example.com/pending',
        serverUrl: sseConfig.url,
      },
      createdAt: Date.now(),
    });
    mockFlowManager.createFlow.mockReturnValue(pendingTokens);

    const factory = new InspectableMCPConnectionFactory(
      { serverName: 'test-server', serverConfig: sseConfig },
      {
        useOAuth: true,
        user: mockUser,
        flowManager: mockFlowManager,
        oauthStart,
        signal: abortController.signal,
      },
    );

    const resultPromise = factory.handleOAuthRequiredForTest();
    await new Promise((resolve) => setImmediate(resolve));

    expect(mockFlowManager.createFlow).toHaveBeenCalledWith(
      'user123:test-server',
      'mcp_oauth',
      {},
      undefined,
      false,
    );

    abortController.abort(abortReason);

    await expect(resultPromise).resolves.toEqual(
      expect.objectContaining({ tokens: null, error: abortReason }),
    );
    expect(mockFlowManager.deleteFlow).not.toHaveBeenCalled();
  });

  it('observes the shared flow after an already-aborted local wait', async () => {
    const abortController = new AbortController();
    const abortReason = new Error('request already aborted');
    const sseConfig = {
      url: 'https://api.example.com/mcp',
      type: 'sse' as const,
      requiresOAuth: true,
    } as t.SSEOptions;
    let rejectSharedFlow: ((error: Error) => void) | undefined;
    const sharedFlow = new Promise<MCPOAuthTokens | null>((_resolve, reject) => {
      rejectSharedFlow = reject;
    });

    abortController.abort(abortReason);
    mockProcessMCPEnv.mockReturnValue(sseConfig);
    mockFlowManager.getFlowState.mockResolvedValue({
      status: 'PENDING',
      type: 'mcp_oauth',
      metadata: { authorizationUrl: 'https://auth.example.com/pending' },
      createdAt: Date.now(),
    });
    mockFlowManager.createFlow.mockReturnValue(sharedFlow);

    const factory = new InspectableMCPConnectionFactory(
      { serverName: 'test-server', serverConfig: sseConfig },
      {
        useOAuth: true,
        user: mockUser,
        flowManager: mockFlowManager,
        signal: abortController.signal,
      },
    );

    await expect(factory.handleOAuthRequiredForTest()).resolves.toEqual(
      expect.objectContaining({ tokens: null, error: abortReason }),
    );

    rejectSharedFlow?.(new Error('shared flow later failed'));
    await new Promise((resolve) => setImmediate(resolve));
    expect(mockFlowManager.deleteFlow).not.toHaveBeenCalled();
  });

  describe('static create method', () => {
    it('should create a basic connection without OAuth', async () => {
      const basicOptions = {
        serverName: 'test-server',
        serverConfig: mockServerConfig,
      };

      mockConnectionInstance.isConnected.mockResolvedValue(true);

      const connection = await MCPConnectionFactory.create(basicOptions);

      expect(connection).toBe(mockConnectionInstance);
      expect(mockProcessMCPEnv).toHaveBeenCalledWith({
        options: mockServerConfig,
        dbSourced: undefined,
      });
      expect(mockMCPConnection).toHaveBeenCalledWith({
        serverName: 'test-server',
        serverConfig: mockServerConfig,
        userId: undefined,
        oauthTokens: null,
        useSSRFProtection: false,
        allowedAddresses: undefined,
        ephemeralConnection: false,
      });
      expect(mockConnectionInstance.connect).toHaveBeenCalled();
    });

    it('passes the validated App operation limits into App-profile transport construction', async () => {
      const operationLimits = { maxBytes: 2 * 1024 * 1024, timeoutMs: 45_000, maxActive: 4 };
      mockConnectionInstance.isConnected.mockResolvedValue(true);

      await MCPConnectionFactory.create({
        serverName: 'app-server',
        serverConfig: mockServerConfig,
        capabilityProfile: 'apps',
        operationLimits,
      });

      expect(mockMCPConnection).toHaveBeenCalledWith(
        expect.objectContaining({ capabilityProfile: 'apps', operationLimits }),
      );
    });

    it('should merge requestHeaders before Graph pre-processing, overriding by case', async () => {
      const graphTokenResolver = jest.fn();
      const serverConfig = {
        type: 'streamable-http',
        url: 'https://api.example.com/mcp',
        source: 'yaml',
        apiKey: { source: 'admin', authorization_type: 'bearer', key: 'catalog-key' },
        headers: { 'X-Workspace': 'workspace-1', Authorization: 'Bearer stale' },
        requestHeaders: { authorization: 'Bearer {{LIBRECHAT_GRAPH_ACCESS_TOKEN}}' },
      } as t.MCPOptions;

      mockPreProcessGraphTokens.mockImplementation(async (config) => config as t.MCPOptions);
      mockProcessMCPEnv.mockImplementation(
        ({ options }: { options: t.MCPOptions }) => options as t.MCPOptions,
      );
      mockConnectionInstance.isConnected.mockResolvedValue(true);

      await MCPConnectionFactory.create(
        { serverName: 'test-server', serverConfig },
        { user: mockUser, graphTokenResolver },
      );

      /** The preprocessor only inspects `headers`, so the chat-only map has to be
       *  folded in before it runs — and the base `Authorization` must be gone,
       *  since keeping both spellings would let Undici join the two values. */
      const preprocessed = mockPreProcessGraphTokens.mock.calls[0][0] as {
        headers?: Record<string, string>;
        requestHeaders?: Record<string, string>;
      };
      expect(preprocessed.headers).toEqual({
        'X-Workspace': 'workspace-1',
        authorization: 'Bearer {{LIBRECHAT_GRAPH_ACCESS_TOKEN}}',
      });
      expect(preprocessed).not.toHaveProperty('requestHeaders');
    });

    it('should pre-process Graph placeholders before connection config resolution', async () => {
      const graphTokenResolver = jest.fn();
      const serverConfig: t.MCPOptions = {
        type: 'streamable-http',
        url: 'https://api.example.com/mcp?token={{LIBRECHAT_GRAPH_ACCESS_TOKEN}}',
      };
      const graphProcessedConfig: t.MCPOptions = {
        ...serverConfig,
        url: 'https://api.example.com/mcp?token=resolved-graph-token',
      };
      const basicOptions = {
        serverName: 'test-server',
        serverConfig,
      };

      mockPreProcessGraphTokens.mockResolvedValue(graphProcessedConfig);
      mockProcessMCPEnv.mockReturnValue(graphProcessedConfig);
      mockConnectionInstance.isConnected.mockResolvedValue(true);

      await MCPConnectionFactory.create(basicOptions, {
        user: mockUser,
        graphTokenResolver,
      });

      expect(mockPreProcessGraphTokens).toHaveBeenCalledWith(
        serverConfig,
        expect.objectContaining({
          user: mockUser,
          graphTokenResolver,
        }),
      );
      expect(mockProcessMCPEnv).toHaveBeenCalledWith(
        expect.objectContaining({
          options: graphProcessedConfig,
        }),
      );
      expect(mockMCPConnection).toHaveBeenCalledWith(
        expect.objectContaining({
          serverConfig: graphProcessedConfig,
        }),
      );
    });

    it('should register fallback oauthRequired handler for non-OAuth connections', async () => {
      const basicOptions = {
        serverName: 'test-server',
        serverConfig: mockServerConfig,
      };

      mockConnectionInstance.isConnected.mockResolvedValue(true);

      await MCPConnectionFactory.create(basicOptions);

      expect(mockConnectionInstance.on).toHaveBeenCalledWith('oauthRequired', expect.any(Function));

      const onCall = (mockConnectionInstance.on as jest.Mock).mock.calls.find(
        ([event]: [string]) => event === 'oauthRequired',
      );
      const handler = onCall![1] as () => void;
      handler();

      expect(mockConnectionInstance.emit).toHaveBeenCalledWith(
        'oauthFailed',
        expect.objectContaining({ message: 'Server does not use OAuth' }),
      );
      // The fallback `oauthRequired` listener is intentionally kept attached
      // for the connection's lifetime so mid-session 401s are still handled.
      expect(mockConnectionInstance.removeListener).not.toHaveBeenCalledWith(
        'oauthRequired',
        expect.any(Function),
      );
    });

    it('should create a connection with OAuth', async () => {
      const basicOptions = {
        serverName: 'test-server',
        serverConfig: mockServerConfig,
      };

      const oauthOptions = {
        useOAuth: true as const,
        user: mockUser,
        flowManager: mockFlowManager,
        tokenMethods: {
          findToken: jest.fn(),
          createToken: jest.fn(),
          updateToken: jest.fn(),
          deleteTokens: jest.fn(),
        },
      };

      const mockTokens: MCPOAuthTokens = {
        access_token: 'access123',
        refresh_token: 'refresh123',
        token_type: 'Bearer',
        obtained_at: Date.now(),
        credential_set_id: 'callback-generation',
      };

      mockFlowManager.createFlowWithHandler.mockResolvedValue(mockTokens);
      mockConnectionInstance.isConnected.mockResolvedValue(true);

      const connection = await MCPConnectionFactory.create(basicOptions, oauthOptions);

      expect(connection).toBe(mockConnectionInstance);
      expect(mockProcessMCPEnv).toHaveBeenCalledWith({
        options: mockServerConfig,
        user: mockUser,
        dbSourced: undefined,
      });
      expect(mockMCPConnection).toHaveBeenCalledWith({
        serverName: 'test-server',
        serverConfig: mockServerConfig,
        userId: 'user123',
        oauthTokens: mockTokens,
        useSSRFProtection: false,
        allowedAddresses: undefined,
        ephemeralConnection: false,
      });
    });

    it('should tenant-scope mcp_get_tokens flow locks', async () => {
      mockTenantStorage.getStore.mockReturnValueOnce({ tenantId: 'tenant-a' });
      mockMCPOAuthHandler.generateFlowId.mockImplementation((_user, _server, tenant) =>
        tenant ? `tenant:${tenant}:flow123` : 'flow123',
      );

      const basicOptions = {
        serverName: 'test-server',
        serverConfig: mockServerConfig,
      };

      const oauthOptions = {
        useOAuth: true as const,
        user: mockUser,
        flowManager: mockFlowManager,
        tokenMethods: {
          findToken: jest.fn(),
          createToken: jest.fn(),
          updateToken: jest.fn(),
          deleteTokens: jest.fn(),
        },
      };

      mockFlowManager.createFlowWithHandler.mockResolvedValue(null);
      mockConnectionInstance.isConnected.mockResolvedValue(true);

      await MCPConnectionFactory.create(basicOptions, oauthOptions);

      expect(mockFlowManager.createFlowWithHandler).toHaveBeenCalledWith(
        'tenant:tenant-a:flow123',
        'mcp_get_tokens',
        expect.any(Function),
        undefined,
      );
    });
  });

  describe('OAuth token handling', () => {
    it('should return null when no findToken method is provided', async () => {
      const basicOptions = {
        serverName: 'test-server',
        serverConfig: mockServerConfig,
      };

      const oauthOptions: t.OAuthConnectionOptions = {
        useOAuth: true as const,
        user: mockUser,
        flowManager: mockFlowManager,
        tokenMethods: {
          findToken: undefined as unknown as TokenMethods['findToken'],
          createToken: jest.fn(),
          replaceTokenIfCurrent: jest.fn(),
          updateToken: jest.fn(),
          deleteTokens: jest.fn(),
        },
      };

      mockConnectionInstance.isConnected.mockResolvedValue(true);

      await MCPConnectionFactory.create(basicOptions, oauthOptions);

      expect(mockFlowManager.createFlowWithHandler).not.toHaveBeenCalled();
    });

    describe('token flow invalidated while waiting', () => {
      const tokenLoadingFactory = (
        hooks: Pick<
          t.UserConnectionContext,
          | 'onOAuthCredentialsAdopted'
          | 'onOAuthCredentialsInvalidated'
          | 'onOAuthCredentialsChanged'
        > = {},
        oauthRefreshCoordination?: boolean,
      ) =>
        new InspectableMCPConnectionFactory(
          {
            serverName: 'test-server',
            serverConfig: { ...mockServerConfig, oauthRefreshCoordination },
          },
          {
            useOAuth: true,
            user: mockUser,
            flowManager: mockFlowManager,
            tokenMethods: {
              findToken: jest.fn(),
              createToken: jest.fn(),
              replaceTokenIfCurrent: jest.fn(),
              updateToken: jest.fn(),
              deleteTokens: jest.fn(),
            },
            ...hooks,
          },
        );

      it.each([undefined, false, true])(
        'switches token protocol only when coordination is enabled (%s)',
        async (enabled) => {
          mockProcessMCPEnv.mockReturnValue({
            ...mockServerConfig,
            oauthRefreshCoordination: enabled,
          });
          mockMCPOAuthHandler.generateFlowId.mockReturnValue('legacy-token-flow');
          mockMCPOAuthHandler.generateTokenFlowId.mockReturnValue('versioned-token-flow');
          mockFlowManager.createFlowWithHandler.mockResolvedValue(null);
          await tokenLoadingFactory({}, enabled).getOAuthTokensForTest();
          expect(mockFlowManager.createFlowWithHandler).toHaveBeenCalledWith(
            enabled ? 'versioned-token-flow' : 'legacy-token-flow',
            'mcp_get_tokens',
            expect.any(Function),
            undefined,
          );
        },
      );

      it('re-reads stored tokens after the flow it waited on is invalidated by a credential change', async () => {
        const storedTokens: MCPOAuthTokens = {
          access_token: 'stored-after-change',
          token_type: 'Bearer',
          obtained_at: Date.now(),
          credential_set_id: 'persisted-generation',
        };
        mockFlowManager.createFlowWithHandler
          .mockRejectedValueOnce(new FlowStateNotFoundError('mcp_get_tokens'))
          .mockResolvedValueOnce(storedTokens);
        const onOAuthCredentialsInvalidated = jest.fn().mockResolvedValue(undefined);
        const onOAuthCredentialsAdopted = jest.fn();

        await expect(
          tokenLoadingFactory({
            onOAuthCredentialsInvalidated,
            onOAuthCredentialsAdopted,
          }).getOAuthTokensForTest(),
        ).resolves.toEqual(storedTokens);

        expect(mockFlowManager.createFlowWithHandler).toHaveBeenCalledTimes(2);
        expect(onOAuthCredentialsInvalidated).toHaveBeenCalledTimes(1);
        expect(onOAuthCredentialsInvalidated.mock.invocationCallOrder[0]).toBeLessThan(
          mockFlowManager.createFlowWithHandler.mock.invocationCallOrder[1],
        );
        expect(onOAuthCredentialsAdopted).not.toHaveBeenCalled();
      });

      it('does not announce a second credential change for a peer rotation it adopted', async () => {
        const adoptedTokens: MCPOAuthTokens = {
          access_token: 'rotated-by-a-peer',
          token_type: 'Bearer',
          obtained_at: Date.now(),
          credential_set_id: 'peer-generation',
        };
        const onOAuthCredentialsChanged = jest.fn().mockResolvedValue(undefined);
        const onOAuthCredentialsInvalidated = jest.fn().mockResolvedValue('peer-publication');
        /** Run the flow handler, so the factory's own `onTokensAdopted` wiring is exercised. */
        mockFlowManager.createFlowWithHandler.mockImplementation(
          async (_flowId: string, _type: string, handler: () => Promise<MCPOAuthTokens | null>) =>
            handler(),
        );
        mockMCPTokenStorage.getTokens.mockImplementationOnce(async (params) => {
          await params.onTokensAdopted?.(adoptedTokens);
          return adoptedTokens;
        });
        mockFlowManager.getFlowState.mockResolvedValue({
          type: 'mcp_get_tokens',
          status: 'COMPLETED',
          metadata: {},
          createdAt: Date.now(),
          result: adoptedTokens,
        });

        await expect(
          tokenLoadingFactory({
            onOAuthCredentialsChanged,
            onOAuthCredentialsInvalidated,
          }).getOAuthTokensForTest(),
        ).resolves.toEqual(adoptedTokens);

        /**
         * The peer persisted and announced this rotation. Announcing it again would advance the
         * authorization generation a second time for one rotation, retiring the generation
         * recaptured here and leaving the build fenced against its own tool publication.
         */
        expect(onOAuthCredentialsChanged).not.toHaveBeenCalled();
        expect(adoptedTokens.publication_generation).toBe('peer-publication');
        expect(onOAuthCredentialsInvalidated).toHaveBeenCalledTimes(1);
        /** Capture the peer generation before sharing its tokens with flow waiters. */
        expect(mockFlowManager.deleteFlow).toHaveBeenCalled();
        expect(onOAuthCredentialsInvalidated.mock.invocationCallOrder[0]).toBeLessThan(
          mockFlowManager.deleteFlow.mock.invocationCallOrder[0],
        );
      });

      it.each([false, true])(
        'removes both completed token protocols before rollback (%s)',
        async (enabled) => {
          mockProcessMCPEnv.mockReturnValue({
            ...mockServerConfig,
            oauthRefreshCoordination: enabled,
          });
          mockMCPOAuthHandler.generateFlowId.mockReturnValue('legacy-flow');
          mockMCPOAuthHandler.generateTokenFlowId.mockReturnValue('versioned-flow');
          mockFlowManager.getFlowState.mockResolvedValue({
            status: 'COMPLETED',
            type: 'mcp_get_tokens',
            metadata: {},
            createdAt: Date.now(),
          });
          await tokenLoadingFactory({}, enabled).invalidateTokenFlowsForTest();
          expect(mockFlowManager.deleteFlow).toHaveBeenCalledWith('legacy-flow', 'mcp_get_tokens');
          expect(mockFlowManager.deleteFlow).toHaveBeenCalledWith(
            'versioned-flow',
            'mcp_get_tokens',
          );
        },
      );

      it('defers recovery when the re-read loses its flow as well', async () => {
        mockFlowManager.createFlowWithHandler.mockRejectedValue(
          new FlowStateNotFoundError('mcp_get_tokens'),
        );
        const onOAuthCredentialsInvalidated = jest.fn().mockResolvedValue(undefined);

        await expect(
          tokenLoadingFactory({ onOAuthCredentialsInvalidated }).getOAuthTokensForTest(),
        ).rejects.toMatchObject({ name: 'MCPTokenStorageUnavailableError' });

        expect(mockFlowManager.createFlowWithHandler).toHaveBeenCalledTimes(2);
        expect(onOAuthCredentialsInvalidated).toHaveBeenCalledTimes(1);
      });

      it.each(['Error', 'TimeoutError', 'ReplyError', 'SyntaxError'])(
        'defers a %s token-flow failure without prompting',
        async (name) => {
          mockFlowManager.createFlowWithHandler.mockRejectedValue(
            Object.assign(new Error('token store unavailable'), { name }),
          );
          const onOAuthCredentialsInvalidated = jest.fn().mockResolvedValue(undefined);

          await expect(
            tokenLoadingFactory({ onOAuthCredentialsInvalidated }).getOAuthTokensForTest(),
          ).rejects.toMatchObject({ name: 'MCPTokenStorageUnavailableError' });

          expect(mockFlowManager.createFlowWithHandler).toHaveBeenCalledTimes(1);
          expect(onOAuthCredentialsInvalidated).not.toHaveBeenCalled();
        },
      );

      it.each(['TimeoutError', 'ReplyError', 'SyntaxError'])(
        'defers a %s from the token-flow retry',
        async (name) => {
          mockFlowManager.createFlowWithHandler
            .mockRejectedValueOnce(new FlowStateNotFoundError('mcp_get_tokens'))
            .mockRejectedValueOnce(Object.assign(new Error('cache unavailable'), { name }));
          await expect(tokenLoadingFactory().getOAuthTokensForTest()).rejects.toMatchObject({
            name: 'MCPTokenStorageUnavailableError',
          });
          expect(mockFlowManager.createFlowWithHandler).toHaveBeenCalledTimes(2);
        },
      );

      it('preserves serialized reauthentication as an explicit interactive outcome', async () => {
        mockFlowManager.createFlowWithHandler.mockRejectedValueOnce(
          Object.assign(new Error('credentials missing'), {
            name: 'ReauthenticationRequiredError',
          }),
        );
        await expect(tokenLoadingFactory().getOAuthTokensForTest()).resolves.toBeNull();
      });

      it('invalidates a stale flow token and defers the next storage read', async () => {
        mockFlowManager.createFlowWithHandler.mockResolvedValueOnce({
          access_token: 'stale',
          token_type: 'Bearer',
          obtained_at: Date.now(),
        });
        mockMCPTokenStorage.isCurrentAccessToken.mockResolvedValueOnce(false);
        mockFlowManager.getFlowState.mockResolvedValueOnce({
          type: 'mcp_get_tokens',
          status: 'COMPLETED',
          metadata: {},
          createdAt: Date.now(),
        });
        await expect(tokenLoadingFactory().getOAuthTokensForTest()).rejects.toMatchObject({
          name: 'MCPTokenStorageUnavailableError',
        });
        expect(mockFlowManager.deleteFlow).toHaveBeenCalled();
      });

      it('defers a failed client metadata verification read', async () => {
        mockFlowManager.createFlowWithHandler.mockResolvedValueOnce({
          access_token: 'stored',
          token_type: 'Bearer',
          obtained_at: Date.now(),
        });
        mockMCPTokenStorage.getClientInfoAndMetadata.mockRejectedValueOnce(
          new SyntaxError('cache unavailable'),
        );
        await expect(tokenLoadingFactory().getOAuthTokensForTest()).rejects.toMatchObject({
          name: 'MCPTokenStorageUnavailableError',
        });
      });

      it('adopts the generation carried by tokens another authorization released', async () => {
        const releasedTokens: MCPOAuthTokens = {
          access_token: 'released-by-callback',
          token_type: 'Bearer',
          obtained_at: 1_700_000_000_000,
          credential_set_id: 'persisted-generation',
          publication_generation: 'generation-b',
        };
        mockFlowManager.createFlowWithHandler.mockResolvedValue(releasedTokens);
        const onOAuthCredentialsAdopted = jest.fn();

        await expect(
          tokenLoadingFactory({ onOAuthCredentialsAdopted }).getOAuthTokensForTest(),
        ).resolves.toEqual(releasedTokens);

        expect(onOAuthCredentialsAdopted).toHaveBeenCalledWith('generation-b');
      });
    });

    it('rejects a cached access token before it reaches a differently bound connection', async () => {
      const currentConfig = {
        type: 'sse' as const,
        url: 'https://server-b.example.com/mcp',
        initTimeout: 5000,
      } as t.SSEOptions;
      mockProcessMCPEnv.mockReturnValue(currentConfig);
      mockFlowManager.createFlowWithHandler.mockResolvedValue({
        access_token: 'server-a-access-token',
        token_type: 'Bearer',
        obtained_at: Date.now(),
      });
      mockMCPTokenStorage.getClientInfoAndMetadata.mockResolvedValue({
        clientInfo: { client_id: 'dynamic-client' },
        clientMetadata: {
          authorization_endpoint: 'https://auth.example.com/authorize',
          token_endpoint: 'https://auth.example.com/token',
          server_url: 'https://server-a.example.com/mcp',
          client_source: 'dynamic',
        },
      });
      mockMCPOAuthHandler.assertStoredClientBinding.mockImplementationOnce(
        (_serverName, serverUrl, _clientInfo, storedMetadata) => {
          if (storedMetadata?.server_url !== serverUrl) {
            throw new Error('stale OAuth binding');
          }
        },
      );

      const factory = new InspectableMCPConnectionFactory(
        { serverName: 'test-server', serverConfig: currentConfig },
        {
          useOAuth: true,
          user: mockUser,
          flowManager: mockFlowManager,
          tokenMethods: {
            findToken: jest.fn(),
            createToken: jest.fn(),
            replaceTokenIfCurrent: jest.fn(),
            updateToken: jest.fn(),
            deleteTokens: jest.fn(),
          },
        },
      );
      mockConnectionInstance.isConnected.mockResolvedValue(true);

      await expect(factory.createConnectionForTest()).resolves.toBe(mockConnectionInstance);
      expect(mockMCPTokenStorage.isCurrentAccessToken).toHaveBeenCalledWith(
        expect.objectContaining({ accessToken: 'server-a-access-token' }),
      );
      expect(mockMCPTokenStorage.getClientInfoAndMetadata).toHaveBeenCalled();
      expect(mockMCPOAuthHandler.assertStoredClientBinding).toHaveBeenCalledWith(
        'test-server',
        'https://server-b.example.com/mcp',
        expect.objectContaining({ client_id: 'dynamic-client' }),
        expect.objectContaining({ server_url: 'https://server-a.example.com/mcp' }),
        undefined,
      );
      expect(mockMCPConnection).toHaveBeenCalledWith(
        expect.objectContaining({
          serverName: 'test-server',
          serverConfig: currentConfig,
          oauthTokens: null,
        }),
      );
    });

    it('rejects a cached token when the client generation changes after access validation', async () => {
      const currentConfig = {
        type: 'sse' as const,
        url: 'https://server.example.com/mcp',
        initTimeout: 5000,
      } as t.SSEOptions;
      mockProcessMCPEnv.mockReturnValue(currentConfig);
      mockFlowManager.createFlowWithHandler.mockResolvedValue({
        access_token: 'generation-a-access',
        token_type: 'Bearer',
        obtained_at: Date.now(),
        credential_set_id: 'credential-set-a',
      });
      mockMCPTokenStorage.isCurrentAccessToken.mockResolvedValueOnce(true);
      mockMCPTokenStorage.getClientInfoAndMetadata.mockResolvedValue({
        clientInfo: { client_id: 'client-b' },
        clientMetadata: {
          authorization_endpoint: 'https://auth.example.com/authorize',
          token_endpoint: 'https://auth.example.com/token',
          server_url: 'https://server.example.com/mcp',
          client_source: 'dynamic',
          credential_set_id: 'credential-set-b',
        },
      });
      mockMCPTokenStorage.assertCredentialSetBinding.mockImplementationOnce(
        (_serverName, tokenCredentialSetId, clientMetadata) => {
          if (tokenCredentialSetId !== clientMetadata?.credential_set_id) {
            throw new ReauthenticationRequiredError('test-server', 'binding');
          }
        },
      );

      const factory = new InspectableMCPConnectionFactory(
        { serverName: 'test-server', serverConfig: currentConfig },
        {
          useOAuth: true,
          user: mockUser,
          flowManager: mockFlowManager,
          tokenMethods: {
            findToken: jest.fn(),
            createToken: jest.fn(),
            replaceTokenIfCurrent: jest.fn(),
            updateToken: jest.fn(),
            deleteTokens: jest.fn(),
          },
        },
      );

      await expect(factory.getOAuthTokensForTest()).resolves.toBeNull();
      expect(mockMCPTokenStorage.isCurrentAccessToken).toHaveBeenCalledWith(
        expect.objectContaining({
          accessToken: 'generation-a-access',
          credentialSetId: 'credential-set-a',
        }),
      );
      expect(mockMCPTokenStorage.assertCredentialSetBinding).toHaveBeenCalledWith(
        'test-server',
        'credential-set-a',
        expect.objectContaining({ credential_set_id: 'credential-set-b' }),
      );
    });

    it('starts access and client binding verification in parallel', async () => {
      const currentConfig = {
        type: 'sse' as const,
        url: 'https://server.example.com/mcp',
        initTimeout: 5000,
      } as t.SSEOptions;
      mockProcessMCPEnv.mockReturnValue(currentConfig);
      mockFlowManager.createFlowWithHandler.mockResolvedValue({
        access_token: 'generation-a-access',
        token_type: 'Bearer',
        obtained_at: Date.now(),
        credential_set_id: 'credential-set-a',
      });

      let resolveAccessVerification!: (value: boolean) => void;
      const accessVerification = new Promise<boolean>((resolve) => {
        resolveAccessVerification = resolve;
      });
      const verificationStarts: string[] = [];
      mockMCPTokenStorage.isCurrentAccessToken.mockImplementationOnce(() => {
        verificationStarts.push('access');
        return accessVerification;
      });
      mockMCPTokenStorage.getClientInfoAndMetadata.mockImplementationOnce(async () => {
        verificationStarts.push('client');
        return {
          clientInfo: { client_id: 'client-a' },
          clientMetadata: {
            server_url: 'https://server.example.com/mcp',
            credential_set_id: 'credential-set-a',
          },
        };
      });

      const factory = new InspectableMCPConnectionFactory(
        { serverName: 'test-server', serverConfig: currentConfig },
        {
          useOAuth: true,
          user: mockUser,
          flowManager: mockFlowManager,
          tokenMethods: {
            findToken: jest.fn(),
            createToken: jest.fn(),
            replaceTokenIfCurrent: jest.fn(),
            updateToken: jest.fn(),
            deleteTokens: jest.fn(),
          },
        },
      );

      const tokenRead = factory.getOAuthTokensForTest();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(verificationStarts).toEqual(['access', 'client']);

      resolveAccessVerification(true);
      await expect(tokenRead).resolves.toMatchObject({
        access_token: 'generation-a-access',
        credential_set_id: 'credential-set-a',
      });
    });

    it('replaces a recent PENDING OAuth flow whose resource-parameter decision changed', async () => {
      /**
       * An operator sets `send_resource_parameter: false` to repair a failing Entra
       * login. The pending flow's authorization URL still carries `resource`, so
       * replaying it would reissue the request that just failed. The stored client
       * binding is unchanged here, so the resource-parameter check is the only thing
       * that can retire the flow.
       */
      const currentConfig = {
        type: 'sse' as const,
        url: 'https://server-a.example.com/mcp',
        initTimeout: 5000,
        oauth: { send_resource_parameter: false },
      } as t.SSEOptions;
      const staleMetadata = {
        serverName: 'test-server',
        userId: 'user123',
        serverUrl: 'https://server-a.example.com/mcp',
        state: 'stale-state',
        authorizationUrl:
          'https://auth.example.com/old-authorize?resource=https%3A%2F%2Fserver-a.example.com%2Fmcp',
        clientInfo: { client_id: 'dynamic-client' },
        clientSource: 'dynamic' as const,
        metadata: {
          authorization_endpoint: 'https://auth.example.com/authorize',
          token_endpoint: 'https://auth.example.com/token',
        },
      };
      const freshTokens: MCPOAuthTokens = {
        access_token: 'fresh-access-token',
        token_type: 'Bearer',
        obtained_at: Date.now(),
      };
      const oauthStart = jest.fn();

      mockProcessMCPEnv.mockReturnValue(currentConfig);
      mockMCPOAuthHandler.generateFlowId.mockReturnValue('flow123');
      mockMCPOAuthHandler.matchesResourceParameterDecision.mockReturnValue(false);
      mockFlowManager.getFlowState.mockResolvedValue({
        status: 'PENDING',
        type: 'mcp_oauth',
        metadata: staleMetadata,
        createdAt: Date.now(),
      });
      mockMCPOAuthHandler.initiateOAuthFlow.mockResolvedValue({
        authorizationUrl: 'https://auth.example.com/fresh-authorize',
        flowId: 'fresh-flow',
        flowMetadata: {
          ...staleMetadata,
          state: 'fresh-state',
          authorizationUrl: 'https://auth.example.com/fresh-authorize',
          sendResourceParameter: false,
        },
      });
      mockFlowManager.createFlow.mockResolvedValue(freshTokens);

      const factory = new InspectableMCPConnectionFactory(
        { serverName: 'test-server', serverConfig: currentConfig },
        {
          useOAuth: true,
          user: mockUser,
          flowManager: mockFlowManager,
          oauthStart,
          tokenMethods: {
            findToken: jest.fn(),
            createToken: jest.fn(),
            replaceTokenIfCurrent: jest.fn(),
            updateToken: jest.fn(),
            deleteTokens: jest.fn(),
          },
        },
      );

      const result = await factory.handleOAuthRequiredForTest();

      expect(mockMCPOAuthHandler.matchesResourceParameterDecision).toHaveBeenCalledWith(
        expect.objectContaining({ state: 'stale-state' }),
        currentConfig.oauth,
      );
      expect(result?.tokens).toEqual(freshTokens);
      expect(mockMCPOAuthHandler.initiateOAuthFlow).toHaveBeenCalled();
      expect(oauthStart).toHaveBeenCalledWith('https://auth.example.com/fresh-authorize');
      expect(oauthStart).not.toHaveBeenCalledWith(
        expect.stringContaining('resource='),
        expect.anything(),
      );
    });

    it.each(['PENDING', 'COMPLETED'] as const)(
      'replaces a recent %s OAuth flow bound to another server URL',
      async (status) => {
        const currentConfig = {
          type: 'sse' as const,
          url: 'https://server-b.example.com/mcp',
          initTimeout: 5000,
        } as t.SSEOptions;
        const staleMetadata = {
          serverName: 'test-server',
          userId: 'user123',
          serverUrl: 'https://server-a.example.com/mcp',
          state: 'stale-state',
          authorizationUrl: 'https://auth.example.com/old-authorize',
          clientInfo: { client_id: 'old-dynamic-client' },
          clientSource: 'dynamic' as const,
          metadata: {
            authorization_endpoint: 'https://auth.example.com/authorize',
            token_endpoint: 'https://auth.example.com/token',
          },
        };
        const staleTokens: MCPOAuthTokens = {
          access_token: 'server-a-access-token',
          token_type: 'Bearer',
          obtained_at: Date.now(),
        };
        const freshTokens: MCPOAuthTokens = {
          access_token: 'server-b-access-token',
          token_type: 'Bearer',
          obtained_at: Date.now(),
        };
        const oauthStart = jest.fn();

        mockProcessMCPEnv.mockReturnValue(currentConfig);
        mockMCPOAuthHandler.generateFlowId.mockReturnValue('flow123');
        mockMCPOAuthHandler.assertStoredClientBinding.mockImplementation(
          (_serverName, serverUrl, _clientInfo, storedMetadata) => {
            if (storedMetadata?.server_url !== serverUrl) {
              throw new Error('stale OAuth binding');
            }
          },
        );
        mockFlowManager.getFlowState.mockResolvedValue({
          status,
          type: 'mcp_oauth',
          metadata: staleMetadata,
          createdAt: Date.now(),
          ...(status === 'COMPLETED' && {
            completedAt: Date.now(),
            result: staleTokens,
          }),
        });
        mockMCPOAuthHandler.initiateOAuthFlow.mockResolvedValue({
          authorizationUrl: 'https://auth.example.com/fresh-authorize',
          flowId: 'fresh-flow',
          flowMetadata: {
            ...staleMetadata,
            serverUrl: currentConfig.url,
            state: 'fresh-state',
            authorizationUrl: 'https://auth.example.com/fresh-authorize',
            clientInfo: { client_id: 'fresh-dynamic-client' },
          },
        });
        mockFlowManager.createFlow.mockResolvedValue(freshTokens);

        const factory = new InspectableMCPConnectionFactory(
          { serverName: 'test-server', serverConfig: currentConfig },
          {
            useOAuth: true,
            user: mockUser,
            flowManager: mockFlowManager,
            oauthStart,
            tokenMethods: {
              findToken: jest.fn(),
              createToken: jest.fn(),
              replaceTokenIfCurrent: jest.fn(),
              updateToken: jest.fn(),
              deleteTokens: jest.fn(),
            },
          },
        );

        const result = await factory.handleOAuthRequiredForTest();

        expect(result?.tokens).toEqual(freshTokens);
        expect(result?.tokens).not.toEqual(staleTokens);
        expect(mockFlowManager.deleteFlow).toHaveBeenCalledWith('flow123', 'mcp_oauth');
        expect(mockMCPOAuthHandler.deleteStateMapping).toHaveBeenCalledWith(
          'stale-state',
          mockFlowManager,
        );
        expect(mockMCPOAuthHandler.initiateOAuthFlow).toHaveBeenCalled();
        expect(oauthStart).toHaveBeenCalledWith('https://auth.example.com/fresh-authorize');
        expect(oauthStart).not.toHaveBeenCalledWith(
          'https://auth.example.com/old-authorize',
          expect.anything(),
        );
      },
    );

    it('does not misclassify token storage failures as missing authorization', async () => {
      const basicOptions = {
        serverName: 'test-server',
        serverConfig: mockServerConfig,
      };

      const oauthOptions = {
        useOAuth: true as const,
        user: mockUser,
        flowManager: mockFlowManager,
        tokenMethods: {
          findToken: jest.fn(),
          createToken: jest.fn(),
          updateToken: jest.fn(),
          deleteTokens: jest.fn(),
        },
      };

      const storageError = new Error('OAuth token storage is unavailable for "test-server"');
      storageError.name = 'MCPTokenStorageUnavailableError';
      mockFlowManager.createFlowWithHandler.mockRejectedValue(storageError);
      await expect(MCPConnectionFactory.create(basicOptions, oauthOptions)).rejects.toThrow(
        'OAuth token storage is unavailable',
      );
      expect(mockMCPConnection).not.toHaveBeenCalled();
      expect(mockLogger.warn).toHaveBeenCalledWith(
        '[MCP][User: user123] OAuth token loading failed; deferring connection recovery',
      );
    });

    it('does not misclassify transient refresh failures as missing authorization', async () => {
      const basicOptions = {
        serverName: 'test-server',
        serverConfig: mockServerConfig,
      };
      const oauthOptions = {
        useOAuth: true as const,
        user: mockUser,
        flowManager: mockFlowManager,
        tokenMethods: {
          findToken: jest.fn(),
          createToken: jest.fn(),
          updateToken: jest.fn(),
          deleteTokens: jest.fn(),
        },
      };
      const refreshError = new Error(
        'OAuth token refresh is temporarily unavailable for "test-server"',
      );
      refreshError.name = 'MCPTokenRefreshUnavailableError';
      mockFlowManager.createFlowWithHandler.mockRejectedValue(refreshError);

      await expect(MCPConnectionFactory.create(basicOptions, oauthOptions)).rejects.toThrow(
        'OAuth token refresh is temporarily unavailable',
      );
      expect(mockMCPConnection).not.toHaveBeenCalled();
    });
  });

  describe('OAuth event handling', () => {
    beforeEach(() => {
      mockConnectionInstance.connect.mockRejectedValue(new Error('OAuth authentication required'));
    });

    it('should handle oauthRequired event for returnOnOAuth scenario', async () => {
      const basicOptions = {
        serverName: 'test-server',
        serverConfig: {
          ...mockServerConfig,
          url: 'https://api.example.com',
          type: 'sse' as const,
        } as t.SSEOptions,
      };

      const oauthOptions = {
        useOAuth: true as const,
        user: mockUser,
        flowManager: mockFlowManager,
        returnOnOAuth: true,
        oauthStart: jest.fn(),
        tokenMethods: {
          findToken: jest.fn(),
          createToken: jest.fn(),
          updateToken: jest.fn(),
          deleteTokens: jest.fn(),
        },
      };

      const mockFlowData = {
        authorizationUrl: 'https://auth.example.com',
        flowId: 'flow123',
        flowMetadata: {
          serverName: 'test-server',
          userId: 'user123',
          serverUrl: 'https://api.example.com',
          state: 'random-state',
          clientInfo: { client_id: 'client123' },
        },
      };

      (getTenantId as jest.Mock).mockReturnValue('test-tenant');

      mockMCPOAuthHandler.initiateOAuthFlow.mockResolvedValue(mockFlowData);
      // createFlow runs as a background monitor — simulate it staying pending
      mockFlowManager.createFlow.mockReturnValue(new Promise(() => {}));
      mockConnectionInstance.isConnected.mockResolvedValue(false);

      let oauthRequiredHandler: (data: Record<string, unknown>) => Promise<void>;
      mockConnectionInstance.on.mockImplementation((event, handler) => {
        if (event === 'oauthRequired') {
          oauthRequiredHandler = handler as (data: Record<string, unknown>) => Promise<void>;
        }
        return mockConnectionInstance;
      });

      try {
        await MCPConnectionFactory.create(basicOptions, oauthOptions);
      } catch {
        // Expected to fail due to connection not established
      }

      expect(oauthRequiredHandler!).toBeDefined();

      (getTenantId as jest.Mock).mockReturnValue(undefined);
      await oauthRequiredHandler!({ serverUrl: 'https://api.example.com' });

      expect(mockMCPOAuthHandler.initiateOAuthFlow).toHaveBeenCalledWith(
        'test-server',
        'https://api.example.com',
        'user123',
        {},
        undefined,
        undefined,
        oauthOptions.tokenMethods.findToken,
        undefined,
        'test-tenant',
      );

      // initFlow must be awaited BEFORE the redirect to guarantee state is stored
      expect(mockFlowManager.initFlow).toHaveBeenCalledWith(
        'flow123',
        'mcp_oauth',
        expect.objectContaining({ ...mockFlowData.flowMetadata, tenantId: 'test-tenant' }),
      );
      const initCallOrder = mockFlowManager.initFlow.mock.invocationCallOrder[0];
      const oauthStartCallOrder = (oauthOptions.oauthStart as jest.Mock).mock
        .invocationCallOrder[0];
      expect(initCallOrder).toBeLessThan(oauthStartCallOrder);

      expect(oauthOptions.oauthStart).toHaveBeenCalledWith('https://auth.example.com');
      expect(mockConnectionInstance.emit).toHaveBeenCalledWith(
        'oauthFailed',
        expect.objectContaining({
          message: 'OAuth flow initiated - return early',
        }),
      );
    });

    it('should clear stale client registration when returnOnOAuth flow fails with client rejection', async () => {
      const basicOptions = {
        serverName: 'test-server',
        serverConfig: {
          ...mockServerConfig,
          url: 'https://api.example.com',
          type: 'sse' as const,
        } as t.SSEOptions,
      };

      const deleteTokensSpy = jest.fn().mockResolvedValue({ acknowledged: true, deletedCount: 1 });
      const oauthOptions = {
        useOAuth: true as const,
        user: mockUser,
        flowManager: mockFlowManager,
        returnOnOAuth: true,
        oauthStart: jest.fn(),
        tokenMethods: {
          findToken: jest.fn(),
          createToken: jest.fn(),
          updateToken: jest.fn(),
          deleteTokens: deleteTokensSpy,
        },
      };

      const mockFlowData = {
        authorizationUrl: 'https://auth.example.com',
        flowId: 'flow123',
        flowMetadata: {
          serverName: 'test-server',
          userId: 'user123',
          serverUrl: 'https://api.example.com',
          state: 'random-state',
          clientInfo: { client_id: 'stale-client' },
          reusedStoredClient: true,
          reusedClientCredentialSetId: 'credential-generation-a',
        },
      };

      mockMCPOAuthHandler.initiateOAuthFlow.mockResolvedValue(mockFlowData);
      mockMCPTokenStorage.deleteClientRegistration.mockResolvedValue(undefined);
      // createFlow rejects with invalid_client — simulating stale client rejection
      mockFlowManager.createFlow.mockRejectedValue(new Error('invalid_client'));
      mockConnectionInstance.isConnected.mockResolvedValue(false);

      let oauthRequiredHandler: (data: Record<string, unknown>) => Promise<void>;
      mockConnectionInstance.on.mockImplementation((event, handler) => {
        if (event === 'oauthRequired') {
          oauthRequiredHandler = handler as (data: Record<string, unknown>) => Promise<void>;
        }
        return mockConnectionInstance;
      });

      try {
        await MCPConnectionFactory.create(basicOptions, oauthOptions);
      } catch {
        // Expected
      }

      await oauthRequiredHandler!({ serverUrl: 'https://api.example.com' });

      // Drain microtasks so the background .catch() handler completes
      await new Promise((r) => setImmediate(r));

      // deleteClientRegistration should have been called via clearStaleClientIfRejected
      expect(mockMCPTokenStorage.deleteClientRegistration).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'user123',
          serverName: 'test-server',
          credentialSetId: 'credential-generation-a',
        }),
      );
    });

    it('should re-issue the stored OAuth URL when a PENDING flow already exists (returnOnOAuth)', async () => {
      const basicOptions = {
        serverName: 'test-server',
        serverConfig: mockServerConfig,
        user: mockUser,
      };

      const oauthOptions: t.OAuthConnectionOptions = {
        user: mockUser,
        useOAuth: true,
        returnOnOAuth: true,
        oauthStart: jest.fn(),
        flowManager: mockFlowManager,
      };

      mockFlowManager.getFlowState.mockResolvedValue({
        status: 'PENDING',
        type: 'mcp_oauth',
        metadata: {
          codeVerifier: 'existing-verifier',
          authorizationUrl: 'https://auth.example.com/existing',
        },
        createdAt: Date.now(),
      });
      mockConnectionInstance.isConnected.mockResolvedValue(false);

      let oauthRequiredHandler: (data: Record<string, unknown>) => Promise<void>;
      mockConnectionInstance.on.mockImplementation((event, handler) => {
        if (event === 'oauthRequired') {
          oauthRequiredHandler = handler as (data: Record<string, unknown>) => Promise<void>;
        }
        return mockConnectionInstance;
      });

      try {
        await MCPConnectionFactory.create(basicOptions, oauthOptions);
      } catch {
        // Expected to fail
      }

      await oauthRequiredHandler!({ serverUrl: 'https://api.example.com' });

      expect(mockMCPOAuthHandler.initiateOAuthFlow).not.toHaveBeenCalled();
      expect(oauthOptions.oauthStart).toHaveBeenCalledWith(
        'https://auth.example.com/existing',
        expect.objectContaining({ expiresAt: expect.any(Number) }),
      );
      expect(mockFlowManager.deleteFlow).not.toHaveBeenCalled();
      expect(mockConnectionInstance.emit).toHaveBeenCalledWith(
        'oauthFailed',
        expect.objectContaining({ message: 'Pending OAuth flow reused - return early' }),
      );
    });

    it('should emit oauthFailed when a PENDING flow expires before replay (returnOnOAuth)', async () => {
      const createdAt = 1000;
      const firstNow = createdAt + PENDING_STALE_MS - 1;
      const expiredNow = createdAt + PENDING_STALE_MS;
      jest
        .spyOn(Date, 'now')
        .mockReturnValueOnce(firstNow)
        .mockReturnValueOnce(expiredNow)
        .mockReturnValue(expiredNow);

      const basicOptions = {
        serverName: 'test-server',
        serverConfig: mockServerConfig,
        user: mockUser,
      };

      const oauthOptions: t.OAuthConnectionOptions = {
        user: mockUser,
        useOAuth: true,
        returnOnOAuth: true,
        oauthStart: jest.fn(),
        flowManager: mockFlowManager,
      };

      mockFlowManager.getFlowState.mockResolvedValue({
        status: 'PENDING',
        type: 'mcp_oauth',
        metadata: {
          codeVerifier: 'existing-verifier',
          authorizationUrl: 'https://auth.example.com/existing',
        },
        createdAt,
      });
      mockConnectionInstance.isConnected.mockResolvedValue(false);

      let oauthRequiredHandler: (data: Record<string, unknown>) => Promise<void>;
      mockConnectionInstance.on.mockImplementation((event, handler) => {
        if (event === 'oauthRequired') {
          oauthRequiredHandler = handler as (data: Record<string, unknown>) => Promise<void>;
        }
        return mockConnectionInstance;
      });

      try {
        await MCPConnectionFactory.create(basicOptions, oauthOptions);
      } catch {
        // Expected to fail
      }

      await oauthRequiredHandler!({ serverUrl: 'https://api.example.com' });

      expect(oauthOptions.oauthStart).not.toHaveBeenCalled();
      expect(mockMCPOAuthHandler.initiateOAuthFlow).not.toHaveBeenCalled();
      expect(mockConnectionInstance.emit).toHaveBeenCalledWith(
        'oauthFailed',
        expect.objectContaining({ message: 'Pending OAuth flow expired before replay' }),
      );
    });

    it('should emit oauthFailed when initFlow fails to store flow state (returnOnOAuth)', async () => {
      const basicOptions = {
        serverName: 'test-server',
        serverConfig: {
          ...mockServerConfig,
          url: 'https://api.example.com',
          type: 'sse' as const,
        } as t.SSEOptions,
      };

      const oauthOptions = {
        useOAuth: true as const,
        user: mockUser,
        flowManager: mockFlowManager,
        returnOnOAuth: true,
        oauthStart: jest.fn(),
        tokenMethods: {
          findToken: jest.fn(),
          createToken: jest.fn(),
          updateToken: jest.fn(),
          deleteTokens: jest.fn(),
        },
      };

      const mockFlowData = {
        authorizationUrl: 'https://auth.example.com',
        flowId: 'flow123',
        flowMetadata: {
          serverName: 'test-server',
          userId: 'user123',
          serverUrl: 'https://api.example.com',
          state: 'state123',
        },
      };

      mockMCPOAuthHandler.initiateOAuthFlow.mockResolvedValue(mockFlowData);
      mockFlowManager.initFlow.mockRejectedValue(new Error('Store write failed'));
      mockConnectionInstance.isConnected.mockResolvedValue(false);

      let oauthRequiredHandler: (data: Record<string, unknown>) => Promise<void>;
      mockConnectionInstance.on.mockImplementation((event, handler) => {
        if (event === 'oauthRequired') {
          oauthRequiredHandler = handler as (data: Record<string, unknown>) => Promise<void>;
        }
        return mockConnectionInstance;
      });

      try {
        await MCPConnectionFactory.create(basicOptions, oauthOptions);
      } catch {
        // Expected to fail
      }

      await oauthRequiredHandler!({ serverUrl: 'https://api.example.com' });

      // initFlow failed, so oauthStart should NOT have been called (redirect never happens)
      expect(oauthOptions.oauthStart).not.toHaveBeenCalled();
      // createFlow should NOT have been called since initFlow failed first
      expect(mockFlowManager.createFlow).not.toHaveBeenCalled();
      expect(mockConnectionInstance.emit).toHaveBeenCalledWith(
        'oauthFailed',
        expect.objectContaining({ message: 'OAuth initiation failed' }),
      );
      expect(mockLogger.error).toHaveBeenCalled();
    });

    it('should log warnings when background createFlow monitor rejects (returnOnOAuth)', async () => {
      const basicOptions = {
        serverName: 'test-server',
        serverConfig: {
          ...mockServerConfig,
          url: 'https://api.example.com',
          type: 'sse' as const,
        } as t.SSEOptions,
      };

      const oauthOptions = {
        useOAuth: true as const,
        user: mockUser,
        flowManager: mockFlowManager,
        returnOnOAuth: true,
        oauthStart: jest.fn(),
        tokenMethods: {
          findToken: jest.fn(),
          createToken: jest.fn(),
          updateToken: jest.fn(),
          deleteTokens: jest.fn(),
        },
      };

      const mockFlowData = {
        authorizationUrl: 'https://auth.example.com',
        flowId: 'flow123',
        flowMetadata: {
          serverName: 'test-server',
          userId: 'user123',
          serverUrl: 'https://api.example.com',
          state: 'state123',
        },
      };

      mockMCPOAuthHandler.initiateOAuthFlow.mockResolvedValue(mockFlowData);
      // Simulate the background monitor timing out
      mockFlowManager.createFlow.mockRejectedValue(new Error('mcp_oauth flow timed out'));
      mockConnectionInstance.isConnected.mockResolvedValue(false);

      let oauthRequiredHandler: (data: Record<string, unknown>) => Promise<void>;
      mockConnectionInstance.on.mockImplementation((event, handler) => {
        if (event === 'oauthRequired') {
          oauthRequiredHandler = handler as (data: Record<string, unknown>) => Promise<void>;
        }
        return mockConnectionInstance;
      });

      try {
        await MCPConnectionFactory.create(basicOptions, oauthOptions);
      } catch {
        // Expected to fail
      }

      await oauthRequiredHandler!({ serverUrl: 'https://api.example.com' });

      // Allow the .catch handler on createFlow to execute
      await Promise.resolve();

      // initFlow should have succeeded and redirect should have happened
      expect(mockFlowManager.initFlow).toHaveBeenCalled();
      expect(oauthOptions.oauthStart).toHaveBeenCalledWith('https://auth.example.com');
      // The background monitor error should be logged, not silently swallowed
      expect(mockLogger.debug).toHaveBeenCalledWith(
        '[MCP][User: user123] OAuth flow monitor ended',
      );
      expect(JSON.stringify(mockLogger.debug.mock.calls)).not.toContain('mcp_oauth flow timed out');
    });

    it('should call initFlow before createFlow in blocking OAuth path (non-returnOnOAuth)', async () => {
      const sseConfig = {
        ...mockServerConfig,
        url: 'https://api.example.com',
        type: 'sse' as const,
      } as t.SSEOptions;

      const basicOptions = {
        serverName: 'test-server',
        serverConfig: sseConfig,
      };

      const oauthOptions = {
        useOAuth: true as const,
        user: mockUser,
        flowManager: mockFlowManager,
        oauthStart: jest.fn(),
        oauthEnd: jest.fn(),
        tokenMethods: {
          findToken: jest.fn(),
          createToken: jest.fn(),
          updateToken: jest.fn(),
          deleteTokens: jest.fn(),
        },
      };

      const mockFlowData = {
        authorizationUrl: 'https://auth.example.com',
        flowId: 'flow123',
        flowMetadata: {
          serverName: 'test-server',
          userId: 'user123',
          serverUrl: 'https://api.example.com',
          state: 'random-state',
          clientInfo: { client_id: 'client123' },
          metadata: {
            token_endpoint: 'https://auth.example.com/token',
            authorization_endpoint: 'https://auth.example.com/authorize',
          },
        },
      };

      const mockTokens: MCPOAuthTokens = {
        access_token: 'access123',
        refresh_token: 'refresh123',
        token_type: 'Bearer',
        obtained_at: Date.now(),
        credential_set_id: 'blocking-callback-generation',
      };

      // processMCPEnv must return config with url so handleOAuthRequired proceeds
      mockProcessMCPEnv.mockReturnValue(sseConfig);
      (getTenantId as jest.Mock).mockReturnValue('test-tenant');
      mockMCPOAuthHandler.initiateOAuthFlow.mockResolvedValue(mockFlowData);
      mockMCPOAuthHandler.generateFlowId.mockReturnValue('flow123');
      mockFlowManager.getFlowState.mockResolvedValue(null);
      mockFlowManager.createFlow.mockResolvedValue(mockTokens);
      mockConnectionInstance.isConnected.mockResolvedValue(false);

      let oauthRequiredHandler: (data: Record<string, unknown>) => Promise<void>;
      mockConnectionInstance.on.mockImplementation((event, handler) => {
        if (event === 'oauthRequired') {
          oauthRequiredHandler = handler as (data: Record<string, unknown>) => Promise<void>;
        }
        return mockConnectionInstance;
      });

      try {
        await MCPConnectionFactory.create(basicOptions, oauthOptions);
      } catch {
        // Expected to fail
      }

      (getTenantId as jest.Mock).mockReturnValue(undefined);
      await oauthRequiredHandler!({ serverUrl: 'https://api.example.com' });

      // initFlow must be called BEFORE oauthStart and createFlow
      expect(mockFlowManager.initFlow).toHaveBeenCalledWith(
        'flow123',
        'mcp_oauth',
        expect.objectContaining({ ...mockFlowData.flowMetadata, tenantId: 'test-tenant' }),
      );
      const initCallOrder = mockFlowManager.initFlow.mock.invocationCallOrder[0];
      const oauthStartCallOrder = (oauthOptions.oauthStart as jest.Mock).mock
        .invocationCallOrder[0];
      const createCallOrder = mockFlowManager.createFlow.mock.invocationCallOrder[0];
      expect(initCallOrder).toBeLessThan(oauthStartCallOrder);
      expect(initCallOrder).toBeLessThan(createCallOrder);

      // createFlow should receive {} since initFlow already persisted metadata
      expect(mockFlowManager.createFlow).toHaveBeenCalledWith(
        'flow123',
        'mcp_oauth',
        {},
        undefined,
        false,
      );
    });

    it('should delete stale flow and create new OAuth flow when existing flow is COMPLETED', async () => {
      const basicOptions = {
        serverName: 'test-server',
        serverConfig: mockServerConfig,
        user: mockUser,
      };

      const oauthOptions: t.OAuthConnectionOptions = {
        user: mockUser,
        useOAuth: true,
        returnOnOAuth: true,
        oauthStart: jest.fn(),
        flowManager: mockFlowManager,
      };

      const mockFlowData = {
        authorizationUrl: 'https://auth.example.com',
        flowId: 'user123:test-server',
        flowMetadata: {
          serverName: 'test-server',
          userId: 'user123',
          serverUrl: 'https://api.example.com',
          state: 'test-state',
          codeVerifier: 'new-code-verifier-xyz',
          clientInfo: { client_id: 'test-client' },
          metadata: {
            authorization_endpoint: 'https://auth.example.com/authorize',
            token_endpoint: 'https://auth.example.com/token',
            issuer: 'https://api.example.com',
          },
        },
      };

      mockFlowManager.getFlowState.mockResolvedValue({
        status: 'COMPLETED',
        type: 'mcp_oauth',
        metadata: { codeVerifier: 'old-verifier' },
        createdAt: Date.now() - 60000,
      });
      mockMCPOAuthHandler.initiateOAuthFlow.mockResolvedValue(mockFlowData);
      mockFlowManager.deleteFlow.mockResolvedValue(true);
      // createFlow runs as a background monitor — simulate it staying pending
      mockFlowManager.createFlow.mockReturnValue(new Promise(() => {}));
      mockConnectionInstance.isConnected.mockResolvedValue(false);

      let oauthRequiredHandler: (data: Record<string, unknown>) => Promise<void>;
      mockConnectionInstance.on.mockImplementation((event, handler) => {
        if (event === 'oauthRequired') {
          oauthRequiredHandler = handler as (data: Record<string, unknown>) => Promise<void>;
        }
        return mockConnectionInstance;
      });

      try {
        await MCPConnectionFactory.create(basicOptions, oauthOptions);
      } catch {
        // Expected to fail
      }

      await oauthRequiredHandler!({ serverUrl: 'https://api.example.com' });

      expect(mockFlowManager.deleteFlow).toHaveBeenCalledWith('user123:test-server', 'mcp_oauth');

      // initFlow must be called after deleteFlow and before createFlow
      const deleteCallOrder = mockFlowManager.deleteFlow.mock.invocationCallOrder[0];
      const initCallOrder = mockFlowManager.initFlow.mock.invocationCallOrder[0];
      const createCallOrder = mockFlowManager.createFlow.mock.invocationCallOrder[0];
      expect(deleteCallOrder).toBeLessThan(initCallOrder);
      expect(initCallOrder).toBeLessThan(createCallOrder);

      expect(mockFlowManager.initFlow).toHaveBeenCalledWith(
        'user123:test-server',
        'mcp_oauth',
        expect.objectContaining({
          codeVerifier: 'new-code-verifier-xyz',
        }),
      );

      // createFlow finds the existing PENDING state written by initFlow,
      // so metadata arg is unused (passed as {})
      expect(mockFlowManager.createFlow).toHaveBeenCalledWith(
        'user123:test-server',
        'mcp_oauth',
        {},
        undefined,
        false,
      );
    });

    it('should silently refresh tokens on oauthRequired without invoking interactive flow', async () => {
      const sseConfig = {
        ...mockServerConfig,
        url: 'https://api.example.com',
        type: 'sse' as const,
      } as t.SSEOptions;

      const basicOptions = {
        serverName: 'test-server',
        serverConfig: sseConfig,
      };

      const oauthOptions = {
        useOAuth: true as const,
        user: mockUser,
        flowManager: mockFlowManager,
        oauthStart: jest.fn(),
        tokenMethods: {
          findToken: jest.fn(),
          createToken: jest.fn(),
          updateToken: jest.fn(),
          deleteTokens: jest.fn(),
        },
      };

      const refreshedTokens: MCPOAuthTokens = {
        access_token: 'refreshed-access',
        refresh_token: 'refresh123',
        token_type: 'Bearer',
        obtained_at: Date.now(),
      };

      mockProcessMCPEnv.mockReturnValue(sseConfig);
      mockMCPOAuthHandler.generateFlowId.mockReturnValue('flow123');
      // The silent refresh path: createFlowWithHandler executes the handler
      // (which calls forceRefreshTokens) and returns the refreshed tokens.
      mockFlowManager.createFlowWithHandler.mockImplementation(async (_flowId, type, handler) => {
        if (type === 'mcp_get_tokens') {
          return handler();
        }
        return null;
      });
      mockMCPTokenStorage.forceRefreshTokens.mockResolvedValueOnce(refreshedTokens);
      mockConnectionInstance.isConnected.mockResolvedValue(false);

      let oauthRequiredHandler: (data: Record<string, unknown>) => Promise<void>;
      mockConnectionInstance.on.mockImplementation((event, handler) => {
        if (event === 'oauthRequired') {
          oauthRequiredHandler = handler as (data: Record<string, unknown>) => Promise<void>;
        }
        return mockConnectionInstance;
      });

      try {
        await MCPConnectionFactory.create(basicOptions, oauthOptions);
      } catch {
        // Expected to fail because connection itself is mocked as not connected
      }

      await oauthRequiredHandler!({ serverUrl: 'https://api.example.com' });

      expect(mockMCPTokenStorage.forceRefreshTokens).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'user123',
          serverName: 'test-server',
          findToken: oauthOptions.tokenMethods.findToken,
          createToken: oauthOptions.tokenMethods.createToken,
        }),
      );
      expect(mockConnectionInstance.setOAuthTokens).toHaveBeenCalledWith(refreshedTokens);
      expect(mockConnectionInstance.emit).toHaveBeenCalledWith('oauthHandled', 'silent-refresh');
      // Silent refresh succeeded — interactive flow must NOT be initiated.
      expect(mockMCPOAuthHandler.initiateOAuthFlow).not.toHaveBeenCalled();
    });

    it('suppresses interactive OAuth during teardown, then falls back after release', async () => {
      const sseConfig = {
        ...mockServerConfig,
        url: 'https://api.example.com',
        type: 'sse' as const,
      } as t.SSEOptions;

      const basicOptions = {
        serverName: 'test-server',
        serverConfig: sseConfig,
      };

      const oauthOptions = {
        useOAuth: true as const,
        user: mockUser,
        flowManager: mockFlowManager,
        oauthStart: jest.fn(),
        oauthEnd: jest.fn(),
        tokenMethods: {
          findToken: jest.fn(),
          createToken: jest.fn(),
          updateToken: jest.fn(),
          deleteTokens: jest.fn(),
        },
      };

      const mockFlowData = {
        authorizationUrl: 'https://auth.example.com',
        flowId: 'flow123',
        flowMetadata: {
          serverName: 'test-server',
          userId: 'user123',
          serverUrl: 'https://api.example.com',
          state: 'random-state',
        },
      };

      const interactiveTokens: MCPOAuthTokens = {
        access_token: 'interactive-access',
        token_type: 'Bearer',
        obtained_at: Date.now(),
        credential_set_id: 'interactive-generation',
      };

      mockProcessMCPEnv.mockReturnValue(sseConfig);
      mockMCPOAuthHandler.generateFlowId.mockReturnValue('flow123');
      // Silent refresh attempt returns null (no refresh token / refresh failed).
      mockFlowManager.createFlowWithHandler.mockImplementation(async (_flowId, type, handler) => {
        if (type === 'mcp_get_tokens') {
          return handler();
        }
        return null;
      });
      mockMCPTokenStorage.forceRefreshTokens.mockResolvedValueOnce(null);
      mockMCPOAuthHandler.initiateOAuthFlow.mockResolvedValue(mockFlowData);
      mockFlowManager.getFlowState.mockResolvedValue(null);
      mockFlowManager.createFlow.mockResolvedValue(interactiveTokens);
      mockConnectionInstance.isConnected.mockResolvedValue(false);

      let oauthRequiredHandler: (data: Record<string, unknown>) => Promise<void>;
      mockConnectionInstance.on.mockImplementation((event, handler) => {
        if (event === 'oauthRequired') {
          oauthRequiredHandler = handler as (data: Record<string, unknown>) => Promise<void>;
        }
        return mockConnectionInstance;
      });

      try {
        await MCPConnectionFactory.create(basicOptions, oauthOptions);
      } catch {
        // Expected to fail
      }

      mockMCPTokenStorage.isRefreshTeardownActive.mockReturnValue(true);
      await oauthRequiredHandler!({ serverUrl: 'https://api.example.com' });

      expect(mockMCPOAuthHandler.initiateOAuthFlow).not.toHaveBeenCalled();

      mockMCPTokenStorage.isRefreshTeardownActive.mockReturnValue(false);
      await oauthRequiredHandler!({ serverUrl: 'https://api.example.com' });

      // Silent refresh was attempted, but yielded no tokens.
      expect(mockMCPTokenStorage.forceRefreshTokens).toHaveBeenCalled();
      // Fall-through behavior: interactive flow runs.
      expect(mockMCPOAuthHandler.initiateOAuthFlow).toHaveBeenCalled();
      expect(mockConnectionInstance.setOAuthTokens).toHaveBeenCalledWith(interactiveTokens);
    });

    it('should silently refresh tokens for returnOnOAuth path without redirecting', async () => {
      const basicOptions = {
        serverName: 'test-server',
        serverConfig: {
          ...mockServerConfig,
          url: 'https://api.example.com',
          type: 'sse' as const,
        } as t.SSEOptions,
      };

      const oauthOptions = {
        useOAuth: true as const,
        user: mockUser,
        flowManager: mockFlowManager,
        returnOnOAuth: true,
        oauthStart: jest.fn(),
        tokenMethods: {
          findToken: jest.fn(),
          createToken: jest.fn(),
          updateToken: jest.fn(),
          deleteTokens: jest.fn(),
        },
      };

      const refreshedTokens: MCPOAuthTokens = {
        access_token: 'refreshed-access',
        refresh_token: 'refresh123',
        token_type: 'Bearer',
        obtained_at: Date.now(),
      };

      mockMCPOAuthHandler.generateFlowId.mockReturnValue('flow123');
      mockFlowManager.createFlowWithHandler.mockImplementation(async (_flowId, type, handler) => {
        if (type === 'mcp_get_tokens') {
          return handler();
        }
        return null;
      });
      mockMCPTokenStorage.forceRefreshTokens.mockResolvedValueOnce(refreshedTokens);
      mockConnectionInstance.isConnected.mockResolvedValue(false);

      let oauthRequiredHandler: (data: Record<string, unknown>) => Promise<void>;
      mockConnectionInstance.on.mockImplementation((event, handler) => {
        if (event === 'oauthRequired') {
          oauthRequiredHandler = handler as (data: Record<string, unknown>) => Promise<void>;
        }
        return mockConnectionInstance;
      });

      try {
        await MCPConnectionFactory.create(basicOptions, oauthOptions);
      } catch {
        // Expected
      }

      await oauthRequiredHandler!({ serverUrl: 'https://api.example.com' });

      expect(mockConnectionInstance.setOAuthTokens).toHaveBeenCalledWith(refreshedTokens);
      expect(mockConnectionInstance.emit).toHaveBeenCalledWith('oauthHandled', 'silent-refresh');
      // returnOnOAuth interactive path must NOT trigger when silent refresh succeeds.
      expect(mockMCPOAuthHandler.initiateOAuthFlow).not.toHaveBeenCalled();
      expect(oauthOptions.oauthStart).not.toHaveBeenCalled();
    });

    describe('when the server rejects the tokens a silent refresh issued', () => {
      const renewedTokens: MCPOAuthTokens = {
        access_token: 'renewed-access',
        refresh_token: 'refresh123',
        token_type: 'Bearer',
        obtained_at: Date.now(),
        credential_set_id: 'grant-1',
      };
      const challenge = {
        serverUrl: 'https://api.example.com',
        rejectedCredentialSetId: 'grant-1',
      };

      async function captureEstablishmentHandler(oauthStart: jest.Mock) {
        let oauthRequiredHandler: ((data: Record<string, unknown>) => Promise<void>) | undefined;
        mockConnectionInstance.on.mockImplementation((event, handler) => {
          if (event === 'oauthRequired') {
            oauthRequiredHandler = handler as (data: Record<string, unknown>) => Promise<void>;
          }
          return mockConnectionInstance;
        });
        mockConnectionInstance.isConnected.mockResolvedValue(false);
        mockMCPOAuthHandler.generateFlowId.mockReturnValue('flow123');
        mockMCPTokenStorage.forceRefreshTokens.mockResolvedValue(renewedTokens);
        mockMCPOAuthHandler.initiateOAuthFlow.mockResolvedValue({
          authorizationUrl: 'https://auth.example.com',
          flowId: 'flow123',
          flowMetadata: {
            serverName: 'test-server',
            userId: 'user123',
            serverUrl: 'https://api.example.com',
            state: 'random-state',
          },
        });
        mockFlowManager.getFlowState.mockResolvedValue(null);
        mockFlowManager.createFlow.mockReturnValue(new Promise(() => {}));

        try {
          await MCPConnectionFactory.create(
            {
              serverName: 'test-server',
              serverConfig: {
                ...mockServerConfig,
                url: 'https://api.example.com',
                type: 'sse' as const,
              } as t.SSEOptions,
            },
            {
              useOAuth: true,
              user: mockUser,
              flowManager: mockFlowManager,
              returnOnOAuth: true,
              oauthStart,
              tokenMethods: {
                findToken: jest.fn(),
                createToken: jest.fn(),
                replaceTokenIfCurrent: jest.fn(),
                updateToken: jest.fn(),
                deleteTokens: jest.fn(),
              },
            },
          );
        } catch {
          // Expected: the mocked connection never reports connected
        }
        return oauthRequiredHandler!;
      }

      it('starts interactive OAuth instead of refreshing the rejected renewal again', async () => {
        const oauthStart = jest.fn();
        const handler = await captureEstablishmentHandler(oauthStart);

        await handler(challenge);
        await handler(challenge);

        expect(mockMCPTokenStorage.forceRefreshTokens).toHaveBeenCalledTimes(1);
        expect(mockMCPTokenStorage.markAuthorizationRejected).toHaveBeenCalledWith(
          expect.objectContaining({ credentialSetId: 'grant-1' }),
        );
        expect(mockMCPTokenStorage.isCurrentAccessToken).toHaveBeenCalledWith(
          expect.objectContaining({ accessToken: 'renewed-access', credentialSetId: 'grant-1' }),
        );
        expect(mockConnectionInstance.emit).toHaveBeenCalledWith('oauthHandled', 'silent-refresh');
        expect(oauthStart).toHaveBeenCalledWith('https://auth.example.com');
        expect(mockConnectionInstance.emit).toHaveBeenCalledWith(
          'oauthFailed',
          expect.objectContaining({ message: 'OAuth flow initiated - return early' }),
        );
      });

      it('refreshes again when another request replaced the renewal', async () => {
        const oauthStart = jest.fn();
        const handler = await captureEstablishmentHandler(oauthStart);
        mockMCPTokenStorage.isCurrentAccessToken.mockResolvedValue(false);

        await handler(challenge);
        await handler(challenge);

        expect(mockMCPTokenStorage.forceRefreshTokens).toHaveBeenCalledTimes(2);
        expect(mockMCPOAuthHandler.initiateOAuthFlow).not.toHaveBeenCalled();
        expect(oauthStart).not.toHaveBeenCalled();
      });

      it('refreshes a credential set the renewal did not issue', async () => {
        const oauthStart = jest.fn();
        const handler = await captureEstablishmentHandler(oauthStart);

        await handler(challenge);
        await handler({ ...challenge, rejectedCredentialSetId: 'grant-2' });

        expect(mockMCPTokenStorage.forceRefreshTokens).toHaveBeenCalledTimes(2);
        expect(oauthStart).not.toHaveBeenCalled();
      });
    });

    it('should fall back to interactive OAuth when silent refresh throws unexpectedly', async () => {
      const sseConfig = {
        ...mockServerConfig,
        url: 'https://api.example.com',
        type: 'sse' as const,
      } as t.SSEOptions;

      const basicOptions = {
        serverName: 'test-server',
        serverConfig: sseConfig,
      };

      const oauthOptions = {
        useOAuth: true as const,
        user: mockUser,
        flowManager: mockFlowManager,
        oauthStart: jest.fn(),
        oauthEnd: jest.fn(),
        tokenMethods: {
          findToken: jest.fn(),
          createToken: jest.fn(),
          updateToken: jest.fn(),
          deleteTokens: jest.fn(),
        },
      };

      const mockFlowData = {
        authorizationUrl: 'https://auth.example.com',
        flowId: 'flow123',
        flowMetadata: {
          serverName: 'test-server',
          userId: 'user123',
          serverUrl: 'https://api.example.com',
          state: 'random-state',
        },
      };

      mockProcessMCPEnv.mockReturnValue(sseConfig);
      mockMCPOAuthHandler.generateFlowId.mockReturnValue('flow123');
      // Silent refresh path throws — must be swallowed and interactive runs.
      mockMCPTokenStorage.forceRefreshTokens.mockRejectedValueOnce(new Error('refresh boom'));
      mockMCPOAuthHandler.initiateOAuthFlow.mockResolvedValue(mockFlowData);
      mockFlowManager.getFlowState.mockResolvedValue(null);
      mockFlowManager.createFlow.mockResolvedValue({
        access_token: 'fallback-access',
        token_type: 'Bearer',
        obtained_at: Date.now(),
      } as MCPOAuthTokens);
      mockConnectionInstance.isConnected.mockResolvedValue(false);

      let oauthRequiredHandler: (data: Record<string, unknown>) => Promise<void>;
      mockConnectionInstance.on.mockImplementation((event, handler) => {
        if (event === 'oauthRequired') {
          oauthRequiredHandler = handler as (data: Record<string, unknown>) => Promise<void>;
        }
        return mockConnectionInstance;
      });

      try {
        await MCPConnectionFactory.create(basicOptions, oauthOptions);
      } catch {
        // Expected
      }

      await oauthRequiredHandler!({ serverUrl: 'https://api.example.com' });

      // The thrown silent refresh error must be swallowed and the interactive
      // flow used as a fallback so the user is never stuck.
      expect(mockMCPOAuthHandler.initiateOAuthFlow).toHaveBeenCalled();
    });

    it('defers instead of prompting when another replica holds the refresh', async () => {
      const sseConfig = {
        ...mockServerConfig,
        url: 'https://api.example.com',
        type: 'sse' as const,
      } as t.SSEOptions;

      const basicOptions = { serverName: 'test-server', serverConfig: sseConfig };
      const oauthOptions = {
        useOAuth: true as const,
        user: mockUser,
        flowManager: mockFlowManager,
        oauthStart: jest.fn(),
        oauthEnd: jest.fn(),
        tokenMethods: {
          findToken: jest.fn(),
          createToken: jest.fn(),
          updateToken: jest.fn(),
          deleteTokens: jest.fn(),
        },
      };

      mockProcessMCPEnv.mockReturnValue(sseConfig);
      mockMCPOAuthHandler.generateFlowId.mockReturnValue('flow123');
      /** Named rather than constructed, because these errors cross the built package boundary. */
      const contended = new Error(
        'OAuth token refresh is temporarily unavailable for "test-server"',
      );
      contended.name = 'MCPTokenRefreshUnavailableError';
      mockMCPTokenStorage.forceRefreshTokens.mockRejectedValueOnce(contended);
      mockFlowManager.getFlowState.mockResolvedValue(null);
      mockConnectionInstance.isConnected.mockResolvedValue(false);

      let oauthRequiredHandler: (data: Record<string, unknown>) => Promise<void>;
      mockConnectionInstance.on.mockImplementation((event, handler) => {
        if (event === 'oauthRequired') {
          oauthRequiredHandler = handler as (data: Record<string, unknown>) => Promise<void>;
        }
        return mockConnectionInstance;
      });

      try {
        await MCPConnectionFactory.create(basicOptions, oauthOptions);
      } catch {
        // Expected
      }

      await oauthRequiredHandler!({ serverUrl: 'https://api.example.com' });

      /**
       * A peer redeeming this credential is not a reason to ask the user to authorize the server
       * again: its rotation is about to land and the next request adopts it. Prompting here is the
       * outcome the cross-replica flight exists to prevent, so the connection defers instead.
       */
      expect(mockMCPOAuthHandler.initiateOAuthFlow).not.toHaveBeenCalled();
      expect(oauthOptions.oauthStart).not.toHaveBeenCalled();
      expect(mockConnectionInstance.emit).toHaveBeenCalledWith('oauthFailed', contended);
    });

    it('retries silent recovery after contention without spending the interactive phase', async () => {
      const factory = new InspectableMCPConnectionFactory(
        {
          serverName: 'test-server',
          serverConfig: { type: 'sse', url: 'https://api.example.com' },
        },
        {
          useOAuth: true,
          user: mockUser,
          flowManager: mockFlowManager,
          tokenMethods: {
            findToken: jest.fn(),
            createToken: jest.fn(),
            replaceTokenIfCurrent: jest.fn(),
            updateToken: jest.fn(),
            deleteTokens: jest.fn(),
          },
        },
      );
      let handler!: (data: Record<string, unknown>) => Promise<void>;
      mockConnectionInstance.on.mockImplementation((event, listener) => {
        if (event === 'oauthReauthenticationRequired') handler = listener as typeof handler;
        return mockConnectionInstance;
      });
      factory.bindRequestRecoveryForTest(mockConnectionInstance);
      const unavailable = Object.assign(new Error('retry'), {
        name: 'MCPTokenRefreshUnavailableError',
      });
      const tokens = { access_token: 'fresh', token_type: 'Bearer', obtained_at: Date.now() };
      mockMCPTokenStorage.forceRefreshTokens
        .mockRejectedValueOnce(unavailable)
        .mockResolvedValueOnce(tokens);
      await handler({ serverUrl: 'https://api.example.com' });
      await handler({
        serverUrl: 'https://api.example.com',
        rejectedCredentialSetId: null,
      });
      expect(mockMCPTokenStorage.forceRefreshTokens).toHaveBeenCalledTimes(2);
      expect(mockMCPTokenStorage.forceRefreshTokens).toHaveBeenCalledWith(
        expect.objectContaining({ rejectedCredentialSetId: 'rejected-generation' }),
      );
      expect(mockMCPTokenStorage.forceRefreshTokens).toHaveBeenLastCalledWith(
        expect.objectContaining({ rejectedCredentialSetId: null }),
      );
      expect(mockConnectionInstance.setOAuthTokens).toHaveBeenCalledWith(tokens);
      expect(mockMCPOAuthHandler.initiateOAuthFlow).not.toHaveBeenCalled();
    });

    it('should bypass any flow cache on silent refresh and invalidate mcp_get_tokens cache (regression for stale cached token reuse)', async () => {
      // Reproduces the cache-collision flagged by Codex on PR #13369: when an
      // earlier `getOAuthTokens` call cached its (now server-rejected) tokens
      // under the `mcp_get_tokens` flow, the silent refresh must NOT share or
      // reuse that cache. The fix bypasses `FlowStateManager` entirely for the
      // force-refresh, calls `MCPTokenStorage.forceRefreshTokens` directly,
      // and invalidates the `mcp_get_tokens` cache afterwards so the next
      // `getOAuthTokens` reads the freshly persisted tokens.
      const sseConfig = {
        ...mockServerConfig,
        url: 'https://api.example.com',
        type: 'sse' as const,
      } as t.SSEOptions;

      const basicOptions = {
        serverName: 'test-server',
        serverConfig: sseConfig,
      };

      const onOAuthCredentialsChanged = jest.fn().mockResolvedValue(undefined);
      const oauthOptions = {
        useOAuth: true as const,
        user: mockUser,
        flowManager: mockFlowManager,
        oauthStart: jest.fn(),
        onOAuthCredentialsChanged,
        tokenMethods: {
          findToken: jest.fn(),
          createToken: jest.fn(),
          updateToken: jest.fn(),
          deleteTokens: jest.fn(),
        },
      };

      const staleCachedTokens: MCPOAuthTokens = {
        access_token: 'stale-cached-access',
        refresh_token: 'refresh123',
        token_type: 'Bearer',
        obtained_at: Date.now(),
      };

      const freshlyRefreshedTokens: MCPOAuthTokens = {
        access_token: 'freshly-refreshed-access',
        refresh_token: 'refresh456',
        token_type: 'Bearer',
        obtained_at: Date.now(),
      };

      mockProcessMCPEnv.mockReturnValue(sseConfig);
      mockMCPOAuthHandler.generateFlowId.mockReturnValue('flow123');
      // Simulate the real FlowStateManager cache behavior for `mcp_get_tokens`:
      // a prior call cached `staleCachedTokens` and the cache is still
      // non-expired, so `getOAuthTokens` returns it without re-running the
      // handler. Silent refresh must NOT route through this cached flow.
      mockFlowManager.createFlowWithHandler.mockImplementation(async (_flowId, type, _handler) => {
        if (type === 'mcp_get_tokens') {
          return staleCachedTokens;
        }
        return null;
      });
      // `invalidateGetTokensFlow` only deletes COMPLETED states (to avoid
      // breaking concurrent PENDING joiners), so reflect that here.
      mockFlowManager.getFlowState.mockResolvedValue({
        status: 'COMPLETED' as const,
        type: 'mcp_get_tokens',
        metadata: {},
        createdAt: Date.now(),
        completedAt: Date.now(),
        result: staleCachedTokens,
      });
      // Mirror the real storage contract: `onRefreshSuccess` runs inside the
      // shared redemption after the rotated tokens are persisted.
      mockMCPTokenStorage.forceRefreshTokens.mockImplementationOnce(async (params) => {
        await params.onRefreshSuccess?.(freshlyRefreshedTokens);
        return freshlyRefreshedTokens;
      });
      mockConnectionInstance.isConnected.mockResolvedValue(false);

      let oauthRequiredHandler: (data: Record<string, unknown>) => Promise<void>;
      mockConnectionInstance.on.mockImplementation((event, handler) => {
        if (event === 'oauthRequired') {
          oauthRequiredHandler = handler as (data: Record<string, unknown>) => Promise<void>;
        }
        return mockConnectionInstance;
      });

      try {
        await MCPConnectionFactory.create(basicOptions, oauthOptions);
      } catch {
        // Expected
      }

      await oauthRequiredHandler!({ serverUrl: 'https://api.example.com' });

      // The refresh runs against the token storage directly — not through any
      // `createFlowWithHandler` flow that could return a stale cached value.
      expect(mockMCPTokenStorage.forceRefreshTokens).toHaveBeenCalled();
      expect(mockFlowManager.createFlowWithHandler).not.toHaveBeenCalledWith(
        expect.anything(),
        'mcp_force_refresh_tokens',
        expect.anything(),
        expect.anything(),
      );
      // The connection receives the FRESHLY refreshed tokens, NOT the stale
      // cached ones — that's the whole point of the fix.
      expect(mockConnectionInstance.setOAuthTokens).toHaveBeenCalledWith(freshlyRefreshedTokens);
      expect(onOAuthCredentialsChanged).toHaveBeenCalledWith({
        userId: mockUser!.id,
        serverName: 'test-server',
      });
      expect(mockConnectionInstance.setOAuthTokens).not.toHaveBeenCalledWith(staleCachedTokens);
      expect(mockConnectionInstance.emit).toHaveBeenCalledWith('oauthHandled', 'silent-refresh');
      // The cached `mcp_get_tokens` flow state is dropped so the next
      // `getOAuthTokens` call reads the freshly persisted tokens from storage.
      expect(mockFlowManager.deleteFlow).toHaveBeenCalledWith('flow123', 'mcp_get_tokens');
    });

    it('completes a pending token flow with the generation its silent refresh published', async () => {
      const sseConfig = {
        ...mockServerConfig,
        url: 'https://api.example.com',
        type: 'sse' as const,
      } as t.SSEOptions;
      const staleCachedTokens: MCPOAuthTokens = {
        access_token: 'stale-cached-access',
        refresh_token: 'refresh123',
        token_type: 'Bearer',
        obtained_at: Date.now(),
      };
      const freshlyRefreshedTokens: MCPOAuthTokens = {
        access_token: 'freshly-refreshed-access',
        refresh_token: 'refresh456',
        token_type: 'Bearer',
        obtained_at: Date.now(),
      };

      mockProcessMCPEnv.mockReturnValue(sseConfig);
      mockMCPOAuthHandler.generateFlowId.mockReturnValue('flow123');
      mockFlowManager.createFlowWithHandler.mockImplementation(async (_flowId, type) =>
        type === 'mcp_get_tokens' ? staleCachedTokens : null,
      );
      mockFlowManager.getFlowState.mockResolvedValue({
        status: 'PENDING' as const,
        type: 'mcp_get_tokens',
        metadata: {},
        createdAt: Date.now(),
      });
      mockMCPTokenStorage.forceRefreshTokens.mockImplementationOnce(async (params) => {
        const commitRefresh = await params.onRefreshPreparing?.();
        await commitRefresh?.(freshlyRefreshedTokens);
        return freshlyRefreshedTokens;
      });
      mockConnectionInstance.isConnected.mockResolvedValue(false);

      let oauthRequiredHandler: (data: Record<string, unknown>) => Promise<void>;
      mockConnectionInstance.on.mockImplementation((event, handler) => {
        if (event === 'oauthRequired') {
          oauthRequiredHandler = handler as (data: Record<string, unknown>) => Promise<void>;
        }
        return mockConnectionInstance;
      });

      try {
        await MCPConnectionFactory.create(
          { serverName: 'test-server', serverConfig: sseConfig },
          {
            useOAuth: true as const,
            user: mockUser,
            flowManager: mockFlowManager,
            oauthStart: jest.fn(),
            onOAuthCredentialsChanging: async () => async () => 'generation-b',
            tokenMethods: {
              findToken: jest.fn(),
              createToken: jest.fn(),
              replaceTokenIfCurrent: jest.fn(),
              updateToken: jest.fn(),
              deleteTokens: jest.fn(),
            },
          },
        );
      } catch {
        // Expected: the connection rejects until the refresh runs below
      }

      await oauthRequiredHandler!({ serverUrl: 'https://api.example.com' });

      expect(mockFlowManager.completeFlow).toHaveBeenCalledWith('flow123', 'mcp_get_tokens', {
        ...freshlyRefreshedTokens,
        publication_generation: 'generation-b',
      });
      expect(mockConnectionInstance.setOAuthTokens).toHaveBeenCalledWith(freshlyRefreshedTokens);
      expect(mockConnectionInstance.emit).toHaveBeenCalledWith('oauthHandled', 'silent-refresh');
    });

    it('should coalesce concurrent silent refresh attempts into a single redemption', async () => {
      // Reproduces the concurrent-redemption race flagged by Codex on PR #13369:
      // if two 401s for the same user/server race the silent refresh, they
      // must share one in-flight refresh-token redemption — providers that
      // rotate refresh tokens reject the second redemption, otherwise causing
      // an unnecessary interactive OAuth fallback.
      const sseConfig = {
        ...mockServerConfig,
        url: 'https://api.example.com',
        type: 'sse' as const,
      } as t.SSEOptions;

      const basicOptions = {
        serverName: 'test-server',
        serverConfig: sseConfig,
      };

      const oauthOptions = {
        useOAuth: true as const,
        user: mockUser,
        flowManager: mockFlowManager,
        oauthStart: jest.fn(),
        tokenMethods: {
          findToken: jest.fn(),
          createToken: jest.fn(),
          updateToken: jest.fn(),
          deleteTokens: jest.fn(),
        },
      };

      const refreshedTokens: MCPOAuthTokens = {
        access_token: 'refreshed-access',
        refresh_token: 'refresh456',
        token_type: 'Bearer',
        obtained_at: Date.now(),
      };

      mockProcessMCPEnv.mockReturnValue(sseConfig);
      mockMCPOAuthHandler.generateFlowId.mockReturnValue('flow123');
      // Hold a single in-flight refresh open until both concurrent callers
      // have joined the lock. `mockImplementationOnce` (rather than the
      // persistent `mockImplementation`) ensures this never-resolving promise
      // does not leak into later tests' default mock behavior.
      let resolveRefresh: ((tokens: MCPOAuthTokens) => void) | undefined;
      let started: (() => void) | undefined;
      const refreshStarted = new Promise<void>((resolve) => (started = resolve));
      mockMCPTokenStorage.forceRefreshTokens.mockImplementationOnce(
        () =>
          new Promise<MCPOAuthTokens>((res) => {
            resolveRefresh = res;
            started?.();
          }),
      );
      mockConnectionInstance.isConnected.mockResolvedValue(false);

      let oauthRequiredHandler: (data: Record<string, unknown>) => Promise<void>;
      mockConnectionInstance.on.mockImplementation((event, handler) => {
        if (event === 'oauthRequired') {
          oauthRequiredHandler = handler as (data: Record<string, unknown>) => Promise<void>;
        }
        return mockConnectionInstance;
      });

      try {
        await MCPConnectionFactory.create(basicOptions, oauthOptions);
      } catch {
        // Expected
      }

      // Fire two concurrent oauthRequired events; both must share the same
      // in-flight refresh attempt.
      const first = oauthRequiredHandler!({ serverUrl: 'https://api.example.com' });
      const second = oauthRequiredHandler!({ serverUrl: 'https://api.example.com' });

      // Let the in-flight lock register, then resolve the single redemption.
      await refreshStarted;
      resolveRefresh!(refreshedTokens);
      await Promise.all([first, second]);

      // Exactly one refresh-token redemption was issued.
      expect(mockMCPTokenStorage.forceRefreshTokens).toHaveBeenCalledTimes(1);
      // Both callers set the connection's tokens with the same refreshed value.
      expect(mockConnectionInstance.setOAuthTokens).toHaveBeenCalledWith(refreshedTokens);
    });

    it.each([false, true])(
      'coalesces legacy identities only within the same binding (different: %s)',
      async (different) => {
        const makeConfig = (url: string): t.SSEOptions => ({
          type: 'sse',
          url,
          initTimeout: 15000,
        });
        const tokenMethods = {
          findToken: jest.fn(),
          createToken: jest.fn(),
          replaceTokenIfCurrent: jest.fn(),
          updateToken: jest.fn(),
          deleteTokens: jest.fn(),
        };
        mockProcessMCPEnv.mockImplementation(({ options }) => options as t.MCPOptions);

        const factoryA = new InspectableMCPConnectionFactory(
          {
            serverName: 'test-server',
            serverConfig: makeConfig('https://server-a.example.com/mcp'),
          },
          { useOAuth: true, user: mockUser, flowManager: mockFlowManager, tokenMethods },
        );
        const factoryB = new InspectableMCPConnectionFactory(
          {
            serverName: 'test-server',
            serverConfig: makeConfig(
              different ? 'https://server-b.example.com/mcp' : 'https://server-a.example.com/mcp',
            ),
          },
          { useOAuth: true, user: mockUser, flowManager: mockFlowManager, tokenMethods },
        );

        const resolutions: Array<(tokens: MCPOAuthTokens) => void> = [];
        mockMCPTokenStorage.forceRefreshTokens.mockImplementation(
          () =>
            new Promise<MCPOAuthTokens>((resolve) => {
              resolutions.push(resolve);
            }),
        );

        const attemptA = factoryA.attemptSilentTokenRefreshForTest();
        await Promise.resolve();
        const attemptB = factoryB.attemptSilentTokenRefreshForTest(null);
        await Promise.resolve();

        expect(mockMCPTokenStorage.forceRefreshTokens).toHaveBeenCalledTimes(different ? 2 : 1);
        const tokensA: MCPOAuthTokens = {
          access_token: 'server-a-token',
          token_type: 'Bearer',
          obtained_at: Date.now(),
        };
        const tokensB: MCPOAuthTokens = {
          access_token: 'server-b-token',
          token_type: 'Bearer',
          obtained_at: Date.now(),
        };
        resolutions[0](tokensA);
        resolutions[1]?.(tokensB);

        await expect(attemptA).resolves.toEqual(tokensA);
        await expect(attemptB).resolves.toEqual(different ? tokensB : tokensA);
      },
    );

    it('coalesces the common storage refresh while timing out its local waiters', async () => {
      jest.useFakeTimers();
      let releaseRejection!: () => void;
      const blocked = new Promise<void>((resolve) => (releaseRejection = resolve));
      mockMCPTokenStorage.forceRefreshTokens.mockImplementationOnce(async () => {
        await blocked;
        return null;
      });
      const factory = new InspectableMCPConnectionFactory(
        {
          serverName: 'test-server',
          serverConfig: { type: 'sse', url: 'https://api.example.com', initTimeout: 5000 },
        },
        {
          useOAuth: true,
          user: mockUser,
          flowManager: mockFlowManager,
          tokenMethods: {
            findToken: jest.fn(),
            createToken: jest.fn(),
            replaceTokenIfCurrent: jest.fn(),
            updateToken: jest.fn(),
            deleteTokens: jest.fn(),
          },
        },
      );
      try {
        const first = factory.attemptSilentTokenRefreshForTest('rejected-generation');
        const second = factory.attemptSilentTokenRefreshForTest('rejected-generation');
        void first.catch(() => undefined);
        void second.catch(() => undefined);
        expect(mockMCPTokenStorage.forceRefreshTokens).toHaveBeenCalledTimes(1);
        expect(mockMCPTokenStorage.forceRefreshTokens).toHaveBeenCalledWith(
          expect.objectContaining({ rejectedCredentialSetId: 'rejected-generation' }),
        );
        await jest.advanceTimersByTimeAsync(2001);
        await expect(first).rejects.toMatchObject({ name: 'MCPTokenRefreshUnavailableError' });
        await expect(second).rejects.toMatchObject({ name: 'MCPTokenRefreshUnavailableError' });
        releaseRejection();
        await jest.advanceTimersByTimeAsync(0);
        expect(mockMCPTokenStorage.forceRefreshTokens).toHaveBeenCalledTimes(1);
      } finally {
        releaseRejection();
        jest.useRealTimers();
      }
    });

    it('should keep the in-flight silent-refresh lock until the aborted refresh settles', async () => {
      // A timed-out caller should fall back to interactive OAuth immediately,
      // but the shared lock must remain briefly while the underlying abortable
      // refresh settles so another 401 cannot immediately redeem the same
      // rotating refresh token.
      const sseConfig = {
        ...mockServerConfig,
        url: 'https://api.example.com',
        type: 'sse' as const,
      } as t.SSEOptions;

      const basicOptions = {
        serverName: 'test-server',
        serverConfig: sseConfig,
      };

      const oauthOptions = {
        useOAuth: true as const,
        user: mockUser,
        flowManager: mockFlowManager,
        oauthStart: jest.fn(),
        oauthEnd: jest.fn(),
        tokenMethods: {
          findToken: jest.fn(),
          createToken: jest.fn(),
          updateToken: jest.fn(),
          deleteTokens: jest.fn(),
        },
      };

      mockProcessMCPEnv.mockReturnValue(sseConfig);
      mockMCPOAuthHandler.generateFlowId.mockReturnValue('flow123');
      const refreshedTokens: MCPOAuthTokens = {
        access_token: 'late-refresh',
        refresh_token: 'refresh456',
        token_type: 'Bearer',
        obtained_at: Date.now(),
      };
      let refreshSignal: AbortSignal | undefined;
      let resolveRefresh: ((tokens: MCPOAuthTokens) => void) | undefined;
      mockMCPTokenStorage.forceRefreshTokens.mockImplementationOnce((params) => {
        refreshSignal = params.signal;
        return new Promise<MCPOAuthTokens>((resolve) => {
          resolveRefresh = resolve;
        });
      });
      // Provide a no-op interactive fallback so the handler can complete.
      mockMCPOAuthHandler.initiateOAuthFlow.mockResolvedValue({
        authorizationUrl: 'https://auth.example.com',
        flowId: 'flow123',
        flowMetadata: {
          serverName: 'test-server',
          userId: 'user123',
          serverUrl: 'https://api.example.com',
          state: 'state-x',
        },
      });
      mockFlowManager.getFlowState.mockResolvedValue(null);
      mockFlowManager.createFlow.mockResolvedValue(null);
      mockConnectionInstance.connect.mockRejectedValue(new Error('OAuth authentication required'));
      mockConnectionInstance.isConnected.mockResolvedValue(false);

      let oauthRequiredHandler: (data: Record<string, unknown>) => Promise<void>;
      mockConnectionInstance.on.mockImplementation((event, handler) => {
        if (event === 'oauthRequired') {
          oauthRequiredHandler = handler as (data: Record<string, unknown>) => Promise<void>;
        }
        return mockConnectionInstance;
      });

      try {
        await MCPConnectionFactory.create(basicOptions, oauthOptions);
      } catch {
        // Expected — initial connection mocked to fail.
      }

      // Switch to fake timers only for the silent-refresh attempt so we can
      // fast-forward past its timeout without slowing the test suite.
      jest.useFakeTimers();
      try {
        const firstAttempt = oauthRequiredHandler!({ serverUrl: 'https://api.example.com' });
        await jest.advanceTimersByTimeAsync(2_001);
        await firstAttempt;

        const inflightMap = (
          MCPConnectionFactory as unknown as {
            inflightSilentRefreshes: Map<string, unknown>;
          }
        ).inflightSilentRefreshes;
        expect(inflightMap.size).toBe(1);
        expect(refreshSignal?.aborted).toBe(true);
        expect(mockMCPOAuthHandler.initiateOAuthFlow).not.toHaveBeenCalled();
        expect(mockConnectionInstance.emit).toHaveBeenCalledWith(
          'oauthFailed',
          expect.objectContaining({ name: 'MCPTokenRefreshUnavailableError' }),
        );

        const secondAttempt = oauthRequiredHandler!({ serverUrl: 'https://api.example.com' });
        await secondAttempt;
        expect(mockMCPTokenStorage.forceRefreshTokens).toHaveBeenCalledTimes(1);

        resolveRefresh!(refreshedTokens);
        for (let i = 0; i < 10; i += 1) {
          await Promise.resolve();
        }
        expect(inflightMap.size).toBe(0);
      } finally {
        jest.useRealTimers();
      }
    });

    it('should drop timed-out silent-refresh locks after abort grace if refresh stays hung', async () => {
      const sseConfig = {
        ...mockServerConfig,
        url: 'https://api.example.com',
        type: 'sse' as const,
      } as t.SSEOptions;

      const basicOptions = {
        serverName: 'test-server',
        serverConfig: sseConfig,
      };

      const oauthOptions = {
        useOAuth: true as const,
        user: mockUser,
        flowManager: mockFlowManager,
        oauthStart: jest.fn(),
        oauthEnd: jest.fn(),
        tokenMethods: {
          findToken: jest.fn(),
          createToken: jest.fn(),
          updateToken: jest.fn(),
          deleteTokens: jest.fn(),
        },
      };

      mockProcessMCPEnv.mockReturnValue(sseConfig);
      mockMCPOAuthHandler.generateFlowId.mockReturnValue('flow123');
      let firstRefreshSignal: AbortSignal | undefined;
      let secondRefreshSignal: AbortSignal | undefined;
      mockMCPTokenStorage.forceRefreshTokens
        .mockImplementationOnce((params) => {
          firstRefreshSignal = params.signal;
          return new Promise<MCPOAuthTokens>(() => {});
        })
        .mockImplementationOnce((params) => {
          secondRefreshSignal = params.signal;
          return Promise.resolve(null as unknown as MCPOAuthTokens);
        });
      mockMCPOAuthHandler.initiateOAuthFlow.mockResolvedValue({
        authorizationUrl: 'https://auth.example.com',
        flowId: 'flow123',
        flowMetadata: {
          serverName: 'test-server',
          userId: 'user123',
          serverUrl: 'https://api.example.com',
          state: 'state-x',
        },
      });
      mockFlowManager.getFlowState.mockResolvedValue(null);
      mockFlowManager.createFlow.mockResolvedValue(null);
      mockConnectionInstance.connect.mockRejectedValue(new Error('OAuth authentication required'));
      mockConnectionInstance.isConnected.mockResolvedValue(false);

      let oauthRequiredHandler: (data: Record<string, unknown>) => Promise<void>;
      mockConnectionInstance.on.mockImplementation((event, handler) => {
        if (event === 'oauthRequired') {
          oauthRequiredHandler = handler as (data: Record<string, unknown>) => Promise<void>;
        }
        return mockConnectionInstance;
      });

      try {
        await MCPConnectionFactory.create(basicOptions, oauthOptions);
      } catch {
        // Expected
      }

      jest.useFakeTimers();
      try {
        const firstAttempt = oauthRequiredHandler!({ serverUrl: 'https://api.example.com' });
        await jest.advanceTimersByTimeAsync(2_001);
        await firstAttempt;

        const inflightMap = (
          MCPConnectionFactory as unknown as {
            inflightSilentRefreshes: Map<string, unknown>;
          }
        ).inflightSilentRefreshes;
        expect(inflightMap.size).toBe(1);
        expect(firstRefreshSignal?.aborted).toBe(true);

        await jest.advanceTimersByTimeAsync(1_001);
        expect(inflightMap.size).toBe(0);

        const secondAttempt = oauthRequiredHandler!({ serverUrl: 'https://api.example.com' });
        await secondAttempt;

        expect(mockMCPTokenStorage.forceRefreshTokens).toHaveBeenCalledTimes(2);
        expect(secondRefreshSignal).toBeDefined();
      } finally {
        jest.useRealTimers();
      }
    });

    it('defers recovery when the silent refresh budget expires with initTimeout omitted', async () => {
      const sseConfig = {
        url: 'https://api.example.com',
        type: 'sse' as const,
      } as t.SSEOptions;

      const basicOptions = {
        serverName: 'test-server',
        serverConfig: sseConfig,
      };

      const oauthOptions = {
        useOAuth: true as const,
        user: mockUser,
        flowManager: mockFlowManager,
        oauthStart: jest.fn(),
        oauthEnd: jest.fn(),
        tokenMethods: {
          findToken: jest.fn(),
          createToken: jest.fn(),
          updateToken: jest.fn(),
          deleteTokens: jest.fn(),
        },
      };

      mockProcessMCPEnv.mockReturnValue(sseConfig);
      mockMCPOAuthHandler.generateFlowId.mockReturnValue('flow123');
      let refreshSignal: AbortSignal | undefined;
      mockMCPTokenStorage.forceRefreshTokens.mockImplementationOnce((params) => {
        refreshSignal = params.signal;
        return new Promise<MCPOAuthTokens>(() => {});
      });
      mockMCPOAuthHandler.initiateOAuthFlow.mockResolvedValue({
        authorizationUrl: 'https://auth.example.com',
        flowId: 'flow123',
        flowMetadata: {
          serverName: 'test-server',
          userId: 'user123',
          serverUrl: 'https://api.example.com',
          state: 'state-x',
        },
      });
      mockFlowManager.getFlowState.mockResolvedValue(null);
      mockFlowManager.createFlow.mockResolvedValue(null);
      mockConnectionInstance.connect.mockRejectedValue(new Error('OAuth authentication required'));
      mockConnectionInstance.isConnected.mockResolvedValue(false);

      let oauthRequiredHandler: (data: Record<string, unknown>) => Promise<void>;
      mockConnectionInstance.on.mockImplementation((event, handler) => {
        if (event === 'oauthRequired') {
          oauthRequiredHandler = handler as (data: Record<string, unknown>) => Promise<void>;
        }
        return mockConnectionInstance;
      });

      try {
        await MCPConnectionFactory.create(basicOptions, oauthOptions);
      } catch {
        // Expected
      }

      jest.useFakeTimers();
      try {
        const attempt = oauthRequiredHandler!({ serverUrl: 'https://api.example.com' });
        await jest.advanceTimersByTimeAsync(5_001);
        await attempt;

        expect(refreshSignal?.aborted).toBe(true);
        expect(mockMCPOAuthHandler.initiateOAuthFlow).not.toHaveBeenCalled();
        expect(mockConnectionInstance.emit).toHaveBeenCalledWith(
          'oauthFailed',
          expect.objectContaining({ name: 'MCPTokenRefreshUnavailableError' }),
        );
      } finally {
        jest.useRealTimers();
      }
    });

    it('should cap silent refresh below half of a small connection timeout', async () => {
      const sseConfig = {
        ...mockServerConfig,
        url: 'https://api.example.com',
        type: 'sse' as const,
        initTimeout: 5000,
      } as t.SSEOptions;

      const basicOptions = {
        serverName: 'test-server',
        serverConfig: sseConfig,
      };

      const oauthOptions = {
        useOAuth: true as const,
        user: mockUser,
        flowManager: mockFlowManager,
        oauthStart: jest.fn(),
        oauthEnd: jest.fn(),
        tokenMethods: {
          findToken: jest.fn(),
          createToken: jest.fn(),
          updateToken: jest.fn(),
          deleteTokens: jest.fn(),
        },
      };

      mockProcessMCPEnv.mockReturnValue(sseConfig);
      mockMCPOAuthHandler.generateFlowId.mockReturnValue('flow123');
      let refreshSignal: AbortSignal | undefined;
      mockMCPTokenStorage.forceRefreshTokens.mockImplementationOnce((params) => {
        refreshSignal = params.signal;
        return new Promise<MCPOAuthTokens>(() => {});
      });
      mockMCPOAuthHandler.initiateOAuthFlow.mockResolvedValue({
        authorizationUrl: 'https://auth.example.com',
        flowId: 'flow123',
        flowMetadata: {
          serverName: 'test-server',
          userId: 'user123',
          serverUrl: 'https://api.example.com',
          state: 'state-x',
        },
      });
      mockFlowManager.getFlowState.mockResolvedValue(null);
      mockFlowManager.createFlow.mockResolvedValue(null);
      mockConnectionInstance.connect.mockRejectedValue(new Error('OAuth authentication required'));
      mockConnectionInstance.isConnected.mockResolvedValue(false);

      let oauthRequiredHandler: (data: Record<string, unknown>) => Promise<void>;
      mockConnectionInstance.on.mockImplementation((event, handler) => {
        if (event === 'oauthRequired') {
          oauthRequiredHandler = handler as (data: Record<string, unknown>) => Promise<void>;
        }
        return mockConnectionInstance;
      });

      try {
        await MCPConnectionFactory.create(basicOptions, oauthOptions);
      } catch {
        // Expected
      }

      jest.useFakeTimers();
      try {
        const attempt = oauthRequiredHandler!({ serverUrl: 'https://api.example.com' });
        await jest.advanceTimersByTimeAsync(1_999);
        expect(refreshSignal?.aborted).not.toBe(true);
        expect(mockMCPOAuthHandler.initiateOAuthFlow).not.toHaveBeenCalled();

        await jest.advanceTimersByTimeAsync(2);
        await attempt;

        expect(refreshSignal?.aborted).toBe(true);
        expect(mockMCPOAuthHandler.initiateOAuthFlow).not.toHaveBeenCalled();
        expect(mockConnectionInstance.emit).toHaveBeenCalledWith(
          'oauthFailed',
          expect.objectContaining({ name: 'MCPTokenRefreshUnavailableError' }),
        );
      } finally {
        jest.useRealTimers();
      }
    });

    it('should skip silent refresh for 403 OAuth reauthorization failures', async () => {
      const sseConfig = {
        ...mockServerConfig,
        url: 'https://api.example.com',
        type: 'sse' as const,
      } as t.SSEOptions;

      const basicOptions = {
        serverName: 'test-server',
        serverConfig: sseConfig,
      };

      const oauthOptions = {
        useOAuth: true as const,
        user: mockUser,
        flowManager: mockFlowManager,
        oauthStart: jest.fn(),
        oauthEnd: jest.fn(),
        tokenMethods: {
          findToken: jest.fn(),
          createToken: jest.fn(),
          updateToken: jest.fn(),
          deleteTokens: jest.fn(),
        },
      };

      mockProcessMCPEnv.mockReturnValue(sseConfig);
      mockMCPOAuthHandler.generateFlowId.mockReturnValue('flow123');
      mockMCPOAuthHandler.initiateOAuthFlow.mockResolvedValue({
        authorizationUrl: 'https://auth.example.com',
        flowId: 'flow123',
        flowMetadata: {
          serverName: 'test-server',
          userId: 'user123',
          serverUrl: 'https://api.example.com',
          state: 'state-x',
        },
      });
      mockFlowManager.getFlowState.mockResolvedValue(null);
      mockFlowManager.createFlow.mockResolvedValue(null);
      mockConnectionInstance.isConnected.mockResolvedValue(false);

      let oauthRequiredHandler: (data: Record<string, unknown>) => Promise<void>;
      mockConnectionInstance.on.mockImplementation((event, handler) => {
        if (event === 'oauthRequired') {
          oauthRequiredHandler = handler as (data: Record<string, unknown>) => Promise<void>;
        }
        return mockConnectionInstance;
      });

      try {
        await MCPConnectionFactory.create(basicOptions, oauthOptions);
      } catch {
        // Expected
      }

      const forbiddenError = Object.assign(new Error('Non-200 status code (403)'), { code: 403 });
      await oauthRequiredHandler!({
        serverUrl: 'https://api.example.com',
        error: forbiddenError,
      });

      expect(mockMCPTokenStorage.forceRefreshTokens).not.toHaveBeenCalled();
      expect(mockConnectionInstance.setOAuthTokens).not.toHaveBeenCalled();
      expect(mockMCPOAuthHandler.initiateOAuthFlow).toHaveBeenCalled();
    });

    it('should not process already resolved configs for request OAuth handlers', () => {
      const sseConfig = {
        ...mockServerConfig,
        url: 'https://api.example.com/${SHOULD_NOT_EXPAND}',
        type: 'sse' as const,
      } as t.SSEOptions;
      mockProcessMCPEnv.mockClear();

      const cleanup = MCPConnectionFactory.attachRequestOAuthHandler(
        {
          serverName: 'test-server',
          serverConfig: sseConfig,
          skipEnvProcessing: true,
        },
        {
          useOAuth: true,
          user: mockUser,
          flowManager: mockFlowManager,
          oauthStart: jest.fn(),
        },
        mockConnectionInstance,
      );

      expect(mockProcessMCPEnv).not.toHaveBeenCalled();
      expect(mockConnectionInstance.on).toHaveBeenCalledWith(
        'oauthReauthenticationRequired',
        expect.any(Function),
      );

      cleanup();
    });

    it('bounds request recovery to one silent refresh and one interactive flow', async () => {
      const sseConfig = {
        ...mockServerConfig,
        url: 'https://api.example.com',
        type: 'sse' as const,
      } as t.SSEOptions;
      const basicOptions = {
        serverName: 'test-server',
        serverConfig: sseConfig,
      };
      const refreshedTokens: MCPOAuthTokens = {
        access_token: 'refreshed-access',
        refresh_token: 'refresh-token',
        token_type: 'Bearer',
        obtained_at: Date.now(),
      };
      const interactiveTokens: MCPOAuthTokens = {
        access_token: 'interactive-access',
        token_type: 'Bearer',
        obtained_at: Date.now(),
        credential_set_id: 'interactive-generation',
      };
      mockProcessMCPEnv.mockReturnValue(sseConfig);
      mockMCPOAuthHandler.generateFlowId.mockReturnValue('flow123');
      mockMCPTokenStorage.forceRefreshTokens.mockResolvedValueOnce(refreshedTokens);
      mockFlowManager.getFlowState.mockResolvedValue(null);
      mockMCPOAuthHandler.initiateOAuthFlow.mockResolvedValueOnce({
        authorizationUrl: 'https://auth.example.com',
        flowId: 'flow123',
        flowMetadata: {
          serverName: 'test-server',
          userId: 'user123',
          serverUrl: 'https://api.example.com',
          state: 'fresh-state',
        },
      });
      mockFlowManager.createFlow.mockResolvedValueOnce(interactiveTokens);

      let requestOAuthHandler: ((data: Record<string, unknown>) => Promise<void>) | undefined;
      mockConnectionInstance.on.mockImplementation((event, handler) => {
        if (event === 'oauthReauthenticationRequired') {
          requestOAuthHandler = handler as (data: Record<string, unknown>) => Promise<void>;
        }
        return mockConnectionInstance;
      });
      const cleanup = MCPConnectionFactory.attachRequestOAuthHandler(
        basicOptions,
        {
          useOAuth: true,
          user: mockUser,
          flowManager: mockFlowManager,
          oauthStart: jest.fn(),
          tokenMethods: {
            findToken: jest.fn(),
            createToken: jest.fn(),
            replaceTokenIfCurrent: jest.fn(),
            updateToken: jest.fn(),
            deleteTokens: jest.fn(),
          },
        },
        mockConnectionInstance,
      );
      const challenge = {
        serverUrl: 'https://api.example.com',
        error: new Error('Non-200 status code (401)'),
      };

      const rejection = (rejectedCredentialSetId: string) => ({
        ...challenge,
        rejectedCredentialSetId,
      });
      await Promise.all([
        requestOAuthHandler!(rejection('original-generation')),
        requestOAuthHandler!(rejection('original-generation')),
      ]);
      await requestOAuthHandler!(rejection('refreshed-generation'));
      await requestOAuthHandler!(rejection('interactive-generation'));

      expect(
        mockMCPTokenStorage.markAuthorizationRejected.mock.calls.map(
          ([params]) => params.credentialSetId,
        ),
      ).toEqual(['refreshed-generation', 'interactive-generation']);
      expect(mockMCPTokenStorage.forceRefreshTokens).toHaveBeenCalledWith(
        expect.objectContaining({ rejectedCredentialSetId: 'original-generation' }),
      );

      expect(mockMCPTokenStorage.forceRefreshTokens).toHaveBeenCalledTimes(1);
      expect(mockMCPOAuthHandler.initiateOAuthFlow).toHaveBeenCalledTimes(1);
      expect(mockConnectionInstance.setOAuthTokens).toHaveBeenNthCalledWith(1, refreshedTokens);
      expect(mockConnectionInstance.setOAuthTokens).toHaveBeenNthCalledWith(2, interactiveTokens);
      expect(mockConnectionInstance.emit).toHaveBeenCalledWith(
        'oauthFailed',
        expect.objectContaining({ message: 'OAuth recovery phase budget exhausted' }),
      );

      cleanup();
    });

    it('should not reuse request-scoped OAuth callbacks after connection is cached', async () => {
      const sseConfig = {
        ...mockServerConfig,
        url: 'https://api.example.com',
        type: 'sse' as const,
      } as t.SSEOptions;

      const basicOptions = {
        serverName: 'test-server',
        serverConfig: sseConfig,
      };

      const oauthStart = jest.fn();
      const oauthEnd = jest.fn();
      const requestAbortController = new AbortController();
      const initialTokens: MCPOAuthTokens = {
        access_token: 'initial-access',
        refresh_token: 'initial-refresh',
        token_type: 'Bearer',
        obtained_at: Date.now(),
      };

      const oauthOptions = {
        useOAuth: true as const,
        user: mockUser,
        flowManager: mockFlowManager,
        oauthStart,
        oauthEnd,
        signal: requestAbortController.signal,
        tokenMethods: {
          findToken: jest.fn(),
          createToken: jest.fn(),
          updateToken: jest.fn(),
          deleteTokens: jest.fn(),
        },
      };

      mockProcessMCPEnv.mockReturnValue(sseConfig);
      mockMCPOAuthHandler.generateFlowId.mockReturnValue('flow123');
      mockFlowManager.createFlowWithHandler.mockResolvedValue(initialTokens);
      mockConnectionInstance.connect.mockResolvedValue(undefined);
      mockConnectionInstance.isConnected.mockResolvedValue(true);

      let oauthRequiredHandler: (data: Record<string, unknown>) => Promise<void>;
      mockConnectionInstance.on.mockImplementation((event, handler) => {
        if (event === 'oauthRequired') {
          oauthRequiredHandler = handler as (data: Record<string, unknown>) => Promise<void>;
        }
        return mockConnectionInstance;
      });

      await MCPConnectionFactory.create(basicOptions, oauthOptions);

      requestAbortController.abort();
      mockFlowManager.getFlowState.mockResolvedValue(null);
      mockMCPTokenStorage.forceRefreshTokens.mockResolvedValueOnce(null);

      await oauthRequiredHandler!({
        serverUrl: 'https://api.example.com',
        error: new Error('Non-200 status code (401)'),
      });

      expect(mockMCPOAuthHandler.initiateOAuthFlow).not.toHaveBeenCalled();
      expect(mockFlowManager.initFlow).not.toHaveBeenCalled();
      expect(mockFlowManager.createFlow).not.toHaveBeenCalled();
      expect(oauthStart).not.toHaveBeenCalled();
      expect(oauthEnd).not.toHaveBeenCalled();
      expect(mockMCPTokenStorage.markAuthorizationRejected).toHaveBeenCalledWith(
        expect.objectContaining({ credentialSetId: 'rejected-generation' }),
      );
      expect(mockConnectionInstance.emit).toHaveBeenCalledWith(
        'oauthFailed',
        expect.objectContaining({ message: 'OAuth reauthentication required' }),
      );
    });

    it('should clear request-scoped OAuth callbacks after successful connection', async () => {
      const sseConfig = {
        ...mockServerConfig,
        url: 'https://api.example.com',
        type: 'sse' as const,
      } as t.SSEOptions;
      const initialTokens: MCPOAuthTokens = {
        access_token: 'initial-access',
        refresh_token: 'initial-refresh',
        token_type: 'Bearer',
        obtained_at: Date.now(),
      };
      const oauthStart = jest.fn();
      const oauthEnd = jest.fn();
      const requestAbortController = new AbortController();
      const upstreamTokenProvider = jest.fn();
      const factory = new InspectableMCPConnectionFactory(
        {
          serverName: 'test-server',
          serverConfig: sseConfig,
        },
        {
          useOAuth: true,
          user: mockUser,
          flowManager: mockFlowManager,
          oauthStart,
          oauthEnd,
          signal: requestAbortController.signal,
          upstreamTokenProvider,
          returnOnOAuth: true,
          tokenMethods: {
            findToken: jest.fn(),
            createToken: jest.fn(),
            replaceTokenIfCurrent: jest.fn(),
            updateToken: jest.fn(),
            deleteTokens: jest.fn(),
          },
        },
      );

      mockProcessMCPEnv.mockReturnValue(sseConfig);
      mockFlowManager.createFlowWithHandler.mockResolvedValue(initialTokens);
      mockConnectionInstance.connect.mockResolvedValue(undefined);
      mockConnectionInstance.isConnected.mockResolvedValue(true);

      await factory.createConnectionForTest();

      expect(mockConnectionInstance.on).toHaveBeenCalledWith('oauthRequired', expect.any(Function));
      expect(factory.getRequestScopedOAuthState()).toEqual({
        signal: undefined,
        oauthStart: undefined,
        oauthEnd: undefined,
        returnOnOAuth: false,
      });
      expect(factory.hasUpstreamTokenProviderForTest()).toBe(false);
    });

    it('should let a live request handle cached-connection reauthentication with fresh callbacks', async () => {
      const sseConfig = {
        ...mockServerConfig,
        url: 'https://api.example.com',
        type: 'sse' as const,
      } as t.SSEOptions;

      const basicOptions = {
        serverName: 'test-server',
        serverConfig: sseConfig,
      };

      const staleOAuthStart = jest.fn();
      const liveOAuthStart = jest.fn();
      const initialTokens: MCPOAuthTokens = {
        access_token: 'initial-access',
        refresh_token: 'initial-refresh',
        token_type: 'Bearer',
        obtained_at: Date.now(),
      };
      const callbackTokens: MCPOAuthTokens = {
        access_token: 'callback-access',
        token_type: 'Bearer',
        obtained_at: Date.now(),
        credential_set_id: 'callback-generation',
      };

      mockProcessMCPEnv.mockReturnValue(sseConfig);
      mockMCPOAuthHandler.generateFlowId.mockReturnValue('flow123');
      mockFlowManager.createFlowWithHandler.mockResolvedValue(initialTokens);
      mockFlowManager.createFlow.mockResolvedValue(callbackTokens);
      mockFlowManager.getFlowState.mockResolvedValue(null);
      mockMCPOAuthHandler.initiateOAuthFlow.mockResolvedValue({
        authorizationUrl: 'https://auth.example.com',
        flowId: 'flow123',
        flowMetadata: {
          serverName: 'test-server',
          userId: 'user123',
          serverUrl: 'https://api.example.com',
          state: 'state-live',
          clientInfo: { client_id: 'client-live' },
        },
      });
      mockConnectionInstance.connect.mockResolvedValue(undefined);
      mockConnectionInstance.isConnected.mockResolvedValue(true);
      type Listener = (...args: unknown[]) => void;
      const handlers: Record<string, Listener[]> = {};
      mockConnectionInstance.on.mockImplementation((event, handler) => {
        const key = typeof event === 'symbol' ? event.toString() : event;
        (handlers[key] ??= []).push(handler as Listener);
        return mockConnectionInstance;
      });
      mockConnectionInstance.removeListener.mockImplementation((event, handler) => {
        const key = typeof event === 'symbol' ? event.toString() : event;
        const list = handlers[key];
        const index = list?.indexOf(handler as Listener) ?? -1;
        if (list && index !== -1) {
          list.splice(index, 1);
        }
        return mockConnectionInstance;
      });
      mockConnectionInstance.emit.mockImplementation((event, ...args) => {
        const key = typeof event === 'symbol' ? event.toString() : event;
        const list = handlers[key];
        if (!list?.length) {
          return false;
        }
        for (const fn of [...list]) {
          fn(...args);
        }
        return true;
      });

      await MCPConnectionFactory.create(basicOptions, {
        useOAuth: true,
        user: mockUser,
        flowManager: mockFlowManager,
        oauthStart: staleOAuthStart,
        tokenMethods: {
          findToken: jest.fn(),
          createToken: jest.fn(),
          replaceTokenIfCurrent: jest.fn(),
          updateToken: jest.fn(),
          deleteTokens: jest.fn(),
        },
      });

      const liveStarted = new Promise<void>((resolve) => {
        liveOAuthStart.mockImplementation(async () => {
          resolve();
        });
      });
      const cleanup = MCPConnectionFactory.attachRequestOAuthHandler(
        basicOptions,
        {
          useOAuth: true,
          user: mockUser,
          flowManager: mockFlowManager,
          oauthStart: liveOAuthStart,
          tokenMethods: {
            findToken: jest.fn(),
            createToken: jest.fn(),
            replaceTokenIfCurrent: jest.fn(),
            updateToken: jest.fn(),
            deleteTokens: jest.fn(),
          },
        },
        mockConnectionInstance,
      );
      mockMCPTokenStorage.forceRefreshTokens.mockResolvedValueOnce(null);

      mockConnectionInstance.emit('oauthRequired', {
        serverUrl: 'https://api.example.com',
        error: new Error('Non-200 status code (401)'),
      });

      await liveStarted;

      expect(staleOAuthStart).not.toHaveBeenCalled();
      expect(liveOAuthStart).toHaveBeenCalledWith('https://auth.example.com');
      expect(handlers.oauthReauthenticationRequired.length).toBe(1);

      cleanup();

      expect(handlers.oauthReauthenticationRequired.length).toBe(0);
    });

    it('should invalidate completed mcp_oauth cache before falling through to interactive OAuth', async () => {
      // Regression for the Codex finding "Bypass completed OAuth cache after a
      // rejected token": when silent refresh returns null and the handler
      // falls through to interactive OAuth, any recently COMPLETED mcp_oauth
      // flow must be cleared so the fast-reuse path in `handleOAuthRequired`
      // can't hand back the very tokens the resource server just rejected.
      const sseConfig = {
        ...mockServerConfig,
        url: 'https://api.example.com',
        type: 'sse' as const,
      } as t.SSEOptions;

      const basicOptions = {
        serverName: 'test-server',
        serverConfig: sseConfig,
      };

      const oauthOptions = {
        useOAuth: true as const,
        user: mockUser,
        flowManager: mockFlowManager,
        oauthStart: jest.fn(),
        oauthEnd: jest.fn(),
        tokenMethods: {
          findToken: jest.fn(),
          createToken: jest.fn(),
          updateToken: jest.fn(),
          deleteTokens: jest.fn(),
        },
      };

      const completedFlowState = {
        status: 'COMPLETED' as const,
        type: 'mcp_oauth',
        metadata: { state: 'old-csrf-state' },
        createdAt: Date.now(),
        completedAt: Date.now(),
        result: {
          access_token: 'just-rejected',
          token_type: 'Bearer',
          obtained_at: Date.now(),
        } as MCPOAuthTokens,
      };

      mockProcessMCPEnv.mockReturnValue(sseConfig);
      mockMCPOAuthHandler.generateFlowId.mockReturnValue('flow123');
      mockMCPTokenStorage.forceRefreshTokens.mockResolvedValueOnce(null);
      // First lookup (from invalidateCompletedOAuthFlow) sees the stale
      // COMPLETED state with the just-rejected tokens; the second lookup
      // (inside handleOAuthRequired, after deletion) sees nothing and goes
      // straight to a fresh interactive OAuth flow.
      mockFlowManager.getFlowState
        .mockResolvedValueOnce(completedFlowState)
        .mockResolvedValue(null);
      mockMCPOAuthHandler.initiateOAuthFlow.mockResolvedValue({
        authorizationUrl: 'https://auth.example.com',
        flowId: 'flow123',
        flowMetadata: {
          serverName: 'test-server',
          userId: 'user123',
          serverUrl: 'https://api.example.com',
          state: 'fresh-csrf-state',
        },
      });
      mockFlowManager.createFlow.mockResolvedValue({
        access_token: 'freshly-issued',
        token_type: 'Bearer',
        obtained_at: Date.now(),
      } as MCPOAuthTokens);
      mockConnectionInstance.isConnected.mockResolvedValue(false);

      let oauthRequiredHandler: (data: Record<string, unknown>) => Promise<void>;
      mockConnectionInstance.on.mockImplementation((event, handler) => {
        if (event === 'oauthRequired') {
          oauthRequiredHandler = handler as (data: Record<string, unknown>) => Promise<void>;
        }
        return mockConnectionInstance;
      });

      try {
        await MCPConnectionFactory.create(basicOptions, oauthOptions);
      } catch {
        // Expected
      }

      await oauthRequiredHandler!({ serverUrl: 'https://api.example.com' });

      // Completed `mcp_oauth` flow was deleted before the interactive path ran.
      expect(mockFlowManager.deleteFlow).toHaveBeenCalledWith('flow123', 'mcp_oauth');
      // And the old CSRF state mapping was cleaned up alongside it.
      expect(mockMCPOAuthHandler.deleteStateMapping).toHaveBeenCalledWith(
        'old-csrf-state',
        mockFlowManager,
      );
    });

    it('should not invalidate a completed mcp_oauth flow from another tenant', async () => {
      const sseConfig = {
        ...mockServerConfig,
        url: 'https://api.example.com',
        type: 'sse' as const,
      } as t.SSEOptions;

      const basicOptions = {
        serverName: 'test-server',
        serverConfig: sseConfig,
      };

      const oauthOptions = {
        useOAuth: true as const,
        user: mockUser,
        flowManager: mockFlowManager,
        oauthStart: jest.fn(),
        oauthEnd: jest.fn(),
        tokenMethods: {
          findToken: jest.fn(),
          createToken: jest.fn(),
          updateToken: jest.fn(),
          deleteTokens: jest.fn(),
        },
      };

      const tenantBCompletedFlow = {
        status: 'COMPLETED' as const,
        type: 'mcp_oauth',
        metadata: { state: 'tenant-b-state', tenantId: 'tenant-b' },
        createdAt: Date.now(),
        completedAt: Date.now(),
        result: {
          access_token: 'tenant-b-token',
          token_type: 'Bearer',
          obtained_at: Date.now(),
        } as MCPOAuthTokens,
      };

      (getTenantId as jest.Mock).mockReturnValue('tenant-a');
      mockProcessMCPEnv.mockReturnValue(sseConfig);
      mockMCPOAuthHandler.generateFlowId.mockReturnValue('flow123');
      mockMCPTokenStorage.forceRefreshTokens.mockResolvedValueOnce(null);
      mockFlowManager.getFlowState
        .mockResolvedValueOnce(tenantBCompletedFlow)
        .mockResolvedValue(null);
      mockMCPOAuthHandler.initiateOAuthFlow.mockResolvedValue({
        authorizationUrl: 'https://auth.example.com',
        flowId: 'flow123',
        flowMetadata: {
          serverName: 'test-server',
          userId: 'user123',
          serverUrl: 'https://api.example.com',
          state: 'tenant-a-state',
        },
      });
      mockFlowManager.createFlow.mockResolvedValue(null);
      mockConnectionInstance.isConnected.mockResolvedValue(false);

      let oauthRequiredHandler: (data: Record<string, unknown>) => Promise<void>;
      mockConnectionInstance.on.mockImplementation((event, handler) => {
        if (event === 'oauthRequired') {
          oauthRequiredHandler = handler as (data: Record<string, unknown>) => Promise<void>;
        }
        return mockConnectionInstance;
      });

      try {
        await MCPConnectionFactory.create(basicOptions, oauthOptions);
      } catch {
        // Expected
      }

      await oauthRequiredHandler!({ serverUrl: 'https://api.example.com' });

      expect(mockFlowManager.getFlowState).toHaveBeenCalledWith('flow123', 'mcp_oauth');
      expect(mockFlowManager.deleteFlow).not.toHaveBeenCalledWith('flow123', 'mcp_oauth');
      expect(mockMCPOAuthHandler.deleteStateMapping).not.toHaveBeenCalledWith(
        'tenant-b-state',
        mockFlowManager,
      );
      expect(mockFlowManager.initFlow).toHaveBeenCalledWith(
        'flow123',
        'mcp_oauth',
        expect.objectContaining({ tenantId: 'tenant-a' }),
      );
    });

    it('should tenant-scope mcp_oauth flow lookup before completed-flow reuse', async () => {
      const sseConfig = {
        ...mockServerConfig,
        url: 'https://api.example.com',
        type: 'sse' as const,
      } as t.SSEOptions;

      const basicOptions = {
        serverName: 'test-server',
        serverConfig: sseConfig,
      };

      const oauthOptions = {
        useOAuth: true as const,
        user: mockUser,
        flowManager: mockFlowManager,
        oauthStart: jest.fn(),
        oauthEnd: jest.fn(),
        tokenMethods: {
          findToken: jest.fn(),
          createToken: jest.fn(),
          updateToken: jest.fn(),
          deleteTokens: jest.fn(),
        },
      };

      const tenantFlowId = 'tenant:tenant-a:user123:test-server';

      (getTenantId as jest.Mock).mockReturnValue('tenant-a');
      mockProcessMCPEnv.mockReturnValue(sseConfig);
      mockMCPTokenStorage.forceRefreshTokens.mockResolvedValueOnce(null);
      mockFlowManager.getFlowState.mockResolvedValue(null);
      mockMCPOAuthHandler.initiateOAuthFlow.mockResolvedValue({
        authorizationUrl: 'https://auth.example.com',
        flowId: tenantFlowId,
        flowMetadata: {
          serverName: 'test-server',
          userId: 'user123',
          serverUrl: 'https://api.example.com',
          state: 'tenant-a-state',
          tenantId: 'tenant-a',
        },
      });
      mockFlowManager.createFlow.mockResolvedValue(null);
      mockConnectionInstance.isConnected.mockResolvedValue(false);

      let oauthRequiredHandler: (data: Record<string, unknown>) => Promise<void>;
      mockConnectionInstance.on.mockImplementation((event, handler) => {
        if (event === 'oauthRequired') {
          oauthRequiredHandler = handler as (data: Record<string, unknown>) => Promise<void>;
        }
        return mockConnectionInstance;
      });

      try {
        await MCPConnectionFactory.create(basicOptions, oauthOptions);
      } catch {
        // Expected
      }

      await oauthRequiredHandler!({ serverUrl: 'https://api.example.com' });

      expect(mockFlowManager.getFlowState).toHaveBeenCalledWith(tenantFlowId, 'mcp_oauth');
      expect(mockFlowManager.getFlowState).not.toHaveBeenCalledWith(
        'user123:test-server',
        'mcp_oauth',
      );
      expect(mockFlowManager.initFlow).toHaveBeenCalledWith(
        tenantFlowId,
        'mcp_oauth',
        expect.objectContaining({ tenantId: 'tenant-a' }),
      );
    });

    it('should scope the silent-refresh in-flight lock by tenant', async () => {
      // Regression for the Codex finding "Scope silent refresh lock by
      // tenant": two tenants that share the same `userId` and `serverName`
      // (e.g. when IDs are username-based) must not join each other's
      // in-flight refresh; otherwise tokens minted under tenant A's
      // refresh-token would be applied to a tenant-B connection.
      const tenantMock = getTenantId as jest.MockedFunction<typeof getTenantId>;

      const sseConfig = {
        ...mockServerConfig,
        url: 'https://api.example.com',
        type: 'sse' as const,
      } as t.SSEOptions;

      const basicOptions = {
        serverName: 'test-server',
        serverConfig: sseConfig,
      };

      const oauthOptions = {
        useOAuth: true as const,
        user: mockUser,
        flowManager: mockFlowManager,
        oauthStart: jest.fn(),
        tokenMethods: {
          findToken: jest.fn(),
          createToken: jest.fn(),
          updateToken: jest.fn(),
          deleteTokens: jest.fn(),
        },
      };

      const tenantATokens: MCPOAuthTokens = {
        access_token: 'tenant-a-access',
        refresh_token: 'tenant-a-refresh',
        token_type: 'Bearer',
        obtained_at: Date.now(),
      };
      const tenantBTokens: MCPOAuthTokens = {
        access_token: 'tenant-b-access',
        refresh_token: 'tenant-b-refresh',
        token_type: 'Bearer',
        obtained_at: Date.now(),
      };

      mockProcessMCPEnv.mockReturnValue(sseConfig);
      mockMCPOAuthHandler.generateFlowId.mockReturnValue('flow123');
      mockConnectionInstance.isConnected.mockResolvedValue(false);

      let oauthRequiredHandler: (data: Record<string, unknown>) => Promise<void>;
      mockConnectionInstance.on.mockImplementation((event, handler) => {
        if (event === 'oauthRequired') {
          oauthRequiredHandler = handler as (data: Record<string, unknown>) => Promise<void>;
        }
        return mockConnectionInstance;
      });

      // Build a factory whose tenantId was captured as "tenant-a", trigger a
      // refresh, then build a second factory under "tenant-b" with the same
      // userId and serverName. Each refresh must call `forceRefreshTokens`
      // independently and apply its own tokens.
      tenantMock.mockReturnValue('tenant-a');
      mockMCPTokenStorage.forceRefreshTokens.mockResolvedValueOnce(tenantATokens);

      try {
        await MCPConnectionFactory.create(basicOptions, oauthOptions);
      } catch {
        // Expected
      }
      const tenantAHandler = oauthRequiredHandler!;

      // Reset oauthRequiredHandler capture for the second factory.
      tenantMock.mockReturnValue('tenant-b');
      mockMCPTokenStorage.forceRefreshTokens.mockResolvedValueOnce(tenantBTokens);

      try {
        await MCPConnectionFactory.create(basicOptions, oauthOptions);
      } catch {
        // Expected
      }
      const tenantBHandler = oauthRequiredHandler!;

      await Promise.all([
        tenantAHandler({ serverUrl: 'https://api.example.com' }),
        tenantBHandler({ serverUrl: 'https://api.example.com' }),
      ]);

      // Each tenant ran its own refresh and applied its own tokens — no
      // cross-tenant coalescing.
      expect(mockMCPTokenStorage.forceRefreshTokens).toHaveBeenCalledTimes(2);
      expect(mockConnectionInstance.setOAuthTokens).toHaveBeenCalledWith(tenantATokens);
      expect(mockConnectionInstance.setOAuthTokens).toHaveBeenCalledWith(tenantBTokens);
    });

    it('should restore captured tenant context while silently refreshing tokens', async () => {
      const capturedContext = {
        tenantId: 'tenant-a',
        userId: 'user123',
        requestId: 'req-123',
      };
      mockTenantStorage.getStore.mockReturnValueOnce(capturedContext);

      const sseConfig = {
        ...mockServerConfig,
        url: 'https://api.example.com',
        type: 'sse' as const,
      } as t.SSEOptions;

      const basicOptions = {
        serverName: 'test-server',
        serverConfig: sseConfig,
      };

      const oauthOptions = {
        useOAuth: true as const,
        user: mockUser,
        flowManager: mockFlowManager,
        oauthStart: jest.fn(),
        tokenMethods: {
          findToken: jest.fn(),
          createToken: jest.fn(),
          updateToken: jest.fn(),
          deleteTokens: jest.fn(),
        },
      };

      const refreshedTokens: MCPOAuthTokens = {
        access_token: 'tenant-access',
        refresh_token: 'tenant-refresh',
        token_type: 'Bearer',
        obtained_at: Date.now(),
      };

      mockProcessMCPEnv.mockReturnValue(sseConfig);
      mockMCPOAuthHandler.generateFlowId.mockReturnValue('flow123');
      mockMCPTokenStorage.forceRefreshTokens.mockResolvedValueOnce(refreshedTokens);
      mockConnectionInstance.isConnected.mockResolvedValue(false);

      let oauthRequiredHandler: (data: Record<string, unknown>) => Promise<void>;
      mockConnectionInstance.on.mockImplementation((event, handler) => {
        if (event === 'oauthRequired') {
          oauthRequiredHandler = handler as (data: Record<string, unknown>) => Promise<void>;
        }
        return mockConnectionInstance;
      });

      try {
        await MCPConnectionFactory.create(basicOptions, oauthOptions);
      } catch {
        // Expected
      }

      await oauthRequiredHandler!({ serverUrl: 'https://api.example.com' });

      expect(mockTenantStorage.run).toHaveBeenCalledWith(capturedContext, expect.any(Function));
      expect(mockMCPTokenStorage.forceRefreshTokens).toHaveBeenCalled();
      expect(mockConnectionInstance.setOAuthTokens).toHaveBeenCalledWith(refreshedTokens);
    });

    it('should NOT delete a PENDING mcp_get_tokens flow after silent refresh', async () => {
      // Regression for the Codex findings around active token-fetch flows:
      // concurrent `getOAuthTokens` callers may be joined to a PENDING
      // `mcp_get_tokens` flow via `monitorFlow`. Deleting it under them makes
      // waiters fail; leaving it alone lets a stale handler publish rejected
      // tokens later. Completing the flow with the fresh tokens solves both.
      const sseConfig = {
        ...mockServerConfig,
        url: 'https://api.example.com',
        type: 'sse' as const,
      } as t.SSEOptions;

      const basicOptions = {
        serverName: 'test-server',
        serverConfig: sseConfig,
      };

      const oauthOptions = {
        useOAuth: true as const,
        user: mockUser,
        flowManager: mockFlowManager,
        oauthStart: jest.fn(),
        tokenMethods: {
          findToken: jest.fn(),
          createToken: jest.fn(),
          updateToken: jest.fn(),
          deleteTokens: jest.fn(),
        },
      };

      const refreshedTokens: MCPOAuthTokens = {
        access_token: 'refreshed-access',
        refresh_token: 'refresh789',
        token_type: 'Bearer',
        obtained_at: Date.now(),
      };

      (getTenantId as jest.Mock).mockReturnValue('tenant-a');
      mockProcessMCPEnv.mockReturnValue(sseConfig);
      mockMCPOAuthHandler.generateFlowId.mockImplementation((_user, _server, tenant) =>
        tenant ? `tenant:${tenant}:flow123` : 'flow123',
      );
      // Mirror the real storage contract: `onRefreshSuccess` runs inside the
      // shared redemption after the rotated tokens are persisted.
      mockMCPTokenStorage.forceRefreshTokens.mockImplementationOnce(async (params) => {
        await params.onRefreshSuccess?.(refreshedTokens);
        return refreshedTokens;
      });
      // A concurrent `getOAuthTokens` for this user/server is currently
      // PENDING — joiners are monitoring it via `monitorFlow`.
      mockFlowManager.getFlowState.mockResolvedValue({
        status: 'PENDING' as const,
        type: 'mcp_get_tokens',
        metadata: {},
        createdAt: Date.now(),
      });
      mockConnectionInstance.isConnected.mockResolvedValue(false);

      let oauthRequiredHandler: (data: Record<string, unknown>) => Promise<void>;
      mockConnectionInstance.on.mockImplementation((event, handler) => {
        if (event === 'oauthRequired') {
          oauthRequiredHandler = handler as (data: Record<string, unknown>) => Promise<void>;
        }
        return mockConnectionInstance;
      });

      try {
        await MCPConnectionFactory.create(basicOptions, oauthOptions);
      } catch {
        // Expected
      }

      await oauthRequiredHandler!({ serverUrl: 'https://api.example.com' });

      expect(mockMCPTokenStorage.forceRefreshTokens).toHaveBeenCalled();
      expect(mockFlowManager.getFlowState).toHaveBeenCalledWith(
        'tenant:tenant-a:flow123',
        'mcp_get_tokens',
      );
      expect(mockFlowManager.completeFlow).toHaveBeenCalledWith(
        'tenant:tenant-a:flow123',
        'mcp_get_tokens',
        refreshedTokens,
      );
      expect(mockFlowManager.deleteFlow).not.toHaveBeenCalledWith(
        'tenant:tenant-a:flow123',
        'mcp_get_tokens',
      );
    });

    it('should invalidate mcp_get_tokens cache after interactive OAuth stores fresh tokens', async () => {
      // Regression for the Codex finding "Invalidate token cache after
      // interactive fallback": when silent refresh fails but interactive OAuth
      // succeeds, the old `mcp_get_tokens` flow cache could otherwise re-serve
      // stale tokens to the next `getOAuthTokens` call.
      const sseConfig = {
        ...mockServerConfig,
        url: 'https://api.example.com',
        type: 'sse' as const,
      } as t.SSEOptions;

      const basicOptions = {
        serverName: 'test-server',
        serverConfig: sseConfig,
      };

      const oauthOptions = {
        useOAuth: true as const,
        user: mockUser,
        flowManager: mockFlowManager,
        oauthStart: jest.fn(),
        oauthEnd: jest.fn(),
        tokenMethods: {
          findToken: jest.fn(),
          createToken: jest.fn(),
          updateToken: jest.fn(),
          deleteTokens: jest.fn(),
        },
      };

      const interactiveTokens: MCPOAuthTokens = {
        access_token: 'interactive-access',
        token_type: 'Bearer',
        obtained_at: Date.now(),
        credential_set_id: 'interactive-generation',
      };

      mockProcessMCPEnv.mockReturnValue(sseConfig);
      mockMCPOAuthHandler.generateFlowId.mockReturnValue('flow123');
      mockMCPTokenStorage.forceRefreshTokens.mockResolvedValueOnce(null);
      mockMCPOAuthHandler.initiateOAuthFlow.mockResolvedValue({
        authorizationUrl: 'https://auth.example.com',
        flowId: 'flow123',
        flowMetadata: {
          serverName: 'test-server',
          userId: 'user123',
          serverUrl: 'https://api.example.com',
          state: 'fresh-csrf-state',
        },
      });
      // First `getFlowState` (from `invalidateCompletedOAuthFlow`): no
      // completed mcp_oauth flow → no-op. Second (from `handleOAuthRequired`):
      // no existing flow either. Final (from `invalidateGetTokensFlow` after
      // interactive store): a COMPLETED `mcp_get_tokens` cache exists and
      // must be cleared so the next `getOAuthTokens` reads fresh tokens.
      mockFlowManager.getFlowState
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({
          status: 'COMPLETED' as const,
          type: 'mcp_get_tokens',
          metadata: {},
          createdAt: Date.now(),
          completedAt: Date.now(),
          result: {
            access_token: 'old-stale',
            token_type: 'Bearer',
            obtained_at: Date.now(),
          } as MCPOAuthTokens,
        });
      mockFlowManager.createFlow.mockResolvedValue(interactiveTokens);
      mockConnectionInstance.isConnected.mockResolvedValue(false);

      let oauthRequiredHandler: (data: Record<string, unknown>) => Promise<void>;
      mockConnectionInstance.on.mockImplementation((event, handler) => {
        if (event === 'oauthRequired') {
          oauthRequiredHandler = handler as (data: Record<string, unknown>) => Promise<void>;
        }
        return mockConnectionInstance;
      });

      try {
        await MCPConnectionFactory.create(basicOptions, oauthOptions);
      } catch {
        // Expected
      }

      await oauthRequiredHandler!({ serverUrl: 'https://api.example.com' });

      expect(mockConnectionInstance.setOAuthTokens).toHaveBeenCalledWith(interactiveTokens);
      // The stale `mcp_get_tokens` cache is cleared so the next
      // `getOAuthTokens` reads the freshly persisted interactive tokens.
      expect(mockFlowManager.deleteFlow).toHaveBeenCalledWith('flow123', 'mcp_get_tokens');
    });

    it('does not persist callback tokens a second time after the route stored them', async () => {
      const sseConfig = {
        ...mockServerConfig,
        url: 'https://api.example.com',
        type: 'sse' as const,
      } as t.SSEOptions;
      const callbackTokens: MCPOAuthTokens = {
        access_token: 'interactive-access',
        token_type: 'Bearer',
        obtained_at: Date.now(),
        credential_set_id: 'callback-generation',
      };
      const oauthOptions = {
        useOAuth: true as const,
        user: mockUser,
        flowManager: mockFlowManager,
        oauthStart: jest.fn(),
        oauthEnd: jest.fn(),
        tokenMethods: {
          findToken: jest.fn(),
          createToken: jest.fn(),
          updateToken: jest.fn(),
          deleteTokens: jest.fn(),
        },
      };

      mockProcessMCPEnv.mockReturnValue(sseConfig);
      mockMCPOAuthHandler.generateFlowId.mockReturnValue('flow123');
      mockMCPTokenStorage.forceRefreshTokens.mockResolvedValueOnce(null);
      mockMCPOAuthHandler.initiateOAuthFlow.mockResolvedValue({
        authorizationUrl: 'https://auth.example.com',
        flowId: 'flow123',
        flowMetadata: {
          serverName: 'test-server',
          userId: 'user123',
          serverUrl: 'https://api.example.com',
          state: 'fresh-csrf-state',
          clientInfo: { client_id: 'client-a' },
          metadata: {
            authorization_endpoint: 'https://auth.example.com/authorize',
            token_endpoint: 'https://auth.example.com/token',
          },
          clientSource: 'dynamic',
        },
      });
      mockFlowManager.getFlowState.mockResolvedValue(null);
      mockFlowManager.createFlow.mockResolvedValue(callbackTokens);
      mockMCPTokenStorage.isCurrentAccessToken.mockResolvedValue(true);
      mockMCPTokenStorage.getClientInfoAndMetadata.mockResolvedValue({
        clientInfo: { client_id: 'client-a' },
        clientMetadata: {
          server_url: 'https://api.example.com',
          credential_set_id: 'callback-generation',
        },
      });
      mockConnectionInstance.isConnected.mockResolvedValue(false);

      let oauthRequiredHandler!: (data: Record<string, unknown>) => Promise<void>;
      mockConnectionInstance.on.mockImplementation((event, handler) => {
        if (event === 'oauthRequired') {
          oauthRequiredHandler = handler as (data: Record<string, unknown>) => Promise<void>;
        }
        return mockConnectionInstance;
      });

      try {
        await MCPConnectionFactory.create(
          { serverName: 'test-server', serverConfig: sseConfig },
          oauthOptions,
        );
      } catch {
        // Expected: the mocked connection never becomes connected.
      }
      await oauthRequiredHandler({ serverUrl: 'https://api.example.com' });

      expect(mockMCPTokenStorage.storeTokens).not.toHaveBeenCalled();
      expect(mockConnectionInstance.setOAuthTokens).toHaveBeenCalledWith(callbackTokens);
      expect(mockConnectionInstance.emit).toHaveBeenCalledWith('oauthHandled', 'interactive');
    });

    it('rejects callback tokens that do not identify a persisted credential generation', async () => {
      const sseConfig = {
        ...mockServerConfig,
        url: 'https://api.example.com',
        type: 'sse' as const,
      } as t.SSEOptions;
      const callbackTokens: MCPOAuthTokens = {
        access_token: 'unbound-interactive-access',
        token_type: 'Bearer',
        obtained_at: Date.now(),
      };
      const oauthOptions = {
        useOAuth: true as const,
        user: mockUser,
        flowManager: mockFlowManager,
        oauthStart: jest.fn(),
        oauthEnd: jest.fn(),
        tokenMethods: {
          findToken: jest.fn(),
          createToken: jest.fn(),
          updateToken: jest.fn(),
          deleteTokens: jest.fn(),
        },
      };

      mockProcessMCPEnv.mockReturnValue(sseConfig);
      mockMCPOAuthHandler.generateFlowId.mockReturnValue('flow123');
      mockMCPTokenStorage.forceRefreshTokens.mockResolvedValueOnce(null);
      mockMCPOAuthHandler.initiateOAuthFlow.mockResolvedValue({
        authorizationUrl: 'https://auth.example.com',
        flowId: 'flow123',
        flowMetadata: {
          serverName: 'test-server',
          userId: 'user123',
          serverUrl: 'https://api.example.com',
          state: 'fresh-csrf-state',
          clientInfo: { client_id: 'client-a' },
          metadata: {
            authorization_endpoint: 'https://auth.example.com/authorize',
            token_endpoint: 'https://auth.example.com/token',
          },
          clientSource: 'dynamic',
        },
      });
      mockFlowManager.getFlowState.mockResolvedValue(null);
      mockFlowManager.createFlow.mockResolvedValue(callbackTokens);
      mockConnectionInstance.isConnected.mockResolvedValue(false);

      let oauthRequiredHandler!: (data: Record<string, unknown>) => Promise<void>;
      mockConnectionInstance.on.mockImplementation((event, handler) => {
        if (event === 'oauthRequired') {
          oauthRequiredHandler = handler as (data: Record<string, unknown>) => Promise<void>;
        }
        return mockConnectionInstance;
      });

      try {
        await MCPConnectionFactory.create(
          { serverName: 'test-server', serverConfig: sseConfig },
          oauthOptions,
        );
      } catch {
        // Expected: the mocked connection never becomes connected.
      }
      await oauthRequiredHandler({ serverUrl: 'https://api.example.com' });

      expect(mockMCPTokenStorage.storeTokens).not.toHaveBeenCalled();
      expect(mockMCPTokenStorage.isCurrentAccessToken).not.toHaveBeenCalled();
      expect(mockMCPTokenStorage.getClientInfoAndMetadata).not.toHaveBeenCalled();
      expect(mockConnectionInstance.setOAuthTokens).not.toHaveBeenCalled();
      expect(mockConnectionInstance.emit).toHaveBeenCalledWith('oauthFailed', expect.any(Error));
      expect(mockConnectionInstance.emit).not.toHaveBeenCalledWith('oauthHandled');
    });

    it('does not resurrect an ID-bearing callback after a newer generation wins', async () => {
      const sseConfig = {
        ...mockServerConfig,
        url: 'https://api.example.com',
        type: 'sse' as const,
      } as t.SSEOptions;
      const callbackTokens: MCPOAuthTokens = {
        access_token: 'stale-interactive-access',
        token_type: 'Bearer',
        obtained_at: Date.now(),
        credential_set_id: 'stale-callback-generation',
      };
      const oauthOptions = {
        useOAuth: true as const,
        user: mockUser,
        flowManager: mockFlowManager,
        oauthStart: jest.fn(),
        oauthEnd: jest.fn(),
        tokenMethods: {
          findToken: jest.fn(),
          createToken: jest.fn(),
          updateToken: jest.fn(),
          deleteTokens: jest.fn(),
        },
      };

      mockProcessMCPEnv.mockReturnValue(sseConfig);
      mockMCPOAuthHandler.generateFlowId.mockReturnValue('flow123');
      mockMCPTokenStorage.forceRefreshTokens.mockResolvedValueOnce(null);
      mockMCPOAuthHandler.initiateOAuthFlow.mockResolvedValue({
        authorizationUrl: 'https://auth.example.com',
        flowId: 'flow123',
        flowMetadata: {
          serverName: 'test-server',
          userId: 'user123',
          serverUrl: 'https://api.example.com',
          state: 'fresh-csrf-state',
          clientInfo: { client_id: 'client-a' },
          metadata: {
            authorization_endpoint: 'https://auth.example.com/authorize',
            token_endpoint: 'https://auth.example.com/token',
          },
          clientSource: 'dynamic',
        },
      });
      mockFlowManager.getFlowState.mockResolvedValue(null);
      mockFlowManager.createFlow.mockResolvedValue(callbackTokens);
      mockMCPTokenStorage.isCurrentAccessToken.mockResolvedValueOnce(false);
      mockMCPTokenStorage.getClientInfoAndMetadata.mockResolvedValue({
        clientInfo: { client_id: 'client-b' },
        clientMetadata: {
          server_url: 'https://api.example.com',
          credential_set_id: 'newer-generation',
        },
      });
      mockConnectionInstance.isConnected.mockResolvedValue(false);

      let oauthRequiredHandler!: (data: Record<string, unknown>) => Promise<void>;
      mockConnectionInstance.on.mockImplementation((event, handler) => {
        if (event === 'oauthRequired') {
          oauthRequiredHandler = handler as (data: Record<string, unknown>) => Promise<void>;
        }
        return mockConnectionInstance;
      });

      try {
        await MCPConnectionFactory.create(
          { serverName: 'test-server', serverConfig: sseConfig },
          oauthOptions,
        );
      } catch {
        // Expected: the mocked connection never becomes connected.
      }
      await oauthRequiredHandler({ serverUrl: 'https://api.example.com' });

      expect(mockMCPTokenStorage.storeTokens).not.toHaveBeenCalled();
      expect(mockConnectionInstance.setOAuthTokens).not.toHaveBeenCalled();
      expect(mockConnectionInstance.emit).toHaveBeenCalledWith('oauthFailed', expect.any(Error));
      expect(mockConnectionInstance.emit).not.toHaveBeenCalledWith('oauthHandled');
    });

    it('rejects already-persisted callback tokens when the server binding changed', async () => {
      const sseConfig = {
        ...mockServerConfig,
        url: 'https://current.example.com/mcp',
        type: 'sse' as const,
      } as t.SSEOptions;
      const callbackTokens: MCPOAuthTokens = {
        access_token: 'interactive-access',
        token_type: 'Bearer',
        obtained_at: Date.now(),
        credential_set_id: 'callback-generation',
      };
      const bindingError = new Error('stale OAuth server binding');
      const oauthOptions = {
        useOAuth: true as const,
        user: mockUser,
        flowManager: mockFlowManager,
        oauthStart: jest.fn(),
        oauthEnd: jest.fn(),
        tokenMethods: {
          findToken: jest.fn(),
          createToken: jest.fn(),
          updateToken: jest.fn(),
          deleteTokens: jest.fn(),
        },
      };

      mockProcessMCPEnv.mockReturnValue(sseConfig);
      mockMCPOAuthHandler.generateFlowId.mockReturnValue('flow123');
      mockMCPTokenStorage.forceRefreshTokens.mockResolvedValueOnce(null);
      mockMCPOAuthHandler.initiateOAuthFlow.mockResolvedValue({
        authorizationUrl: 'https://auth.example.com',
        flowId: 'flow123',
        flowMetadata: {
          serverName: 'test-server',
          userId: 'user123',
          serverUrl: 'https://old.example.com/mcp',
          state: 'fresh-csrf-state',
          clientInfo: { client_id: 'client-a' },
          metadata: {
            authorization_endpoint: 'https://auth.example.com/authorize',
            token_endpoint: 'https://auth.example.com/token',
          },
          clientSource: 'dynamic',
        },
      });
      mockFlowManager.getFlowState.mockResolvedValue(null);
      mockFlowManager.createFlow.mockResolvedValue(callbackTokens);
      mockMCPTokenStorage.isCurrentAccessToken.mockResolvedValue(true);
      mockMCPTokenStorage.getClientInfoAndMetadata.mockResolvedValue({
        clientInfo: { client_id: 'client-a' },
        clientMetadata: {
          server_url: 'https://old.example.com/mcp',
          credential_set_id: 'callback-generation',
        },
      });
      mockMCPOAuthHandler.assertStoredClientBinding.mockImplementationOnce(() => {
        throw bindingError;
      });
      mockConnectionInstance.isConnected.mockResolvedValue(false);

      let oauthRequiredHandler!: (data: Record<string, unknown>) => Promise<void>;
      mockConnectionInstance.on.mockImplementation((event, handler) => {
        if (event === 'oauthRequired') {
          oauthRequiredHandler = handler as (data: Record<string, unknown>) => Promise<void>;
        }
        return mockConnectionInstance;
      });

      try {
        await MCPConnectionFactory.create(
          { serverName: 'test-server', serverConfig: sseConfig },
          oauthOptions,
        );
      } catch {
        // Expected: the mocked connection never becomes connected.
      }
      await oauthRequiredHandler({ serverUrl: 'https://current.example.com/mcp' });

      expect(mockMCPTokenStorage.storeTokens).not.toHaveBeenCalled();
      expect(mockConnectionInstance.setOAuthTokens).not.toHaveBeenCalled();
      expect(mockConnectionInstance.emit).toHaveBeenCalledWith('oauthFailed', bindingError);
      expect(mockConnectionInstance.emit).not.toHaveBeenCalledWith('oauthHandled');
    });

    it('should complete PENDING token waiters with the persisted interactive credential generation', async () => {
      const sseConfig = {
        ...mockServerConfig,
        url: 'https://api.example.com',
        type: 'sse' as const,
      } as t.SSEOptions;
      const basicOptions = {
        serverName: 'test-server',
        serverConfig: sseConfig,
      };
      const oauthOptions = {
        useOAuth: true as const,
        user: mockUser,
        flowManager: mockFlowManager,
        oauthStart: jest.fn(),
        oauthEnd: jest.fn(),
        tokenMethods: {
          findToken: jest.fn(),
          createToken: jest.fn(),
          updateToken: jest.fn(),
          deleteTokens: jest.fn(),
        },
      };
      const callbackTokens: MCPOAuthTokens = {
        access_token: 'interactive-access',
        token_type: 'Bearer',
        obtained_at: Date.now(),
        credential_set_id: 'persisted-generation',
      };

      mockProcessMCPEnv.mockReturnValue(sseConfig);
      mockMCPOAuthHandler.generateFlowId.mockReturnValue('flow123');
      mockMCPTokenStorage.forceRefreshTokens.mockResolvedValueOnce(null);
      mockMCPOAuthHandler.initiateOAuthFlow.mockResolvedValue({
        authorizationUrl: 'https://auth.example.com',
        flowId: 'flow123',
        flowMetadata: {
          serverName: 'test-server',
          userId: 'user123',
          serverUrl: 'https://api.example.com',
          state: 'fresh-csrf-state',
        },
      });
      mockFlowManager.getFlowState
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({
          status: 'PENDING' as const,
          type: 'mcp_get_tokens',
          metadata: {},
          createdAt: Date.now(),
        });
      mockFlowManager.createFlow.mockResolvedValue(callbackTokens);
      mockConnectionInstance.isConnected.mockResolvedValue(false);

      let oauthRequiredHandler: (data: Record<string, unknown>) => Promise<void>;
      mockConnectionInstance.on.mockImplementation((event, handler) => {
        if (event === 'oauthRequired') {
          oauthRequiredHandler = handler as (data: Record<string, unknown>) => Promise<void>;
        }
        return mockConnectionInstance;
      });

      try {
        await MCPConnectionFactory.create(basicOptions, oauthOptions);
      } catch {
        // Expected
      }
      await oauthRequiredHandler!({ serverUrl: 'https://api.example.com' });

      expect(mockMCPTokenStorage.storeTokens).not.toHaveBeenCalled();
      expect(mockFlowManager.completeFlow).toHaveBeenCalledWith(
        'flow123',
        'mcp_get_tokens',
        callbackTokens,
      );
      expect(mockFlowManager.deleteFlow).not.toHaveBeenCalledWith('flow123', 'mcp_get_tokens');
    });
  });

  describe('connection retry logic', () => {
    it('should establish connection successfully', async () => {
      const basicOptions = {
        serverName: 'test-server',
        serverConfig: mockServerConfig, // Use default 5000ms timeout
      };

      mockConnectionInstance.connect.mockResolvedValue(undefined);
      mockConnectionInstance.isConnected.mockResolvedValue(true);

      const connection = await MCPConnectionFactory.create(basicOptions);

      expect(connection).toBe(mockConnectionInstance);
      expect(mockConnectionInstance.connect).toHaveBeenCalledTimes(1);
    });

    it('should handle OAuth errors during connection attempts', async () => {
      const basicOptions = {
        serverName: 'test-server',
        serverConfig: mockServerConfig,
      };

      const oauthOptions = {
        useOAuth: true as const,
        user: mockUser,
        flowManager: mockFlowManager,
        oauthStart: jest.fn(),
        tokenMethods: {
          findToken: jest.fn(),
          createToken: jest.fn(),
          updateToken: jest.fn(),
          deleteTokens: jest.fn(),
        },
      };

      const oauthError = new Error('Non-200 status code (401)');
      (oauthError as unknown as Record<string, unknown>).isOAuthError = true;

      mockConnectionInstance.connect.mockRejectedValue(oauthError);
      mockConnectionInstance.isConnected.mockResolvedValue(false);

      await expect(MCPConnectionFactory.create(basicOptions, oauthOptions)).rejects.toThrow(
        'Non-200 status code (401)',
      );

      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.stringContaining('OAuth required, stopping connection attempts'),
      );
    });
  });

  describe('isOAuthError method', () => {
    it('should identify OAuth errors by message content', async () => {
      const basicOptions = {
        serverName: 'test-server',
        serverConfig: mockServerConfig,
      };

      const oauthOptions = {
        useOAuth: true as const,
        user: mockUser,
        flowManager: mockFlowManager,
        tokenMethods: {
          findToken: jest.fn(),
          createToken: jest.fn(),
          updateToken: jest.fn(),
          deleteTokens: jest.fn(),
        },
      };

      const error401 = new Error('401 Unauthorized');

      mockConnectionInstance.connect.mockRejectedValue(error401);
      mockConnectionInstance.isConnected.mockResolvedValue(false);

      await expect(MCPConnectionFactory.create(basicOptions, oauthOptions)).rejects.toThrow('401');
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.stringContaining('OAuth required, stopping connection attempts'),
      );
    });

    it('should identify "no authorization" errors as OAuth errors (HTTP 400)', async () => {
      const basicOptions = {
        serverName: 'test-server',
        serverConfig: mockServerConfig,
      };

      const oauthOptions = {
        useOAuth: true as const,
        user: mockUser,
        flowManager: mockFlowManager,
        tokenMethods: {
          findToken: jest.fn(),
          createToken: jest.fn(),
          updateToken: jest.fn(),
          deleteTokens: jest.fn(),
        },
      };

      const noAuthError = new Error(
        'Either no authorization values are specified or it could not be derived from the request',
      );

      mockConnectionInstance.connect.mockRejectedValue(noAuthError);
      mockConnectionInstance.isConnected.mockResolvedValue(false);

      await expect(MCPConnectionFactory.create(basicOptions, oauthOptions)).rejects.toThrow(
        'no authorization',
      );
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.stringContaining('OAuth required, stopping connection attempts'),
      );
    });

    it('should identify invalid_grant errors as OAuth errors', async () => {
      const basicOptions = {
        serverName: 'test-server',
        serverConfig: mockServerConfig,
      };

      const oauthOptions = {
        useOAuth: true as const,
        user: mockUser,
        flowManager: mockFlowManager,
        tokenMethods: {
          findToken: jest.fn(),
          createToken: jest.fn(),
          updateToken: jest.fn(),
          deleteTokens: jest.fn(),
        },
      };

      const invalidGrantError = new Error(
        'Streamable HTTP error: Error POSTing to endpoint: {"error":"invalid_grant"}',
      );

      mockConnectionInstance.connect.mockRejectedValue(invalidGrantError);
      mockConnectionInstance.isConnected.mockResolvedValue(false);

      await expect(MCPConnectionFactory.create(basicOptions, oauthOptions)).rejects.toThrow(
        'invalid_grant',
      );
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.stringContaining('OAuth required, stopping connection attempts'),
      );
    });
  });

  describe('declared identity across connection transformations', () => {
    it.each(['create', 'discoverTools'] as const)(
      '%s retains the callback identity while transforming only wire headers',
      async (entry) => {
        const declared: t.ParsedServerConfig = {
          type: 'streamable-http',
          url: 'https://mcp.example.com',
          source: 'yaml',
          headers: { 'X-Workspace': 'catalog' },
          requestHeaders: { 'X-Workspace': 'chat' },
        };
        let definition: t.MCPOptions | undefined;
        let wireConfig: t.MCPOptions | undefined;
        class IdentityFactory extends MCPConnectionFactory {
          protected async createConnection(): Promise<MCPConnection> {
            definition = this.serverDefinition;
            wireConfig = this.serverConfig;
            return mockConnectionInstance;
          }

          protected async discoverToolsInternal() {
            await this.createConnection();
            return { tools: [], connection: null, oauthRequired: false, oauthUrl: null };
          }
        }
        mockProcessMCPEnv.mockImplementation(({ options }) => options);
        await IdentityFactory[entry]({ serverName: 'identity', serverConfig: declared });
        expect(definition).toBe(declared);
        expect(getMCPServerGeneration(definition!)).toBe(getMCPServerGeneration(declared));
        expect(wireConfig).not.toHaveProperty('requestHeaders');
        expect(wireConfig).toMatchObject({
          headers: { 'X-Workspace': entry === 'create' ? 'chat' : 'catalog' },
        });
      },
    );
  });

  describe('discoverTools static method', () => {
    const mockTools = [
      { name: 'tool1', description: 'First tool', inputSchema: { type: 'object' } },
      { name: 'tool2', description: 'Second tool', inputSchema: { type: 'object' } },
    ];

    it('preserves public tool listing without a redundant OAuth connect when tokens are absent', async () => {
      const serverConfig = {
        type: 'streamable-http' as const,
        url: 'https://mcp.example.com',
        requiresOAuth: true,
      };
      mockProcessMCPEnv.mockImplementation(({ options }) => options);
      mockFlowManager.createFlowWithHandler.mockResolvedValue(null);
      mockConnectionInstance.connect.mockResolvedValue(undefined);
      mockConnectionInstance.isConnected.mockResolvedValue(true);
      mockConnectionInstance.fetchOrderedToolsSnapshot = jest.fn().mockResolvedValue({
        tools: mockTools,
        complete: true,
      });

      const result = await MCPConnectionFactory.discoverTools(
        { serverName: 'public-oauth', serverConfig },
        {
          useOAuth: true,
          user: mockUser!,
          flowManager: mockFlowManager,
          tokenMethods: {
            findToken: jest.fn(),
            createToken: jest.fn(),
            replaceTokenIfCurrent: jest.fn(),
            updateToken: jest.fn(),
            deleteTokens: jest.fn(),
          },
        },
      );

      expect(result.tools).toEqual(mockTools);
      expect(result.oauthRequired).toBe(true);
      expect(mockMCPConnection).toHaveBeenCalledTimes(1);
      expect(mockConnectionInstance.connect).toHaveBeenCalledTimes(1);
    });

    it('should discover tools from a successfully connected server', async () => {
      const basicOptions = {
        serverName: 'test-server',
        serverConfig: mockServerConfig,
      };

      mockConnectionInstance.connect.mockResolvedValue(undefined);
      mockConnectionInstance.isConnected.mockResolvedValue(true);
      mockConnectionInstance.fetchOrderedToolsSnapshot = jest
        .fn()
        .mockResolvedValue({ tools: mockTools, complete: true });

      const result = await MCPConnectionFactory.discoverTools(basicOptions);

      expect(result.tools).toEqual(mockTools);
      expect(result.oauthRequired).toBe(false);
      expect(result.oauthUrl).toBeNull();
      expect(result.connection).toBe(mockConnectionInstance);
    });

    it('forces one direct bearer refresh when the initial connection handshake rejects it', async () => {
      const authError = Object.assign(new Error('unauthorized'), { status: 401 });
      const rejectedConnection = {
        ...mockConnectionInstance,
        connect: jest.fn().mockRejectedValue(authError),
        dispose: jest.fn().mockResolvedValue(undefined),
      } as unknown as jest.Mocked<MCPConnection>;
      const refreshedConnection = {
        ...mockConnectionInstance,
        connect: jest.fn().mockResolvedValue(undefined),
        isConnected: jest.fn().mockResolvedValue(true),
      } as unknown as jest.Mocked<MCPConnection>;
      mockMCPConnection
        .mockImplementationOnce(() => rejectedConnection)
        .mockImplementationOnce(() => refreshedConnection);
      mockProcessMCPEnv.mockImplementation(({ options }) => options);
      const upstreamTokenProvider = jest.fn().mockResolvedValue({ access_token: 'fresh-token' });
      const directBearerSourceConfig = {
        type: 'streamable-http' as const,
        url: 'https://mcp.example.com',
        source: 'yaml' as const,
        headers: { Authorization: 'Bearer {{LIBRECHAT_OPENID_ACCESS_TOKEN}}' },
      } as t.MCPOptions;
      const serverConfig = {
        ...directBearerSourceConfig,
        headers: { Authorization: 'Bearer stale-token' },
      } as t.MCPOptions;
      const directBearerRecoveryState: t.DirectBearerRecoveryState = { attempted: false };

      const connection = await MCPConnectionFactory.create(
        {
          serverName: 'direct-bearer',
          serverConfig,
          directBearerSourceConfig,
          directBearerRecoveryState,
        },
        { user: mockUser, upstreamTokenProvider },
      );

      expect(connection).toBe(refreshedConnection);
      expect(rejectedConnection.connect).toHaveBeenCalledTimes(1);
      expect(rejectedConnection.dispose).toHaveBeenCalledTimes(1);
      expect(upstreamTokenProvider).toHaveBeenCalledTimes(1);
      expect(upstreamTokenProvider).toHaveBeenCalledWith({ forceRefresh: true });
      expect(directBearerRecoveryState.resolvedConfig).toMatchObject({
        headers: { Authorization: 'Bearer fresh-token' },
      });
      expect(mockMCPConnection).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          serverConfig: expect.objectContaining({
            headers: { Authorization: 'Bearer fresh-token' },
          }),
          directBearerRecoveryEnabled: true,
        }),
      );
    });

    it('treats a replacement handshake rejection as terminal without refreshing again', async () => {
      const authError = Object.assign(new Error('unauthorized'), { status: 401 });
      const rejectedConnection = {
        ...mockConnectionInstance,
        connect: jest.fn().mockRejectedValue(authError),
        dispose: jest.fn().mockResolvedValue(undefined),
      } as unknown as jest.Mocked<MCPConnection>;
      mockMCPConnection.mockImplementationOnce(() => rejectedConnection);
      mockProcessMCPEnv.mockImplementation(({ options }) => options);
      const upstreamTokenProvider = jest.fn();
      const directBearerSourceConfig = {
        type: 'streamable-http' as const,
        url: 'https://mcp.example.com',
        source: 'yaml' as const,
        headers: { Authorization: 'Bearer {{LIBRECHAT_OPENID_ACCESS_TOKEN}}' },
      } as t.MCPOptions;

      await expect(
        MCPConnectionFactory.create(
          {
            serverName: 'direct-bearer',
            serverConfig: {
              type: 'streamable-http',
              url: 'https://mcp.example.com',
              source: 'yaml',
              headers: { Authorization: 'Bearer refreshed-token' },
            } as t.MCPOptions,
            directBearerSourceConfig,
            directBearerRecoveryState: { attempted: true },
          },
          { user: mockUser, upstreamTokenProvider },
        ),
      ).rejects.toMatchObject({
        code: 'MCP_AUTHENTICATION_REJECTED',
        connectionRefreshed: false,
      } satisfies Partial<MCPAuthenticationRejectedError>);

      expect(mockMCPConnection).toHaveBeenCalledTimes(1);
      expect(upstreamTokenProvider).not.toHaveBeenCalled();
    });

    it('replaces one direct OpenID bearer connection and rediscovers after tools/list rejects it', async () => {
      const staleError = Object.assign(new Error('unauthorized'), { status: 401 });
      const firstConnection = {
        ...mockConnectionInstance,
        connect: jest.fn().mockResolvedValue(undefined),
        isConnected: jest.fn().mockResolvedValue(true),
        fetchOrderedToolsSnapshot: jest.fn().mockResolvedValue({
          tools: [],
          complete: false,
          authenticationError: staleError,
        }),
        dispose: jest.fn().mockResolvedValue(undefined),
      } as unknown as jest.Mocked<MCPConnection>;
      const refreshedConnection = {
        ...mockConnectionInstance,
        connect: jest.fn().mockResolvedValue(undefined),
        isConnected: jest.fn().mockResolvedValue(true),
        fetchOrderedToolsSnapshot: jest
          .fn()
          .mockResolvedValue({ tools: mockTools, complete: true }),
      } as unknown as jest.Mocked<MCPConnection>;
      mockMCPConnection
        .mockImplementationOnce(() => firstConnection)
        .mockImplementationOnce(() => refreshedConnection);
      mockProcessMCPEnv.mockImplementation(({ options }) => options);
      const upstreamTokenProvider = jest
        .fn()
        .mockResolvedValueOnce({ access_token: 'stale-token' })
        .mockResolvedValueOnce({ access_token: 'fresh-token' });
      const serverConfig = {
        type: 'streamable-http' as const,
        url: 'https://mcp.example.com',
        source: 'yaml' as const,
        headers: { Authorization: 'Bearer {{LIBRECHAT_OPENID_ACCESS_TOKEN}}' },
      } as t.MCPOptions;

      const result = await MCPConnectionFactory.discoverTools(
        { serverName: 'direct-bearer', serverConfig },
        { user: mockUser, upstreamTokenProvider },
      );

      expect(result.tools).toEqual(mockTools);
      expect(firstConnection.dispose).toHaveBeenCalledTimes(1);
      expect(upstreamTokenProvider).toHaveBeenNthCalledWith(1, { forceRefresh: false });
      expect(upstreamTokenProvider).toHaveBeenNthCalledWith(2, { forceRefresh: true });
      expect(mockMCPConnection).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          serverConfig: expect.objectContaining({
            headers: { Authorization: 'Bearer fresh-token' },
          }),
        }),
      );
    });

    it('returns a terminal auth outcome after the replacement discovery is also rejected', async () => {
      const authError = Object.assign(new Error('unauthorized'), { status: 401 });
      const rejectedConnection = (): jest.Mocked<MCPConnection> =>
        ({
          ...mockConnectionInstance,
          connect: jest.fn().mockResolvedValue(undefined),
          isConnected: jest.fn().mockResolvedValue(true),
          fetchOrderedToolsSnapshot: jest.fn().mockResolvedValue({
            tools: [],
            complete: false,
            authenticationError: authError,
          }),
          dispose: jest.fn().mockResolvedValue(undefined),
        }) as unknown as jest.Mocked<MCPConnection>;
      mockMCPConnection
        .mockImplementationOnce(() => rejectedConnection())
        .mockImplementationOnce(() => rejectedConnection());
      mockProcessMCPEnv.mockImplementation(({ options }) => options);
      const upstreamTokenProvider = jest
        .fn()
        .mockResolvedValueOnce({ access_token: 'stale-token' })
        .mockResolvedValueOnce({ access_token: 'fresh-token' });
      const serverConfig = {
        type: 'streamable-http' as const,
        url: 'https://mcp.example.com',
        source: 'yaml' as const,
        headers: { Authorization: 'Bearer {{LIBRECHAT_OPENID_ACCESS_TOKEN}}' },
      } as t.MCPOptions;

      await expect(
        MCPConnectionFactory.discoverTools(
          { serverName: 'direct-bearer', serverConfig },
          { user: mockUser, upstreamTokenProvider },
        ),
      ).rejects.toBeInstanceOf(MCPAuthenticationRejectedError);
      expect(upstreamTokenProvider).toHaveBeenCalledTimes(2);
      expect(mockMCPConnection).toHaveBeenCalledTimes(2);
    });

    it('does not force-refresh after an authentication rejection when discovery was cancelled', async () => {
      const controller = new AbortController();
      const authError = Object.assign(new Error('unauthorized'), { status: 401 });
      const rejectedConnection = {
        ...mockConnectionInstance,
        connect: jest.fn().mockResolvedValue(undefined),
        isConnected: jest.fn().mockResolvedValue(true),
        fetchOrderedToolsSnapshot: jest.fn().mockImplementation(async () => {
          controller.abort();
          return { tools: [], complete: false, authenticationError: authError };
        }),
        dispose: jest.fn().mockResolvedValue(undefined),
      } as unknown as jest.Mocked<MCPConnection>;
      mockMCPConnection.mockImplementationOnce(() => rejectedConnection);
      mockProcessMCPEnv.mockImplementation(({ options }) => options);
      const upstreamTokenProvider = jest.fn().mockResolvedValue({ access_token: 'stale-token' });
      const serverConfig = {
        type: 'streamable-http' as const,
        url: 'https://mcp.example.com',
        source: 'yaml' as const,
        headers: { Authorization: 'Bearer {{LIBRECHAT_OPENID_ACCESS_TOKEN}}' },
      } as t.MCPOptions;

      const result = await MCPConnectionFactory.discoverTools(
        { serverName: 'direct-bearer', serverConfig },
        { user: mockUser, upstreamTokenProvider, signal: controller.signal },
      );

      expect(result.tools).toBeNull();
      expect(upstreamTokenProvider).toHaveBeenCalledTimes(1);
      expect(upstreamTokenProvider).not.toHaveBeenCalledWith({ forceRefresh: true });
      expect(mockMCPConnection).toHaveBeenCalledTimes(1);
    });

    it('records OAuth rejection when tools/list fails after a successful handshake', async () => {
      mockFlowManager.createFlowWithHandler.mockResolvedValue({
        access_token: 'rejected-access',
        token_type: 'Bearer',
        obtained_at: Date.now(),
        credential_set_id: 'rejected-generation',
      });
      mockConnectionInstance.connect.mockResolvedValue(undefined);
      mockConnectionInstance.isConnected.mockResolvedValue(true);
      mockConnectionInstance.fetchOrderedToolsSnapshot = jest.fn().mockResolvedValue({
        tools: [],
        complete: false,
        authenticationError: Object.assign(new Error('unauthorized'), { status: 401 }),
      });
      const result = await MCPConnectionFactory.discoverTools(
        { serverName: 'test-server', serverConfig: mockServerConfig },
        {
          useOAuth: true,
          user: mockUser,
          flowManager: mockFlowManager,
          tokenMethods: {
            findToken: jest.fn(),
            createToken: jest.fn(),
            replaceTokenIfCurrent: jest.fn(),
            updateToken: jest.fn(),
            deleteTokens: jest.fn(),
          },
        },
      );

      expect(result.oauthRequired).toBe(true);
      expect(result.tools).toBeNull();
      expect(mockMCPTokenStorage.markAuthorizationRejected).toHaveBeenCalledWith(
        expect.objectContaining({ credentialSetId: 'rejected-generation' }),
      );
    });

    it('does not expose an incomplete discovery snapshot as authoritative', async () => {
      const basicOptions = {
        serverName: 'test-server',
        serverConfig: mockServerConfig,
      };

      mockConnectionInstance.connect.mockResolvedValue(undefined);
      mockConnectionInstance.isConnected.mockResolvedValue(true);
      mockConnectionInstance.fetchOrderedToolsSnapshot = jest.fn().mockResolvedValue({
        tools: [mockTools[0]],
        complete: false,
      });

      const result = await MCPConnectionFactory.discoverTools(basicOptions);

      expect(result.tools).toBeNull();
      expect(result.connection).toBe(mockConnectionInstance);
    });

    it('should forward user context to processMCPEnv for non-OAuth discovery', async () => {
      const serverConfig: t.MCPOptions = {
        type: 'streamable-http',
        url: 'https://my-mcp.server.com?key={{MY_CUSTOM_KEY}}',
      } as t.MCPOptions;

      const basicOptions = {
        serverName: 'test-server',
        serverConfig,
      };

      const userContext = {
        user: mockUser,
        customUserVars: { MY_CUSTOM_KEY: 'c527bd0abc123' },
        connectionTimeout: 10000,
      };

      mockConnectionInstance.connect.mockResolvedValue(undefined);
      mockConnectionInstance.isConnected.mockResolvedValue(true);
      mockConnectionInstance.fetchOrderedToolsSnapshot = jest
        .fn()
        .mockResolvedValue({ tools: mockTools, complete: true });

      const result = await MCPConnectionFactory.discoverTools(basicOptions, userContext);

      expect(result.tools).toEqual(mockTools);
      expect(mockProcessMCPEnv).toHaveBeenCalledWith(
        expect.objectContaining({
          user: mockUser,
          options: serverConfig,
          customUserVars: { MY_CUSTOM_KEY: 'c527bd0abc123' },
        }),
      );
    });

    it('should detect OAuth required without generating URL in discovery mode', async () => {
      const basicOptions = {
        serverName: 'test-server',
        serverConfig: {
          ...mockServerConfig,
          url: 'https://api.example.com',
          type: 'sse' as const,
        } as t.SSEOptions,
      };

      const mockOAuthStart = jest.fn().mockResolvedValue(undefined);

      const oauthOptions = {
        useOAuth: true as const,
        user: mockUser as unknown as IUser,
        flowManager: mockFlowManager,
        oauthStart: mockOAuthStart,
        tokenMethods: {
          findToken: jest.fn(),
          createToken: jest.fn(),
          updateToken: jest.fn(),
          deleteTokens: jest.fn(),
        },
      };

      mockConnectionInstance.isConnected.mockResolvedValue(false);
      mockConnectionInstance.disconnect = jest.fn().mockResolvedValue(undefined);

      let oauthHandler: (() => void) | undefined;
      mockConnectionInstance.once.mockImplementation((event, handler) => {
        if (event === 'oauthRequired') {
          oauthHandler = handler as () => void;
        }
        return mockConnectionInstance;
      });

      mockConnectionInstance.connect.mockImplementation(async () => {
        if (oauthHandler) {
          oauthHandler();
        }
        throw new Error('OAuth required');
      });

      const result = await MCPConnectionFactory.discoverTools(basicOptions, oauthOptions);

      expect(result.connection).toBeNull();
      expect(result.tools).toBeNull();
      expect(result.oauthRequired).toBe(true);
      expect(result.oauthUrl).toBeNull();
      expect(mockOAuthStart).not.toHaveBeenCalled();
    });

    it('should fast-fail discovery when non-OAuth server returns 401', async () => {
      const basicOptions = {
        serverName: 'github',
        serverConfig: {
          ...mockServerConfig,
          url: 'https://api.githubcopilot.com/mcp/',
          type: 'streamable-http' as const,
          initTimeout: 30000,
        } as t.StreamableHTTPOptions,
      };

      mockConnectionInstance.isConnected.mockResolvedValue(false);
      mockConnectionInstance.disconnect = jest.fn().mockResolvedValue(undefined);

      let oauthHandler: (() => void) | undefined;
      mockConnectionInstance.once.mockImplementation((event, handler) => {
        if (event === 'oauthRequired') {
          oauthHandler = handler as () => void;
        }
        return mockConnectionInstance;
      });

      mockConnectionInstance.connect.mockImplementation(async () => {
        if (oauthHandler) {
          oauthHandler();
        }
        throw Object.assign(new Error('unauthorized'), { code: 401 });
      });

      const start = Date.now();
      const result = await MCPConnectionFactory.discoverTools(basicOptions);
      const elapsed = Date.now() - start;

      expect(elapsed).toBeLessThan(5000);
      expect(result.tools).toBeNull();
      expect(result.oauthRequired).toBe(true);
      expect(result.oauthUrl).toBeNull();
      expect(result.connection).toBeNull();
    });

    it('should degrade OBO resolution failures to unauthenticated discovery', async () => {
      const { resolveOboToken } = jest.requireMock('~/mcp/oauth') as {
        resolveOboToken: jest.Mock;
      };
      const serverConfig = {
        type: 'sse' as const,
        url: 'https://obo.example.com',
        requiresOAuth: false,
        obo: { scopes: 'api://obo-server/Mcp.Tools.ReadWrite' },
      } as unknown as t.MCPOptions;
      const oboError = new OboTokenResolutionError(
        'session_refresh_failed',
        'Your sign-in session expired and could not be refreshed. Please sign in again.',
      );

      mockProcessMCPEnv.mockReturnValue(serverConfig);
      resolveOboToken.mockRejectedValueOnce(oboError);
      mockConnectionInstance.connect.mockResolvedValue(undefined);
      mockConnectionInstance.isConnected.mockResolvedValue(true);
      mockConnectionInstance.fetchOrderedToolsSnapshot = jest.fn().mockResolvedValue({
        tools: mockTools,
        complete: true,
      });
      mockConnectionInstance.dispose = jest.fn().mockResolvedValue(undefined);

      const result = await MCPConnectionFactory.discoverTools(
        { serverName: 'obo-srv', serverConfig },
        {
          useOAuth: true,
          user: mockUser as IUser,
          flowManager: mockFlowManager,
          tokenMethods: {
            findToken: jest.fn(),
            createToken: jest.fn(),
            replaceTokenIfCurrent: jest.fn(),
            updateToken: jest.fn(),
            deleteTokens: jest.fn(),
          },
          oboTokenResolver: jest.fn(),
          upstreamTokenProvider: jest.fn(),
        },
      );

      expect(result.tools).toEqual(mockTools);
      expect(result.connection).toBeNull();
      expect(result.oauthRequired).toBe(true);
      expect(result.oauthUrl).toBeNull();
      expect(mockMCPConnection).toHaveBeenCalledTimes(1);
      expect(mockMCPConnection).toHaveBeenCalledWith(
        expect.objectContaining({
          oauthTokens: null,
        }),
      );
      expect(mockLogger.debug).toHaveBeenCalledWith(
        expect.stringContaining(
          '[Discovery] OBO token resolution failed, attempting unauthenticated tool listing',
        ),
        oboError,
      );
    });

    it('should return null tools when discovery fails completely', async () => {
      const basicOptions = {
        serverName: 'test-server',
        serverConfig: mockServerConfig,
      };

      mockConnectionInstance.connect.mockRejectedValue(new Error('Connection failed'));
      mockConnectionInstance.isConnected.mockResolvedValue(false);
      mockConnectionInstance.disconnect = jest.fn().mockResolvedValue(undefined);

      const result = await MCPConnectionFactory.discoverTools(basicOptions);

      expect(result.tools).toBeNull();
      expect(result.connection).toBeNull();
      expect(result.oauthRequired).toBe(false);
    });

    it('should handle disconnect errors gracefully during cleanup', async () => {
      const basicOptions = {
        serverName: 'test-server',
        serverConfig: mockServerConfig,
      };

      mockConnectionInstance.connect.mockRejectedValue(new Error('Connection failed'));
      mockConnectionInstance.isConnected.mockResolvedValue(false);
      mockConnectionInstance.disconnect = jest
        .fn()
        .mockRejectedValue(new Error('Disconnect failed'));

      const result = await MCPConnectionFactory.discoverTools(basicOptions);

      expect(result.tools).toBeNull();
      expect(mockLogger.debug).toHaveBeenCalled();
    });

    describe('deadline bounding', () => {
      /** Builds distinct per-construction connection mocks so the authenticated attempt and the
       *  unauthenticated fallback can be told apart, recording lifecycle order across both. */
      const trackConnections = (events: string[]) => {
        let index = 0;
        mockMCPConnection.mockImplementation(() => {
          const label = index++ === 0 ? 'auth' : 'unauth';
          const instance = {
            connect: jest.fn(async () => {
              events.push(`${label}:connect`);
              throw new Error('Connection failed');
            }),
            isConnected: jest.fn().mockResolvedValue(false),
            setOAuthTokens: jest.fn(),
            getOAuthCredentialSetId: jest.fn().mockReturnValue('rejected-generation'),
            on: jest.fn(),
            once: jest.fn(),
            off: jest.fn(),
            removeListener: jest.fn(),
            emit: jest.fn(),
            dispose: jest.fn(async () => {
              events.push(`${label}:dispose`);
            }),
          } as unknown as jest.Mocked<MCPConnection>;
          return instance;
        });
      };

      it('disposes the authenticated attempt before the fallback opens a second connection', async () => {
        const events: string[] = [];
        trackConnections(events);

        const result = await MCPConnectionFactory.discoverTools({
          serverName: 'test-server',
          serverConfig: mockServerConfig,
        });

        expect(result.tools).toBeNull();
        expect(events).toEqual([
          'auth:connect',
          'auth:dispose',
          'unauth:connect',
          'unauth:dispose',
        ]);
      });

      it('skips discovery entirely once the deadline has passed', async () => {
        const events: string[] = [];
        trackConnections(events);

        const result = await MCPConnectionFactory.discoverTools(
          { serverName: 'test-server', serverConfig: mockServerConfig },
          { deadlineMs: Date.now() - 1 },
        );

        expect(result.tools).toBeNull();
        expect(events).toEqual([]);
        expect(mockMCPConnection).not.toHaveBeenCalled();
        expect(mockPreProcessGraphTokens).not.toHaveBeenCalled();
      });

      it('stops before token resolution when the budget expires during credential preparation', async () => {
        const events: string[] = [];
        trackConnections(events);
        mockPreProcessGraphTokens.mockImplementationOnce(async (options) => {
          await new Promise((resolve) => setTimeout(resolve, 60));
          return options;
        });

        const result = await MCPConnectionFactory.discoverTools(
          { serverName: 'test-server', serverConfig: mockServerConfig },
          { deadlineMs: Date.now() + 20, graphTokenResolver: jest.fn() },
        );

        expect(result.tools).toBeNull();
        expect(events).toEqual([]);
        expect(mockMCPConnection).not.toHaveBeenCalled();
      });

      it('skips discovery entirely for a caller whose signal is already aborted', async () => {
        const events: string[] = [];
        trackConnections(events);
        const controller = new AbortController();
        controller.abort();

        const result = await MCPConnectionFactory.discoverTools(
          { serverName: 'test-server', serverConfig: mockServerConfig },
          { signal: controller.signal },
        );

        expect(result.tools).toBeNull();
        expect(events).toEqual([]);
        expect(mockMCPConnection).not.toHaveBeenCalled();
        expect(mockPreProcessGraphTokens).not.toHaveBeenCalled();
      });

      it('stops before connecting when the caller aborts during credential preparation', async () => {
        const events: string[] = [];
        trackConnections(events);
        const controller = new AbortController();
        mockPreProcessGraphTokens.mockImplementationOnce(async (options) => {
          controller.abort();
          return options;
        });

        const result = await MCPConnectionFactory.discoverTools(
          { serverName: 'test-server', serverConfig: mockServerConfig },
          { signal: controller.signal, graphTokenResolver: jest.fn() },
        );

        expect(result.tools).toBeNull();
        expect(mockMCPConnection).not.toHaveBeenCalled();
      });

      it('abandons a hung connect promptly when a signal-only caller aborts mid-connect', async () => {
        const events: string[] = [];
        let index = 0;
        mockMCPConnection.mockImplementation(() => {
          const label = index++ === 0 ? 'auth' : 'unauth';
          return {
            connect: jest.fn(() => {
              events.push(`${label}:connect`);
              return new Promise(() => {});
            }),
            isConnected: jest.fn().mockResolvedValue(false),
            setOAuthTokens: jest.fn(),
            getOAuthCredentialSetId: jest.fn().mockReturnValue('rejected-generation'),
            on: jest.fn(),
            once: jest.fn(),
            off: jest.fn(),
            removeListener: jest.fn(),
            emit: jest.fn(),
            dispose: jest.fn(async () => {
              events.push(`${label}:dispose`);
            }),
          } as unknown as jest.Mocked<MCPConnection>;
        });
        const controller = new AbortController();
        setTimeout(() => controller.abort(), 20);

        const start = Date.now();
        const result = await MCPConnectionFactory.discoverTools(
          { serverName: 'test-server', serverConfig: mockServerConfig },
          { signal: controller.signal },
        );

        expect(result.tools).toBeNull();
        expect(Date.now() - start).toBeLessThan(2000);
        expect(events).toEqual(['auth:connect', 'auth:dispose']);
        expect(mockMCPConnection).toHaveBeenCalledTimes(1);
      });

      it('forwards the deadline to the tools/list snapshot', async () => {
        const deadlineMs = Date.now() + 5000;
        mockConnectionInstance.connect.mockResolvedValue(undefined);
        mockConnectionInstance.isConnected.mockResolvedValue(true);
        mockConnectionInstance.fetchOrderedToolsSnapshot = jest
          .fn()
          .mockResolvedValue({ tools: [], complete: true });

        await MCPConnectionFactory.discoverTools(
          { serverName: 'test-server', serverConfig: mockServerConfig },
          { deadlineMs },
        );

        expect(mockConnectionInstance.fetchOrderedToolsSnapshot).toHaveBeenCalledWith(
          deadlineMs,
          expect.any(AbortSignal),
        );
        expect(mockConnectionInstance.isConnected).toHaveBeenCalledWith(expect.any(AbortSignal));
      });

      it('clamps a long initTimeout to the remaining budget instead of waiting it out', async () => {
        mockProcessMCPEnv.mockReturnValue({
          ...mockServerConfig,
          initTimeout: 30000,
        } as t.MCPOptions);
        mockConnectionInstance.connect.mockImplementation(() => new Promise(() => {}));
        mockConnectionInstance.isConnected.mockResolvedValue(false);

        const start = Date.now();
        const result = await MCPConnectionFactory.discoverTools(
          { serverName: 'test-server', serverConfig: mockServerConfig },
          { deadlineMs: Date.now() + 50 },
        );

        expect(result.tools).toBeNull();
        expect(Date.now() - start).toBeLessThan(2000);
      });

      describe('OAuth rejection persistence', () => {
        it.each([
          ['handshake', 'deadline'],
          ['handshake', 'abort'],
          ['tools/list', 'deadline'],
          ['tools/list', 'abort'],
        ])('hands off %s rejection persistence when discovery stops at %s', async (phase, stop) => {
          jest.useFakeTimers();
          let finishRecording!: () => void;
          let recordingStarted!: () => void;
          const started = new Promise<void>((resolve) => (recordingStarted = resolve));
          const pendingWrite = new Promise<void>((resolve) => (finishRecording = resolve));
          mockMCPTokenStorage.markAuthorizationRejected.mockImplementationOnce(() => {
            recordingStarted();
            return pendingWrite;
          });
          const controller = new AbortController();
          const onDiscoveryDetached = jest.fn();
          mockFlowManager.createFlowWithHandler.mockResolvedValue({
            access_token: 'rejected-access',
            token_type: 'Bearer',
            obtained_at: Date.now(),
            credential_set_id: 'rejected-generation',
          });
          let oauthHandler: (() => void) | undefined;
          mockConnectionInstance.once.mockImplementation((event, handler) => {
            if (event === 'oauthRequired') oauthHandler = handler as () => void;
            return mockConnectionInstance;
          });
          mockConnectionInstance.connect.mockImplementation(async () => {
            if (phase === 'handshake') {
              oauthHandler?.();
              throw new Error('OAuth required');
            }
          });
          mockConnectionInstance.isConnected.mockResolvedValue(true);
          mockConnectionInstance.fetchOrderedToolsSnapshot = jest.fn().mockResolvedValue({
            tools: [],
            complete: false,
            authenticationError: Object.assign(new Error('unauthorized'), { status: 401 }),
          });
          try {
            const discovery = MCPConnectionFactory.discoverTools(
              { serverName: 'test-server', serverConfig: mockServerConfig },
              {
                useOAuth: true,
                user: mockUser,
                flowManager: mockFlowManager,
                tokenMethods: {
                  findToken: jest.fn(),
                  createToken: jest.fn(),
                  replaceTokenIfCurrent: jest.fn(),
                  updateToken: jest.fn(),
                  deleteTokens: jest.fn(),
                },
                ...(stop === 'deadline'
                  ? { deadlineMs: Date.now() + 100 }
                  : { signal: controller.signal }),
                onDiscoveryDetached,
              },
            );
            await started;
            if (stop === 'deadline') await jest.advanceTimersByTimeAsync(100);
            else controller.abort();
            const result = await discovery;
            expect(result.tools).toBeNull();
            expect(result.oauthRequired).toBe(true);
            expect(mockMCPConnection).toHaveBeenCalledTimes(1);
            expect(onDiscoveryDetached).toHaveBeenCalledTimes(1);
            const [detached] = onDiscoveryDetached.mock.calls[0] as [Promise<void>];
            let finished = false;
            void detached.then(() => (finished = true));
            await Promise.resolve();
            expect(finished).toBe(false);
            finishRecording();
            await detached;
            expect(finished).toBe(true);
          } finally {
            finishRecording();
            jest.useRealTimers();
          }
        });
      });

      describe('OAuth token loading', () => {
        const oauthDiscoveryOptions = (bounds: {
          deadlineMs?: number;
          signal?: AbortSignal;
          onDiscoveryDetached?: t.UserConnectionContext['onDiscoveryDetached'];
        }) => ({
          useOAuth: true as const,
          user: mockUser,
          flowManager: mockFlowManager,
          tokenMethods: {
            findToken: jest.fn(),
            createToken: jest.fn(),
            replaceTokenIfCurrent: jest.fn(),
            updateToken: jest.fn(),
            deleteTokens: jest.fn(),
          },
          ...bounds,
        });
        const cancelledDiscovery = {
          tools: null,
          connection: null,
          oauthRequired: false,
          oauthUrl: null,
        };
        const refreshUnavailable = () => {
          const error = new Error(
            'OAuth token refresh is temporarily unavailable for "test-server"',
          );
          error.name = 'MCPTokenRefreshUnavailableError';
          return error;
        };
        const deferTokenFlow = () => {
          let resolve!: (tokens: MCPOAuthTokens | null) => void;
          let reject!: (error: Error) => void;
          const promise = new Promise<MCPOAuthTokens | null>((resolveFlow, rejectFlow) => {
            resolve = resolveFlow;
            reject = rejectFlow;
          });
          return { promise, resolve, reject };
        };
        type DeferredTokenFlow = ReturnType<typeof deferTokenFlow>;

        it.each<
          [string, (flow: DeferredTokenFlow) => void, PromiseSettledResult<unknown>['status']]
        >([
          [
            'stores its tokens',
            (flow) =>
              flow.resolve({
                access_token: 'late-access',
                token_type: 'Bearer',
                obtained_at: Date.now(),
                credential_set_id: 'persisted-generation',
              }),
            'fulfilled',
          ],
          ['fails', (flow) => flow.reject(refreshUnavailable()), 'rejected'],
        ])(
          'stops waiting at the deadline for a stalled token flow that later %s, handing it off',
          async (_outcome, finish, settlement) => {
            const flow = deferTokenFlow();
            const onDiscoveryDetached = jest.fn();
            mockFlowManager.createFlowWithHandler.mockReturnValue(flow.promise);

            const start = Date.now();
            const result = await MCPConnectionFactory.discoverTools(
              { serverName: 'test-server', serverConfig: mockServerConfig },
              oauthDiscoveryOptions({ deadlineMs: Date.now() + 50, onDiscoveryDetached }),
            );

            expect(result).toEqual(cancelledDiscovery);
            expect(Date.now() - start).toBeLessThan(2000);
            expect(mockFlowManager.createFlowWithHandler).toHaveBeenCalledWith(
              expect.any(String),
              'mcp_get_tokens',
              expect.any(Function),
              undefined,
            );
            expect(mockMCPConnection).not.toHaveBeenCalled();
            expect(onDiscoveryDetached).toHaveBeenCalledTimes(1);
            const [detachedWork] = onDiscoveryDetached.mock.calls[0] as [Promise<unknown>];

            finish(flow);
            await expect(Promise.allSettled([detachedWork])).resolves.toEqual([
              expect.objectContaining({ status: settlement }),
            ]);
            expect(mockFlowManager.deleteFlow).not.toHaveBeenCalled();
            expect(mockMCPConnection).not.toHaveBeenCalled();
          },
        );

        it('stops waiting for the token flow when the caller aborts, handing it off', async () => {
          const controller = new AbortController();
          const onDiscoveryDetached = jest.fn();
          mockFlowManager.createFlowWithHandler.mockImplementation(() => {
            setTimeout(() => controller.abort(), 20);
            return new Promise<MCPOAuthTokens | null>(() => undefined);
          });

          const start = Date.now();
          const result = await MCPConnectionFactory.discoverTools(
            { serverName: 'test-server', serverConfig: mockServerConfig },
            oauthDiscoveryOptions({ signal: controller.signal, onDiscoveryDetached }),
          );

          expect(result).toEqual(cancelledDiscovery);
          expect(Date.now() - start).toBeLessThan(2000);
          expect(mockMCPConnection).not.toHaveBeenCalled();
          expect(onDiscoveryDetached).toHaveBeenCalledWith(expect.any(Promise));
        });

        it('still surfaces a token failure that lands inside the budget', async () => {
          mockFlowManager.createFlowWithHandler.mockRejectedValue(refreshUnavailable());

          await expect(
            MCPConnectionFactory.discoverTools(
              { serverName: 'test-server', serverConfig: mockServerConfig },
              oauthDiscoveryOptions({ deadlineMs: Date.now() + 5000 }),
            ),
          ).rejects.toThrow('OAuth token refresh is temporarily unavailable');
          expect(mockMCPConnection).not.toHaveBeenCalled();
        });

        it('connects with tokens that load inside the budget', async () => {
          const tokens: MCPOAuthTokens = {
            access_token: 'fresh-access',
            token_type: 'Bearer',
            obtained_at: Date.now(),
            credential_set_id: 'persisted-generation',
          };
          mockFlowManager.createFlowWithHandler.mockResolvedValue(tokens);
          mockConnectionInstance.connect.mockResolvedValue(undefined);
          mockConnectionInstance.isConnected.mockResolvedValue(true);
          mockConnectionInstance.fetchOrderedToolsSnapshot = jest
            .fn()
            .mockResolvedValue({ tools: mockTools, complete: true });

          const onDiscoveryDetached = jest.fn();
          const result = await MCPConnectionFactory.discoverTools(
            { serverName: 'test-server', serverConfig: mockServerConfig },
            oauthDiscoveryOptions({ deadlineMs: Date.now() + 5000, onDiscoveryDetached }),
          );

          expect(result.tools).toEqual(mockTools);
          expect(mockMCPConnection).toHaveBeenCalledWith(
            expect.objectContaining({ oauthTokens: tokens }),
          );
          expect(onDiscoveryDetached).not.toHaveBeenCalled();
        });
      });
    });
  });

  describe('proactive OAuth flow', () => {
    const makeOAuthServerConfig = (): t.MCPOptions =>
      ({
        type: 'streamable-http' as const,
        url: 'https://bigquery.googleapis.com/mcp',
        initTimeout: 5000,
        requiresOAuth: true,
      }) as unknown as t.MCPOptions;

    const makeOAuthOptions = () => ({
      useOAuth: true as const,
      user: mockUser,
      flowManager: mockFlowManager,
      tokenMethods: {
        findToken: jest.fn(),
        createToken: jest.fn(),
        updateToken: jest.fn(),
        deleteTokens: jest.fn(),
      },
    });

    function wireEventHandlers(instance: jest.Mocked<MCPConnection>) {
      type Listener = (...args: unknown[]) => void;

      const handlers: Record<string, Listener[]> = {};
      const onceWrappers = new Map<Listener, Listener>();
      const key = (event: string | symbol): string =>
        typeof event === 'symbol' ? event.toString() : event;
      const addHandler = (event: string | symbol, handler: Listener) => {
        (handlers[key(event)] ??= []).push(handler);
      };
      const removeHandler = (event: string | symbol, handler: Listener) => {
        const list = handlers[key(event)];
        if (!list) {
          return;
        }
        const wrapped = onceWrappers.get(handler);
        const handlerToRemove = wrapped ?? handler;
        const index = list.indexOf(handlerToRemove);
        if (index !== -1) {
          list.splice(index, 1);
        }
        if (wrapped) {
          onceWrappers.delete(handler);
        }
      };

      instance.on.mockImplementation((event: string | symbol, handler: Listener) => {
        addHandler(event, handler);
        return instance;
      });

      instance.once.mockImplementation((event: string | symbol, handler: Listener) => {
        const wrapped: Listener = (...args) => {
          removeHandler(event, handler);
          handler(...args);
        };
        onceWrappers.set(handler, wrapped);
        addHandler(event, wrapped);
        return instance;
      });

      instance.off.mockImplementation((event: string | symbol, handler: Listener) => {
        removeHandler(event, handler);
        return instance;
      });

      instance.removeListener.mockImplementation((event: string | symbol, handler: Listener) => {
        removeHandler(event, handler);
        return instance;
      });

      instance.emit.mockImplementation((event: string | symbol, ...args: unknown[]) => {
        const list = handlers[key(event)];
        if (!list || list.length === 0) {
          return false;
        }
        for (const fn of [...list]) {
          fn(...args);
        }
        return true;
      });

      return handlers;
    }

    it('should trigger proactive OAuth when requiresOAuth and no tokens', async () => {
      const serverConfig = makeOAuthServerConfig();
      const oauthOptions = makeOAuthOptions();

      mockProcessMCPEnv.mockReturnValue(serverConfig);
      mockFlowManager.createFlowWithHandler.mockResolvedValue(null);

      const mockTokens: MCPOAuthTokens = {
        access_token: 'bq-token',
        token_type: 'Bearer',
        obtained_at: Date.now(),
        credential_set_id: 'bq-generation',
      };

      const mockFlowData = {
        authorizationUrl: 'https://accounts.google.com/o/oauth2/auth?state=xyz',
        flowId: 'flow-bq',
        flowMetadata: {
          serverName: 'bigquery',
          userId: 'user123',
          serverUrl: 'https://bigquery.googleapis.com/mcp',
          state: 'state-xyz',
          clientInfo: { client_id: 'bq-client' },
        },
      };

      mockMCPOAuthHandler.generateFlowId.mockReturnValue('flow-bq');
      mockMCPOAuthHandler.initiateOAuthFlow.mockResolvedValue(mockFlowData);
      mockFlowManager.getFlowState.mockResolvedValue(null);
      mockFlowManager.createFlow.mockResolvedValue(mockTokens);

      wireEventHandlers(mockConnectionInstance);
      mockConnectionInstance.isConnected.mockResolvedValue(true);

      const connection = await MCPConnectionFactory.create(
        { serverName: 'bigquery', serverConfig },
        oauthOptions,
      );

      expect(connection).toBe(mockConnectionInstance);
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.stringContaining('proactively triggering OAuth flow'),
      );
      expect(mockConnectionInstance.setOAuthTokens).toHaveBeenCalledWith(mockTokens);
      expect(mockConnectionInstance.connect).toHaveBeenCalled();
    });

    it('adopts the generation carried by the tokens an interactive OAuth flow released', async () => {
      const serverConfig = makeOAuthServerConfig();
      const onOAuthCredentialsAdopted = jest.fn();
      const oauthOptions = { ...makeOAuthOptions(), onOAuthCredentialsAdopted };

      mockProcessMCPEnv.mockReturnValue(serverConfig);
      mockFlowManager.createFlowWithHandler.mockResolvedValue(null);

      const releasedTokens: MCPOAuthTokens = {
        access_token: 'bq-token',
        token_type: 'Bearer',
        obtained_at: 1_700_000_000_000,
        credential_set_id: 'bq-generation',
        publication_generation: 'generation-b',
      };
      mockMCPOAuthHandler.generateFlowId.mockReturnValue('flow-bq');
      mockMCPOAuthHandler.initiateOAuthFlow.mockResolvedValue({
        authorizationUrl: 'https://accounts.google.com/o/oauth2/auth?state=xyz',
        flowId: 'flow-bq',
        flowMetadata: {
          serverName: 'bigquery',
          userId: 'user123',
          serverUrl: 'https://bigquery.googleapis.com/mcp',
          state: 'state-xyz',
          clientInfo: { client_id: 'bq-client' },
        },
      });
      mockFlowManager.getFlowState.mockResolvedValue(null);
      mockFlowManager.createFlow.mockResolvedValue(releasedTokens);

      wireEventHandlers(mockConnectionInstance);
      mockConnectionInstance.isConnected.mockResolvedValue(true);

      await expect(
        MCPConnectionFactory.create({ serverName: 'bigquery', serverConfig }, oauthOptions),
      ).resolves.toBe(mockConnectionInstance);

      expect(mockConnectionInstance.setOAuthTokens).toHaveBeenCalledWith(releasedTokens);
      expect(onOAuthCredentialsAdopted).toHaveBeenCalledWith('generation-b');
    });

    it('should trigger proactive OAuth when oauth is configured without requiresOAuth', async () => {
      const serverConfig = {
        type: 'streamable-http' as const,
        url: 'https://drivemcp.googleapis.com/mcp/v1',
        initTimeout: 5000,
        oauth: {
          authorization_url: 'https://accounts.google.com/o/oauth2/v2/auth',
          token_url: 'https://oauth2.googleapis.com/token',
        },
      } as t.ParsedServerConfig;
      const oauthOptions = makeOAuthOptions();

      mockProcessMCPEnv.mockReturnValue(serverConfig);
      mockFlowManager.createFlowWithHandler.mockResolvedValue(null);

      const mockTokens: MCPOAuthTokens = {
        access_token: 'drive-token',
        token_type: 'Bearer',
        obtained_at: Date.now(),
        credential_set_id: 'drive-generation',
      };

      mockMCPOAuthHandler.generateFlowId.mockReturnValue('flow-drive');
      mockMCPOAuthHandler.initiateOAuthFlow.mockResolvedValue({
        authorizationUrl: 'https://accounts.google.com/o/oauth2/auth?state=drive',
        flowId: 'flow-drive',
        flowMetadata: {
          serverName: 'drive',
          userId: 'user123',
          serverUrl: 'https://drivemcp.googleapis.com/mcp/v1',
          state: 'state-drive',
        },
      });
      mockFlowManager.getFlowState.mockResolvedValue(null);
      mockFlowManager.createFlow.mockResolvedValue(mockTokens);

      wireEventHandlers(mockConnectionInstance);
      mockConnectionInstance.isConnected.mockResolvedValue(true);

      const connection = await MCPConnectionFactory.create(
        { serverName: 'drive', serverConfig },
        oauthOptions,
      );

      expect(connection).toBe(mockConnectionInstance);
      expect(mockMCPOAuthHandler.initiateOAuthFlow).toHaveBeenCalled();
      expect(mockConnectionInstance.setOAuthTokens).toHaveBeenCalledWith(mockTokens);
      expect(mockConnectionInstance.connect).toHaveBeenCalled();
    });

    it('should not trigger proactive OAuth when only OAuth metadata is present', async () => {
      const serverConfig = {
        type: 'streamable-http' as const,
        url: 'https://metadata-only.example.com/mcp',
        initTimeout: 5000,
        oauthMetadata: {
          authorization_servers: ['https://auth.example.com/'],
        },
      } as t.ParsedServerConfig;
      const oauthOptions = makeOAuthOptions();

      mockProcessMCPEnv.mockReturnValue(serverConfig);
      mockFlowManager.createFlowWithHandler.mockResolvedValue(null);
      mockConnectionInstance.isConnected.mockResolvedValue(true);

      const connection = await MCPConnectionFactory.create(
        { serverName: 'metadata-only', serverConfig },
        oauthOptions,
      );

      expect(connection).toBe(mockConnectionInstance);
      expect(mockMCPOAuthHandler.initiateOAuthFlow).not.toHaveBeenCalled();
      expect(mockConnectionInstance.connect).toHaveBeenCalled();
    });

    it('should NOT trigger proactive OAuth when useOAuth is true but requiresOAuth is absent', async () => {
      const serverConfig = {
        command: 'node',
        args: ['server.js'],
        initTimeout: 5000,
      } as t.MCPOptions;

      const oauthOptions = makeOAuthOptions();

      mockProcessMCPEnv.mockReturnValue(serverConfig);
      mockFlowManager.createFlowWithHandler.mockResolvedValue(null);
      mockConnectionInstance.isConnected.mockResolvedValue(true);

      const connection = await MCPConnectionFactory.create(
        { serverName: 'test-server', serverConfig },
        oauthOptions,
      );

      expect(connection).toBe(mockConnectionInstance);
      expect(mockLogger.info).not.toHaveBeenCalledWith(
        expect.stringContaining('proactively triggering OAuth flow'),
      );
    });

    it('should not trigger proactive OAuth when requiresOAuth is explicitly false', async () => {
      const serverConfig = {
        type: 'streamable-http' as const,
        url: 'https://api.example.com/mcp',
        initTimeout: 5000,
        requiresOAuth: false,
        oauth: {
          authorization_url: 'https://auth.example.com/oauth/authorize',
          token_url: 'https://auth.example.com/oauth/token',
        },
      } as t.MCPOptions;
      const oauthOptions = makeOAuthOptions();

      mockProcessMCPEnv.mockReturnValue(serverConfig);
      mockFlowManager.createFlowWithHandler.mockResolvedValue(null);
      mockConnectionInstance.isConnected.mockResolvedValue(true);

      const connection = await MCPConnectionFactory.create(
        { serverName: 'test-server', serverConfig },
        oauthOptions,
      );

      expect(connection).toBe(mockConnectionInstance);
      expect(mockMCPOAuthHandler.initiateOAuthFlow).not.toHaveBeenCalled();
      expect(mockLogger.info).not.toHaveBeenCalledWith(
        expect.stringContaining('proactively triggering OAuth flow'),
      );
    });

    it('should skip proactive OAuth when tokens already exist', async () => {
      const serverConfig = makeOAuthServerConfig();
      const oauthOptions = makeOAuthOptions();

      mockProcessMCPEnv.mockReturnValue(serverConfig);
      const existingTokens: MCPOAuthTokens = {
        access_token: 'existing-token',
        token_type: 'Bearer',
        obtained_at: Date.now(),
      };
      mockFlowManager.createFlowWithHandler.mockResolvedValue(existingTokens);
      mockConnectionInstance.isConnected.mockResolvedValue(true);

      const connection = await MCPConnectionFactory.create(
        { serverName: 'bigquery', serverConfig },
        oauthOptions,
      );

      expect(connection).toBe(mockConnectionInstance);
      expect(mockLogger.info).not.toHaveBeenCalledWith(
        expect.stringContaining('proactively triggering OAuth flow'),
      );
    });

    it('should reject when proactive OAuth flow fails', async () => {
      const serverConfig = makeOAuthServerConfig();
      const oauthOptions = {
        ...makeOAuthOptions(),
        returnOnOAuth: true,
        oauthStart: jest.fn(),
      };

      mockProcessMCPEnv.mockReturnValue(serverConfig);
      mockFlowManager.createFlowWithHandler.mockResolvedValue(null);

      const mockFlowData = {
        authorizationUrl: 'https://accounts.google.com/o/oauth2/auth',
        flowId: 'flow-bq',
        flowMetadata: {
          serverName: 'bigquery',
          userId: 'user123',
          serverUrl: 'https://bigquery.googleapis.com/mcp',
          state: 'state-xyz',
        },
      };

      mockMCPOAuthHandler.generateFlowId.mockReturnValue('flow-bq');
      mockMCPOAuthHandler.initiateOAuthFlow.mockResolvedValue(mockFlowData);
      mockFlowManager.getFlowState.mockResolvedValue(null);
      mockFlowManager.createFlow.mockReturnValue(new Promise(() => {}));

      wireEventHandlers(mockConnectionInstance);
      mockConnectionInstance.isConnected.mockResolvedValue(false);

      await expect(
        MCPConnectionFactory.create({ serverName: 'bigquery', serverConfig }, oauthOptions),
      ).rejects.toThrow('OAuth flow initiated - return early');
    });

    it('should throw when requiresOAuth is true but url is missing', async () => {
      const serverConfig = {
        type: 'streamable-http' as const,
        initTimeout: 5000,
        requiresOAuth: true,
      } as unknown as t.MCPOptions;

      const oauthOptions = makeOAuthOptions();

      mockProcessMCPEnv.mockReturnValue(serverConfig);
      mockFlowManager.createFlowWithHandler.mockResolvedValue(null);

      wireEventHandlers(mockConnectionInstance);
      mockConnectionInstance.isConnected.mockResolvedValue(false);

      await expect(
        MCPConnectionFactory.create({ serverName: 'no-url', serverConfig }, oauthOptions),
      ).rejects.toThrow('server URL is missing');
    });

    it('should reject when proactive OAuth has no registered handler', async () => {
      const serverConfig = makeOAuthServerConfig();
      const oauthOptions = makeOAuthOptions();

      mockProcessMCPEnv.mockReturnValue(serverConfig);
      mockFlowManager.createFlowWithHandler.mockResolvedValue(null);
      mockConnectionInstance.on.mockReturnValue(mockConnectionInstance);
      mockConnectionInstance.once.mockReturnValue(mockConnectionInstance);
      mockConnectionInstance.off.mockReturnValue(mockConnectionInstance);
      mockConnectionInstance.emit.mockReturnValue(false);

      await expect(
        MCPConnectionFactory.create({ serverName: 'bigquery', serverConfig }, oauthOptions),
      ).rejects.toThrow('OAuth required but no handler is registered');

      expect(mockConnectionInstance.connect).not.toHaveBeenCalled();
    });

    it('should clean up cross-listeners when oauthHandled fires', async () => {
      const serverConfig = makeOAuthServerConfig();
      const oauthOptions = makeOAuthOptions();

      mockProcessMCPEnv.mockReturnValue(serverConfig);
      mockFlowManager.createFlowWithHandler.mockResolvedValue(null);

      const mockTokens: MCPOAuthTokens = {
        access_token: 'cleanup-token',
        token_type: 'Bearer',
        obtained_at: Date.now(),
        credential_set_id: 'cleanup-generation',
      };

      mockMCPOAuthHandler.generateFlowId.mockReturnValue('flow-cleanup');
      mockMCPOAuthHandler.initiateOAuthFlow.mockResolvedValue({
        authorizationUrl: 'https://auth.example.com',
        flowId: 'flow-cleanup',
        flowMetadata: {
          serverName: 'bigquery',
          userId: 'user123',
          serverUrl: 'https://bigquery.googleapis.com/mcp',
          state: 'state-cleanup',
          clientInfo: { client_id: 'client-cleanup' },
        },
      });
      mockFlowManager.getFlowState.mockResolvedValue(null);
      mockFlowManager.createFlow.mockResolvedValue(mockTokens);

      const handlers = wireEventHandlers(mockConnectionInstance);
      mockConnectionInstance.isConnected.mockResolvedValue(true);

      await MCPConnectionFactory.create({ serverName: 'bigquery', serverConfig }, oauthOptions);

      // After oauthHandled resolved, the oauthFailed listener should have been removed
      const failedListeners = handlers['oauthFailed'] ?? [];
      expect(failedListeners.length).toBe(0);
    });

    it('should not trigger proactive OAuth during tool discovery', async () => {
      const serverConfig = makeOAuthServerConfig();
      const oauthOptions = {
        ...makeOAuthOptions(),
        oauthStart: jest.fn(),
      };
      const mockTools = [
        { name: 'tool1', description: 'First tool', inputSchema: { type: 'object' } },
      ];

      mockProcessMCPEnv.mockReturnValue(serverConfig);
      mockFlowManager.createFlowWithHandler.mockResolvedValue(null);
      mockConnectionInstance.connect.mockResolvedValue(undefined);
      mockConnectionInstance.isConnected.mockResolvedValue(true);
      mockConnectionInstance.fetchOrderedToolsSnapshot = jest
        .fn()
        .mockResolvedValue({ tools: mockTools, complete: true });

      const result = await MCPConnectionFactory.discoverTools(
        { serverName: 'bigquery', serverConfig },
        oauthOptions,
      );

      expect(result.tools).toEqual(mockTools);
      expect(result.oauthRequired).toBe(true);
      expect(oauthOptions.oauthStart).not.toHaveBeenCalled();
      expect(mockMCPOAuthHandler.initiateOAuthFlow).not.toHaveBeenCalled();
    });
  });

  describe('OBO upstreamTokenProvider plumbing', () => {
    const oboServerConfig = {
      type: 'sse' as const,
      url: 'https://obo.example.com',
      requiresOAuth: false,
      obo: { scopes: 'api://obo-server/Mcp.Tools.ReadWrite' },
    } as unknown as t.MCPOptions;

    beforeEach(() => {
      mockProcessMCPEnv.mockReturnValue(oboServerConfig);
      mockConnectionInstance.connect.mockResolvedValue(undefined);
      mockConnectionInstance.isConnected.mockResolvedValue(true);
    });

    it('forwards upstreamTokenProvider into resolveOboToken at connection establishment', async () => {
      const { resolveOboToken } = jest.requireMock('~/mcp/oauth') as {
        resolveOboToken: jest.Mock;
      };
      resolveOboToken.mockResolvedValue({
        access_token: 'connection-time-obo-token',
        token_type: 'Bearer',
        obtained_at: Date.now(),
        expires_at: Date.now() + 3600_000,
      });

      const upstreamTokenProvider = jest.fn();
      const oboTokenResolver = jest.fn();

      await MCPConnectionFactory.create(
        { serverName: 'obo-srv', serverConfig: oboServerConfig },
        {
          useOAuth: true,
          user: mockUser,
          flowManager: mockFlowManager,
          tokenMethods: {
            findToken: jest.fn(),
            createToken: jest.fn(),
            replaceTokenIfCurrent: jest.fn(),
            updateToken: jest.fn(),
            deleteTokens: jest.fn(),
          },
          oboTokenResolver,
          upstreamTokenProvider,
        },
      );

      expect(resolveOboToken).toHaveBeenCalledWith(
        mockUser,
        oboServerConfig.obo,
        oboTokenResolver,
        upstreamTokenProvider,
        undefined,
        false,
      );
    });

    it('resolves a provider lazily after the server is confirmed to use OBO', async () => {
      const { resolveOboToken } = jest.requireMock('~/mcp/oauth') as {
        resolveOboToken: jest.Mock;
      };
      resolveOboToken.mockImplementationOnce(async (_user, _config, _exchange, provider) => {
        await provider();
        return {
          access_token: 'connection-time-obo-token',
          token_type: 'Bearer',
          obtained_at: Date.now(),
          expires_at: Date.now() + 3600_000,
        };
      });
      const upstreamTokenProvider = jest.fn();
      const upstreamTokenProviderResolver = jest.fn().mockResolvedValue(upstreamTokenProvider);
      const oboTokenResolver = jest.fn();

      await MCPConnectionFactory.create(
        { serverName: 'obo-srv', serverConfig: oboServerConfig },
        {
          useOAuth: true,
          user: mockUser,
          flowManager: mockFlowManager,
          tokenMethods: {
            findToken: jest.fn(),
            createToken: jest.fn(),
            replaceTokenIfCurrent: jest.fn(),
            updateToken: jest.fn(),
            deleteTokens: jest.fn(),
          },
          oboTokenResolver,
          upstreamTokenProviderResolver,
        },
      );

      expect(upstreamTokenProviderResolver).toHaveBeenCalledTimes(1);
      expect(upstreamTokenProviderResolver).toHaveBeenCalledWith(
        expect.objectContaining({
          target: { mcpServer: 'obo-srv', scopes: oboServerConfig.obo?.scopes },
        }),
      );
      expect(resolveOboToken).toHaveBeenCalledWith(
        mockUser,
        oboServerConfig.obo,
        oboTokenResolver,
        expect.any(Function),
        undefined,
        false,
      );
    });

    it.each([undefined, new Error('owner stopped'), 'stopped'])(
      'detaches connection initialization from an uncooperative OBO exchange (%s)',
      async (reason) => {
        const controller = new AbortController();
        const { resolveOboToken } = jest.requireMock('~/mcp/oauth');
        resolveOboToken.mockImplementationOnce(() => {
          queueMicrotask(() => controller.abort(reason));
          return new Promise(() => {});
        });
        await expect(
          MCPConnectionFactory.create(
            { serverName: 'obo-srv', serverConfig: oboServerConfig },
            {
              useOAuth: true,
              user: mockUser,
              flowManager: mockFlowManager,
              tokenMethods: {
                findToken: jest.fn(),
                createToken: jest.fn(),
                replaceTokenIfCurrent: jest.fn(),
                updateToken: jest.fn(),
                deleteTokens: jest.fn(),
              },
              signal: controller.signal,
              oboTokenResolver: jest.fn(),
              upstreamTokenProvider: jest.fn(),
            },
          ),
        ).rejects.toMatchObject({ name: 'AbortError' });
      },
    );

    it.each([undefined, new Error('owner stopped during trust check'), 'stopped'])(
      'detaches connection initialization from a pending OBO trust check (%s)',
      async (reason) => {
        const controller = new AbortController();
        const oboTrustChecker = jest.fn().mockImplementation(
          () =>
            new Promise<boolean>(() => {
              queueMicrotask(() => controller.abort(reason));
            }),
        );
        const { resolveOboToken } = jest.requireMock('~/mcp/oauth');
        resolveOboToken.mockClear();

        await expect(
          MCPConnectionFactory.create(
            { serverName: 'obo-srv', serverConfig: oboServerConfig },
            {
              useOAuth: true,
              user: mockUser,
              flowManager: mockFlowManager,
              tokenMethods: {
                findToken: jest.fn(),
                createToken: jest.fn(),
                replaceTokenIfCurrent: jest.fn(),
                updateToken: jest.fn(),
                deleteTokens: jest.fn(),
              },
              signal: controller.signal,
              oboTokenResolver: jest.fn(),
              upstreamTokenProvider: jest.fn(),
              oboTrustChecker,
            },
          ),
        ).rejects.toMatchObject({ name: 'AbortError' });
        expect(resolveOboToken).not.toHaveBeenCalled();
      },
    );

    it('does not look up credentials for an untrusted OBO configuration', async () => {
      const upstreamTokenProviderResolver = jest.fn();
      const oboTrustChecker = jest.fn().mockResolvedValue(false);
      const { resolveOboToken } = jest.requireMock('~/mcp/oauth');
      resolveOboToken.mockClear();
      await expect(
        MCPConnectionFactory.create(
          { serverName: 'obo-srv', serverConfig: oboServerConfig },
          {
            useOAuth: true,
            user: mockUser,
            flowManager: mockFlowManager,
            tokenMethods: {
              findToken: jest.fn(),
              createToken: jest.fn(),
              replaceTokenIfCurrent: jest.fn(),
              updateToken: jest.fn(),
              deleteTokens: jest.fn(),
            },
            oboTokenResolver: jest.fn(),
            oboTrustChecker,
            upstreamTokenProviderResolver,
          },
        ),
      ).rejects.toThrow('OBO token exchange failed');
      expect(oboTrustChecker).toHaveBeenCalled();
      expect(upstreamTokenProviderResolver).not.toHaveBeenCalled();
      expect(resolveOboToken).not.toHaveBeenCalled();
    });

    it('does not invoke the resolver for a non-OBO direct-bearer server', async () => {
      const directBearerConfig = {
        type: 'streamable-http' as const,
        url: 'https://direct.example.com',
        headers: { Authorization: 'Bearer static-token' },
      } as unknown as t.MCPOptions;
      mockProcessMCPEnv.mockReturnValue(directBearerConfig);
      const upstreamTokenProviderResolver = jest.fn();

      await MCPConnectionFactory.create(
        { serverName: 'direct-srv', serverConfig: directBearerConfig },
        { user: mockUser, upstreamTokenProviderResolver },
      );

      expect(upstreamTokenProviderResolver).not.toHaveBeenCalled();
    });

    it('identifies missing upstream credentials before exchanging an OBO token', async () => {
      const { resolveOboToken } = jest.requireMock('~/mcp/oauth') as {
        resolveOboToken: jest.Mock;
      };
      resolveOboToken.mockClear();
      const OboError = OboTokenResolutionError as unknown as jest.Mock;
      OboError.mockImplementation((reason: string, userMessage: string, retryable = false) => {
        const error = new Error(userMessage);
        Object.setPrototypeOf(error, OboError.prototype);
        return Object.assign(error, {
          name: 'OboTokenResolutionError',
          reason,
          retryable,
          userMessage,
        });
      });
      const oboTokenResolver = jest.fn();

      await expect(
        MCPConnectionFactory.create(
          { serverName: 'obo-srv', serverConfig: oboServerConfig },
          {
            useOAuth: true,
            user: mockUser,
            flowManager: mockFlowManager,
            tokenMethods: {
              findToken: jest.fn(),
              createToken: jest.fn(),
              replaceTokenIfCurrent: jest.fn(),
              updateToken: jest.fn(),
              deleteTokens: jest.fn(),
            },
            oboTokenResolver,
            /** upstreamTokenProvider intentionally omitted */
          },
        ),
      ).rejects.toMatchObject({
        name: 'OboTokenResolutionError',
        reason: 'missing_upstream_provider',
        retryable: false,
      });
      expect(resolveOboToken).not.toHaveBeenCalled();
    });

    it('preserves OBO resolution failure metadata at connection establishment', async () => {
      const { resolveOboToken } = jest.requireMock('~/mcp/oauth') as {
        resolveOboToken: jest.Mock;
      };
      const OboError = OboTokenResolutionError as unknown as jest.Mock;
      OboError.mockImplementation(
        (reason: string, userMessage: string, retryable = false, cause?: unknown) => {
          const error = new Error(userMessage);
          Object.setPrototypeOf(error, OboError.prototype);
          return Object.assign(error, {
            name: 'OboTokenResolutionError',
            reason,
            retryable,
            userMessage,
            cause,
          });
        },
      );
      resolveOboToken.mockRejectedValueOnce(
        new OboTokenResolutionError('session_refresh_failed', 'Sign-in expired.'),
      );

      await expect(
        MCPConnectionFactory.create(
          { serverName: 'obo-srv', serverConfig: oboServerConfig },
          {
            useOAuth: true,
            user: mockUser,
            flowManager: mockFlowManager,
            tokenMethods: {
              findToken: jest.fn(),
              createToken: jest.fn(),
              replaceTokenIfCurrent: jest.fn(),
              updateToken: jest.fn(),
              deleteTokens: jest.fn(),
            },
            oboTokenResolver: jest.fn(),
            upstreamTokenProvider: jest.fn(),
          },
        ),
      ).rejects.toMatchObject({
        name: 'OboTokenResolutionError',
        reason: 'session_refresh_failed',
        retryable: false,
      });
    });
  });

  describe('OBO authentication failures', () => {
    const oboServerConfig = {
      type: 'sse' as const,
      url: 'https://obo.example.com',
      requiresOAuth: false,
      obo: { scopes: 'api://obo-server/Mcp.Tools.ReadWrite' },
    } as unknown as t.MCPOptions;

    const connectionTokens = {
      access_token: 'rejected-obo-token',
      token_type: 'Bearer' as const,
      obtained_at: Date.now(),
      expires_at: Date.now() + 3600_000,
    };
    const refreshedTokens = {
      access_token: 'refreshed-obo-token',
      token_type: 'Bearer' as const,
      obtained_at: Date.now(),
      expires_at: Date.now() + 3600_000,
    };

    let resolveOboToken: jest.Mock;

    /** The `oauthRequired` listener the factory attached for this connection. */
    const getAuthHandler = (): (() => Promise<void>) => {
      const onCall = (mockConnectionInstance.on as jest.Mock).mock.calls.find(
        ([event]: [string]) => event === 'oauthRequired',
      );
      return onCall![1] as () => Promise<void>;
    };

    const createOboConnection = () =>
      MCPConnectionFactory.create(
        { serverName: 'obo-srv', serverConfig: oboServerConfig },
        {
          useOAuth: true,
          user: mockUser,
          flowManager: mockFlowManager,
          tokenMethods: {
            findToken: jest.fn(),
            createToken: jest.fn(),
            replaceTokenIfCurrent: jest.fn(),
            updateToken: jest.fn(),
            deleteTokens: jest.fn(),
          },
          oboTokenResolver: jest.fn(),
          upstreamTokenProvider: jest.fn(),
        },
      );

    beforeEach(() => {
      mockProcessMCPEnv.mockReturnValue(oboServerConfig);
      mockConnectionInstance.connect.mockResolvedValue(undefined);
      mockConnectionInstance.isConnected.mockResolvedValue(true);
      ({ resolveOboToken } = jest.requireMock('~/mcp/oauth') as {
        resolveOboToken: jest.Mock;
      });
      resolveOboToken.mockReset();
      resolveOboToken.mockResolvedValue(connectionTokens);
    });

    it('re-exchanges a rejected token and lets the connect retry proceed', async () => {
      resolveOboToken
        .mockResolvedValueOnce(connectionTokens)
        .mockResolvedValueOnce(refreshedTokens);
      /** The real handler runs inside `connectClient`, so fire it from within `connect()`. */
      mockConnectionInstance.connect.mockImplementationOnce(async () => {
        await getAuthHandler()();
      });

      await createOboConnection();

      expect(resolveOboToken).toHaveBeenCalledTimes(2);
      /** The rejected credential is still inside its cached lifetime, so the cache is bypassed. */
      expect(resolveOboToken).toHaveBeenLastCalledWith(
        mockUser,
        oboServerConfig.obo,
        expect.any(Function),
        expect.any(Function),
        undefined,
        true,
      );
      expect(mockConnectionInstance.setOAuthTokens).toHaveBeenCalledWith(refreshedTokens);
      /** Runtime headers outrank the transport's, so the stale bearer has to be replaced too. */
      expect(mockConnectionInstance.setAuthorizationHeader).toHaveBeenCalledWith(
        'refreshed-obo-token',
      );
      expect(mockConnectionInstance.emit).toHaveBeenCalledWith('oauthHandled');
      expect(mockConnectionInstance.emit).not.toHaveBeenCalledWith(
        'oauthFailed',
        expect.anything(),
      );
      expect(mockConnectionInstance.stopReconnecting).not.toHaveBeenCalled();
    });

    it('preserves a cancelled re-exchange without logging a sign-in failure', async () => {
      const abort = new DOMException('Stopped', 'AbortError');
      resolveOboToken.mockResolvedValueOnce(connectionTokens).mockRejectedValueOnce(abort);
      mockConnectionInstance.connect.mockImplementationOnce(async () => {
        await getAuthHandler()();
        throw new Error('HTTP 401 Unauthorized');
      });
      await expect(createOboConnection()).rejects.toMatchObject({ name: 'AbortError' });
      expect(mockLogger.error).not.toHaveBeenCalled();
      expect(mockConnectionInstance.stopReconnecting).toHaveBeenCalled();
    });

    it('retires the connection when the re-exchange fails', async () => {
      resolveOboToken
        .mockResolvedValueOnce(connectionTokens)
        .mockRejectedValueOnce(new Error('IdP rejected the exchange'));
      mockConnectionInstance.connect.mockImplementationOnce(async () => {
        await getAuthHandler()();
      });

      await createOboConnection();

      expect(mockConnectionInstance.setOAuthTokens).not.toHaveBeenCalled();
      expect(mockConnectionInstance.stopReconnecting).toHaveBeenCalled();
      expect(mockConnectionInstance.emit).toHaveBeenCalledWith(
        'oauthFailed',
        expect.objectContaining({ message: 'IdP rejected the exchange' }),
      );
    });

    it('surfaces why the re-exchange failed instead of the generic 401', async () => {
      const authError = new Error('HTTP 401 Unauthorized');
      resolveOboToken
        .mockResolvedValueOnce(connectionTokens)
        .mockRejectedValueOnce(new Error('Your sign-in session expired. Please sign in again.'));
      /**
       * `connectClient` rethrows the server's original 401 after the handler fails,
       * so without propagation the caller would only ever see `authError`.
       */
      mockConnectionInstance.connect.mockImplementationOnce(async () => {
        await getAuthHandler()();
        throw authError;
      });
      mockConnectionInstance.isConnected.mockResolvedValue(false);

      await expect(createOboConnection()).rejects.toThrow(
        'Your sign-in session expired. Please sign in again.',
      );
    });

    it('re-exchanges at most once per connection attempt', async () => {
      resolveOboToken
        .mockResolvedValueOnce(connectionTokens)
        .mockResolvedValueOnce(refreshedTokens);
      mockConnectionInstance.connect.mockImplementationOnce(async () => {
        const handler = getAuthHandler();
        await handler();
        await handler();
      });

      await createOboConnection();

      expect(resolveOboToken).toHaveBeenCalledTimes(2);
      expect(mockConnectionInstance.stopReconnecting).toHaveBeenCalled();
      expect(mockConnectionInstance.emit).toHaveBeenCalledWith(
        'oauthFailed',
        expect.objectContaining({ message: 'Refreshed OBO token was rejected' }),
      );
    });

    it('defers to a live request instead of re-exchanging on a cached connection', async () => {
      await createOboConnection();
      expect(resolveOboToken).toHaveBeenCalledTimes(1);

      await getAuthHandler()();

      /** The creating request is over, so `upstreamTokenProvider` no longer has a live session. */
      expect(resolveOboToken).toHaveBeenCalledTimes(1);
      expect(mockConnectionInstance.setOAuthTokens).not.toHaveBeenCalled();
      expect(mockConnectionInstance.stopReconnecting).toHaveBeenCalled();
      expect(mockConnectionInstance.emit).toHaveBeenCalledWith(
        'oauthFailed',
        expect.objectContaining({ message: 'OBO re-exchange requires a live request' }),
      );
    });
  });
});
