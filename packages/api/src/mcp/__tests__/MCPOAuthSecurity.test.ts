/**
 * Tests verifying MCP OAuth security hardening:
 *
 * 1. SSRF via OAuth URLs — validates that the OAuth handler rejects
 *    token_url, authorization_url, and revocation_endpoint values
 *    pointing to private/internal addresses.
 *
 * 2. redirect_uri manipulation — validates that user-supplied redirect_uri
 *    is ignored in favor of the server-controlled default.
 *
 * 3. allowedDomains SSRF exemption — validates that admin-configured allowedDomains
 *    exempts trusted domains from SSRF checks, including auto-discovery paths.
 */

import * as net from 'net';
import * as http from 'http';
import { TokenExchangeMethodEnum } from 'librechat-data-provider';
import type { Socket } from 'net';
import type { OAuthTestServer } from './helpers/oauthTestServer';
import { createOAuthMCPServer } from './helpers/oauthTestServer';
import { MCPOAuthHandler } from '~/mcp/oauth';

jest.mock('@librechat/data-schemas', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
  encryptV2: jest.fn(async (val: string) => `enc:${val}`),
  decryptV2: jest.fn(async (val: string) => val.replace(/^enc:/, '')),
}));

/**
 * Mock only the DNS-dependent resolveHostnameSSRF; keep isSSRFTarget real.
 * SSRF tests use literal private IPs (127.0.0.1, 169.254.169.254, 10.0.0.1)
 * which are caught by isSSRFTarget before resolveHostnameSSRF is reached.
 * This avoids non-deterministic DNS lookups in test execution.
 */
jest.mock('~/auth', () => ({
  ...jest.requireActual('~/auth'),
  resolveHostnameSSRF: jest.fn(async () => false),
}));

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address() as net.AddressInfo;
      srv.close((err) => (err ? reject(err) : resolve(addr.port)));
    });
  });
}

function trackSockets(httpServer: http.Server): () => Promise<void> {
  const sockets = new Set<Socket>();
  httpServer.on('connection', (socket: Socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  return () =>
    new Promise<void>((resolve) => {
      for (const socket of sockets) {
        socket.destroy();
      }
      sockets.clear();
      httpServer.close(() => resolve());
    });
}

describe('MCP OAuth SSRF protection', () => {
  let oauthServer: OAuthTestServer;
  let ssrfTargetServer: http.Server;
  let ssrfTargetPort: number;
  let ssrfRequestReceived: boolean;
  let destroySSRFSockets: () => Promise<void>;

  beforeEach(async () => {
    ssrfRequestReceived = false;

    oauthServer = await createOAuthMCPServer({
      tokenTTLMs: 60000,
      issueRefreshTokens: true,
    });

    ssrfTargetPort = await getFreePort();
    ssrfTargetServer = http.createServer((_req, res) => {
      ssrfRequestReceived = true;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          access_token: 'ssrf-token',
          token_type: 'Bearer',
          expires_in: 3600,
        }),
      );
    });
    destroySSRFSockets = trackSockets(ssrfTargetServer);
    await new Promise<void>((resolve) =>
      ssrfTargetServer.listen(ssrfTargetPort, '127.0.0.1', resolve),
    );
  });

  afterEach(async () => {
    try {
      await oauthServer.close();
    } finally {
      await destroySSRFSockets();
    }
  });

  it('should reject token_url pointing to a private IP (refreshOAuthTokens)', async () => {
    const code = await oauthServer.getAuthCode();
    const tokenRes = await fetch(`${oauthServer.url}token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `grant_type=authorization_code&code=${code}`,
    });
    const initial = (await tokenRes.json()) as {
      access_token: string;
      refresh_token: string;
    };

    const regRes = await fetch(`${oauthServer.url}register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ redirect_uris: ['http://localhost/callback'] }),
    });
    const clientInfo = (await regRes.json()) as {
      client_id: string;
      client_secret: string;
    };

    const ssrfTokenUrl = `http://127.0.0.1:${ssrfTargetPort}/latest/meta-data/iam/security-credentials/`;

    await expect(
      MCPOAuthHandler.refreshOAuthTokens(
        initial.refresh_token,
        {
          serverName: 'ssrf-test-server',
          serverUrl: oauthServer.url,
          clientInfo: {
            ...clientInfo,
            redirect_uris: ['http://localhost/callback'],
            token_endpoint_auth_method: 'client_secret_post',
          },
          storedTokenEndpoint: ssrfTokenUrl,
          storedAuthMethods: ['client_secret_post'],
        },
        {},
        {
          token_url: ssrfTokenUrl,
          client_id: clientInfo.client_id,
          client_secret: clientInfo.client_secret,
          token_exchange_method: TokenExchangeMethodEnum.DefaultPost,
        },
      ),
    ).rejects.toThrow(/targets a blocked address/);

    expect(ssrfRequestReceived).toBe(false);
  });

  it('should reject private authorization_url in initiateOAuthFlow', async () => {
    await expect(
      MCPOAuthHandler.initiateOAuthFlow(
        'test-server',
        'https://mcp.example.com/',
        'user-1',
        {},
        {
          authorization_url: 'http://169.254.169.254/authorize',
          token_url: 'https://auth.example.com/token',
          client_id: 'client',
          client_secret: 'secret',
        },
      ),
    ).rejects.toThrow(/targets a blocked address/);
  });

  it('should reject private token_url in initiateOAuthFlow', async () => {
    await expect(
      MCPOAuthHandler.initiateOAuthFlow(
        'test-server',
        'https://mcp.example.com/',
        'user-1',
        {},
        {
          authorization_url: 'https://auth.example.com/authorize',
          token_url: `http://127.0.0.1:${ssrfTargetPort}/token`,
          client_id: 'client',
          client_secret: 'secret',
        },
      ),
    ).rejects.toThrow(/targets a blocked address/);

    expect(ssrfRequestReceived).toBe(false);
  });

  it('should reject private revocationEndpoint in revokeOAuthToken', async () => {
    await expect(
      MCPOAuthHandler.revokeOAuthToken('test-server', 'some-token', 'access', {
        serverUrl: 'https://mcp.example.com/',
        clientId: 'client',
        clientSecret: 'secret',
        revocationEndpoint: 'http://10.0.0.1/revoke',
      }),
    ).rejects.toThrow(/targets a blocked address/);
  });
});

describe('MCP OAuth redirect_uri enforcement', () => {
  const originalEnv = process.env;
  let oauthServer: OAuthTestServer;

  beforeAll(async () => {
    oauthServer = await createOAuthMCPServer({ tokenTTLMs: 60000 });
  });
  afterAll(async () => {
    await oauthServer.close();
  });
  beforeEach(() => {
    process.env = { ...originalEnv, DOMAIN_CLIENT: 'https://client.example/ui/' };
  });
  afterEach(() => {
    process.env = originalEnv;
  });

  it.each([
    [undefined, 'http://localhost:3080'],
    ['https://server.example', 'https://server.example'],
    ['https://server.example/', 'https://server.example'],
    ['https://server.example///', 'https://server.example'],
    ['https://server.example/chat', 'https://server.example/chat'],
    ['https://server.example/chat/', 'https://server.example/chat'],
    ['https://server.example/chat///', 'https://server.example/chat'],
    ['https://server.example/apps/librechat/', 'https://server.example/apps/librechat'],
  ])('ignores attacker redirects and canonicalizes %s', async (domainServer, baseUrl) => {
    if (domainServer === undefined) {
      delete process.env.DOMAIN_SERVER;
    } else {
      process.env.DOMAIN_SERVER = domainServer;
    }
    const attackerRedirectUri = 'https://attacker.example.com/steal-code';
    for (const preconfigured of [true, false]) {
      const result = await MCPOAuthHandler.initiateOAuthFlow(
        'victim-server',
        oauthServer.url,
        'victim-user-id',
        {},
        preconfigured
          ? {
              authorization_url: `${oauthServer.url}authorize`,
              token_url: `${oauthServer.url}token`,
              client_id: 'test-client',
              redirect_uri: attackerRedirectUri,
            }
          : { redirect_uri: attackerRedirectUri },
        ['127.0.0.1'],
      );
      const authUrl = new URL(result.authorizationUrl);
      const expectedRedirectUri = `${baseUrl}/api/mcp/victim-server/oauth/callback`;
      expect(authUrl.searchParams.get('redirect_uri')).toBe(expectedRedirectUri);
      expect(result.flowMetadata.clientInfo?.redirect_uris).toEqual([expectedRedirectUri]);
      expect(authUrl.searchParams.get('redirect_uri')).not.toBe(attackerRedirectUri);
    }
  });
});

describe('MCP OAuth allowedDomains SSRF exemption for admin-trusted hosts', () => {
  it('should allow private authorization_url when hostname is in allowedDomains', async () => {
    const result = await MCPOAuthHandler.initiateOAuthFlow(
      'internal-server',
      'https://speedy-mcp.company.com/',
      'user-1',
      {},
      {
        authorization_url: 'http://10.0.0.1/authorize',
        token_url: 'http://10.0.0.1/token',
        client_id: 'client',
        client_secret: 'secret',
      },
      ['10.0.0.1'],
    );

    expect(result.authorizationUrl).toContain('10.0.0.1/authorize');
  });

  it('should allow private token_url when hostname matches wildcard allowedDomains', async () => {
    const result = await MCPOAuthHandler.initiateOAuthFlow(
      'internal-server',
      'https://speedy-mcp.company.com/',
      'user-1',
      {},
      {
        authorization_url: 'https://auth.company.internal/authorize',
        token_url: 'https://auth.company.internal/token',
        client_id: 'client',
        client_secret: 'secret',
      },
      ['*.company.internal'],
    );

    expect(result.authorizationUrl).toContain('auth.company.internal/authorize');
  });

  it('should still reject private URLs when allowedDomains does not match', async () => {
    await expect(
      MCPOAuthHandler.initiateOAuthFlow(
        'test-server',
        'https://mcp.example.com/',
        'user-1',
        {},
        {
          authorization_url: 'http://169.254.169.254/authorize',
          token_url: 'https://auth.example.com/token',
          client_id: 'client',
          client_secret: 'secret',
        },
        ['safe.example.com'],
      ),
    ).rejects.toThrow(/targets a blocked address/);
  });

  it('should still reject when allowedDomains is empty', async () => {
    await expect(
      MCPOAuthHandler.initiateOAuthFlow(
        'test-server',
        'https://mcp.example.com/',
        'user-1',
        {},
        {
          authorization_url: 'http://10.0.0.1/authorize',
          token_url: 'https://auth.example.com/token',
          client_id: 'client',
          client_secret: 'secret',
        },
        [],
      ),
    ).rejects.toThrow(/targets a blocked address/);
  });

  it('should allow private revocationEndpoint when hostname is in allowedDomains', async () => {
    const mockFetch = Object.assign(
      jest.fn().mockResolvedValue({ ok: true, status: 200 } as Response),
      { preconnect: jest.fn() },
    );
    const originalFetch = global.fetch;
    global.fetch = mockFetch;

    try {
      await MCPOAuthHandler.revokeOAuthToken(
        'internal-server',
        'some-token',
        'access',
        {
          serverUrl: 'https://internal.corp.net/',
          clientId: 'client',
          clientSecret: 'secret',
          revocationEndpoint: 'http://10.0.0.1/revoke',
        },
        {},
        ['10.0.0.1'],
      );

      expect(mockFetch).toHaveBeenCalled();
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('should allow localhost token_url in refreshOAuthTokens when localhost is in allowedDomains', async () => {
    const mockFetch = Object.assign(
      jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          access_token: 'new-access-token',
          token_type: 'Bearer',
          expires_in: 3600,
        }),
      } as Response),
      { preconnect: jest.fn() },
    );
    const originalFetch = global.fetch;
    global.fetch = mockFetch;

    try {
      const tokens = await MCPOAuthHandler.refreshOAuthTokens(
        'old-refresh-token',
        {
          serverName: 'local-server',
          serverUrl: 'http://localhost:8080/',
          clientInfo: {
            client_id: 'client-id',
            client_secret: 'client-secret',
            redirect_uris: ['http://localhost:3080/callback'],
          },
          storedTokenEndpoint: 'http://localhost:8080/token',
          storedAuthMethods: ['client_secret_basic'],
        },
        {},
        {
          token_url: 'http://localhost:8080/token',
          client_id: 'client-id',
          client_secret: 'client-secret',
        },
        ['localhost'],
      );

      expect(tokens.access_token).toBe('new-access-token');
      expect(mockFetch).toHaveBeenCalled();
    } finally {
      global.fetch = originalFetch;
    }
  });

  describe('auto-discovery path with allowedDomains', () => {
    let discoveryServer: OAuthTestServer;

    beforeEach(async () => {
      discoveryServer = await createOAuthMCPServer({
        tokenTTLMs: 60000,
        issueRefreshTokens: true,
      });
    });

    afterEach(async () => {
      await discoveryServer.close();
    });

    it('should allow auto-discovered OAuth endpoints when server IP is in allowedDomains', async () => {
      const result = await MCPOAuthHandler.initiateOAuthFlow(
        'discovery-server',
        discoveryServer.url,
        'user-1',
        {},
        undefined,
        ['127.0.0.1'],
      );

      expect(result.authorizationUrl).toContain('127.0.0.1');
      expect(result.flowId).toBeTruthy();
    });

    it('should reject auto-discovered endpoints when allowedDomains does not cover server IP', async () => {
      await expect(
        MCPOAuthHandler.initiateOAuthFlow(
          'discovery-server',
          discoveryServer.url,
          'user-1',
          {},
          undefined,
          ['safe.example.com'],
        ),
      ).rejects.toThrow(/targets a blocked address/);
    });

    it('should allow auto-discovered token_url in refreshOAuthTokens branch 3 (no clientInfo/config)', async () => {
      const code = await discoveryServer.getAuthCode();
      const tokenRes = await fetch(`${discoveryServer.url}token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `grant_type=authorization_code&code=${code}`,
      });
      const initial = (await tokenRes.json()) as {
        access_token: string;
        refresh_token: string;
      };

      const tokens = await MCPOAuthHandler.refreshOAuthTokens(
        initial.refresh_token,
        {
          serverName: 'discovery-refresh-server',
          serverUrl: discoveryServer.url,
        },
        {},
        undefined,
        ['127.0.0.1'],
      );

      expect(tokens.access_token).toBeTruthy();
    });
  });
});
