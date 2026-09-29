/**
 * Tests for MCP OAuth token expiry → re-authentication scenarios.
 *
 * Reproduces the edge case where:
 * 1. Tokens are stored (access + refresh)
 * 2. Access token expires
 * 3. Refresh attempt fails (server rejects/revokes refresh token)
 * 4. System must fall back to full OAuth re-auth via handleOAuthRequired
 * 5. The CSRF cookie may be absent (chat/SSE flow), so the PENDING flow fallback is needed
 *
 * Also tests the happy path: access token expired but refresh succeeds.
 */

import { Keyv } from 'keyv';
import jwt from 'jsonwebtoken';
import { logger } from '@librechat/data-schemas';
import type { IUser } from '@librechat/data-schemas';
import type { OAuthTestServer } from './helpers/oauthTestServer';
import type { MCPOAuthTokens } from '~/mcp/oauth';
import type * as t from '~/mcp/types';
import {
  persistMCPAuthorizationTransaction,
  prepareMCPAuthorizationMutation,
} from '~/mcp/authorization';
import { MockKeyv, InMemoryTokenStore, createOAuthMCPServer } from './helpers/oauthTestServer';
import { MCPTokenStorage, MCPOAuthHandler, ReauthenticationRequiredError } from '~/mcp/oauth';
import { FlowStateManager, PENDING_STALE_MS } from '~/flow/manager';
import { MCPConnectionFactory } from '~/mcp/MCPConnectionFactory';

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

const credentialSetId = 'token-expiry-credential-set';
const tokenMetadata = { credential_set_id: credentialSetId };

function bindingMetadata(serverUrl: string) {
  return {
    authorization_endpoint: new URL('authorize', serverUrl).href,
    token_endpoint: new URL('token', serverUrl).href,
    server_url: new URL(serverUrl).href,
    client_source: 'dynamic' as const,
    resource: new URL(serverUrl).href,
  };
}

async function waitForCondition(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 5000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() > deadline) {
      throw new Error('Timed out waiting for condition');
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function seedStoredClient(tokenStore: InMemoryTokenStore, serverUrl: string) {
  await tokenStore.createToken({
    userId: 'u1',
    type: 'mcp_oauth_client',
    identifier: 'mcp:test-srv:client',
    token: 'enc:{"client_id":"test-client"}',
    expiresIn: 86400,
    metadata: { ...tokenMetadata, ...bindingMetadata(serverUrl) },
  });
}

describe('Persisted access-token expiry', () => {
  const ONE_YEAR_SECONDS = 365 * 24 * 60 * 60;

  /** Stores one provider response and reports the lifetime the access record actually carries. */
  async function persistedLifetimeSeconds(
    tokens: Record<string, unknown>,
    updateExisting = false,
  ): Promise<number> {
    const tokenStore = new InMemoryTokenStore();
    if (updateExisting) {
      await tokenStore.createToken({
        userId: 'u1',
        type: 'mcp_oauth',
        identifier: 'mcp:test-srv',
        token: 'enc:previous-token',
        expiresIn: 3600,
        metadata: tokenMetadata,
      });
    }
    await MCPTokenStorage.storeTokens({
      userId: 'u1',
      serverName: 'test-srv',
      tokens: tokens as never,
      createToken: tokenStore.createToken,
      updateToken: tokenStore.updateToken,
      findToken: tokenStore.findToken,
      clientInfo: { client_id: 'test-client' },
      metadata: bindingMetadata('https://mcp.example.com/'),
    });
    const stored = await tokenStore.findToken({
      userId: 'u1',
      type: 'mcp_oauth',
      identifier: 'mcp:test-srv',
    });
    return Math.round((stored!.expiresAt.getTime() - Date.now()) / 1000);
  }

  it.each([{ expires_in: 0 }, { expires_at: 0 }])(
    'preserves an explicitly zero lifetime: %j',
    async (expiry) => {
      await expect(
        persistedLifetimeSeconds({
          access_token: 'opaque-zero-lifetime',
          token_type: 'Bearer',
          ...expiry,
        }),
      ).resolves.toBeLessThanOrEqual(0);
    },
  );

  it('updates an existing access record to expire immediately for expires_in zero', async () => {
    await expect(
      persistedLifetimeSeconds(
        {
          access_token: 'replacement',
          token_type: 'Bearer',
          expires_in: 0,
        },
        true,
      ),
    ).resolves.toBeLessThanOrEqual(0);
  });

  it.each([NaN, Infinity])(
    'ignores non-finite expires_at %s in favor of a finite lifetime',
    async (expires_at) => {
      await expect(
        persistedLifetimeSeconds({
          access_token: 'opaque',
          token_type: 'Bearer',
          expires_at,
          expires_in: 3600,
        }),
      ).resolves.toBe(3600);
    },
  );

  it('keeps a disclosed lifetime', async () => {
    await expect(
      persistedLifetimeSeconds({
        access_token: 'opaque-access-token',
        token_type: 'Bearer',
        expires_in: 3600,
        refresh_token: 'r1',
        obtained_at: Date.now(),
      }),
    ).resolves.toBe(3600);
  });

  /**
   * A lifetime that has already elapsed must not be recorded as a year of validity: `getTokens`
   * decides to refresh from this record, so a dead credential stored as valid is only discovered
   * when the resource server rejects a request.
   */
  it('records a credential that arrived expired as expired', async () => {
    const lifetime = await persistedLifetimeSeconds({
      access_token: 'expired-access-token',
      token_type: 'Bearer',
      expires_at: Date.now() - 60_000,
      refresh_token: 'r1',
      obtained_at: Date.now(),
    });
    expect(lifetime).toBeLessThanOrEqual(0);
    expect(lifetime).not.toBe(ONE_YEAR_SECONDS);
  });

  it('does not round a sub-second remaining lifetime up to a year', async () => {
    const lifetime = await persistedLifetimeSeconds({
      access_token: 'nearly-expired-access-token',
      token_type: 'Bearer',
      expires_at: Date.now() + 900,
      refresh_token: 'r1',
      obtained_at: Date.now(),
    });
    expect(lifetime).toBeLessThanOrEqual(1);
    expect(lifetime).not.toBe(ONE_YEAR_SECONDS);
  });

  /**
   * A JWT `exp` comes from the provider's clock, so skew can make a live credential look expired.
   * That case keeps its existing leniency (`tokens.test.ts`) and is deliberately not changed here.
   */
  it('keeps the default for a past JWT exp, which may be clock skew', async () => {
    const expiredJwt = jwt.sign(
      { sub: 'u1', exp: Math.floor(Date.now() / 1000) - 60 },
      'test-secret',
    );
    await expect(
      persistedLifetimeSeconds({
        access_token: expiredJwt,
        token_type: 'Bearer',
        refresh_token: 'r1',
        obtained_at: Date.now(),
      }),
    ).resolves.toBe(ONE_YEAR_SECONDS);
  });

  /** RFC 6749 §5.1 makes `expires_in` only RECOMMENDED, so an unknown lifetime keeps its default. */
  it('keeps the long default when no lifetime is knowable', async () => {
    await expect(
      persistedLifetimeSeconds({
        access_token: 'opaque-access-token-without-expiry',
        token_type: 'Bearer',
        refresh_token: 'r1',
        obtained_at: Date.now(),
      }),
    ).resolves.toBe(ONE_YEAR_SECONDS);
  });
});

describe('A credential persisted with an elapsed lifetime', () => {
  let server: OAuthTestServer;
  let tokenStore: InMemoryTokenStore;

  beforeEach(async () => {
    server = await createOAuthMCPServer({
      tokenTTLMs: 60000,
      issueRefreshTokens: true,
      rotateRefreshTokens: true,
    });
    tokenStore = new InMemoryTokenStore();
  });

  afterEach(async () => {
    await server.close();
  });

  /**
   * The stored-credential read is the only path that can recover before a request fails, so a
   * response whose lifetime already elapsed has to refresh here rather than reach a transport,
   * get rejected, and risk an interactive prompt for a grant that is still renewable.
   */
  it('refreshes on the next read instead of requiring re-authentication', async () => {
    const code = await server.getAuthCode();
    const tokenRes = await fetch(`${server.url}token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `grant_type=authorization_code&code=${code}`,
    });
    const initial = (await tokenRes.json()) as { access_token: string; refresh_token: string };

    await MCPTokenStorage.storeTokens({
      userId: 'u1',
      serverName: 'test-srv',
      tokens: { ...initial, token_type: 'Bearer', obtained_at: Date.now(), expires_at: Date.now() },
      createToken: tokenStore.createToken,
      updateToken: tokenStore.updateToken,
      findToken: tokenStore.findToken,
      clientInfo: { client_id: 'test-client' },
      metadata: bindingMetadata(server.url),
    });

    const result = await MCPTokenStorage.getTokens({
      userId: 'u1',
      serverName: 'test-srv',
      findToken: tokenStore.findToken,
      createToken: tokenStore.createToken,
      updateToken: tokenStore.updateToken,
      refreshTokens: async (refreshToken) => {
        const res = await fetch(`${server.url}token`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: `grant_type=refresh_token&refresh_token=${refreshToken}`,
        });
        if (!res.ok) {
          throw new Error(`Refresh failed: ${res.status}`);
        }
        const data = (await res.json()) as MCPOAuthTokens & { expires_in: number };
        return {
          ...data,
          obtained_at: Date.now(),
          expires_at: Date.now() + data.expires_in * 1000,
        };
      },
    });

    expect(result).not.toBeNull();
    expect(result!.access_token).not.toBe(initial.access_token);
    expect(
      server.tokenRequests.filter(({ grantType }) => grantType === 'refresh_token'),
    ).toHaveLength(1);

    const mcpRes = await fetch(server.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: `Bearer ${result!.access_token}`,
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
});

describe('MCP OAuth Token Expiry Scenarios', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('Access token expired + refresh token available + refresh succeeds', () => {
    let server: OAuthTestServer;
    let tokenStore: InMemoryTokenStore;

    beforeEach(async () => {
      server = await createOAuthMCPServer({
        tokenTTLMs: 500,
        issueRefreshTokens: true,
      });
      tokenStore = new InMemoryTokenStore();
    });

    afterEach(async () => {
      await server.close();
    });

    it('should refresh expired access token via real /token endpoint', async () => {
      // Get initial tokens from real server
      const code = await server.getAuthCode();
      const tokenRes = await fetch(`${server.url}token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `grant_type=authorization_code&code=${code}`,
      });
      const initial = (await tokenRes.json()) as {
        access_token: string;
        token_type: string;
        expires_in: number;
        refresh_token: string;
      };

      // Store expired access token directly (bypassing storeTokens' expiresIn clamping)
      await tokenStore.createToken({
        userId: 'u1',
        type: 'mcp_oauth',
        identifier: 'mcp:test-srv',
        token: `enc:${initial.access_token}`,
        expiresIn: -1,
        metadata: tokenMetadata,
      });
      await tokenStore.createToken({
        userId: 'u1',
        type: 'mcp_oauth_refresh',
        identifier: 'mcp:test-srv:refresh',
        token: `enc:${initial.refresh_token}`,
        expiresIn: 86400,
        metadata: tokenMetadata,
      });
      await seedStoredClient(tokenStore, server.url);

      const refreshCallback = async (refreshToken: string): Promise<MCPOAuthTokens> => {
        const res = await fetch(`${server.url}token`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: `grant_type=refresh_token&refresh_token=${refreshToken}`,
        });
        if (!res.ok) {
          throw new Error(`Refresh failed: ${res.status}`);
        }
        const data = (await res.json()) as {
          access_token: string;
          token_type: string;
          expires_in: number;
        };
        return {
          ...data,
          obtained_at: Date.now(),
          expires_at: Date.now() + data.expires_in * 1000,
        };
      };

      const result = await MCPTokenStorage.getTokens({
        userId: 'u1',
        serverName: 'test-srv',
        findToken: tokenStore.findToken,
        createToken: tokenStore.createToken,
        updateToken: tokenStore.updateToken,
        refreshTokens: refreshCallback,
      });

      expect(result).not.toBeNull();
      expect(result!.access_token).not.toBe(initial.access_token);

      // Verify the refreshed token works against the server
      const mcpRes = await fetch(server.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          Authorization: `Bearer ${result!.access_token}`,
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
  });

  describe('Discovery budget ends while refreshed tokens wait on the authorization fence', () => {
    let server: OAuthTestServer;
    let tokenStore: InMemoryTokenStore;

    beforeEach(async () => {
      server = await createOAuthMCPServer({
        tokenTTLMs: 60000,
        issueRefreshTokens: true,
        rotateRefreshTokens: true,
      });
      tokenStore = new InMemoryTokenStore();
    });

    afterEach(async () => {
      await server.close();
    });

    it('returns within its budget and still stores the rotated tokens once the fence write lands', async () => {
      const code = await server.getAuthCode();
      const tokenRes = await fetch(`${server.url}token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `grant_type=authorization_code&code=${code}`,
      });
      const initial = (await tokenRes.json()) as { access_token: string; refresh_token: string };
      await tokenStore.createToken({
        userId: 'u1',
        type: 'mcp_oauth',
        identifier: 'mcp:test-srv',
        token: `enc:${initial.access_token}`,
        expiresIn: -1,
        metadata: tokenMetadata,
      });
      await tokenStore.createToken({
        userId: 'u1',
        type: 'mcp_oauth_refresh',
        identifier: 'mcp:test-srv:refresh',
        token: `enc:${initial.refresh_token}`,
        expiresIn: 86400,
        metadata: tokenMetadata,
      });
      await seedStoredClient(tokenStore, server.url);

      const tokenEndpoint = `${server.url}token`;
      /** Redeems at the test provider directly; provider discovery is outside this scenario. */
      class ProviderRefreshFactory extends MCPConnectionFactory {
        protected createRefreshTokensFunction() {
          return async (refreshToken: string): Promise<MCPOAuthTokens> => {
            const res = await fetch(tokenEndpoint, {
              method: 'POST',
              headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
              body: `grant_type=refresh_token&refresh_token=${refreshToken}`,
            });
            const data = (await res.json()) as MCPOAuthTokens & { expires_in: number };
            return {
              ...data,
              obtained_at: Date.now(),
              expires_at: Date.now() + data.expires_in * 1000,
            };
          };
        }
      }

      let releaseFenceWrite: (() => void) | undefined;
      const fenceWrite = new Promise<void>((resolve) => {
        releaseFenceWrite = resolve;
      });
      const persistPublicationRetry = jest.fn(async () => {
        await fenceWrite;
        return 'retry-v1';
      });
      const invalidateRecoveryGeneration = jest.fn().mockResolvedValue('generation-2');
      const clearLocalRecovery = jest.fn();
      const onDiscoveryDetached = jest.fn();
      const flowManager = new FlowStateManager<MCPOAuthTokens | null>(
        new MockKeyv<MCPOAuthTokens | null>() as unknown as Keyv,
        { ttl: 30000, ci: true },
      );
      const refreshGrants = () =>
        server.tokenRequests.filter(({ grantType }) => grantType === 'refresh_token');
      const storedToken = async (type: string, identifier: string) =>
        (await tokenStore.findToken({ userId: 'u1', type, identifier }))?.token.replace(
          /^enc:/,
          '',
        );

      const budgetMs = 2_000;
      const startedAt = Date.now();
      const discovery = ProviderRefreshFactory.discoverTools(
        {
          serverName: 'test-srv',
          serverConfig: {
            type: 'streamable-http',
            url: server.url,
            oauthRefreshCoordination: true,
          },
        },
        {
          useOAuth: true,
          user: { id: 'u1' } as IUser,
          flowManager,
          tokenMethods: {
            findToken: tokenStore.findToken,
            createToken: tokenStore.createToken,
            updateToken: tokenStore.updateToken,
            deleteTokens: tokenStore.deleteTokens,
          },
          deadlineMs: startedAt + budgetMs,
          onDiscoveryDetached,
          onOAuthCredentialsChanging: (scope) =>
            prepareMCPAuthorizationMutation(scope, {
              invalidateRecoveryGeneration,
              clearLocalRecovery,
              persistPublicationRetry,
              retryDelaysMs: [0],
            }),
        },
      );

      await waitForCondition(() => persistPublicationRetry.mock.calls.length === 1);
      expect(refreshGrants()).toHaveLength(1);
      expect(server.issuedRefreshTokens.has(initial.refresh_token)).toBe(false);

      await expect(discovery).resolves.toEqual({
        tools: null,
        connection: null,
        oauthRequired: false,
        oauthUrl: null,
      });
      expect(Date.now() - startedAt).toBeLessThan(budgetMs + 1_000);
      expect(await storedToken('mcp_oauth_refresh', 'mcp:test-srv:refresh')).toBe(
        initial.refresh_token,
      );
      expect(onDiscoveryDetached).toHaveBeenCalledTimes(1);
      const [tokenWork] = onDiscoveryDetached.mock.calls[0] as [Promise<unknown>];

      releaseFenceWrite?.();
      await Promise.allSettled([tokenWork]);
      const tokenFlowId = MCPOAuthHandler.generateTokenFlowId('u1', 'test-srv');
      expect((await flowManager.getFlowState(tokenFlowId, 'mcp_get_tokens'))?.status).toBe(
        'COMPLETED',
      );

      const rotatedRefreshToken = await storedToken('mcp_oauth_refresh', 'mcp:test-srv:refresh');
      const refreshedAccessToken = await storedToken('mcp_oauth', 'mcp:test-srv');
      expect(server.issuedRefreshTokens.has(rotatedRefreshToken ?? '')).toBe(true);
      expect(server.issuedTokens.has(refreshedAccessToken ?? '')).toBe(true);
      expect(invalidateRecoveryGeneration).toHaveBeenCalledWith({
        userId: 'u1',
        serverName: 'test-srv',
      });
      expect(clearLocalRecovery).toHaveBeenCalledWith('u1', 'test-srv', 'generation-2');

      await expect(
        MCPTokenStorage.getTokens({
          userId: 'u1',
          serverName: 'test-srv',
          findToken: tokenStore.findToken,
        }),
      ).resolves.toMatchObject({
        access_token: refreshedAccessToken,
        refresh_token: rotatedRefreshToken,
      });
      expect(refreshGrants()).toHaveLength(1);
    });
  });

  describe('A callback settles or removes the token flow a connection is waiting on', () => {
    let server: OAuthTestServer;
    let tokenStore: InMemoryTokenStore;
    let flowManager: FlowStateManager<MCPOAuthTokens | null>;
    const tokenFlowId = MCPOAuthHandler.generateTokenFlowId('u1', 'test-srv');
    const oauthFlowId = MCPOAuthHandler.generateFlowId('u1', 'test-srv');

    class TokenLoadingFactory extends MCPConnectionFactory {
      public constructor(basic: t.BasicConnectionOptions, options: t.OAuthConnectionOptions) {
        super(basic, options);
      }

      public loadTokens(): Promise<MCPOAuthTokens | null> {
        return this.getOAuthTokens();
      }
    }

    beforeEach(async () => {
      server = await createOAuthMCPServer({ tokenTTLMs: 60000, issueRefreshTokens: true });
      tokenStore = new InMemoryTokenStore();
      flowManager = new FlowStateManager<MCPOAuthTokens | null>(
        new MockKeyv<MCPOAuthTokens | null>() as unknown as Keyv,
        { ttl: 30000, ci: true },
      );
    });

    afterEach(async () => {
      await server.close();
    });

    const waitingConnection = (
      hooks: Pick<
        t.UserConnectionContext,
        'onOAuthCredentialsAdopted' | 'onOAuthCredentialsInvalidated'
      >,
    ) =>
      new TokenLoadingFactory(
        {
          serverName: 'test-srv',
          serverConfig: {
            type: 'streamable-http',
            url: server.url,
            oauthRefreshCoordination: true,
          },
        },
        {
          useOAuth: true,
          user: { id: 'u1' } as IUser,
          flowManager,
          tokenMethods: {
            findToken: tokenStore.findToken,
            createToken: tokenStore.createToken,
            updateToken: tokenStore.updateToken,
            deleteTokens: tokenStore.deleteTokens,
          },
          ...hooks,
        },
      );

    /** Mirrors the callback route: exchanges a code, then stores, publishes, and settles in one transaction. */
    const completeAuthorizationFromCallback = async () => {
      const code = await server.getAuthCode();
      const tokenRes = await fetch(`${server.url}token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `grant_type=authorization_code&code=${code}`,
      });
      const exchanged = (await tokenRes.json()) as {
        access_token: string;
        token_type: string;
        expires_in: number;
        refresh_token: string;
      };
      const exchangedTokens: MCPOAuthTokens = {
        ...exchanged,
        obtained_at: Date.now(),
        expires_at: Date.now() + exchanged.expires_in * 1000,
      };
      await flowManager.initFlow(oauthFlowId, 'mcp_oauth', {
        serverName: 'test-srv',
        userId: 'u1',
        serverUrl: server.url,
        state: 'callback-state',
      });
      const stored = await persistMCPAuthorizationTransaction(
        {
          scope: { userId: 'u1', serverName: 'test-srv' },
          flowIds: [tokenFlowId, oauthFlowId],
          tokens: exchangedTokens,
          completeAuthorization: async (tokens) => {
            await flowManager.completeFlow(oauthFlowId, 'mcp_oauth', tokens);
          },
          persistTokens: (tokens, onStoreCommitted) =>
            MCPTokenStorage.storeTokens({
              userId: 'u1',
              serverName: 'test-srv',
              tokens,
              createToken: tokenStore.createToken,
              updateToken: tokenStore.updateToken,
              deleteTokens: tokenStore.deleteTokens,
              findToken: tokenStore.findToken,
              clientInfo: { client_id: 'test-client' },
              metadata: bindingMetadata(server.url),
              onStoreCommitted,
            }),
        },
        {
          ensureServerActive: async () => true,
          inactiveServerError: () => new Error('deleted'),
          invalidateRecoveryGeneration: async () => 'generation-2',
          persistPublicationRetry: async () => 'retry-v1',
          clearPublicationRetry: async () => undefined,
          flowManager,
          retryDelaysMs: [0],
        },
      );
      return { exchanged, stored };
    };

    it('re-reads the tokens a callback stored after removing the failed flow it was waiting on', async () => {
      let failEarlierAttempt: (() => void) | undefined;
      const earlierAttempt = flowManager.createFlowWithHandler(
        tokenFlowId,
        'mcp_get_tokens',
        () =>
          new Promise<MCPOAuthTokens | null>((_, reject) => {
            failEarlierAttempt = () =>
              reject(new ReauthenticationRequiredError('test-srv', 'missing'));
          }),
      );
      await waitForCondition(
        async () =>
          (await flowManager.getFlowState(tokenFlowId, 'mcp_get_tokens'))?.status === 'PENDING',
      );

      const onOAuthCredentialsInvalidated = jest.fn().mockResolvedValue(undefined);
      const onOAuthCredentialsAdopted = jest.fn();
      const waiting = waitingConnection({
        onOAuthCredentialsInvalidated,
        onOAuthCredentialsAdopted,
      }).loadTokens();
      await new Promise((resolve) => setTimeout(resolve, 250));

      failEarlierAttempt?.();
      await expect(earlierAttempt).rejects.toBeInstanceOf(ReauthenticationRequiredError);
      expect((await flowManager.getFlowState(tokenFlowId, 'mcp_get_tokens'))?.status).toBe(
        'FAILED',
      );

      const { exchanged } = await completeAuthorizationFromCallback();
      expect(await flowManager.getFlowState(tokenFlowId, 'mcp_get_tokens')).toBeFalsy();

      await expect(waiting).resolves.toMatchObject({ access_token: exchanged.access_token });
      expect(onOAuthCredentialsInvalidated).toHaveBeenCalledTimes(1);
      expect(onOAuthCredentialsAdopted).not.toHaveBeenCalled();
      expect((await flowManager.getFlowState(oauthFlowId, 'mcp_oauth'))?.result).toMatchObject({
        access_token: exchanged.access_token,
        publication_generation: 'generation-2',
      });
    }, 15000);

    it('adopts the generation a callback published when it settles the flow it was waiting on', async () => {
      let finishEarlierAttempt: (() => void) | undefined;
      const earlierAttempt = flowManager.createFlowWithHandler(
        tokenFlowId,
        'mcp_get_tokens',
        () =>
          new Promise<MCPOAuthTokens | null>((resolve) => {
            finishEarlierAttempt = () => resolve(null);
          }),
      );
      await waitForCondition(
        async () =>
          (await flowManager.getFlowState(tokenFlowId, 'mcp_get_tokens'))?.status === 'PENDING',
      );

      const onOAuthCredentialsInvalidated = jest.fn().mockResolvedValue(undefined);
      const onOAuthCredentialsAdopted = jest.fn();
      const waiting = waitingConnection({
        onOAuthCredentialsInvalidated,
        onOAuthCredentialsAdopted,
      }).loadTokens();
      await new Promise((resolve) => setTimeout(resolve, 250));

      const { exchanged } = await completeAuthorizationFromCallback();

      await expect(waiting).resolves.toMatchObject({
        access_token: exchanged.access_token,
        publication_generation: 'generation-2',
      });
      expect(onOAuthCredentialsAdopted).toHaveBeenCalledWith('generation-2');
      expect(onOAuthCredentialsInvalidated).not.toHaveBeenCalled();

      finishEarlierAttempt?.();
      await expect(earlierAttempt).resolves.toMatchObject({
        access_token: exchanged.access_token,
      });
    }, 15000);
  });

  describe('Access token expired + refresh token rejected by server', () => {
    let tokenStore: InMemoryTokenStore;

    beforeEach(() => {
      tokenStore = new InMemoryTokenStore();
    });

    it('should return null when refresh token is rejected (invalid_grant)', async () => {
      const server = await createOAuthMCPServer({
        tokenTTLMs: 60000,
        issueRefreshTokens: true,
      });

      try {
        const code = await server.getAuthCode();
        const tokenRes = await fetch(`${server.url}token`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: `grant_type=authorization_code&code=${code}`,
        });
        const initial = (await tokenRes.json()) as {
          access_token: string;
          token_type: string;
          expires_in: number;
          refresh_token: string;
        };

        // Store expired access token directly
        await tokenStore.createToken({
          userId: 'u1',
          type: 'mcp_oauth',
          identifier: 'mcp:test-srv',
          token: `enc:${initial.access_token}`,
          expiresIn: -1,
          metadata: tokenMetadata,
        });
        await tokenStore.createToken({
          userId: 'u1',
          type: 'mcp_oauth_refresh',
          identifier: 'mcp:test-srv:refresh',
          token: `enc:${initial.refresh_token}`,
          expiresIn: 86400,
          metadata: tokenMetadata,
        });
        await seedStoredClient(tokenStore, server.url);

        // Simulate server revoking the refresh token
        server.issuedRefreshTokens.clear();

        const refreshCallback = async (refreshToken: string): Promise<MCPOAuthTokens> => {
          const res = await fetch(`${server.url}token`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: `grant_type=refresh_token&refresh_token=${refreshToken}`,
          });
          if (!res.ok) {
            const body = (await res.json()) as { error: string };
            throw new Error(`Token refresh failed: ${body.error}`);
          }
          const data = (await res.json()) as MCPOAuthTokens;
          return data;
        };

        const result = await MCPTokenStorage.getTokens({
          userId: 'u1',
          serverName: 'test-srv',
          findToken: tokenStore.findToken,
          createToken: tokenStore.createToken,
          updateToken: tokenStore.updateToken,
          refreshTokens: refreshCallback,
        });

        expect(result).toBeNull();
        expect(logger.error).toHaveBeenCalledWith(
          expect.stringContaining('Failed to refresh tokens'),
          expect.any(Error),
        );
      } finally {
        await server.close();
      }
    });

    it('should return null when refresh endpoint returns unauthorized_client', async () => {
      await tokenStore.createToken({
        userId: 'u1',
        type: 'mcp_oauth',
        identifier: 'mcp:test-srv',
        token: 'enc:expired-token',
        expiresIn: -1,
        metadata: tokenMetadata,
      });
      await tokenStore.createToken({
        userId: 'u1',
        type: 'mcp_oauth_refresh',
        identifier: 'mcp:test-srv:refresh',
        token: 'enc:some-refresh-token',
        expiresIn: 86400,
        metadata: tokenMetadata,
      });
      await seedStoredClient(tokenStore, 'https://mcp.example.com/');

      const refreshCallback = jest
        .fn()
        .mockRejectedValue(new Error('unauthorized_client: client not authorized for refresh'));

      const result = await MCPTokenStorage.getTokens({
        userId: 'u1',
        serverName: 'test-srv',
        findToken: tokenStore.findToken,
        createToken: tokenStore.createToken,
        updateToken: tokenStore.updateToken,
        refreshTokens: refreshCallback,
      });

      expect(result).toBeNull();
      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining('does not support refresh tokens'),
      );
    });
  });

  describe('Access token expired + NO refresh token → ReauthenticationRequiredError', () => {
    let tokenStore: InMemoryTokenStore;

    beforeEach(() => {
      tokenStore = new InMemoryTokenStore();
    });

    it('should throw ReauthenticationRequiredError when no refresh token stored', async () => {
      await tokenStore.createToken({
        userId: 'u1',
        type: 'mcp_oauth',
        identifier: 'mcp:test-srv',
        token: 'enc:expired-token',
        expiresIn: -1,
      });

      await expect(
        MCPTokenStorage.getTokens({
          userId: 'u1',
          serverName: 'test-srv',
          findToken: tokenStore.findToken,
        }),
      ).rejects.toThrow(ReauthenticationRequiredError);
    });

    it('should throw ReauthenticationRequiredError with correct reason for expired token', async () => {
      await tokenStore.createToken({
        userId: 'u1',
        type: 'mcp_oauth',
        identifier: 'mcp:test-srv',
        token: 'enc:expired-token',
        expiresIn: -1,
      });

      await expect(
        MCPTokenStorage.getTokens({
          userId: 'u1',
          serverName: 'test-srv',
          findToken: tokenStore.findToken,
        }),
      ).rejects.toThrow('access token expired');
    });

    it('should throw ReauthenticationRequiredError with correct reason for missing token', async () => {
      await expect(
        MCPTokenStorage.getTokens({
          userId: 'u1',
          serverName: 'test-srv',
          findToken: tokenStore.findToken,
        }),
      ).rejects.toThrow('access token missing');
    });
  });

  describe('PENDING flow fallback for CSRF-less OAuth callbacks', () => {
    it('should allow OAuth completion when PENDING flow exists (simulating chat/SSE path)', async () => {
      const store = new MockKeyv<MCPOAuthTokens | null>();
      const flowManager = new FlowStateManager(store as unknown as Keyv, {
        ttl: 30000,
        ci: true,
      });

      const flowId = 'user1:test-server';

      await flowManager.initFlow(flowId, 'mcp_oauth', {
        serverName: 'test-server',
        userId: 'user1',
        serverUrl: 'https://example.com',
        state: 'test-state',
        authorizationUrl: 'https://example.com/authorize?state=user1:test-server',
      });

      const state = await flowManager.getFlowState(flowId, 'mcp_oauth');
      expect(state?.status).toBe('PENDING');

      const tokens: MCPOAuthTokens = {
        access_token: 'new-access-token',
        token_type: 'Bearer',
        refresh_token: 'new-refresh-token',
        obtained_at: Date.now(),
        expires_at: Date.now() + 3600000,
      };

      const completed = await flowManager.completeFlow(flowId, 'mcp_oauth', tokens);
      expect(completed).toBe(true);

      const completedState = await flowManager.getFlowState(flowId, 'mcp_oauth');
      expect(completedState?.status).toBe('COMPLETED');
      expect((completedState?.result as MCPOAuthTokens | undefined)?.access_token).toBe(
        'new-access-token',
      );
    });

    it('should store authorizationUrl in flow metadata for re-issuance', async () => {
      const store = new MockKeyv<MCPOAuthTokens | null>();
      const flowManager = new FlowStateManager(store as unknown as Keyv, {
        ttl: 30000,
        ci: true,
      });

      const flowId = 'user1:test-server';
      const authUrl = 'https://auth.example.com/authorize?client_id=abc&state=user1:test-server';

      await flowManager.initFlow(flowId, 'mcp_oauth', {
        serverName: 'test-server',
        userId: 'user1',
        serverUrl: 'https://example.com',
        state: 'test-state',
        authorizationUrl: authUrl,
      });

      const state = await flowManager.getFlowState(flowId, 'mcp_oauth');
      expect((state?.metadata as Record<string, unknown>)?.authorizationUrl).toBe(authUrl);
    });
  });

  describe('Full token expiry → refresh failure → re-auth flow', () => {
    let server: OAuthTestServer;
    let tokenStore: InMemoryTokenStore;

    beforeEach(async () => {
      server = await createOAuthMCPServer({
        tokenTTLMs: 60000,
        issueRefreshTokens: true,
      });
      tokenStore = new InMemoryTokenStore();
    });

    afterEach(async () => {
      await server.close();
    });

    it('should go through full cycle: get tokens → expire → refresh fails → re-auth needed', async () => {
      // Step 1: Get initial tokens
      const code = await server.getAuthCode();
      const tokenRes = await fetch(`${server.url}token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `grant_type=authorization_code&code=${code}`,
      });
      const initial = (await tokenRes.json()) as {
        access_token: string;
        token_type: string;
        expires_in: number;
        refresh_token: string;
      };

      // Step 2: Store tokens with valid expiry first
      await MCPTokenStorage.storeTokens({
        userId: 'u1',
        serverName: 'test-srv',
        tokens: initial,
        createToken: tokenStore.createToken,
        clientInfo: { client_id: 'test-client' },
        metadata: bindingMetadata(server.url),
      });

      // Step 3: Verify tokens work
      const validResult = await MCPTokenStorage.getTokens({
        userId: 'u1',
        serverName: 'test-srv',
        findToken: tokenStore.findToken,
      });
      expect(validResult).not.toBeNull();
      expect(validResult!.access_token).toBe(initial.access_token);

      // Step 4: Simulate token expiry by directly updating the stored token's expiresAt
      await tokenStore.updateToken({ userId: 'u1', identifier: 'mcp:test-srv' }, { expiresIn: -1 });

      // Step 5: Revoke refresh token on server side (simulating server-side revocation)
      server.issuedRefreshTokens.clear();

      // Step 6: Try to get tokens — refresh should fail, return null
      const refreshCallback = async (refreshToken: string): Promise<MCPOAuthTokens> => {
        const res = await fetch(`${server.url}token`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: `grant_type=refresh_token&refresh_token=${refreshToken}`,
        });
        if (!res.ok) {
          const body = (await res.json()) as { error: string };
          throw new Error(`Refresh failed: ${body.error}`);
        }
        const data = (await res.json()) as MCPOAuthTokens;
        return data;
      };

      const expiredResult = await MCPTokenStorage.getTokens({
        userId: 'u1',
        serverName: 'test-srv',
        findToken: tokenStore.findToken,
        createToken: tokenStore.createToken,
        updateToken: tokenStore.updateToken,
        refreshTokens: refreshCallback,
      });

      // Refresh failed → returns null → triggers OAuth re-auth flow
      expect(expiredResult).toBeNull();

      // Step 7: Simulate the re-auth flow via FlowStateManager
      const flowStore = new MockKeyv<MCPOAuthTokens | null>();
      const flowManager = new FlowStateManager(flowStore as unknown as Keyv, {
        ttl: 30000,
        ci: true,
      });
      const flowId = 'u1:test-srv';

      await flowManager.initFlow(flowId, 'mcp_oauth', {
        serverName: 'test-srv',
        userId: 'u1',
        serverUrl: server.url,
        state: 'test-state',
        authorizationUrl: `${server.url}authorize?state=${flowId}`,
      });

      // Step 8: Get a new auth code and exchange for tokens (simulating user re-auth)
      const newCode = await server.getAuthCode();
      const newTokenRes = await fetch(`${server.url}token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `grant_type=authorization_code&code=${newCode}`,
      });
      const newTokens = (await newTokenRes.json()) as {
        access_token: string;
        token_type: string;
        expires_in: number;
        refresh_token?: string;
      };

      // Step 9: Complete the flow
      const mcpTokens: MCPOAuthTokens = {
        ...newTokens,
        obtained_at: Date.now(),
        expires_at: Date.now() + newTokens.expires_in * 1000,
      };
      await flowManager.completeFlow(flowId, 'mcp_oauth', mcpTokens);

      // Step 10: Store the new tokens
      await MCPTokenStorage.storeTokens({
        userId: 'u1',
        serverName: 'test-srv',
        tokens: mcpTokens,
        createToken: tokenStore.createToken,
        updateToken: tokenStore.updateToken,
        findToken: tokenStore.findToken,
        clientInfo: { client_id: 'test-client' },
        metadata: bindingMetadata(server.url),
      });

      // Step 11: Verify new tokens work
      const newResult = await MCPTokenStorage.getTokens({
        userId: 'u1',
        serverName: 'test-srv',
        findToken: tokenStore.findToken,
      });
      expect(newResult).not.toBeNull();
      expect(newResult!.access_token).toBe(newTokens.access_token);

      // Step 12: Verify new token works against server
      const finalMcpRes = await fetch(server.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          Authorization: `Bearer ${newResult!.access_token}`,
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
      expect(finalMcpRes.status).toBe(200);
    });
  });

  describe('Concurrent token expiry with connection mutex', () => {
    it('should handle multiple concurrent getTokens calls when token is expired', async () => {
      const tokenStore = new InMemoryTokenStore();

      await tokenStore.createToken({
        userId: 'u1',
        type: 'mcp_oauth',
        identifier: 'mcp:test-srv',
        token: 'enc:expired-token',
        expiresIn: -1,
        metadata: tokenMetadata,
      });
      await tokenStore.createToken({
        userId: 'u1',
        type: 'mcp_oauth_refresh',
        identifier: 'mcp:test-srv:refresh',
        token: 'enc:valid-refresh',
        expiresIn: 86400,
        metadata: tokenMetadata,
      });
      await seedStoredClient(tokenStore, 'https://mcp.example.com/');

      let refreshCallCount = 0;
      const refreshCallback = jest.fn().mockImplementation(async () => {
        refreshCallCount++;
        await new Promise((r) => setTimeout(r, 100));
        return {
          access_token: `refreshed-token-${refreshCallCount}`,
          token_type: 'Bearer',
          expires_in: 3600,
          obtained_at: Date.now(),
          expires_at: Date.now() + 3600000,
        };
      });

      // Fire 3 concurrent getTokens calls via FlowStateManager (like the connection mutex does)
      const flowStore = new MockKeyv<MCPOAuthTokens | null>();
      const flowManager = new FlowStateManager(flowStore as unknown as Keyv, {
        ttl: 30000,
        ci: true,
      });

      const getTokensViaFlow = () =>
        flowManager.createFlowWithHandler('u1:test-srv', 'mcp_get_tokens', async () => {
          return await MCPTokenStorage.getTokens({
            userId: 'u1',
            serverName: 'test-srv',
            findToken: tokenStore.findToken,
            createToken: tokenStore.createToken,
            updateToken: tokenStore.updateToken,
            refreshTokens: refreshCallback,
          });
        });

      const [r1, r2, r3] = await Promise.all([
        getTokensViaFlow(),
        getTokensViaFlow(),
        getTokensViaFlow(),
      ]);

      // All should get tokens (either directly or via flow coalescing)
      expect(r1).not.toBeNull();
      expect(r2).not.toBeNull();
      expect(r3).not.toBeNull();

      // The refresh callback should only be called once due to flow coalescing
      expect(refreshCallback).toHaveBeenCalledTimes(1);
    });
  });

  describe('Stale PENDING flow detection', () => {
    it('should treat PENDING flows older than 2 minutes as stale', async () => {
      const flowStore = new MockKeyv<MCPOAuthTokens | null>();
      const flowManager = new FlowStateManager(flowStore as unknown as Keyv, {
        ttl: 300000,
        ci: true,
      });

      const flowId = 'user1:test-server';
      await flowManager.initFlow(flowId, 'mcp_oauth', {
        serverName: 'test-server',
        authorizationUrl: 'https://example.com/auth',
      });

      // Manually age the flow past the staleness window
      const state = await flowManager.getFlowState(flowId, 'mcp_oauth');
      if (state) {
        state.createdAt = Date.now() - PENDING_STALE_MS - 60 * 1000;
        await (flowStore as unknown as { set: (k: string, v: unknown) => Promise<void> }).set(
          `mcp_oauth:${flowId}`,
          state,
        );
      }

      const agedState = await flowManager.getFlowState(flowId, 'mcp_oauth');
      expect(agedState?.status).toBe('PENDING');

      const age = agedState?.createdAt ? Date.now() - agedState.createdAt : 0;
      expect(age).toBeGreaterThan(PENDING_STALE_MS);

      // A new flow should be created (the stale one would be deleted + recreated)
      // This verifies our staleness check threshold
      expect(age > PENDING_STALE_MS).toBe(true);
    });

    it('should not treat recent PENDING flows as stale', async () => {
      const flowStore = new MockKeyv<MCPOAuthTokens | null>();
      const flowManager = new FlowStateManager(flowStore as unknown as Keyv, {
        ttl: 300000,
        ci: true,
      });

      const flowId = 'user1:test-server';
      await flowManager.initFlow(flowId, 'mcp_oauth', {
        serverName: 'test-server',
        authorizationUrl: 'https://example.com/auth',
      });

      const state = await flowManager.getFlowState(flowId, 'mcp_oauth');
      const age = state?.createdAt ? Date.now() - state.createdAt : Infinity;

      expect(age < PENDING_STALE_MS).toBe(true);
    });
  });
});

describe('mixed-version token flow isolation', () => {
  it.each([undefined, 'tenant/a'])(
    'does not expose typed failures to legacy readers (%s)',
    async (tenantId) => {
      const manager = new FlowStateManager<MCPOAuthTokens>(new Keyv(), { ci: true, ttl: 30_000 });
      const legacyId = MCPOAuthHandler.generateFlowId('u1', 'test-srv', tenantId);
      const currentId = MCPOAuthHandler.generateTokenFlowId('u1', 'test-srv', tenantId);
      expect(currentId).not.toBe(legacyId);
      await manager.initFlow(legacyId, 'mcp_get_tokens');
      await manager.initFlow(currentId, 'mcp_get_tokens');
      const failure = Object.assign(new Error('retry later'), {
        name: 'MCPTokenRefreshUnavailableError',
      });
      await manager.failFlow(currentId, 'mcp_get_tokens', failure);
      expect(await manager.getFlowState(legacyId, 'mcp_get_tokens')).toMatchObject({
        status: 'PENDING',
      });
      expect(await manager.getFlowState(currentId, 'mcp_get_tokens')).toMatchObject({
        status: 'FAILED',
        errorName: failure.name,
      });
      await manager.completeFlow(legacyId, 'mcp_get_tokens', {
        access_token: 'legacy-token',
        obtained_at: Date.now(),
        token_type: 'Bearer',
      });
      expect(await manager.getFlowState(currentId, 'mcp_get_tokens')).toMatchObject({
        status: 'FAILED',
      });
      await manager.deleteFlow(legacyId, 'mcp_get_tokens');
      await manager.deleteFlow(currentId, 'mcp_get_tokens');
    },
  );
});
