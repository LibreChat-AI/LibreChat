/** Real-SDK integration coverage for `notifications/tools/list_changed` (#7117). */
import { CacheKeys } from 'librechat-data-provider';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import type { LCAvailableTools } from '../types';
import {
  getMCPAppToolsPublicationGeneration,
  setMCPToolsChangedRevisionHandler,
} from '../toolsChanged';
import { createMCPCatalogStore } from '../catalog/store';
import { MCPConnection } from '../connection';

jest.setTimeout(10_000);

async function waitFor(condition: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) {
      throw new Error('Timed out waiting for the tool-list refresh');
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

interface Barrier {
  entered: Promise<void>;
  release: () => void;
}

interface TestHarness {
  connection: MCPConnection;
  getListCalls: () => number;
  setTools: (tools: Tool[]) => void;
  failNextList: () => void;
  blockNextList: () => Barrier;
  notifyChanged: () => Promise<void>;
  close: () => Promise<void>;
}

const tool = (name: string, description = name): Tool => ({
  name,
  description,
  inputSchema: { type: 'object', properties: {} },
});

async function createHarness(initialTools: Tool[]): Promise<TestHarness> {
  let tools = initialTools;
  let listCalls = 0;
  let shouldFailNextList = false;
  let nextBarrier:
    | {
        entered: Promise<void>;
        resolveEntered: () => void;
        released: Promise<void>;
        release: () => void;
      }
    | undefined;

  const server = new Server(
    { name: 'dynamic-tool-server', version: '1.0.0' },
    { capabilities: { tools: { listChanged: true } } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    listCalls++;
    if (shouldFailNextList) {
      shouldFailNextList = false;
      throw new McpError(ErrorCode.InternalError, 'temporary tools/list failure');
    }

    const snapshot = tools.map((entry) => ({ ...entry }));
    const barrier = nextBarrier;
    nextBarrier = undefined;
    if (barrier) {
      barrier.resolveEntered();
      await barrier.released;
    }
    return { tools: snapshot };
  });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);

  const connection = new MCPConnection({
    serverName: 'dynamic',
    serverConfig: { type: 'streamable-http', url: 'https://mcp.example.com' },
  });
  await connection.client.connect(clientTransport);
  connection.emit('connectionChange', 'connected');

  return {
    connection,
    getListCalls: () => listCalls,
    setTools: (nextTools) => {
      tools = nextTools;
    },
    failNextList: () => {
      shouldFailNextList = true;
    },
    blockNextList: () => {
      let resolveEntered: (() => void) | undefined;
      let release: (() => void) | undefined;
      const entered = new Promise<void>((resolve) => {
        resolveEntered = resolve;
      });
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      nextBarrier = {
        entered,
        resolveEntered: () => resolveEntered?.(),
        released,
        release: () => release?.(),
      };
      return { entered, release: () => release?.() };
    },
    notifyChanged: () => server.sendToolListChanged(),
    close: async () => {
      connection.removeAllListeners();
      await connection.client.close().catch(() => undefined);
      await server.close().catch(() => undefined);
    },
  };
}

describe('tools/list_changed', () => {
  let harness: TestHarness | undefined;

  afterEach(async () => {
    setMCPToolsChangedRevisionHandler(null);
    await harness?.close();
    harness = undefined;
  });

  it('publishes additions, removals, and schema changes from refreshed snapshots', async () => {
    harness = await createHarness([tool('initial', 'version one')]);
    const snapshots: Tool[][] = [];
    harness.connection.on('toolsChanged', (tools: Tool[]) => snapshots.push(tools));
    await harness.connection.fetchTools();

    harness.setTools([tool('initial', 'version one'), tool('added')]);
    await harness.notifyChanged();
    await waitFor(() => snapshots.length === 1);
    expect(snapshots[0].map(({ name }) => name)).toEqual(['initial', 'added']);

    harness.setTools([
      {
        ...tool('initial', 'version two'),
        inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
      },
    ]);
    await harness.notifyChanged();
    await waitFor(() => snapshots.length === 2);

    expect(snapshots[1]).toEqual([
      expect.objectContaining({
        name: 'initial',
        description: 'version two',
        inputSchema: expect.objectContaining({
          properties: { query: { type: 'string' } },
        }),
      }),
    ]);
  });

  it('does not lose a notification that arrives while a refresh is in flight', async () => {
    harness = await createHarness([tool('initial')]);
    const snapshots: Tool[][] = [];
    harness.connection.on('toolsChanged', (tools: Tool[]) => snapshots.push(tools));
    await harness.connection.fetchTools();

    const barrier = harness.blockNextList();
    harness.setTools([tool('initial'), tool('stale')]);
    await harness.notifyChanged();
    await barrier.entered;

    harness.setTools([tool('initial'), tool('latest')]);
    await harness.notifyChanged();
    barrier.release();
    await waitFor(() => snapshots.length === 2);

    expect(snapshots[0].map(({ name }) => name)).toEqual(['initial', 'stale']);
    expect(snapshots[1].map(({ name }) => name)).toEqual(['initial', 'latest']);
  });

  it('keeps a newer cross-replica snapshot when an older request finishes last', async () => {
    const olderReplica = await createHarness([tool('initial')]);
    const newerReplica = await createHarness([tool('initial')]);
    const cache = new Map<string, unknown>();
    const store = createMCPCatalogStore({
      cacheConfig: { FORCED_IN_MEMORY_CACHE_NAMESPACES: [CacheKeys.TOOL_CACHE] },
      getCache: () => ({
        get: async (key) => cache.get(key),
        set: async (key, value) => {
          cache.set(key, value);
          return true;
        },
        delete: async (key) => cache.delete(key),
      }),
    });
    const configGeneration = getMCPAppToolsPublicationGeneration({
      type: 'streamable-http',
      url: 'https://mcp.example.com',
    });
    setMCPToolsChangedRevisionHandler(({ serverName, configGeneration }) =>
      store.getNextAppToolsPublicationRevision(serverName, configGeneration),
    );
    const publications: Promise<boolean>[] = [];
    const publish = (tools: Tool[], publicationRevision?: string) => {
      const catalog: LCAvailableTools = Object.fromEntries(
        tools.map(({ name }) => [name, { type: 'function', function: { name } }]),
      );
      publications.push(
        store.setCachedAppServerTools('dynamic', configGeneration, catalog, publicationRevision),
      );
    };
    olderReplica.connection.on('toolsChanged', publish);
    newerReplica.connection.on('toolsChanged', publish);

    try {
      const barrier = olderReplica.blockNextList();
      olderReplica.setTools([tool('stale')]);
      await olderReplica.notifyChanged();
      await barrier.entered;

      newerReplica.setTools([tool('current')]);
      await newerReplica.notifyChanged();
      await waitFor(() => publications.length === 1);
      await Promise.all(publications);

      barrier.release();
      await waitFor(() => publications.length === 2);
      await Promise.all(publications);

      await expect(store.getCachedAppServerTools('dynamic', configGeneration)).resolves.toEqual({
        current: { type: 'function', function: { name: 'current' } },
      });
    } finally {
      await Promise.all([olderReplica.close(), newerReplica.close()]);
    }
  });

  it('does not publish an in-flight snapshot after the connection is disconnected', async () => {
    harness = await createHarness([tool('initial')]);
    const snapshots: Tool[][] = [];
    harness.connection.on('toolsChanged', (tools: Tool[]) => snapshots.push(tools));
    await harness.connection.fetchTools();

    const barrier = harness.blockNextList();
    harness.setTools([tool('initial'), tool('stale-after-disconnect')]);
    await harness.notifyChanged();
    await barrier.entered;
    await harness.connection.disconnect();
    barrier.release();
    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(snapshots).toEqual([]);
  });

  it('discards an old transport snapshot when disconnect and reconnect race the refresh', async () => {
    harness = await createHarness([tool('initial')]);
    const snapshots: Tool[][] = [];
    harness.connection.on('toolsChanged', (tools: Tool[]) => snapshots.push(tools));
    await harness.connection.fetchTools();

    const barrier = harness.blockNextList();
    harness.setTools([tool('initial'), tool('stale-transport')]);
    await harness.notifyChanged();
    await barrier.entered;

    harness.connection.emit('connectionChange', 'disconnected');
    harness.setTools([tool('initial'), tool('latest-transport')]);
    harness.connection.emit('connectionChange', 'connected');
    barrier.release();

    await waitFor(() => snapshots.length === 1);
    expect(snapshots[0].map(({ name }) => name)).toEqual(['initial', 'latest-transport']);
  });

  it('refreshes after reconnect when the server changed tools while notifications were unavailable', async () => {
    harness = await createHarness([tool('initial')]);
    const snapshots: Tool[][] = [];
    harness.connection.on('toolsChanged', (tools: Tool[]) => snapshots.push(tools));
    await harness.connection.fetchTools();

    harness.connection.emit('connectionChange', 'disconnected');
    harness.setTools([tool('initial'), tool('added-while-disconnected')]);
    harness.connection.emit('connectionChange', 'connected');

    await waitFor(() => snapshots.length === 1);
    expect(snapshots[0].map(({ name }) => name)).toEqual(['initial', 'added-while-disconnected']);
  });

  it('publishes an empty snapshot when a reconnect no longer advertises tools', async () => {
    harness = await createHarness([tool('initial')]);
    const snapshots: Tool[][] = [];
    harness.connection.on('toolsChanged', (tools: Tool[]) => snapshots.push(tools));
    await harness.connection.fetchTools();
    jest.spyOn(harness.connection.client, 'getServerCapabilities').mockReturnValue({});

    harness.connection.emit('connectionChange', 'disconnected');
    harness.connection.emit('connectionChange', 'connected');

    await waitFor(() => snapshots.length === 1);
    expect(snapshots[0]).toEqual([]);
  });

  it('clears a recreated connection when its current server no longer advertises tools', async () => {
    harness = await createHarness([tool('initial')]);
    const snapshots: Tool[][] = [];
    harness.connection.on('toolsChanged', (tools: Tool[]) => snapshots.push(tools));
    await harness.connection.fetchTools();
    jest.spyOn(harness.connection.client, 'getServerCapabilities').mockReturnValue({});

    await harness.connection.refreshToolList();

    expect(snapshots).toEqual([[]]);
  });

  it('retains the last good catalog and retries after a transient list failure', async () => {
    harness = await createHarness([tool('initial')]);
    const snapshots: Tool[][] = [];
    harness.connection.on('toolsChanged', (tools: Tool[]) => snapshots.push(tools));
    await harness.connection.fetchTools();
    const callsBeforeNotification = harness.getListCalls();

    harness.setTools([tool('initial'), tool('recovered')]);
    harness.failNextList();
    await harness.notifyChanged();
    await waitFor(() => harness!.getListCalls() > callsBeforeNotification);
    expect(snapshots).toEqual([]);

    await waitFor(() => snapshots.length === 1);
    expect(snapshots[0].map(({ name }) => name)).toEqual(['initial', 'recovered']);
  });

  it('retries when shared publication ordering is temporarily unavailable', async () => {
    harness = await createHarness([tool('initial')]);
    const snapshots: Array<{ tools: Tool[]; revision?: string }> = [];
    const allocateRevision = jest
      .fn<Promise<string>, [{ serverName: string; configGeneration: string }]>()
      .mockRejectedValueOnce(new Error('Redis unavailable'))
      .mockResolvedValue('1');
    setMCPToolsChangedRevisionHandler(allocateRevision);
    harness.connection.on('toolsChanged', (tools: Tool[], revision?: string) =>
      snapshots.push({ tools, revision }),
    );

    harness.setTools([tool('recovered')]);
    await harness.notifyChanged();
    expect(snapshots).toEqual([]);

    await waitFor(() => snapshots.length === 1);
    expect(snapshots[0]).toEqual({ tools: [tool('recovered')], revision: '1' });
    expect(allocateRevision).toHaveBeenCalledTimes(2);
  });
});
