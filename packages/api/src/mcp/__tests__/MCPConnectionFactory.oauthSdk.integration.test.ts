import { Keyv } from 'keyv';
import type { IUser } from '@librechat/data-schemas';
import type {
  OAuthClientInformation,
  OAuthStoredClientMetadata,
  MCPOAuthTokens,
} from '~/mcp/oauth';
import type { MCPOAuthFlowMetadata } from '~/mcp/oauth';
import type * as t from '~/mcp/types';
import {
  MockKeyv,
  InMemoryTokenStore,
  createOAuthMCPServer,
  type OAuthTestServer,
} from './helpers/oauthTestServer';
import { persistMCPAuthorizationTransaction } from '~/mcp/authorization';
import { MCPServersRegistry } from '~/mcp/registry/MCPServersRegistry';
import { MCPConnectionFactory } from '~/mcp/MCPConnectionFactory';
import { MCPTokenStorage, MCPOAuthHandler } from '~/mcp/oauth';
import { FlowStateManager } from '~/flow/manager';
import { MCPConnection } from '~/mcp/connection';
import { MCPManager } from '~/mcp/MCPManager';

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
  encryptV2: jest.fn(async (val: string) => `enc:${val}`),
  decryptV2: jest.fn(async (val: string) => val.replace(/^enc:/, '')),
}));

jest.mock('~/auth', () => ({
  createSSRFSafeUndiciConnect: jest.fn(() => undefined),
  isOAuthUrlAllowed: jest.fn(() => false),
  isSSRFTarget: jest.fn(() => false),
  resolveHostnameSSRF: jest.fn(async () => false),
}));

jest.mock('~/mcp/mcpConfig', () => ({
  mcpConfig: {
    CONNECTION_CHECK_TTL: 0,
    OAUTH_HANDLING_TIMEOUT: 10 * 60 * 1000,
    USER_CONNECTION_IDLE_TIMEOUT: 30 * 60 * 1000,
    TOOLS_LIST_MAX_PAGES: 50,
    TOOLS_LIST_MAX_TOOLS: 1000,
    TOOLS_LIST_MAX_BYTES: 5 * 1024 * 1024,
    TOOLS_LIST_TIMEOUT_MS: 30000,
  },
}));

class TokenLoadingFactory extends MCPConnectionFactory {
  public constructor(basic: t.BasicConnectionOptions, options: t.OAuthConnectionOptions) {
    super(basic, options);
  }

  public loadTokens() {
    return this.getOAuthTokens();
  }
}

const SERVER_NAME = 'sdk-oauth-server';
const USER_ID = 'sdk-user';
const CLIENT_ID = 'librechat-sdk-test-client';

async function safeDisconnect(conn: MCPConnection | null): Promise<void> {
  if (!conn) {
    return;
  }
  (conn as unknown as { shouldStopReconnecting: boolean }).shouldStopReconnecting = true;
  conn.removeAllListeners();
  await conn.disconnect().catch(() => undefined);
}

async function waitFor(condition: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error('Timed out waiting for condition');
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function createFlowManager(): FlowStateManager<MCPOAuthTokens | null> {
  return new FlowStateManager(new MockKeyv<MCPOAuthTokens | null>() as unknown as Keyv, {
    ttl: 30000,
    ci: true,
  });
}

async function issueTokens(server: OAuthTestServer, scope = 'read'): Promise<MCPOAuthTokens> {
  const authUrl = new URL('authorize', server.url);
  authUrl.searchParams.set('redirect_uri', 'http://localhost');
  authUrl.searchParams.set('state', 'sdk-test');
  authUrl.searchParams.set('client_id', CLIENT_ID);
  authUrl.searchParams.set('scope', scope);
  authUrl.searchParams.set('resource', server.resourceUrl);

  const authRes = await fetch(authUrl, { redirect: 'manual' });
  const location = authRes.headers.get('location');
  if (!location) {
    throw new Error(`Authorization failed with ${authRes.status}`);
  }
  const code = new URL(location).searchParams.get('code');
  if (!code) {
    throw new Error('Authorization response did not include a code');
  }

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    client_id: CLIENT_ID,
    resource: server.resourceUrl,
  });
  const tokenRes = await fetch(new URL('token', server.url), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!tokenRes.ok) {
    throw new Error(`Token exchange failed: ${tokenRes.status} ${await tokenRes.text()}`);
  }
  const tokens = (await tokenRes.json()) as {
    access_token: string;
    token_type: string;
    expires_in: number;
    refresh_token?: string;
    scope?: string;
  };
  return {
    ...tokens,
    obtained_at: Date.now(),
    expires_at: Date.now() + tokens.expires_in * 1000,
  };
}

async function storeTokens(
  tokenStore: InMemoryTokenStore,
  server: OAuthTestServer,
  tokens: MCPOAuthTokens,
  scope = 'read',
): Promise<MCPOAuthTokens> {
  const clientInfo: OAuthClientInformation = {
    client_id: CLIENT_ID,
    redirect_uris: ['http://localhost'],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
    scope,
  };
  const metadata: OAuthStoredClientMetadata = {
    issuer: server.url.replace(/\/$/, ''),
    authorization_endpoint: new URL('authorize', server.url).href,
    token_endpoint: new URL('token', server.url).href,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    token_endpoint_auth_methods_supported: ['none'],
    scopes_supported: scope.split(/\s+/).filter(Boolean),
    server_url: server.url,
    client_source: 'dynamic',
    resource: server.resourceUrl,
  };

  return MCPTokenStorage.storeTokens({
    userId: USER_ID,
    serverName: SERVER_NAME,
    tokens,
    createToken: tokenStore.createToken,
    updateToken: tokenStore.updateToken,
    findToken: tokenStore.findToken,
    clientInfo,
    metadata,
  });
}

describe('MCPConnectionFactory OAuth against real SDK Streamable HTTP server', () => {
  let server: OAuthTestServer;
  let connection: MCPConnection | null;
  let tokenStore: InMemoryTokenStore;

  beforeEach(() => {
    MCPConnection.clearCooldown(SERVER_NAME);
    connection = null;
    tokenStore = new InMemoryTokenStore();
  });

  afterEach(async () => {
    await safeDisconnect(connection);
    if (server) {
      await server.close();
    }
    jest.clearAllMocks();
  });

  it('tries unauthenticated public tool listing only once when an OAuth server has no token', async () => {
    const postHeaders: Array<string | undefined> = [];
    server = await createOAuthMCPServer({
      onResourceRequest: (request) => {
        if (request.method === 'POST') postHeaders.push(request.headers.authorization);
      },
    });
    const result = await MCPConnectionFactory.discoverTools(
      {
        serverName: SERVER_NAME,
        serverConfig: { type: 'streamable-http', url: server.url, requiresOAuth: true },
      },
      {
        useOAuth: true,
        user: { id: USER_ID } as IUser,
        flowManager: createFlowManager(),
        tokenMethods: {
          findToken: tokenStore.findToken,
          createToken: tokenStore.createToken,
          updateToken: tokenStore.updateToken,
          deleteTokens: tokenStore.deleteTokens,
        },
      },
    );

    expect(result).toMatchObject({ tools: null, connection: null, oauthRequired: true });
    expect(postHeaders).toEqual([undefined]);
  });

  it('does not cancel finished SDK requests when a shared run signal is aborted', async () => {
    let resourcePosts = 0;
    server = await createOAuthMCPServer({
      onResourceRequest: (request) => {
        if (request.method === 'POST') resourcePosts += 1;
      },
    });
    const tokens = await issueTokens(server);
    await storeTokens(tokenStore, server, tokens);
    const flowManager = createFlowManager();
    const tokenMethods = {
      findToken: tokenStore.findToken,
      createToken: tokenStore.createToken,
      updateToken: tokenStore.updateToken,
      deleteTokens: tokenStore.deleteTokens,
    };
    const serverConfig = {
      type: 'streamable-http' as const,
      url: server.url,
      requiresOAuth: true,
    };
    connection = await MCPConnectionFactory.create(
      { serverName: SERVER_NAME, serverConfig },
      { useOAuth: true, user: { id: USER_ID } as IUser, flowManager, tokenMethods },
    );
    const manager = new MCPManager();
    jest.spyOn(manager, 'getConnection').mockResolvedValue(connection);
    const registrySpy = jest.spyOn(MCPServersRegistry, 'getInstance').mockReturnValue({
      resolveAllowlists: jest.fn().mockResolvedValue({
        allowedDomains: null,
        allowedAddresses: null,
        useSSRFProtection: false,
      }),
    } as unknown as MCPServersRegistry);
    const controller = new AbortController();
    try {
      for (let index = 0; index < 3; index += 1) {
        await expect(
          manager.callTool({
            user: { id: USER_ID } as IUser,
            serverName: SERVER_NAME,
            serverConfig,
            toolName: 'echo',
            toolArguments: { message: `call ${index}` },
            provider: 'openai',
            flowManager,
            tokenMethods,
            options: { signal: controller.signal },
          }),
        ).resolves.toBeDefined();
      }
      const completedPosts = resourcePosts;
      controller.abort(new Error('Run ended'));
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(resourcePosts).toBe(completedPosts);
    } finally {
      registrySpy.mockRestore();
    }
  });

  it('refreshes an expired callback for the active connection and token waiter after publication settles', async () => {
    server = await createOAuthMCPServer({
      issueRefreshTokens: true,
      rotateRefreshTokens: true,
      requireResourceParameter: true,
    });
    const flowManager = new FlowStateManager<MCPOAuthTokens>(
      new MockKeyv<MCPOAuthTokens>() as unknown as Keyv,
      { ttl: 30000, ci: true },
    );
    const tokenMethods = {
      findToken: tokenStore.findToken,
      createToken: tokenStore.createToken,
      updateToken: tokenStore.updateToken,
      deleteTokens: tokenStore.deleteTokens,
    };
    const basic = {
      serverName: SERVER_NAME,
      serverConfig: {
        type: 'streamable-http' as const,
        url: server.url,
        initTimeout: 15000,
        requiresOAuth: true,
        oauthRefreshCoordination: true,
      },
    };
    const options = {
      useOAuth: true as const,
      user: { id: USER_ID } as IUser,
      flowManager,
      tokenMethods,
    };
    let waitingTokens: Promise<MCPOAuthTokens | null> | undefined;
    let published = false;
    let waiterReachedFence = false;
    const acquireLease = flowManager.acquireLease.bind(flowManager);
    jest.spyOn(flowManager, 'acquireLease').mockImplementation((...args) => {
      if (published) waiterReachedFence = true;
      return acquireLease(...args);
    });
    const oauthStart = jest.fn(async (authorizationUrl: string) => {
      // Follow the actual authorization URL (including PKCE), then use the same exchange and
      // persistence transaction as the callback route. Only the elapsed lifetime is injected.
      const response = await fetch(authorizationUrl, { redirect: 'manual' });
      const code = new URL(response.headers.get('location')!).searchParams.get('code')!;
      const flowId = MCPOAuthHandler.generateFlowId(USER_ID, SERVER_NAME);
      const state = await flowManager.getFlowState(flowId, 'mcp_oauth');
      const metadata = state!.metadata as MCPOAuthFlowMetadata;
      const tokenFlowId = MCPOAuthHandler.generateTokenFlowId(USER_ID, SERVER_NAME);
      await flowManager.initFlow(tokenFlowId, 'mcp_get_tokens');
      waitingTokens = new TokenLoadingFactory(basic, options).loadTokens();
      void waitingTokens.catch(() => undefined);

      await MCPOAuthHandler.completeOAuthFlow(
        flowId,
        code,
        flowManager,
        {},
        async (exchanged, completeAuthorization) => {
          server.issuedTokens.delete(exchanged.access_token);
          return persistMCPAuthorizationTransaction<MCPOAuthTokens>(
            {
              scope: { userId: USER_ID, serverName: SERVER_NAME },
              flowIds: [flowId, MCPOAuthHandler.generateTokenFlowId(USER_ID, SERVER_NAME)],
              tokens: { ...exchanged, expires_at: Date.now() - 1000 },
              completeAuthorization: completeAuthorization!,
              persistTokens: (tokens, onStoreCommitted) =>
                MCPTokenStorage.storeTokens({
                  ...tokenMethods,
                  flowManager,
                  userId: USER_ID,
                  serverName: SERVER_NAME,
                  tokens,
                  clientInfo: metadata.clientInfo,
                  metadata: MCPOAuthHandler.buildStoredClientMetadata(
                    metadata.metadata,
                    metadata.resourceMetadata,
                    metadata.serverUrl,
                    metadata.clientSource,
                  ),
                  onStoreCommitted: async (stored) => {
                    await onStoreCommitted(stored);
                    published = true;
                    // Completion wakes the token waiter before storeTokens releases its lease.
                    // It must not consume the refresh token while rollback is still possible.
                    await waitFor(() => waiterReachedFence);
                    expect(
                      server.tokenRequests.filter((r) => r.grantType === 'refresh_token'),
                    ).toHaveLength(0);
                  },
                }),
            },
            {
              ensureServerActive: async () => true,
              inactiveServerError: () => new Error('Server deleted'),
              invalidateRecoveryGeneration: async () => 'callback-publication',
              flowManager,
              retryDelaysMs: [0],
            },
          );
        },
      );
    });
    connection = await MCPConnectionFactory.create(basic, { ...options, oauthStart });
    const loaded = await waitingTokens;
    expect(loaded).not.toBeNull();
    expect(server.issuedTokens.has(loaded!.access_token)).toBe(true);
    expect(await connection.isConnected()).toBe(true);
    expect((await connection.fetchTools()).some((tool) => tool.name === 'echo')).toBe(true);
    expect(oauthStart).toHaveBeenCalledTimes(1);
    expect(server.tokenRequests.filter((r) => r.grantType === 'refresh_token')).toHaveLength(1);
  });

  it.each([
    {
      status: 503,
      error: 'temporarily_unavailable',
      scope: 'read',
      discovery: false,
      coordinate: false,
    },
    { status: 503, error: 'invalid_client', scope: 'read', discovery: false, coordinate: false },
    { status: 429, error: 'invalid_grant', scope: '', discovery: false, coordinate: false },
    { status: 429, error: 'invalid_scope', scope: 'read', discovery: true, coordinate: true },
    { status: 503, error: 'invalid_client', scope: 'read', discovery: true, coordinate: true },
    { status: 408, error: 'invalid_grant', scope: '', discovery: false, coordinate: true },
  ])(
    'preserves authorization through HTTP $status ($error, discovery=$discovery), then retries without consent',
    async ({ status, error, scope, discovery, coordinate }) => {
      let unavailable = true;
      server = await createOAuthMCPServer({
        issueRefreshTokens: true,
        rotateRefreshTokens: true,
        requireResourceParameter: true,
        refreshFailure: () =>
          unavailable ? { status, body: JSON.stringify({ error }) } : undefined,
      });
      const initial = await issueTokens(server, scope);
      await storeTokens(tokenStore, server, { ...initial, expires_at: Date.now() - 1000 }, scope);
      const flowManager = createFlowManager();
      const oauthStart = jest.fn();
      const tokenMethods = {
        findToken: tokenStore.findToken,
        createToken: tokenStore.createToken,
        updateToken: tokenStore.updateToken,
        deleteTokens: tokenStore.deleteTokens,
      };
      const snapshot = () =>
        Promise.all([
          tokenStore.findToken({
            userId: USER_ID,
            type: 'mcp_oauth_refresh',
            identifier: `mcp:${SERVER_NAME}:refresh`,
          }),
          tokenStore.findToken({
            userId: USER_ID,
            type: 'mcp_oauth_client',
            identifier: `mcp:${SERVER_NAME}:client`,
          }),
        ]);
      const before = await snapshot();
      const basic = {
        serverName: SERVER_NAME,
        serverConfig: {
          type: 'streamable-http' as const,
          url: server.url,
          initTimeout: 15000,
          requiresOAuth: true,
          oauthRefreshCoordination: coordinate,
        },
      };
      const options = {
        useOAuth: true as const,
        user: { id: USER_ID } as IUser,
        flowManager,
        tokenMethods,
        oauthStart,
        returnOnOAuth: true,
      };
      const attempt = () =>
        discovery
          ? MCPConnectionFactory.discoverTools(basic, options)
          : MCPConnectionFactory.create(basic, options);
      await expect(attempt()).rejects.toMatchObject({ name: 'MCPTokenRefreshUnavailableError' });
      expect(oauthStart).not.toHaveBeenCalled();
      expect(await snapshot()).toEqual(before);
      expect(server.issuedRefreshTokens.has(initial.refresh_token!)).toBe(true);
      expect(server.tokenRequests.filter((r) => r.grantType === 'refresh_token')).toHaveLength(1);

      unavailable = false;
      const recovered = await attempt();
      connection = 'connection' in recovered ? recovered.connection : recovered;
      expect(connection).not.toBeNull();
      expect(await connection!.isConnected()).toBe(true);
      expect((await connection!.fetchTools()).some((tool) => tool.name === 'echo')).toBe(true);
      expect(oauthStart).not.toHaveBeenCalled();
      expect(server.tokenRequests.filter((r) => r.grantType === 'authorization_code')).toHaveLength(
        1,
      );
      expect(server.tokenRequests.filter((r) => r.grantType === 'refresh_token')).toHaveLength(2);
      const [rotated] = await snapshot();
      expect(rotated?.token).not.toBe(before[0]?.token);
      expect(server.issuedRefreshTokens.has(rotated!.token.replace(/^enc:/, ''))).toBe(true);
    },
  );

  it.each(['invalid_client', 'invalid_grant'])(
    'still requests consent for a permanent HTTP 400 %s',
    async (error) => {
      server = await createOAuthMCPServer({
        issueRefreshTokens: true,
        refreshFailure: () => ({ status: 400, body: JSON.stringify({ error }) }),
      });
      const initial = await issueTokens(server);
      await storeTokens(tokenStore, server, { ...initial, expires_at: Date.now() - 1000 });
      const oauthStart = jest.fn();
      const flowManager = createFlowManager();
      try {
        await expect(
          MCPConnectionFactory.create(
            {
              serverName: SERVER_NAME,
              serverConfig: { type: 'streamable-http', url: server.url, requiresOAuth: true },
            },
            {
              useOAuth: true,
              user: { id: USER_ID } as IUser,
              flowManager,
              returnOnOAuth: true,
              oauthStart,
              tokenMethods: {
                findToken: tokenStore.findToken,
                createToken: tokenStore.createToken,
                updateToken: tokenStore.updateToken,
                deleteTokens: tokenStore.deleteTokens,
              },
            },
          ),
        ).rejects.toThrow('OAuth flow initiated');
        expect(oauthStart).toHaveBeenCalledTimes(1);
      } finally {
        await flowManager.deleteFlow(
          MCPOAuthHandler.generateFlowId(USER_ID, SERVER_NAME),
          'mcp_oauth',
        );
      }
    },
  );

  it('silently refreshes a server-rejected token and reconnects with the MCP resource parameter', async () => {
    server = await createOAuthMCPServer({
      issueRefreshTokens: true,
      requireResourceParameter: true,
      tokenScopes: ['read'],
      scopesSupported: ['read'],
    });
    const initialTokens = await issueTokens(server);
    await storeTokens(tokenStore, server, initialTokens);

    server.issuedTokens.delete(initialTokens.access_token);

    connection = await MCPConnectionFactory.create(
      {
        serverName: SERVER_NAME,
        serverConfig: {
          type: 'streamable-http',
          url: server.url,
          initTimeout: 15000,
        },
      },
      {
        useOAuth: true,
        user: { id: USER_ID } as IUser,
        flowManager: createFlowManager(),
        tokenMethods: {
          findToken: tokenStore.findToken,
          createToken: tokenStore.createToken,
          updateToken: tokenStore.updateToken,
          deleteTokens: tokenStore.deleteTokens,
        },
      },
    );

    expect(await connection.isConnected()).toBe(true);
    const tools = await connection.fetchTools();
    expect(tools.some((tool) => tool.name === 'echo')).toBe(true);

    const refreshRequest = server.tokenRequests.find(
      (request) => request.grantType === 'refresh_token',
    );
    expect(refreshRequest).toEqual(
      expect.objectContaining({
        resource: server.resourceUrl,
        clientId: CLIENT_ID,
      }),
    );

    const storedAccessToken = await tokenStore.findToken({
      userId: USER_ID,
      type: 'mcp_oauth',
      identifier: `mcp:${SERVER_NAME}`,
    });
    expect(storedAccessToken?.token).not.toBe(`enc:${initialTokens.access_token}`);
  });

  it('recovers a tool call rejected after connection and retries with the refreshed token', async () => {
    server = await createOAuthMCPServer({
      issueRefreshTokens: true,
      requireResourceParameter: true,
      tokenScopes: ['read'],
      scopesSupported: ['read'],
    });
    const initialTokens = await issueTokens(server);
    await storeTokens(tokenStore, server, initialTokens);
    const flowManager = createFlowManager();
    const tokenMethods = {
      findToken: tokenStore.findToken,
      createToken: tokenStore.createToken,
      updateToken: tokenStore.updateToken,
      deleteTokens: tokenStore.deleteTokens,
    };
    const serverConfig = {
      type: 'streamable-http' as const,
      url: server.url,
      initTimeout: 15000,
      requiresOAuth: true,
    };

    connection = await MCPConnectionFactory.create(
      { serverName: SERVER_NAME, serverConfig },
      {
        useOAuth: true,
        user: { id: USER_ID } as IUser,
        flowManager,
        tokenMethods,
      },
    );
    server.issuedTokens.delete(initialTokens.access_token);
    const isConnectedSpy = jest.spyOn(connection, 'isConnected').mockResolvedValueOnce(true);

    const manager = new MCPManager();
    jest.spyOn(manager, 'getConnection').mockResolvedValue(connection);
    const registrySpy = jest.spyOn(MCPServersRegistry, 'getInstance').mockReturnValue({
      resolveAllowlists: jest.fn().mockResolvedValue({
        allowedDomains: null,
        allowedAddresses: null,
        useSSRFProtection: false,
      }),
    } as unknown as MCPServersRegistry);
    const oauthStart = jest.fn(async (_authorizationUrl: string): Promise<void> => undefined);

    try {
      await expect(
        manager.callTool({
          user: { id: USER_ID } as IUser,
          serverName: SERVER_NAME,
          serverConfig,
          toolName: 'echo',
          toolArguments: { message: 'runtime refresh' },
          provider: 'openai',
          flowManager,
          tokenMethods,
          oauthStart,
        }),
      ).resolves.toBeDefined();

      expect(
        server.tokenRequests.filter((request) => request.grantType === 'refresh_token'),
      ).toHaveLength(1);
      expect(oauthStart).not.toHaveBeenCalled();
    } finally {
      isConnectedSpy.mockRestore();
      registrySpy.mockRestore();
    }
  });

  it('lets an in-flight request finish before a concurrent OAuth reconnect', async () => {
    let markSlowRequestStarted: (() => void) | undefined;
    let releaseFirstSlowRequest: (() => void) | undefined;
    const slowRequestStarted = new Promise<void>((resolve) => {
      markSlowRequestStarted = resolve;
    });
    const firstSlowRequestBlocked = new Promise<void>((resolve) => {
      releaseFirstSlowRequest = resolve;
    });
    let slowRequestCount = 0;
    server = await createOAuthMCPServer({
      issueRefreshTokens: true,
      requireResourceParameter: true,
      tokenScopes: ['read'],
      scopesSupported: ['read'],
      echoHandler: async (message) => {
        if (message === 'slow borrower' && slowRequestCount++ === 0) {
          markSlowRequestStarted?.();
          await firstSlowRequestBlocked;
        }
        return `echo: ${message}`;
      },
    });
    const initialTokens = await issueTokens(server);
    await storeTokens(tokenStore, server, initialTokens);
    const flowManager = createFlowManager();
    const tokenMethods = {
      findToken: tokenStore.findToken,
      createToken: tokenStore.createToken,
      updateToken: tokenStore.updateToken,
      deleteTokens: tokenStore.deleteTokens,
    };
    const serverConfig = {
      type: 'streamable-http' as const,
      url: server.url,
      initTimeout: 15000,
      requiresOAuth: true,
    };

    connection = await MCPConnectionFactory.create(
      { serverName: SERVER_NAME, serverConfig },
      {
        useOAuth: true,
        user: { id: USER_ID } as IUser,
        flowManager,
        tokenMethods,
      },
    );
    const connectSpy = jest.spyOn(connection, 'connect');
    const isConnectedSpy = jest.spyOn(connection, 'isConnected').mockResolvedValue(true);

    const manager = new MCPManager();
    jest.spyOn(manager, 'getConnection').mockResolvedValue(connection);
    const registrySpy = jest.spyOn(MCPServersRegistry, 'getInstance').mockReturnValue({
      resolveAllowlists: jest.fn().mockResolvedValue({
        allowedDomains: null,
        allowedAddresses: null,
        useSSRFProtection: false,
      }),
    } as unknown as MCPServersRegistry);
    const oauthStart = jest.fn(async (_authorizationUrl: string): Promise<void> => undefined);
    const callTool = (message: string) =>
      manager.callTool({
        user: { id: USER_ID } as IUser,
        serverName: SERVER_NAME,
        serverConfig,
        toolName: 'echo',
        toolArguments: { message },
        provider: 'openai',
        flowManager,
        tokenMethods,
        oauthStart,
      });

    try {
      const slowCall = callTool('slow borrower');
      await slowRequestStarted;
      server.issuedTokens.delete(initialTokens.access_token);

      const recoveringCall = callTool('recovery owner');
      await waitFor(
        () =>
          server.tokenRequests.filter((request) => request.grantType === 'refresh_token').length ===
          1,
      );

      expect(connectSpy).not.toHaveBeenCalled();
      expect(slowRequestCount).toBe(1);
      releaseFirstSlowRequest?.();

      await expect(Promise.all([slowCall, recoveringCall])).resolves.toHaveLength(2);
      expect(
        server.tokenRequests.filter((request) => request.grantType === 'refresh_token'),
      ).toHaveLength(1);
      expect(slowRequestCount).toBe(1);
      expect(oauthStart).not.toHaveBeenCalled();
    } finally {
      releaseFirstSlowRequest?.();
      connectSpy.mockRestore();
      isConnectedSpy.mockRestore();
      registrySpy.mockRestore();
    }
  });

  it('escalates to interactive OAuth when the resource rejects refreshed tokens during reconnect', async () => {
    server = await createOAuthMCPServer({
      issueRefreshTokens: true,
      requireResourceParameter: true,
      tokenScopes: ['read'],
      scopesSupported: ['read'],
      rejectRefreshTokens: 10,
    });
    const initialTokens = await issueTokens(server);
    await storeTokens(tokenStore, server, initialTokens);
    const flowManager = createFlowManager();
    const tokenMethods = {
      findToken: tokenStore.findToken,
      createToken: tokenStore.createToken,
      updateToken: tokenStore.updateToken,
      deleteTokens: tokenStore.deleteTokens,
    };
    const serverConfig = {
      type: 'streamable-http' as const,
      url: server.url,
      initTimeout: 15000,
      requiresOAuth: true,
    };

    connection = await MCPConnectionFactory.create(
      { serverName: SERVER_NAME, serverConfig },
      {
        useOAuth: true,
        user: { id: USER_ID } as IUser,
        flowManager,
        tokenMethods,
      },
    );
    server.issuedTokens.delete(initialTokens.access_token);
    const isConnectedSpy = jest.spyOn(connection, 'isConnected').mockResolvedValueOnce(true);

    const manager = new MCPManager();
    jest.spyOn(manager, 'getConnection').mockResolvedValue(connection);
    const registrySpy = jest.spyOn(MCPServersRegistry, 'getInstance').mockReturnValue({
      resolveAllowlists: jest.fn().mockResolvedValue({
        allowedDomains: null,
        allowedAddresses: null,
        useSSRFProtection: false,
      }),
    } as unknown as MCPServersRegistry);
    const oauthStart = jest.fn(async (): Promise<void> => {
      const authorizedTokens = await issueTokens(server);
      const storedTokens = await storeTokens(tokenStore, server, authorizedTokens);
      const flowId = MCPOAuthHandler.generateFlowId(USER_ID, SERVER_NAME);
      await flowManager.completeFlow(flowId, 'mcp_oauth', storedTokens);
    });

    try {
      await expect(
        manager.callTool({
          user: { id: USER_ID } as IUser,
          serverName: SERVER_NAME,
          serverConfig,
          toolName: 'echo',
          toolArguments: { message: 'interactive fallback' },
          provider: 'openai',
          flowManager,
          tokenMethods,
          oauthStart,
        }),
      ).resolves.toBeDefined();

      expect(
        server.tokenRequests.filter((request) => request.grantType === 'refresh_token'),
      ).toHaveLength(1);
      expect(oauthStart).toHaveBeenCalledTimes(1);
    } finally {
      isConnectedSpy.mockRestore();
      registrySpy.mockRestore();
    }
  });

  it('starts OAuth once the resource rejects the tokens a refresh issued while connecting', async () => {
    server = await createOAuthMCPServer({
      issueRefreshTokens: true,
      requireResourceParameter: true,
      tokenScopes: ['read'],
      scopesSupported: ['read'],
      rejectRefreshTokens: 10,
    });
    const initialTokens = await issueTokens(server);
    await storeTokens(tokenStore, server, initialTokens);
    server.issuedTokens.delete(initialTokens.access_token);

    const oauthStart = jest.fn(async (_authorizationUrl: string): Promise<void> => undefined);
    await expect(
      MCPConnectionFactory.create(
        {
          serverName: SERVER_NAME,
          serverConfig: {
            type: 'streamable-http',
            url: server.url,
            initTimeout: 15000,
          },
        },
        {
          useOAuth: true,
          user: { id: USER_ID } as IUser,
          flowManager: createFlowManager(),
          tokenMethods: {
            findToken: tokenStore.findToken,
            createToken: tokenStore.createToken,
            updateToken: tokenStore.updateToken,
            deleteTokens: tokenStore.deleteTokens,
          },
          returnOnOAuth: true,
          oauthStart,
        },
      ),
    ).rejects.toThrow();

    expect(
      server.tokenRequests.filter((request) => request.grantType === 'refresh_token'),
    ).toHaveLength(1);
    expect(oauthStart).toHaveBeenCalledTimes(1);
    const authorizationUrl = new URL(oauthStart.mock.calls[0][0]);
    expect(authorizationUrl.searchParams.get('resource')).toBe(server.resourceUrl);
  });

  it('does not silently refresh an SDK insufficient_scope challenge before starting OAuth', async () => {
    server = await createOAuthMCPServer({
      issueRefreshTokens: true,
      requireResourceParameter: true,
      tokenScopes: ['read'],
      requiredScopes: ['write'],
      scopesSupported: ['write'],
    });
    const initialTokens = await issueTokens(server);
    await storeTokens(tokenStore, server, initialTokens);

    const oauthStart = jest.fn(async (_authorizationUrl: string): Promise<void> => undefined);
    await expect(
      MCPConnectionFactory.create(
        {
          serverName: SERVER_NAME,
          serverConfig: {
            type: 'streamable-http',
            url: server.url,
            initTimeout: 15000,
          },
        },
        {
          useOAuth: true,
          user: { id: USER_ID } as IUser,
          flowManager: createFlowManager(),
          tokenMethods: {
            findToken: tokenStore.findToken,
            createToken: tokenStore.createToken,
            updateToken: tokenStore.updateToken,
            deleteTokens: tokenStore.deleteTokens,
          },
          returnOnOAuth: true,
          oauthStart,
        },
      ),
    ).rejects.toThrow();

    expect(
      server.tokenRequests.filter((request) => request.grantType === 'refresh_token'),
    ).toHaveLength(0);
    expect(oauthStart).toHaveBeenCalledTimes(1);
    const authorizationUrl = new URL(oauthStart.mock.calls[0][0]);
    expect(authorizationUrl.searchParams.get('resource')).toBe(server.resourceUrl);
    expect(authorizationUrl.searchParams.get('scope')).toBe('write');
  });
});
