/**
 * The pinned `web-fetch` server's tools must reach the chat. Startup publishes
 * the app catalog under a generation hashed from the registry's inspected
 * config (which carries `requiresOAuth: false`); the chat loaders used to hash
 * the raw `mcpConfig` entry instead, missed, and skipped the pinned server.
 * Nothing here mocks `getMCPServerTools`: publication and lookup run through
 * the real registry, catalog store and tool cache service.
 */
import { logger } from '@librechat/data-schemas';
import { CacheKeys, Constants } from 'librechat-data-provider';
import type * as t from '~/mcp/types';
import {
  getMCPToolCatalogGeneration,
  getMCPAppToolsPublicationGeneration,
} from '~/mcp/toolsChanged';
import { STANDARD_MCP_CAPABILITY_PROFILE } from '~/mcp/capabilities';
import { MCPServerInspector } from '~/mcp/registry/MCPServerInspector';
import { MCPServersRegistry } from '~/mcp/registry/MCPServersRegistry';
import { createMCPCatalogStore } from '~/mcp/catalog/store';
import { createMCPToolCacheService } from '~/mcp/tools';
import { getMCPToolsLookup } from './lookup';
import { loadEphemeralAgent } from './load';
import { loadAddedAgent } from './added';

jest.mock('~/mcp/registry/MCPServerInspector');
jest.mock('~/mcp/registry/db/ServerConfigsDB', () => ({
  ServerConfigsDB: jest.fn().mockImplementation(() => ({
    get: jest.fn().mockResolvedValue(undefined),
    getAll: jest.fn().mockResolvedValue({}),
    add: jest.fn().mockResolvedValue(undefined),
    update: jest.fn().mockResolvedValue(undefined),
    upsert: jest.fn().mockResolvedValue(undefined),
    remove: jest.fn().mockResolvedValue(undefined),
    reset: jest.fn().mockResolvedValue(undefined),
  })),
}));

const SERVER = 'web-fetch';
const fetchTool = `web_fetch${Constants.mcp_delimiter}${SERVER}`;

/** The librechat.yaml entry, as `appConfig.mcpConfig` carries it. */
const yamlEntry = {
  type: 'streamable-http',
  url: '${TCHAT_BROKER_ORIGIN}/tinyfish/mcp',
  headers: { Authorization: 'Bearer ${TCHAT_BROKER_SHARED_KEY}' },
  title: 'Web fetch',
  description: 'Fetch a web page by URL and read its content.',
  alwaysOn: true,
  chatMenu: false,
  startup: true,
  timeout: 120000,
} as unknown as t.MCPOptions;

function createHarness() {
  (MCPServersRegistry as unknown as { instance: undefined }).instance = undefined;
  MCPServersRegistry.createInstance({} as typeof import('mongoose'));
  const registry = MCPServersRegistry.getInstance();

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

  /** Wired as api/server/services/Config/mcp.js wires it. */
  const service = createMCPToolCacheService({
    getCachedTools: store.getCachedTools,
    updateCachedGlobalTools: store.updateCachedGlobalTools,
    setCachedTools: store.setCachedTools,
    setCachedToolsIfCurrent: store.setCachedToolsIfCurrent,
    getCachedAppServerTools: store.getCachedAppServerTools,
    setCachedAppServerTools: store.setCachedAppServerTools,
    getServerConfig: (serverName, userId) => registry.getServerConfig(serverName, userId),
    getAllServerConfigs: () => registry.getAllServerConfigs(),
    isAppServerConfig: (serverName, effectiveConfig) =>
      registry.isAppServerConfig(serverName, effectiveConfig),
  });

  /** What ConnectionsRepository does for an app-level connection at startup. */
  async function publishAtStartup() {
    const serverConfig = (await registry.getServerConfig(SERVER)) as t.ParsedServerConfig;
    const publicationGeneration = getMCPToolCatalogGeneration(
      serverConfig,
      STANDARD_MCP_CAPABILITY_PROFILE,
    );
    const publicationRevision = await store.getNextAppToolsPublicationRevision(
      SERVER,
      publicationGeneration,
    );
    await service.updateMCPServerTools({
      userId: undefined,
      serverName: SERVER,
      tools: [{ name: 'web_fetch', description: 'Fetch a URL', inputSchema: { type: 'object' } }],
      serverConfig,
      publicationGeneration,
      publicationRevision: publicationRevision ?? undefined,
    });
  }

  const deps = {
    getAgent: async () => null,
    getMCPServerTools: service.getMCPServerTools,
    isUnmodifiedAppMCPServer: (serverName: string, rawConfig: t.MCPOptions) =>
      registry.isUnmodifiedAppServer(serverName, rawConfig),
  };

  return { registry, publishAtStartup, deps };
}

describe('pinned MCP server catalog lookup', () => {
  const env = { ...process.env };
  let harness: ReturnType<typeof createHarness>;
  let warnSpy: jest.SpyInstance;

  beforeEach(async () => {
    process.env.TCHAT_BROKER_ORIGIN = 'http://tchat-broker:8080';
    process.env.TCHAT_BROKER_SHARED_KEY = 'test-key';
    jest
      .spyOn(MCPServerInspector, 'inspect')
      .mockImplementation(async (_serverName: string, rawConfig: t.MCPOptions) => ({
        ...rawConfig,
        requiresOAuth: false,
        tools: 'web_fetch',
        capabilities: '{}',
        initDuration: 108,
      }));
    warnSpy = jest.spyOn(logger, 'warn');
    harness = createHarness();
    await harness.registry.reset();
    await harness.registry.addServer(SERVER, yamlEntry, 'CACHE');
    await harness.publishAtStartup();
  });

  afterEach(() => {
    jest.restoreAllMocks();
    process.env = { ...env };
  });

  const skipWarnings = () =>
    warnSpy.mock.calls.filter(([message]) => String(message).includes('Skipping pinned'));

  test('the registry config is what startup hashed, and it differs from the YAML entry', async () => {
    const stored = (await harness.registry.getServerConfig(SERVER)) as t.ParsedServerConfig;
    expect(stored.requiresOAuth).toBe(false);
    expect(getMCPAppToolsPublicationGeneration(yamlEntry as t.ParsedServerConfig)).not.toBe(
      getMCPAppToolsPublicationGeneration(stored),
    );
  });

  test('loadEphemeralAgent equips the pinned server from the published catalog', async () => {
    const agent = await loadEphemeralAgent(
      {
        req: {
          user: { id: 'user-1' },
          config: { mcpConfig: { [SERVER]: yamlEntry } } as never,
          body: { ephemeralAgent: { mcp: [] } },
        },
        endpoint: 'TensorGrid',
        model_parameters: { model: 'gpt-5.4' } as never,
      },
      harness.deps,
    );

    expect(agent?.tools).toContain(fetchTool);
    expect(skipWarnings()).toEqual([]);
  });

  test('loadAddedAgent equips the pinned server from the published catalog', async () => {
    const agent = await loadAddedAgent(
      {
        req: {
          user: { id: 'user-1' },
          config: { mcpConfig: { [SERVER]: yamlEntry } },
        },
        conversation: { endpoint: 'TensorGrid', model: 'gpt-5.4' } as never,
      },
      harness.deps,
    );

    expect(agent?.tools).toContain(fetchTool);
    expect(skipWarnings()).toEqual([]);
  });

  test('an admin override that differs from YAML is still looked up as an overlay', async () => {
    const override = { ...yamlEntry, url: 'https://tenant.example.com/mcp' } as t.MCPOptions;
    const lookup = await getMCPToolsLookup(SERVER, override, harness.deps.isUnmodifiedAppMCPServer);
    expect(lookup).toEqual({ requestScoped: false, serverConfig: override });
  });
});

describe('getMCPToolsLookup', () => {
  const entry = { type: 'streamable-http', url: 'https://mcp.example.com/mcp' } as t.MCPOptions;

  test('resolves through the registry when there is no request entry', async () => {
    expect(await getMCPToolsLookup(SERVER, undefined)).toEqual({ requestScoped: false });
  });

  test('keeps a request-scoped entry on the fresh mcp_all path', async () => {
    const scoped = {
      ...entry,
      headers: { 'X-Conversation': '{{LIBRECHAT_BODY_CONVERSATIONID}}' },
    } as unknown as t.MCPOptions;
    const isUnmodified = jest.fn();
    expect(await getMCPToolsLookup(SERVER, scoped, isUnmodified)).toEqual({ requestScoped: true });
    expect(isUnmodified).not.toHaveBeenCalled();
  });

  test('drops an entry that is just the unmodified app server', async () => {
    expect(await getMCPToolsLookup(SERVER, entry, async () => true)).toEqual({
      requestScoped: false,
    });
  });

  test('keeps the entry when the comparison is unavailable or fails', async () => {
    const overlay = { requestScoped: false, serverConfig: entry };
    expect(await getMCPToolsLookup(SERVER, entry)).toEqual(overlay);
    expect(
      await getMCPToolsLookup(SERVER, entry, async () => {
        throw new Error('registry down');
      }),
    ).toEqual(overlay);
  });
});
