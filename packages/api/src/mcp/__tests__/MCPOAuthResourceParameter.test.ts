/**
 * Tests that `mcpServers.<name>.oauth.send_resource_parameter: false` suppresses the
 * RFC 8707 `resource` parameter that Protected Resource Metadata discovery otherwise
 * injects into:
 *   - the pre-configured authorize URL
 *   - the `refresh_token` grant body
 *
 * and that the decision is captured on the flow metadata the token exchange reads.
 *
 * A local HTTP server publishes RFC 9728 Protected Resource Metadata so discovery
 * yields a real `resource` identifier bound to the MCP server URL. The refresh case
 * is verified by recording the outbound /token POST body.
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

/** MCP server that publishes RFC 9728 metadata whose `resource` matches its own URL. */
async function startProtectedResourceServer(): Promise<{
  serverUrl: string;
  close: () => Promise<void>;
}> {
  const port = await getFreePort();
  const serverUrl = `http://127.0.0.1:${port}/mcp`;
  const server = http.createServer((req, res) => {
    if (req.url?.startsWith('/.well-known/oauth-protected-resource')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ resource: serverUrl, scopes_supported: ['mcp.read'] }));
      return;
    }
    res.writeHead(401, { 'WWW-Authenticate': 'Bearer' });
    res.end();
  });
  const close = trackSockets(server);
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  return { serverUrl, close };
}

/** Records every /token request body and answers with a valid token payload. */
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

describe('MCP OAuth send_resource_parameter', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('pre-configured authorize URL', () => {
    it('sends the discovered resource identifier by default', async () => {
      const { serverUrl, close } = await startProtectedResourceServer();
      try {
        const { authorizationUrl, flowMetadata } = await MCPOAuthHandler.initiateOAuthFlow(
          'entra-server',
          serverUrl,
          'user-1',
          {},
          {
            authorization_url: 'https://login.microsoftonline.test/tenant/oauth2/v2.0/authorize',
            token_url: 'https://login.microsoftonline.test/tenant/oauth2/v2.0/token',
            client_id: 'test-client',
            client_secret: 'test-secret',
            scope: 'api://test-client/access_as_user openid offline_access',
            token_exchange_method: TokenExchangeMethodEnum.DefaultPost,
          },
        );

        expect(new URL(authorizationUrl).searchParams.get('resource')).toBe(serverUrl);
        expect(flowMetadata.sendResourceParameter).toBeUndefined();
        expect(flowMetadata.resourceMetadata?.resource).toBe(serverUrl);
      } finally {
        await close();
      }
    });

    it('omits the resource parameter when send_resource_parameter is false', async () => {
      const { serverUrl, close } = await startProtectedResourceServer();
      try {
        const { authorizationUrl, flowMetadata } = await MCPOAuthHandler.initiateOAuthFlow(
          'entra-server',
          serverUrl,
          'user-1',
          {},
          {
            authorization_url: 'https://login.microsoftonline.test/tenant/oauth2/v2.0/authorize',
            token_url: 'https://login.microsoftonline.test/tenant/oauth2/v2.0/token',
            client_id: 'test-client',
            client_secret: 'test-secret',
            scope: 'api://test-client/access_as_user openid offline_access',
            token_exchange_method: TokenExchangeMethodEnum.DefaultPost,
            send_resource_parameter: false,
          },
        );

        const params = new URL(authorizationUrl).searchParams;
        expect(params.has('resource')).toBe(false);
        expect(params.get('scope')).toBe('api://test-client/access_as_user openid offline_access');
        expect(flowMetadata.sendResourceParameter).toBe(false);
        /** Capability discovery is untouched: the document is still validated and stored. */
        expect(flowMetadata.resourceMetadata?.resource).toBe(serverUrl);
        expect(flowMetadata.resourceMetadata?.scopes_supported).toEqual(['mcp.read']);
      } finally {
        await close();
      }
    });
  });

  describe('resource inherited from the authorization endpoint', () => {
    const entraAuthorize = 'https://login.microsoftonline.test/tenant/oauth2/v2.0/authorize';

    /**
     * `startAuthorization` copies the configured endpoint's query string verbatim, so a
     * `resource` left in `authorization_url` reaches the provider even though discovery
     * never supplied it. Declining to add one is not enough; it has to be removed.
     */
    it('removes a resource parameter carried by the configured authorization_url', async () => {
      const { serverUrl, close } = await startProtectedResourceServer();
      try {
        const { authorizationUrl } = await MCPOAuthHandler.initiateOAuthFlow(
          'entra-server',
          serverUrl,
          'user-1',
          {},
          {
            authorization_url: `${entraAuthorize}?resource=${encodeURIComponent('https://stale.example.test/mcp')}`,
            token_url: 'https://login.microsoftonline.test/tenant/oauth2/v2.0/token',
            client_id: 'test-client',
            client_secret: 'test-secret',
            scope: 'api://test-client/access_as_user openid offline_access',
            token_exchange_method: TokenExchangeMethodEnum.DefaultPost,
            send_resource_parameter: false,
          },
        );

        const params = new URL(authorizationUrl).searchParams;
        expect(params.has('resource')).toBe(false);
        /** Unrelated parameters on the configured URL survive. */
        expect(params.get('scope')).toBe('api://test-client/access_as_user openid offline_access');
      } finally {
        await close();
      }
    });

    it('replaces an inherited resource with the discovered identifier when enabled', async () => {
      const { serverUrl, close } = await startProtectedResourceServer();
      try {
        const { authorizationUrl } = await MCPOAuthHandler.initiateOAuthFlow(
          'entra-server',
          serverUrl,
          'user-1',
          {},
          {
            authorization_url: `${entraAuthorize}?resource=${encodeURIComponent('https://stale.example.test/mcp')}`,
            token_url: 'https://login.microsoftonline.test/tenant/oauth2/v2.0/token',
            client_id: 'test-client',
            client_secret: 'test-secret',
            scope: 'api://test-client/access_as_user openid offline_access',
            token_exchange_method: TokenExchangeMethodEnum.DefaultPost,
          },
        );

        expect(new URL(authorizationUrl).searchParams.get('resource')).toBe(serverUrl);
      } finally {
        await close();
      }
    });
  });

  /**
   * Stored tokens intentionally survive a change to this setting, but a pending flow
   * cannot: its authorization URL was already built, so replaying it would reissue the
   * request the operator just reconfigured away from.
   */
  describe('matchesResourceParameterDecision', () => {
    it('keeps a pending flow whose decision still matches the config', () => {
      expect(MCPOAuthHandler.matchesResourceParameterDecision({}, {})).toBe(true);
      expect(
        MCPOAuthHandler.matchesResourceParameterDecision(
          { sendResourceParameter: false },
          { send_resource_parameter: false },
        ),
      ).toBe(true);
    });

    it('retires a pending flow that still sends resource after the opt-out', () => {
      expect(
        MCPOAuthHandler.matchesResourceParameterDecision({}, { send_resource_parameter: false }),
      ).toBe(false);
    });

    it('retires a pending opted-out flow after the opt-out is withdrawn', () => {
      expect(
        MCPOAuthHandler.matchesResourceParameterDecision({ sendResourceParameter: false }, {}),
      ).toBe(false);
    });

    it('treats a flow initiated before the field existed as sending resource', () => {
      // No flag on stored metadata: the flow did send `resource`, so it stays valid
      // only while the config still asks for it.
      expect(MCPOAuthHandler.matchesResourceParameterDecision(undefined, undefined)).toBe(true);
      expect(
        MCPOAuthHandler.matchesResourceParameterDecision(undefined, {
          send_resource_parameter: false,
        }),
      ).toBe(false);
    });
  });

  describe('refresh_token grant', () => {
    it('sends resource= by default', async () => {
      const { url, bodies, close } = await startRecordingTokenServer();
      try {
        await MCPOAuthHandler.refreshOAuthTokens(
          'refresh-token-1',
          { serverName: 'entra-server', resource: 'https://mcp.example.test/mcp' },
          {},
          {
            token_url: url,
            client_id: 'test-client',
            client_secret: 'test-secret',
          },
        );

        expect(bodies).toHaveLength(1);
        expect(bodies[0].get('resource')).toBe('https://mcp.example.test/mcp');
      } finally {
        await close();
      }
    });

    it('omits resource= when send_resource_parameter is false', async () => {
      const { url, bodies, close } = await startRecordingTokenServer();
      try {
        await MCPOAuthHandler.refreshOAuthTokens(
          'refresh-token-1',
          { serverName: 'entra-server', resource: 'https://mcp.example.test/mcp' },
          {},
          {
            token_url: url,
            client_id: 'test-client',
            client_secret: 'test-secret',
            send_resource_parameter: false,
          },
        );

        expect(bodies).toHaveLength(1);
        expect(bodies[0].has('resource')).toBe(false);
        expect(bodies[0].get('grant_type')).toBe('refresh_token');
      } finally {
        await close();
      }
    });
  });
});
