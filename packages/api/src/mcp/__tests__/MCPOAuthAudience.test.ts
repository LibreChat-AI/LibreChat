/**
 * Tests that the optional `audience` field on `mcpServers.<name>.oauth` is
 * forwarded into:
 *   - the pre-configured authorize URL build
 *   - the `refresh_token` grant body
 *
 * The authorize URL is verified by parsing the URL produced by
 * `initiateOAuthFlow`. The refresh case is verified by intercepting the
 * outbound /token POST body via a local HTTP server that records every
 * request body it receives.
 */

import * as net from 'net';
import * as http from 'http';
import { TokenExchangeMethodEnum } from 'librechat-data-provider';
import type { Socket } from 'net';
import { MCPOAuthHandler } from '~/mcp/oauth';

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

/** Bypass SSRF for local test endpoints. */
jest.mock('~/auth', () => ({
  ...jest.requireActual('~/auth'),
  createSSRFSafeUndiciConnect: jest.fn(() => undefined),
  isSSRFTarget: jest.fn(() => false),
  resolveHostnameSSRF: jest.fn(async () => false),
  isOAuthUrlAllowed: jest.fn(() => true),
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

/**
 * Tiny /token endpoint that records every request body and responds with a
 * valid OAuth token payload. Sufficient to assert what LibreChat actually
 * sends to the authorization server during a refresh exchange.
 */
async function startRecordingTokenServer(): Promise<{
  url: string;
  bodies: URLSearchParams[];
  close: () => Promise<void>;
}> {
  const bodies: URLSearchParams[] = [];
  const port = await getFreePort();
  const server = http.createServer((req, res) => {
    if (req.method !== 'POST') {
      res.writeHead(405);
      res.end();
      return;
    }
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      bodies.push(new URLSearchParams(raw));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          access_token: 'new-access-token',
          token_type: 'Bearer',
          expires_in: 3600,
        }),
      );
    });
  });
  const close = trackSockets(server);
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${port}/`, bodies, close };
}

describe('MCP OAuth audience parameter', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('pre-configured authorize URL', () => {
    it('appends audience= query parameter when configured', async () => {
      const { authorizationUrl } = await MCPOAuthHandler.initiateOAuthFlow(
        'test-server',
        'https://example.test/mcp',
        'user-1',
        {},
        {
          authorization_url: 'https://auth.example.test/authorize',
          token_url: 'https://auth.example.test/token',
          client_id: 'test-client',
          client_secret: 'test-secret',
          redirect_uri: 'https://example.test/api/mcp/test-server/oauth/callback',
          scope: 'read execute',
          audience: 'https://example.test/mcp',
          token_exchange_method: TokenExchangeMethodEnum.DefaultPost,
        },
      );

      const url = new URL(authorizationUrl);
      expect(url.searchParams.get('audience')).toBe('https://example.test/mcp');
    });

    it('omits audience when not configured', async () => {
      const { authorizationUrl } = await MCPOAuthHandler.initiateOAuthFlow(
        'test-server',
        'https://example.test/mcp',
        'user-1',
        {},
        {
          authorization_url: 'https://auth.example.test/authorize',
          token_url: 'https://auth.example.test/token',
          client_id: 'test-client',
          client_secret: 'test-secret',
          redirect_uri: 'https://example.test/api/mcp/test-server/oauth/callback',
          scope: 'read',
          token_exchange_method: TokenExchangeMethodEnum.DefaultPost,
        },
      );

      const url = new URL(authorizationUrl);
      expect(url.searchParams.has('audience')).toBe(false);
    });
  });

  describe('refresh_token grant body', () => {
    let recorder: Awaited<ReturnType<typeof startRecordingTokenServer>>;

    beforeEach(async () => {
      recorder = await startRecordingTokenServer();
    });

    afterEach(async () => {
      await recorder.close();
    });

    it('appends audience to refresh body when configured', async () => {
      await MCPOAuthHandler.refreshOAuthTokens(
        'refresh-token-value',
        {
          serverName: 'test-server',
          serverUrl: recorder.url,
          clientInfo: {
            client_id: 'test-client',
            client_secret: 'test-secret',
            redirect_uris: ['http://localhost/callback'],
            token_endpoint_auth_method: 'client_secret_post',
          },
          storedTokenEndpoint: `${recorder.url}token`,
          storedAuthMethods: ['client_secret_post'],
        },
        {},
        {
          token_url: `${recorder.url}token`,
          client_id: 'test-client',
          client_secret: 'test-secret',
          audience: 'https://example.test/mcp',
          token_exchange_method: TokenExchangeMethodEnum.DefaultPost,
        },
      );

      expect(recorder.bodies.length).toBeGreaterThan(0);
      const body = recorder.bodies[recorder.bodies.length - 1];
      expect(body.get('grant_type')).toBe('refresh_token');
      expect(body.get('audience')).toBe('https://example.test/mcp');
    });

    it('omits audience from refresh body when forward_audience_on_refresh=false (Cognito opt-out)', async () => {
      await MCPOAuthHandler.refreshOAuthTokens(
        'refresh-token-value',
        {
          serverName: 'test-server',
          serverUrl: recorder.url,
          clientInfo: {
            client_id: 'test-client',
            client_secret: 'test-secret',
            redirect_uris: ['http://localhost/callback'],
            token_endpoint_auth_method: 'client_secret_post',
          },
          storedTokenEndpoint: `${recorder.url}token`,
          storedAuthMethods: ['client_secret_post'],
        },
        {},
        {
          token_url: `${recorder.url}token`,
          client_id: 'test-client',
          client_secret: 'test-secret',
          audience: 'https://example.test/mcp',
          forward_audience_on_refresh: false,
          token_exchange_method: TokenExchangeMethodEnum.DefaultPost,
        },
      );

      expect(recorder.bodies.length).toBeGreaterThan(0);
      const body = recorder.bodies[recorder.bodies.length - 1];
      expect(body.get('grant_type')).toBe('refresh_token');
      expect(body.has('audience')).toBe(false);
    });

    it('omits audience from refresh body when not configured', async () => {
      await MCPOAuthHandler.refreshOAuthTokens(
        'refresh-token-value',
        {
          serverName: 'test-server',
          serverUrl: recorder.url,
          clientInfo: {
            client_id: 'test-client',
            client_secret: 'test-secret',
            redirect_uris: ['http://localhost/callback'],
            token_endpoint_auth_method: 'client_secret_post',
          },
          storedTokenEndpoint: `${recorder.url}token`,
          storedAuthMethods: ['client_secret_post'],
        },
        {},
        {
          token_url: `${recorder.url}token`,
          client_id: 'test-client',
          client_secret: 'test-secret',
          token_exchange_method: TokenExchangeMethodEnum.DefaultPost,
        },
      );

      expect(recorder.bodies.length).toBeGreaterThan(0);
      const body = recorder.bodies[recorder.bodies.length - 1];
      expect(body.get('grant_type')).toBe('refresh_token');
      expect(body.has('audience')).toBe(false);
    });
  });
});
