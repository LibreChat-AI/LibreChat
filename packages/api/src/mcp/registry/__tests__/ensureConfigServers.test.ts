import type * as t from '~/mcp/types';
import { MCPServersRegistry } from '~/mcp/registry/MCPServersRegistry';
import { MCPServerInspector } from '~/mcp/registry/MCPServerInspector';

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

const FIXED_TIME = 1699564800000;

const mockMongoose = {} as typeof import('mongoose');

const sseConfig: t.MCPOptions = {
  type: 'sse',
  url: 'https://mcp.example.com/sse',
};

const altSseConfig: t.MCPOptions = {
  type: 'sse',
  url: 'https://mcp.other-tenant.com/sse',
};

const yamlConfig: t.MCPOptions = {
  type: 'stdio',
  command: 'node',
  args: ['tools.js'],
};

function makeParsedConfig(overrides: Partial<t.ParsedServerConfig> = {}): t.ParsedServerConfig {
  return {
    tools: 'tool_a, tool_b',
    capabilities: '{}',
    initDuration: 42,
    ...overrides,
  } as unknown as t.ParsedServerConfig;
}

describe('MCPServersRegistry — ensureConfigServers', () => {
  let registry: MCPServersRegistry;
  let inspectSpy: jest.SpyInstance;

  beforeAll(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date(FIXED_TIME));
  });

  afterAll(() => {
    jest.useRealTimers();
  });

  beforeEach(async () => {
    (MCPServersRegistry as unknown as { instance: undefined }).instance = undefined;
    MCPServersRegistry.createInstance(mockMongoose);
    registry = MCPServersRegistry.getInstance();

    inspectSpy = jest
      .spyOn(MCPServerInspector, 'inspect')
      .mockImplementation(async (_serverName: string, rawConfig: t.MCPOptions) =>
        makeParsedConfig(rawConfig as unknown as Partial<t.ParsedServerConfig>),
      );

    await registry.reset();
  });

  afterEach(() => {
    inspectSpy.mockClear();
  });

  it('should return empty for empty input', async () => {
    expect(await registry.ensureConfigServers({})).toEqual({});
  });

  it('should return empty for null/undefined input', async () => {
    expect(
      await registry.ensureConfigServers(null as unknown as Record<string, t.MCPOptions>),
    ).toEqual({});
    expect(
      await registry.ensureConfigServers(undefined as unknown as Record<string, t.MCPOptions>),
    ).toEqual({});
  });

  it('routes each config-source initialization through the supplied limiter', async () => {
    let limitCalls = 0;
    const limit = async <T>(task: () => Promise<T>): Promise<T> => {
      limitCalls += 1;
      return task();
    };

    const result = await registry.ensureConfigServers(
      { first: sseConfig, second: altSseConfig },
      limit,
    );

    expect(result).toEqual(
      expect.objectContaining({ first: expect.any(Object), second: expect.any(Object) }),
    );
    expect(limitCalls).toBe(2);
  });

  it('should skip unchanged YAML-named servers but still process config-only servers', async () => {
    await registry.addServer('yaml_server', yamlConfig, 'CACHE');
    inspectSpy.mockClear();

    const result = await registry.ensureConfigServers({
      yaml_server: yamlConfig,
      config_server: sseConfig,
    });

    expect(result).toHaveProperty('config_server');
    expect(result).not.toHaveProperty('yaml_server');
    expect(inspectSpy).toHaveBeenCalledTimes(1);
    expect(inspectSpy).toHaveBeenCalledWith(
      'config_server',
      { ...sseConfig, source: 'config' },
      undefined,
      undefined,
      undefined,
    );
  });

  it('should skip lazy-init for YAML-named servers with no admin override', async () => {
    await registry.addServer('yaml_a', yamlConfig, 'CACHE');
    await registry.addServer('yaml_b', yamlConfig, 'CACHE');
    inspectSpy.mockClear();

    const result = await registry.ensureConfigServers({
      yaml_a: yamlConfig,
      yaml_b: yamlConfig,
    });

    expect(result).not.toHaveProperty('yaml_a');
    expect(result).not.toHaveProperty('yaml_b');
    expect(inspectSpy).not.toHaveBeenCalled();
  });

  it('should lazy-init YAML-named server when admin override changes a field', async () => {
    await registry.addServer('yaml_a', yamlConfig, 'CACHE');
    inspectSpy.mockClear();

    const overrideConfig: t.MCPOptions = { ...yamlConfig, iconPath: 'https://x.com/icon.svg' };
    const result = await registry.ensureConfigServers({
      yaml_a: overrideConfig,
    });

    expect(result).toHaveProperty('yaml_a');
    expect(inspectSpy).toHaveBeenCalledTimes(1);
  });

  it('should lazy-init YAML server when admin overrides only the proxy field', async () => {
    await registry.addServer('yaml_remote', sseConfig, 'CACHE');
    inspectSpy.mockClear();

    const overrideConfig: t.MCPOptions = {
      ...sseConfig,
      proxy: 'http://proxy.example.com:8080',
    } as t.MCPOptions;
    const result = await registry.ensureConfigServers({
      yaml_remote: overrideConfig,
    });

    expect(result).toHaveProperty('yaml_remote');
    expect(inspectSpy).toHaveBeenCalledTimes(1);
  });

  it('should lazy-init YAML server when admin overrides only the requestHeaders field', async () => {
    await registry.addServer('yaml_remote', sseConfig, 'CACHE');
    inspectSpy.mockClear();

    const overrideConfig: t.MCPOptions = {
      ...sseConfig,
      requestHeaders: { 'X-Conversation-Id': '{{LIBRECHAT_BODY_CONVERSATIONID}}' },
    };
    const result = await registry.ensureConfigServers({
      yaml_remote: overrideConfig,
    });

    expect(result).toHaveProperty('yaml_remote');
    expect(
      (result.yaml_remote as { requestHeaders?: Record<string, string> }).requestHeaders,
    ).toEqual({
      'X-Conversation-Id': '{{LIBRECHAT_BODY_CONVERSATIONID}}',
    });
    expect(inspectSpy).toHaveBeenCalledTimes(1);
  });

  it('should lazy-init YAML server when admin overrides only the OBO field', async () => {
    await registry.addServer('yaml_remote', sseConfig, 'CACHE');
    inspectSpy.mockClear();

    const overrideConfig: t.MCPOptions = {
      ...sseConfig,
      obo: { scopes: 'api://mcp-server/Mcp.Tools.ReadWrite' },
    };
    const result = await registry.ensureConfigServers({
      yaml_remote: overrideConfig,
    });

    expect(result).toHaveProperty('yaml_remote');
    expect(result.yaml_remote.obo).toEqual({ scopes: 'api://mcp-server/Mcp.Tools.ReadWrite' });
    expect(inspectSpy).toHaveBeenCalledTimes(1);
  });

  it('should not re-init YAML server when only the difference is an inspector-derived field absent from rawConfig', async () => {
    const yamlWithInferred: t.MCPOptions = {
      ...sseConfig,
      requiresOAuth: false,
    } as t.MCPOptions;
    await registry.addServer('yaml_remote', yamlWithInferred, 'CACHE');
    inspectSpy.mockClear();

    const result = await registry.ensureConfigServers({
      yaml_remote: sseConfig,
    });

    expect(result).not.toHaveProperty('yaml_remote');
    expect(inspectSpy).not.toHaveBeenCalled();
  });

  it('should issue a single batched YAML cache read regardless of how many servers are checked', async () => {
    await registry.addServer('yaml_a', yamlConfig, 'CACHE');
    await registry.addServer('yaml_b', yamlConfig, 'CACHE');
    await registry.addServer('yaml_c', yamlConfig, 'CACHE');
    const cacheGetSpy = jest.spyOn(registry['cacheConfigsRepo'], 'get');
    const cacheGetAllSpy = jest.spyOn(registry['cacheConfigsRepo'], 'getAll');

    await registry.ensureConfigServers({
      yaml_a: yamlConfig,
      yaml_b: yamlConfig,
      yaml_c: yamlConfig,
      config_only: sseConfig,
    });

    expect(cacheGetSpy).not.toHaveBeenCalled();
    expect(cacheGetAllSpy).toHaveBeenCalledTimes(1);
  });

  it('should lazy-initialize a config-source server and tag source as config', async () => {
    const result = await registry.ensureConfigServers({ my_server: sseConfig });

    expect(result).toHaveProperty('my_server');
    expect(result.my_server.source).toBe('config');
    expect(inspectSpy).toHaveBeenCalledTimes(1);
    expect(inspectSpy).toHaveBeenCalledWith(
      'my_server',
      { ...sseConfig, source: 'config' },
      undefined,
      undefined,
      undefined,
    );
  });

  it('should return cached result on second call without re-inspecting', async () => {
    await registry.ensureConfigServers({ my_server: sseConfig });
    expect(inspectSpy).toHaveBeenCalledTimes(1);

    const result2 = await registry.ensureConfigServers({ my_server: sseConfig });
    expect(result2).toHaveProperty('my_server');
    expect(result2.my_server.source).toBe('config');
    expect(inspectSpy).toHaveBeenCalledTimes(1);
  });

  it('should store inspectionFailed stub on inspection failure', async () => {
    inspectSpy.mockRejectedValueOnce(new Error('connection refused'));

    const result = await registry.ensureConfigServers({ bad_server: sseConfig });

    expect(result).toHaveProperty('bad_server');
    expect(result.bad_server.inspectionFailed).toBe(true);
    expect(result.bad_server.source).toBe('config');
  });

  it('should return stub from cache on repeated failure without re-inspecting', async () => {
    inspectSpy.mockRejectedValueOnce(new Error('connection refused'));
    await registry.ensureConfigServers({ bad_server: sseConfig });
    expect(inspectSpy).toHaveBeenCalledTimes(1);

    const result2 = await registry.ensureConfigServers({ bad_server: sseConfig });
    expect(result2.bad_server.inspectionFailed).toBe(true);
    expect(inspectSpy).toHaveBeenCalledTimes(1);
  });

  it('should retry stale failure stub after CONFIG_STUB_RETRY_MS', async () => {
    inspectSpy.mockRejectedValueOnce(new Error('transient DNS failure'));
    await registry.ensureConfigServers({ flaky_server: sseConfig });
    expect(inspectSpy).toHaveBeenCalledTimes(1);

    jest.setSystemTime(new Date(FIXED_TIME + 6 * 60 * 1000));

    const result = await registry.ensureConfigServers({ flaky_server: sseConfig });
    expect(inspectSpy).toHaveBeenCalledTimes(2);
    expect(result.flaky_server.inspectionFailed).toBeUndefined();
    expect(result.flaky_server.source).toBe('config');

    jest.setSystemTime(new Date(FIXED_TIME));
  });

  describe('cross-tenant isolation', () => {
    it('should use different cache keys for same server name with different configs', async () => {
      inspectSpy.mockClear();
      const resultA = await registry.ensureConfigServers({ shared_name: sseConfig });
      expect(resultA.shared_name.source).toBe('config');
      expect(inspectSpy).toHaveBeenCalledTimes(1);

      const resultB = await registry.ensureConfigServers({ shared_name: altSseConfig });
      expect(resultB.shared_name.source).toBe('config');
      expect(inspectSpy).toHaveBeenCalledTimes(2);
    });

    it('should return tenant-A config for tenant-A and tenant-B config for tenant-B', async () => {
      const resultA = await registry.ensureConfigServers({ srv: sseConfig });
      const resultB = await registry.ensureConfigServers({ srv: altSseConfig });

      expect((resultA.srv as unknown as { url: string }).url).toBe('https://mcp.example.com/sse');
      expect((resultB.srv as unknown as { url: string }).url).toBe(
        'https://mcp.other-tenant.com/sse',
      );
    });
  });

  describe('concurrent deduplication', () => {
    it('should only inspect once for multiple parallel calls with the same config', async () => {
      inspectSpy.mockClear();
      // Fire two calls simultaneously — both see cache miss, but only one should inspect
      const [r1, r2] = await Promise.all([
        registry.ensureConfigServers({ dedup_srv: sseConfig }),
        registry.ensureConfigServers({ dedup_srv: sseConfig }),
      ]);

      expect(r1.dedup_srv).toBeDefined();
      expect(r2.dedup_srv).toBeDefined();
      expect(inspectSpy).toHaveBeenCalledTimes(1);

      // Subsequent call must NOT re-inspect (cached)
      inspectSpy.mockClear();
      await registry.ensureConfigServers({ dedup_srv: sseConfig });
      expect(inspectSpy).toHaveBeenCalledTimes(0);
    });
  });

  describe('merge order', () => {
    it('should keep operator-managed servers authoritative in getAllServerConfigs', async () => {
      await registry.addServer('yaml_srv', yamlConfig, 'CACHE');

      const configServers = await registry.ensureConfigServers({ config_srv: sseConfig });

      const all = await registry.getAllServerConfigs(undefined, configServers);
      expect(all).toHaveProperty('yaml_srv');
      expect(all).toHaveProperty('config_srv');
      expect(all.yaml_srv.source).toBe('yaml');
      expect(all.config_srv.source).toBe('config');
    });

    it('should let config servers appear alongside user DB servers', async () => {
      const mockDbConfigs = {
        user_srv: makeParsedConfig({ source: 'user', dbId: 'abc123' }),
      };
      jest.spyOn(registry['dbConfigsRepo'], 'getAll').mockResolvedValue(mockDbConfigs);

      const configServers = await registry.ensureConfigServers({ config_srv: sseConfig });
      const all = await registry.getAllServerConfigs('user-1', configServers);

      expect(all).toHaveProperty('config_srv');
      expect(all).toHaveProperty('user_srv');
      expect(all.config_srv.source).toBe('config');
      expect(all.user_srv.source).toBe('user');
    });
  });

  describe('invalidateConfigCache', () => {
    it('should clear config cache and force re-inspection on next call', async () => {
      await registry.ensureConfigServers({ my_server: sseConfig });
      inspectSpy.mockClear();

      await registry.invalidateConfigCache();

      await registry.ensureConfigServers({ my_server: sseConfig });
      expect(inspectSpy).toHaveBeenCalledTimes(1);
    });

    it('should return evicted server names', async () => {
      await registry.ensureConfigServers({ srv_a: sseConfig, srv_b: altSseConfig });
      const evicted = await registry.invalidateConfigCache();
      expect(evicted.length).toBeGreaterThan(0);
    });

    it('should return empty array when nothing is cached', async () => {
      const evicted = await registry.invalidateConfigCache();
      expect(evicted).toEqual([]);
    });
  });

  describe('getServerConfig with configServers', () => {
    it('should return config-source server when configServers is passed', async () => {
      const configServers = await registry.ensureConfigServers({ config_srv: sseConfig });
      const config = await registry.getServerConfig('config_srv', undefined, configServers);
      expect(config).toBeDefined();
      expect(config?.source).toBe('config');
    });

    it('should return config-source server with userId when configServers is passed', async () => {
      const configServers = await registry.ensureConfigServers({ config_srv: sseConfig });
      const config = await registry.getServerConfig('config_srv', 'user-123', configServers);
      expect(config).toBeDefined();
      expect(config?.source).toBe('config');
    });

    it('should return undefined for config-source server without configServers (tenant isolation)', async () => {
      await registry.ensureConfigServers({ config_srv: sseConfig });
      const config = await registry.getServerConfig('config_srv');
      expect(config).toBeUndefined();
    });

    it('should return correct config after invalidation and re-init', async () => {
      const configServers1 = await registry.ensureConfigServers({ config_srv: sseConfig });
      expect(await registry.getServerConfig('config_srv', undefined, configServers1)).toBeDefined();

      await registry.invalidateConfigCache();

      const configServers2 = await registry.ensureConfigServers({ config_srv: sseConfig });
      const config = await registry.getServerConfig('config_srv', undefined, configServers2);
      expect(config).toBeDefined();
      expect(config?.source).toBe('config');
    });

    it('should surface inspectionFailed stub for config-only server when no YAML/DB fallback exists', async () => {
      inspectSpy.mockRejectedValueOnce(new Error('connection refused'));
      const configServers = await registry.ensureConfigServers({ bad_config_only: sseConfig });
      expect(configServers.bad_config_only.inspectionFailed).toBe(true);

      const config = await registry.getServerConfig('bad_config_only', undefined, configServers);
      expect(config).toBeDefined();
      expect(config?.inspectionFailed).toBe(true);
      expect(config?.source).toBe('config');
    });

    it('should prefer healthy YAML entry over inspectionFailed config-tier stub on the same name', async () => {
      await registry.addServer('shared_name', yamlConfig, 'CACHE');

      inspectSpy.mockRejectedValueOnce(new Error('connection refused'));
      const configServers = await registry.ensureConfigServers({ shared_name: sseConfig });
      expect(configServers.shared_name.inspectionFailed).toBe(true);

      const config = await registry.getServerConfig('shared_name', undefined, configServers);
      expect(config).toBeDefined();
      expect(config?.inspectionFailed).toBeUndefined();
      expect(config?.source).toBe('yaml');
    });

    it('should prefer the user-tier DB entry over a config-tier candidate on the same name', async () => {
      const dbConfig = makeParsedConfig({
        source: 'user',
        title: 'User Slack',
      } as Partial<t.ParsedServerConfig>);
      jest.spyOn(registry['dbConfigsRepo'], 'get').mockResolvedValue(dbConfig);

      const configCandidate = makeParsedConfig({
        source: 'config',
        title: 'Config Slack',
      } as Partial<t.ParsedServerConfig>);

      const result = await registry.getServerConfig('slack', 'user-1', {
        slack: configCandidate,
      });
      expect(result?.source).toBe('user');
      expect((result as unknown as { title: string }).title).toBe('User Slack');
    });

    it('should overlay healthy admin override fields onto a YAML base while preserving yaml source', async () => {
      const yamlEntry = makeParsedConfig({
        ...sseConfig,
        source: 'yaml',
        title: 'YAML Title',
      } as unknown as Partial<t.ParsedServerConfig>);
      await registry['cacheConfigsRepo'].add('shared', yamlEntry);

      const adminOverride = makeParsedConfig({
        ...sseConfig,
        source: 'config',
        title: 'Admin Title',
      } as unknown as Partial<t.ParsedServerConfig>);

      const result = await registry.getServerConfig('shared', undefined, {
        shared: adminOverride,
      });
      expect(result?.source).toBe('yaml');
      expect((result as unknown as { title: string }).title).toBe('Admin Title');
    });

    it('should not leak a tenant-scoped failure stub into subsequent no-configServers calls', async () => {
      inspectSpy.mockRejectedValueOnce(new Error('connection refused'));
      const tenantA = await registry.ensureConfigServers({ tenant_a_only: sseConfig });
      expect(tenantA.tenant_a_only.inspectionFailed).toBe(true);

      const firstLookup = await registry.getServerConfig('tenant_a_only', undefined, tenantA);
      expect(firstLookup?.inspectionFailed).toBe(true);
      expect(firstLookup?.source).toBe('config');

      const leakedLookup = await registry.getServerConfig('tenant_a_only');
      expect(leakedLookup).toBeUndefined();

      const tenantB = await registry.ensureConfigServers({ tenant_a_only: altSseConfig });
      const tenantBLookup = await registry.getServerConfig('tenant_a_only', undefined, tenantB);
      expect((tenantBLookup as unknown as { url: string }).url).toBe(
        'https://mcp.other-tenant.com/sse',
      );
    });

    it('should not cross-contaminate between tenant configServers maps', async () => {
      const tenantA = await registry.ensureConfigServers({ srv: sseConfig });
      const tenantB = await registry.ensureConfigServers({ srv: altSseConfig });

      const configA = await registry.getServerConfig('srv', undefined, tenantA);
      const configB = await registry.getServerConfig('srv', undefined, tenantB);

      expect((configA as unknown as { url: string }).url).toBe('https://mcp.example.com/sse');
      expect((configB as unknown as { url: string }).url).toBe('https://mcp.other-tenant.com/sse');
    });
  });

  describe('source tagging', () => {
    it('should tag CACHE-stored servers as yaml', async () => {
      await registry.addServer('yaml_srv', yamlConfig, 'CACHE');
      const config = await registry.getServerConfig('yaml_srv');
      expect(config?.source).toBe('yaml');
    });

    it('should tag stubs as yaml when stored in CACHE', async () => {
      await registry.addServerStub('stub_srv', yamlConfig, 'CACHE');
      const config = await registry.getServerConfig('stub_srv');
      expect(config?.source).toBe('yaml');
      expect(config?.inspectionFailed).toBe(true);
    });
  });
});
