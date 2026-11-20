/** Real-SDK coverage for app-level catalogs that never reach agents (#14857). */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CacheKeys, Constants, normalizeServerName } from 'librechat-data-provider';
import { ListToolsRequestSchema, type Tool } from '@modelcontextprotocol/sdk/types.js';
import type { MCPToolsChangedEvent } from '../toolsChanged';
import type { ParsedServerConfig } from '../types';
import {
  notifyMCPToolsChanged,
  setMCPToolsChangedHandler,
  getMCPToolCatalogGeneration,
  setMCPToolsChangedRevisionHandler,
} from '../toolsChanged';
import { STANDARD_MCP_CAPABILITY_PROFILE } from '../capabilities';
import { createMCPCatalogStore } from '../catalog/store';
import { createMCPToolCacheService } from '../tools';
import { MCPConnection } from '../connection';

jest.setTimeout(10_000);

const SERVER_NAME = 'shared';

const appConfig: ParsedServerConfig = {
  type: 'streamable-http',
  url: 'https://mcp.example.com/mcp',
};

const tool = (name: string): Tool => ({
  name,
  description: `${name} the corpus`,
  inputSchema: { type: 'object', properties: {} },
});

const toolKey = (name: string) =>
  `${name}${Constants.mcp_delimiter}${normalizeServerName(SERVER_NAME)}`;

/** Wires the store, the cache service, and the publication handlers exactly as startup does. */
function createHarness() {
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

  const service = createMCPToolCacheService({
    getCachedTools: store.getCachedTools,
    updateCachedGlobalTools: store.updateCachedGlobalTools,
    setCachedTools: store.setCachedTools,
    setCachedToolsIfCurrent: store.setCachedToolsIfCurrent,
    getCachedAppServerTools: store.getCachedAppServerTools,
    setCachedAppServerTools: store.setCachedAppServerTools,
    getServerConfig: async () => appConfig,
    getAllServerConfigs: async () => ({ [SERVER_NAME]: appConfig }),
    isAppServerConfig: async () => true,
  });

  setMCPToolsChangedRevisionHandler(({ serverName, configGeneration }) =>
    store.getNextAppToolsPublicationRevision(serverName, configGeneration),
  );
  setMCPToolsChangedHandler(async (event: MCPToolsChangedEvent) => {
    await service.updateMCPServerTools({
      userId: event.userId,
      serverName: event.serverName,
      tools: event.tools,
      serverConfig: event.serverConfig as ParsedServerConfig,
      publicationGeneration: event.publicationGeneration,
      publicationRevision: event.publicationRevision,
      capabilityProfile: event.capabilityProfile,
    });
  });

  return { store, service };
}

async function createConnection(tools: Tool[]) {
  const server = new Server(
    { name: 'shared-tool-server', version: '1.0.0' },
    { capabilities: { tools: { listChanged: true } } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((entry) => ({ ...entry })),
  }));

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);

  /** No userId: this is an app-shared connection, the scope agents read from. */
  const connection = new MCPConnection({
    serverName: SERVER_NAME,
    serverConfig: appConfig,
    capabilityProfile: STANDARD_MCP_CAPABILITY_PROFILE,
  });
  await connection.client.connect(clientTransport);
  connection.emit('connectionChange', 'connected');

  return {
    connection,
    notifyChanged: () => server.sendToolListChanged(),
    close: async () => {
      connection.removeAllListeners();
      await connection.client.close().catch(() => undefined);
      await server.close().catch(() => undefined);
    },
  };
}

describe('app-level tool publication', () => {
  const configGeneration = getMCPToolCatalogGeneration(appConfig);
  let harness: Awaited<ReturnType<typeof createConnection>> | undefined;

  afterEach(async () => {
    setMCPToolsChangedHandler(null);
    setMCPToolsChangedRevisionHandler(null);
    await harness?.close();
    harness = undefined;
  });

  /** The reporter's case: a shared server connecting outside the startup refresh. Its snapshot
   * has to carry ordering, or the catalog write is dropped and agents see no tools at all. */
  it('makes a first-connect snapshot readable by agents', async () => {
    const { service } = createHarness();
    harness = await createConnection([tool('search')]);

    const snapshot = await harness.connection.fetchToolsSnapshot();
    expect(snapshot.publicationRevision).toBeDefined();

    await notifyMCPToolsChanged({
      tools: snapshot.tools,
      serverName: SERVER_NAME,
      serverConfig: appConfig,
      publicationGeneration: configGeneration,
      publicationRevision: snapshot.publicationRevision,
      capabilityProfile: STANDARD_MCP_CAPABILITY_PROFILE,
    });

    const published = await service.getMCPServerTools('user-1', SERVER_NAME, appConfig);
    expect(Object.keys(published ?? {})).toEqual([toolKey('search')]);
  });

  it('reserves ordering before the tools/list it describes', async () => {
    const { store } = createHarness();
    harness = await createConnection([tool('search')]);

    const before = await store.getNextAppToolsPublicationRevision(SERVER_NAME, configGeneration);
    const snapshot = await harness.connection.fetchToolsSnapshot();
    const after = await store.getNextAppToolsPublicationRevision(SERVER_NAME, configGeneration);

    expect(Number(snapshot.publicationRevision)).toBeGreaterThan(Number(before));
    expect(Number(snapshot.publicationRevision)).toBeLessThan(Number(after));
  });

  /** A snapshot fetched earlier must not overwrite a catalog published from a later fetch,
   * which is exactly what a revision allocated at publish time would allow. */
  it('cannot overwrite a catalog fetched after it', async () => {
    const { service } = createHarness();
    harness = await createConnection([tool('stale')]);
    const stale = await harness.connection.fetchToolsSnapshot();

    const current = await harness.connection.reserveToolsPublicationRevision();
    await notifyMCPToolsChanged({
      tools: [tool('current')],
      serverName: SERVER_NAME,
      serverConfig: appConfig,
      publicationGeneration: configGeneration,
      publicationRevision: current.publicationRevision,
      capabilityProfile: STANDARD_MCP_CAPABILITY_PROFILE,
    });
    await notifyMCPToolsChanged({
      tools: stale.tools,
      serverName: SERVER_NAME,
      serverConfig: appConfig,
      publicationGeneration: configGeneration,
      publicationRevision: stale.publicationRevision,
      capabilityProfile: STANDARD_MCP_CAPABILITY_PROFILE,
    });

    const published = await service.getMCPServerTools('user-1', SERVER_NAME, appConfig);
    expect(Object.keys(published ?? {})).toEqual([toolKey('current')]);
  });

  /** When a request-time fetch is superseded by a list_changed refresh, it returns the refresh's
   * catalog — and must return the refresh's revision with it, not its own superseded ticket. */
  it('carries the refresh revision when a request fetch is superseded', async () => {
    createHarness();
    harness = await createConnection([tool('search')]);
    const published: Array<string | undefined> = [];
    harness.connection.on('toolsChanged', (_tools: Tool[], revision?: string) =>
      published.push(revision),
    );

    await harness.notifyChanged();
    await harness.connection.refreshToolList();
    const ordered = await harness.connection.fetchOrderedToolsSnapshot();

    expect(published.length).toBeGreaterThan(0);
    expect(ordered.complete).toBe(true);
    expect(ordered.publicationRevision).toBeDefined();
  });
});
