/**
 * Real sockets, no undici mock: the CONNECT handshake with a proxy is made by a client undici builds
 * itself, so only a request that goes through a proxy shows which timeouts that client carries.
 */
import { createServer } from 'node:net';
import type { AddressInfo, Server, Socket } from 'node:net';
import { MCPConnection } from '~/mcp/connection';

jest.mock('@librechat/data-schemas', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
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
    TOOLS_LIST_MAX_PAGES: 50,
    TOOLS_LIST_MAX_TOOLS: 1000,
    TOOLS_LIST_MAX_BYTES: 5 * 1024 * 1024,
    TOOLS_LIST_TIMEOUT_MS: 30000,
  },
}));

type PrivateConnection = {
  agents: Array<{ destroy: () => Promise<void> }>;
  createFetchFunction: (
    getHeaders: () => Record<string, string> | null | undefined,
    timeout?: number,
    sseBodyTimeout?: number,
    configuredSecretHeaderKeys?: ReadonlySet<string>,
    baseUrl?: string,
  ) => (input: string, init?: { method: string; body: string }) => Promise<unknown>;
};

/** What `promise` settled with (`resolved` or the transport error code), or `pending`. */
async function settle(promise: Promise<unknown>, ms: number): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const pending = new Promise<string>((resolve) => {
    timer = setTimeout(() => resolve('pending'), ms);
  });
  try {
    return await Promise.race([
      promise.then(
        () => 'resolved',
        (error: { code?: string; cause?: { code?: string } }) =>
          error.cause?.code ?? error.code ?? String(error),
      ),
      pending,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

describe('MCP proxy CONNECT tunnel', () => {
  const url = 'https://mcp.example.com/mcp';
  const sockets = new Set<Socket>();
  let proxy: Server | undefined;
  let conn: MCPConnection | undefined;

  afterEach(async () => {
    const { agents = [] } = (conn ?? {}) as Partial<PrivateConnection>;
    await Promise.all(agents.map((agent) => agent.destroy()));
    conn?.removeAllListeners();
    for (const socket of sockets) socket.destroy();
    sockets.clear();
    const server = proxy;
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    conn = undefined;
    proxy = undefined;
  });

  it('gives up on a silent proxy at the server timeout', async () => {
    /** Accepts the TCP connection and never answers the CONNECT request. */
    proxy = createServer((socket) => {
      sockets.add(socket);
      socket.on('error', () => undefined);
    });
    await new Promise<void>((resolve) => proxy?.listen(0, '127.0.0.1', resolve));
    conn = new MCPConnection({
      serverName: 'silent-proxy',
      serverConfig: {
        type: 'streamable-http',
        url,
        proxy: `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`,
      },
      useSSRFProtection: false,
    });
    const customFetch = (conn as unknown as PrivateConnection).createFetchFunction.call(
      conn,
      () => null,
      500,
      undefined,
      undefined,
      url,
    );

    const outcome = await settle(customFetch(url, { method: 'POST', body: '{}' }), 5_000);

    expect(outcome).toBe('UND_ERR_HEADERS_TIMEOUT');
  });
});
