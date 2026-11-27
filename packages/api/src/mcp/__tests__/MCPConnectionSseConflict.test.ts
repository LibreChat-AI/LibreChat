/**
 * Integration tests for the `409` a Streamable HTTP server returns when the standalone `GET`
 * SSE stream is already mapped to the session.
 *
 * These drive a real client transport against a real in-process server that reproduces the
 * production sequence: the stream opens, dies at the socket (undici surfaces this as
 * `TypeError: terminated`), and every reconnect then conflicts because the server never
 * observed the disconnect and still holds the previous stream.
 */

import * as net from 'net';
import * as http from 'http';
import { randomUUID } from 'crypto';
import { logger } from '@librechat/data-schemas';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
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

interface ConflictTestServer {
  url: string;
  getRequests: () => number;
  close: () => Promise<void>;
}

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
 * Serves `initialize` from a real `StreamableHTTPServerTransport` so the client negotiates a
 * genuine session, then models a server holding a leaked stream. The leak is per-session, as it
 * is in the SDK: the first session's stream has its socket destroyed underneath the client and
 * every later `GET` carrying that session id conflicts, while a rebuilt session gets a healthy
 * stream — so recovery is only possible by replacing the session.
 */
async function createConflictingServer(): Promise<ConflictTestServer> {
  const sessions = new Map<string, StreamableHTTPServerTransport>();
  const streamedSessions = new Set<string>();
  let getRequests = 0;

  const httpServer = http.createServer(async (req, res) => {
    if (req.method === 'GET') {
      getRequests += 1;
      const streamSid = (req.headers['mcp-session-id'] as string | undefined) ?? '';

      if (streamedSessions.has(streamSid)) {
        res.writeHead(409, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            jsonrpc: '2.0',
            error: {
              code: -32000,
              message: 'Conflict: Only one SSE stream is allowed per session',
            },
            id: null,
          }),
        );
        return;
      }

      const isFirstStream = streamedSessions.size === 0;
      streamedSessions.add(streamSid);
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
      });
      res.write(': open\n\n');

      if (isFirstStream) {
        setTimeout(() => req.socket.destroy(), 50);
      }
      return;
    }

    const sid = req.headers['mcp-session-id'] as string | undefined;
    let transport = sid ? sessions.get(sid) : undefined;
    const isNewTransport = !transport;

    if (!transport) {
      transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() });
      const mcp = new McpServer({ name: 'test-conflict', version: '0.0.1' });
      await mcp.connect(transport);
    }

    await transport.handleRequest(req, res);

    if (isNewTransport && transport.sessionId) {
      const registeredId = transport.sessionId;
      sessions.set(registeredId, transport);
      transport.onclose = () => sessions.delete(registeredId);
    }
  });

  const destroySockets = trackSockets(httpServer);
  const port = await listenOnEphemeralPort(httpServer);

  return {
    url: `http://127.0.0.1:${port}/`,
    getRequests: () => getRequests,
    close: async () => {
      const closing = [...sessions.values()].map((t) => t.close().catch(() => undefined));
      sessions.clear();
      await Promise.all(closing);
      await destroySockets();
    },
  };
}

async function waitForCondition(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 10000,
  intervalMs = 25,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() > deadline) {
      throw new Error('Timed out waiting for condition');
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

function loggedMessages(mock: jest.Mock): string[] {
  return mock.mock.calls.map((call) => String(call[0]));
}

function countMatching(mock: jest.Mock, needle: string): number {
  return loggedMessages(mock).filter((message) => message.includes(needle)).length;
}

async function safeDisconnect(conn: MCPConnection | null): Promise<void> {
  if (!conn) {
    return;
  }
  (conn as unknown as { shouldStopReconnecting: boolean }).shouldStopReconnecting = true;
  conn.removeAllListeners();
  await conn.disconnect();
}

describe('MCPConnection standalone SSE stream conflict', () => {
  let server: ConflictTestServer | null;
  let conn: MCPConnection | null;

  beforeEach(() => {
    server = null;
    conn = null;
    jest.clearAllMocks();
  });

  afterEach(async () => {
    MCPConnection.clearCooldown('test');
    await safeDisconnect(conn);
    conn = null;
    await server?.close();
  });

  it('escalates the first conflict for rebuild and reports the rest as follow-on noise', async () => {
    const srv = await createConflictingServer();
    server = srv;
    conn = new MCPConnection({
      serverName: 'test',
      serverConfig: { type: 'streamable-http', url: srv.url },
      useSSRFProtection: false,
    });

    const escalations: string[] = [];
    conn.on('connectionChange', (state: string) => {
      if (state === 'error') {
        escalations.push(state);
      }
    });

    await conn.connect();

    /**
     * Let the SDK exhaust its own retry budget without the rebuild closing the transport
     * partway through, so the full sequence of repeat conflicts is observable.
     */
    (conn as unknown as { shouldStopReconnecting: boolean }).shouldStopReconnecting = true;

    const warnMock = logger.warn as jest.Mock;
    const errorMock = logger.error as jest.Mock;
    const debugMock = logger.debug as jest.Mock;

    await waitForCondition(
      () => countMatching(warnMock, 'conflicted with a stale server-side') > 0,
    );
    await waitForCondition(() => srv.getRequests() >= 3);
    await waitForCondition(
      () => countMatching(debugMock, 'SDK reconnection budget exhausted') > 0,
      10000,
    );

    expect(countMatching(warnMock, 'conflicted with a stale server-side')).toBe(1);
    expect(escalations).toEqual(['error']);

    expect(countMatching(debugMock, 'still conflicting; session rebuild already underway')).toBe(1);
    expect(countMatching(errorMock, 'may require manual intervention')).toBe(0);
    expect(countMatching(errorMock, 'Maximum reconnection attempts')).toBe(0);
  }, 20000);

  it('rebuilds the session so the connection recovers from the conflict', async () => {
    const srv = await createConflictingServer();
    server = srv;
    const connection = new MCPConnection({
      serverName: 'test',
      serverConfig: { type: 'streamable-http', url: srv.url },
      useSSRFProtection: false,
    });
    conn = connection;

    await connection.connect();
    const firstSessionId = (connection as unknown as { transport?: { sessionId?: string } })
      .transport?.sessionId;
    expect(firstSessionId).toBeTruthy();

    /**
     * `client.connect()` assigns the new session id as soon as initialize returns,
     * before `connectClient` emits `connected`. Waiting on the id swap alone races
     * that handshake, so require a live connection on the rebuilt session.
     */
    await waitForCondition(async () => {
      const current = (connection as unknown as { transport?: { sessionId?: string } }).transport
        ?.sessionId;
      return Boolean(current) && current !== firstSessionId && (await connection.isConnected());
    }, 15000);

    expect(await connection.isConnected()).toBe(true);
  }, 25000);
});
