/**
 * Integration tests for MCP server reinitialize recovery (issue #12143).
 *
 * Reproduces the bug: when an MCP server is unreachable at startup,
 * inspection fails and the server config is never stored — making the
 * reinitialize button return 404 and blocking all recovery.
 *
 * These tests spin up a real in-process MCP server using the SDK's
 * StreamableHTTPServerTransport and exercise the full
 * MCPServersInitializer → MCPServersRegistry → MCPServerInspector pipeline
 * with real connections — no mocked transports, no mocked inspections.
 *
 * Minimal mocks: only logger, auth/SSRF, cluster, mcpConfig, and DB repo
 * (to avoid MongoDB). Everything else — the inspector, registry, cache,
 * initializer, and MCP connection — runs for real.
 */

import * as net from 'net';
import { Keyv } from 'keyv';
import * as http from 'http';
import { Agent } from 'undici';
import { Types } from 'mongoose';
import { randomUUID } from 'crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { IUser } from '@librechat/data-schemas';
import type { Socket } from 'net';
import type * as t from '~/mcp/types';
import { registryStatusCache } from '~/mcp/registry/cache/RegistryStatusCache';
import { MCPServersInitializer } from '~/mcp/registry/MCPServersInitializer';
import { MCPServerInspector } from '~/mcp/registry/MCPServerInspector';
import { MCPServersRegistry } from '~/mcp/registry/MCPServersRegistry';
import { ConnectionsRepository } from '~/mcp/ConnectionsRepository';
import { MCPInspectionFailedError } from '~/mcp/errors';
import { FlowStateManager } from '~/flow/manager';
import { MCPConnection } from '~/mcp/connection';
import { MCPManager } from '~/mcp/MCPManager';

jest.mock('@librechat/data-schemas', () => ({
  ...jest.requireActual<typeof import('@librechat/data-schemas')>('@librechat/data-schemas'),
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

jest.mock('~/cluster', () => ({
  isLeader: jest.fn().mockResolvedValue(true),
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

jest.mock('~/mcp/registry/db/ServerConfigsDB', () => ({
  ServerConfigsDB: jest.fn().mockImplementation(() => ({
    get: jest.fn().mockResolvedValue(undefined),
    getAll: jest.fn().mockResolvedValue({}),
    add: jest.fn().mockResolvedValue(undefined),
    update: jest.fn().mockResolvedValue(undefined),
    remove: jest.fn().mockResolvedValue(undefined),
    reset: jest.fn().mockResolvedValue(undefined),
  })),
}));

const mockMongoose = {} as typeof import('mongoose');

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

function makeUser(): IUser {
  return {
    _id: new Types.ObjectId(),
    id: new Types.ObjectId().toString(),
    username: 'testuser',
    email: 'test@example.com',
    name: 'Test',
    avatar: '',
    provider: 'email',
    role: 'user',
    emailVerified: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  } as IUser;
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
  port: number;
  close: () => Promise<void>;
}

/**
 * Lets the first inspection run and holds every later one until released, so a test can connect
 * to the first recovery before a second inspection would write.
 */
function holdLaterInspections(): {
  firstStarted: Promise<void>;
  release: () => void;
  calls: () => number;
} {
  const inspect = MCPServerInspector.inspect.bind(MCPServerInspector);
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  let markFirstStarted!: () => void;
  const firstStarted = new Promise<void>((resolve) => {
    markFirstStarted = resolve;
  });
  const spy = jest
    .spyOn(MCPServerInspector, 'inspect')
    .mockImplementation(async (...args: Parameters<typeof MCPServerInspector.inspect>) => {
      if (spy.mock.calls.length === 1) {
        markFirstStarted();
      } else {
        await released;
      }
      return inspect(...args);
    });
  return { firstStarted, release, calls: () => spy.mock.calls.length };
}

interface ReinitOutcome {
  success: boolean;
  /** Tool count from a complete snapshot; `null` when the snapshot was incomplete */
  tools: number | null;
}

async function createMCPServerOnPort(port: number): Promise<TestServer> {
  const sessions = new Map<string, StreamableHTTPServerTransport>();

  const httpServer = http.createServer(async (req, res) => {
    const sid = req.headers['mcp-session-id'] as string | undefined;
    let transport = sid ? sessions.get(sid) : undefined;

    if (!transport) {
      transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() });
      const mcp = new McpServer({ name: 'recovery-test-server', version: '0.0.1' });
      mcp.tool('echo', 'Echo tool for testing', {}, async () => ({
        content: [{ type: 'text', text: 'ok' }],
      }));
      mcp.tool('greet', 'Greeting tool', {}, async () => ({
        content: [{ type: 'text', text: 'hello' }],
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
  await new Promise<void>((resolve) => httpServer.listen(port, '127.0.0.1', resolve));

  return {
    url: `http://127.0.0.1:${port}/`,
    port,
    close: async () => {
      const closing = [...sessions.values()].map((t) => t.close().catch(() => undefined));
      sessions.clear();
      await Promise.all(closing);
      await destroySockets();
    },
  };
}

describe('MCP reinitialize recovery – integration (issue #12143)', () => {
  let server: TestServer | null = null;
  let conn: MCPConnection | null = null;
  let registry: MCPServersRegistry;

  beforeEach(async () => {
    (MCPServersRegistry as unknown as { instance: undefined }).instance = undefined;
    MCPServersRegistry.createInstance(mockMongoose, ['127.0.0.1']);
    registry = MCPServersRegistry.getInstance();
    await registryStatusCache.reset();
    await registry.reset();
    MCPServersInitializer.resetProcessFlag();
  });

  afterEach(async () => {
    await safeDisconnect(conn);
    conn = null;
    // Reset MCPManager if it was created during the test
    try {
      const mgr = MCPManager.getInstance();
      await Promise.all(mgr.appConnections?.disconnectAll() ?? []);
    } catch {
      // Not initialized — nothing to clean up
    }
    (MCPManager as unknown as { instance: null }).instance = null;
    if (server) {
      await server.close();
      server = null;
    }
  });

  it('should store a stub config when the MCP server is unreachable at startup', async () => {
    const deadPort = await getFreePort();
    const configs: t.MCPServers = {
      'speedy-mcp': {
        type: 'streamable-http',
        url: `http://127.0.0.1:${deadPort}/`,
      },
    };

    await MCPServersInitializer.initialize(configs);

    // Before the fix: getServerConfig would return undefined here
    // After the fix: a stub with inspectionFailed=true is stored
    const config = await registry.getServerConfig('speedy-mcp');
    expect(config).toBeDefined();
    expect(config!.inspectionFailed).toBe(true);
    expect(config!.url).toBe(`http://127.0.0.1:${deadPort}/`);
    expect(config!.tools).toBeUndefined();
    expect(config!.capabilities).toBeUndefined();
    expect(config!.toolFunctions).toBeUndefined();
  });

  it('should recover via reinspectServer after the MCP server comes back online', async () => {
    // Phase 1: Server is down at startup
    const deadPort = await getFreePort();
    const configs: t.MCPServers = {
      'speedy-mcp': {
        type: 'streamable-http',
        url: `http://127.0.0.1:${deadPort}/`,
      },
    };

    await MCPServersInitializer.initialize(configs);

    const stubConfig = await registry.getServerConfig('speedy-mcp');
    expect(stubConfig).toBeDefined();
    expect(stubConfig!.inspectionFailed).toBe(true);

    // Phase 2: Start the real server on the same (previously dead) port
    server = await createMCPServerOnPort(deadPort);

    // Phase 3: Reinspect — this is what the reinitialize button triggers
    const result = await registry.reinspectServer('speedy-mcp', 'CACHE');

    // Verify the stub was replaced with a fully inspected config
    expect(result.config.inspectionFailed).toBeUndefined();
    expect(result.config.tools).toContain('echo');
    expect(result.config.tools).toContain('greet');
    expect(result.config.capabilities).toBeDefined();
    expect(result.config.toolFunctions).toBeDefined();

    // Verify the registry now returns the real config
    const realConfig = await registry.getServerConfig('speedy-mcp');
    expect(realConfig).toBeDefined();
    expect(realConfig!.inspectionFailed).toBeUndefined();
    expect(realConfig!.tools).toContain('echo');
  });

  it('should allow a real client connection after reinspection succeeds', async () => {
    // Phase 1: Server is down at startup
    const deadPort = await getFreePort();
    const configs: t.MCPServers = {
      'speedy-mcp': {
        type: 'streamable-http',
        url: `http://127.0.0.1:${deadPort}/`,
      },
    };

    await MCPServersInitializer.initialize(configs);
    expect((await registry.getServerConfig('speedy-mcp'))!.inspectionFailed).toBe(true);

    // Phase 2: Server comes back online on the same port
    server = await createMCPServerOnPort(deadPort);

    // Phase 3: Reinspect
    await registry.reinspectServer('speedy-mcp', 'CACHE');

    // Phase 4: Establish a real client connection
    conn = new MCPConnection({
      serverName: 'speedy-mcp',
      serverConfig: { type: 'streamable-http', url: server.url },
      useSSRFProtection: false,
    });

    await conn.connect();
    const tools = await conn.fetchTools();

    expect(tools).toHaveLength(2);
    expect(tools.map((t) => t.name)).toContain('echo');
    expect(tools.map((t) => t.name)).toContain('greet');
  });

  it('should not attempt connections to stub servers via ConnectionsRepository', async () => {
    const deadPort = await getFreePort();
    await MCPServersInitializer.initialize({
      'stub-srv': { type: 'streamable-http', url: `http://127.0.0.1:${deadPort}/` },
    });
    expect((await registry.getServerConfig('stub-srv'))!.inspectionFailed).toBe(true);

    const repo = new ConnectionsRepository(undefined);
    expect(await repo.has('stub-srv')).toBe(false);
    expect(await repo.get('stub-srv')).toBeNull();

    const all = await repo.getAll();
    expect(all.has('stub-srv')).toBe(false);
  });

  it('addServerStub should clear negative read-through cache entries', async () => {
    // Query a server that doesn't exist — result is negative-cached
    const config1 = await registry.getServerConfig('late-server');
    expect(config1).toBeUndefined();

    // Store a stub (simulating a failed init that runs after the lookup)
    await registry.addServerStub(
      'late-server',
      { type: 'streamable-http', url: 'http://127.0.0.1:9999/' },
      'CACHE',
    );

    // The stub should be found despite the earlier negative cache entry
    const config2 = await registry.getServerConfig('late-server');
    expect(config2).toBeDefined();
    expect(config2!.inspectionFailed).toBe(true);
  });

  it('concurrent reinspectServer calls share one inspection and all recover', async () => {
    const deadPort = await getFreePort();
    await MCPServersInitializer.initialize({
      'race-server': {
        type: 'streamable-http',
        url: `http://127.0.0.1:${deadPort}/`,
      },
    });
    expect((await registry.getServerConfig('race-server'))!.inspectionFailed).toBe(true);

    server = await createMCPServerOnPort(deadPort);
    const inspectSpy = jest.spyOn(MCPServerInspector, 'inspect');

    // Simulate multiple users clicking Reinitialize at the same time.
    const results = await Promise.all(
      Array.from({ length: 5 }, () => registry.reinspectServer('race-server', 'CACHE')),
    );

    expect(inspectSpy).toHaveBeenCalledTimes(1);
    for (const result of results) {
      expect(result.config).toEqual(results[0].config);
    }

    const config = await registry.getServerConfig('race-server');
    expect(config).toEqual(results[0].config);
    expect(config!.inspectionFailed).toBeUndefined();
    expect(config!.tools).toContain('echo');
  });

  it('concurrent reinitMCPServer-equivalent flows all connect with the recovered tools', async () => {
    const deadPort = await getFreePort();
    const serverName = 'concurrent-reinit';
    const configs: t.MCPServers = {
      [serverName]: {
        type: 'streamable-http',
        url: `http://127.0.0.1:${deadPort}/`,
      },
    };

    // Reset MCPManager singleton so createInstance works
    (MCPManager as unknown as { instance: null }).instance = null;

    // Initialize with dead server — this sets up both registry (stub) and MCPManager
    await MCPManager.createInstance(configs);
    const mcpManager = MCPManager.getInstance();

    expect((await registry.getServerConfig(serverName))!.inspectionFailed).toBe(true);

    // Server comes back online
    server = await createMCPServerOnPort(deadPort);

    const flowManager = new FlowStateManager<null>(new Keyv(), { ttl: 60_000 });

    /**
     * Replicate reinitMCPServer logic: recover a failed config → getConnection → tools snapshot.
     * Each call uses a distinct user to simulate concurrent requests from different users.
     */
    async function simulateReinitMCPServer(): Promise<ReinitOutcome> {
      const user = makeUser();
      let config = await registry.getServerConfig(serverName, user.id);
      if (config?.inspectionFailed) {
        config = await registry.recoverServerConfig(serverName, config, user.id);
        if (!config) {
          return { success: false, tools: null };
        }
      }

      const connection = await mcpManager.getConnection({
        serverName,
        user,
        flowManager,
        forceNew: true,
        serverConfig: config,
      });

      const snapshot = await connection.fetchToolsSnapshot();
      return { success: true, tools: snapshot.complete ? snapshot.tools.length : null };
    }

    const results = await Promise.all(Array.from({ length: 5 }, () => simulateReinitMCPServer()));

    // One recovery is written before any flow connects, so no connection is replaced mid-snapshot
    expect(results).toEqual(Array.from({ length: 5 }, () => ({ success: true, tools: 2 })));

    // Final registry state must be fully recovered
    const finalConfig = await registry.getServerConfig(serverName);
    expect(finalConfig).toBeDefined();
    expect(finalConfig!.inspectionFailed).toBeUndefined();
    expect(finalConfig!.tools).toContain('echo');
  });

  it('reports an incomplete tool snapshot when a newer config replaces the held app connection', async () => {
    const deadPort = await getFreePort();
    const serverName = 'replaced-connection';
    (MCPManager as unknown as { instance: null }).instance = null;
    await MCPManager.createInstance({
      [serverName]: { type: 'streamable-http', url: `http://127.0.0.1:${deadPort}/` },
    });
    const mcpManager = MCPManager.getInstance();
    server = await createMCPServerOnPort(deadPort);
    const flowManager = new FlowStateManager<null>(new Keyv(), { ttl: 60_000 });

    const firstUser = makeUser();
    await registry.reinspectServer(serverName, 'CACHE', firstUser.id);
    const held = await mcpManager.getConnection({ serverName, user: firstUser, flowManager });

    // What an admin edit does: store a newer config
    await registry.updateServer(serverName, { type: 'streamable-http', url: server.url }, 'CACHE');
    const replacement = await mcpManager.getConnection({
      serverName,
      user: makeUser(),
      flowManager,
    });
    expect(replacement).not.toBe(held);

    // reinitMCPServer keeps cached tools for an incomplete snapshot; a complete empty one would
    // publish an empty catalog
    await expect(held.fetchToolsSnapshot()).resolves.toMatchObject({ complete: false, tools: [] });
    const current = await replacement.fetchToolsSnapshot();
    expect(current.complete).toBe(true);
    expect(current.tools.map((tool) => tool.name).sort()).toEqual(['echo', 'greet']);
  });

  it('keeps a connection made after recovery current when another request reinspects mid-flight', async () => {
    const serverName = 'mid-flight-reinspection';
    server = await createMCPServerOnPort(await getFreePort());
    (MCPManager as unknown as { instance: null }).instance = null;
    const mcpManager = await MCPManager.createInstance({});
    await registry.addServerStub(serverName, { type: 'streamable-http', url: server.url }, 'CACHE');
    const flowManager = new FlowStateManager<null>(new Keyv(), { ttl: 60_000 });
    const inspections = holdLaterInspections();

    const first = registry.reinspectServer(serverName, 'CACHE');
    await inspections.firstStarted;
    const second = registry.reinspectServer(serverName, 'CACHE');
    const firstResult = await first;
    const recoveredConnection = await mcpManager.getConnection({
      serverName,
      user: makeUser(),
      flowManager,
    });

    inspections.release();
    const secondResult = await second;
    const laterConnection = await mcpManager.getConnection({
      serverName,
      user: makeUser(),
      flowManager,
    });
    const stored = await registry.getServerConfig(serverName);
    const snapshot = await recoveredConnection.fetchToolsSnapshot();

    expect(inspections.calls()).toBe(1);
    expect(secondResult.config).toEqual(firstResult.config);
    expect(stored).toEqual(firstResult.config);
    expect(recoveredConnection.isStale(stored!.updatedAt!)).toBe(false);
    expect(laterConnection).toBe(recoveredConnection);
    expect(snapshot.complete).toBe(true);
    expect(snapshot.tools.map((tool) => tool.name).sort()).toEqual(['echo', 'greet']);
  });

  it('keeps the first recovery when a reinspection under other allowlists finishes later', async () => {
    const serverName = 'allowlist-reinspection';
    (MCPServersRegistry as unknown as { instance: undefined }).instance = undefined;
    registry = MCPServersRegistry.createInstance(
      mockMongoose,
      ['127.0.0.1'],
      undefined,
      async (ctx) => ({
        allowedDomains: ctx?.userId === 'user-b' ? ['127.0.0.1', 'localhost'] : ['127.0.0.1'],
        allowedAddresses: null,
      }),
    );
    server = await createMCPServerOnPort(await getFreePort());
    (MCPManager as unknown as { instance: null }).instance = null;
    const mcpManager = await MCPManager.createInstance({});
    await registry.addServerStub(serverName, { type: 'streamable-http', url: server.url }, 'CACHE');
    const flowManager = new FlowStateManager<null>(new Keyv(), { ttl: 60_000 });
    const inspections = holdLaterInspections();

    const first = registry.reinspectServer(serverName, 'CACHE', 'user-a');
    await inspections.firstStarted;
    const second = registry.reinspectServer(serverName, 'CACHE', 'user-b');
    const firstResult = await first;
    const recoveredConnection = await mcpManager.getConnection({
      serverName,
      user: makeUser(),
      flowManager,
    });

    inspections.release();
    const secondResult = await second;
    const laterConnection = await mcpManager.getConnection({
      serverName,
      user: makeUser(),
      flowManager,
    });
    const snapshot = await recoveredConnection.fetchToolsSnapshot();

    expect(inspections.calls()).toBe(2);
    expect(secondResult.config).toEqual(firstResult.config);
    await expect(registry.getServerConfig(serverName)).resolves.toEqual(firstResult.config);
    expect(laterConnection).toBe(recoveredConnection);
    expect(snapshot.complete).toBe(true);
    expect(snapshot.tools.map((tool) => tool.name).sort()).toEqual(['echo', 'greet']);
  });

  it('connects a request that read the stub before another request recovered the server', async () => {
    const serverName = 'stale-stub-reinspection';
    server = await createMCPServerOnPort(await getFreePort());
    (MCPManager as unknown as { instance: null }).instance = null;
    const mcpManager = await MCPManager.createInstance({});
    await registry.addServerStub(serverName, { type: 'streamable-http', url: server.url }, 'CACHE');
    const flowManager = new FlowStateManager<null>(new Keyv(), { ttl: 60_000 });
    const user = makeUser();

    const staleStub = await registry.getServerConfig(serverName, user.id);
    const { config: recovered } = await registry.reinspectServer(serverName, 'CACHE');
    const inspectSpy = jest.spyOn(MCPServerInspector, 'inspect');
    const serverConfig = await registry.recoverServerConfig(serverName, staleStub!, user.id);
    const connection = await mcpManager.getConnection({
      serverName,
      user,
      flowManager,
      serverConfig,
    });
    const snapshot = await connection.fetchToolsSnapshot();

    expect(staleStub!.inspectionFailed).toBe(true);
    expect(inspectSpy).not.toHaveBeenCalled();
    expect(serverConfig).toEqual(recovered);
    expect(snapshot.complete).toBe(true);
    expect(snapshot.tools.map((tool) => tool.name).sort()).toEqual(['echo', 'greet']);
  });

  it('reinspectServer should throw MCPInspectionFailedError when the server is still unreachable', async () => {
    const deadPort = await getFreePort();
    const configs: t.MCPServers = {
      'still-broken': {
        type: 'streamable-http',
        url: `http://127.0.0.1:${deadPort}/`,
      },
    };

    await MCPServersInitializer.initialize(configs);
    expect((await registry.getServerConfig('still-broken'))!.inspectionFailed).toBe(true);

    // Server is STILL down — reinspection should fail with MCPInspectionFailedError
    await expect(registry.reinspectServer('still-broken', 'CACHE')).rejects.toThrow(
      MCPInspectionFailedError,
    );

    // The stub should remain intact for future retry
    const config = await registry.getServerConfig('still-broken');
    expect(config).toBeDefined();
    expect(config!.inspectionFailed).toBe(true);
  });
});
