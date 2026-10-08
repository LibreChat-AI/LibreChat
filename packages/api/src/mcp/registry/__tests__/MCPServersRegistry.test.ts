import './helpers/setupCredsEnv';
import { logger } from '@librechat/data-schemas';
import { setImmediate as realSetImmediate } from 'timers';
import {
  DEFAULT_MCP_APPS_POLICY,
  DEFAULT_MCP_APP_PERSISTED_BYTES,
  DEFAULT_MCP_APP_ADMISSION_REQUESTS_PER_MINUTE,
  DEFAULT_MCP_APP_MAX_ACTIVE_VIEWS,
  DEFAULT_MCP_APP_ACTION_PREVIEW_CHARS,
} from 'librechat-data-provider';
import type * as t from '~/mcp/types';
import {
  MCPServersRegistry,
  MCPConfigInitializationCanceledError,
} from '~/mcp/registry/MCPServersRegistry';
import { ServerConfigsCacheInMemory } from '~/mcp/registry/cache/ServerConfigsCacheInMemory';
import { getMCPAppToolsPublicationGeneration } from '~/mcp/toolsChanged';
import { MCPServerInspector } from '~/mcp/registry/MCPServerInspector';
import { MCPInspectionFailedError } from '~/mcp/errors';
import { processMCPEnv } from '~/utils/env';

// Mock MCPServerInspector to avoid actual server connections
jest.mock('~/mcp/registry/MCPServerInspector');

// Mock ServerConfigsDB to avoid mongoose dependency
jest.mock('~/mcp/registry/db/ServerConfigsDB', () => ({
  ServerConfigsDB: jest.fn().mockImplementation(() => ({
    get: jest.fn().mockResolvedValue(undefined),
    getAll: jest.fn().mockResolvedValue({}),
    add: jest.fn().mockImplementation(async (serverName: string, config: t.ParsedServerConfig) => ({
      serverName,
      config,
    })),
    update: jest.fn().mockResolvedValue(undefined),
    remove: jest.fn().mockResolvedValue(undefined),
    reset: jest.fn().mockResolvedValue(undefined),
  })),
}));

const FIXED_TIME = 1699564800000;
const originalDateNow = Date.now;
Date.now = jest.fn(() => FIXED_TIME);

// Mock mongoose for registry initialization
const mockMongoose = {} as typeof import('mongoose');

/**
 * Unit tests for MCPServersRegistry using in-memory cache.
 * For integration tests using Redis-backed cache, see MCPServersRegistry.cache_integration.spec.ts
 */
describe('MCPServersRegistry', () => {
  let registry: MCPServersRegistry;

  const testParsedConfig: t.ParsedServerConfig = {
    type: 'stdio',
    command: 'node',
    args: ['tools.js'],
    requiresOAuth: false,
    serverInstructions: 'Instructions for file_tools_server',
    tools: 'file_read, file_write',
    capabilities: '{"tools":{"listChanged":true}}',
    toolFunctions: {
      file_read_mcp_file_tools_server: {
        type: 'function',
        function: {
          name: 'file_read_mcp_file_tools_server',
          description: 'Read a file',
          parameters: { type: 'object' },
        },
      },
    },
    updatedAt: FIXED_TIME,
  };
  beforeAll(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date(FIXED_TIME));
  });
  afterAll(() => {
    Date.now = originalDateNow;
  });
  beforeEach(async () => {
    // Reset the singleton instance before each test
    (MCPServersRegistry as unknown as { instance: undefined }).instance = undefined;

    // Create a new instance for testing
    MCPServersRegistry.createInstance(mockMongoose);
    registry = MCPServersRegistry.getInstance();

    // Mock MCPServerInspector.inspect to return the config that's passed in
    jest
      .spyOn(MCPServerInspector, 'inspect')
      .mockImplementation(async (_serverName: string, rawConfig: t.MCPOptions) => {
        return {
          ...testParsedConfig,
          ...rawConfig,
          requiresOAuth: false,
        } as unknown as t.ParsedServerConfig;
      });
    await registry.reset();
  });

  // Tests for the old privateServersCache API have been removed
  // The refactoring simplified the architecture to use unified repositories (cache + DB)
  // instead of the three-tier system (sharedAppServers, sharedUserServers, privateServersCache)

  // Tests for getPrivateServerConfig have been removed
  // The new architecture uses getServerConfig() which checks cache first, then DB
  // Private server functionality is now handled by the DB repository (not yet implemented)

  describe('getAllServerConfigs', () => {
    it('should return servers from cache repository', async () => {
      // Add servers to cache using the new API
      await registry['cacheConfigsRepo'].add('app_server', testParsedConfig);
      await registry['cacheConfigsRepo'].add('user_server', testParsedConfig);

      // getAllServerConfigs should return configs from cache (DB is not implemented yet)
      const configs = await registry.getAllServerConfigs();
      expect(Object.keys(configs)).toHaveLength(2);
      expect(configs).toHaveProperty('app_server');
      expect(configs).toHaveProperty('user_server');
    });

    it('should partition read-through entries by tenant', async () => {
      const { tenantStorage } = await import('@librechat/data-schemas');
      const dbGetAll = jest.spyOn(registry['dbConfigsRepo'], 'getAll');
      dbGetAll.mockResolvedValueOnce({ tenant_a_server: testParsedConfig });
      dbGetAll.mockResolvedValueOnce({ tenant_b_server: testParsedConfig });

      /** The DB read behind each miss is tenant-filtered, so the cached maps
       *  must never cross tenants even for the same userId. */
      const inA = await tenantStorage.run(
        { tenantId: 'tenant-a' },
        async () => await registry.getAllServerConfigs('user-1'),
      );
      const inB = await tenantStorage.run(
        { tenantId: 'tenant-b' },
        async () => await registry.getAllServerConfigs('user-1'),
      );

      expect(Object.keys(inA)).toEqual(['tenant_a_server']);
      expect(Object.keys(inB)).toEqual(['tenant_b_server']);
      expect(dbGetAll).toHaveBeenCalledTimes(2);

      /** Within one tenant the entry is reused without a second DB read. */
      const inAAgain = await tenantStorage.run(
        { tenantId: 'tenant-a' },
        async () => await registry.getAllServerConfigs('user-1'),
      );
      expect(Object.keys(inAAgain)).toEqual(['tenant_a_server']);
      expect(dbGetAll).toHaveBeenCalledTimes(2);
    });

    it('partitions role-filtered server maps when a user role changes', async () => {
      const dbGetAll = jest.spyOn(registry['dbConfigsRepo'], 'getAll');
      dbGetAll.mockResolvedValueOnce({ admin_server: testParsedConfig });
      dbGetAll.mockResolvedValueOnce({ user_server: testParsedConfig });

      await expect(registry.getAllServerConfigs('user-1', {}, 'ADMIN')).resolves.toEqual({
        admin_server: testParsedConfig,
      });
      await expect(registry.getAllServerConfigs('user-1', {}, 'USER')).resolves.toEqual({
        user_server: testParsedConfig,
      });
      await expect(registry.getAllServerConfigs('user-1', {}, 'USER')).resolves.toEqual({
        user_server: testParsedConfig,
      });

      expect(dbGetAll).toHaveBeenNthCalledWith(1, 'user-1', 'ADMIN');
      expect(dbGetAll).toHaveBeenNthCalledWith(2, 'user-1', 'USER');
      expect(dbGetAll).toHaveBeenCalledTimes(2);
    });

    it('does not join or erase a single-flight fetch from another generation', async () => {
      let resolveOld!: (value: Record<string, t.ParsedServerConfig>) => void;
      let resolveFresh!: (value: Record<string, t.ParsedServerConfig>) => void;
      let signalOldStarted!: () => void;
      let signalFreshStarted!: () => void;
      const oldResult = new Promise<Record<string, t.ParsedServerConfig>>((resolve) => {
        resolveOld = resolve;
      });
      const freshResult = new Promise<Record<string, t.ParsedServerConfig>>((resolve) => {
        resolveFresh = resolve;
      });
      const oldStarted = new Promise<void>((resolve) => {
        signalOldStarted = resolve;
      });
      const freshStarted = new Promise<void>((resolve) => {
        signalFreshStarted = resolve;
      });
      const dbGetAll = jest
        .spyOn(registry['dbConfigsRepo'], 'getAll')
        .mockImplementationOnce(async () => {
          signalOldStarted();
          return oldResult;
        })
        .mockImplementationOnce(async () => {
          signalFreshStarted();
          return freshResult;
        });

      const oldRequest = registry.getAllServerConfigs('user-1');
      await oldStarted;
      expect(dbGetAll).toHaveBeenCalledTimes(1);

      await registry['readThroughCacheAll'].invalidateAll();
      const freshRequest = registry.getAllServerConfigs('user-1');
      await freshStarted;
      expect(dbGetAll).toHaveBeenCalledTimes(2);

      resolveOld({ old_server: testParsedConfig });
      await expect(oldRequest).resolves.toEqual({ old_server: testParsedConfig });

      const joinedFreshRequest = registry.getAllServerConfigs('user-1');

      resolveFresh({ fresh_server: testParsedConfig });
      await expect(freshRequest).resolves.toEqual({ fresh_server: testParsedConfig });
      await expect(joinedFreshRequest).resolves.toEqual({ fresh_server: testParsedConfig });
      expect(dbGetAll).toHaveBeenCalledTimes(2);

      await expect(registry.getAllServerConfigs('user-1')).resolves.toEqual({
        fresh_server: testParsedConfig,
      });
      expect(dbGetAll).toHaveBeenCalledTimes(2);
    });

    it('should keep YAML servers authoritative when a DB server has the same name', async () => {
      const warnSpy = jest.spyOn(logger, 'warn').mockImplementation();
      const yamlConfig = { ...testParsedConfig, source: 'yaml' as const, title: 'YAML Slack' };
      const dbConfig = { ...testParsedConfig, source: 'user' as const, title: 'User Slack' };
      await registry['cacheConfigsRepo'].add('slack', yamlConfig);
      jest.spyOn(registry['dbConfigsRepo'], 'getAll').mockResolvedValue({
        slack: dbConfig,
        user_server: dbConfig,
      });

      try {
        const configs = await registry.getAllServerConfigs('user-1');

        expect(configs.slack).toMatchObject({ source: 'yaml', title: 'YAML Slack' });
        expect(configs.user_server).toMatchObject({ source: 'user', title: 'User Slack' });
      } finally {
        warnSpy.mockRestore();
      }
    });

    it('should warn when operator-managed servers shadow DB servers', async () => {
      const warnSpy = jest.spyOn(logger, 'warn').mockImplementation();
      const yamlConfig = { ...testParsedConfig, source: 'yaml' as const, title: 'YAML Slack' };
      const dbConfig = { ...testParsedConfig, source: 'user' as const, title: 'User Slack' };
      await registry['cacheConfigsRepo'].add('slack', yamlConfig);
      jest.spyOn(registry['dbConfigsRepo'], 'getAll').mockResolvedValue({ slack: dbConfig });

      try {
        await registry.getAllServerConfigs('user-1');

        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('shadow DB-backed server'));
        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('1 colliding name'));
        expect(JSON.stringify(warnSpy.mock.calls)).not.toContain('slack');
      } finally {
        warnSpy.mockRestore();
      }
    });

    it('should preserve the user-tier entry over a config-tier override on the same name without emitting a misleading shadow warning', async () => {
      const warnSpy = jest.spyOn(logger, 'warn').mockImplementation();
      const configServer = {
        ...testParsedConfig,
        source: 'config' as const,
        title: 'Config Slack',
      };
      const dbConfig = { ...testParsedConfig, source: 'user' as const, title: 'User Slack' };
      jest.spyOn(registry['dbConfigsRepo'], 'getAll').mockResolvedValue({ slack: dbConfig });

      try {
        const result = await registry.getAllServerConfigs('user-1', { slack: configServer });

        expect(result.slack.source).toBe('user');
        expect(result.slack.title).toBe('User Slack');
        expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining('Config MCP server'));
      } finally {
        warnSpy.mockRestore();
      }
    });
  });

  describe('isAppServerConfig', () => {
    it('rejects a same-name tenant override that inherited the YAML source tag', async () => {
      const baseConfig = {
        ...testParsedConfig,
        source: 'yaml' as const,
        url: 'https://base.example.com/mcp',
        type: 'streamable-http' as const,
      };
      await registry['cacheConfigsRepo'].add('shared', baseConfig);

      await expect(registry.isAppServerConfig('shared', baseConfig)).resolves.toBe(true);
      await expect(
        registry.isAppServerConfig('shared', {
          ...baseConfig,
          url: 'https://tenant.example.com/mcp',
        }),
      ).resolves.toBe(false);
    });
  });

  describe('addServer', () => {
    it('should pass user source to inspector before storing DB servers', async () => {
      const inspectSpy = jest.spyOn(MCPServerInspector, 'inspect');

      await registry.addServer(
        'user_runtime_server',
        {
          type: 'streamable-http',
          url: 'https://api.example.com/mcp',
          headers: {
            'X-LibreChat-User-Email': '{{LIBRECHAT_USER_EMAIL}}',
          },
        },
        'DB',
        'user-1',
      );

      expect(inspectSpy).toHaveBeenCalledWith(
        'user_runtime_server',
        expect.objectContaining({
          source: 'user',
          headers: {
            'X-LibreChat-User-Email': '{{LIBRECHAT_USER_EMAIL}}',
          },
        }),
        undefined,
        undefined,
        undefined,
      );
    });

    it('should reserve YAML and current config server names when creating DB servers', async () => {
      await registry.addServer('slack', { ...testParsedConfig, title: 'Slack' }, 'CACHE');
      await registry['configCacheRepo'].upsert('other_tenant:hash', {
        ...testParsedConfig,
        source: 'config',
        title: 'Other Tenant Server',
      });
      const dbAddSpy = jest.spyOn(registry['dbConfigsRepo'], 'add').mockResolvedValue({
        serverName: 'slack-2',
        config: { ...testParsedConfig, source: 'user', title: 'Slack' },
      });

      await registry.addServer(
        'temp_server_name',
        { ...testParsedConfig, title: 'Slack' },
        'DB',
        'user-1',
        ['config_slack'],
      );

      const reservedServerNames = Array.from(dbAddSpy.mock.calls[0]?.[3] ?? []);
      expect(reservedServerNames).toEqual(expect.arrayContaining(['slack', 'config_slack']));
      expect(reservedServerNames).not.toContain('other_tenant');
    });
  });

  /**
   * Agent Plugins servers reach the registry through the same startup path as
   * librechat.yaml servers. Deriving `source` from the storage tier alone used to
   * retag them `'yaml'`, which dropped the marker `processMCPEnv` needs to keep
   * plugin-authored placeholders literal and let a plugin exfiltrate `process.env`
   * secrets through its own headers.
   */
  describe('plugin provenance', () => {
    const pluginConfig: t.ParsedServerConfig = {
      source: 'plugin',
      type: 'streamable-http',
      url: 'https://plugin.example.com/mcp',
      headers: { Authorization: 'Bearer ${TEST_PLUGIN_SECRET}' },
    };

    it('keeps the plugin marker through inspection and cache storage', async () => {
      const inspectSpy = jest.spyOn(MCPServerInspector, 'inspect');

      const result = await registry.addServer('plugin_server', pluginConfig, 'CACHE');

      expect(inspectSpy).toHaveBeenCalledWith(
        'plugin_server',
        expect.objectContaining({
          source: 'plugin',
          headers: { Authorization: 'Bearer ${TEST_PLUGIN_SECRET}' },
        }),
        undefined,
        undefined,
        undefined,
      );
      expect(result.config.source).toBe('plugin');
      await expect(registry['cacheConfigsRepo'].get('plugin_server')).resolves.toMatchObject({
        source: 'plugin',
        headers: { Authorization: 'Bearer ${TEST_PLUGIN_SECRET}' },
      });
    });

    it('still tags operator-authored cache servers as yaml', async () => {
      const result = await registry.addServer('yaml_server', { ...testParsedConfig }, 'CACHE');

      expect(result.config.source).toBe('yaml');
    });

    it('keeps the plugin marker on a recovery stub when inspection fails', async () => {
      const result = await registry.addServerStub('plugin_server', pluginConfig, 'CACHE');

      expect(result.config).toMatchObject({ source: 'plugin', inspectionFailed: true });
    });

    it('keeps the plugin marker through config-tier lazy init', async () => {
      const result = await registry.ensureConfigServers({ plugin_server: pluginConfig });

      expect(result.plugin_server.source).toBe('plugin');
    });

    it('never lets a DB-stored config claim plugin provenance', async () => {
      const inspectSpy = jest.spyOn(MCPServerInspector, 'inspect');

      const result = await registry.addServer('forged_server', pluginConfig, 'DB', 'user-1');

      expect(inspectSpy).toHaveBeenCalledWith(
        'forged_server',
        expect.objectContaining({ source: 'user' }),
        undefined,
        undefined,
        undefined,
      );
      expect(result.config.source).toBe('user');
    });

    it('leaves a plugin-authored header literal after a registry round trip', async () => {
      process.env.TEST_PLUGIN_SECRET = 'host-secret-value';
      try {
        await registry.addServer('plugin_server', pluginConfig, 'CACHE');
        const stored = await registry.getServerConfig('plugin_server');
        expect(stored).toBeDefined();

        const runtimeConfig = processMCPEnv({ options: stored! });

        expect(runtimeConfig).toMatchObject({
          headers: { Authorization: 'Bearer ${TEST_PLUGIN_SECRET}' },
        });
      } finally {
        delete process.env.TEST_PLUGIN_SECRET;
      }
    });

    /**
     * An operator Config override that shadows a same-name plugin base must keep
     * its own trusted `'config'` source. Inheriting the base's `'plugin'` marker
     * would make `processMCPEnv` stop resolving the operator's own placeholders
     * and silently break their server.
     */
    it('does not lend plugin provenance to an operator config override of the same name', async () => {
      const pluginBase: t.ParsedServerConfig = {
        source: 'plugin',
        type: 'streamable-http',
        url: 'https://plugin.example.com/mcp',
        requiresOAuth: false,
      };
      await registry['cacheConfigsRepo'].add('shared', pluginBase);

      const override: t.ParsedServerConfig = {
        source: 'config',
        type: 'streamable-http',
        url: 'https://operator.example.com/mcp',
        headers: { Authorization: 'Bearer ${TEST_OPERATOR_SECRET}' },
        requiresOAuth: false,
      };

      const all = await registry.getAllServerConfigs('user-1', { shared: override });
      expect(all.shared.source).toBe('config');

      const single = await registry.getServerConfig('shared', 'user-1', { shared: override });
      expect(single?.source).toBe('config');

      process.env.TEST_OPERATOR_SECRET = 'operator-secret-value';
      try {
        const runtimeConfig = processMCPEnv({ options: all.shared });
        expect(runtimeConfig).toMatchObject({
          headers: { Authorization: 'Bearer operator-secret-value' },
        });
      } finally {
        delete process.env.TEST_OPERATOR_SECRET;
      }
    });

    it('keeps a process-backed plugin server authoritative over config-tier overrides', async () => {
      const pluginBase: t.ParsedServerConfig = {
        source: 'plugin',
        type: 'stdio',
        command: 'node',
        args: ['trusted-plugin-server.js'],
      };
      await registry['cacheConfigsRepo'].add('shared-process', pluginBase);

      const override: t.ParsedServerConfig = {
        source: 'config',
        type: 'streamable-http',
        url: 'https://override.example.com/mcp',
        requiresOAuth: false,
      };

      const all = await registry.getAllServerConfigs('user-1', {
        'shared-process': override,
      });
      expect(all['shared-process']).toMatchObject(pluginBase);
      expect(all['shared-process']).not.toHaveProperty('url');

      const single = await registry.getServerConfig('shared-process', 'user-1', {
        'shared-process': override,
      });
      expect(single).toMatchObject(pluginBase);
      expect(single).not.toHaveProperty('url');
    });
  });

  describe('resolveAllowlists (per-request, tenant-scoped)', () => {
    const createWith = (
      allowedDomains?: string[] | null,
      allowedAddresses?: string[] | null,
      resolver?: (ctx?: { userId?: string; role?: string }) => Promise<{
        allowedDomains?: string[] | null;
        allowedAddresses?: string[] | null;
        mcpApps: { enabled: boolean; legacyHtmlEnabled: boolean };
      }>,
      mcpApps?: { enabled: boolean; legacyHtmlEnabled: boolean },
    ): MCPServersRegistry => {
      (MCPServersRegistry as unknown as { instance: undefined }).instance = undefined;
      MCPServersRegistry.createInstance(
        mockMongoose,
        allowedDomains,
        allowedAddresses,
        resolver,
        mcpApps,
      );
      return MCPServersRegistry.getInstance();
    };

    it('returns the YAML base allowlists when no resolver is injected', async () => {
      const reg = createWith(['yaml.com'], ['10.0.0.0/8']);
      await expect(reg.resolveAllowlists()).resolves.toEqual({
        allowedDomains: ['yaml.com'],
        allowedAddresses: ['10.0.0.0/8'],
        useSSRFProtection: false,
        mcpApps: {
          enabled: false,
          legacyHtmlEnabled: true,
          maxPersistedAppBytes: DEFAULT_MCP_APP_PERSISTED_BYTES,
          maxAdmissionRequestsPerMinute: DEFAULT_MCP_APP_ADMISSION_REQUESTS_PER_MINUTE,
          maxActiveViews: DEFAULT_MCP_APP_MAX_ACTIVE_VIEWS,
          maxActionPreviewChars: DEFAULT_MCP_APP_ACTION_PREVIEW_CHARS,
        },
      });
    });

    it('enables SSRF protection when the effective allowlist is empty', async () => {
      const reg = createWith(undefined, undefined);
      await expect(reg.resolveAllowlists()).resolves.toEqual({
        allowedDomains: undefined,
        allowedAddresses: undefined,
        useSSRFProtection: true,
        mcpApps: {
          enabled: false,
          legacyHtmlEnabled: true,
          maxPersistedAppBytes: DEFAULT_MCP_APP_PERSISTED_BYTES,
          maxAdmissionRequestsPerMinute: DEFAULT_MCP_APP_ADMISSION_REQUESTS_PER_MINUTE,
          maxActiveViews: DEFAULT_MCP_APP_MAX_ACTIVE_VIEWS,
          maxActionPreviewChars: DEFAULT_MCP_APP_ACTION_PREVIEW_CHARS,
        },
      });
    });

    it('returns the resolver-provided merged allowlists and forwards the context', async () => {
      const resolver = jest.fn().mockResolvedValue({
        allowedDomains: ['admin-added.com'],
        allowedAddresses: ['172.16.0.0/12'],
        mcpApps: { enabled: true, legacyHtmlEnabled: true },
      });
      const reg = createWith(['yaml.com'], null, resolver);

      const result = await reg.resolveAllowlists({ userId: 'u1', role: 'ADMIN' });

      expect(resolver).toHaveBeenCalledWith({ userId: 'u1', role: 'ADMIN' });
      expect(result).toEqual({
        allowedDomains: ['admin-added.com'],
        allowedAddresses: ['172.16.0.0/12'],
        useSSRFProtection: false,
        mcpApps: { enabled: true, legacyHtmlEnabled: true },
      });
    });

    it('falls back to the YAML base allowlists but disables apps when the resolver throws', async () => {
      const resolver = jest.fn().mockRejectedValue(new Error('DB down'));
      const reg = createWith(['yaml.com'], null, resolver);

      // Allowlists fall back to the operator baseline; apps fail closed because inline app HTML
      // cannot be retracted once it reaches the transcript.
      await expect(reg.resolveAllowlists()).resolves.toEqual({
        allowedDomains: ['yaml.com'],
        allowedAddresses: null,
        useSSRFProtection: false,
        mcpApps: DEFAULT_MCP_APPS_POLICY,
      });
    });

    it('inspects against the resolved (admin-panel) allowlist, not the YAML base', async () => {
      const resolver = jest.fn().mockResolvedValue({
        allowedDomains: ['admin-added.com'],
        allowedAddresses: ['10.0.0.0/8'],
        mcpApps: { enabled: true, legacyHtmlEnabled: true },
      });
      const reg = createWith(['yaml-only.com'], null, resolver);
      const inspectSpy = jest.spyOn(MCPServerInspector, 'inspect');
      await reg.reset();

      await reg.addServer(
        'admin_panel_server',
        { type: 'streamable-http', url: 'https://admin-added.com/mcp' },
        'DB',
        'user-1',
      );

      expect(resolver).toHaveBeenCalledWith({ userId: 'user-1' });
      expect(inspectSpy).toHaveBeenCalledWith(
        'admin_panel_server',
        expect.objectContaining({ url: 'https://admin-added.com/mcp' }),
        undefined,
        ['admin-added.com'],
        ['10.0.0.0/8'],
      );
    });

    it('scopes the config-source cache key by the resolved allowlist (no cross-tenant poison)', async () => {
      const resolver = jest
        .fn()
        .mockResolvedValueOnce({ allowedDomains: ['a.com'], allowedAddresses: null })
        .mockResolvedValueOnce({ allowedDomains: ['b.com'], allowedAddresses: null });
      const reg = createWith(null, null, resolver);
      const inspectSpy = jest.spyOn(MCPServerInspector, 'inspect');
      await reg.reset();
      inspectSpy.mockClear();

      const cfg = {
        srv: { type: 'streamable-http' as const, url: 'https://srv.example.com/mcp' },
      };
      await reg.ensureConfigServers(cfg); // resolver call 1 → allowlist A
      await reg.ensureConfigServers(cfg); // resolver call 2 → allowlist B (distinct key)

      // Different resolved allowlists ⇒ different cache keys ⇒ the second pass re-inspects
      // instead of reusing the first allowlist's cached entry.
      expect(inspectSpy).toHaveBeenCalledTimes(2);
    });
  });

  describe('resolveCachedAppServerConfig', () => {
    const rawConfig: t.MCPOptions = {
      type: 'streamable-http',
      url: 'https://config.example.com/mcp',
    };
    const allowlists = {
      allowedDomains: ['config.example.com'],
      allowedAddresses: null,
    };

    it('returns an exact healthy config-cache target without inspecting or connecting', async () => {
      const cachedConfig = {
        ...rawConfig,
        source: 'config' as const,
        requiresOAuth: false,
      } as t.ParsedServerConfig;
      const key = registry['configCacheKey']('srv', rawConfig, allowlists);
      const { config: storedCachedConfig } = await registry['configCacheRepo'].add(
        key,
        cachedConfig,
      );
      const inspectSpy = jest.spyOn(MCPServerInspector, 'inspect');
      inspectSpy.mockClear();

      await expect(
        registry.resolveCachedAppServerConfig({
          serverName: 'srv',
          userId: 'user-1',
          role: 'USER',
          mcpConfig: { srv: rawConfig },
          ...allowlists,
        }),
      ).resolves.toEqual({
        serverConfig: storedCachedConfig,
        connectionOwner: 'principal',
      });
      expect(inspectSpy).not.toHaveBeenCalled();
    });

    it('keeps an absent or failed config-cache target unavailable instead of using a same-name base', async () => {
      await registry['cacheConfigsRepo'].add('srv', {
        type: 'streamable-http',
        url: 'https://base.example.com/mcp',
        requiresOAuth: false,
        source: 'yaml',
      });

      await expect(
        registry.resolveCachedAppServerConfig({
          serverName: 'srv',
          userId: 'user-1',
          role: 'USER',
          mcpConfig: { srv: rawConfig },
          ...allowlists,
        }),
      ).resolves.toBeUndefined();

      const key = registry['configCacheKey']('srv', rawConfig, allowlists);
      await registry['configCacheRepo'].add(key, {
        ...rawConfig,
        source: 'config',
        inspectionFailed: true,
      } as t.ParsedServerConfig);
      await expect(
        registry.resolveCachedAppServerConfig({
          serverName: 'srv',
          userId: 'user-1',
          role: 'USER',
          mcpConfig: { srv: rawConfig },
          ...allowlists,
        }),
      ).resolves.toBeUndefined();
    });

    it('uses the operator target for an admitted unmodified YAML config', async () => {
      const yamlConfig = {
        ...rawConfig,
        source: 'yaml' as const,
        requiresOAuth: false,
      } as t.ParsedServerConfig;
      const { config: storedYamlConfig } = await registry['cacheConfigsRepo'].add(
        'srv',
        yamlConfig,
      );

      await expect(
        registry.resolveCachedAppServerConfig({
          serverName: 'srv',
          userId: 'user-1',
          role: 'USER',
          mcpConfig: { srv: rawConfig },
          ...allowlists,
        }),
      ).resolves.toEqual({ serverConfig: storedYamlConfig, connectionOwner: 'operator' });
    });
  });

  describe('reset', () => {
    it('should clear all servers from cache repository', async () => {
      // Add servers to cache using the new API
      await registry.addServer('app_server', testParsedConfig, 'CACHE');
      await registry.addServer('user_server', testParsedConfig, 'CACHE');

      // Verify servers are accessible before reset
      const appConfigBefore = await registry.getServerConfig('app_server');
      const userConfigBefore = await registry.getServerConfig('user_server');
      const allConfigsBefore = await registry.getAllServerConfigs();

      expect(appConfigBefore).toEqual(expect.objectContaining(testParsedConfig));
      expect(userConfigBefore).toEqual(expect.objectContaining(testParsedConfig));
      expect(Object.keys(allConfigsBefore)).toHaveLength(2);

      // Reset everything
      await registry.reset();

      // Verify all servers are cleared after reset
      const appConfigAfter = await registry.getServerConfig('app_server');
      const userConfigAfter = await registry.getServerConfig('user_server');
      const allConfigsAfter = await registry.getAllServerConfigs();

      expect(appConfigAfter).toBeUndefined();
      expect(userConfigAfter).toBeUndefined();
      expect(Object.keys(allConfigsAfter)).toHaveLength(0);
    });
  });

  describe('Storage location routing (getConfigRepository)', () => {
    describe('CACHE storage location', () => {
      it('should route addServer to cache repository', async () => {
        await registry.addServer('cache_server', testParsedConfig, 'CACHE');

        const config = await registry.getServerConfig('cache_server');
        expect(config).toBeDefined();
        expect(config?.type).toBe('stdio');
        if (config && 'command' in config) {
          expect(config.command).toBe('node');
        }
      });

      it('should route updateServer to cache repository', async () => {
        await registry.addServer('cache_server', testParsedConfig, 'CACHE');

        const updatedConfig = { ...testParsedConfig, command: 'python' } as t.ParsedServerConfig;
        await registry.updateServer('cache_server', updatedConfig, 'CACHE');

        const config = await registry.getServerConfig('cache_server');
        expect(config).toBeDefined();
        if (config && 'command' in config) {
          expect(config.command).toBe('python');
        }
      });

      it('separates update inspection from persistence', async () => {
        await registry.addServer('cache_server', testParsedConfig, 'CACHE');
        const updatedConfig = { ...testParsedConfig, command: 'python' } as t.ParsedServerConfig;

        const inspected = await registry.inspectServerUpdate(
          'cache_server',
          updatedConfig,
          'CACHE',
        );

        const beforeCommit = await registry['cacheConfigsRepo'].get('cache_server');
        expect(beforeCommit && 'command' in beforeCommit ? beforeCommit.command : undefined).toBe(
          'node',
        );

        await registry.commitServerUpdate('cache_server', inspected, 'CACHE');

        const afterCommit = await registry['cacheConfigsRepo'].get('cache_server');
        expect(afterCommit && 'command' in afterCommit ? afterCommit.command : undefined).toBe(
          'python',
        );
      });

      it('should route removeServer to cache repository', async () => {
        await registry.addServer('cache_server', testParsedConfig, 'CACHE');
        // Verify server exists in underlying cache repository (not via getServerConfig to avoid populating read-through cache)
        expect(await registry['cacheConfigsRepo'].get('cache_server')).toBeDefined();

        await registry.removeServer('cache_server', 'CACHE');

        // Verify server is removed from underlying cache repository
        const config = await registry['cacheConfigsRepo'].get('cache_server');
        expect(config).toBeUndefined();
      });
    });

    describe('Invalid storage location', () => {
      it('should throw error for unsupported storage location in addServer', async () => {
        await expect(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          registry.addServer('test_server', testParsedConfig, 'INVALID' as any),
        ).rejects.toThrow('The provided storage location "INVALID" is not supported');
      });

      it('should throw error for unsupported storage location in updateServer', async () => {
        await expect(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          registry.updateServer('test_server', testParsedConfig, 'REDIS' as any),
        ).rejects.toThrow('The provided storage location "REDIS" is not supported');
      });

      it('should throw error for unsupported storage location in removeServer', async () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await expect(registry.removeServer('test_server', 'S3' as any)).rejects.toThrow(
          'The provided storage location "S3" is not supported',
        );
      });
    });
  });

  describe('admin API key update binding', () => {
    const bearerConfig: t.MCPOptions = {
      type: 'streamable-http',
      url: 'https://mcp.example.com/mcp',
      proxy: 'http://proxy.example.com/',
      apiKey: {
        source: 'admin',
        authorization_type: 'bearer',
        key: 'owner-secret',
      },
    };
    const customHeaderConfig: t.MCPOptions = {
      ...bearerConfig,
      apiKey: {
        source: 'admin',
        authorization_type: 'custom',
        custom_header: 'X-Owner-Key',
        key: 'owner-secret',
      },
    };
    const rebindingCases: Array<[string, t.MCPOptions, t.MCPOptions, string[]]> = [
      [
        'URL',
        bearerConfig,
        {
          ...bearerConfig,
          url: 'https://attacker.example.com/mcp',
          apiKey: { source: 'admin', authorization_type: 'bearer' },
        },
        ['url'],
      ],
      [
        'transport',
        bearerConfig,
        {
          ...bearerConfig,
          type: 'sse',
          apiKey: { source: 'admin', authorization_type: 'bearer' },
        },
        ['type'],
      ],
      [
        'proxy',
        bearerConfig,
        {
          ...bearerConfig,
          proxy: 'http://attacker.example.com/',
          apiKey: { source: 'admin', authorization_type: 'bearer' },
        },
        ['proxy'],
      ],
      [
        'authorization type',
        bearerConfig,
        {
          ...bearerConfig,
          apiKey: { source: 'admin', authorization_type: 'basic' },
        },
        ['apiKey.authorization_type'],
      ],
      [
        'custom-header binding',
        customHeaderConfig,
        {
          ...customHeaderConfig,
          apiKey: {
            source: 'admin',
            authorization_type: 'custom',
            custom_header: 'X-Attacker-Key',
          },
        },
        ['apiKey.custom_header'],
      ],
    ];

    it.each(rebindingCases)(
      'rejects an omitted-key %s rebinding before outbound inspection',
      async (_label, existingConfig, update, changedFields) => {
        jest.spyOn(registry['dbConfigsRepo'], 'get').mockResolvedValue(existingConfig);
        const inspectSpy = jest.mocked(MCPServerInspector.inspect);
        inspectSpy.mockClear();

        await expect(
          registry.inspectServerUpdate('shared-server', update, 'DB', 'editor-user'),
        ).rejects.toMatchObject({
          code: 'MCP_API_KEY_REENTRY_REQUIRED',
          changedFields,
        });

        expect(inspectSpy).not.toHaveBeenCalled();
      },
    );

    it('preserves the omitted key for an equivalent request boundary', async () => {
      const existingConfig: t.MCPOptions = {
        type: 'streamable-http',
        url: 'https://mcp.example.com/mcp',
        proxy: 'http://proxy.example.com/',
        apiKey: {
          source: 'admin',
          authorization_type: 'custom',
          custom_header: 'X-Api-Key',
          key: 'owner-secret',
        },
      };
      const equivalentUpdate: t.MCPOptions = {
        ...existingConfig,
        type: 'http',
        url: 'https://MCP.EXAMPLE.COM:443/mcp',
        proxy: 'http://PROXY.EXAMPLE.COM:80/',
        description: 'Updated description',
        apiKey: {
          source: 'admin',
          authorization_type: 'custom',
          custom_header: 'x-api-key',
        },
      };
      jest.spyOn(registry['dbConfigsRepo'], 'get').mockResolvedValue(existingConfig);
      const inspectSpy = jest.mocked(MCPServerInspector.inspect);
      inspectSpy.mockClear();

      await registry.inspectServerUpdate('shared-server', equivalentUpdate, 'DB', 'editor-user');

      expect(inspectSpy).toHaveBeenCalledTimes(1);
      expect(inspectSpy).toHaveBeenCalledWith(
        'shared-server',
        expect.objectContaining({
          apiKey: expect.objectContaining({ key: 'owner-secret' }),
        }),
        undefined,
        undefined,
        undefined,
      );
    });
  });

  describe('reinspectServer', () => {
    const stubOptions: t.MCPOptions = {
      type: 'streamable-http',
      url: 'https://recovering.example.com/mcp',
    };

    beforeEach(() => {
      /** The inspector is a module automock, so its recorded calls outlive each test. */
      jest.mocked(MCPServerInspector.inspect).mockClear();
    });

    afterEach(() => {
      jest.setSystemTime(new Date(FIXED_TIME));
    });

    it('resolves a server that is no longer failed to its stored config without inspecting', async () => {
      const { config } = await registry.addServer('healthy_server', testParsedConfig, 'CACHE');
      const inspectSpy = jest.spyOn(MCPServerInspector, 'inspect');
      inspectSpy.mockClear();

      await expect(registry.reinspectServer('healthy_server', 'CACHE')).resolves.toEqual({
        serverName: 'healthy_server',
        config,
      });
      expect(inspectSpy).not.toHaveBeenCalled();
    });

    it('should throw when the server does not exist', async () => {
      await expect(registry.reinspectServer('ghost_server', 'CACHE')).rejects.toThrow(
        'not found in CACHE',
      );
    });

    it('shares one inspection and one write among concurrent callers', async () => {
      await registry.addServerStub('stub_server', stubOptions, 'CACHE');
      const inspectSpy = jest.spyOn(MCPServerInspector, 'inspect');
      const replaceSpy = jest.spyOn(ServerConfigsCacheInMemory.prototype, 'replaceStub');

      const [first, ...joined] = await Promise.all(
        Array.from({ length: 3 }, () => registry.reinspectServer('stub_server', 'CACHE')),
      );

      expect(inspectSpy).toHaveBeenCalledTimes(1);
      expect(replaceSpy).toHaveBeenCalledTimes(1);
      expect(joined).toEqual([first, first]);
      expect(first.config.inspectionFailed).toBeUndefined();
      await expect(registry['cacheConfigsRepo'].get('stub_server')).resolves.toEqual(first.config);
    });

    it('inspects separately under different allowlists and keeps the recovery that landed first', async () => {
      (MCPServersRegistry as unknown as { instance: undefined }).instance = undefined;
      const tenantRegistry = MCPServersRegistry.createInstance(
        mockMongoose,
        null,
        null,
        async (ctx) => ({
          allowedDomains: [`${ctx?.userId}.example.com`],
          allowedAddresses: null,
          mcpApps: { enabled: false, legacyHtmlEnabled: false },
        }),
      );
      await tenantRegistry.reset();
      await tenantRegistry.addServerStub('stub_server', stubOptions, 'CACHE');

      const inspect = jest.mocked(MCPServerInspector.inspect).getMockImplementation()!;
      let releaseTenantA!: () => void;
      const tenantAHeld = new Promise<void>((resolve) => {
        releaseTenantA = resolve;
      });
      let markTenantAInspecting!: () => void;
      const tenantAInspecting = new Promise<void>((resolve) => {
        markTenantAInspecting = resolve;
      });
      const inspectSpy = jest
        .spyOn(MCPServerInspector, 'inspect')
        .mockImplementation(async (serverName, rawConfig, connection, domains, addresses) => {
          const tenant = domains?.[0];
          if (tenant === 'tenant-a.example.com') {
            markTenantAInspecting();
            await tenantAHeld;
          } else {
            await tenantAInspecting;
          }
          const parsed = await inspect(serverName, rawConfig, connection, domains, addresses);
          return { ...parsed, description: tenant };
        });

      const tenantA = tenantRegistry.reinspectServer('stub_server', 'CACHE', 'tenant-a');
      const tenantB = await tenantRegistry.reinspectServer('stub_server', 'CACHE', 'tenant-b');
      releaseTenantA();
      const tenantAResult = await tenantA;

      expect(inspectSpy).toHaveBeenCalledTimes(2);
      expect(tenantB.config.description).toBe('tenant-b.example.com');
      expect(tenantAResult.config).toEqual(tenantB.config);
      await expect(tenantRegistry['cacheConfigsRepo'].get('stub_server')).resolves.toEqual(
        tenantB.config,
      );
    });

    it('does not share a DB reinspection across users', async () => {
      jest.spyOn(registry['dbConfigsRepo'], 'get').mockResolvedValue({
        ...stubOptions,
        source: 'user',
        dbId: 'db-server-id',
        inspectionFailed: true,
        updatedAt: FIXED_TIME,
      });
      const updateSpy = jest.spyOn(registry['dbConfigsRepo'], 'update');
      const inspectSpy = jest.spyOn(MCPServerInspector, 'inspect');

      const [userOne, userOneAgain, userTwo] = await Promise.all([
        registry.reinspectServer('db_server', 'DB', 'user-1'),
        registry.reinspectServer('db_server', 'DB', 'user-1'),
        registry.reinspectServer('db_server', 'DB', 'user-2'),
      ]);

      expect(inspectSpy).toHaveBeenCalledTimes(2);
      expect(userOneAgain).toBe(userOne);
      expect(userTwo).not.toBe(userOne);
      expect(updateSpy.mock.calls.map(([, , userId]) => userId).sort()).toEqual([
        'user-1',
        'user-2',
      ]);
    });

    it('writes nothing when another replica recovered the stub during inspection', async () => {
      await registry.addServerStub('stub_server', stubOptions, 'CACHE');
      const memoized = await registry.getAllServerConfigs();
      const recoveredElsewhere: t.ParsedServerConfig = {
        ...stubOptions,
        description: 'recovered elsewhere',
      };
      const inspect = jest.mocked(MCPServerInspector.inspect).getMockImplementation()!;
      jest.spyOn(MCPServerInspector, 'inspect').mockImplementationOnce(async (...args) => {
        await registry['cacheConfigsRepo'].update('stub_server', recoveredElsewhere);
        return inspect(...args);
      });
      const replaceSpy = jest.spyOn(ServerConfigsCacheInMemory.prototype, 'replaceStub');

      const result = await registry.reinspectServer('stub_server', 'CACHE');

      await expect(replaceSpy.mock.results[0].value).resolves.toBeUndefined();
      expect(result.config).toMatchObject(recoveredElsewhere);
      await expect(registry['cacheConfigsRepo'].get('stub_server')).resolves.toEqual(result.config);
      expect(memoized.stub_server.inspectionFailed).toBe(true);
      await expect(registry.getAllServerConfigs()).resolves.toMatchObject({
        stub_server: { description: 'recovered elsewhere' },
      });
    });

    it('resolves to a recovery stored elsewhere when its own inspection fails', async () => {
      await registry.addServerStub('stub_server', stubOptions, 'CACHE');
      const memoized = await registry.getAllServerConfigs();
      const recoveredElsewhere: t.ParsedServerConfig = {
        ...stubOptions,
        description: 'recovered elsewhere',
      };
      jest.spyOn(MCPServerInspector, 'inspect').mockImplementationOnce(async () => {
        await registry['cacheConfigsRepo'].update('stub_server', recoveredElsewhere);
        throw new Error('connect ECONNREFUSED');
      });

      const result = await registry.reinspectServer('stub_server', 'CACHE');

      expect(result.config).toMatchObject(recoveredElsewhere);
      expect(result.config.inspectionFailed).toBeUndefined();
      expect(memoized.stub_server.inspectionFailed).toBe(true);
      await expect(registry.getAllServerConfigs()).resolves.toMatchObject({
        stub_server: { description: 'recovered elsewhere' },
      });
    });

    it('does not inspect again when a recovery lands while its allowlists resolve', async () => {
      let releaseResolver!: () => void;
      const resolverHeld = new Promise<void>((resolve) => {
        releaseResolver = resolve;
      });
      let markResolving!: () => void;
      const resolving = new Promise<void>((resolve) => {
        markResolving = resolve;
      });
      (MCPServersRegistry as unknown as { instance: undefined }).instance = undefined;
      const slowRegistry = MCPServersRegistry.createInstance(
        mockMongoose,
        null,
        null,
        async (ctx) => {
          if (ctx?.userId === 'slow-user') {
            markResolving();
            await resolverHeld;
          }
          return {
            allowedDomains: null,
            allowedAddresses: null,
            mcpApps: { enabled: false, legacyHtmlEnabled: false },
          };
        },
      );
      await slowRegistry.reset();
      await slowRegistry.addServerStub('stub_server', stubOptions, 'CACHE');
      const inspectSpy = jest.spyOn(MCPServerInspector, 'inspect');

      const slow = slowRegistry.reinspectServer('stub_server', 'CACHE', 'slow-user');
      await resolving;
      const recovered = await slowRegistry.reinspectServer('stub_server', 'CACHE', 'fast-user');
      releaseResolver();

      await expect(slow).resolves.toEqual(recovered);
      expect(inspectSpy).toHaveBeenCalledTimes(1);
    });

    it('inspects the newer stub when a registry re-initialization replaced the inspected one', async () => {
      await registry.addServerStub('stub_server', stubOptions, 'CACHE');
      const movedOptions: t.MCPOptions = { ...stubOptions, url: 'https://moved.example.com/mcp' };
      const inspect = jest.mocked(MCPServerInspector.inspect).getMockImplementation()!;
      const inspectSpy = jest
        .spyOn(MCPServerInspector, 'inspect')
        .mockImplementationOnce(async (...args) => {
          jest.setSystemTime(new Date(FIXED_TIME + 1000));
          await registry['cacheConfigsRepo'].update('stub_server', {
            ...movedOptions,
            source: 'yaml',
            inspectionFailed: true,
          });
          return inspect(...args);
        });

      const result = await registry.reinspectServer('stub_server', 'CACHE');

      expect(inspectSpy).toHaveBeenCalledTimes(2);
      expect(inspectSpy.mock.calls[1][1]).toMatchObject(movedOptions);
      expect(result.config).toMatchObject(movedOptions);
      expect(result.config.inspectionFailed).toBeUndefined();
      await expect(registry['cacheConfigsRepo'].get('stub_server')).resolves.toEqual(result.config);
    });

    it('does not answer a caller that read a newer stub with the inspection of the one it replaced', async () => {
      await registry.addServerStub('stub_server', stubOptions, 'CACHE');
      const movedOptions: t.MCPOptions = { ...stubOptions, url: 'https://moved.example.com/mcp' };
      const inspect = jest.mocked(MCPServerInspector.inspect).getMockImplementation()!;
      let releaseReplaced!: () => void;
      const replacedHeld = new Promise<void>((resolve) => {
        releaseReplaced = resolve;
      });
      let markReplacedInspecting!: () => void;
      const replacedInspecting = new Promise<void>((resolve) => {
        markReplacedInspecting = resolve;
      });
      const inspectSpy = jest
        .spyOn(MCPServerInspector, 'inspect')
        .mockImplementationOnce(async (...args) => {
          markReplacedInspecting();
          await replacedHeld;
          return inspect(...args);
        });

      const replaced = registry.reinspectServer('stub_server', 'CACHE');
      await replacedInspecting;
      jest.setSystemTime(new Date(FIXED_TIME + 1000));
      await registry['cacheConfigsRepo'].update('stub_server', {
        ...movedOptions,
        source: 'yaml',
        inspectionFailed: true,
      });

      const current = await registry.reinspectServer('stub_server', 'CACHE');
      expect(inspectSpy).toHaveBeenCalledTimes(2);
      expect(inspectSpy.mock.calls[1][1]).toMatchObject(movedOptions);
      expect(current.config).toMatchObject(movedOptions);

      releaseReplaced();
      await expect(replaced).resolves.toEqual(current);
      expect(inspectSpy).toHaveBeenCalledTimes(2);
      await expect(registry['cacheConfigsRepo'].get('stub_server')).resolves.toEqual(
        current.config,
      );
    });

    it('adopts the outcome of the flight another request started for a newer stub', async () => {
      await registry.addServerStub('stub_server', stubOptions, 'CACHE');
      const movedOptions: t.MCPOptions = { ...stubOptions, url: 'https://moved.example.com/mcp' };
      const inspect = jest.mocked(MCPServerInspector.inspect).getMockImplementation()!;
      let releaseReplaced!: () => void;
      const replacedHeld = new Promise<void>((resolve) => {
        releaseReplaced = resolve;
      });
      let markReplacedInspecting!: () => void;
      const replacedInspecting = new Promise<void>((resolve) => {
        markReplacedInspecting = resolve;
      });
      let releaseNewer!: () => void;
      const newerHeld = new Promise<void>((resolve) => {
        releaseNewer = resolve;
      });
      let markNewerInspecting!: () => void;
      const newerInspecting = new Promise<void>((resolve) => {
        markNewerInspecting = resolve;
      });
      const inspectSpy = jest
        .spyOn(MCPServerInspector, 'inspect')
        .mockImplementationOnce(async (...args) => {
          markReplacedInspecting();
          await replacedHeld;
          return inspect(...args);
        })
        .mockImplementationOnce(async (...args) => {
          markNewerInspecting();
          await newerHeld;
          return inspect(...args);
        })
        .mockRejectedValue(new Error('connect ECONNREFUSED'));

      const replaced = registry.reinspectServer('stub_server', 'CACHE');
      await replacedInspecting;
      jest.setSystemTime(new Date(FIXED_TIME + 1000));
      await registry['cacheConfigsRepo'].update('stub_server', {
        ...movedOptions,
        source: 'yaml',
        inspectionFailed: true,
      });
      const newer = registry.reinspectServer('stub_server', 'CACHE');
      await newerInspecting;

      releaseReplaced();
      /** The store is promise-only, so one real macrotask lets the replaced flight settle as far
       *  as it can while the newer flight is still held. */
      await new Promise<void>((resolve) => realSetImmediate(resolve));
      releaseNewer();
      const [replacedResult, newerResult] = await Promise.all([replaced, newer]);

      expect(inspectSpy).toHaveBeenCalledTimes(2);
      expect(newerResult.config).toMatchObject(movedOptions);
      expect(newerResult.config.inspectionFailed).toBeUndefined();
      expect(replacedResult).toEqual(newerResult);
    });

    it('adopts the outcome of the flight for a replacement stored with an older timestamp', async () => {
      jest.setSystemTime(new Date(FIXED_TIME + 1000));
      await registry.addServerStub('stub_server', stubOptions, 'CACHE');
      const skewedOptions: t.MCPOptions = { ...stubOptions, url: 'https://skewed.example.com/mcp' };
      const inspect = jest.mocked(MCPServerInspector.inspect).getMockImplementation()!;
      let releaseReplaced!: () => void;
      const replacedHeld = new Promise<void>((resolve) => {
        releaseReplaced = resolve;
      });
      let markReplacedInspecting!: () => void;
      const replacedInspecting = new Promise<void>((resolve) => {
        markReplacedInspecting = resolve;
      });
      let releaseSkewed!: () => void;
      const skewedHeld = new Promise<void>((resolve) => {
        releaseSkewed = resolve;
      });
      let markSkewedInspecting!: () => void;
      const skewedInspecting = new Promise<void>((resolve) => {
        markSkewedInspecting = resolve;
      });
      const inspectSpy = jest
        .spyOn(MCPServerInspector, 'inspect')
        .mockImplementationOnce(async (...args) => {
          markReplacedInspecting();
          await replacedHeld;
          return inspect(...args);
        })
        .mockImplementationOnce(async (...args) => {
          markSkewedInspecting();
          await skewedHeld;
          return inspect(...args);
        })
        .mockRejectedValue(new Error('connect ECONNREFUSED'));

      const replaced = registry.reinspectServer('stub_server', 'CACHE');
      await replacedInspecting;
      jest.setSystemTime(new Date(FIXED_TIME));
      await registry['cacheConfigsRepo'].update('stub_server', {
        ...skewedOptions,
        source: 'yaml',
        inspectionFailed: true,
      });
      const skewed = registry.reinspectServer('stub_server', 'CACHE');
      await skewedInspecting;

      releaseReplaced();
      /** The store is promise-only, so one real macrotask lets the replaced flight settle as far
       *  as it can while the skewed flight is still held. */
      await new Promise<void>((resolve) => realSetImmediate(resolve));
      releaseSkewed();
      const [replacedResult, skewedResult] = await Promise.all([replaced, skewed]);

      expect(inspectSpy).toHaveBeenCalledTimes(2);
      expect(skewedResult.config).toMatchObject(skewedOptions);
      expect(skewedResult.config.inspectionFailed).toBeUndefined();
      expect(replacedResult).toEqual(skewedResult);
    });

    it('breaks a mutual wait by inspecting within the flight that would close it', async () => {
      await registry.addServerStub('stub_server', stubOptions, 'CACHE');
      const movedOptions: t.MCPOptions = { ...stubOptions, url: 'https://moved.example.com/mcp' };
      const restoredOptions: t.MCPOptions = {
        ...stubOptions,
        url: 'https://restored.example.com/mcp',
      };
      const inspect = jest.mocked(MCPServerInspector.inspect).getMockImplementation()!;
      let releaseFirst!: () => void;
      const firstHeld = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      let markFirstInspecting!: () => void;
      const firstInspecting = new Promise<void>((resolve) => {
        markFirstInspecting = resolve;
      });
      let releaseMoved!: () => void;
      const movedHeld = new Promise<void>((resolve) => {
        releaseMoved = resolve;
      });
      let markMovedInspecting!: () => void;
      const movedInspecting = new Promise<void>((resolve) => {
        markMovedInspecting = resolve;
      });
      const inspectSpy = jest
        .spyOn(MCPServerInspector, 'inspect')
        .mockImplementationOnce(async (...args) => {
          markFirstInspecting();
          await firstHeld;
          return inspect(...args);
        })
        .mockImplementationOnce(async (...args) => {
          markMovedInspecting();
          await movedHeld;
          return inspect(...args);
        });

      const first = registry.reinspectServer('stub_server', 'CACHE');
      await firstInspecting;
      jest.setSystemTime(new Date(FIXED_TIME + 1000));
      await registry['cacheConfigsRepo'].update('stub_server', {
        ...movedOptions,
        source: 'yaml',
        inspectionFailed: true,
      });
      const moved = registry.reinspectServer('stub_server', 'CACHE');
      await movedInspecting;

      releaseFirst();
      await new Promise<void>((resolve) => realSetImmediate(resolve));
      /** A stub carrying the first flight's `updatedAt` again, which only clock skew can write,
       *  makes the flight the first one now waits on settle into the first one's key. */
      jest.setSystemTime(new Date(FIXED_TIME));
      await registry['cacheConfigsRepo'].update('stub_server', {
        ...restoredOptions,
        source: 'yaml',
        inspectionFailed: true,
      });
      releaseMoved();
      const [firstResult, movedResult] = await Promise.all([first, moved]);

      expect(inspectSpy).toHaveBeenCalledTimes(3);
      expect(inspectSpy.mock.calls[2][1]).toMatchObject(restoredOptions);
      expect(movedResult.config).toMatchObject(restoredOptions);
      expect(firstResult).toEqual(movedResult);
      await expect(registry['cacheConfigsRepo'].get('stub_server')).resolves.toEqual(
        movedResult.config,
      );
    });

    it('rejects instead of waiting on itself when storage leaves the inspected stub in place', async () => {
      await registry.addServerStub('stub_server', stubOptions, 'CACHE');
      jest
        .spyOn(ServerConfigsCacheInMemory.prototype, 'replaceStub')
        .mockResolvedValueOnce(undefined);

      await expect(registry.reinspectServer('stub_server', 'CACHE')).rejects.toThrow(
        MCPInspectionFailedError,
      );
      await expect(registry['cacheConfigsRepo'].get('stub_server')).resolves.toMatchObject({
        inspectionFailed: true,
      });

      const retried = await registry.reinspectServer('stub_server', 'CACHE');
      expect(retried.config.inspectionFailed).toBeUndefined();
    });

    it('rejects every concurrent caller while the server is unreachable, then retries on the next call', async () => {
      await registry.addServerStub('stub_server', stubOptions, 'CACHE');
      const inspectSpy = jest.spyOn(MCPServerInspector, 'inspect');
      inspectSpy.mockRejectedValueOnce(new Error('connect ECONNREFUSED'));

      const outcomes = await Promise.allSettled([
        registry.reinspectServer('stub_server', 'CACHE'),
        registry.reinspectServer('stub_server', 'CACHE'),
      ]);

      expect(inspectSpy).toHaveBeenCalledTimes(1);
      for (const outcome of outcomes) {
        expect(outcome).toMatchObject({
          status: 'rejected',
          reason: expect.any(MCPInspectionFailedError),
        });
      }
      await expect(registry['cacheConfigsRepo'].get('stub_server')).resolves.toMatchObject({
        inspectionFailed: true,
      });

      const retried = await registry.reinspectServer('stub_server', 'CACHE');
      expect(inspectSpy).toHaveBeenCalledTimes(2);
      expect(retried.config.inspectionFailed).toBeUndefined();
    });
  });

  describe('recoverServerConfig', () => {
    const stubOptions: t.MCPOptions = {
      type: 'streamable-http',
      url: 'https://recovering.example.com/mcp',
    };

    it('returns a config that did not fail inspection as is', async () => {
      const config: t.ParsedServerConfig = { ...stubOptions, source: 'yaml' };
      const reinspectSpy = jest.spyOn(registry, 'reinspectServer');

      await expect(registry.recoverServerConfig('healthy_server', config)).resolves.toBe(config);
      expect(reinspectSpy).not.toHaveBeenCalled();
    });

    it('leaves a config-tier stub to the config cache retry', async () => {
      const reinspectSpy = jest.spyOn(registry, 'reinspectServer');

      await expect(
        registry.recoverServerConfig('config_server', {
          ...stubOptions,
          source: 'config',
          inspectionFailed: true,
        }),
      ).resolves.toBeUndefined();
      expect(reinspectSpy).not.toHaveBeenCalled();
    });

    it('returns the recovered config for a stub', async () => {
      const { config: stub } = await registry.addServerStub('stub_server', stubOptions, 'CACHE');

      const recovered = await registry.recoverServerConfig('stub_server', stub, 'user-1');

      expect(recovered?.inspectionFailed).toBeUndefined();
      await expect(registry['cacheConfigsRepo'].get('stub_server')).resolves.toEqual(recovered);
    });

    it('returns the stored config when another request already recovered the server', async () => {
      const { config: stub } = await registry.addServerStub('stub_server', stubOptions, 'CACHE');
      const { config: recoveredElsewhere } = await registry.reinspectServer('stub_server', 'CACHE');
      const inspectSpy = jest.spyOn(MCPServerInspector, 'inspect');
      inspectSpy.mockClear();

      await expect(registry.recoverServerConfig('stub_server', stub, 'user-1')).resolves.toEqual(
        recoveredElsewhere,
      );
      expect(inspectSpy).not.toHaveBeenCalled();
    });

    it('returns undefined while the server is still unreachable', async () => {
      const { config: stub } = await registry.addServerStub('stub_server', stubOptions, 'CACHE');
      jest
        .spyOn(MCPServerInspector, 'inspect')
        .mockRejectedValueOnce(new Error('connect ECONNREFUSED'));

      await expect(
        registry.recoverServerConfig('stub_server', stub, 'user-1'),
      ).resolves.toBeUndefined();
      await expect(registry['cacheConfigsRepo'].get('stub_server')).resolves.toMatchObject({
        inspectionFailed: true,
      });
    });

    it('reinspects a user-sourced stub in DB storage for that user', async () => {
      const reinspectSpy = jest.spyOn(registry, 'reinspectServer');

      await registry.recoverServerConfig(
        'db_server',
        { ...stubOptions, source: 'user', inspectionFailed: true },
        'user-1',
      );

      expect(reinspectSpy).toHaveBeenCalledWith('db_server', 'DB', 'user-1');
    });
  });

  describe('Read-through cache', () => {
    describe('getServerConfig', () => {
      it('should cache repeated calls for the same server', async () => {
        // Add a server to the cache repository
        await registry['cacheConfigsRepo'].add('test_server', testParsedConfig);

        // Spy on the cache repository get method
        const cacheRepoGetSpy = jest.spyOn(registry['cacheConfigsRepo'], 'get');

        // First call should hit the cache repository
        const config1 = await registry.getServerConfig('test_server');
        expect(config1).toEqual(testParsedConfig);
        expect(cacheRepoGetSpy).toHaveBeenCalledTimes(1);

        // Second call should hit the read-through cache, not the repository
        const config2 = await registry.getServerConfig('test_server');
        expect(config2).toEqual(testParsedConfig);
        expect(cacheRepoGetSpy).toHaveBeenCalledTimes(1); // Still 1, not 2

        // Third call should also hit the read-through cache
        const config3 = await registry.getServerConfig('test_server');
        expect(config3).toEqual(testParsedConfig);
        expect(cacheRepoGetSpy).toHaveBeenCalledTimes(1); // Still 1
      });

      it('should cache "not found" results to avoid repeated DB lookups', async () => {
        // Spy on the DB repository get method
        const dbRepoGetSpy = jest.spyOn(registry['dbConfigsRepo'], 'get');

        // First call - server doesn't exist, should hit DB
        const config1 = await registry.getServerConfig('nonexistent_server');
        expect(config1).toBeUndefined();
        expect(dbRepoGetSpy).toHaveBeenCalledTimes(1);

        // Second call - should hit read-through cache, not DB
        const config2 = await registry.getServerConfig('nonexistent_server');
        expect(config2).toBeUndefined();
        expect(dbRepoGetSpy).toHaveBeenCalledTimes(1); // Still 1, not 2
      });

      it('should use different cache keys for different userIds', async () => {
        await registry['cacheConfigsRepo'].add('test_server', testParsedConfig);
        const cacheRepoGetSpy = jest.spyOn(registry['cacheConfigsRepo'], 'get');

        await registry.getServerConfig('test_server');
        expect(cacheRepoGetSpy).toHaveBeenCalledTimes(1);

        await registry.getServerConfig('test_server', 'user123');
        expect(cacheRepoGetSpy).toHaveBeenCalledTimes(2);

        await registry.getServerConfig('test_server', 'user123');
        expect(cacheRepoGetSpy).toHaveBeenCalledTimes(2);

        await registry.getServerConfig('test_server', 'user456');
        expect(cacheRepoGetSpy).toHaveBeenCalledTimes(3);
      });
    });

    describe('getAllServerConfigs', () => {
      it('should cache repeated calls', async () => {
        // Add servers to cache
        await registry['cacheConfigsRepo'].add('server1', testParsedConfig);
        await registry['cacheConfigsRepo'].add('server2', testParsedConfig);

        // Spy on the cache repository getAll method
        const cacheRepoGetAllSpy = jest.spyOn(registry['cacheConfigsRepo'], 'getAll');

        // First call should hit the repository
        const configs1 = await registry.getAllServerConfigs();
        expect(Object.keys(configs1)).toHaveLength(2);
        expect(cacheRepoGetAllSpy).toHaveBeenCalledTimes(1);

        // Second call should hit the read-through cache
        const configs2 = await registry.getAllServerConfigs();
        expect(Object.keys(configs2)).toHaveLength(2);
        expect(cacheRepoGetAllSpy).toHaveBeenCalledTimes(1); // Still 1

        // Third call should also hit the read-through cache
        const configs3 = await registry.getAllServerConfigs();
        expect(Object.keys(configs3)).toHaveLength(2);
        expect(cacheRepoGetAllSpy).toHaveBeenCalledTimes(1); // Still 1
      });

      it('should use different cache keys for different userIds', async () => {
        // Spy on the cache repository getAll method
        const cacheRepoGetAllSpy = jest.spyOn(registry['cacheConfigsRepo'], 'getAll');

        // First call without userId
        await registry.getAllServerConfigs();
        expect(cacheRepoGetAllSpy).toHaveBeenCalledTimes(1);

        // Call with userId - should be a different cache key
        await registry.getAllServerConfigs('user123');
        expect(cacheRepoGetAllSpy).toHaveBeenCalledTimes(2);

        // Repeat call with same userId - should hit read-through cache
        await registry.getAllServerConfigs('user123');
        expect(cacheRepoGetAllSpy).toHaveBeenCalledTimes(2); // Still 2

        // Call with different userId - should hit repository
        await registry.getAllServerConfigs('user456');
        expect(cacheRepoGetAllSpy).toHaveBeenCalledTimes(3);
      });
    });

    /** A replica running older code fills these stores from its own DB reads, so a
     *  cache hit has to carry the same normalization the repository applies. */
    describe('configs stored by an older replica', () => {
      const storedByOlderReplica = {
        type: 'streamable-http',
        url: 'https://example.com/mcp',
        source: 'user',
        dbId: 'db-legacy-1',
        requiresOAuth: true,
        headers: null,
        requestHeaders: null,
      } as unknown as t.ParsedServerConfig;

      it('normalizes null header maps served from a per-server cache hit', async () => {
        const dbGet = jest
          .spyOn(registry['dbConfigsRepo'], 'get')
          .mockResolvedValue(storedByOlderReplica);

        await registry.getServerConfig('legacy_server', 'user-1');
        expect(dbGet).toHaveBeenCalledTimes(1);

        const cached = await registry.getServerConfig('legacy_server', 'user-1');
        expect(dbGet).toHaveBeenCalledTimes(1);
        expect(cached).toMatchObject({ dbId: 'db-legacy-1', source: 'user' });
        expect(cached).not.toHaveProperty('headers');
        expect(cached).not.toHaveProperty('requestHeaders');
        expect(() => getMCPAppToolsPublicationGeneration(cached!)).not.toThrow();
      });

      it('normalizes null header maps served from an all-servers cache hit', async () => {
        const dbGetAll = jest
          .spyOn(registry['dbConfigsRepo'], 'getAll')
          .mockResolvedValue({ legacy_server: storedByOlderReplica });

        await registry.getAllServerConfigs('user-1');
        expect(dbGetAll).toHaveBeenCalledTimes(1);

        /** Drop this replica's process memo only; the shared entry stays as the
         *  older replica encoded it, which is what another pod would read. */
        registry['readThroughCacheAll']['memo'].clear();

        const cached = (await registry.getAllServerConfigs('user-1')).legacy_server;
        expect(dbGetAll).toHaveBeenCalledTimes(1);
        expect(cached).toMatchObject({ dbId: 'db-legacy-1', source: 'user' });
        expect(cached).not.toHaveProperty('headers');
        expect(cached).not.toHaveProperty('requestHeaders');
        expect(() => getMCPAppToolsPublicationGeneration(cached)).not.toThrow();
      });

      it('preserves populated header maps across both cache hits', async () => {
        const headers = { 'X-Shared': 'value' };
        const requestHeaders = { 'X-Request': 'value' };
        const config = { ...storedByOlderReplica, headers, requestHeaders };
        jest.spyOn(registry['dbConfigsRepo'], 'get').mockResolvedValue(config);
        jest
          .spyOn(registry['dbConfigsRepo'], 'getAll')
          .mockResolvedValue({ header_server: config });

        await registry.getServerConfig('header_server', 'user-1');
        await registry.getAllServerConfigs('user-1');
        registry['readThroughCacheAll']['memo'].clear();

        const single = await registry.getServerConfig('header_server', 'user-1');
        const all = (await registry.getAllServerConfigs('user-1')).header_server;
        for (const cached of [single, all]) {
          expect(cached).toMatchObject({ headers, requestHeaders });
          expect(() => getMCPAppToolsPublicationGeneration(cached!)).not.toThrow();
        }
      });
    });
  });

  describe('admin-panel overrides for YAML-defined servers', () => {
    const yamlLangfuseConfig = Object.freeze({
      type: 'streamable-http',
      url: 'https://langfuse.com/api/public/mcp',
      requiresOAuth: false,
      source: 'yaml',
      updatedAt: FIXED_TIME,
    }) as t.ParsedServerConfig;

    it('flows config-tier override on a YAML-defined server through to getAllServerConfigs', async () => {
      await registry['cacheConfigsRepo'].add('langfuse-docs', yamlLangfuseConfig);

      const overrideRawConfig: t.MCPOptions = {
        type: 'streamable-http',
        url: 'https://langfuse.com/api/public/mcp',
        requiresOAuth: false,
        iconPath: 'https://example.com/icon.svg',
      };

      const configServers = await registry.ensureConfigServers({
        'langfuse-docs': overrideRawConfig,
      });

      expect(configServers['langfuse-docs']).toBeDefined();
      expect(configServers['langfuse-docs'].iconPath).toBe('https://example.com/icon.svg');

      const result = await registry.getAllServerConfigs('user-1', configServers);

      expect(result['langfuse-docs']).toBeDefined();
      expect(result['langfuse-docs'].iconPath).toBe('https://example.com/icon.svg');
      expect(result['langfuse-docs'].source).toBe('yaml');
    });

    it.each([
      ['oauthRefreshWaitTimeout', 25000],
      ['oauthPersistenceWaitTimeout', 60000],
      ['oauthRefreshCoordination', true],
    ] as const)('retains an admin-only %s override', async (field, value) => {
      await registry['cacheConfigsRepo'].add('langfuse-docs', yamlLangfuseConfig);
      const configServers = await registry.ensureConfigServers({
        'langfuse-docs': { ...yamlLangfuseConfig, [field]: value },
      });
      expect(configServers['langfuse-docs'][field]).toBe(value);
      const result = await registry.getAllServerConfigs('user-1', configServers);
      expect(result['langfuse-docs'][field]).toBe(value);
    });

    it('preserves user-DB tier (source: "user") over config-tier overrides', async () => {
      const userDbEntry: t.ParsedServerConfig = {
        type: 'streamable-http',
        url: 'https://user-defined.example.com/mcp',
        requiresOAuth: false,
        source: 'user',
        dbId: 'user-db-id-123',
        updatedAt: FIXED_TIME,
      };

      jest
        .spyOn(registry['dbConfigsRepo'], 'getAll')
        .mockResolvedValue({ 'shared-server': userDbEntry });

      const configTierOverride: t.ParsedServerConfig = {
        type: 'streamable-http',
        url: 'https://admin-override.example.com/mcp',
        requiresOAuth: false,
        source: 'config',
        iconPath: 'https://example.com/admin-icon.svg',
        updatedAt: FIXED_TIME,
      };

      const result = await registry.getAllServerConfigs('user-1', {
        'shared-server': configTierOverride,
      });

      expect(result['shared-server']).toBeDefined();
      expect(result['shared-server'].source).toBe('user');
      expect(result['shared-server'].url).toBe('https://user-defined.example.com/mcp');
      expect(result['shared-server'].dbId).toBe('user-db-id-123');
    });

    it('still runs lazy-init for pure config-tier servers not present in YAML', async () => {
      const configOnlyRawConfig: t.MCPOptions = {
        type: 'streamable-http',
        url: 'https://config-only.example.com/mcp',
        requiresOAuth: false,
        iconPath: 'https://example.com/config-only-icon.svg',
      };

      const inspectSpy = jest.spyOn(MCPServerInspector, 'inspect');
      inspectSpy.mockClear();

      const result = await registry.ensureConfigServers({
        'config-only-server': configOnlyRawConfig,
      });

      expect(inspectSpy).toHaveBeenCalledTimes(1);
      expect(inspectSpy).toHaveBeenCalledWith(
        'config-only-server',
        {
          ...configOnlyRawConfig,
          source: 'config',
        },
        undefined,
        undefined,
        undefined,
      );
      expect(result['config-only-server']).toBeDefined();
      expect(result['config-only-server'].iconPath).toBe(
        'https://example.com/config-only-icon.svg',
      );
      expect(result['config-only-server'].source).toBe('config');
    });

    it('lets duplicate cold initializations share one pending owner slot', async () => {
      let releaseInspection!: () => void;
      const inspectionGate = new Promise<void>((resolve) => {
        releaseInspection = resolve;
      });
      const inspectSpy = jest.spyOn(MCPServerInspector, 'inspect');
      inspectSpy.mockClear();
      inspectSpy.mockImplementationOnce(async (_serverName, rawConfig) => {
        await inspectionGate;
        return { ...testParsedConfig, ...rawConfig } as t.ParsedServerConfig;
      });
      const limitCalls = jest.fn();
      const limit = <T>(task: () => Promise<T>): Promise<T> => {
        limitCalls();
        return task();
      };
      const config = {
        shared: {
          type: 'streamable-http' as const,
          url: 'https://shared.example.com/mcp',
        },
      };

      const first = registry.ensureConfigServers(config, limit);
      const second = registry.ensureConfigServers(config, limit);
      await Promise.resolve();
      await Promise.resolve();
      releaseInspection();

      await expect(Promise.all([first, second])).resolves.toHaveLength(2);
      expect(inspectSpy).toHaveBeenCalledTimes(1);
      expect(limitCalls).toHaveBeenCalledTimes(1);
    });

    it('lets a healthy joiner replace a canceled pending initialization', async () => {
      let rejectOwner!: (error: Error) => void;
      const ownerGate = new Promise<never>((_resolve, reject) => {
        rejectOwner = reject;
      });
      const config = {
        shared: {
          type: 'streamable-http' as const,
          url: 'https://shared.example.com/mcp',
        },
      };
      const canceledLimitCalls = jest.fn();
      const canceledLimit = <T>(_task: () => Promise<T>): Promise<T> => {
        canceledLimitCalls();
        return ownerGate;
      };
      const healthyLimitCalls = jest.fn();
      const healthyLimit = <T>(task: () => Promise<T>): Promise<T> => {
        healthyLimitCalls();
        return task();
      };

      const canceled = registry.ensureConfigServers(config, canceledLimit);
      const healthy = registry.ensureConfigServers(config, healthyLimit);
      await Promise.resolve();
      rejectOwner(new MCPConfigInitializationCanceledError());

      await expect(canceled).resolves.toEqual({});
      await expect(healthy).resolves.toHaveProperty('shared');
      expect(canceledLimitCalls).toHaveBeenCalledTimes(1);
      expect(healthyLimitCalls).toHaveBeenCalledTimes(1);
    });

    it('preserves YAML base entry when config-tier override reports inspectionFailed', async () => {
      const yamlSeed: t.ParsedServerConfig = {
        type: 'streamable-http',
        url: 'https://langfuse.com/api/public/mcp',
        requiresOAuth: false,
        headers: { Authorization: 'Bearer yaml-token' },
        source: 'yaml',
        tools: 'yaml_tool_a, yaml_tool_b',
        capabilities: '{"tools":{"listChanged":true}}',
        updatedAt: FIXED_TIME,
      };
      await registry['cacheConfigsRepo'].add('langfuse-docs', yamlSeed);

      const failedOverride: t.ParsedServerConfig = {
        type: 'streamable-http',
        url: 'https://langfuse.com/api/public/mcp',
        requiresOAuth: false,
        source: 'config',
        inspectionFailed: true,
        updatedAt: FIXED_TIME,
      };

      const result = await registry.getAllServerConfigs('user-1', {
        'langfuse-docs': failedOverride,
      });

      expect(result['langfuse-docs']).toBeDefined();
      expect(result['langfuse-docs'].source).toBe('yaml');
      expect(result['langfuse-docs'].inspectionFailed).toBeUndefined();
      expect(result['langfuse-docs'].tools).toBe('yaml_tool_a, yaml_tool_b');
      expect(result['langfuse-docs'].capabilities).toBe('{"tools":{"listChanged":true}}');
      expect((result['langfuse-docs'] as t.StreamableHTTPOptions).headers).toEqual({
        Authorization: 'Bearer yaml-token',
      });
    });

    it('healthy YAML entry survives end-to-end when inspect throws for YAML server', async () => {
      await registry['cacheConfigsRepo'].add('langfuse-docs', yamlLangfuseConfig);
      const inspectSpy = jest.spyOn(MCPServerInspector, 'inspect');
      inspectSpy.mockClear();
      inspectSpy.mockRejectedValueOnce(new Error('network timeout'));

      const configServers = await registry.ensureConfigServers({
        'langfuse-docs': {
          type: 'streamable-http',
          url: 'https://langfuse.com/api/public/mcp',
          iconPath: 'https://example.com/icon.svg',
        } as t.MCPOptions,
      });
      const result = await registry.getAllServerConfigs('user-1', configServers);

      expect(result['langfuse-docs'].source).toBe('yaml');
      expect(result['langfuse-docs'].inspectionFailed).toBeUndefined();
      expect(result['langfuse-docs'].url).toBe('https://langfuse.com/api/public/mcp');
    });

    it('preserves YAML source tag when config-tier override succeeds', async () => {
      const yamlSeed: t.ParsedServerConfig = {
        type: 'streamable-http',
        url: 'https://langfuse.com/api/public/mcp',
        requiresOAuth: false,
        source: 'yaml',
        updatedAt: FIXED_TIME,
      };
      await registry['cacheConfigsRepo'].add('langfuse-docs', yamlSeed);

      const successfulOverride: t.ParsedServerConfig = {
        type: 'streamable-http',
        url: 'https://langfuse.com/api/public/mcp',
        requiresOAuth: false,
        source: 'config',
        iconPath: 'https://example.com/icon.svg',
        updatedAt: FIXED_TIME,
      };

      const result = await registry.getAllServerConfigs('user-1', {
        'langfuse-docs': successfulOverride,
      });

      expect(result['langfuse-docs']).toBeDefined();
      expect(result['langfuse-docs'].source).toBe('yaml');
      expect(result['langfuse-docs'].iconPath).toBe('https://example.com/icon.svg');
    });

    it('skips lazy-init for YAML server with no admin override', async () => {
      const yamlSeed: t.ParsedServerConfig = {
        type: 'streamable-http',
        url: 'https://langfuse.com/api/public/mcp',
        requiresOAuth: false,
        source: 'yaml',
        updatedAt: FIXED_TIME,
      };
      await registry['cacheConfigsRepo'].add('langfuse-docs', yamlSeed);

      const yamlRawConfig: t.MCPOptions = {
        type: 'streamable-http',
        url: 'https://langfuse.com/api/public/mcp',
        requiresOAuth: false,
      };

      const inspectSpy = jest.spyOn(MCPServerInspector, 'inspect');
      inspectSpy.mockClear();

      const result = await registry.ensureConfigServers({
        'langfuse-docs': yamlRawConfig,
      });

      expect(inspectSpy).not.toHaveBeenCalled();
      expect(result['langfuse-docs']).toBeUndefined();
    });

    it('runs lazy-init for YAML server with admin override', async () => {
      const yamlSeed: t.ParsedServerConfig = {
        type: 'streamable-http',
        url: 'https://langfuse.com/api/public/mcp',
        requiresOAuth: false,
        source: 'yaml',
        updatedAt: FIXED_TIME,
      };
      await registry['cacheConfigsRepo'].add('langfuse-docs', yamlSeed);

      const overrideRawConfig: t.MCPOptions = {
        type: 'streamable-http',
        url: 'https://langfuse.com/api/public/mcp',
        requiresOAuth: false,
        iconPath: 'https://x.com/icon.svg',
      };

      const inspectSpy = jest.spyOn(MCPServerInspector, 'inspect');
      inspectSpy.mockClear();

      await registry.ensureConfigServers({
        'langfuse-docs': overrideRawConfig,
      });

      expect(inspectSpy).toHaveBeenCalledTimes(1);
    });

    it('getServerConfig falls through to YAML on failure stub', async () => {
      const yamlSeed: t.ParsedServerConfig = {
        type: 'streamable-http',
        url: 'https://langfuse.com/api/public/mcp',
        requiresOAuth: false,
        source: 'yaml',
        tools: 'yaml_tool_a',
        updatedAt: FIXED_TIME,
      };
      await registry['cacheConfigsRepo'].add('langfuse-docs', yamlSeed);

      const failureStub: t.ParsedServerConfig = {
        type: 'streamable-http',
        url: 'https://langfuse.com/api/public/mcp',
        requiresOAuth: false,
        source: 'config',
        inspectionFailed: true,
        updatedAt: FIXED_TIME,
      };

      const result = await registry.getServerConfig('langfuse-docs', 'user-1', {
        'langfuse-docs': failureStub,
      });

      expect(result).toBeDefined();
      expect(result?.source).toBe('yaml');
      expect(result?.inspectionFailed).toBeUndefined();
      expect(result?.tools).toBe('yaml_tool_a');
    });

    it('passes a fully merged config to lazy-init when override only adds new fields', async () => {
      const yamlSeed: t.ParsedServerConfig = {
        type: 'streamable-http',
        url: 'https://langfuse.com/api/public/mcp',
        requiresOAuth: false,
        headers: { Authorization: 'Bearer yaml-token' },
        source: 'yaml',
        updatedAt: FIXED_TIME,
      };
      await registry['cacheConfigsRepo'].add('langfuse-docs', yamlSeed);

      const mergedRawConfig: t.MCPOptions = {
        type: 'streamable-http',
        url: 'https://langfuse.com/api/public/mcp',
        requiresOAuth: false,
        headers: { Authorization: 'Bearer yaml-token' },
        iconPath: 'https://example.com/icon.svg',
      };

      const inspectSpy = jest.spyOn(MCPServerInspector, 'inspect');
      inspectSpy.mockClear();

      const result = await registry.ensureConfigServers({
        'langfuse-docs': mergedRawConfig,
      });

      expect(inspectSpy).toHaveBeenCalledTimes(1);
      const firstCallArgs = inspectSpy.mock.calls[0];
      expect(firstCallArgs[0]).toBe('langfuse-docs');
      const passedConfig = firstCallArgs[1] as t.StreamableHTTPOptions & {
        iconPath?: string;
        requiresOAuth?: boolean;
      };
      expect(passedConfig.type).toBe('streamable-http');
      expect(passedConfig.url).toBe('https://langfuse.com/api/public/mcp');
      expect(passedConfig.requiresOAuth).toBe(false);
      expect(passedConfig.headers).toEqual({ Authorization: 'Bearer yaml-token' });
      expect(passedConfig.iconPath).toBe('https://example.com/icon.svg');

      expect(result['langfuse-docs']).toBeDefined();
      expect(result['langfuse-docs'].iconPath).toBe('https://example.com/icon.svg');
    });
  });
});
