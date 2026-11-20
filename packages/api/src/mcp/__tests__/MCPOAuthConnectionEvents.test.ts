/**
 * Tests for MCPConnection OAuth event cycle against a real OAuth-gated MCP server.
 *
 * Verifies: oauthRequired emission on 401, oauthHandled reconnection,
 * oauthFailed rejection, timeout behavior, and token expiry mid-session.
 */

import type { OAuthTestServer } from './helpers/oauthTestServer';
import type { StreamableHTTPOptions } from '~/mcp/types';
import type { MCPOAuthTokens } from '~/mcp/oauth';
import { MCPConnectionFactory } from '~/mcp/MCPConnectionFactory';
import { createOAuthMCPServer } from './helpers/oauthTestServer';
import { MCPConnection } from '~/mcp/connection';

jest.mock('@librechat/data-schemas', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
  encryptV2: jest.fn(async (val: string) => `enc:${val}`),
  decryptV2: jest.fn(async (val: string) => val.replace(/^enc:/, '')),
  getTenantId: jest.fn(),
}));

jest.mock('~/auth', () => ({
  createSSRFSafeUndiciConnect: jest.fn(() => undefined),
  isOAuthUrlAllowed: jest.fn(() => false),
  isSSRFTarget: jest.fn(() => false),
  resolveHostnameSSRF: jest.fn(async () => false),
}));

jest.mock('~/mcp/mcpConfig', () => ({
  mcpConfig: { CONNECTION_CHECK_TTL: 0, USER_CONNECTION_IDLE_TIMEOUT: 30 * 60 * 1000 },
}));

async function safeDisconnect(conn: MCPConnection | null): Promise<void> {
  if (!conn) {
    return;
  }
  try {
    await conn.disconnect();
  } catch {
    // Ignore disconnect errors during cleanup
  }
}

async function exchangeCodeForToken(serverUrl: string): Promise<string> {
  const authRes = await fetch(`${serverUrl}authorize?redirect_uri=http://localhost&state=test`, {
    redirect: 'manual',
  });
  const location = authRes.headers.get('location') ?? '';
  const code = new URL(location).searchParams.get('code') ?? '';

  const tokenRes = await fetch(`${serverUrl}token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=authorization_code&code=${code}`,
  });
  const data = (await tokenRes.json()) as { access_token: string };
  return data.access_token;
}

describe('MCPConnection OAuth Events — Real Server', () => {
  let server: OAuthTestServer;
  let connection: MCPConnection | null = null;

  beforeEach(() => {
    MCPConnection.clearCooldown('test-server');
  });

  afterEach(async () => {
    await safeDisconnect(connection);
    connection = null;
    if (server) {
      await server.close();
    }
    jest.clearAllMocks();
  });

  describe('oauthRequired event', () => {
    beforeEach(async () => {
      server = await createOAuthMCPServer({ tokenTTLMs: 60000 });
    });

    it('should emit oauthRequired when connecting without a token', async () => {
      connection = new MCPConnection({
        serverName: 'test-server',
        serverConfig: { type: 'streamable-http', url: server.url },
        userId: 'user-1',
      });

      const oauthRequiredPromise = new Promise<{
        serverName: string;
        error: Error;
        serverUrl?: string;
        userId?: string;
      }>((resolve) => {
        connection!.on('oauthRequired', (data) => {
          resolve(
            data as {
              serverName: string;
              error: Error;
              serverUrl?: string;
              userId?: string;
            },
          );
        });
      });

      // Connection will fail with 401, emitting oauthRequired
      const connectPromise = connection.connect().catch(() => {
        // Expected to fail since no one handles oauthRequired
      });

      let raceTimer: NodeJS.Timeout | undefined;
      const eventData = await Promise.race([
        oauthRequiredPromise,
        new Promise<never>((_, reject) => {
          raceTimer = setTimeout(
            () => reject(new Error('Timed out waiting for oauthRequired')),
            10000,
          );
        }),
      ]).finally(() => clearTimeout(raceTimer));

      expect(eventData.serverName).toBe('test-server');
      expect(eventData.error).toBeDefined();

      // Emit oauthFailed to unblock connect()
      connection.emit('oauthFailed', new Error('test cleanup'));
      await connectPromise.catch(() => undefined);
    });

    it.each(['credential-a', undefined])(
      'retains a delayed transport identity including absence (%s)',
      async (credential) => {
        const accessToken = await exchangeCodeForToken(server.url);
        connection = new MCPConnection({
          serverName: 'test-server',
          serverConfig: { type: 'streamable-http', url: server.url },
          userId: 'user-1',
          oauthTokens: {
            access_token: accessToken,
            token_type: 'Bearer',
            obtained_at: Date.now(),
            credential_set_id: credential,
          },
        });
        await connection.connect();
        connection.setOAuthTokens({
          access_token: 'new-token',
          token_type: 'Bearer',
          obtained_at: Date.now(),
          credential_set_id: 'credential-b',
        });
        const error = new Error('Error POSTing to endpoint (HTTP 401): Unauthorized');
        const transport = (
          connection as unknown as { transport: { onerror: (error: Error) => void } }
        ).transport;
        transport.onerror(error);
        expect(await connection.isConnected()).toBe(false);
        expect(connection.getLastConnectionCheckError()).toBe(error);
        expect(connection.getLastConnectionCheckCredentialSetId()).toBe(credential ?? null);
        expect(connection.getOAuthCredentialSetId()).toBe(credential ?? null);
      },
    );

    it('should not emit oauthRequired when connecting with a valid token', async () => {
      const accessToken = await exchangeCodeForToken(server.url);

      connection = new MCPConnection({
        serverName: 'test-server',
        serverConfig: { type: 'streamable-http', url: server.url },
        userId: 'user-1',
        oauthTokens: {
          access_token: accessToken,
          token_type: 'Bearer',
        } as MCPOAuthTokens,
      });

      let oauthFired = false;
      connection.on('oauthRequired', () => {
        oauthFired = true;
      });

      await connection.connect();
      expect(await connection.isConnected()).toBe(true);
      expect(oauthFired).toBe(false);
    });
  });

  describe('oauthHandled reconnection', () => {
    beforeEach(async () => {
      server = await createOAuthMCPServer({ tokenTTLMs: 60000 });
    });

    it('should succeed on retry after oauthHandled provides valid tokens', async () => {
      connection = new MCPConnection({
        serverName: 'test-server',
        serverConfig: {
          type: 'streamable-http',
          url: server.url,
          initTimeout: 15000,
        },
        userId: 'user-1',
      });

      // First connect fails with 401 → oauthRequired fires
      let oauthFired = false;
      connection.on('oauthRequired', () => {
        oauthFired = true;
        connection!.emit('oauthFailed', new Error('Will retry with tokens'));
      });

      // First attempt fails as expected
      await expect(connection.connect()).rejects.toThrow();
      expect(oauthFired).toBe(true);

      // Now set valid tokens and reconnect
      const accessToken = await exchangeCodeForToken(server.url);
      connection.setOAuthTokens({
        access_token: accessToken,
        token_type: 'Bearer',
      } as MCPOAuthTokens);

      await connection.connect();
      expect(await connection.isConnected()).toBe(true);
    });
  });

  describe('oauthFailed rejection', () => {
    beforeEach(async () => {
      server = await createOAuthMCPServer({ tokenTTLMs: 60000 });
    });

    it('should reject connect() when oauthFailed is emitted', async () => {
      connection = new MCPConnection({
        serverName: 'test-server',
        serverConfig: {
          type: 'streamable-http',
          url: server.url,
          initTimeout: 15000,
        },
        userId: 'user-1',
      });

      connection.on('oauthRequired', () => {
        connection!.emit('oauthFailed', new Error('User denied OAuth'));
      });

      await expect(connection.connect()).rejects.toThrow();
    });
  });

  describe('Token expiry during session', () => {
    it('should detect expired token on reconnect and emit oauthRequired', async () => {
      server = await createOAuthMCPServer({ tokenTTLMs: 1000 });

      const accessToken = await exchangeCodeForToken(server.url);

      connection = new MCPConnection({
        serverName: 'test-server',
        serverConfig: {
          type: 'streamable-http',
          url: server.url,
          initTimeout: 15000,
        },
        userId: 'user-1',
        oauthTokens: {
          access_token: accessToken,
          credential_set_id: 'expired-credential',
          token_type: 'Bearer',
        } as MCPOAuthTokens,
      });

      // Initial connect should succeed
      await connection.connect();
      expect(await connection.isConnected()).toBe(true);
      await connection.disconnect();

      // Wait for token to expire
      await new Promise((r) => setTimeout(r, 1200));

      // Reconnect should trigger oauthRequired since token is expired on the server
      let oauthFired = false;
      connection.on('oauthRequired', (event) => {
        expect(event.rejectedCredentialSetId).toBe('expired-credential');
        oauthFired = true;
        connection!.emit('oauthFailed', new Error('Will retry with fresh token'));
      });

      // First reconnect fails with 401 → oauthRequired
      await expect(connection.connect()).rejects.toThrow();
      expect(oauthFired).toBe(true);

      // Get fresh token and reconnect
      const newToken = await exchangeCodeForToken(server.url);
      connection.setOAuthTokens({
        access_token: newToken,
        token_type: 'Bearer',
      } as MCPOAuthTokens);

      await connection.connect();
      expect(await connection.isConnected()).toBe(true);
    });
  });

  describe('MCPConnectionFactory.discoverTools — non-OAuth 401 fast-fail', () => {
    beforeEach(async () => {
      server = await createOAuthMCPServer({ tokenTTLMs: 60000 });
    });

    it('should fast-fail when a non-OAuth discovery hits 401', async () => {
      const basicOptions = {
        serverName: 'test-server',
        serverConfig: {
          type: 'streamable-http',
          url: server.url,
          initTimeout: 15000,
        } as StreamableHTTPOptions,
      };

      const start = Date.now();
      const result = await MCPConnectionFactory.discoverTools(basicOptions);
      const elapsed = Date.now() - start;

      expect(elapsed).toBeLessThan(5000);
      expect(result.tools).toBeNull();
      expect(result.oauthRequired).toBe(true);
      expect(result.oauthUrl).toBeNull();
      expect(result.connection).toBeNull();
    });
  });
});
