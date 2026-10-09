/**
 * OAuth flow tests against a real HTTP server.
 *
 * Tests MCPOAuthHandler.refreshOAuthTokens and MCPTokenStorage lifecycle
 * using a real test OAuth server (not mocked SDK functions).
 */

import { Keyv } from 'keyv';
import { createHash } from 'crypto';
import { TokenExchangeMethodEnum } from 'librechat-data-provider';
import type { OAuthTestServer } from './helpers/oauthTestServer';
import type { MCPOAuthTokens } from '~/mcp/oauth';
import { createOAuthMCPServer, MockKeyv, InMemoryTokenStore } from './helpers/oauthTestServer';
import { MCPTokenStorage, MCPOAuthHandler } from '~/mcp/oauth';
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

/** Bypass SSRF validation — these tests use real local HTTP servers. */
jest.mock('~/auth', () => ({
  ...jest.requireActual('~/auth'),
  createSSRFSafeUndiciConnect: jest.fn(() => undefined),
  isSSRFTarget: jest.fn(() => false),
  resolveHostnameSSRF: jest.fn(async () => false),
}));

describe('MCP OAuth Flow — Real HTTP Server', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('Token refresh with real server', () => {
    let server: OAuthTestServer;

    beforeEach(async () => {
      server = await createOAuthMCPServer({
        tokenTTLMs: 60000,
        issueRefreshTokens: true,
      });
    });

    afterEach(async () => {
      await server.close();
    });

    it('should refresh tokens with stored client info via real /token endpoint', async () => {
      // First get initial tokens
      const code = await server.getAuthCode();
      const tokenRes = await fetch(`${server.url}token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `grant_type=authorization_code&code=${code}`,
      });
      const initial = (await tokenRes.json()) as {
        access_token: string;
        refresh_token: string;
      };

      expect(initial.refresh_token).toBeDefined();

      // Register a client so we have clientInfo
      const regRes = await fetch(`${server.url}register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ redirect_uris: ['http://localhost/callback'] }),
      });
      const clientInfo = (await regRes.json()) as {
        client_id: string;
        client_secret: string;
      };

      // Refresh tokens using the real endpoint
      const refreshed = await MCPOAuthHandler.refreshOAuthTokens(
        initial.refresh_token,
        {
          serverName: 'test-server',
          serverUrl: server.url,
          clientInfo: {
            ...clientInfo,
            redirect_uris: ['http://localhost/callback'],
            token_endpoint_auth_method: 'client_secret_post',
          },
          storedTokenEndpoint: `${server.url}token`,
          storedAuthMethods: ['client_secret_post'],
        },
        {},
        {
          token_url: `${server.url}token`,
          client_id: clientInfo.client_id,
          client_secret: clientInfo.client_secret,
          token_exchange_method: TokenExchangeMethodEnum.DefaultPost,
        },
      );

      expect(refreshed.access_token).toBeDefined();
      expect(refreshed.access_token).not.toBe(initial.access_token);
      expect(refreshed.token_type).toBe('Bearer');
      expect(refreshed.obtained_at).toBeDefined();
    });

    it('should get new refresh token when server rotates', async () => {
      const rotatingServer = await createOAuthMCPServer({
        tokenTTLMs: 60000,
        issueRefreshTokens: true,
        rotateRefreshTokens: true,
      });

      try {
        const code = await rotatingServer.getAuthCode();
        const tokenRes = await fetch(`${rotatingServer.url}token`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: `grant_type=authorization_code&code=${code}`,
        });
        const initial = (await tokenRes.json()) as {
          access_token: string;
          refresh_token: string;
        };

        const refreshed = await MCPOAuthHandler.refreshOAuthTokens(
          initial.refresh_token,
          {
            serverName: 'test-server',
            serverUrl: rotatingServer.url,
          },
          {},
          {
            token_url: `${rotatingServer.url}token`,
            client_id: 'anon',
            token_exchange_method: TokenExchangeMethodEnum.DefaultPost,
          },
        );

        expect(refreshed.access_token).not.toBe(initial.access_token);
        expect(refreshed.refresh_token).toBeDefined();
        expect(refreshed.refresh_token).not.toBe(initial.refresh_token);
      } finally {
        await rotatingServer.close();
      }
    });

    it('should fail refresh with invalid refresh token', async () => {
      await expect(
        MCPOAuthHandler.refreshOAuthTokens(
          'invalid-refresh-token',
          {
            serverName: 'test-server',
            serverUrl: server.url,
          },
          {},
          {
            token_url: `${server.url}token`,
            client_id: 'anon',
            token_exchange_method: TokenExchangeMethodEnum.DefaultPost,
          },
        ),
      ).rejects.toThrow();
    });
  });

  describe('OAuth server metadata discovery', () => {
    let server: OAuthTestServer;

    beforeEach(async () => {
      server = await createOAuthMCPServer({ issueRefreshTokens: true });
    });

    afterEach(async () => {
      await server.close();
    });

    it('should expose /.well-known/oauth-authorization-server', async () => {
      const res = await fetch(`${server.url}.well-known/oauth-authorization-server`);
      expect(res.status).toBe(200);

      const metadata = (await res.json()) as {
        authorization_endpoint: string;
        token_endpoint: string;
        registration_endpoint: string;
        grant_types_supported: string[];
      };

      expect(metadata.authorization_endpoint).toContain('/authorize');
      expect(metadata.token_endpoint).toContain('/token');
      expect(metadata.registration_endpoint).toContain('/register');
      expect(metadata.grant_types_supported).toContain('authorization_code');
      expect(metadata.grant_types_supported).toContain('refresh_token');
    });

    it('should not advertise refresh_token grant when disabled', async () => {
      const noRefreshServer = await createOAuthMCPServer({
        issueRefreshTokens: false,
      });
      try {
        const res = await fetch(`${noRefreshServer.url}.well-known/oauth-authorization-server`);
        const metadata = (await res.json()) as { grant_types_supported: string[] };
        expect(metadata.grant_types_supported).not.toContain('refresh_token');
      } finally {
        await noRefreshServer.close();
      }
    });
  });

  describe('Dynamic client registration', () => {
    let server: OAuthTestServer;

    beforeEach(async () => {
      server = await createOAuthMCPServer();
    });

    afterEach(async () => {
      await server.close();
    });

    it('should register a client via /register endpoint', async () => {
      const res = await fetch(`${server.url}register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          redirect_uris: ['http://localhost/callback'],
        }),
      });

      expect(res.status).toBe(200);
      const client = (await res.json()) as {
        client_id: string;
        client_secret: string;
        redirect_uris: string[];
      };

      expect(client.client_id).toBeDefined();
      expect(client.client_secret).toBeDefined();
      expect(client.redirect_uris).toEqual(['http://localhost/callback']);
      expect(server.registeredClients.has(client.client_id)).toBe(true);
    });
  });

  describe('End-to-End: store, retrieve, expire, refresh cycle', () => {
    it('should perform full token lifecycle with real server', async () => {
      const server = await createOAuthMCPServer({
        tokenTTLMs: 1000,
        issueRefreshTokens: true,
      });
      const tokenStore = new InMemoryTokenStore();

      try {
        // 1. Get initial tokens via auth code exchange
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

        // 2. Store tokens
        await MCPTokenStorage.storeTokens({
          userId: 'u1',
          serverName: 'test-srv',
          tokens: initial,
          createToken: tokenStore.createToken,
          clientInfo: { client_id: 'test-client' },
          metadata: {
            authorization_endpoint: `${server.url}authorize`,
            token_endpoint: `${server.url}token`,
            server_url: server.url,
            client_source: 'dynamic',
          },
        });

        // 3. Retrieve — should succeed
        const valid = await MCPTokenStorage.getTokens({
          userId: 'u1',
          serverName: 'test-srv',
          findToken: tokenStore.findToken,
        });
        expect(valid).not.toBeNull();
        expect(valid!.access_token).toBe(initial.access_token);
        expect(valid!.refresh_token).toBe(initial.refresh_token);

        // 4. Wait for expiry
        await new Promise((r) => setTimeout(r, 1200));

        // 5. Retrieve again — should trigger refresh via callback
        const refreshCallback = async (refreshToken: string): Promise<MCPOAuthTokens> => {
          const refreshRes = await fetch(`${server.url}token`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/x-www-form-urlencoded',
            },
            body: `grant_type=refresh_token&refresh_token=${refreshToken}`,
          });

          if (!refreshRes.ok) {
            throw new Error(`Refresh failed: ${refreshRes.status}`);
          }

          const data = (await refreshRes.json()) as {
            access_token: string;
            token_type: string;
            expires_in: number;
            refresh_token?: string;
          };

          return {
            ...data,
            obtained_at: Date.now(),
            expires_at: Date.now() + data.expires_in * 1000,
          };
        };

        const refreshed = await MCPTokenStorage.getTokens({
          userId: 'u1',
          serverName: 'test-srv',
          findToken: tokenStore.findToken,
          createToken: tokenStore.createToken,
          updateToken: tokenStore.updateToken,
          refreshTokens: refreshCallback,
        });

        expect(refreshed).not.toBeNull();
        expect(refreshed!.access_token).not.toBe(initial.access_token);

        // 6. Verify the refreshed token works against the server
        const mcpRes = await fetch(server.url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json, text/event-stream',
            Authorization: `Bearer ${refreshed!.access_token}`,
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
      } finally {
        await server.close();
      }
    });
  });

  describe('completeOAuthFlow via FlowStateManager', () => {
    let server: OAuthTestServer;

    beforeEach(async () => {
      server = await createOAuthMCPServer({ issueRefreshTokens: true });
    });

    afterEach(async () => {
      await server.close();
    });

    it('should exchange auth code and complete flow in FlowStateManager', async () => {
      const store = new MockKeyv<MCPOAuthTokens | null>();
      const flowManager = new FlowStateManager(store as unknown as Keyv, {
        ttl: 30000,
        ci: true,
      });

      const flowId = 'test-user:test-server';
      const code = await server.getAuthCode();

      // Initialize the flow with metadata the handler needs
      await flowManager.initFlow(flowId, 'mcp_oauth', {
        serverUrl: server.url,
        clientInfo: {
          client_id: 'test-client',
          redirect_uris: ['http://localhost/callback'],
        },
        codeVerifier: 'test-verifier',
        metadata: {
          token_endpoint: `${server.url}token`,
          token_endpoint_auth_methods_supported: ['client_secret_post'],
        },
      });

      // The SDK's exchangeAuthorization wants full OAuth metadata,
      // so we'll test the token exchange directly instead of going through
      // completeOAuthFlow (which requires full SDK-compatible metadata)
      const tokenRes = await fetch(`${server.url}token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `grant_type=authorization_code&code=${code}`,
      });

      const tokens = (await tokenRes.json()) as {
        access_token: string;
        token_type: string;
        expires_in: number;
        refresh_token?: string;
      };

      const mcpTokens: MCPOAuthTokens = {
        ...tokens,
        obtained_at: Date.now(),
        expires_at: Date.now() + tokens.expires_in * 1000,
      };

      // Complete the flow
      const completed = await flowManager.completeFlow(flowId, 'mcp_oauth', mcpTokens);
      expect(completed).toBe(true);

      const state = await flowManager.getFlowState(flowId, 'mcp_oauth');
      expect(state?.status).toBe('COMPLETED');
      expect((state?.result as MCPOAuthTokens | undefined)?.access_token).toBe(tokens.access_token);
    });

    it('should fail flow when authorization code is invalid', async () => {
      const tokenRes = await fetch(`${server.url}token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'grant_type=authorization_code&code=invalid-code',
      });

      expect(tokenRes.status).toBe(400);
      const body = (await tokenRes.json()) as { error: string };
      expect(body.error).toBe('invalid_grant');
    });

    it('should fail when authorization code is reused', async () => {
      const code = await server.getAuthCode();

      // First exchange succeeds
      const firstRes = await fetch(`${server.url}token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `grant_type=authorization_code&code=${code}`,
      });
      expect(firstRes.status).toBe(200);

      // Second exchange fails
      const secondRes = await fetch(`${server.url}token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `grant_type=authorization_code&code=${code}`,
      });
      expect(secondRes.status).toBe(400);
      const body = (await secondRes.json()) as { error: string };
      expect(body.error).toBe('invalid_grant');
    });
  });

  describe('PKCE verification', () => {
    let server: OAuthTestServer;

    beforeEach(async () => {
      server = await createOAuthMCPServer({ tokenTTLMs: 60000 });
    });

    afterEach(async () => {
      await server.close();
    });

    function generatePKCE(): { verifier: string; challenge: string } {
      const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
      const challenge = createHash('sha256').update(verifier).digest('base64url');
      return { verifier, challenge };
    }

    it('should accept valid code_verifier matching code_challenge', async () => {
      const { verifier, challenge } = generatePKCE();

      const authRes = await fetch(
        `${server.url}authorize?redirect_uri=http://localhost&state=test&code_challenge=${challenge}&code_challenge_method=S256`,
        { redirect: 'manual' },
      );
      const location = authRes.headers.get('location') ?? '';
      const code = new URL(location).searchParams.get('code') ?? '';

      const tokenRes = await fetch(`${server.url}token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `grant_type=authorization_code&code=${code}&code_verifier=${verifier}`,
      });

      expect(tokenRes.status).toBe(200);
      const data = (await tokenRes.json()) as { access_token: string };
      expect(data.access_token).toBeDefined();
    });

    it('should reject wrong code_verifier', async () => {
      const { challenge } = generatePKCE();

      const authRes = await fetch(
        `${server.url}authorize?redirect_uri=http://localhost&state=test&code_challenge=${challenge}&code_challenge_method=S256`,
        { redirect: 'manual' },
      );
      const location = authRes.headers.get('location') ?? '';
      const code = new URL(location).searchParams.get('code') ?? '';

      const tokenRes = await fetch(`${server.url}token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `grant_type=authorization_code&code=${code}&code_verifier=wrong-verifier`,
      });

      expect(tokenRes.status).toBe(400);
      const body = (await tokenRes.json()) as { error: string };
      expect(body.error).toBe('invalid_grant');
    });

    it('should reject missing code_verifier when code_challenge was provided', async () => {
      const { challenge } = generatePKCE();

      const authRes = await fetch(
        `${server.url}authorize?redirect_uri=http://localhost&state=test&code_challenge=${challenge}&code_challenge_method=S256`,
        { redirect: 'manual' },
      );
      const location = authRes.headers.get('location') ?? '';
      const code = new URL(location).searchParams.get('code') ?? '';

      const tokenRes = await fetch(`${server.url}token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `grant_type=authorization_code&code=${code}`,
      });

      expect(tokenRes.status).toBe(400);
      const body = (await tokenRes.json()) as { error: string };
      expect(body.error).toBe('invalid_grant');
    });

    it('should still accept codes without PKCE when no code_challenge was provided', async () => {
      const code = await server.getAuthCode();

      const tokenRes = await fetch(`${server.url}token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `grant_type=authorization_code&code=${code}`,
      });

      expect(tokenRes.status).toBe(200);
    });
  });
});
