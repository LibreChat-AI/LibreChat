/**
 * Integration tests for MCP SSRF protections.
 *
 * These tests spin up real in-process HTTP servers and verify that MCPConnection:
 *
 * 1. Does NOT follow 301/302 redirects from SSE/StreamableHTTP transports
 *    (redirect: 'manual' prevents SSRF via server-controlled 301/302)
 * 2. DOES follow 307/308 redirects (method-preserving) with a depth limit of 5,
 *    as required by servers like Coda that route doc-scoped tool calls via 308
 * 3. Blocks WebSocket connections to hosts that DNS-resolve to private IPs,
 *    regardless of whether useSSRFProtection is enabled (allowlist scenario)
 */

import * as net from 'net';
import * as http from 'http';
import { randomUUID } from 'crypto';
import { Request as UndiciRequest } from 'undici';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type {
  RequestInfo as UndiciRequestInfo,
  RequestInit as UndiciRequestInit,
  Response as UndiciResponse,
} from 'undici';
import type { Socket } from 'net';
import { createSSRFSafeUndiciConnect, resolveHostnameSSRF } from '~/auth';
import { MCPConnection } from '~/mcp/connection';

type CustomFetch = (input: UndiciRequestInfo, init?: UndiciRequestInit) => Promise<UndiciResponse>;
type LookupAddress = string | Array<{ address: string; family: number }>;
type LookupCallback = (
  err: NodeJS.ErrnoException | null,
  address: LookupAddress,
  family?: number,
) => void;

jest.mock('@librechat/data-schemas', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

jest.mock('~/auth', () => ({
  createSSRFSafeUndiciConnect: jest.fn(() => ({
    lookup: (_hostname: string, optionsOrCallback: unknown, maybeCallback?: LookupCallback) => {
      const callback =
        typeof optionsOrCallback === 'function'
          ? (optionsOrCallback as LookupCallback)
          : maybeCallback;
      if (!callback) {
        throw new Error('lookup callback missing');
      }
      if (
        typeof optionsOrCallback === 'object' &&
        optionsOrCallback != null &&
        'all' in optionsOrCallback &&
        optionsOrCallback.all === true
      ) {
        callback(null, [{ address: '127.0.0.1', family: 4 }]);
        return;
      }
      callback(null, '127.0.0.1', 4);
    },
  })),
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

const mockedResolveHostnameSSRF = resolveHostnameSSRF as jest.MockedFunction<
  typeof resolveHostnameSSRF
>;
const mockedCreateSSRFSafeUndiciConnect = createSSRFSafeUndiciConnect as jest.MockedFunction<
  typeof createSSRFSafeUndiciConnect
>;

function getLookupCallback(
  optionsOrCallback: unknown,
  maybeCallback?: LookupCallback,
): LookupCallback {
  if (typeof optionsOrCallback === 'function') {
    return optionsOrCallback as LookupCallback;
  }
  if (maybeCallback) {
    return maybeCallback;
  }
  throw new Error('lookup callback missing');
}

function createRebindBlockingLookup(): jest.Mock {
  return jest.fn((hostname: string, optionsOrCallback: unknown, maybeCallback?: LookupCallback) => {
    const callback = getLookupCallback(optionsOrCallback, maybeCallback);
    if (hostname !== 'rebind.test') {
      callback(null, '127.0.0.1', 4);
      return;
    }
    const err = Object.assign(
      new Error('SSRF protection: rebind.test resolved to blocked address 127.0.0.1'),
      { code: 'ESSRF' },
    ) as NodeJS.ErrnoException;
    callback(err, '127.0.0.1', 4);
  });
}

function collectErrorMessages(error: unknown): string[] {
  const messages: string[] = [];
  let current: unknown = error;
  while (current instanceof Error) {
    messages.push(current.message);
    current = (current as { cause?: unknown }).cause;
  }
  return messages;
}

async function expectRebindSSRFRejection(promise: Promise<unknown>): Promise<void> {
  let caught: unknown;
  let didReject = false;
  try {
    await promise;
  } catch (error) {
    didReject = true;
    caught = error;
  }
  if (!didReject) {
    throw new Error('Expected promise to reject with SSRF error, but it resolved');
  }
  expect(
    collectErrorMessages(caught).some((message) => /SSRF protection: rebind\.test/.test(message)),
  ).toBe(true);
}

async function safeDisconnect(conn: MCPConnection | null): Promise<void> {
  if (!conn) {
    return;
  }
  (conn as unknown as { shouldStopReconnecting: boolean }).shouldStopReconnecting = true;
  conn.removeAllListeners();
  await conn.disconnect();
}

interface TestServer {
  url: string;
  redirectHit: boolean;
  close: () => Promise<void>;
}

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
 * Creates an HTTP server that responds with a 301 redirect to a target URL.
 * A second server is spun up at the redirect target to detect whether the
 * redirect was actually followed.
 */
async function createRedirectingServer(redirectTarget: string): Promise<TestServer> {
  const state = { redirectHit: false };

  const targetPort = new URL(redirectTarget).port || '80';
  const targetServer = http.createServer((_req, res) => {
    state.redirectHit = true;
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('You should not be here');
  });
  const destroyTargetSockets = trackSockets(targetServer);
  await new Promise<void>((resolve) =>
    targetServer.listen(parseInt(targetPort), '127.0.0.1', resolve),
  );

  const httpServer = http.createServer((_req, res) => {
    res.writeHead(301, { Location: redirectTarget });
    res.end();
  });

  const destroySockets = trackSockets(httpServer);
  const port = await getFreePort();
  await new Promise<void>((resolve) => httpServer.listen(port, '127.0.0.1', resolve));

  return {
    url: `http://127.0.0.1:${port}/`,
    get redirectHit() {
      return state.redirectHit;
    },
    close: async () => {
      await destroySockets();
      await destroyTargetSockets();
    },
  };
}

/**
 * Builds an HTTP request handler that routes incoming requests to (per-session)
 * `StreamableHTTPServerTransport` instances backed by an `McpServer`. Sessions
 * are stored in the caller-provided `sessions` Map so the caller can drain them
 * during teardown.
 */
function createMCPRequestHandler(
  sessions: Map<string, StreamableHTTPServerTransport>,
  serverName: string,
): http.RequestListener {
  return async (req, res) => {
    const sid = req.headers['mcp-session-id'] as string | undefined;
    let transport = sid ? sessions.get(sid) : undefined;

    if (!transport) {
      transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() });
      const mcp = new McpServer({ name: serverName, version: '0.0.1' });
      await mcp.connect(transport);
    }

    await transport.handleRequest(req, res);

    if (transport.sessionId && !sessions.has(transport.sessionId)) {
      sessions.set(transport.sessionId, transport);
      transport.onclose = () => sessions.delete(transport!.sessionId!);
    }
  };
}

async function closeMCPSessions(
  sessions: Map<string, StreamableHTTPServerTransport>,
): Promise<void> {
  const closing = [...sessions.values()].map((t) => t.close().catch(() => undefined));
  sessions.clear();
  await Promise.all(closing);
}

/**
 * Creates a real StreamableHTTP MCP server for baseline connectivity tests.
 */
async function createStreamableServer(): Promise<Omit<TestServer, 'redirectHit'>> {
  const sessions = new Map<string, StreamableHTTPServerTransport>();
  const httpServer = http.createServer(createMCPRequestHandler(sessions, 'test-ssrf'));

  const destroySockets = trackSockets(httpServer);
  const port = await getFreePort();
  await new Promise<void>((resolve) => httpServer.listen(port, '127.0.0.1', resolve));

  return {
    url: `http://127.0.0.1:${port}/`,
    close: async () => {
      await closeMCPSessions(sessions);
      await destroySockets();
    },
  };
}

async function createOversizedToolResultStreamableServer(
  payloadSize: number,
): Promise<Omit<TestServer, 'redirectHit'>> {
  const sessions = new Map<string, StreamableHTTPServerTransport>();

  const httpServer = http.createServer(async (req, res) => {
    const sid = req.headers['mcp-session-id'] as string | undefined;
    let transport = sid ? sessions.get(sid) : undefined;

    if (!transport) {
      transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() });
      const mcp = new McpServer({ name: 'oversized-tool-result', version: '0.0.1' });
      mcp.tool('oversized', 'Returns an oversized text payload', {}, async () => ({
        content: [{ type: 'text', text: 'x'.repeat(payloadSize) }],
      }));
      await mcp.connect(transport);
    }

    await transport.handleRequest(req, res);

    if (transport.sessionId && !sessions.has(transport.sessionId)) {
      sessions.set(transport.sessionId, transport);
      transport.onclose = () => sessions.delete(transport!.sessionId!);
    }
  });

  const destroySockets = trackSockets(httpServer);
  const port = await getFreePort();
  await new Promise<void>((resolve) => httpServer.listen(port, '127.0.0.1', resolve));

  return {
    url: `http://127.0.0.1:${port}/`,
    close: async () => {
      await closeMCPSessions(sessions);
      await destroySockets();
    },
  };
}

describe('direct bearer HTTP rejection', () => {
  it.each([
    ['sse', 401],
    ['sse', 403],
    ['streamable-http', 401],
    ['streamable-http', 403],
  ] as const)('preserves a structured %s POST status %s', async (type, status) => {
    const server = http.createServer((_req, res) => {
      res.writeHead(status);
      res.end('credential rejected');
    });
    const close = trackSockets(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(server.address() as net.AddressInfo).port}/mcp`;
    const connection = new MCPConnection({
      serverName: 'direct-bearer',
      serverConfig: { type, url },
      useSSRFProtection: false,
      directBearerRecoveryEnabled: true,
    });
    const createFetch = Reflect.get(connection, 'createFetchFunction') as (
      getHeaders: () => Record<string, string>,
    ) => CustomFetch;
    try {
      await expect(
        createFetch.call(connection, () => ({ Authorization: 'Bearer token' }))(url, {
          method: 'POST',
          body: '{}',
        }),
      ).rejects.toMatchObject({ name: 'MCPTransportAuthenticationError', status });
    } finally {
      await connection.dispose();
      await close();
    }
  });
});

describe('MCP SSRF protection – redirect blocking', () => {
  let redirectServer: TestServer;
  let conn: MCPConnection | null;

  afterEach(async () => {
    await safeDisconnect(conn);
    conn = null;
    if (redirectServer) {
      await redirectServer.close();
    }
    jest.restoreAllMocks();
  });

  it('should not follow redirects from streamable-http to a private IP', async () => {
    const targetPort = await getFreePort();
    redirectServer = await createRedirectingServer(
      `http://127.0.0.1:${targetPort}/latest/meta-data/`,
    );

    conn = new MCPConnection({
      serverName: 'redirect-test',
      serverConfig: { type: 'streamable-http', url: redirectServer.url },
      useSSRFProtection: false,
    });

    await expect(conn.connect()).rejects.toThrow();
    expect(redirectServer.redirectHit).toBe(false);
  });

  it('should not follow redirects even with SSRF protection off (allowlist scenario)', async () => {
    const targetPort = await getFreePort();
    redirectServer = await createRedirectingServer(`http://127.0.0.1:${targetPort}/admin`);

    conn = new MCPConnection({
      serverName: 'redirect-test-2',
      serverConfig: { type: 'streamable-http', url: redirectServer.url },
      useSSRFProtection: false,
    });

    await expect(conn.connect()).rejects.toThrow();
    expect(redirectServer.redirectHit).toBe(false);
  });

  it('should connect normally to a non-redirecting streamable-http server', async () => {
    const realServer = await createStreamableServer();
    try {
      conn = new MCPConnection({
        serverName: 'legit-server',
        serverConfig: { type: 'streamable-http', url: realServer.url },
        useSSRFProtection: false,
      });

      await conn.connect();
      const tools = await conn.fetchTools();
      expect(tools).toBeDefined();
    } finally {
      await safeDisconnect(conn);
      conn = null;
      await realServer.close();
    }
  });
});

/**
 * Creates a single HTTP server that 307/308-redirects from the root path to
 * `/mcp`, where a real MCP server is mounted. The redirect stays on the same
 * origin (Coda-style doc-scoped routing), so credential-bearing headers like
 * `mcp-session-id` survive the cross-path hop and the MCP session keeps state.
 */
async function createRedirectingMCPServer(
  statusCode: 307 | 308,
): Promise<TestServer & { close: () => Promise<void> }> {
  const sessions = new Map<string, StreamableHTTPServerTransport>();
  const state = { redirectHit: false };
  const mcpPath = '/mcp';
  const port = await getFreePort();
  const mcpHandler = createMCPRequestHandler(sessions, 'redirect-target');

  const server = http.createServer(async (req, res) => {
    if ((req.url ?? '').startsWith(mcpPath)) {
      state.redirectHit = true;
      await mcpHandler(req, res);
      return;
    }

    res.writeHead(statusCode, { Location: `http://127.0.0.1:${port}${mcpPath}` });
    res.end();
  });

  const destroySockets = trackSockets(server);
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));

  return {
    url: `http://127.0.0.1:${port}/`,
    get redirectHit() {
      return state.redirectHit;
    },
    close: async () => {
      await closeMCPSessions(sessions);
      await destroySockets();
    },
  };
}

/**
 * Creates a single HTTP server with `depth` chained 307/308 redirects on
 * `/hop/N → /hop/N-1 → … → /hop/0`, where `/hop/0` returns a plain 200.
 * Same-origin throughout, so the chain exercises only redirect-depth limits
 * (not cross-origin header behavior).
 */
async function createRedirectChain(depth: number, statusCode: 307 | 308): Promise<TestServer> {
  const state = { redirectHit: false };
  const port = await getFreePort();

  const server = http.createServer((req, res) => {
    const match = (req.url ?? '/').match(/^\/hop\/(\d+)/);
    const n = match ? parseInt(match[1], 10) : -1;
    if (n > 0) {
      res.writeHead(statusCode, {
        Location: `http://127.0.0.1:${port}/hop/${n - 1}`,
      });
      res.end();
      return;
    }
    state.redirectHit = true;
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('final');
  });

  const destroySockets = trackSockets(server);
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));

  return {
    url: `http://127.0.0.1:${port}/hop/${depth}`,
    get redirectHit() {
      return state.redirectHit;
    },
    close: destroySockets,
  };
}

/**
 * Same-origin redirect chain ending at a real MCP server at `/mcp`. URL
 * `/hop/N-1` redirects through N hops total, with the final hop landing on
 * `/mcp`. Used to verify MCP traffic survives the maximum allowed redirect
 * depth.
 */
async function createRedirectChainToMCP(depth: number, statusCode: 307 | 308): Promise<TestServer> {
  const sessions = new Map<string, StreamableHTTPServerTransport>();
  const state = { redirectHit: false };
  const mcpPath = '/mcp';
  const port = await getFreePort();
  const mcpHandler = createMCPRequestHandler(sessions, 'mcp-via-chain');

  const server = http.createServer(async (req, res) => {
    const url = req.url ?? '/';

    if (url.startsWith(mcpPath)) {
      state.redirectHit = true;
      await mcpHandler(req, res);
      return;
    }

    const match = url.match(/^\/hop\/(\d+)/);
    const n = match ? parseInt(match[1], 10) : 0;
    const nextLocation =
      n > 0 ? `http://127.0.0.1:${port}/hop/${n - 1}` : `http://127.0.0.1:${port}${mcpPath}`;
    res.writeHead(statusCode, { Location: nextLocation });
    res.end();
  });

  const destroySockets = trackSockets(server);
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));

  return {
    url: `http://127.0.0.1:${port}/hop/${depth - 1}`,
    get redirectHit() {
      return state.redirectHit;
    },
    close: async () => {
      await closeMCPSessions(sessions);
      await destroySockets();
    },
  };
}

interface CapturedRequest {
  method: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

interface HeaderCaptureServer {
  url: string;
  receivedHeaders: http.IncomingHttpHeaders[];
  receivedRequests: CapturedRequest[];
  close: () => Promise<void>;
}

interface RawResponseServer {
  url: string;
  close: () => Promise<void>;
}

/**
 * Captures every incoming request's headers, method, and body, then replies
 * with a benign 200 so tests can assert what actually crossed a redirect
 * boundary (header stripping, 307/308 method preservation, payload survival).
 */
async function createHeaderCaptureServer(): Promise<HeaderCaptureServer> {
  const headers: http.IncomingHttpHeaders[] = [];
  const requests: CapturedRequest[] = [];
  const server = http.createServer((req, res) => {
    headers.push({ ...req.headers });
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      requests.push({
        method: req.method ?? '',
        headers: { ...req.headers },
        body: Buffer.concat(chunks).toString('utf8'),
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
    });
  });
  const destroySockets = trackSockets(server);
  const port = await getFreePort();
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${port}/`,
    receivedHeaders: headers,
    receivedRequests: requests,
    close: destroySockets,
  };
}

async function createTunnelProxyCaptureServer(): Promise<HeaderCaptureServer> {
  const headers: http.IncomingHttpHeaders[] = [];
  const requests: CapturedRequest[] = [];
  const server = http.createServer((_req, res) => {
    res.writeHead(502);
    res.end();
  });
  server.on('connect', (req, clientSocket, head) => {
    headers.push({ ...req.headers });
    requests.push({
      method: 'CONNECT',
      headers: { ...req.headers },
      body: req.url ?? '',
    });

    let buffer = Buffer.from(head);
    let responded = false;
    const respondIfRequestComplete = () => {
      if (responded || !buffer.includes('\r\n\r\n')) {
        return;
      }
      responded = true;
      const requestLine = buffer.toString('utf8').split('\r\n')[0] ?? '';
      requests.push({
        method: requestLine.split(' ')[0] ?? '',
        headers: {},
        body: requestLine,
      });
      clientSocket.write(
        'HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}',
      );
      clientSocket.end();
    };

    clientSocket.on('error', () => undefined);
    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    clientSocket.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      respondIfRequestComplete();
    });
    respondIfRequestComplete();
  });

  const destroySockets = trackSockets(server);
  const port = await getFreePort();
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${port}/`,
    receivedHeaders: headers,
    receivedRequests: requests,
    close: destroySockets,
  };
}

async function createRawResponseServer(handler: http.RequestListener): Promise<RawResponseServer> {
  const server = http.createServer(handler);
  const destroySockets = trackSockets(server);
  const port = await getFreePort();
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${port}/`,
    close: destroySockets,
  };
}

/**
 * Issues a single 307/308 redirect to `redirectTarget` (which lives on a
 * different port and is therefore a different origin). Used to verify
 * cross-origin credential-stripping behavior.
 */
async function createCrossOriginRedirectingServer(
  redirectTarget: string,
  statusCode: 307 | 308,
): Promise<TestServer> {
  const state = { redirectHit: false };
  const server = http.createServer((_req, res) => {
    state.redirectHit = true;
    res.writeHead(statusCode, { Location: redirectTarget });
    res.end();
  });
  const destroySockets = trackSockets(server);
  const port = await getFreePort();
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${port}/`,
    get redirectHit() {
      return state.redirectHit;
    },
    close: destroySockets,
  };
}

describe('MCP SSRF protection – 307/308 redirect following', () => {
  let server: TestServer | undefined;
  let conn: MCPConnection | null;

  afterEach(async () => {
    await safeDisconnect(conn);
    conn = null;
    if (server) {
      await server.close();
      server = undefined;
    }
    jest.restoreAllMocks();
  });

  it('should follow a 308 redirect and connect to the target MCP server', async () => {
    server = await createRedirectingMCPServer(308);

    conn = new MCPConnection({
      serverName: 'redirect-308',
      serverConfig: { type: 'streamable-http', url: server.url },
      useSSRFProtection: false,
    });

    await conn.connect();
    const tools = await conn.fetchTools();
    expect(tools).toBeDefined();
    expect(server.redirectHit).toBe(true);
  });

  it('should follow a 307 redirect and connect to the target MCP server', async () => {
    server = await createRedirectingMCPServer(307);

    conn = new MCPConnection({
      serverName: 'redirect-307',
      serverConfig: { type: 'streamable-http', url: server.url },
      useSSRFProtection: false,
    });

    await conn.connect();
    const tools = await conn.fetchTools();
    expect(tools).toBeDefined();
    expect(server.redirectHit).toBe(true);
  });

  it('should stop following redirects after 5 hops', async () => {
    server = await createRedirectChain(6, 308);

    conn = new MCPConnection({
      serverName: 'redirect-too-deep',
      serverConfig: { type: 'streamable-http', url: server.url },
      useSSRFProtection: false,
    });

    await expect(conn.connect()).rejects.toThrow();
    expect(server.redirectHit).toBe(false);
  });

  it('should reach the target after exactly 5 redirect hops (at the limit)', async () => {
    server = await createRedirectChain(5, 308);

    conn = new MCPConnection({
      serverName: 'redirect-at-limit',
      serverConfig: { type: 'streamable-http', url: server.url },
      useSSRFProtection: false,
    });

    await expect(conn.connect()).rejects.toThrow();
    expect(server.redirectHit).toBe(true);
  });

  it('should complete an MCP request through 5 same-origin redirect hops', async () => {
    server = await createRedirectChainToMCP(5, 308);

    conn = new MCPConnection({
      serverName: 'redirect-chain-mcp',
      serverConfig: { type: 'streamable-http', url: server.url },
      useSSRFProtection: false,
    });

    await conn.connect();
    const tools = await conn.fetchTools();
    expect(tools).toBeDefined();
    expect(server.redirectHit).toBe(true);
  });
});

describe('MCP SSRF protection – 307/308 redirect to private IP', () => {
  let server: TestServer | undefined;
  let conn: MCPConnection | null;

  afterEach(async () => {
    await safeDisconnect(conn);
    conn = null;
    if (server) {
      await server.close();
      server = undefined;
    }
    jest.restoreAllMocks();
  });

  it('should block a 308 redirect whose target resolves to a private IP (allowlist scenario)', async () => {
    const capture = await createHeaderCaptureServer();
    try {
      server = await createCrossOriginRedirectingServer(capture.url, 308);
      mockedResolveHostnameSSRF.mockResolvedValueOnce(true);

      conn = new MCPConnection({
        serverName: 'redirect-ssrf-block',
        serverConfig: { type: 'streamable-http', url: server.url },
        useSSRFProtection: false,
      });

      await expect(conn.connect()).rejects.toThrow();
      expect(server.redirectHit).toBe(true);
      expect(capture.receivedHeaders).toHaveLength(0);
    } finally {
      await capture.close();
    }
  });

  it('should block a 307 redirect whose target resolves to a private IP (SSRF protection on)', async () => {
    const capture = await createHeaderCaptureServer();
    try {
      server = await createCrossOriginRedirectingServer(capture.url, 307);
      mockedResolveHostnameSSRF.mockResolvedValueOnce(true);

      conn = new MCPConnection({
        serverName: 'redirect-ssrf-block-on',
        serverConfig: { type: 'streamable-http', url: server.url },
        useSSRFProtection: true,
      });

      await expect(conn.connect()).rejects.toThrow();
      expect(server.redirectHit).toBe(true);
      expect(capture.receivedHeaders).toHaveLength(0);
    } finally {
      await capture.close();
    }
  });

  it('should block DNS rebinding between redirect pre-check and connect-time lookup', async () => {
    const capture = await createHeaderCaptureServer();
    try {
      const rebindUrl = new URL(capture.url);
      rebindUrl.hostname = 'rebind.test';
      server = await createCrossOriginRedirectingServer(rebindUrl.href, 308);
      mockedResolveHostnameSSRF.mockResolvedValueOnce(false);
      mockedCreateSSRFSafeUndiciConnect.mockClear();
      const lookup = createRebindBlockingLookup();
      mockedCreateSSRFSafeUndiciConnect.mockReturnValueOnce({
        lookup,
      } as ReturnType<typeof createSSRFSafeUndiciConnect>);

      conn = new MCPConnection({
        serverName: 'redirect-rebinding-block',
        serverConfig: { type: 'streamable-http', url: server.url },
        useSSRFProtection: false,
      });

      await expectRebindSSRFRejection(conn.connect());
      expect(server.redirectHit).toBe(true);
      expect(mockedCreateSSRFSafeUndiciConnect).toHaveBeenCalledTimes(1);
      expect(lookup).toHaveBeenCalled();
      expect(lookup.mock.calls[0]?.[0]).toBe('rebind.test');
      expect(capture.receivedHeaders).toHaveLength(0);
    } finally {
      await capture.close();
    }
  });

  it('should switch to a no-exemption SSRF-safe dispatcher when protection is already on', async () => {
    const capture = await createHeaderCaptureServer();
    try {
      const rebindUrl = new URL(capture.url);
      rebindUrl.hostname = 'rebind.test';
      server = await createCrossOriginRedirectingServer(rebindUrl.href, 308);
      mockedResolveHostnameSSRF.mockResolvedValueOnce(false);
      mockedCreateSSRFSafeUndiciConnect.mockClear();
      const lookup = createRebindBlockingLookup();
      mockedCreateSSRFSafeUndiciConnect
        .mockReturnValueOnce({
          lookup,
        } as ReturnType<typeof createSSRFSafeUndiciConnect>)
        .mockReturnValueOnce({
          lookup,
        } as ReturnType<typeof createSSRFSafeUndiciConnect>);

      conn = new MCPConnection({
        serverName: 'redirect-rebinding-block-protection-on',
        serverConfig: { type: 'streamable-http', url: server.url },
        useSSRFProtection: true,
      });

      await expectRebindSSRFRejection(conn.connect());
      expect(server.redirectHit).toBe(true);
      expect(mockedCreateSSRFSafeUndiciConnect).toHaveBeenCalledTimes(2);
      expect(mockedCreateSSRFSafeUndiciConnect.mock.calls[1]).toEqual([]);
      expect(lookup).toHaveBeenCalled();
      expect(lookup.mock.calls.some(([hostname]) => hostname === 'rebind.test')).toBe(true);
      expect(capture.receivedHeaders).toHaveLength(0);
    } finally {
      await capture.close();
    }
  });
});

describe('MCP SSRF protection – cross-origin credential stripping on redirect', () => {
  let server: TestServer | undefined;
  let conn: MCPConnection | null;

  afterEach(async () => {
    await safeDisconnect(conn);
    conn = null;
    if (server) {
      await server.close();
      server = undefined;
    }
    jest.restoreAllMocks();
  });

  it('should strip Authorization, runtime headers, and config headers when 308-redirecting cross-origin', async () => {
    const capture = await createHeaderCaptureServer();
    try {
      server = await createCrossOriginRedirectingServer(capture.url, 308);

      conn = new MCPConnection({
        serverName: 'cross-origin-strip',
        serverConfig: {
          type: 'streamable-http',
          url: server.url,
          headers: {
            'X-Config-Api-Key': 'config-level-secret',
            'X-Internal-Token': 'config-internal-token',
          },
        },
        oauthTokens: {
          access_token: 'super-secret-bearer-token',
          token_type: 'Bearer',
          obtained_at: Date.now(),
        },
        useSSRFProtection: false,
      });
      conn.setRequestHeaders({ 'X-Runtime-Api-Key': 'runtime-private-api-key' });

      await expect(conn.connect()).rejects.toThrow();
      expect(server.redirectHit).toBe(true);
      expect(capture.receivedHeaders.length).toBeGreaterThan(0);

      for (const headers of capture.receivedHeaders) {
        expect(headers['authorization']).toBeUndefined();
        expect(headers['x-runtime-api-key']).toBeUndefined();
        expect(headers['x-config-api-key']).toBeUndefined();
        expect(headers['x-internal-token']).toBeUndefined();
        expect(headers['mcp-session-id']).toBeUndefined();
        expect(headers['cookie']).toBeUndefined();
        /** Non-credential protocol headers must survive — guards against a
         * regression that strips everything indiscriminately. */
        expect(headers['accept']).toBeDefined();
        expect(headers['content-type']).toBeDefined();
      }
    } finally {
      await capture.close();
    }
  });

  it('should preserve credential headers on same-origin 308 redirects (Coda-style flow)', async () => {
    server = await createRedirectingMCPServer(308);

    conn = new MCPConnection({
      serverName: 'same-origin-preserve',
      serverConfig: { type: 'streamable-http', url: server.url },
      oauthTokens: {
        access_token: 'preserved-bearer',
        token_type: 'Bearer',
        obtained_at: Date.now(),
      },
      useSSRFProtection: false,
    });

    /** Same-origin redirect → MCP session continuity must hold across hops. */
    await conn.connect();
    const tools = await conn.fetchTools();
    expect(tools).toBeDefined();
  });

  it('treats a protocol downgrade as cross-origin (URL.origin contract)', () => {
    /**
     * The cross-origin strip path keys off `targetUrl.origin !== originalOrigin`.
     * `URL.origin` is defined as `scheme + "://" + host + ":" + port`, so a
     * same-host `https → http` redirect produces a different origin and trips
     * the strip path through the existing logic — no separate code path is
     * needed for protocol downgrade. Pin the URL contract here instead of
     * standing up a TLS fixture just to re-prove the spec.
     */
    expect(new URL('https://example.com/a').origin).not.toBe(
      new URL('http://example.com/a').origin,
    );
    expect(new URL('https://example.com:443/a').origin).not.toBe(
      new URL('http://example.com:80/a').origin,
    );
  });
});

describe('MCP SSRF protection – customFetch input shapes', () => {
  let target: Omit<TestServer, 'redirectHit'> | undefined;
  let conn: MCPConnection | null;
  const originalMaxResponseBytes = process.env.MCP_STREAMABLE_HTTP_MAX_RESPONSE_BYTES;
  const originalMaxLineBytes = process.env.MCP_STREAMABLE_HTTP_MAX_LINE_BYTES;

  it.each([true, false])(
    'uses the live bearer on SSE stream reconnect only in direct mode: %s',
    async (directBearerRecoveryEnabled) => {
      const requests: http.IncomingHttpHeaders[] = [];
      let stream: http.ServerResponse | undefined;
      let reconnected!: () => void;
      const reconnect = new Promise<void>((resolve) => {
        reconnected = resolve;
      });
      const server = http.createServer((req, res) => {
        requests.push(req.headers);
        stream = res;
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write('retry: 10\nevent: endpoint\ndata: /messages\n\n');
        if (requests.length === 2) {
          reconnected();
        }
      });
      const close = trackSockets(server);
      const port = await getFreePort();
      await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
      const config = {
        type: 'sse' as const,
        url: `http://127.0.0.1:${port}/sse`,
        headers: {
          Authorization: 'Bearer old-token',
          'X-Access-Token': 'old-token',
          'X-Operator': 'configured',
        },
      };
      conn = new MCPConnection({
        serverName: 'sse-live-bearer',
        serverConfig: config,
        useSSRFProtection: false,
        directBearerRecoveryEnabled,
      });
      const transport = await conn['constructTransport'](config);
      try {
        await transport.start();
        conn.setRequestHeaders({
          AUTHORIZATION: 'Bearer fresh-token',
          'X-Access-Token': 'fresh-token',
          'X-Request': 'private',
        });
        stream?.end();
        await reconnect;
        expect(requests[0].authorization).toBe('Bearer old-token');
        expect(requests[1].authorization).toBe(
          directBearerRecoveryEnabled ? 'Bearer fresh-token' : 'Bearer old-token',
        );
        expect(requests[1]['x-operator']).toBe('configured');
        expect(requests[1]['x-access-token']).toBe(
          directBearerRecoveryEnabled ? 'fresh-token' : 'old-token',
        );
        expect(requests[1]['x-request']).toBeUndefined();
      } finally {
        await transport.close();
        await close();
      }
    },
  );

  afterEach(async () => {
    if (originalMaxResponseBytes == null) {
      delete process.env.MCP_STREAMABLE_HTTP_MAX_RESPONSE_BYTES;
    } else {
      process.env.MCP_STREAMABLE_HTTP_MAX_RESPONSE_BYTES = originalMaxResponseBytes;
    }
    if (originalMaxLineBytes == null) {
      delete process.env.MCP_STREAMABLE_HTTP_MAX_LINE_BYTES;
    } else {
      process.env.MCP_STREAMABLE_HTTP_MAX_LINE_BYTES = originalMaxLineBytes;
    }
    await safeDisconnect(conn);
    conn = null;
    if (target) {
      await target.close();
      target = undefined;
    }
    jest.restoreAllMocks();
  });

  /**
   * Reach into the private fetch factory to exercise it with each
   * `RequestInfo` shape undici accepts. `Request.toString()` returns
   * `"[object Request]"`, so a naive `new URL(input.toString())` for origin
   * derivation would throw before any network call — this test pins that
   * regression.
   */
  function getCustomFetch(connection: MCPConnection): CustomFetch {
    const factory = (
      connection as unknown as {
        createFetchFunction: (
          getHeaders: () => Record<string, string> | null | undefined,
          timeout?: number,
          sseBodyTimeout?: number,
          configuredSecretHeaderKeys?: ReadonlySet<string>,
          baseUrl?: string,
          guardStreamableHTTPResponses?: boolean,
        ) => CustomFetch;
      }
    ).createFetchFunction;
    return factory.call(connection, () => null);
  }

  function getGuardedStreamableHTTPCustomFetch(connection: MCPConnection): CustomFetch {
    const factory = (
      connection as unknown as {
        createFetchFunction: (
          getHeaders: () => Record<string, string> | null | undefined,
          timeout?: number,
          sseBodyTimeout?: number,
          configuredSecretHeaderKeys?: ReadonlySet<string>,
          baseUrl?: string,
          guardStreamableHTTPResponses?: boolean,
        ) => CustomFetch;
      }
    ).createFetchFunction;
    return factory.call(connection, () => null, undefined, undefined, undefined, undefined, true);
  }

  function createBaseUrlFetch(connection: MCPConnection, baseUrl: string): CustomFetch {
    const factory = (
      connection as unknown as {
        createFetchFunction: (
          getHeaders: () => Record<string, string> | null | undefined,
          timeout?: number,
          sseBodyTimeout?: number,
          configuredSecretHeaderKeys?: ReadonlySet<string>,
          baseUrl?: string,
        ) => CustomFetch;
      }
    ).createFetchFunction;
    return factory.call(connection, () => null, undefined, 300000, undefined, baseUrl);
  }

  function createBaseUrlDispatchers(connection: MCPConnection, baseUrl: string): string[] {
    const privateSelf = connection as unknown as {
      agents: Array<{ constructor: { name: string } }>;
    };
    createBaseUrlFetch(connection, baseUrl);
    return privateSelf.agents.map((agent) => agent.constructor.name);
  }

  const proxyEnvKeys = [
    'PROXY',
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'NO_PROXY',
    'http_proxy',
    'https_proxy',
    'no_proxy',
  ] as const;
  type ProxyEnvKey = (typeof proxyEnvKeys)[number];

  function snapshotProxyEnv(): Partial<Record<ProxyEnvKey, string>> {
    const snapshot: Partial<Record<ProxyEnvKey, string>> = {};
    for (const key of proxyEnvKeys) {
      if (process.env[key] != null) {
        snapshot[key] = process.env[key];
      }
    }
    return snapshot;
  }

  function restoreProxyEnv(snapshot: Partial<Record<ProxyEnvKey, string>>): void {
    for (const key of proxyEnvKeys) {
      if (snapshot[key] == null) {
        delete process.env[key];
      } else {
        process.env[key] = snapshot[key];
      }
    }
  }

  function clearProxyEnv(): void {
    for (const key of proxyEnvKeys) {
      delete process.env[key];
    }
  }

  it('should allocate proxy dispatchers for streamable-http when proxy is configured', () => {
    conn = new MCPConnection({
      serverName: 'customfetch-proxy-dispatchers',
      serverConfig: {
        type: 'streamable-http',
        url: 'https://mcp.example.com/mcp',
        proxy: 'http://proxy.example.com:8080',
      },
      useSSRFProtection: false,
    });

    const privateSelf = conn as unknown as {
      agents: Array<{ constructor: { name: string } }>;
      createFetchFunction: (
        getHeaders: () => Record<string, string> | null | undefined,
        timeout?: number,
        sseBodyTimeout?: number,
        configuredSecretHeaderKeys?: ReadonlySet<string>,
        baseUrl?: string,
      ) => CustomFetch;
    };
    privateSelf.createFetchFunction.call(
      conn,
      () => null,
      undefined,
      300000,
      undefined,
      'https://mcp.example.com/mcp',
    );

    expect(privateSelf.agents.map((agent) => agent.constructor.name)).toEqual([
      'ProxyAgent',
      'ProxyAgent',
    ]);
  });

  it('should use the PROXY env var for streamable-http when server proxy is not configured', () => {
    const originalProxy = process.env.PROXY;
    process.env.PROXY = 'http://env-proxy.example.com:8080';
    try {
      conn = new MCPConnection({
        serverName: 'customfetch-env-proxy-dispatchers',
        serverConfig: {
          type: 'streamable-http',
          url: 'https://mcp.example.com/mcp',
        },
        useSSRFProtection: false,
      });

      const privateSelf = conn as unknown as {
        agents: Array<{ constructor: { name: string } }>;
        createFetchFunction: (
          getHeaders: () => Record<string, string> | null | undefined,
          timeout?: number,
          sseBodyTimeout?: number,
          configuredSecretHeaderKeys?: ReadonlySet<string>,
          baseUrl?: string,
        ) => CustomFetch;
      };
      privateSelf.createFetchFunction.call(
        conn,
        () => null,
        undefined,
        300000,
        undefined,
        'https://mcp.example.com/mcp',
      );

      expect(privateSelf.agents.map((agent) => agent.constructor.name)).toEqual([
        'ProxyAgent',
        'ProxyAgent',
      ]);
    } finally {
      if (originalProxy == null) {
        delete process.env.PROXY;
      } else {
        process.env.PROXY = originalProxy;
      }
    }
  });

  it('should use standard HTTP proxy env vars for streamable-http when PROXY is absent', () => {
    const originalProxy = process.env.PROXY;
    const originalHttpProxy = process.env.HTTP_PROXY;
    const originalHttpsProxy = process.env.HTTPS_PROXY;
    const originalNoProxy = process.env.NO_PROXY;
    const originalLowerHttpProxy = process.env.http_proxy;
    const originalLowerHttpsProxy = process.env.https_proxy;
    const originalLowerNoProxy = process.env.no_proxy;

    delete process.env.PROXY;
    delete process.env.http_proxy;
    delete process.env.https_proxy;
    delete process.env.no_proxy;
    process.env.HTTP_PROXY = 'http://http-proxy.example.com:8080';
    process.env.HTTPS_PROXY = 'http://https-proxy.example.com:8080';
    process.env.NO_PROXY = 'localhost,127.0.0.1';

    try {
      conn = new MCPConnection({
        serverName: 'customfetch-standard-env-proxy-dispatchers',
        serverConfig: {
          type: 'streamable-http',
          url: 'https://mcp.example.com/mcp',
        },
        useSSRFProtection: false,
      });

      const privateSelf = conn as unknown as {
        agents: Array<{ constructor: { name: string } }>;
        createFetchFunction: (
          getHeaders: () => Record<string, string> | null | undefined,
          timeout?: number,
          sseBodyTimeout?: number,
          configuredSecretHeaderKeys?: ReadonlySet<string>,
          baseUrl?: string,
        ) => CustomFetch;
      };
      privateSelf.createFetchFunction.call(
        conn,
        () => null,
        undefined,
        300000,
        undefined,
        'https://mcp.example.com/mcp',
      );

      expect(privateSelf.agents.map((agent) => agent.constructor.name)).toEqual([
        'ProxyAgent',
        'ProxyAgent',
      ]);
    } finally {
      if (originalProxy == null) {
        delete process.env.PROXY;
      } else {
        process.env.PROXY = originalProxy;
      }
      if (originalHttpProxy == null) {
        delete process.env.HTTP_PROXY;
      } else {
        process.env.HTTP_PROXY = originalHttpProxy;
      }
      if (originalHttpsProxy == null) {
        delete process.env.HTTPS_PROXY;
      } else {
        process.env.HTTPS_PROXY = originalHttpsProxy;
      }
      if (originalNoProxy == null) {
        delete process.env.NO_PROXY;
      } else {
        process.env.NO_PROXY = originalNoProxy;
      }
      if (originalLowerHttpProxy == null) {
        delete process.env.http_proxy;
      } else {
        process.env.http_proxy = originalLowerHttpProxy;
      }
      if (originalLowerHttpsProxy == null) {
        delete process.env.https_proxy;
      } else {
        process.env.https_proxy = originalLowerHttpsProxy;
      }
      if (originalLowerNoProxy == null) {
        delete process.env.no_proxy;
      } else {
        process.env.no_proxy = originalLowerNoProxy;
      }
    }
  });

  it('should honor NO_PROXY when standard HTTP proxy env vars are configured', () => {
    const originalProxy = process.env.PROXY;
    const originalHttpsProxy = process.env.HTTPS_PROXY;
    const originalNoProxy = process.env.NO_PROXY;
    const originalLowerHttpsProxy = process.env.https_proxy;
    const originalLowerNoProxy = process.env.no_proxy;

    delete process.env.PROXY;
    delete process.env.https_proxy;
    delete process.env.no_proxy;
    process.env.HTTPS_PROXY = 'http://https-proxy.example.com:8080';
    process.env.NO_PROXY = 'mcp.example.com';

    try {
      conn = new MCPConnection({
        serverName: 'customfetch-standard-env-no-proxy',
        serverConfig: {
          type: 'streamable-http',
          url: 'https://mcp.example.com/mcp',
        },
        useSSRFProtection: false,
      });

      const privateSelf = conn as unknown as {
        agents: Array<{ constructor: { name: string } }>;
        createFetchFunction: (
          getHeaders: () => Record<string, string> | null | undefined,
          timeout?: number,
          sseBodyTimeout?: number,
          configuredSecretHeaderKeys?: ReadonlySet<string>,
          baseUrl?: string,
        ) => CustomFetch;
      };
      privateSelf.createFetchFunction.call(
        conn,
        () => null,
        undefined,
        300000,
        undefined,
        'https://mcp.example.com/mcp',
      );

      expect(privateSelf.agents.map((agent) => agent.constructor.name)).toEqual(['Agent', 'Agent']);
    } finally {
      if (originalProxy == null) {
        delete process.env.PROXY;
      } else {
        process.env.PROXY = originalProxy;
      }
      if (originalHttpsProxy == null) {
        delete process.env.HTTPS_PROXY;
      } else {
        process.env.HTTPS_PROXY = originalHttpsProxy;
      }
      if (originalNoProxy == null) {
        delete process.env.NO_PROXY;
      } else {
        process.env.NO_PROXY = originalNoProxy;
      }
      if (originalLowerHttpsProxy == null) {
        delete process.env.https_proxy;
      } else {
        process.env.https_proxy = originalLowerHttpsProxy;
      }
      if (originalLowerNoProxy == null) {
        delete process.env.no_proxy;
      } else {
        process.env.no_proxy = originalLowerNoProxy;
      }
    }
  });

  it('should honor bare IPv6 NO_PROXY entries without parsing a port suffix', () => {
    const originalProxy = process.env.PROXY;
    const originalHttpProxy = process.env.HTTP_PROXY;
    const originalNoProxy = process.env.NO_PROXY;
    const originalLowerHttpProxy = process.env.http_proxy;
    const originalLowerNoProxy = process.env.no_proxy;

    delete process.env.PROXY;
    delete process.env.http_proxy;
    delete process.env.no_proxy;
    process.env.HTTP_PROXY = 'http://http-proxy.example.com:8080';
    process.env.NO_PROXY = '::1';

    try {
      conn = new MCPConnection({
        serverName: 'customfetch-standard-env-no-proxy-ipv6',
        serverConfig: {
          type: 'streamable-http',
          url: 'http://[::1]:3000/mcp',
        },
        useSSRFProtection: false,
      });

      const privateSelf = conn as unknown as {
        agents: Array<{ constructor: { name: string } }>;
        createFetchFunction: (
          getHeaders: () => Record<string, string> | null | undefined,
          timeout?: number,
          sseBodyTimeout?: number,
          configuredSecretHeaderKeys?: ReadonlySet<string>,
          baseUrl?: string,
        ) => CustomFetch;
      };
      privateSelf.createFetchFunction.call(
        conn,
        () => null,
        undefined,
        300000,
        undefined,
        'http://[::1]:3000/mcp',
      );

      expect(privateSelf.agents.map((agent) => agent.constructor.name)).toEqual(['Agent', 'Agent']);
    } finally {
      if (originalProxy == null) {
        delete process.env.PROXY;
      } else {
        process.env.PROXY = originalProxy;
      }
      if (originalHttpProxy == null) {
        delete process.env.HTTP_PROXY;
      } else {
        process.env.HTTP_PROXY = originalHttpProxy;
      }
      if (originalNoProxy == null) {
        delete process.env.NO_PROXY;
      } else {
        process.env.NO_PROXY = originalNoProxy;
      }
      if (originalLowerHttpProxy == null) {
        delete process.env.http_proxy;
      } else {
        process.env.http_proxy = originalLowerHttpProxy;
      }
      if (originalLowerNoProxy == null) {
        delete process.env.no_proxy;
      } else {
        process.env.no_proxy = originalLowerNoProxy;
      }
    }
  });

  it('should honor wildcard tokens in NO_PROXY lists', () => {
    const originalProxy = process.env.PROXY;
    const originalHttpProxy = process.env.HTTP_PROXY;
    const originalNoProxy = process.env.NO_PROXY;
    const originalLowerHttpProxy = process.env.http_proxy;
    const originalLowerNoProxy = process.env.no_proxy;

    delete process.env.PROXY;
    delete process.env.http_proxy;
    delete process.env.no_proxy;
    process.env.HTTP_PROXY = 'http://http-proxy.example.com:8080';
    process.env.NO_PROXY = 'localhost,*';

    try {
      conn = new MCPConnection({
        serverName: 'customfetch-standard-env-no-proxy-wildcard-list',
        serverConfig: {
          type: 'streamable-http',
          url: 'http://mcp.example.com/mcp',
        },
        useSSRFProtection: false,
      });

      const privateSelf = conn as unknown as {
        agents: Array<{ constructor: { name: string } }>;
        createFetchFunction: (
          getHeaders: () => Record<string, string> | null | undefined,
          timeout?: number,
          sseBodyTimeout?: number,
          configuredSecretHeaderKeys?: ReadonlySet<string>,
          baseUrl?: string,
        ) => CustomFetch;
      };
      privateSelf.createFetchFunction.call(
        conn,
        () => null,
        undefined,
        300000,
        undefined,
        'http://mcp.example.com/mcp',
      );

      expect(privateSelf.agents.map((agent) => agent.constructor.name)).toEqual(['Agent', 'Agent']);
    } finally {
      if (originalProxy == null) {
        delete process.env.PROXY;
      } else {
        process.env.PROXY = originalProxy;
      }
      if (originalHttpProxy == null) {
        delete process.env.HTTP_PROXY;
      } else {
        process.env.HTTP_PROXY = originalHttpProxy;
      }
      if (originalNoProxy == null) {
        delete process.env.NO_PROXY;
      } else {
        process.env.NO_PROXY = originalNoProxy;
      }
      if (originalLowerHttpProxy == null) {
        delete process.env.http_proxy;
      } else {
        process.env.http_proxy = originalLowerHttpProxy;
      }
      if (originalLowerNoProxy == null) {
        delete process.env.no_proxy;
      } else {
        process.env.no_proxy = originalLowerNoProxy;
      }
    }
  });

  it('should honor CIDR and IP range patterns in NO_PROXY lists', async () => {
    const originalEnv = snapshotProxyEnv();
    clearProxyEnv();
    process.env.HTTP_PROXY = 'http://http-proxy.example.com:8080';
    process.env.NO_PROXY = '10.0.0.0/8,192.168.1.10-192.168.1.20';

    const expectDispatcherNamesForUrl = async (
      url: string,
      expectedNames: string[],
    ): Promise<void> => {
      await safeDisconnect(conn);
      conn = new MCPConnection({
        serverName: `customfetch-no-proxy-${url}`,
        serverConfig: {
          type: 'streamable-http',
          url,
        },
        useSSRFProtection: false,
      });
      expect(createBaseUrlDispatchers(conn, url)).toEqual(expectedNames);
    };

    try {
      await expectDispatcherNamesForUrl('http://10.2.3.4/mcp', ['Agent', 'Agent']);
      await expectDispatcherNamesForUrl('http://192.168.1.15/mcp', ['Agent', 'Agent']);
      await expectDispatcherNamesForUrl('http://192.168.1.25/mcp', ['ProxyAgent', 'ProxyAgent']);
    } finally {
      restoreProxyEnv(originalEnv);
    }
  });

  it('should match NO_PROXY host entries like undici env proxy agents', async () => {
    const originalEnv = snapshotProxyEnv();
    clearProxyEnv();
    process.env.HTTPS_PROXY = 'http://https-proxy.example.com:8080';

    const expectDispatcherNamesForUrl = async (
      noProxy: string,
      url: string,
      expectedNames: string[],
    ): Promise<void> => {
      await safeDisconnect(conn);
      process.env.NO_PROXY = noProxy;
      conn = new MCPConnection({
        serverName: `customfetch-no-proxy-host-${noProxy}-${url}`,
        serverConfig: {
          type: 'streamable-http',
          url,
        },
        useSSRFProtection: false,
      });
      expect(createBaseUrlDispatchers(conn, url)).toEqual(expectedNames);
    };

    try {
      await expectDispatcherNamesForUrl('example.com', 'https://example.com/mcp', [
        'Agent',
        'Agent',
      ]);
      await expectDispatcherNamesForUrl('example.com', 'https://api.example.com/mcp', [
        'Agent',
        'Agent',
      ]);
      await expectDispatcherNamesForUrl('*.example.com', 'https://api.example.com/mcp', [
        'Agent',
        'Agent',
      ]);
      await expectDispatcherNamesForUrl('*.example.com', 'https://example.com/mcp', [
        'Agent',
        'Agent',
      ]);
      await expectDispatcherNamesForUrl('.example.com', 'https://example.com/mcp', [
        'Agent',
        'Agent',
      ]);
      await expectDispatcherNamesForUrl('.example.com', 'https://api.example.com/mcp', [
        'Agent',
        'Agent',
      ]);
      await expectDispatcherNamesForUrl('example.com', 'https://badexample.com/mcp', [
        'ProxyAgent',
        'ProxyAgent',
      ]);
    } finally {
      restoreProxyEnv(originalEnv);
    }
  });

  it('should let empty lowercase proxy env vars disable uppercase fallbacks', () => {
    const originalProxy = process.env.PROXY;
    const originalHttpProxy = process.env.HTTP_PROXY;
    const originalNoProxy = process.env.NO_PROXY;
    const originalLowerHttpProxy = process.env.http_proxy;
    const originalLowerNoProxy = process.env.no_proxy;

    delete process.env.PROXY;
    delete process.env.NO_PROXY;
    delete process.env.no_proxy;
    process.env.HTTP_PROXY = 'http://http-proxy.example.com:8080';
    process.env.http_proxy = '';

    try {
      conn = new MCPConnection({
        serverName: 'customfetch-standard-empty-lowercase-proxy',
        serverConfig: {
          type: 'streamable-http',
          url: 'http://mcp.example.com/mcp',
        },
        useSSRFProtection: false,
      });

      const privateSelf = conn as unknown as {
        agents: Array<{ constructor: { name: string } }>;
        createFetchFunction: (
          getHeaders: () => Record<string, string> | null | undefined,
          timeout?: number,
          sseBodyTimeout?: number,
          configuredSecretHeaderKeys?: ReadonlySet<string>,
          baseUrl?: string,
        ) => CustomFetch;
      };
      privateSelf.createFetchFunction.call(
        conn,
        () => null,
        undefined,
        300000,
        undefined,
        'http://mcp.example.com/mcp',
      );

      expect(privateSelf.agents.map((agent) => agent.constructor.name)).toEqual(['Agent', 'Agent']);
    } finally {
      if (originalProxy == null) {
        delete process.env.PROXY;
      } else {
        process.env.PROXY = originalProxy;
      }
      if (originalHttpProxy == null) {
        delete process.env.HTTP_PROXY;
      } else {
        process.env.HTTP_PROXY = originalHttpProxy;
      }
      if (originalNoProxy == null) {
        delete process.env.NO_PROXY;
      } else {
        process.env.NO_PROXY = originalNoProxy;
      }
      if (originalLowerHttpProxy == null) {
        delete process.env.http_proxy;
      } else {
        process.env.http_proxy = originalLowerHttpProxy;
      }
      if (originalLowerNoProxy == null) {
        delete process.env.no_proxy;
      } else {
        process.env.no_proxy = originalLowerNoProxy;
      }
    }
  });

  it('should let empty lowercase no_proxy disable uppercase fallbacks', () => {
    const originalProxy = process.env.PROXY;
    const originalHttpProxy = process.env.HTTP_PROXY;
    const originalNoProxy = process.env.NO_PROXY;
    const originalLowerHttpProxy = process.env.http_proxy;
    const originalLowerNoProxy = process.env.no_proxy;

    delete process.env.PROXY;
    delete process.env.http_proxy;
    process.env.HTTP_PROXY = 'http://http-proxy.example.com:8080';
    process.env.NO_PROXY = 'mcp.example.com';
    process.env.no_proxy = '';

    try {
      conn = new MCPConnection({
        serverName: 'customfetch-standard-empty-lowercase-no-proxy',
        serverConfig: {
          type: 'streamable-http',
          url: 'http://mcp.example.com/mcp',
        },
        useSSRFProtection: false,
      });

      const privateSelf = conn as unknown as {
        agents: Array<{ constructor: { name: string } }>;
        createFetchFunction: (
          getHeaders: () => Record<string, string> | null | undefined,
          timeout?: number,
          sseBodyTimeout?: number,
          configuredSecretHeaderKeys?: ReadonlySet<string>,
          baseUrl?: string,
        ) => CustomFetch;
      };
      privateSelf.createFetchFunction.call(
        conn,
        () => null,
        undefined,
        300000,
        undefined,
        'http://mcp.example.com/mcp',
      );

      expect(privateSelf.agents.map((agent) => agent.constructor.name)).toEqual([
        'ProxyAgent',
        'ProxyAgent',
      ]);
    } finally {
      if (originalProxy == null) {
        delete process.env.PROXY;
      } else {
        process.env.PROXY = originalProxy;
      }
      if (originalHttpProxy == null) {
        delete process.env.HTTP_PROXY;
      } else {
        process.env.HTTP_PROXY = originalHttpProxy;
      }
      if (originalNoProxy == null) {
        delete process.env.NO_PROXY;
      } else {
        process.env.NO_PROXY = originalNoProxy;
      }
      if (originalLowerHttpProxy == null) {
        delete process.env.http_proxy;
      } else {
        process.env.http_proxy = originalLowerHttpProxy;
      }
      if (originalLowerNoProxy == null) {
        delete process.env.no_proxy;
      } else {
        process.env.no_proxy = originalLowerNoProxy;
      }
    }
  });

  it('should recompute proxy dispatchers from the resolved request URL', async () => {
    const originalEnv = snapshotProxyEnv();
    const capture = await createHeaderCaptureServer();
    clearProxyEnv();
    process.env.HTTP_PROXY = 'http://http-proxy.example.com:8080';
    process.env.NO_PROXY = '127.0.0.1';

    try {
      conn = new MCPConnection({
        serverName: 'customfetch-recompute-proxy-dispatcher',
        serverConfig: {
          type: 'streamable-http',
          url: 'http://mcp.example.com/mcp',
        },
        useSSRFProtection: false,
      });

      const customFetch = createBaseUrlFetch(conn, 'http://mcp.example.com/mcp');
      const response = await customFetch(capture.url);

      expect(response.status).toBe(200);
      await response.body?.cancel();
      expect(capture.receivedRequests).toHaveLength(1);
      expect(
        (conn as unknown as { agents: Array<{ constructor: { name: string } }> }).agents.map(
          (agent) => agent.constructor.name,
        ),
      ).toEqual(['ProxyAgent', 'ProxyAgent', 'Agent']);
    } finally {
      restoreProxyEnv(originalEnv);
      await capture.close();
    }
  });

  it('should preflight proxied IP literal targets before dispatching network requests', async () => {
    mockedResolveHostnameSSRF.mockResolvedValueOnce(true);

    conn = new MCPConnection({
      serverName: 'customfetch-proxy-ssrf',
      serverConfig: {
        type: 'streamable-http',
        url: 'https://mcp.example.com/mcp',
        proxy: 'http://proxy.example.com:8080',
      },
      useSSRFProtection: true,
    });

    const customFetch = getCustomFetch(conn);

    await expect(customFetch('http://203.0.113.10/mcp')).rejects.toThrow(
      /proxied MCP request target/,
    );
    expect(mockedResolveHostnameSSRF).toHaveBeenCalledWith('203.0.113.10', null, '80');
  });

  it('should reject proxied hostname targets unless explicitly allowed when SSRF protection is enabled', async () => {
    mockedResolveHostnameSSRF.mockClear();

    conn = new MCPConnection({
      serverName: 'customfetch-proxy-ssrf-hostname-denied',
      serverConfig: {
        type: 'streamable-http',
        url: 'https://mcp.example.com/mcp',
        proxy: 'http://proxy.example.com:8080',
      },
      useSSRFProtection: true,
    });

    const customFetch = getCustomFetch(conn);

    await expect(customFetch('http://hostname-only.example/mcp')).rejects.toThrow(
      /must be an IP literal or an explicitly allowed host/,
    );
    expect(mockedResolveHostnameSSRF).not.toHaveBeenCalled();
  });

  it('should skip proxied SSRF checks for explicitly allowed target hosts', async () => {
    const proxy = await createTunnelProxyCaptureServer();
    mockedResolveHostnameSSRF.mockClear();

    try {
      conn = new MCPConnection({
        serverName: 'customfetch-proxy-ssrf-allowed-dns',
        serverConfig: {
          type: 'streamable-http',
          url: 'https://mcp.example.com/mcp',
          proxy: proxy.url,
        },
        useSSRFProtection: true,
        allowedAddresses: ['proxy-only.internal:80'],
      });

      const customFetch = getCustomFetch(conn);
      const response = await customFetch('http://proxy-only.internal/mcp');

      expect(response.status).toBe(200);
      await response.body?.cancel().catch(() => undefined);
      expect(proxy.receivedRequests[0]?.method).toBe('CONNECT');
      expect(mockedResolveHostnameSSRF).not.toHaveBeenCalled();
    } finally {
      await proxy.close();
    }
  });

  it('should allow NO_PROXY hostname targets to use direct SSRF-safe dispatchers', async () => {
    const originalEnv = snapshotProxyEnv();
    const capture = await createHeaderCaptureServer();
    clearProxyEnv();
    process.env.HTTP_PROXY = 'http://http-proxy.example.com:8080';
    process.env.NO_PROXY = 'direct.example.com';
    mockedResolveHostnameSSRF.mockClear();

    try {
      conn = new MCPConnection({
        serverName: 'customfetch-no-proxy-hostname-direct',
        serverConfig: {
          type: 'streamable-http',
          url: 'http://mcp.example.com/mcp',
        },
        useSSRFProtection: true,
      });

      const customFetch = createBaseUrlFetch(conn, 'http://mcp.example.com/mcp');
      const directUrl = capture.url.replace('127.0.0.1', 'direct.example.com');
      const response = await customFetch(directUrl);

      expect(response.status).toBe(200);
      await response.body?.cancel().catch(() => undefined);
      expect(capture.receivedRequests).toHaveLength(1);
      expect(mockedResolveHostnameSSRF).not.toHaveBeenCalled();
    } finally {
      restoreProxyEnv(originalEnv);
      await capture.close();
    }
  });

  it.each<['string' | 'URL' | 'Request']>([['string'], ['URL'], ['Request']])(
    'should accept a %s input without throwing on URL derivation',
    async (shape) => {
      target = await createStreamableServer();

      conn = new MCPConnection({
        serverName: `customfetch-${shape.toLowerCase()}`,
        serverConfig: { type: 'streamable-http', url: target.url },
        useSSRFProtection: false,
      });

      const customFetch = getCustomFetch(conn);
      const inputs: Record<typeof shape, () => UndiciRequestInfo> = {
        string: () => target!.url,
        URL: () => new URL(target!.url),
        Request: () => new UndiciRequest(target!.url, { method: 'GET' }),
      };

      const response = await customFetch(inputs[shape]());
      expect(response.status).toBeGreaterThanOrEqual(200);
      await response.body?.cancel().catch(() => undefined);
    },
  );

  it('should preserve headers carried on a Request input when no override headers are supplied', async () => {
    /**
     * Pre-fix regression: `buildFetchInit` unconditionally set `headers: {}`
     * when neither `init.headers` nor runtime headers contributed anything.
     * That overrode the headers attached to the `Request` itself, dropping
     * Authorization / mcp-session-id / protocol negotiation headers that
     * wrappers commonly bake onto the `Request` object directly.
     */
    const capture = await createHeaderCaptureServer();
    try {
      conn = new MCPConnection({
        serverName: 'customfetch-request-headers',
        serverConfig: { type: 'streamable-http', url: capture.url },
        useSSRFProtection: false,
      });

      const customFetch = getCustomFetch(conn);
      const request = new UndiciRequest(capture.url, {
        method: 'GET',
        headers: {
          Authorization: 'Bearer request-input-token',
          'X-Wrapper-Header': 'wrapper-supplied',
        },
      });

      const response = await customFetch(request);
      expect(response.status).toBe(200);
      await response.body?.cancel().catch(() => undefined);

      expect(capture.receivedHeaders.length).toBeGreaterThan(0);
      const headers = capture.receivedHeaders[0];
      expect(headers['authorization']).toBe('Bearer request-input-token');
      expect(headers['x-wrapper-header']).toBe('wrapper-supplied');
    } finally {
      await capture.close();
    }
  });

  it('should preserve POST method and body across a 308 redirect when input is a Request', async () => {
    /**
     * Pre-fix regression: switching `url` to the `Location` string on
     * redirect dropped the original `Request`'s method and body, so a
     * redirected POST silently became a GET with no payload — the exact
     * thing 307/308 are designed to forbid.
     */
    const capture = await createHeaderCaptureServer();
    let server: TestServer | undefined;
    try {
      server = await createCrossOriginRedirectingServer(capture.url, 308);

      conn = new MCPConnection({
        serverName: 'customfetch-request-redirect-post',
        serverConfig: { type: 'streamable-http', url: server.url },
        useSSRFProtection: false,
      });

      const customFetch = getCustomFetch(conn);
      const payload = JSON.stringify({ jsonrpc: '2.0', method: 'ping', id: 1 });
      const request = new UndiciRequest(server.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: payload,
      });

      const response = await customFetch(request);
      expect(response.status).toBe(200);
      await response.body?.cancel().catch(() => undefined);

      expect(server.redirectHit).toBe(true);
      expect(capture.receivedRequests.length).toBeGreaterThan(0);
      const last = capture.receivedRequests[capture.receivedRequests.length - 1];
      expect(last.method).toBe('POST');
      expect(last.body).toBe(payload);
    } finally {
      await capture.close();
      if (server) {
        await server.close();
      }
    }
  });

  it("should honor the Request's AbortController.signal even after Request -> (string, init) normalization", async () => {
    /**
     * Pre-fix regression: `resolveFetchInput` copied method/body/headers
     * out of a `Request` input but dropped `Request.signal`. Callers that
     * wired an `AbortController` onto the `Request` for cancellation or
     * timeouts lost that wiring on entry to the redirect loop, so an abort
     * after the request started had no effect.
     */
    target = await createStreamableServer();
    conn = new MCPConnection({
      serverName: 'customfetch-request-signal',
      serverConfig: { type: 'streamable-http', url: target.url },
      useSSRFProtection: false,
    });

    const customFetch = getCustomFetch(conn);
    const controller = new AbortController();
    const request = new UndiciRequest(target.url, {
      method: 'GET',
      signal: controller.signal,
    });
    /** Abort before the fetch lands so we don't race the real socket. */
    controller.abort();

    await expect(customFetch(request)).rejects.toThrow();
  });

  it('should not crash on a cross-origin redirect when no headers are present', async () => {
    /**
     * Pre-fix regression: `buildFetchInit` skips setting `headers` when
     * nothing contributes any, but the cross-origin strip path read
     * `currentInit.headers` unconditionally and called `Object.entries`
     * on `undefined`, throwing `TypeError`. Guarded so a no-headers
     * cross-origin hop returns the response cleanly.
     */
    const capture = await createHeaderCaptureServer();
    let server: TestServer | undefined;
    try {
      server = await createCrossOriginRedirectingServer(capture.url, 307);

      conn = new MCPConnection({
        serverName: 'customfetch-redirect-no-headers',
        serverConfig: { type: 'streamable-http', url: server.url },
        useSSRFProtection: false,
      });

      const customFetch = getCustomFetch(conn);
      const response = await customFetch(server.url);
      expect(response.status).toBe(200);
      await response.body?.cancel().catch(() => undefined);
      expect(server.redirectHit).toBe(true);
    } finally {
      await capture.close();
      if (server) {
        await server.close();
      }
    }
  });

  it('should not apply streamable HTTP response caps unless the transport opts in', async () => {
    process.env.MCP_STREAMABLE_HTTP_MAX_RESPONSE_BYTES = '8';
    const server = await createRawResponseServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"jsonrpc":"2.0","id":1,"result":{"too":"large"}}');
    });
    try {
      conn = new MCPConnection({
        serverName: 'customfetch-unguarded-byte-limit',
        serverConfig: { type: 'sse', url: server.url },
        useSSRFProtection: false,
      });

      const customFetch = getCustomFetch(conn);
      const response = await customFetch(server.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'ping', id: 1 }),
      });

      await expect(response.text()).resolves.toContain('"too":"large"');
    } finally {
      await server.close();
    }
  });

  it('should reject oversized JSON POST responses with the streamable HTTP byte cap', async () => {
    process.env.MCP_STREAMABLE_HTTP_MAX_RESPONSE_BYTES = '8';
    const server = await createRawResponseServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"jsonrpc":"2.0","id":1,"result":{"too":"large"}}');
    });
    try {
      conn = new MCPConnection({
        serverName: 'customfetch-json-byte-limit',
        serverConfig: { type: 'streamable-http', url: server.url },
        useSSRFProtection: false,
      });

      const customFetch = getGuardedStreamableHTTPCustomFetch(conn);
      const response = await customFetch(server.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'ping', id: 1 }),
      });

      await expect(response.text()).rejects.toThrow(
        /MCP response exceeded byte limit.*limit=8 bytes/,
      );
    } finally {
      await server.close();
    }
  });

  /**
   * A `Content-Type` whose parameters mention the SSE type is not an SSE response. Classifying
   * it by substring made the guard hand the caller a synthetic SSE error frame — parsed as a
   * successful response body — instead of throwing, so an oversized body arrived looking well
   * formed.
   */
  it('should not treat a content type that merely mentions the SSE type as an event stream', async () => {
    process.env.MCP_STREAMABLE_HTTP_MAX_RESPONSE_BYTES = '8';
    const server = await createRawResponseServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain; boundary=text/event-stream' });
      res.end('{"jsonrpc":"2.0","id":1,"result":{"too":"large"}}');
    });
    try {
      conn = new MCPConnection({
        serverName: 'customfetch-deceptive-content-type',
        serverConfig: { type: 'streamable-http', url: server.url },
        useSSRFProtection: false,
      });

      const customFetch = getGuardedStreamableHTTPCustomFetch(conn);
      const response = await customFetch(server.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'ping', id: 1 }),
      });

      await expect(response.text()).rejects.toThrow(
        /MCP response exceeded byte limit.*limit=8 bytes/,
      );
    } finally {
      await server.close();
    }
  });

  it('should still guard a genuine event stream whose content type carries parameters', async () => {
    process.env.MCP_STREAMABLE_HTTP_MAX_LINE_BYTES = '16';
    const server = await createRawResponseServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'TEXT/EVENT-STREAM; charset=utf-8' });
      res.end(`data: ${'x'.repeat(256)}\n\n`);
    });
    try {
      conn = new MCPConnection({
        serverName: 'customfetch-parameterized-sse',
        serverConfig: { type: 'streamable-http', url: server.url },
        useSSRFProtection: false,
      });

      const customFetch = getGuardedStreamableHTTPCustomFetch(conn);
      const response = await customFetch(server.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'ping', id: 1 }),
      });

      await expect(response.text()).resolves.toContain(
        'MCP response contained an oversized SSE line',
      );
    } finally {
      await server.close();
    }
  });

  it('should reject a POST response with an oversized SSE line before the SSE parser can grow it', async () => {
    process.env.MCP_STREAMABLE_HTTP_MAX_LINE_BYTES = '16';
    const server = await createRawResponseServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end(`data: ${'x'.repeat(64)}\n\n`);
    });
    try {
      conn = new MCPConnection({
        serverName: 'customfetch-sse-line-limit',
        serverConfig: { type: 'streamable-http', url: server.url },
        useSSRFProtection: false,
      });

      const customFetch = getGuardedStreamableHTTPCustomFetch(conn);
      const response = await customFetch(server.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled' }),
      });
      await expect(response.text()).rejects.toThrow(
        /MCP response contained an oversized SSE line.*lineLimit=16 bytes.*observedLine=17 bytes/,
      );
    } finally {
      await server.close();
    }
  });

  it('should allow SSE lines above the old 1 MiB default when no line override is set', async () => {
    delete process.env.MCP_STREAMABLE_HTTP_MAX_LINE_BYTES;
    const payload = 'x'.repeat(2 * 1024 * 1024);
    const server = await createRawResponseServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end(`data: ${payload}\n\n`);
    });
    try {
      conn = new MCPConnection({
        serverName: 'customfetch-sse-default-line-limit',
        serverConfig: { type: 'streamable-http', url: server.url },
        useSSRFProtection: false,
      });

      const customFetch = getGuardedStreamableHTTPCustomFetch(conn);
      const response = await customFetch(server.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled' }),
      });

      await expect(response.text()).resolves.toContain(payload.slice(0, 128));
    } finally {
      await server.close();
    }
  });

  it('should fail an actual streamable HTTP tool call promptly with a clear oversized SSE line error', async () => {
    process.env.MCP_STREAMABLE_HTTP_MAX_LINE_BYTES = '512';
    target = await createOversizedToolResultStreamableServer(2048);
    conn = new MCPConnection({
      serverName: 'streamable-http-tool-call-sse-line-limit',
      serverConfig: { type: 'streamable-http', url: target.url },
      useSSRFProtection: false,
    });

    await conn.connect();
    const startedAt = Date.now();

    await expect(
      conn.client.callTool({ name: 'oversized', arguments: {} }, undefined, { timeout: 3000 }),
    ).rejects.toThrow(/MCP response contained an oversized SSE line/);
    expect(Date.now() - startedAt).toBeLessThan(1500);
  });

  it('should stream valid SSE POST responses without waiting for EOF', async () => {
    process.env.MCP_STREAMABLE_HTTP_MAX_LINE_BYTES = '4096';
    let finish!: () => void;
    const finished = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const server = await createRawResponseServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: {"jsonrpc":"2.0","id":1,"result":{}}\n\n');
      finished.then(() => res.end()).catch(() => res.end());
    });
    try {
      conn = new MCPConnection({
        serverName: 'customfetch-sse-streaming',
        serverConfig: { type: 'streamable-http', url: server.url },
        useSSRFProtection: false,
      });

      const customFetch = getGuardedStreamableHTTPCustomFetch(conn);
      const response = await customFetch(server.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'ping', id: 1 }),
      });
      const reader = response.body!.getReader();
      const { value, done } = await reader.read();

      expect(done).toBe(false);
      expect(Buffer.from(value as Uint8Array).toString('utf8')).toContain('"result":{}');
      await reader.cancel().catch(() => undefined);
      finish();
    } finally {
      finish();
      await server.close();
    }
  });
});

describe('MCP SSRF protection – WebSocket DNS resolution', () => {
  let conn: MCPConnection | null;

  afterEach(async () => {
    await safeDisconnect(conn);
    conn = null;
    jest.restoreAllMocks();
  });

  it('should block WebSocket to host resolving to private IP when SSRF protection is on', async () => {
    mockedResolveHostnameSSRF.mockResolvedValueOnce(true);

    conn = new MCPConnection({
      serverName: 'ws-ssrf-test',
      serverConfig: { type: 'websocket', url: 'ws://evil.example.com:8080/mcp' },
      useSSRFProtection: true,
    });

    await expect(conn.connect()).rejects.toThrow(/SSRF protection/);
    expect(mockedResolveHostnameSSRF).toHaveBeenCalledWith(
      expect.stringContaining('evil.example.com'),
      null,
      '8080',
    );
  });

  it('should block WebSocket to host resolving to private IP even with SSRF protection off', async () => {
    mockedResolveHostnameSSRF.mockResolvedValueOnce(true);

    conn = new MCPConnection({
      serverName: 'ws-ssrf-allowlist',
      serverConfig: { type: 'websocket', url: 'ws://allowlisted.example.com:8080/mcp' },
      useSSRFProtection: false,
    });

    await expect(conn.connect()).rejects.toThrow(/SSRF protection/);
    expect(mockedResolveHostnameSSRF).toHaveBeenCalledWith(
      expect.stringContaining('allowlisted.example.com'),
      null,
      '8080',
    );
  });

  it('should allow WebSocket to host resolving to public IP', async () => {
    mockedResolveHostnameSSRF.mockResolvedValueOnce(false);

    conn = new MCPConnection({
      serverName: 'ws-public-test',
      serverConfig: { type: 'websocket', url: 'ws://public.example.com:8080/mcp' },
      useSSRFProtection: true,
    });

    /** Fails on connect (no real server), but the error must not be an SSRF rejection. */
    await expect(conn.connect()).rejects.not.toThrow(/SSRF protection/);
  });
});
