import { logger } from '@librechat/data-schemas';
import { Constants, normalizeServerName } from 'librechat-data-provider';
import type { LCAvailableTools, ParsedServerConfig } from './types';
import type { MCPToolCacheDeps, MCPToolInput } from './tools';
import { getMCPToolCatalogGeneration } from './toolsChanged';
import { MCP_APPS_CAPABILITY_PROFILE } from './capabilities';
import { createMCPToolCacheService } from './tools';

const requestScopedConfig: ParsedServerConfig = {
  type: 'streamable-http',
  url: 'https://mcp.example.com/{{LIBRECHAT_BODY_CONVERSATIONID}}/mcp',
  source: 'yaml',
};

const cacheableConfig: ParsedServerConfig = {
  type: 'streamable-http',
  url: 'https://mcp.example.com/mcp',
  source: 'yaml',
};

const tenantConfig: ParsedServerConfig = {
  ...cacheableConfig,
  source: 'config',
};

const toolName = (name: string, server: string) =>
  `${name}${Constants.mcp_delimiter}${normalizeServerName(server)}`;

const makeTool = (name: string) => ({
  type: 'function' as const,
  ['function']: { name, description: '', parameters: { type: 'object' as const, properties: {} } },
});

function createMockDeps(overrides: Partial<MCPToolCacheDeps> = {}): MCPToolCacheDeps {
  return {
    getCachedTools: jest.fn().mockResolvedValue(null),
    setCachedTools: jest.fn().mockResolvedValue(true),
    getCachedAppServerTools: jest.fn().mockResolvedValue(null),
    setCachedAppServerTools: jest.fn().mockResolvedValue(true),
    getServerConfig: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function createSharedCacheDeps(params: {
  config: ParsedServerConfig;
  app?: boolean;
  appCache?: Map<string, LCAvailableTools>;
  userCache?: Map<string, LCAvailableTools>;
}): MCPToolCacheDeps {
  const { config, app = true } = params;
  const appCache = params.appCache ?? new Map<string, LCAvailableTools>();
  const userCache = params.userCache ?? new Map<string, LCAvailableTools>();
  const appKey = (serverName: string, generation: string) =>
    JSON.stringify([serverName, generation]);
  const userKey = (userId: string, serverName: string, generation?: string) =>
    JSON.stringify([userId, serverName, generation]);

  return {
    getCachedTools: jest.fn(async ({ userId, serverName, configGeneration } = {}) => {
      if (!userId || !serverName) {
        return null;
      }
      return userCache.get(userKey(userId, serverName, configGeneration)) ?? null;
    }),
    setCachedTools: jest.fn(async (tools, { userId, serverName, configGeneration } = {}) => {
      if (userId && serverName) {
        userCache.set(userKey(userId, serverName, configGeneration), tools);
      }
      return true;
    }),
    setCachedToolsIfCurrent: jest.fn(async (tools, { userId, serverName, configGeneration }) => {
      userCache.set(userKey(userId, serverName, configGeneration), tools);
      return true;
    }),
    getCachedAppServerTools: jest.fn(
      async (serverName, generation) => appCache.get(appKey(serverName, generation)) ?? null,
    ),
    setCachedAppServerTools: jest.fn(async (serverName, generation, tools) => {
      appCache.set(appKey(serverName, generation), tools);
      return true;
    }),
    getServerConfig: jest.fn().mockResolvedValue(config),
    getAllServerConfigs: jest.fn().mockResolvedValue(app ? { dynamic: config } : {}),
    isAppServerConfig: jest.fn().mockResolvedValue(app),
  };
}

describe('createMCPToolCacheService', () => {
  describe('configuration-addressed app catalogs', () => {
    it('keeps standard operator catalogs global and Apps catalogs user-scoped', async () => {
      const appCache = new Map<string, LCAvailableTools>();
      const userCache = new Map<string, LCAvailableTools>();
      const deps = createSharedCacheDeps({ config: cacheableConfig, appCache, userCache });
      const service = createMCPToolCacheService(deps);
      const standardTools = {
        [toolName('standard', 'dynamic')]: makeTool(toolName('standard', 'dynamic')),
      };
      const appsTools = {
        [toolName('apps', 'dynamic')]: makeTool(toolName('apps', 'dynamic')),
      };

      await service.cacheMCPServerTools({
        userId: 'u1',
        serverName: 'dynamic',
        serverTools: standardTools,
        publicationRevision: '1',
      });
      await service.cacheMCPServerTools({
        userId: 'u1',
        serverName: 'dynamic',
        serverTools: appsTools,
        publicationGeneration: 'apps-lease',
        capabilityProfile: MCP_APPS_CAPABILITY_PROFILE,
      });

      await expect(service.getMCPServerTools('u1', 'dynamic')).resolves.toEqual(standardTools);
      await expect(
        service.getMCPServerTools('u1', 'dynamic', undefined, MCP_APPS_CAPABILITY_PROFILE),
      ).resolves.toEqual(appsTools);
      expect(appCache).toHaveProperty('size', 1);
      expect(userCache).toHaveProperty('size', 1);
      expect(deps.getCachedTools).toHaveBeenLastCalledWith({
        userId: 'u1',
        serverName: 'dynamic',
        configGeneration: getMCPToolCatalogGeneration(cacheableConfig, MCP_APPS_CAPABILITY_PROFILE),
        allowLegacyMigration: false,
      });
    });

    it('restores the static catalog without discovering app server configs', async () => {
      const staticTools = { builtin: makeTool('builtin') };
      const updateCachedGlobalTools = jest.fn(async (update) => update({}));
      const getAllServerConfigs = jest.fn().mockResolvedValue({ alpha: cacheableConfig });
      const service = createMCPToolCacheService(
        createMockDeps({ updateCachedGlobalTools, getAllServerConfigs }),
      );

      await service.syncStaticTools(staticTools);

      expect(updateCachedGlobalTools).toHaveBeenCalledTimes(1);
      expect(updateCachedGlobalTools.mock.calls[0][0]({})).toEqual(staticTools);
      expect(getAllServerConfigs).not.toHaveBeenCalled();
    });

    it('removes legacy MCP entries from the shared global catalog during rollout', async () => {
      const alphaConfig = { ...cacheableConfig, toolFunctions: {} };
      const builtin = 'code_interpreter';
      const staticDelimiterTool = `get${Constants.mcp_delimiter}status`;
      let globalTools: LCAvailableTools = {};
      const staticTools = {
        [builtin]: makeTool(builtin),
        [staticDelimiterTool]: makeTool(staticDelimiterTool),
      };
      const deps = createMockDeps({
        getAllServerConfigs: jest.fn().mockResolvedValue({ alpha: alphaConfig }),
        updateCachedGlobalTools: jest.fn(async (update) => {
          globalTools = update(globalTools);
        }),
      });

      await createMCPToolCacheService(deps).mergeAppTools({}, staticTools);

      expect(globalTools).toEqual(staticTools);
      expect(deps.updateCachedGlobalTools).toHaveBeenCalledTimes(1);
    });

    it('writes an authoritative empty snapshot under the publishing config generation', async () => {
      const setCachedAppServerTools = jest.fn().mockResolvedValue(true);
      const deps = createMockDeps({ setCachedAppServerTools });
      const service = createMCPToolCacheService(deps);
      const generation = getMCPToolCatalogGeneration(cacheableConfig);

      await expect(
        service.replaceAppServerTools({
          serverName: 'dynamic',
          serverTools: {},
          publicationGeneration: generation,
          publicationRevision: '1',
        }),
      ).resolves.toBe(true);

      expect(setCachedAppServerTools).toHaveBeenCalledWith('dynamic', generation, {}, '1');
      expect(deps.setCachedTools).not.toHaveBeenCalled();
    });

    it('propagates a rejected app-slice write', async () => {
      const deps = createMockDeps({
        setCachedAppServerTools: jest.fn().mockRejectedValue(new Error('Redis down')),
      });

      await expect(
        createMCPToolCacheService(deps).replaceAppServerTools({
          serverName: 'dynamic',
          serverTools: {},
          publicationGeneration: 'config-generation',
          publicationRevision: '1',
        }),
      ).rejects.toThrow('Redis down');
    });

    /** A publisher that lost its snapshot's revision fetched at an unknown time. Allocating a
     * fresh one here would let a slow fetch of an old catalog outrank a newer one. */
    it('does not publish a live app snapshot without pre-fetch ordering', async () => {
      const deps = createMockDeps();

      await expect(
        createMCPToolCacheService(deps).replaceAppServerTools({
          serverName: 'dynamic',
          serverTools: {},
          publicationGeneration: 'config-generation',
        }),
      ).resolves.toBe(false);

      expect(deps.setCachedAppServerTools).not.toHaveBeenCalled();
    });

    /** #14857 went a release without a diagnostic because dropping an app catalog only logged
     * at debug. A drop means agents lose this server's tools, so it has to be visible by
     * default; a superseded write is routine and must stay quiet. */
    describe('visibility of a discarded publication', () => {
      const publish = (params: { publicationGeneration?: string; publicationRevision?: string }) =>
        createMCPToolCacheService(
          createMockDeps({ setCachedAppServerTools: jest.fn().mockResolvedValue(false) }),
        ).replaceAppServerTools({ serverName: 'dynamic', serverTools: {}, ...params });

      let warn: jest.SpyInstance;

      beforeEach(() => {
        warn = jest.spyOn(logger, 'warn').mockImplementation(() => logger);
      });

      afterEach(() => warn.mockRestore());

      it('warns when a publication cannot be ordered', async () => {
        await publish({ publicationGeneration: 'config-generation' });

        expect(warn).toHaveBeenCalledWith(expect.stringContaining('Skipped unordered'));
      });

      it('warns when a publication cannot be addressed', async () => {
        await publish({ publicationRevision: '1' });

        expect(warn).toHaveBeenCalledWith(expect.stringContaining('Skipped unaddressed'));
      });

      it('stays quiet when a concurrent replica already published newer tools', async () => {
        await publish({ publicationGeneration: 'config-generation', publicationRevision: '1' });

        expect(warn).not.toHaveBeenCalled();
      });
    });

    /** The catalog write needs ordering; the tools themselves were read from the server and are
     * correct to serve. Discarding them is what surfaced as a server with no tools (#14857). */
    it('serves tools it could not publish instead of discarding them', async () => {
      const deps = createSharedCacheDeps({ config: cacheableConfig });
      const search = toolName('search', 'dynamic');

      await expect(
        createMCPToolCacheService(deps).updateMCPServerTools({
          userId: 'user-1',
          serverName: 'dynamic',
          serverConfig: cacheableConfig,
          tools: [{ name: 'search' }],
        }),
      ).resolves.toEqual({ [search]: expect.objectContaining({ type: 'function' }) });

      expect(deps.setCachedAppServerTools).not.toHaveBeenCalled();
    });

    it('discards a superseded catalog rather than serving it', async () => {
      const deps = createSharedCacheDeps({ config: cacheableConfig });
      deps.setCachedAppServerTools = jest.fn().mockResolvedValue(false);

      await expect(
        createMCPToolCacheService(deps).updateMCPServerTools({
          userId: 'user-1',
          serverName: 'dynamic',
          serverConfig: cacheableConfig,
          tools: [{ name: 'search' }],
          publicationRevision: '1',
        }),
      ).resolves.toBeNull();
    });

    it('rejects a tool boundary owned by another app server', async () => {
      const shadowed = toolName('search', 'foo_bar');
      const deps = createMockDeps({
        getAllServerConfigs: jest.fn().mockResolvedValue({
          'foo bar': cacheableConfig,
          foo_bar: cacheableConfig,
        }),
      });

      await expect(
        createMCPToolCacheService(deps).replaceAppServerTools({
          serverName: 'foo bar',
          serverTools: { [shadowed]: makeTool(shadowed) },
          publicationGeneration: 'config-generation',
          publicationRevision: '1',
        }),
      ).rejects.toThrow('belongs to app server foo_bar');
    });

    it('isolates old and new replicas instead of electing the first publisher', async () => {
      const appCache = new Map<string, LCAvailableTools>();
      const oldConfig = cacheableConfig;
      const newConfig = { ...cacheableConfig, url: 'https://mcp.example.com/v2/mcp' };
      const oldService = createMCPToolCacheService(
        createSharedCacheDeps({ config: oldConfig, appCache }),
      );
      const newService = createMCPToolCacheService(
        createSharedCacheDeps({ config: newConfig, appCache }),
      );
      const oldTools = { [toolName('old', 'dynamic')]: makeTool(toolName('old', 'dynamic')) };
      const newTools = { [toolName('new', 'dynamic')]: makeTool(toolName('new', 'dynamic')) };

      await newService.replaceAppServerTools({
        serverName: 'dynamic',
        serverTools: newTools,
        publicationGeneration: getMCPToolCatalogGeneration(newConfig),
        publicationRevision: '1',
      });
      await oldService.replaceAppServerTools({
        serverName: 'dynamic',
        serverTools: oldTools,
        publicationGeneration: getMCPToolCatalogGeneration(oldConfig),
        publicationRevision: '1',
      });

      await expect(newService.getMCPServerTools('user', 'dynamic')).resolves.toEqual(newTools);
      await expect(oldService.getMCPServerTools('user', 'dynamic')).resolves.toEqual(oldTools);
      expect(appCache).toHaveProperty('size', 2);
    });

    it('recovers safely after shared cache loss even if a stale replica publishes first', async () => {
      const appCache = new Map<string, LCAvailableTools>();
      const oldConfig = cacheableConfig;
      const newConfig = { ...cacheableConfig, url: 'https://mcp.example.com/v2/mcp' };
      const oldService = createMCPToolCacheService(
        createSharedCacheDeps({ config: oldConfig, appCache }),
      );
      const newService = createMCPToolCacheService(
        createSharedCacheDeps({ config: newConfig, appCache }),
      );
      const stale = { [toolName('stale', 'dynamic')]: makeTool(toolName('stale', 'dynamic')) };
      const current = {
        [toolName('current', 'dynamic')]: makeTool(toolName('current', 'dynamic')),
      };

      appCache.clear();
      await oldService.replaceAppServerTools({
        serverName: 'dynamic',
        serverTools: stale,
        publicationGeneration: getMCPToolCatalogGeneration(oldConfig),
        publicationRevision: '1',
      });
      await expect(newService.getMCPServerTools('user', 'dynamic')).resolves.toBeNull();

      await newService.replaceAppServerTools({
        serverName: 'dynamic',
        serverTools: current,
        publicationGeneration: getMCPToolCatalogGeneration(newConfig),
        publicationRevision: '1',
      });
      await expect(newService.getMCPServerTools('user', 'dynamic')).resolves.toEqual(current);
    });

    it('splits startup tools into independently addressed server slices', async () => {
      const alphaConfig = { ...cacheableConfig, toolFunctions: {} };
      const betaConfig = { ...cacheableConfig, url: 'https://beta.example.com', toolFunctions: {} };
      const setCachedAppServerTools = jest.fn().mockResolvedValue(true);
      const deps = createMockDeps({
        getAllServerConfigs: jest.fn().mockResolvedValue({ alpha: alphaConfig, beta: betaConfig }),
        setCachedAppServerTools,
      });
      const alpha = toolName('one', 'alpha');
      const beta = toolName('two', 'beta');

      await createMCPToolCacheService(deps).mergeAppTools(
        {
          [alpha]: makeTool(alpha),
          [beta]: makeTool(beta),
        },
        {},
      );

      expect(setCachedAppServerTools).toHaveBeenCalledWith(
        'alpha',
        getMCPToolCatalogGeneration(alphaConfig),
        { [alpha]: makeTool(alpha) },
      );
      expect(setCachedAppServerTools).toHaveBeenCalledWith(
        'beta',
        getMCPToolCatalogGeneration(betaConfig),
        { [beta]: makeTool(beta) },
      );
      expect(deps.setCachedTools).not.toHaveBeenCalled();
    });

    it('does not replace a known-good slice when startup inspection is incomplete', async () => {
      const setCachedAppServerTools = jest.fn().mockResolvedValue(true);
      const deps = createMockDeps({
        getAllServerConfigs: jest.fn().mockResolvedValue({
          complete: { ...cacheableConfig, toolFunctions: {} },
          incomplete: { ...cacheableConfig, toolFunctions: undefined },
        }),
        setCachedAppServerTools,
      });

      await createMCPToolCacheService(deps).mergeAppTools({}, {});

      expect(setCachedAppServerTools).toHaveBeenCalledTimes(1);
      expect(setCachedAppServerTools).toHaveBeenCalledWith('complete', expect.any(String), {});
    });
  });

  describe('user catalog fencing', () => {
    it('passes both connection and config generations to the guarded write', async () => {
      const setCachedToolsIfCurrent = jest.fn().mockResolvedValue(true);
      const deps = createMockDeps({
        getServerConfig: jest.fn().mockResolvedValue(tenantConfig),
        getAllServerConfigs: jest.fn().mockResolvedValue({}),
        setCachedToolsIfCurrent,
      });

      await createMCPToolCacheService(deps).updateMCPServerTools({
        userId: 'u1',
        serverName: 'tenant',
        tools: [{ name: 'search' }],
        publicationGeneration: 'connection-generation',
      });

      expect(setCachedToolsIfCurrent).toHaveBeenCalledWith(expect.any(Object), {
        userId: 'u1',
        serverName: 'tenant',
        configGeneration: getMCPToolCatalogGeneration(tenantConfig),
        publicationGeneration: 'connection-generation',
      });
    });

    it('does not return definitions rejected by the publication-generation fence', async () => {
      const deps = createMockDeps({
        getServerConfig: jest.fn().mockResolvedValue(tenantConfig),
        getAllServerConfigs: jest.fn().mockResolvedValue({}),
        setCachedToolsIfCurrent: jest.fn().mockResolvedValue(false),
      });

      await expect(
        createMCPToolCacheService(deps).updateMCPServerTools({
          userId: 'u1',
          serverName: 'tenant',
          tools: [{ name: 'stale' }],
          publicationGeneration: 'stale-generation',
        }),
      ).resolves.toBeNull();
    });

    it('keeps a late old-config publication invisible to current readers', async () => {
      const userCache = new Map<string, LCAvailableTools>();
      const oldConfig = tenantConfig;
      const newConfig = { ...tenantConfig, url: 'https://mcp.example.com/v2/mcp' };
      const oldService = createMCPToolCacheService(
        createSharedCacheDeps({ config: oldConfig, app: false, userCache }),
      );
      const newService = createMCPToolCacheService(
        createSharedCacheDeps({ config: newConfig, app: false, userCache }),
      );
      const oldTools = { [toolName('old', 'dynamic')]: makeTool(toolName('old', 'dynamic')) };
      const newTools = { [toolName('new', 'dynamic')]: makeTool(toolName('new', 'dynamic')) };

      await newService.cacheMCPServerTools({
        userId: 'u1',
        serverName: 'dynamic',
        serverTools: newTools,
        publicationGeneration: 'new-connection',
      });
      await oldService.cacheMCPServerTools({
        userId: 'u1',
        serverName: 'dynamic',
        serverTools: oldTools,
        publicationGeneration: 'old-connection',
      });

      await expect(newService.getMCPServerTools('u1', 'dynamic')).resolves.toEqual(newTools);
    });

    it('does not fall back to an unfenced write when a guard is configured', async () => {
      const setCachedToolsIfCurrent = jest.fn().mockResolvedValue(true);
      const deps = createMockDeps({
        getServerConfig: jest.fn().mockResolvedValue(tenantConfig),
        getAllServerConfigs: jest.fn().mockResolvedValue({}),
        setCachedToolsIfCurrent,
      });

      await createMCPToolCacheService(deps).cacheMCPServerTools({
        userId: 'u1',
        serverName: 'tenant',
        serverTools: {},
      });

      expect(setCachedToolsIfCurrent).not.toHaveBeenCalled();
      expect(deps.setCachedTools).not.toHaveBeenCalled();
    });
  });

  describe('tool construction and reads', () => {
    it('returns empty for a null tool list without caching', async () => {
      const deps = createMockDeps();
      const result = await createMCPToolCacheService(deps).updateMCPServerTools({
        userId: 'u1',
        serverName: 'srv',
        tools: null,
      });

      expect(result).toEqual({});
      expect(deps.setCachedTools).not.toHaveBeenCalled();
    });

    it('builds model-facing names with the normalized server name', async () => {
      const deps = createMockDeps();
      const tools: MCPToolInput[] = [{ name: 'search', description: 'Search' }];
      const result = await createMCPToolCacheService(deps).updateMCPServerTools({
        userId: 'u1',
        serverName: 'Connector: Company',
        tools,
      });
      const expected = toolName('search', 'Connector: Company');

      expect(result?.[expected]?.['function'].name).toBe(expected);
      expect(deps.setCachedTools).toHaveBeenCalledWith(result, {
        userId: 'u1',
        serverName: 'Connector: Company',
        configGeneration: undefined,
      });
    });

    it('strips a redundant server-name prefix from keys and records the raw name', async () => {
      /** `acme_trace..._mcp_acme` carries the server twice and can push the
       *  model-facing name past provider function-name limits (64). */
      const deps = createMockDeps();
      const tools: MCPToolInput[] = [
        { name: 'acme_trace_top_time_consuming_operations', description: 'Trace' },
        { name: 'list_services', description: 'List' },
      ];
      const result = await createMCPToolCacheService(deps).updateMCPServerTools({
        userId: 'u1',
        serverName: 'acme',
        tools,
      });

      const strippedKey = toolName('trace_top_time_consuming_operations', 'acme');
      const plainKey = toolName('list_services', 'acme');
      expect(Object.keys(result ?? {}).sort()).toEqual([plainKey, strippedKey].sort());
      expect(result?.[strippedKey]?.['function'].name).toBe(strippedKey);
      expect(result?.[strippedKey]?.serverToolName).toBe(
        'acme_trace_top_time_consuming_operations',
      );
      expect(result?.[plainKey]?.serverToolName).toBeUndefined();
    });

    it('keeps the prefixed key when stripping would collide with a sibling tool', async () => {
      const deps = createMockDeps();
      const tools: MCPToolInput[] = [
        { name: 'search', description: 'Plain' },
        { name: 'acme_search', description: 'Prefixed' },
      ];
      const result = await createMCPToolCacheService(deps).updateMCPServerTools({
        userId: 'u1',
        serverName: 'acme',
        tools,
      });

      const plainKey = toolName('search', 'acme');
      const prefixedKey = toolName('acme_search', 'acme');
      expect(Object.keys(result ?? {}).sort()).toEqual([prefixedKey, plainKey].sort());
      expect(result?.[plainKey]?.serverToolName).toBeUndefined();
      expect(result?.[prefixedKey]?.serverToolName).toBeUndefined();
    });

    it('builds request-scoped tools without caching them', async () => {
      const deps = createMockDeps({
        getServerConfig: jest.fn().mockResolvedValue(requestScopedConfig),
      });
      const result = await createMCPToolCacheService(deps).updateMCPServerTools({
        userId: 'u1',
        serverName: 'body-scoped',
        tools: [{ name: 'search' }],
      });

      expect(result?.[toolName('search', 'body-scoped')]).toBeDefined();
      expect(deps.setCachedTools).not.toHaveBeenCalled();
      expect(deps.setCachedAppServerTools).not.toHaveBeenCalled();
    });

    it('treats a missing app slice differently from an authoritative empty slice', async () => {
      const getCachedAppServerTools = jest
        .fn()
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({});
      const deps = createMockDeps({
        getServerConfig: jest.fn().mockResolvedValue(cacheableConfig),
        getAllServerConfigs: jest.fn().mockResolvedValue({ dynamic: cacheableConfig }),
        getCachedAppServerTools,
      });
      const service = createMCPToolCacheService(deps);

      await expect(service.getMCPServerTools('u1', 'dynamic')).resolves.toBeNull();
      await expect(service.getMCPServerTools('u1', 'dynamic')).resolves.toEqual({});
    });

    it('heals raw server names in a configuration-addressed user slice', async () => {
      const staleName = `search${Constants.mcp_delimiter}Connector: Company`;
      const staleTools = { [staleName]: makeTool(staleName) };
      const deps = createMockDeps({
        getServerConfig: jest.fn().mockResolvedValue(tenantConfig),
        getAllServerConfigs: jest.fn().mockResolvedValue({}),
        getCachedTools: jest.fn().mockResolvedValue(staleTools),
      });

      const result = await createMCPToolCacheService(deps).getMCPServerTools(
        'u1',
        'Connector: Company',
      );
      const healed = toolName('search', 'Connector: Company');

      expect(Object.keys(result ?? {})).toEqual([healed]);
      expect(result?.[healed]['function'].name).toBe(healed);
    });

    it('returns null without reading cache for request-scoped servers', async () => {
      const deps = createMockDeps();
      await expect(
        createMCPToolCacheService(deps).getMCPServerTools('u1', 'body-scoped', requestScopedConfig),
      ).resolves.toBeNull();
      expect(deps.getCachedTools).not.toHaveBeenCalled();
      expect(deps.getCachedAppServerTools).not.toHaveBeenCalled();
    });

    it('returns null when a cache read fails', async () => {
      const deps = createMockDeps({
        getCachedTools: jest.fn().mockRejectedValue(new Error('cache unavailable')),
      });
      await expect(
        createMCPToolCacheService(deps).getMCPServerTools('u1', 'server'),
      ).resolves.toBeNull();
    });
  });
});
