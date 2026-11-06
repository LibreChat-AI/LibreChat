/**
 * Integration tests for MCPConnection undici Agent lifecycle.
 *
 * These tests spin up real in-process MCP servers using the official SDK's
 * StreamableHTTPServerTransport and SSEServerTransport, then connect via
 * MCPConnection and assert that:
 *
 * 1. Agents are reused across requests — one per transport, not one per request.
 * 2. All Agents are closed when disconnect() is called.
 * 3. Prior Agents are closed before a new transport is built during reconnection.
 * 4. A second disconnect() does not double-close already-cleared Agents.
 * 5. SSE 404 without an active session is silently ignored (backwards compat).
 * 6. SSE 404 with an active session falls through so reconnection can fire.
 * 7. Regression: the old per-request Agent pattern results in leaked agents that
 *    are never closed — proving the fix is necessary.
 */

import * as net from 'net';
import * as http from 'http';
import { randomUUID } from 'crypto';
import { logger } from '@librechat/data-schemas';
import { Agent, fetch as undiciFetch } from 'undici';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { Server as McpServerCore } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
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

const mockLogger = logger as jest.Mocked<typeof logger>;

/**
 * Track every Agent created during the test run so we can forcibly tear down their
 * internal connection pools in afterAll. The MCP SDK's Client / EventSource may hold
 * references to undici internals that keep Node's event loop alive.
 */
const allAgentsCreated: Agent[] = [];
const OriginalAgent = Agent;
const PatchedAgent = new Proxy(OriginalAgent, {
  construct(target, args) {
    const instance = new target(...(args as [Agent.Options?]));
    allAgentsCreated.push(instance);
    return instance;
  },
});
(global as Record<string, unknown>).__undiciAgent = PatchedAgent;

/** Cleanly disconnect an MCPConnection — suppress reconnection first so no timers linger. */
async function safeDisconnect(conn: MCPConnection | null): Promise<void> {
  if (!conn) {
    return;
  }
  (conn as unknown as { shouldStopReconnecting: boolean }).shouldStopReconnecting = true;
  conn.removeAllListeners();
  await conn.disconnect();
}

afterAll(async () => {
  const destroying = allAgentsCreated.map((a) => {
    if (!a.destroyed && !a.closed) {
      return a.destroy().catch(() => undefined);
    }
    return Promise.resolve();
  });
  allAgentsCreated.length = 0;
  await Promise.all(destroying);
});

interface TestServer {
  url: string;
  close: () => Promise<void>;
}

const SESSION_ID_LESS_TEST_TOOL = {
  name: 'sessionless-post-tool',
  description: 'Proves the Streamable HTTP POST channel remains usable',
  inputSchema: { type: 'object' as const, properties: {} },
};

function createStreamableClientTransport(sessionId?: string) {
  return new StreamableHTTPClientTransport(new URL('http://127.0.0.1:1/mcp'), { sessionId });
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

/** Wraps an http.Server with socket tracking so close() kills all lingering connections. */
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

async function createStreamableServer(): Promise<TestServer> {
  const sessions = new Map<string, StreamableHTTPServerTransport>();

  const httpServer = http.createServer(async (req, res) => {
    const sid = req.headers['mcp-session-id'] as string | undefined;
    let transport = sid ? sessions.get(sid) : undefined;

    if (!transport) {
      transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() });
      const mcp = new McpServer({ name: 'test-streamable', version: '0.0.1' });
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
      const closing = [...sessions.values()].map((t) => t.close().catch(() => undefined));
      sessions.clear();
      await Promise.all(closing);
      await destroySockets();
    },
  };
}

async function createSessionIdLessStreamableServer({
  getStatus = 502,
  hangGet = false,
  toolsListErrorBody,
  toolsListErrorStatus = 502,
}: {
  getStatus?: number;
  hangGet?: boolean;
  toolsListErrorBody?: string;
  toolsListErrorStatus?: number;
} = {}): Promise<TestServer> {
  const httpServer = http.createServer(async (req, res) => {
    if (req.method === 'GET') {
      if (hangGet) {
        return;
      }
      res.writeHead(getStatus, { 'Content-Type': 'text/plain' }).end('optional SSE unavailable');
      return;
    }

    if (req.method !== 'POST') {
      res.writeHead(405).end();
      return;
    }

    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const message = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
      id?: string | number;
      method?: string;
      params?: { protocolVersion?: string };
    };

    if (message.method === 'notifications/initialized') {
      res.writeHead(202).end();
      return;
    }

    if (message.method === 'tools/list' && toolsListErrorBody != null) {
      res.writeHead(toolsListErrorStatus, { 'Content-Type': 'text/plain' }).end(toolsListErrorBody);
      return;
    }

    const result = (() => {
      if (message.method === 'initialize') {
        return {
          protocolVersion: message.params?.protocolVersion ?? '2025-03-26',
          capabilities: { tools: {} },
          serverInfo: { name: 'test-sessionless', version: '0.0.1' },
        };
      }
      if (message.method === 'ping') {
        return {};
      }
      return { tools: [SESSION_ID_LESS_TEST_TOOL] };
    })();

    res
      .writeHead(200, { 'Content-Type': 'application/json' })
      .end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
  });

  const destroySockets = trackSockets(httpServer);
  const port = await getFreePort();
  await new Promise<void>((resolve) => httpServer.listen(port, '127.0.0.1', resolve));

  return {
    url: `http://127.0.0.1:${port}/`,
    close: destroySockets,
  };
}

async function createSSEServer(): Promise<TestServer> {
  const transports = new Map<string, SSEServerTransport>();
  const mcpServer = new McpServerCore({ name: 'test-sse', version: '0.0.1' }, { capabilities: {} });

  const httpServer = http.createServer(async (req, res) => {
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
  const port = await getFreePort();
  await new Promise<void>((resolve) => httpServer.listen(port, '127.0.0.1', resolve));

  return {
    url: `http://127.0.0.1:${port}/sse`,
    close: async () => {
      const closing = [...transports.values()].map((t) => t.close().catch(() => undefined));
      transports.clear();
      await Promise.all(closing);
      await destroySockets();
    },
  };
}

describe('MCPConnection Agent lifecycle – streamable-http', () => {
  let server: TestServer;
  let conn: MCPConnection | null;
  let closeSpy: jest.SpyInstance;

  beforeEach(async () => {
    server = await createStreamableServer();
    conn = null;
    closeSpy = jest.spyOn(Agent.prototype, 'close');
  });

  afterEach(async () => {
    MCPConnection.clearCooldown('test');
    await safeDisconnect(conn);
    conn = null;
    jest.restoreAllMocks();
    await server.close();
  });

  it('reuses the same Agent across multiple requests instead of creating one per request', async () => {
    conn = new MCPConnection({
      serverName: 'test',
      serverConfig: { type: 'streamable-http', url: server.url },
      useSSRFProtection: false,
    });

    await conn.connect();

    await conn.fetchTools();
    await conn.fetchTools();
    await conn.fetchTools();

    await safeDisconnect(conn);

    /**
     * streamable-http creates two Agents via createFetchFunction: one for POST
     * (normal timeout) and one for GET SSE (long body timeout).
     * If agents were per-request (old bug), they would not be stored and close
     * would be called 0 times. With our fix, Agents are stored and closed on
     * disconnect regardless of request count — confirming reuse.
     */
    const closeCount = closeSpy.mock.calls.length;
    expect(closeCount).toBeGreaterThanOrEqual(1);
    expect(closeCount).not.toBe(3);

    conn = null;
  });

  it('calls Agent.close() on every registered Agent when disconnect() is called', async () => {
    conn = new MCPConnection({
      serverName: 'test',
      serverConfig: { type: 'streamable-http', url: server.url },
      useSSRFProtection: false,
    });

    await conn.connect();
    expect(closeSpy).not.toHaveBeenCalled();

    await safeDisconnect(conn);
    expect(closeSpy).toHaveBeenCalled();
    conn = null;
  });

  it('does not call Agent.close() before disconnect()', async () => {
    conn = new MCPConnection({
      serverName: 'test',
      serverConfig: { type: 'streamable-http', url: server.url },
      useSSRFProtection: false,
    });

    await conn.connect();
    expect(closeSpy).not.toHaveBeenCalled();
  });

  it('closes prior Agents on the connectClient() teardown path', async () => {
    conn = new MCPConnection({
      serverName: 'test',
      serverConfig: { type: 'streamable-http', url: server.url },
      useSSRFProtection: false,
    });

    await conn.connect();
    expect(closeSpy).not.toHaveBeenCalled();

    (conn as unknown as { connectionState: string }).connectionState = 'disconnected';
    await conn.connectClient();

    expect(closeSpy.mock.calls.length).toBeGreaterThan(0);
  });

  it('does not double-close Agents when disconnect() is called twice', async () => {
    conn = new MCPConnection({
      serverName: 'test',
      serverConfig: { type: 'streamable-http', url: server.url },
      useSSRFProtection: false,
    });

    await conn.connect();
    await safeDisconnect(conn);

    const countAfterFirst = closeSpy.mock.calls.length;
    expect(countAfterFirst).toBeGreaterThan(0);

    await safeDisconnect(conn);
    expect(closeSpy.mock.calls.length).toBe(countAfterFirst);
    conn = null;
  });

  it('creates separate Agents for POST (normal timeout) and GET SSE (default sseReadTimeout)', async () => {
    conn = new MCPConnection({
      serverName: 'test',
      serverConfig: { type: 'streamable-http', url: server.url },
      useSSRFProtection: false,
    });

    await conn.connect();

    const agents = (conn as unknown as { agents: Agent[] }).agents;
    expect(agents.length).toBeGreaterThanOrEqual(2);

    const optionsSym = Object.getOwnPropertySymbols(agents[0]).find(
      (s) => s.toString() === 'Symbol(options)',
    );
    expect(optionsSym).toBeDefined();

    const bodyTimeouts = agents.map(
      (a) => (a as unknown as Record<symbol, { bodyTimeout: number }>)[optionsSym!].bodyTimeout,
    );

    const hasShortTimeout = bodyTimeouts.some((t) => t <= 120_000);
    const hasLongTimeout = bodyTimeouts.some((t) => t === 5 * 60 * 1000);

    expect(hasShortTimeout).toBe(true);
    expect(hasLongTimeout).toBe(true);
  });

  it('respects a custom sseReadTimeout from server config', async () => {
    const customTimeout = 10 * 60 * 1000;
    conn = new MCPConnection({
      serverName: 'test',
      serverConfig: { type: 'streamable-http', url: server.url, sseReadTimeout: customTimeout },
      useSSRFProtection: false,
    });

    await conn.connect();

    const agents = (conn as unknown as { agents: Agent[] }).agents;
    const optionsSym = Object.getOwnPropertySymbols(agents[0]).find(
      (s) => s.toString() === 'Symbol(options)',
    );
    expect(optionsSym).toBeDefined();

    const bodyTimeouts = agents.map(
      (a) => (a as unknown as Record<symbol, { bodyTimeout: number }>)[optionsSym!].bodyTimeout,
    );

    expect(bodyTimeouts).toContain(customTimeout);
  });
});

describe('MCPConnection Agent lifecycle – SSE', () => {
  let server: TestServer;
  let conn: MCPConnection | null;
  let closeSpy: jest.SpyInstance;

  beforeEach(async () => {
    server = await createSSEServer();
    conn = null;
    closeSpy = jest.spyOn(Agent.prototype, 'close');
  });

  afterEach(async () => {
    MCPConnection.clearCooldown('test-sse');
    await safeDisconnect(conn);
    conn = null;
    jest.restoreAllMocks();
    await server.close();
  });

  it('reuses the same Agents across multiple requests instead of creating one per request', async () => {
    conn = new MCPConnection({
      serverName: 'test-sse',
      serverConfig: { url: server.url, type: 'sse' },
      useSSRFProtection: false,
    });

    await conn.connect();

    await conn.fetchTools();
    await conn.fetchTools();
    await conn.fetchTools();

    await safeDisconnect(conn);

    /**
     * SSE creates two Agents: sseAgent (eventSourceInit) + createFetchFunction agent.
     * Close count must be at least 2 regardless of how many POST requests were made.
     * If agents were per-request (old bug), they would not be stored and close
     * would be called 0 times.
     */
    expect(closeSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
    conn = null;
  });

  it('calls Agent.close() on every registered Agent when disconnect() is called', async () => {
    conn = new MCPConnection({
      serverName: 'test-sse',
      serverConfig: { url: server.url, type: 'sse' },
      useSSRFProtection: false,
    });

    await conn.connect();
    expect(closeSpy).not.toHaveBeenCalled();

    await safeDisconnect(conn);
    expect(closeSpy).toHaveBeenCalled();
    conn = null;
  });

  it('closes at least two Agents for SSE transport (eventSourceInit + fetch)', async () => {
    conn = new MCPConnection({
      serverName: 'test-sse',
      serverConfig: { url: server.url, type: 'sse' },
      useSSRFProtection: false,
    });

    await conn.connect();
    await safeDisconnect(conn);

    expect(closeSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
    conn = null;
  });

  it('does not double-close Agents when disconnect() is called twice', async () => {
    conn = new MCPConnection({
      serverName: 'test-sse',
      serverConfig: { url: server.url, type: 'sse' },
      useSSRFProtection: false,
    });

    await conn.connect();
    await safeDisconnect(conn);

    const countAfterFirst = closeSpy.mock.calls.length;
    await safeDisconnect(conn);
    expect(closeSpy.mock.calls.length).toBe(countAfterFirst);
    conn = null;
  });
});

describe('Regression: old per-request Agent pattern leaks agents', () => {
  let server: TestServer;
  let conn: MCPConnection | null;

  beforeEach(async () => {
    server = await createStreamableServer();
    conn = null;
  });

  afterEach(async () => {
    MCPConnection.clearCooldown('test-regression');
    await safeDisconnect(conn);
    conn = null;
    jest.restoreAllMocks();
    await server.close();
  });

  it('per-request Agent allocation prevents any agent from being closed on disconnect', async () => {
    conn = new MCPConnection({
      serverName: 'test-regression',
      serverConfig: { type: 'streamable-http', url: server.url },
      useSSRFProtection: false,
    });

    /**
     * Monkey-patch createFetchFunction to replicate the old per-request Agent behavior.
     * In the old code, `new Agent()` was inside the returned closure, so each call to
     * the fetch function allocated a fresh Agent that was never stored or closed.
     */
    const privateSelf = conn as unknown as Record<string, unknown> & { agents: Agent[] };

    const originalMethod = (privateSelf.createFetchFunction as (...a: unknown[]) => unknown).bind(
      conn,
    );

    privateSelf.createFetchFunction = (_getHeaders: unknown, timeout?: number) => {
      const effectiveTimeout = timeout ?? 60000;
      return (input: unknown, init?: unknown) => {
        const agent = new Agent({
          bodyTimeout: effectiveTimeout,
          headersTimeout: effectiveTimeout,
        });
        return undiciFetch(input as string, {
          ...(init as Record<string, unknown>),
          dispatcher: agent,
        });
      };
    };

    const closeSpy = jest.spyOn(Agent.prototype, 'close');

    await conn.connect();
    await conn.fetchTools();
    await conn.fetchTools();
    await conn.fetchTools();

    /**
     * The old pattern: agents is empty because none were stored.
     * disconnecting closes nothing.
     */
    expect(privateSelf.agents.length).toBe(0);

    await safeDisconnect(conn);

    expect(closeSpy).not.toHaveBeenCalled();

    /** Restore the real method so afterEach teardown works cleanly. */
    privateSelf.createFetchFunction = originalMethod;
    conn = null;
  });
});

describe('MCPConnection session-ID-aware SSE failure handling', () => {
  function makeTransportStub(sessionId?: string) {
    return {
      ...(sessionId != null ? { sessionId } : {}),
      onerror: undefined as ((e: Error) => void) | undefined,
      onclose: undefined as (() => void) | undefined,
      onmessage: undefined as ((m: unknown) => void) | undefined,
      start: jest.fn(),
      close: jest.fn(),
      send: jest.fn(),
    };
  }

  function makeConn() {
    return new MCPConnection({
      serverName: 'test-404',
      serverConfig: { url: 'http://127.0.0.1:1/sse', type: 'sse' },
      useSSRFProtection: false,
    });
  }

  function fireSSEError(
    conn: MCPConnection,
    transport: ReturnType<typeof makeTransportStub> | StreamableHTTPClientTransport,
    code = 404,
  ): Error {
    (
      conn as unknown as { setupTransportErrorHandlers: (t: unknown) => void }
    ).setupTransportErrorHandlers(transport);
    const sseError = Object.assign(
      new Error('Streamable HTTP error: Failed to open SSE stream: test failure'),
      { code },
    );
    transport.onerror?.(sseError);
    return sseError;
  }

  beforeEach(() => {
    mockLogger.warn.mockClear();
    mockLogger.error.mockClear();
  });

  it('silently ignores a 404 when no session ID is assigned (backwards-compat probe)', () => {
    const conn = makeConn();
    const transport = makeTransportStub();
    const emitSpy = jest.spyOn(conn, 'emit');

    fireSSEError(conn, transport);

    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('no server-assigned session ID'),
    );
    expect(emitSpy).not.toHaveBeenCalledWith('connectionChange', 'error');
  });

  it('falls through on a 404 when a session ID exists, triggering reconnection', () => {
    const conn = makeConn();
    const transport = makeTransportStub('existing-session-id');
    const emitSpy = jest.spyOn(conn, 'emit');

    fireSSEError(conn, transport);

    expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining('session lost'));
    expect(emitSpy).toHaveBeenCalledWith('connectionChange', 'error');
  });

  it('treats an empty-string sessionId as no assigned session ID', () => {
    const conn = makeConn();
    const transport = makeTransportStub('');
    const emitSpy = jest.spyOn(conn, 'emit');

    fireSSEError(conn, transport);

    expect(emitSpy).not.toHaveBeenCalledWith('connectionChange', 'error');
  });

  it('treats a 406 before a session ID is assigned as an unsupported optional SSE stream', () => {
    const conn = makeConn();
    const transport = makeTransportStub();
    const emitSpy = jest.spyOn(conn, 'emit');

    fireSSEError(conn, transport, 406);

    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('no server-assigned session ID'),
    );
    expect(emitSpy).not.toHaveBeenCalledWith('connectionChange', 'error');
  });

  it('falls through on a 406 when a session ID exists', () => {
    const conn = makeConn();
    const transport = makeTransportStub('existing-session-id');
    const emitSpy = jest.spyOn(conn, 'emit');

    fireSSEError(conn, transport, 406);

    expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining('session lost'));
    expect(emitSpy).toHaveBeenCalledWith('connectionChange', 'error');
  });
  it('does not suppress an OAuth challenge on an optional stream before a session ID is assigned', async () => {
    const conn = makeConn();
    const transport = createStreamableClientTransport();
    conn.emit('connectionChange', 'connected');
    const emitSpy = jest.spyOn(conn, 'emit');

    const oauthError = fireSSEError(conn, transport, 401);

    expect(emitSpy).toHaveBeenCalledWith('oauthError', expect.any(Error));
    expect(emitSpy).not.toHaveBeenCalledWith('connectionChange', 'error');
    expect(await conn.isConnected()).toBe(false);
    expect(conn.getLastConnectionCheckError()).toBe(oauthError);
  });

  it('still reconnects when a 502 SSE failure belongs to an active session ID', () => {
    const conn = makeConn();
    const transport = createStreamableClientTransport('existing-session-id');
    const emitSpy = jest.spyOn(conn, 'emit');

    fireSSEError(conn, transport, 502);

    expect(emitSpy).toHaveBeenCalledWith('connectionChange', 'error');
  });

  it('does not suppress a 502 failure for the legacy SSE transport', () => {
    const conn = makeConn();
    const transport = makeTransportStub();
    const emitSpy = jest.spyOn(conn, 'emit');

    fireSSEError(conn, transport, 502);

    expect(emitSpy).toHaveBeenCalledWith('connectionChange', 'error');
  });

  it('marks an OAuth-challenged connection unusable without blindly reconnecting', async () => {
    const conn = makeConn();
    const transport = makeTransportStub();
    conn.emit('connectionChange', 'connected');
    const emitSpy = jest.spyOn(conn, 'emit');

    const oauthError = fireSSEError(conn, transport, 401);

    expect(emitSpy).toHaveBeenCalledWith('oauthError', expect.any(Error));
    expect(emitSpy).not.toHaveBeenCalledWith('connectionChange', 'error');
    expect(await conn.isConnected()).toBe(false);
    expect(conn.getLastConnectionCheckError()).toBe(oauthError);
  });
});

describe('MCPConnection SSE stream disconnect handling', () => {
  function makeTransportStub() {
    return {
      onerror: undefined as ((e: Error) => void) | undefined,
      onclose: undefined as (() => void) | undefined,
      onmessage: undefined as ((m: unknown) => void) | undefined,
      start: jest.fn(),
      close: jest.fn(),
      send: jest.fn(),
    };
  }

  function makeConn() {
    return new MCPConnection({
      serverName: 'test-sse-disconnect',
      serverConfig: { url: 'http://127.0.0.1:1/sse', type: 'sse' },
      useSSRFProtection: false,
    });
  }

  function makeStreamableConn() {
    return new MCPConnection({
      serverName: 'test-streamable-post-failure',
      serverConfig: { url: 'http://127.0.0.1:1/mcp', type: 'streamable-http' },
      useSSRFProtection: false,
    });
  }

  function bindErrorHandler(
    conn: MCPConnection,
    transport: ReturnType<typeof makeTransportStub> | StreamableHTTPClientTransport,
  ) {
    (
      conn as unknown as { setupTransportErrorHandlers: (t: unknown) => void }
    ).setupTransportErrorHandlers(transport);
  }

  beforeEach(() => {
    mockLogger.debug.mockClear();
    mockLogger.error.mockClear();
  });

  it('suppresses "SSE stream disconnected" errors from escalating to full reconnection', () => {
    const conn = makeConn();
    const transport = makeTransportStub();
    const emitSpy = jest.spyOn(conn, 'emit');
    bindErrorHandler(conn, transport);

    transport.onerror?.(
      new Error('SSE stream disconnected: AbortError: The operation was aborted'),
    );

    expect(mockLogger.debug).toHaveBeenCalledWith(
      expect.stringContaining('SDK SSE stream recovery in progress'),
    );
    expect(emitSpy).not.toHaveBeenCalledWith('connectionChange', 'error');
  });

  it('suppresses "Failed to reconnect SSE stream" errors (SDK still has retries left)', () => {
    const conn = makeConn();
    const transport = makeTransportStub();
    const emitSpy = jest.spyOn(conn, 'emit');
    bindErrorHandler(conn, transport);

    transport.onerror?.(new Error('Failed to reconnect SSE stream: connection refused'));

    expect(mockLogger.debug).toHaveBeenCalledWith(
      expect.stringContaining('SDK SSE stream recovery in progress'),
    );
    expect(emitSpy).not.toHaveBeenCalledWith('connectionChange', 'error');
  });

  it('escalates "Maximum reconnection attempts exceeded" (SDK gave up)', () => {
    const conn = makeConn();
    const transport = makeTransportStub();
    const emitSpy = jest.spyOn(conn, 'emit');
    bindErrorHandler(conn, transport);

    transport.onerror?.(new Error('Maximum reconnection attempts (2) exceeded.'));

    expect(emitSpy).toHaveBeenCalledWith('connectionChange', 'error');
  });

  it('still escalates non-SSE-stream errors (e.g. POST failures)', () => {
    const conn = makeStreamableConn();
    const transport = createStreamableClientTransport();
    const emitSpy = jest.spyOn(conn, 'emit');
    bindErrorHandler(conn, transport);

    transport.onerror?.(new Error('Streamable HTTP error: Error POSTing to endpoint: 500'));

    expect(emitSpy).toHaveBeenCalledWith('connectionChange', 'error');
  });
});

describe('MCPConnection optional session-ID-less SSE GET failures', () => {
  let server: TestServer;
  let conn: MCPConnection | null;

  afterEach(async () => {
    MCPConnection.clearCooldown('test-sessionless-sse');
    await safeDisconnect(conn);
    conn = null;
    jest.restoreAllMocks();
    await server.close();
  });

  beforeEach(() => {
    mockLogger.warn.mockClear();
    mockLogger.error.mockClear();
  });

  it('keeps the POST channel usable when the optional GET returns 502 without a session ID', async () => {
    server = await createSessionIdLessStreamableServer();
    conn = new MCPConnection({
      serverName: 'test-sessionless-sse',
      serverConfig: { type: 'streamable-http', url: server.url },
      useSSRFProtection: false,
    });
    const emitSpy = jest.spyOn(conn, 'emit');

    await conn.connect();
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('no server-assigned session ID'),
    );
    expect(mockLogger.warn).toHaveBeenCalledTimes(1);
    expect(emitSpy).not.toHaveBeenCalledWith('connectionChange', 'error');
    await expect(conn.fetchTools()).resolves.toEqual([SESSION_ID_LESS_TEST_TOOL]);
  });

  it('keeps the POST channel usable when the optional GET times out before response headers', async () => {
    server = await createSessionIdLessStreamableServer({ hangGet: true });
    conn = new MCPConnection({
      serverName: 'test-sessionless-sse',
      serverConfig: { type: 'streamable-http', url: server.url, timeout: 100 },
      useSSRFProtection: false,
    });
    const emitSpy = jest.spyOn(conn, 'emit');

    await conn.connect();
    await new Promise((resolve) => setTimeout(resolve, 1000));

    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('no server-assigned session ID'),
    );
    expect(emitSpy).not.toHaveBeenCalledWith('connectionChange', 'error');
    await expect(conn.fetchTools()).resolves.toEqual([SESSION_ID_LESS_TEST_TOOL]);
  });

  it('does not mistake a POST error body for an optional SSE GET failure', async () => {
    server = await createSessionIdLessStreamableServer({
      getStatus: 405,
      toolsListErrorBody: 'Failed to open SSE stream',
      toolsListErrorStatus: 400,
    });
    conn = new MCPConnection({
      serverName: 'test-sessionless-sse',
      serverConfig: { type: 'streamable-http', url: server.url },
      useSSRFProtection: false,
    });
    const emitSpy = jest.spyOn(conn, 'emit');

    await conn.connect();
    await expect(conn.fetchTools()).resolves.toEqual([]);

    expect(emitSpy).toHaveBeenCalledWith('connectionChange', 'error');
  });
});

describe('MCPConnection SSE GET stream recovery – integration', () => {
  let server: TestServer;
  let conn: MCPConnection | null;

  beforeEach(async () => {
    server = await createStreamableServer();
    conn = null;
  });

  afterEach(async () => {
    MCPConnection.clearCooldown('test-sse-recovery');
    await safeDisconnect(conn);
    conn = null;
    jest.restoreAllMocks();
    await server.close();
  });

  it('survives a GET SSE body timeout without triggering a full transport rebuild', async () => {
    const SHORT_SSE_TIMEOUT = 1500;

    conn = new MCPConnection({
      serverName: 'test-sse-recovery',
      serverConfig: {
        type: 'streamable-http',
        url: server.url,
        sseReadTimeout: SHORT_SSE_TIMEOUT,
      },
      useSSRFProtection: false,
    });

    await conn.connect();

    await conn.fetchTools();

    /**
     * Wait for the GET SSE body timeout to fire. The SDK will see a stream
     * error and call onerror("SSE stream disconnected: …"), then internally
     * schedule a reconnection. Our handler should suppress the escalation.
     */
    await new Promise((resolve) => setTimeout(resolve, SHORT_SSE_TIMEOUT + 1000));

    expect(mockLogger.debug).toHaveBeenCalledWith(
      expect.stringContaining('SDK SSE stream recovery in progress'),
    );
    expect(mockLogger.error).not.toHaveBeenCalledWith(
      expect.stringContaining('Reconnection handler failed'),
      expect.anything(),
    );

    /**
     * The connection should still be functional — POST requests use a
     * separate Agent with the normal timeout and are unaffected.
     */
    const tools = await conn.fetchTools();
    expect(tools).toBeDefined();
  }, 10_000);
});
