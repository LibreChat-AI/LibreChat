/**
 * Covers a suppressed RFC 8707 `resource` that could still reach the provider through an
 * endpoint URL which already carries it: the MCP SDK uses `token_endpoint` verbatim and the
 * refresh paths post to the resolved token URL as-is, so gating only the parameters
 * LibreChat *adds* leaves an inherited one in place.
 *
 * Verified against a real recorded request line rather than a mock, so it asserts what the
 * authorization server would actually receive.
 */

import * as net from 'net';
import * as http from 'http';
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

/** Records the request line of every /token POST so the query string can be asserted. */
async function startUrlRecordingTokenServer(): Promise<{
  origin: string;
  urls: string[];
  close: () => Promise<void>;
}> {
  const urls: string[] = [];
  const port = await getFreePort();
  const sockets = new Set<Socket>();
  const server = http.createServer((req, res) => {
    urls.push(req.url ?? '');
    req.on('data', () => undefined);
    req.on('end', () => {
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
  server.on('connection', (socket: Socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  return {
    origin: `http://127.0.0.1:${port}`,
    urls,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) {
          socket.destroy();
        }
        sockets.clear();
        server.close(() => resolve());
      }),
  };
}

describe('MCP OAuth resource inherited from endpoint URLs', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  it('strips an inherited resource from the token URL on refresh when opted out', async () => {
    const { origin, urls, close } = await startUrlRecordingTokenServer();
    try {
      await MCPOAuthHandler.refreshOAuthTokens(
        'refresh-token-1',
        { serverName: 'entra-server' },
        {},
        {
          token_url: `${origin}/token?resource=${encodeURIComponent('https://stale.example.test/mcp')}&foo=bar`,
          client_id: 'test-client',
          client_secret: 'test-secret',
          send_resource_parameter: false,
        },
      );

      expect(urls).toHaveLength(1);
      const received = new URL(urls[0], origin);
      expect(received.searchParams.has('resource')).toBe(false);
      /** Unrelated query parameters on the configured endpoint survive. */
      expect(received.searchParams.get('foo')).toBe('bar');
    } finally {
      await close();
    }
  });

  it('keeps an inherited resource on the token URL by default', async () => {
    const { origin, urls, close } = await startUrlRecordingTokenServer();
    try {
      await MCPOAuthHandler.refreshOAuthTokens(
        'refresh-token-1',
        { serverName: 'entra-server' },
        {},
        {
          token_url: `${origin}/token?resource=${encodeURIComponent('https://stale.example.test/mcp')}`,
          client_id: 'test-client',
          client_secret: 'test-secret',
        },
      );

      expect(urls).toHaveLength(1);
      expect(new URL(urls[0], origin).searchParams.get('resource')).toBe(
        'https://stale.example.test/mcp',
      );
    } finally {
      await close();
    }
  });
});
