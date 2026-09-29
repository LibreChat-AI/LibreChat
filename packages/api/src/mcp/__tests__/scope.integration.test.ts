import { z } from 'zod';
import * as http from 'http';
import { Agent } from 'undici';
import { randomUUID } from 'crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { IUser } from '@librechat/data-schemas';
import type { Socket } from 'net';
import type { ParsedServerConfig, RequestScopedMCPConnectionStore } from '~/mcp/types';
import type { FlowStateManager } from '~/flow/manager';
import type { MCPRequestContext } from '~/mcp/request';
import type { MCPOAuthTokens } from '~/mcp/oauth';
import { createMCPRequestContext, cleanupMCPRequestContext } from '~/mcp/request';
import { MCPServersRegistry } from '~/mcp/registry/MCPServersRegistry';
import { getFreePort } from '~/mcp/__tests__/helpers/oauthTestServer';
import { ConnectionsRepository } from '~/mcp/ConnectionsRepository';
import { MCPConnection } from '~/mcp/connection';
import { MCPManager } from '~/mcp/MCPManager';

jest.mock('@librechat/data-schemas', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
  getTenantId: jest.fn(() => undefined),
  tenantStorage: {
    getStore: jest.fn(() => undefined),
    run: jest.fn((_context: object, fn: () => unknown) => fn()),
  },
}));

jest.mock('~/auth', () => ({
  createSSRFSafeUndiciConnect: jest.fn(() => undefined),
  isOAuthUrlAllowed: jest.fn(() => false),
  isSSRFTarget: jest.fn(() => false),
  resolveHostnameSSRF: jest.fn(async () => false),
}));

jest.mock('~/auth/domain', () => ({
  isMCPDomainAllowed: jest.fn(async () => true),
}));

interface RequestScopedTestServer {
  url: string;
  brokenUrl: string;
  close: () => Promise<void>;
  deleteCount: () => number;
  liveSessionCount: () => number;
  sessionsCreated: () => number;
  toolCallCount: () => number;
  observedRunIds: () => string[];
  observedParentMessageIds: () => string[];
  observedHeaders: () => Record<string, string>[];
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

async function createRequestScopedTestServer(): Promise<RequestScopedTestServer> {
  const sessions = new Map<string, StreamableHTTPServerTransport>();
  const runIds: string[] = [];
  const parentMessageIds: string[] = [];
  const postHeaders: Record<string, string>[] = [];
  let created = 0;
  let deletes = 0;
  let toolCalls = 0;

  const httpServer = http.createServer(async (req, res) => {
    if (req.url === '/broken') {
      res.writeHead(500).end('broken MCP');
      return;
    }

    if (req.method === 'POST') {
      postHeaders.push(
        Object.fromEntries(
          Object.entries(req.headers).map(([key, value]) => [
            key,
            Array.isArray(value) ? value.join(',') : (value ?? ''),
          ]),
        ),
      );
      const runId = req.headers['x-run-id'];
      if (typeof runId === 'string') {
        runIds.push(runId);
      }
      const parentMessageId = req.headers['x-parent-message'];
      if (typeof parentMessageId === 'string') {
        parentMessageIds.push(parentMessageId);
      }
    } else if (req.method === 'DELETE') {
      deletes += 1;
    }

    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    let transport = sessionId ? sessions.get(sessionId) : undefined;
    const isNewTransport = !transport;

    if (!transport) {
      transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() });
      const mcp = new McpServer({ name: 'request-scoped-test', version: '0.0.1' });
      mcp.tool('echo', 'Echo a value', { value: z.string() }, async ({ value }) => {
        toolCalls += 1;
        return { content: [{ type: 'text', text: value }] };
      });
      await mcp.connect(transport);
    }

    await transport.handleRequest(req, res);

    if (isNewTransport && transport.sessionId) {
      created += 1;
      const registeredId = transport.sessionId;
      sessions.set(registeredId, transport);
      transport.onclose = () => sessions.delete(registeredId);
    }
  });

  const destroySockets = trackSockets(httpServer);
  const port = await getFreePort();
  await new Promise<void>((resolve) => httpServer.listen(port, '127.0.0.1', resolve));

  return {
    url: `http://127.0.0.1:${port}/mcp`,
    brokenUrl: `http://127.0.0.1:${port}/broken`,
    deleteCount: () => deletes,
    liveSessionCount: () => sessions.size,
    sessionsCreated: () => created,
    toolCallCount: () => toolCalls,
    observedRunIds: () => [...runIds],
    observedParentMessageIds: () => [...parentMessageIds],
    observedHeaders: () => postHeaders.map((headers) => ({ ...headers })),
    close: async () => {
      const closing = [...sessions.values()].map((transport) =>
        transport.close().catch(() => undefined),
      );
      sessions.clear();
      await Promise.all(closing);
      await destroySockets();
    },
  };
}

const user = { id: 'scale-user', role: 'USER' } as unknown as IUser;
const flowManager = {} as FlowStateManager<MCPOAuthTokens | null>;

function createManager(): MCPManager {
  const manager = new MCPManager();
  manager.appConnections = {
    has: jest.fn(async () => false),
    getConnectionCount: jest.fn(() => 0),
  } as unknown as ConnectionsRepository;
  return manager;
}

function createServerConfig(url: string): ParsedServerConfig {
  return {
    type: 'streamable-http',
    url,
    source: 'yaml',
    requiresOAuth: false,
    initTimeout: 500,
    headers: {
      'X-Run-Id': '{{LIBRECHAT_BODY_MESSAGEID}}',
      'X-Parent-Message': '{{LIBRECHAT_BODY_PARENTMESSAGEID}}',
    },
  };
}

function callEcho({
  manager,
  config,
  requestScopedConnections,
  runId,
  value,
  serverName = 'request-scoped',
}: {
  manager: MCPManager;
  config: ParsedServerConfig;
  requestScopedConnections: RequestScopedMCPConnectionStore;
  runId: string;
  value: string;
  serverName?: string;
}) {
  return manager.callTool({
    user,
    serverName,
    serverConfig: config,
    toolName: 'echo',
    provider: 'openai',
    toolArguments: { value },
    requestBody: {
      conversationId: 'conversation-1',
      parentMessageId: 'parent-1',
      messageId: runId,
    },
    requestScopedConnections,
    flowManager,
  });
}

describe('request-scoped MCP lifecycle integration', () => {
  let server: RequestScopedTestServer;
  let manager: MCPManager;
  const contexts = new Set<MCPRequestContext>();

  beforeEach(async () => {
    server = await createRequestScopedTestServer();
    manager = createManager();
    jest.spyOn(MCPServersRegistry, 'getInstance').mockReturnValue({
      resolveAllowlists: jest.fn(async () => ({
        allowedDomains: null,
        allowedAddresses: null,
        useSSRFProtection: false,
      })),
    } as unknown as MCPServersRegistry);
  });

  afterEach(async () => {
    await Promise.all([...contexts].map((context) => cleanupMCPRequestContext(context)));
    contexts.clear();
    MCPConnection.clearCooldown('request-scoped');
    MCPConnection.clearCooldown('broken-request-scoped');
    jest.restoreAllMocks();
    await server.close();
  });

  function createContext(): MCPRequestContext {
    const context = createMCPRequestContext();
    contexts.add(context);
    return context;
  }

  it('coalesces a concurrent burst, tears down the run, and isolates the next run', async () => {
    const config = createServerConfig(server.url);
    const firstRun = createContext();
    const burstSize = 20;

    await Promise.all(
      Array.from({ length: burstSize }, (_, index) =>
        callEcho({
          manager,
          config,
          requestScopedConnections: firstRun,
          runId: 'run-1',
          value: `value-${index}`,
        }),
      ),
    );

    expect(server.sessionsCreated()).toBe(1);
    expect(server.liveSessionCount()).toBe(1);
    expect(server.toolCallCount()).toBe(burstSize);
    expect(new Set(server.observedRunIds())).toEqual(new Set(['run-1']));
    expect(new Set(server.observedParentMessageIds())).toEqual(new Set(['parent-1']));
    expect(manager.getConnectionStats().activityEntries).toBe(0);

    await cleanupMCPRequestContext(firstRun);
    contexts.delete(firstRun);

    expect(server.deleteCount()).toBe(1);
    expect(server.liveSessionCount()).toBe(0);

    const secondRun = createContext();
    await callEcho({
      manager,
      config,
      requestScopedConnections: secondRun,
      runId: 'run-2',
      value: 'second-run',
    });

    expect(server.sessionsCreated()).toBe(2);
    expect(server.liveSessionCount()).toBe(1);
    expect(new Set(server.observedRunIds())).toEqual(new Set(['run-1', 'run-2']));
    expect(new Set(server.observedParentMessageIds())).toEqual(new Set(['parent-1']));
  });

  it('clears a failed run so the same server can recover in a fresh run', async () => {
    const brokenRun = createContext();
    const destroyAgent = jest.spyOn(Agent.prototype, 'destroy');

    await expect(
      callEcho({
        manager,
        config: createServerConfig(server.brokenUrl),
        requestScopedConnections: brokenRun,
        runId: 'broken-run',
        value: 'unreachable',
        serverName: 'broken-request-scoped',
      }),
    ).rejects.toThrow();

    expect(brokenRun.connections.size).toBe(0);
    expect(brokenRun.pending.size).toBe(0);
    expect(manager.getConnectionStats().activityEntries).toBe(0);
    expect(destroyAgent).toHaveBeenCalled();

    const recoveryRun = createContext();
    await expect(
      callEcho({
        manager,
        config: createServerConfig(server.url),
        requestScopedConnections: recoveryRun,
        runId: 'recovery-run',
        value: 'recovered',
        serverName: 'broken-request-scoped',
      }),
    ).resolves.toBeDefined();

    expect(server.sessionsCreated()).toBe(1);
    expect(server.toolCallCount()).toBe(1);
    expect(new Set(server.observedRunIds())).toEqual(new Set(['recovery-run']));
  });
});

describe('operator requestHeaders integration', () => {
  const serverName = 'request-headers';
  let server: RequestScopedTestServer;
  let manager: MCPManager;
  const contexts = new Set<MCPRequestContext>();

  /**
   * `X-Conversation-Id` is declared in BOTH maps so precedence is observable,
   * and `X-Trace-Id` only in the chat-only map so its absence proves discovery
   * never sent it.
   */
  function createRequestHeadersConfig(url: string): ParsedServerConfig {
    return {
      type: 'streamable-http',
      url,
      source: 'yaml',
      requiresOAuth: false,
      initTimeout: 500,
      headers: {
        'X-Workspace': 'workspace-1',
        'X-Conversation-Id': 'from-headers',
      },
      requestHeaders: {
        'X-Conversation-Id': '{{LIBRECHAT_BODY_CONVERSATIONID}}',
        'X-Trace-Id': '{{LIBRECHAT_BODY_MESSAGEID}}',
      },
    } as ParsedServerConfig;
  }

  beforeEach(async () => {
    server = await createRequestScopedTestServer();
    manager = createManager();
    jest.spyOn(MCPServersRegistry, 'getInstance').mockReturnValue({
      resolveAllowlists: jest.fn(async () => ({
        allowedDomains: null,
        allowedAddresses: null,
        useSSRFProtection: false,
      })),
      getServerConfig: jest.fn(async () => createRequestHeadersConfig(server.url)),
      isAppServerConfig: jest.fn(async () => false),
    } as unknown as MCPServersRegistry);
  });

  afterEach(async () => {
    await Promise.all([...contexts].map((context) => cleanupMCPRequestContext(context)));
    contexts.clear();
    MCPConnection.clearCooldown(serverName);
    jest.restoreAllMocks();
    await server.close();
  });

  function createContext(): MCPRequestContext {
    const context = createMCPRequestContext();
    contexts.add(context);
    return context;
  }

  function callEchoWithBody({
    requestScopedConnections,
    requestBody,
    value,
  }: {
    requestScopedConnections: RequestScopedMCPConnectionStore;
    requestBody: Record<string, string>;
    value: string;
  }) {
    return manager.callTool({
      user,
      serverName,
      serverConfig: createRequestHeadersConfig(server.url),
      toolName: 'echo',
      provider: 'openai',
      toolArguments: { value },
      requestBody,
      requestScopedConnections,
      flowManager,
    });
  }

  function conversationIdsSeen(): Set<string> {
    return new Set(
      server
        .observedHeaders()
        .map((headers) => headers['x-conversation-id'])
        .filter((value): value is string => value != null),
    );
  }

  it('populates the tool catalog and disposes the discovery connection', async () => {
    const result = await manager.discoverServerTools({
      serverName,
      user,
      configServers: { [serverName]: createRequestHeadersConfig(server.url) },
    });

    expect(result.tools?.map((tool) => tool.name)).toContain('echo');
    expect(result.oauthRequired).toBe(false);
    expect(server.deleteCount()).toBe(1);
    expect(server.liveSessionCount()).toBe(0);
  });

  it('sends the regular headers but not the chat-only ones during discovery', async () => {
    await manager.discoverServerTools({
      serverName,
      user,
      configServers: { [serverName]: createRequestHeadersConfig(server.url) },
    });

    const observed = server.observedHeaders();
    expect(observed.length).toBeGreaterThan(0);
    for (const headers of observed) {
      expect(headers['x-workspace']).toBe('workspace-1');
      expect(headers['x-conversation-id']).toBe('from-headers');
      expect(headers['x-trace-id']).toBeUndefined();
    }
  });

  it('resolves and merges both maps at chat time, the request map winning', async () => {
    await callEchoWithBody({
      requestScopedConnections: createContext(),
      requestBody: { conversationId: 'conv-1', messageId: 'msg-1' },
      value: 'merged',
    });

    const observed = server.observedHeaders();
    expect(observed.length).toBeGreaterThan(0);
    for (const headers of observed) {
      expect(headers['x-workspace']).toBe('workspace-1');
      expect(headers['x-conversation-id']).toBe('conv-1');
      expect(headers['x-trace-id']).toBe('msg-1');
    }
  });

  it('isolates two request bodies in separate connections with distinct headers', async () => {
    await callEchoWithBody({
      requestScopedConnections: createContext(),
      requestBody: { conversationId: 'conv-1', messageId: 'msg-1' },
      value: 'first',
    });
    await callEchoWithBody({
      requestScopedConnections: createContext(),
      requestBody: { conversationId: 'conv-2', messageId: 'msg-2' },
      value: 'second',
    });

    expect(server.sessionsCreated()).toBe(2);
    expect(conversationIdsSeen()).toEqual(new Set(['conv-1', 'conv-2']));
    expect(server.toolCallCount()).toBe(2);
  });

  it('admits a chat whose request override removes a catalog body requirement', async () => {
    const config = createRequestHeadersConfig(server.url);
    await manager.callTool({
      user,
      serverName,
      toolName: 'echo',
      provider: 'openai',
      toolArguments: { value: 'shadowed' },
      serverConfig: {
        ...config,
        headers: { 'X-Conversation-Id': '{{LIBRECHAT_BODY_CONVERSATIONID}}' },
        requestHeaders: {
          'x-conversation-id': 'fixed',
          'X-Trace-Id': '{{LIBRECHAT_BODY_MESSAGEID}}',
        },
      } as ParsedServerConfig,
      requestBody: { messageId: 'msg-1' },
      requestScopedConnections: createContext(),
      flowManager,
    });
    expect(server.toolCallCount()).toBe(1);
    expect(conversationIdsSeen()).toEqual(new Set(['fixed']));
  });

  it.each([
    {
      mode: 'bearer' as const,
      name: 'Authorization',
      chatName: 'Authorization',
      catalog: 'Bearer catalog-key',
    },
    {
      mode: 'bearer' as const,
      name: 'Authorization',
      chatName: 'authorization',
      catalog: 'Bearer catalog-key',
    },
    {
      mode: 'basic' as const,
      name: 'Authorization',
      chatName: 'AUTHORIZATION',
      catalog: 'Basic catalog-key',
    },
    { mode: 'custom' as const, name: 'X-Api-Key', chatName: 'x-api-key', catalog: 'catalog-key' },
    {
      mode: 'custom' as const,
      name: 'X-Custom-Key',
      chatName: 'x-custom-key',
      catalog: 'catalog-key',
    },
  ])(
    'uses the $mode catalog key only in discovery when chat overrides $chatName',
    async ({ mode, name, chatName, catalog }) => {
      const config: ParsedServerConfig = {
        ...createRequestHeadersConfig(server.url),
        type: 'streamable-http',
        url: server.url,
        apiKey: {
          source: 'admin',
          authorization_type: mode,
          key: 'catalog-key',
          ...(mode === 'custom' && name !== 'X-Api-Key' ? { custom_header: name } : {}),
        },
        requestHeaders: {
          [chatName]: '{{LIBRECHAT_BODY_CONVERSATIONID}}',
        },
      };
      jest.spyOn(MCPServersRegistry.getInstance(), 'getServerConfig').mockResolvedValue(config);
      await manager.discoverServerTools({ serverName, user });
      const discoveryHeaders = server.observedHeaders();
      expect(discoveryHeaders.length).toBeGreaterThan(0);
      expect(discoveryHeaders.every((headers) => headers[name.toLowerCase()] === catalog)).toBe(
        true,
      );
      await manager.callTool({
        user,
        serverName,
        serverConfig: config,
        toolName: 'echo',
        provider: 'openai',
        toolArguments: { value: 'chat-credential' },
        requestBody: { conversationId: 'chat-key' },
        requestScopedConnections: createContext(),
        flowManager,
      });
      const chatHeaders = server.observedHeaders().slice(discoveryHeaders.length);
      expect(chatHeaders.length).toBeGreaterThan(0);
      expect(chatHeaders.every((headers) => headers[name.toLowerCase()] === 'chat-key')).toBe(true);
      expect(server.toolCallCount()).toBe(1);
    },
  );

  it('fails closed when a runtime value the request headers need is missing', async () => {
    await expect(
      callEchoWithBody({
        requestScopedConnections: createContext(),
        requestBody: { conversationId: 'conv-1' },
        value: 'no-message-id',
      }),
    ).rejects.toThrow(/messageId/);

    expect(server.sessionsCreated()).toBe(0);
    expect(server.toolCallCount()).toBe(0);
  });
});
