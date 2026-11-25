import './helpers/setupCredsEnv';
import { resolveMCPAppsPolicy } from 'librechat-data-provider';
import { logger, getTenantId, SYSTEM_TENANT_ID } from '@librechat/data-schemas';
import type { MCPAllowlistResolver } from '~/mcp/registry/MCPServersRegistry';
import type * as t from '~/mcp/types';
import {
  HiddenServers,
  findStoredMCPTombstones,
  reportStoredMCPTombstones,
} from '~/mcp/registry/hidden';
import { MCPServersRegistry } from '~/mcp/registry/MCPServersRegistry';
import { MCPServerInspector } from '~/mcp/registry/MCPServerInspector';
import { MCPManager } from '~/mcp/MCPManager';

jest.mock('~/mcp/registry/MCPServerInspector');
jest.mock('~/mcp/registry/db/ServerConfigsDB', () => ({
  ServerConfigsDB: jest.fn().mockImplementation(() => ({
    get: jest.fn().mockResolvedValue(undefined),
    getAll: jest.fn().mockResolvedValue({}),
    add: jest.fn(),
    update: jest.fn(),
    remove: jest.fn(),
    reset: jest.fn(),
  })),
}));

const mockMongoose = {} as typeof import('mongoose');

const remote: t.MCPOptions = { type: 'streamable-http', url: 'https://remote.example.com/mcp' };
const docs: t.MCPOptions = { type: 'streamable-http', url: 'https://docs.example.com/mcp' };
const stdio: t.MCPOptions = { type: 'stdio', command: 'node', args: ['tools.js'] };
const plugin = {
  type: 'streamable-http',
  url: 'https://plugin.example.com/mcp',
  source: 'plugin',
} as t.MCPOptions;

/** librechat.yaml as `initializeMCPs` hands it to the initializer: Agent Plugins servers included. */
const YAML: t.MCPServers = { remote, docs, local: stdio, plugged: plugin };

/** Principal `u-hidden` has `mcpServers.remote` tombstoned; every other principal keeps it. */
const KEPT_BY_USER: Record<string, string[]> = {
  'u-hidden': ['docs', 'local'],
};

function keptServerNames(userId?: string): string[] {
  return KEPT_BY_USER[userId ?? ''] ?? ['remote', 'docs', 'local'];
}

const policy = { allowedDomains: null, allowedAddresses: null, mcpApps: resolveMCPAppsPolicy() };

function createRegistry(resolver: MCPAllowlistResolver): MCPServersRegistry {
  (MCPServersRegistry as unknown as { instance: undefined }).instance = undefined;
  return MCPServersRegistry.createInstance(mockMongoose, null, null, resolver);
}

async function loadYaml(registry: MCPServersRegistry): Promise<void> {
  registry.setYamlServerOptions(YAML);
  await registry.reset();
  for (const [name, config] of Object.entries(YAML)) {
    await registry.addServer(name, config, 'CACHE');
  }
}

describe('MCPServersRegistry — librechat.yaml servers hidden per principal', () => {
  let resolver: jest.Mock<ReturnType<MCPAllowlistResolver>, Parameters<MCPAllowlistResolver>>;
  let registry: MCPServersRegistry;

  beforeEach(async () => {
    jest
      .spyOn(MCPServerInspector, 'inspect')
      .mockImplementation(
        async (_name: string, config: t.MCPOptions) => config as t.ParsedServerConfig,
      );
    resolver = jest.fn(async (ctx) => ({ ...policy, serverNames: keptServerNames(ctx?.userId) }));
    registry = createRegistry(resolver);
    await loadYaml(registry);
    resolver.mockClear();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('getHiddenServerNames', () => {
    it('hides a librechat.yaml server the resolved mcpConfig no longer has', () => {
      expect([...registry.getHiddenServerNames({ docs, local: stdio })]).toEqual(['remote']);
    });

    it('never hides process-backed or Agent Plugins servers', () => {
      expect([...registry.getHiddenServerNames({})]).toEqual(['remote', 'docs']);
    });

    it('hides every hideable server when the resolved config has no mcpConfig', () => {
      expect([...registry.getHiddenServerNames(undefined)]).toEqual(['remote', 'docs']);
    });

    it('hides nothing before the librechat.yaml snapshot is recorded', () => {
      const fresh = createRegistry(resolver);
      expect(fresh.getHiddenServerNames({}).size).toBe(0);
    });
  });

  describe('principal-scoped lookups', () => {
    it('drops the hidden server from the catalog for that principal only', async () => {
      const hidden = await registry.getAllServerConfigs('u-hidden');
      const visible = await registry.getAllServerConfigs('u-visible');

      expect(Object.keys(hidden).sort()).toEqual(['docs', 'local', 'plugged']);
      expect(Object.keys(visible).sort()).toEqual(['docs', 'local', 'plugged', 'remote']);
      expect(resolver).toHaveBeenCalledWith({ userId: 'u-hidden', role: undefined });
    });

    it("hands the resolver the identity the caller's request already loaded", async () => {
      await registry.getAllServerConfigs('u-hidden', undefined, 'USER', { idOnTheSource: null });
      await registry.getServerConfig('remote', 'u-visible', undefined, 'USER', {
        idOnTheSource: 'entra-oid',
      });

      expect(resolver).toHaveBeenNthCalledWith(1, {
        userId: 'u-hidden',
        role: 'USER',
        idOnTheSource: null,
      });
      expect(resolver).toHaveBeenNthCalledWith(2, {
        userId: 'u-visible',
        role: 'USER',
        idOnTheSource: 'entra-oid',
      });
    });

    it('returns nothing for a hidden server by name, including a config-tier overlay', async () => {
      const overlay = await registry.ensureConfigServers({
        remote: { ...remote, title: 'Remote (admin)' },
      });
      expect(overlay.remote).toBeDefined();

      await expect(registry.getServerConfig('remote', 'u-hidden')).resolves.toBeUndefined();
      await expect(
        registry.getServerConfig('remote', 'u-hidden', overlay, 'USER'),
      ).resolves.toBeUndefined();
      await expect(registry.getServerConfig('remote', 'u-visible', overlay)).resolves.toEqual(
        expect.objectContaining({ title: 'Remote (admin)', source: 'yaml' }),
      );
    });

    it('skips the principal resolution for a name no principal can hide', async () => {
      await expect(registry.getServerConfig('local', 'u-hidden')).resolves.toEqual(
        expect.objectContaining({ command: 'node' }),
      );
      await expect(registry.getServerConfig('plugged', 'u-hidden')).resolves.toBeDefined();
      expect(resolver).not.toHaveBeenCalled();
    });

    it('leaves app-level lookups without a user unfiltered', async () => {
      expect(Object.keys(await registry.getAllServerConfigs())).toContain('remote');
      await expect(registry.getServerConfig('remote')).resolves.toBeDefined();
      expect(resolver).not.toHaveBeenCalled();
    });

    it('lets cleanup reach a hidden server through includeHidden', async () => {
      const options = { includeHidden: true };
      await expect(
        registry.getServerConfig('remote', 'u-hidden', undefined, undefined, options),
      ).resolves.toBeDefined();
      expect(
        Object.keys(await registry.getAllServerConfigs('u-hidden', undefined, undefined, options)),
      ).toContain('remote');
      expect(resolver).not.toHaveBeenCalled();
    });

    it('keeps a user-tier entry even under a hidden name', async () => {
      const userEntry: t.ParsedServerConfig = {
        type: 'streamable-http',
        url: 'https://mine.example.com/mcp',
        source: 'user',
        dbId: 'db-1',
      };
      await registry['cacheConfigsRepo'].remove('remote');
      jest.spyOn(registry['dbConfigsRepo'], 'getAll').mockResolvedValue({ remote: userEntry });
      jest.spyOn(registry['dbConfigsRepo'], 'get').mockResolvedValue(userEntry);

      expect((await registry.getAllServerConfigs('u-hidden')).remote).toEqual(userEntry);
      await expect(registry.getServerConfig('remote', 'u-hidden')).resolves.toEqual(userEntry);
    });

    it("leaves a hidden server's instructions out of the model context, whoever names it", async () => {
      for (const [name, config] of Object.entries({ remote, docs })) {
        await registry['cacheConfigsRepo'].update(name, {
          ...config,
          source: 'yaml',
          serverInstructions: `Follow the ${name} rules`,
        });
      }
      /** A model spec can pin `remote` after the picker's own selection was filtered. */
      const pinned = ['remote', 'docs'];
      const manager = new MCPManager();

      const hidden = await manager.formatInstructionsForContext(pinned, undefined, {
        id: 'u-hidden',
        role: 'USER',
        idOnTheSource: null,
      });
      const visible = await manager.formatInstructionsForContext(pinned, undefined, {
        id: 'u-visible',
      });

      expect(hidden).not.toContain('remote');
      expect(hidden).toContain('Follow the docs rules');
      expect(visible).toContain('Follow the remote rules');
      expect(resolver).toHaveBeenCalledWith({
        userId: 'u-hidden',
        role: 'USER',
        idOnTheSource: null,
      });
    });

    it('excludes a hidden OAuth server from reconnection unless cleanup asks for it', async () => {
      await registry['cacheConfigsRepo'].update('remote', {
        ...remote,
        source: 'yaml',
        requiresOAuth: true,
      });

      expect([...(await registry.getOAuthServers('u-hidden'))]).toEqual([]);
      expect([...(await registry.getOAuthServers('u-visible'))]).toEqual(['remote']);
      expect([...(await registry.getOAuthServers('u-hidden', { includeHidden: true }))]).toEqual([
        'remote',
      ]);
    });
  });

  describe('resolveHiddenServerNames', () => {
    it('withholds every hideable server when the principal config cannot be read, until the window passes or the config changes', async () => {
      const warn = jest.spyOn(logger, 'warn').mockReturnValue(logger);
      resolver.mockRejectedValueOnce(new Error('overrides unavailable for alice@example.com'));

      expect([...(await registry.resolveHiddenServerNames({ userId: 'u-visible' }))]).toEqual([
        'remote',
        'docs',
      ]);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('withholding hideable librechat.yaml servers'),
        { type: 'Error' },
      );
      expect(JSON.stringify(warn.mock.calls)).not.toContain('alice@example.com');

      /** One strict read per principal per window, not one per lookup, while the database is down. */
      expect((await registry.getAllServerConfigs('u-visible')).remote).toBeUndefined();
      expect(resolver).toHaveBeenCalledTimes(1);

      await registry.invalidateConfigCache();
      expect([...(await registry.resolveHiddenServerNames({ userId: 'u-visible' }))]).toEqual([]);
      expect(resolver).toHaveBeenCalledTimes(2);
    });

    it('hides nothing when the resolver does not report server names', async () => {
      resolver.mockResolvedValueOnce({ ...policy });

      expect((await registry.resolveHiddenServerNames({ userId: 'u-hidden' })).size).toBe(0);
    });

    it('hides nothing without a resolver to read the principal config', async () => {
      (MCPServersRegistry as unknown as { instance: undefined }).instance = undefined;
      const unresolved = MCPServersRegistry.createInstance(mockMongoose);
      unresolved.setYamlServerOptions(YAML);

      expect((await unresolved.resolveHiddenServerNames({ userId: 'u-hidden' })).size).toBe(0);
    });

    it('reuses one resolution across lookups until the config cache is invalidated', async () => {
      await registry.getAllServerConfigs('u-hidden');
      await registry.getServerConfig('remote', 'u-hidden');
      await registry.getServerConfig('docs', 'u-hidden');
      expect(resolver).toHaveBeenCalledTimes(1);

      KEPT_BY_USER['u-hidden'] = ['remote', 'docs', 'local'];
      try {
        await registry.invalidateConfigCache();
        await expect(registry.getServerConfig('remote', 'u-hidden')).resolves.toBeDefined();
        expect(resolver).toHaveBeenCalledTimes(2);
      } finally {
        KEPT_BY_USER['u-hidden'] = ['docs', 'local'];
      }
    });

    it('resolves concurrent lookups for one principal once', async () => {
      await Promise.all([
        registry.getServerConfig('remote', 'u-hidden'),
        registry.getServerConfig('docs', 'u-hidden'),
        registry.getAllServerConfigs('u-hidden'),
      ]);

      expect(resolver).toHaveBeenCalledTimes(1);
    });

    it('resolves each role separately', async () => {
      await registry.resolveHiddenServerNames({ userId: 'u-hidden', role: 'USER' });
      await registry.resolveHiddenServerNames({ userId: 'u-hidden', role: 'ADMIN' });

      expect(resolver).toHaveBeenNthCalledWith(1, { userId: 'u-hidden', role: 'USER' });
      expect(resolver).toHaveBeenNthCalledWith(2, { userId: 'u-hidden', role: 'ADMIN' });
    });
  });

  describe('isHiddenFromPrincipal', () => {
    const config = { ...remote, source: 'yaml' } as t.ParsedServerConfig;

    it('refuses a hidden librechat.yaml server for that principal', async () => {
      await expect(
        registry.isHiddenFromPrincipal('remote', config, {
          id: 'u-hidden',
          role: 'USER',
          idOnTheSource: null,
        }),
      ).resolves.toBe(true);
      await expect(
        registry.isHiddenFromPrincipal('remote', config, { id: 'u-visible' }),
      ).resolves.toBe(false);
      expect(resolver).toHaveBeenCalledWith({
        userId: 'u-hidden',
        role: 'USER',
        idOnTheSource: null,
      });
    });

    it('never refuses an app-level checkout, a user-tier config, or an unhideable name', async () => {
      await expect(registry.isHiddenFromPrincipal('remote', config)).resolves.toBe(false);
      await expect(
        registry.isHiddenFromPrincipal('remote', { ...config, source: 'user' }, { id: 'u-hidden' }),
      ).resolves.toBe(false);
      await expect(
        registry.isHiddenFromPrincipal('local', stdio as t.ParsedServerConfig, { id: 'u-hidden' }),
      ).resolves.toBe(false);
      expect(resolver).not.toHaveBeenCalled();
    });
  });

  describe('resolveCachedAppServerConfig', () => {
    const allowlists = { allowedDomains: null, allowedAddresses: null };

    it('withholds a server the admitted config hides', async () => {
      await expect(
        registry.resolveCachedAppServerConfig({
          serverName: 'docs',
          userId: 'u-visible',
          mcpConfig: { remote, local: stdio },
          ...allowlists,
        }),
      ).resolves.toBeUndefined();
    });

    it('withholds a server the principal resolution hides even if the admitted config kept it', async () => {
      await expect(
        registry.resolveCachedAppServerConfig({
          serverName: 'remote',
          userId: 'u-hidden',
          mcpConfig: { remote, docs, local: stdio },
          ...allowlists,
        }),
      ).resolves.toBeUndefined();
    });

    it('still resolves a server both keep', async () => {
      await expect(
        registry.resolveCachedAppServerConfig({
          serverName: 'docs',
          userId: 'u-hidden',
          mcpConfig: { docs, local: stdio },
          ...allowlists,
        }),
      ).resolves.toEqual(
        expect.objectContaining({ serverConfig: expect.objectContaining({ url: docs.url }) }),
      );
    });
  });
});

describe('HiddenServers', () => {
  const TTL = 5_000;
  let now: number;
  let readKept: jest.Mock<Promise<string[] | undefined>, [t.MCPPrincipal]>;
  let hidden: HiddenServers;

  /** A deferred read, to hold a resolution in flight. */
  function deferred(): { promise: Promise<string[]>; resolve: (names: string[]) => void } {
    let resolve: (names: string[]) => void = () => undefined;
    const promise = new Promise<string[]>((done) => {
      resolve = done;
    });
    return { promise, resolve };
  }

  beforeEach(() => {
    now = 1_000_000;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    readKept = jest.fn(
      async (_principal: t.MCPPrincipal): Promise<string[] | undefined> => ['docs'],
    );
    hidden = new HiddenServers(TTL, readKept);
    hidden.setYamlServers(YAML);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('treats every librechat.yaml server but stdio and Agent Plugins ones as hideable', () => {
    expect([...hidden.getHideable()]).toEqual(['remote', 'docs']);
    expect(hidden.isHideable('local')).toBe(false);
    expect(hidden.isHideable('plugged')).toBe(false);
  });

  it('keeps a decision in process for the window, then reads again', async () => {
    const principal = { userId: 'u1', role: 'USER' };

    expect([...(await hidden.forPrincipal(principal))]).toEqual(['remote']);
    now += TTL - 1;
    expect([...(await hidden.forPrincipal(principal))]).toEqual(['remote']);
    expect(readKept).toHaveBeenCalledTimes(1);

    now += 1;
    readKept.mockResolvedValueOnce(['remote', 'docs']);
    expect((await hidden.forPrincipal(principal)).size).toBe(0);
    expect(readKept).toHaveBeenCalledTimes(2);
  });

  it('keys decisions by user and role', async () => {
    await hidden.forPrincipal({ userId: 'u1', role: 'USER' });
    await hidden.forPrincipal({ userId: 'u1', role: 'ADMIN' });
    await hidden.forPrincipal({ userId: 'u1' });
    await hidden.forPrincipal({ userId: 'u2', role: 'USER' });

    expect(readKept).toHaveBeenCalledTimes(4);
  });

  it('keeps a failed read hiding everything for the window', async () => {
    jest.spyOn(logger, 'warn').mockReturnValue(logger);
    readKept.mockRejectedValueOnce(new Error('principal read failed'));
    const principal = { userId: 'u1', role: 'USER' };

    expect([...(await hidden.forPrincipal(principal))]).toEqual(['remote', 'docs']);
    expect([...(await hidden.forPrincipal(principal))]).toEqual(['remote', 'docs']);
    expect(readKept).toHaveBeenCalledTimes(1);

    now += TTL;
    expect([...(await hidden.forPrincipal(principal))]).toEqual(['remote']);
  });

  it('does not keep a decision that was being read when it was cleared', async () => {
    const stale = deferred();
    readKept.mockReturnValueOnce(stale.promise);
    const principal = { userId: 'u1', role: 'USER' };

    const inFlight = hidden.forPrincipal(principal);
    hidden.clear();
    readKept.mockResolvedValueOnce(['remote', 'docs']);
    const fresh = hidden.forPrincipal(principal);
    stale.resolve(['docs']);

    expect([...(await inFlight)]).toEqual(['remote']);
    expect((await fresh).size).toBe(0);
    expect((await hidden.forPrincipal(principal)).size).toBe(0);
    expect(readKept).toHaveBeenCalledTimes(2);
  });

  it('keeps nothing when the window is zero', async () => {
    const uncached = new HiddenServers(0, readKept);
    uncached.setYamlServers(YAML);

    await uncached.forPrincipal({ userId: 'u1' });
    await uncached.forPrincipal({ userId: 'u1' });

    expect(readKept).toHaveBeenCalledTimes(2);
  });

  it('drops expired decisions of other principals when it stores a new one', async () => {
    await hidden.forPrincipal({ userId: 'u1' });
    now += TTL;
    await hidden.forPrincipal({ userId: 'u2' });

    expect(hidden['decisions'].size).toBe(1);
  });

  it('hides nothing and reads nothing without hideable servers or a reader', async () => {
    const empty = new HiddenServers(TTL, readKept);
    empty.setYamlServers({ local: stdio });
    const unread = new HiddenServers(TTL);
    unread.setYamlServers(YAML);

    expect((await empty.forPrincipal({ userId: 'u1' })).size).toBe(0);
    expect((await unread.forPrincipal({ userId: 'u1' })).size).toBe(0);
    expect(readKept).not.toHaveBeenCalled();
  });
});

describe('stored MCP tombstones reported at startup', () => {
  const profiles = [
    { principalType: 'role', principalId: '__base__', tombstones: ['mcpServers.docs'] },
    {
      principalType: 'group',
      principalId: { toString: () => '64f000000000000000000001' },
      tombstones: ['mcpServers', 'webSearch'],
    },
    {
      principalType: 'user',
      principalId: 'u1',
      tombstones: [
        'mcpServers.remote.headers',
        'mcpServers.remote.headers.Authorization',
        'mcpServers.local',
        'mcpServers.local.env',
        'mcpServers.plugged',
        'mcpServers.unknown',
      ],
    },
    { principalType: 'role', principalId: 'USER' },
  ];

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('finds the hides and whole-field removals the registry now honours', () => {
    expect(findStoredMCPTombstones(profiles, new Set(['remote', 'docs']))).toEqual([
      { principal: 'role:__base__', fieldPath: 'mcpServers.docs' },
      { principal: 'group:64f000000000000000000001', fieldPath: 'mcpServers' },
      { principal: 'user:u1', fieldPath: 'mcpServers.remote.headers' },
    ]);
  });

  it('logs them once, by principal, reading only the profiles with tombstones under mcpServers', async () => {
    const warn = jest.spyOn(logger, 'warn').mockReturnValue(logger);
    const listProfiles = jest.fn(async (_fieldPath: string) => profiles);

    await reportStoredMCPTombstones(listProfiles, YAML);

    expect(listProfiles).toHaveBeenCalledTimes(1);
    expect(listProfiles).toHaveBeenCalledWith('mcpServers');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain(
      '3 stored config tombstones hide librechat.yaml MCP servers or remove their fields',
    );
    expect(warn.mock.calls[0][0]).toContain(
      'role:__base__ mcpServers.docs; group:64f000000000000000000001 mcpServers; user:u1 mcpServers.remote.headers.',
    );
  });

  it('names the first 20 and counts the rest', async () => {
    const warn = jest.spyOn(logger, 'warn').mockReturnValue(logger);
    const many = Array.from({ length: 23 }, (_, i) => ({
      principalType: 'user',
      principalId: `u${i}`,
      tombstones: ['mcpServers.remote'],
    }));

    await reportStoredMCPTombstones(async () => many, YAML);

    expect(warn.mock.calls[0][0]).toContain('user:u19 mcpServers.remote (and 3 more)');
    expect(warn.mock.calls[0][0]).not.toContain('user:u20 ');
  });

  it('reads nothing without hideable servers and stays quiet when nothing applies', async () => {
    const warn = jest.spyOn(logger, 'warn').mockReturnValue(logger);
    const listProfiles = jest.fn(async () => profiles);

    await reportStoredMCPTombstones(listProfiles, { local: stdio });
    await reportStoredMCPTombstones(
      async () => [{ principalType: 'role', principalId: 'USER' }],
      YAML,
    );

    expect(listProfiles).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it("reads every tenant's profiles in the system scope and names each profile's tenant", async () => {
    const warn = jest.spyOn(logger, 'warn').mockReturnValue(logger);
    let readScope: string | undefined;

    /** Startup has no tenant; under strict tenant isolation only the system scope may read. */
    await reportStoredMCPTombstones(async () => {
      readScope = getTenantId();
      return ['acme', 'globex'].map((tenantId) => ({
        principalType: 'role',
        principalId: 'USER',
        tenantId,
        tombstones: ['mcpServers.remote'],
      }));
    }, YAML);

    expect(getTenantId()).toBeUndefined();
    expect(readScope).toBe(SYSTEM_TENANT_ID);
    expect(warn.mock.calls[0][0]).toContain(
      'tenant:acme role:USER mcpServers.remote; tenant:globex role:USER mcpServers.remote.',
    );
  });

  it('logs a safe warning instead of failing startup when the profiles cannot be read', async () => {
    const warn = jest.spyOn(logger, 'warn').mockReturnValue(logger);

    await expect(
      reportStoredMCPTombstones(async () => {
        throw new Error('connection refused for mongodb://admin:secret@db');
      }, YAML),
    ).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledWith(
      '[MCP] Could not read config profiles to report MCP tombstones',
      { type: 'Error' },
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain('secret');
  });
});
