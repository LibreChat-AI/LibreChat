/**
 * Integration tests for the `dbSourced` security boundary.
 *
 * These tests spin up real in-process MCP servers using the SDK's
 * StreamableHTTPServerTransport, then exercise the full
 * processMCPEnv → MCPConnection → HTTP request pipeline to verify:
 *
 * 1. DB-sourced servers resolve `{{MCP_API_KEY}}` via customUserVars.
 * 2. DB-sourced servers do NOT leak `${ENV_VAR}` from process.env.
 * 3. DB-sourced servers do NOT resolve `{{LIBRECHAT_USER_*}}` placeholders.
 * 4. DB-sourced servers do NOT resolve `{{LIBRECHAT_BODY_*}}` placeholders.
 * 5. YAML-sourced servers (dbSourced=false) resolve ALL placeholder types.
 * 6. Mixed headers: some placeholders resolve, others are blocked.
 */

import * as net from 'net';
import * as http from 'http';
import { Agent } from 'undici';
import { Types } from 'mongoose';
import { randomUUID } from 'crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { MCPOptions } from 'librechat-data-provider';
import type { IUser } from '@librechat/data-schemas';
import type { Socket } from 'net';
import { applyRequestHeaders, hasCustomUserVars, getMissingCustomUserVars } from '~/mcp/utils';
import { getUserApiKeyVariable } from '~/mcp/registry/binding';
import { MCPConnection } from '~/mcp/connection';
import { processMCPEnv } from '~/utils/env';

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

/** Track all Agents for cleanup */
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

async function safeDisconnect(conn: MCPConnection | null): Promise<void> {
  if (!conn) return;
  (conn as unknown as { shouldStopReconnecting: boolean }).shouldStopReconnecting = true;
  conn.removeAllListeners();
  await conn.disconnect();
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
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      httpServer.close(() => resolve());
    });
}

interface TestServer {
  url: string;
  close: () => Promise<void>;
  /** Returns the most recently captured request headers */
  getLastHeaders: () => Record<string, string>;
}

function createTestUser(overrides: Partial<IUser> = {}): IUser {
  return {
    _id: new Types.ObjectId(),
    id: new Types.ObjectId().toString(),
    username: 'testuser',
    email: 'test@example.com',
    name: 'Test User',
    avatar: 'https://example.com/avatar.png',
    provider: 'email',
    role: 'user',
    createdAt: new Date('2021-01-01'),
    updatedAt: new Date('2021-01-01'),
    emailVerified: true,
    ...overrides,
  } as IUser;
}

/**
 * Creates a Streamable HTTP MCP server that captures incoming request headers.
 * The server registers a dummy tool so `fetchTools()` makes a real request
 * through the transport, allowing us to capture the headers from that request.
 */
async function createHeaderCapturingServer(): Promise<TestServer> {
  const sessions = new Map<string, StreamableHTTPServerTransport>();
  let lastHeaders: Record<string, string> = {};

  const httpServer = http.createServer(async (req, res) => {
    // Capture headers from every POST request (the tool-listing / tool-call requests)
    if (req.method === 'POST') {
      lastHeaders = {};
      for (const [key, value] of Object.entries(req.headers)) {
        if (typeof value === 'string') {
          lastHeaders[key] = value;
        } else if (Array.isArray(value)) {
          lastHeaders[key] = value.join(', ');
        }
      }
    }

    const sid = req.headers['mcp-session-id'] as string | undefined;
    let transport = sid ? sessions.get(sid) : undefined;

    if (!transport) {
      transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() });
      const mcp = new McpServer({ name: 'header-capture-server', version: '0.0.1' });
      mcp.tool('echo', 'Echo tool for testing', {}, async () => ({
        content: [{ type: 'text', text: 'ok' }],
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
    getLastHeaders: () => ({ ...lastHeaders }),
    close: async () => {
      const closing = [...sessions.values()].map((t) => t.close().catch(() => undefined));
      sessions.clear();
      await Promise.all(closing);
      await destroySockets();
    },
  };
}

describe('dbSourced header security – integration', () => {
  let server: TestServer;
  let conn: MCPConnection | null;

  beforeEach(async () => {
    server = await createHeaderCapturingServer();
    conn = null;
    process.env.SECRET_DB_URL = 'mongodb://admin:password@prod-host:27017/secret';
    process.env.INTERNAL_API_KEY = 'internal-key-do-not-leak';
  });

  afterEach(async () => {
    await safeDisconnect(conn);
    conn = null;
    jest.restoreAllMocks();
    await server.close();
    delete process.env.SECRET_DB_URL;
    delete process.env.INTERNAL_API_KEY;
  });

  it('does not send a saved key to a new URL even when old field names are injected', async () => {
    const original: MCPOptions = {
      type: 'streamable-http',
      url: 'https://trusted.example.com/mcp',
      apiKey: { source: 'user', authorization_type: 'bearer' },
    };
    const updated: MCPOptions = { ...original, url: server.url };
    const oldField = getUserApiKeyVariable(original);
    const newField = getUserApiKeyVariable(updated);
    const resolved = processMCPEnv({
      options: {
        ...updated,
        customUserVars: { [newField]: { title: 'API Key', description: 'Per-user key' } },
        headers: {
          Authorization: `Bearer {{${newField}}}`,
          'X-Stolen-Key': `{{${oldField}}}`,
          'X-Legacy-Key': '{{MCP_API_KEY}}',
        },
      },
      dbSourced: true,
      customUserVars: { [oldField]: 'another-users-secret', MCP_API_KEY: 'legacy-secret' },
    });
    conn = new MCPConnection({
      serverName: 'rebound-key',
      serverConfig: resolved,
      useSSRFProtection: false,
    });
    if ('headers' in resolved) {
      conn.setRequestHeaders(resolved.headers || {});
    }
    await conn.connect();
    await conn.fetchTools();
    const captured = JSON.stringify(server.getLastHeaders());
    expect(captured).not.toContain('another-users-secret');
    expect(captured).not.toContain('legacy-secret');
  });

  it('does not require or send a bound key shadowed by request authentication', async () => {
    const options: MCPOptions = {
      type: 'streamable-http',
      url: server.url,
      apiKey: { source: 'user', authorization_type: 'bearer' },
    };
    const field = getUserApiKeyVariable(options);
    const declared: MCPOptions = {
      ...options,
      customUserVars: { [field]: { title: 'API Key', description: 'Per-user key' } },
      headers: { Authorization: `Bearer {{${field}}}` },
      requestHeaders: { authorization: 'Bearer request-secret' },
    };
    expect(hasCustomUserVars(declared)).toBe(false);
    expect(getMissingCustomUserVars(declared)).toEqual([]);
    const resolved = processMCPEnv({
      options: applyRequestHeaders(declared),
      dbSourced: true,
      customUserVars: { [field]: 'unused-user-secret' },
    });
    conn = new MCPConnection({
      serverName: 'shadowed-bound-key',
      serverConfig: resolved,
      useSSRFProtection: false,
    });
    if ('headers' in resolved) {
      conn.setRequestHeaders(resolved.headers || {});
    }
    await conn.connect();
    await conn.fetchTools();
    const captured = server.getLastHeaders();
    expect(captured.authorization).toBe('Bearer request-secret');
    expect(JSON.stringify(captured)).not.toContain('unused-user-secret');
  });

  it('sends the saved bound key after a fragment-only URL edit', async () => {
    const original: MCPOptions = {
      type: 'streamable-http',
      url: `${server.url}#old`,
      apiKey: { source: 'user', authorization_type: 'bearer' },
    };
    const field = getUserApiKeyVariable(original);
    const updated: MCPOptions = { ...original, url: `${server.url}#new` };
    expect(getUserApiKeyVariable(updated)).toBe(field);
    const resolved = processMCPEnv({
      options: {
        ...updated,
        customUserVars: { [field]: { title: 'API Key', description: 'Per-user key' } },
        headers: { Authorization: `Bearer {{${field}}}` },
      },
      dbSourced: true,
      customUserVars: { [field]: 'saved-user-secret' },
    });
    conn = new MCPConnection({
      serverName: 'fragment-bound-key',
      serverConfig: resolved,
      useSSRFProtection: false,
    });
    if ('headers' in resolved) {
      conn.setRequestHeaders(resolved.headers || {});
    }
    await conn.connect();
    await conn.fetchTools();
    expect(server.getLastHeaders().authorization).toBe('Bearer saved-user-secret');
  });

  it('DB-sourced: resolves {{MCP_API_KEY}} via customUserVars', async () => {
    const options: MCPOptions = {
      type: 'streamable-http',
      url: server.url,
      customUserVars: { MCP_API_KEY: { title: 'API Key', description: 'Per-user key' } },
      headers: {
        Authorization: 'Bearer {{MCP_API_KEY}}',
      },
    };

    const resolved = processMCPEnv({
      options,
      dbSourced: true,
      customUserVars: { MCP_API_KEY: 'user-provided-secret' },
    });

    conn = new MCPConnection({
      serverName: 'db-test',
      serverConfig: resolved,
      useSSRFProtection: false,
    });

    if ('headers' in resolved) {
      conn.setRequestHeaders(resolved.headers || {});
    }

    await conn.connect();
    await conn.fetchTools();

    const captured = server.getLastHeaders();
    expect(captured['authorization']).toBe('Bearer user-provided-secret');
  });

  it('DB-sourced: does NOT resolve ${ENV_VAR} — literal placeholder sent as header', async () => {
    const options: MCPOptions = {
      type: 'streamable-http',
      url: server.url,
      headers: {
        'X-Leaked-DB': '${SECRET_DB_URL}',
        'X-Leaked-Key': '${INTERNAL_API_KEY}',
      },
    };

    const resolved = processMCPEnv({ options, dbSourced: true });

    conn = new MCPConnection({
      serverName: 'db-test',
      serverConfig: resolved,
      useSSRFProtection: false,
    });

    if ('headers' in resolved) {
      conn.setRequestHeaders(resolved.headers || {});
    }

    await conn.connect();
    await conn.fetchTools();

    const captured = server.getLastHeaders();
    // The literal placeholders must be sent, NOT the env values
    expect(captured['x-leaked-db']).toBe('${SECRET_DB_URL}');
    expect(captured['x-leaked-key']).toBe('${INTERNAL_API_KEY}');
    // Double-check env vars were NOT injected
    expect(captured['x-leaked-db']).not.toContain('mongodb://');
    expect(captured['x-leaked-key']).not.toBe('internal-key-do-not-leak');
  });

  it('DB-sourced: does NOT resolve {{LIBRECHAT_USER_*}} placeholders', async () => {
    const user = createTestUser({ id: 'user-secret-id', email: 'private@corp.com' });
    const options: MCPOptions = {
      type: 'streamable-http',
      url: server.url,
      headers: {
        'X-User-Id': '{{LIBRECHAT_USER_ID}}',
        'X-User-Email': '{{LIBRECHAT_USER_EMAIL}}',
      },
    };

    const resolved = processMCPEnv({ options, user, dbSourced: true });

    conn = new MCPConnection({
      serverName: 'db-test',
      serverConfig: resolved,
      useSSRFProtection: false,
    });

    if ('headers' in resolved) {
      conn.setRequestHeaders(resolved.headers || {});
    }

    await conn.connect();
    await conn.fetchTools();

    const captured = server.getLastHeaders();
    expect(captured['x-user-id']).toBe('{{LIBRECHAT_USER_ID}}');
    expect(captured['x-user-email']).toBe('{{LIBRECHAT_USER_EMAIL}}');
    expect(captured['x-user-id']).not.toBe('user-secret-id');
  });

  it('DB-sourced: does NOT resolve {{LIBRECHAT_BODY_*}} placeholders', async () => {
    const body = {
      conversationId: 'conv-secret-123',
      parentMessageId: 'parent-456',
      messageId: 'msg-789',
    };
    const options: MCPOptions = {
      type: 'streamable-http',
      url: server.url,
      headers: {
        'X-Conv-Id': '{{LIBRECHAT_BODY_CONVERSATIONID}}',
      },
    };

    const resolved = processMCPEnv({ options, body, dbSourced: true });

    conn = new MCPConnection({
      serverName: 'db-test',
      serverConfig: resolved,
      useSSRFProtection: false,
    });

    if ('headers' in resolved) {
      conn.setRequestHeaders(resolved.headers || {});
    }

    await conn.connect();
    await conn.fetchTools();

    const captured = server.getLastHeaders();
    expect(captured['x-conv-id']).toBe('{{LIBRECHAT_BODY_CONVERSATIONID}}');
    expect(captured['x-conv-id']).not.toBe('conv-secret-123');
  });

  it('DB-sourced: mixed headers — customUserVars resolve, everything else blocked', async () => {
    const user = createTestUser({ id: 'user-id-value' });
    const body = { conversationId: 'conv-id-value', parentMessageId: 'p-1', messageId: 'm-1' };
    const options: MCPOptions = {
      type: 'streamable-http',
      url: server.url,
      customUserVars: { MCP_API_KEY: { title: 'API Key', description: 'Per-user key' } },
      headers: {
        Authorization: 'Bearer {{MCP_API_KEY}}',
        'X-Env-Leak': '${SECRET_DB_URL}',
        'X-User-Id': '{{LIBRECHAT_USER_ID}}',
        'X-Conv-Id': '{{LIBRECHAT_BODY_CONVERSATIONID}}',
        'X-Static': 'plain-value',
      },
    };

    const resolved = processMCPEnv({
      options,
      user,
      body,
      dbSourced: true,
      customUserVars: { MCP_API_KEY: 'my-api-key-value' },
    });

    conn = new MCPConnection({
      serverName: 'db-test',
      serverConfig: resolved,
      useSSRFProtection: false,
    });

    if ('headers' in resolved) {
      conn.setRequestHeaders(resolved.headers || {});
    }

    await conn.connect();
    await conn.fetchTools();

    const captured = server.getLastHeaders();
    // customUserVars resolved
    expect(captured['authorization']).toBe('Bearer my-api-key-value');
    // env var blocked
    expect(captured['x-env-leak']).toBe('${SECRET_DB_URL}');
    // user placeholder blocked
    expect(captured['x-user-id']).toBe('{{LIBRECHAT_USER_ID}}');
    // body placeholder blocked
    expect(captured['x-conv-id']).toBe('{{LIBRECHAT_BODY_CONVERSATIONID}}');
    // static value unchanged
    expect(captured['x-static']).toBe('plain-value');
  });

  it('YAML-sourced (default): resolves ALL placeholder types', async () => {
    const user = createTestUser({ id: 'yaml-user-id', email: 'yaml@example.com' });
    const body = { conversationId: 'yaml-conv-id', parentMessageId: 'p-1', messageId: 'm-1' };
    const options: MCPOptions = {
      type: 'streamable-http',
      url: server.url,
      headers: {
        Authorization: 'Bearer {{MY_CUSTOM_KEY}}',
        'X-Env': '${INTERNAL_API_KEY}',
        'X-User-Id': '{{LIBRECHAT_USER_ID}}',
        'X-Conv-Id': '{{LIBRECHAT_BODY_CONVERSATIONID}}',
      },
    };

    const resolved = processMCPEnv({
      options,
      user,
      body,
      dbSourced: false,
      customUserVars: { MY_CUSTOM_KEY: 'yaml-custom-val' },
    });

    conn = new MCPConnection({
      serverName: 'yaml-test',
      serverConfig: resolved,
      useSSRFProtection: false,
    });

    if ('headers' in resolved) {
      conn.setRequestHeaders(resolved.headers || {});
    }

    await conn.connect();
    await conn.fetchTools();

    const captured = server.getLastHeaders();
    // All placeholder types resolved
    expect(captured['authorization']).toBe('Bearer yaml-custom-val');
    expect(captured['x-env']).toBe('internal-key-do-not-leak');
    expect(captured['x-user-id']).toBe('yaml-user-id');
    expect(captured['x-conv-id']).toBe('yaml-conv-id');
  });

  it('DB-sourced: URL placeholder ${ENV_VAR} is NOT resolved', () => {
    const options: MCPOptions = {
      type: 'streamable-http',
      url: '${SECRET_DB_URL}/mcp',
      headers: {},
    };

    const resolved = processMCPEnv({ options, dbSourced: true });
    expect((resolved as { url?: string }).url).toBe('${SECRET_DB_URL}/mcp');
  });

  it('YAML-sourced: URL placeholder ${ENV_VAR} IS resolved', () => {
    const options: MCPOptions = {
      type: 'streamable-http',
      url: '${INTERNAL_API_KEY}/endpoint',
      headers: {},
    };

    const resolved = processMCPEnv({ options, dbSourced: false });
    expect((resolved as { url?: string }).url).toBe('internal-key-do-not-leak/endpoint');
  });

  it('DB-sourced: multiple customUserVars resolve correctly', async () => {
    const options: MCPOptions = {
      type: 'streamable-http',
      url: server.url,
      customUserVars: {
        API_TOKEN: { title: 'Token', description: 'Per-user token' },
        WORKSPACE_ID: { title: 'Workspace', description: 'Per-user workspace' },
        REGION: { title: 'Region', description: 'Per-user region' },
      },
      headers: {
        Authorization: 'Bearer {{API_TOKEN}}',
        'X-Workspace': '{{WORKSPACE_ID}}',
        'X-Region': '{{REGION}}',
      },
    };

    const resolved = processMCPEnv({
      options,
      dbSourced: true,
      customUserVars: {
        API_TOKEN: 'tok-abc123',
        WORKSPACE_ID: 'ws-def456',
        REGION: 'us-east-1',
      },
    });

    conn = new MCPConnection({
      serverName: 'db-multi-var',
      serverConfig: resolved,
      useSSRFProtection: false,
    });

    if ('headers' in resolved) {
      conn.setRequestHeaders(resolved.headers || {});
    }

    await conn.connect();
    await conn.fetchTools();

    const captured = server.getLastHeaders();
    expect(captured['authorization']).toBe('Bearer tok-abc123');
    expect(captured['x-workspace']).toBe('ws-def456');
    expect(captured['x-region']).toBe('us-east-1');
  });

  it('DB-sourced: absent customUserVars leaves placeholder unresolved', async () => {
    const options: MCPOptions = {
      type: 'streamable-http',
      url: server.url,
      customUserVars: { MCP_API_KEY: { title: 'API Key', description: 'Per-user key' } },
      headers: {
        Authorization: 'Bearer {{MCP_API_KEY}}',
      },
    };

    // No customUserVars provided at all
    const resolved = processMCPEnv({ options, dbSourced: true });

    conn = new MCPConnection({
      serverName: 'db-no-vars',
      serverConfig: resolved,
      useSSRFProtection: false,
    });

    if ('headers' in resolved) {
      conn.setRequestHeaders(resolved.headers || {});
    }

    await conn.connect();
    await conn.fetchTools();

    const captured = server.getLastHeaders();
    expect(captured['authorization']).toBe('Bearer {{MCP_API_KEY}}');
  });
});
