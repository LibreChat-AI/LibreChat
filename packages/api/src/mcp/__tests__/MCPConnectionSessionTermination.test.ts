/**
 * Integration tests for Streamable HTTP session termination.
 *
 * Per the MCP spec, a client that discards a Streamable HTTP connection SHOULD
 * send an `HTTP DELETE` with the `Mcp-Session-Id` header so stateful servers can
 * free the session. These tests spin up a real in-process
 * StreamableHTTPServerTransport and assert that MCPConnection issues that DELETE
 * on both teardown paths (`disconnect()` and the reconnect transport swap),
 * while leaving non-streamable transports untouched.
 */

import * as net from 'net';
import * as http from 'http';
import { randomUUID } from 'crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { Server as McpServerCore } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Socket } from 'net';
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

interface DeleteRecord {
  sessionId?: string;
}

interface StreamableTestServer {
  url: string;
  deletes: DeleteRecord[];
  liveSessionCount: () => number;
  sessionsCreated: () => number;
  close: () => Promise<void>;
}

/**
 * Bind directly to an ephemeral port and read the assigned port after the server
 * is listening. Probing for a free port first and reusing it leaves a
 * bind/listen race where a parallel CI process can claim the port in between.
 */
function listenOnEphemeralPort(httpServer: http.Server): Promise<number> {
  return new Promise((resolve) => {
    httpServer.listen(0, '127.0.0.1', () => {
      const addr = httpServer.address() as net.AddressInfo;
      resolve(addr.port);
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
 * Streamable HTTP server that records every DELETE it receives. `deleteStatus`
 * intercepts DELETE with that status before the SDK transport handles it, to
 * simulate a server that opts out of termination (405) or fails it (500).
 */
async function createStreamableServer(
  options: { deleteStatus?: number } = {},
): Promise<StreamableTestServer> {
  const sessions = new Map<string, StreamableHTTPServerTransport>();
  const deletes: DeleteRecord[] = [];
  let sessionsCreated = 0;

  const httpServer = http.createServer(async (req, res) => {
    const sid = req.headers['mcp-session-id'] as string | undefined;

    if (req.method === 'DELETE') {
      deletes.push({ sessionId: sid });
      if (options.deleteStatus != null) {
        res.writeHead(options.deleteStatus).end();
        return;
      }
    }

    let transport = sid ? sessions.get(sid) : undefined;
    const isNewTransport = !transport;

    if (!transport) {
      transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() });
      const mcp = new McpServer({ name: 'test-streamable', version: '0.0.1' });
      await mcp.connect(transport);
    }

    await transport.handleRequest(req, res);

    /**
     * Register the session exactly once, on the initialize request that created
     * it. Reusing this guard for every request would let a long-lived GET stream
     * (or any later request) re-add a session the SDK already closed and removed
     * via `onclose` when it handled the client's DELETE.
     */
    if (isNewTransport && transport.sessionId) {
      sessionsCreated += 1;
      const registeredId = transport.sessionId;
      sessions.set(registeredId, transport);
      transport.onclose = () => sessions.delete(registeredId);
    }
  });

  const destroySockets = trackSockets(httpServer);
  const port = await listenOnEphemeralPort(httpServer);

  return {
    url: `http://127.0.0.1:${port}/`,
    deletes,
    liveSessionCount: () => sessions.size,
    sessionsCreated: () => sessionsCreated,
    close: async () => {
      const closing = [...sessions.values()].map((t) => t.close().catch(() => undefined));
      sessions.clear();
      await Promise.all(closing);
      await destroySockets();
    },
  };
}

interface SSETestServer {
  url: string;
  deletes: string[];
  close: () => Promise<void>;
}

async function createSSEServer(): Promise<SSETestServer> {
  const transports = new Map<string, SSEServerTransport>();
  const mcpServer = new McpServerCore({ name: 'test-sse', version: '0.0.1' }, { capabilities: {} });
  const deletes: string[] = [];

  const httpServer = http.createServer(async (req, res) => {
    if (req.method === 'DELETE') {
      deletes.push(req.url ?? '');
      res.writeHead(405).end();
      return;
    }

    if (req.method === 'GET' && req.url === '/sse') {
      const t = new SSEServerTransport('/messages', res);
      transports.set(t.sessionId, t);
      t.onclose = () => transports.delete(t.sessionId);
      await mcpServer.connect(t);
      return;
    }

    if (req.method === 'POST' && req.url?.startsWith('/messages')) {
      const sid = new URL(req.url, 'http://x').searchParams.get('sessionId') ?? '';
      const t = transports.get(sid);
      if (!t) {
        res.writeHead(404).end();
        return;
      }
      await t.handlePostMessage(req, res);
      return;
    }

    res.writeHead(404).end();
  });

  const destroySockets = trackSockets(httpServer);
  const port = await listenOnEphemeralPort(httpServer);

  return {
    url: `http://127.0.0.1:${port}/sse`,
    deletes,
    close: async () => {
      const closing = [...transports.values()].map((t) => t.close().catch(() => undefined));
      transports.clear();
      await Promise.all(closing);
      await destroySockets();
    },
  };
}

/**
 * Server-side session cleanup runs in the transport's `onclose`, which fires
 * shortly after the client's DELETE resolves. Poll instead of asserting
 * synchronously so the end-to-end effect is verified without a timing flake.
 */
async function waitForCondition(
  predicate: () => boolean,
  timeoutMs = 2000,
  intervalMs = 10,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error('Timed out waiting for condition');
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

async function safeDisconnect(conn: MCPConnection | null): Promise<void> {
  if (!conn) {
    return;
  }
  (conn as unknown as { shouldStopReconnecting: boolean }).shouldStopReconnecting = true;
  conn.removeAllListeners();
  await conn.disconnect();
}

/** Read the session id the client transport negotiated with the server. */
function getClientSessionId(conn: MCPConnection): string | undefined {
  const transport = (conn as unknown as { transport?: { sessionId?: string } }).transport;
  return transport?.sessionId;
}

describe('MCPConnection Streamable HTTP session termination', () => {
  let server: StreamableTestServer | null;
  let conn: MCPConnection | null;

  beforeEach(() => {
    server = null;
    conn = null;
  });

  afterEach(async () => {
    MCPConnection.clearCooldown('test');
    await safeDisconnect(conn);
    conn = null;
    jest.restoreAllMocks();
    await server?.close();
  });

  it('sends an HTTP DELETE with the session id and frees the server-side session on disconnect', async () => {
    const srv = await createStreamableServer();
    server = srv;
    conn = new MCPConnection({
      serverName: 'test',
      serverConfig: { type: 'streamable-http', url: srv.url },
      useSSRFProtection: false,
    });

    await conn.connect();
    const sessionId = getClientSessionId(conn);
    expect(sessionId).toBeTruthy();
    expect(srv.liveSessionCount()).toBe(1);

    await safeDisconnect(conn);
    conn = null;

    expect(srv.deletes).toEqual([{ sessionId }]);
    await waitForCondition(() => srv.liveSessionCount() === 0);
  });

  it('terminates the prior session before swapping in a fresh transport on reconnect', async () => {
    const srv = await createStreamableServer();
    server = srv;
    conn = new MCPConnection({
      serverName: 'test',
      serverConfig: { type: 'streamable-http', url: srv.url },
      useSSRFProtection: false,
    });

    await conn.connect();
    const firstSessionId = getClientSessionId(conn);
    expect(firstSessionId).toBeTruthy();

    await conn.connect();
    const secondSessionId = getClientSessionId(conn);

    expect(secondSessionId).toBeTruthy();
    expect(secondSessionId).not.toBe(firstSessionId);
    expect(srv.deletes).toContainEqual({ sessionId: firstSessionId });
    await waitForCondition(() => srv.liveSessionCount() === 1);
  });

  it('does not throw when the server rejects termination with 405', async () => {
    const srv = await createStreamableServer({ deleteStatus: 405 });
    server = srv;
    conn = new MCPConnection({
      serverName: 'test',
      serverConfig: { type: 'streamable-http', url: srv.url },
      useSSRFProtection: false,
    });

    await conn.connect();
    const sessionId = getClientSessionId(conn);

    await expect(safeDisconnect(conn)).resolves.toBeUndefined();
    conn = null;

    expect(srv.deletes).toEqual([{ sessionId }]);
  });

  it('does not trigger reconnection when the termination DELETE fails', async () => {
    const srv = await createStreamableServer({ deleteStatus: 500 });
    server = srv;
    conn = new MCPConnection({
      serverName: 'test',
      serverConfig: { type: 'streamable-http', url: srv.url },
      useSSRFProtection: false,
    });

    await conn.connect();
    const sessionId = getClientSessionId(conn);
    expect(srv.sessionsCreated()).toBe(1);

    /**
     * A failed DELETE makes the SDK invoke `transport.onerror`. If that were
     * still wired to our handler it would emit `connectionChange('error')` and
     * reconnect mid-teardown, so spy on the reconnection entrypoint. Disconnect
     * directly (not `safeDisconnect`, which sets `shouldStopReconnecting` and
     * would mask the bug).
     */
    const reconnectSpy = jest
      .spyOn(conn as unknown as { handleReconnection: () => Promise<void> }, 'handleReconnection')
      .mockResolvedValue(undefined);

    await conn.disconnect();

    expect(srv.deletes).toEqual([{ sessionId }]);
    expect(reconnectSpy).not.toHaveBeenCalled();
    expect(srv.sessionsCreated()).toBe(1);
    conn = null;
  });
});

describe('MCPConnection SSE session termination', () => {
  let server: SSETestServer | null;
  let conn: MCPConnection | null;

  beforeEach(() => {
    server = null;
    conn = null;
  });

  afterEach(async () => {
    MCPConnection.clearCooldown('test-sse');
    await safeDisconnect(conn);
    conn = null;
    jest.restoreAllMocks();
    await server?.close();
  });

  it('does not send a DELETE for a non-streamable transport', async () => {
    const srv = await createSSEServer();
    server = srv;
    conn = new MCPConnection({
      serverName: 'test-sse',
      serverConfig: { type: 'sse', url: srv.url },
      useSSRFProtection: false,
    });

    await conn.connect();
    await safeDisconnect(conn);
    conn = null;

    expect(srv.deletes).toEqual([]);
  });
});
