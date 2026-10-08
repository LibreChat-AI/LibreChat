import './helpers/setupCredsEnv';
import { tenantStorage } from '@librechat/data-schemas';
import type { MCPConnection } from '~/mcp/connection';
import type * as t from '~/mcp/types';
import { MCPServersRegistry } from '~/mcp/registry/MCPServersRegistry';
import { UserConnectionManager } from '~/mcp/UserConnectionManager';
import { resolveServerInstructions } from '~/mcp/utils';

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

const mockMongoose = {} as typeof import('mongoose');
const INSTRUCTIONS = 'Prefer $select on list operations. Never invent addresses.';
const FIXED_TIME = 1699564800000;
const RUNTIME_IDENTITY_ENV_NAME = 'MCP_BACKFILL_RUNTIME_IDENTITY_TEST';
const previousRuntimeIdentityEnv = process.env[RUNTIME_IDENTITY_ENV_NAME];

beforeAll(() => {
  process.env[RUNTIME_IDENTITY_ENV_NAME] = '{{LIBRECHAT_USER_ID}}';
});

afterAll(() => {
  if (previousRuntimeIdentityEnv == null) {
    delete process.env[RUNTIME_IDENTITY_ENV_NAME];
  } else {
    process.env[RUNTIME_IDENTITY_ENV_NAME] = previousRuntimeIdentityEnv;
  }
});

/** A YAML server whose startup inspection was deferred, leaving the enabled
 * declaration without fetched text. */
const startupDeferredYamlEntry: t.ParsedServerConfig = {
  type: 'streamable-http',
  url: 'https://mcp.example.com/mcp',
  requiresOAuth: false,
  startup: false,
  serverInstructions: true,
  source: 'yaml',
  updatedAt: FIXED_TIME,
};

const oauthDeferredYamlEntry: t.ParsedServerConfig = {
  ...startupDeferredYamlEntry,
  startup: true,
  requiresOAuth: true,
};

const runtimePlaceholderYamlEntry: t.ParsedServerConfig = {
  ...startupDeferredYamlEntry,
  headers: { 'X-User-Id': '{{LIBRECHAT_USER_ID}}' },
};

const runtimeApiKeyPlaceholderYamlEntry: t.ParsedServerConfig = {
  ...startupDeferredYamlEntry,
  apiKey: {
    source: 'admin',
    authorization_type: 'bearer',
    key: '{{LIBRECHAT_OPENID_ACCESS_TOKEN}}',
  },
};

const envExpandedRuntimeApiKeyPlaceholderYamlEntry: t.ParsedServerConfig = {
  ...startupDeferredYamlEntry,
  apiKey: {
    source: 'admin',
    authorization_type: 'bearer',
    key: `\${${RUNTIME_IDENTITY_ENV_NAME}}`,
  },
};

describe('MCPServersRegistry.setResolvedInstructions', () => {
  let registry: MCPServersRegistry;

  beforeEach(async () => {
    (MCPServersRegistry as unknown as { instance: undefined }).instance = undefined;
    MCPServersRegistry.createInstance(mockMongoose);
    registry = MCPServersRegistry.getInstance();
    await registry.reset();
  });

  it('backfills a YAML-tier server and preserves its updatedAt', async () => {
    const { config: stored } = await registry['cacheConfigsRepo'].add(
      'deferred_server',
      startupDeferredYamlEntry,
    );

    const updated = await registry.setResolvedInstructions('deferred_server', INSTRUCTIONS);

    expect(updated).toBe(true);
    const config = await registry.getServerConfig('deferred_server');
    expect(config?.resolvedInstructions).toBe(INSTRUCTIONS);
    expect(config?.serverInstructions).toBe(true);
    expect(config?.updatedAt).toBe(stored.updatedAt);
    expect(resolveServerInstructions(config!)).toBe(INSTRUCTIONS);
  });

  it('invalidates the read-through cache so a primed read sees the backfill', async () => {
    await registry['cacheConfigsRepo'].add('deferred_server', startupDeferredYamlEntry);

    const before = await registry.getServerConfig('deferred_server');
    expect(before?.resolvedInstructions).toBeUndefined();

    await registry.setResolvedInstructions('deferred_server', INSTRUCTIONS);

    const after = await registry.getServerConfig('deferred_server');
    expect(after?.resolvedInstructions).toBe(INSTRUCTIONS);
  });

  it('invalidates YAML read-through caches across tenants', async () => {
    await registry['cacheConfigsRepo'].add('deferred_server', startupDeferredYamlEntry);
    const getInTenant = (tenantId: string) =>
      tenantStorage.run({ tenantId }, () => registry.getServerConfig('deferred_server'));

    expect((await getInTenant('tenant-a'))?.resolvedInstructions).toBeUndefined();
    expect((await getInTenant('tenant-b'))?.resolvedInstructions).toBeUndefined();

    await tenantStorage.run({ tenantId: 'tenant-a' }, () =>
      registry.setResolvedInstructions('deferred_server', INSTRUCTIONS, 'user-1'),
    );

    expect((await getInTenant('tenant-b'))?.resolvedInstructions).toBe(INSTRUCTIONS);
  });

  /** `MCPManager.getInstructions` reads through `getAllServerConfigs`, a different
   *  read-through cache than `getServerConfig`. Backfilling into a cache the context
   *  path never consults would leave the reported bug unfixed. */
  it('reaches the model-context read path through getAllServerConfigs', async () => {
    await registry['cacheConfigsRepo'].add('deferred_server', startupDeferredYamlEntry);

    const primed = await registry.getAllServerConfigs();
    expect(resolveServerInstructions(primed['deferred_server'])).toBeUndefined();

    await registry.setResolvedInstructions('deferred_server', INSTRUCTIONS);

    const after = await registry.getAllServerConfigs();
    expect(resolveServerInstructions(after['deferred_server'])).toBe(INSTRUCTIONS);
  });

  it('is a no-op when the stored instructions already match', async () => {
    await registry['cacheConfigsRepo'].add('deferred_server', startupDeferredYamlEntry);

    await registry.setResolvedInstructions('deferred_server', INSTRUCTIONS);
    const updated = await registry.setResolvedInstructions('deferred_server', INSTRUCTIONS);

    expect(updated).toBe(false);
  });

  it('keeps the first stored text when a later connection delivers different instructions', async () => {
    await registry['cacheConfigsRepo'].add('deferred_server', startupDeferredYamlEntry);

    await registry.setResolvedInstructions('deferred_server', INSTRUCTIONS);
    const updated = await registry.setResolvedInstructions(
      'deferred_server',
      'per-identity text for someone else',
    );

    expect(updated).toBe(false);
    const config = await registry.getServerConfig('deferred_server');
    expect(config?.resolvedInstructions).toBe(INSTRUCTIONS);
  });

  it.each([
    ['OAuth', oauthDeferredYamlEntry],
    ['runtime placeholders', runtimePlaceholderYamlEntry],
    ['runtime placeholders in an admin API key', runtimeApiKeyPlaceholderYamlEntry],
    ['env-expanded runtime placeholders', envExpandedRuntimeApiKeyPlaceholderYamlEntry],
    [
      'configured-oauth-block',
      {
        ...startupDeferredYamlEntry,
        oauth: { authorization_url: 'https://idp.example.com/authorize' },
      } as unknown as t.ParsedServerConfig,
    ],
    [
      'placeholder-bearing-admin-key',
      {
        ...startupDeferredYamlEntry,
        apiKey: { source: 'admin', authorization_type: 'bearer', key: '{{LIBRECHAT_USER_ID}}' },
      } as unknown as t.ParsedServerConfig,
    ],
  ])('refuses a %s-deferred server at the shared-registry boundary', async (_reason, config) => {
    await registry['cacheConfigsRepo'].add('deferred_server', config);

    const updated = await registry.setResolvedInstructions('deferred_server', INSTRUCTIONS);

    expect(updated).toBe(false);
    expect(
      (await registry.getServerConfig('deferred_server'))?.resolvedInstructions,
    ).toBeUndefined();
  });

  it('stores instructions when the connected config matches the stored YAML entry', async () => {
    await registry['cacheConfigsRepo'].add('deferred_server', startupDeferredYamlEntry);

    const updated = await registry.setResolvedInstructions(
      'deferred_server',
      INSTRUCTIONS,
      'user-1',
      {
        ...startupDeferredYamlEntry,
      },
    );

    expect(updated).toBe(true);
    const config = await registry.getServerConfig('deferred_server');
    expect(config?.resolvedInstructions).toBe(INSTRUCTIONS);
  });

  /** A config-tier override shadowing a YAML base keeps the base's 'yaml' source
   *  tag (`overlaySource`), so the connection manager's tier guard cannot see it.
   *  The shared base entry must not adopt instructions fetched from the
   *  override's endpoint. */
  it('refuses instructions delivered by a config-overlaid connection', async () => {
    await registry['cacheConfigsRepo'].add('deferred_server', startupDeferredYamlEntry);

    const updated = await registry.setResolvedInstructions(
      'deferred_server',
      INSTRUCTIONS,
      'user-1',
      {
        ...startupDeferredYamlEntry,
        url: 'https://tenant-override.example.com/mcp',
      },
    );

    expect(updated).toBe(false);
    const config = await registry.getServerConfig('deferred_server');
    expect(config?.resolvedInstructions).toBeUndefined();
  });

  it('returns false for an unknown server without a user', async () => {
    const updated = await registry.setResolvedInstructions('missing_server', INSTRUCTIONS);
    expect(updated).toBe(false);
  });

  it('leaves DB-tier user servers untouched (identity-preserving DB write is a follow-up)', async () => {
    const dbRepo = registry['dbConfigsRepo'] as unknown as {
      get: jest.Mock;
      update: jest.Mock;
    };
    dbRepo.get.mockResolvedValue({ ...startupDeferredYamlEntry, source: 'user' });

    const updated = await registry.setResolvedInstructions('db_server', INSTRUCTIONS, 'user-1');

    expect(updated).toBe(false);
    expect(dbRepo.update).not.toHaveBeenCalled();
  });

  it('patch on the cache repo merges fields without bumping updatedAt', async () => {
    const repo = registry['cacheConfigsRepo'];
    await repo.add('deferred_server', startupDeferredYamlEntry);
    const stored = await repo.get('deferred_server');

    const patched = await repo.patch!('deferred_server', { resolvedInstructions: INSTRUCTIONS });

    expect(patched).toBe(true);
    const after = await repo.get('deferred_server');
    expect(after?.resolvedInstructions).toBe(INSTRUCTIONS);
    expect(after?.updatedAt).toBe(stored?.updatedAt);
    expect(await repo.patch!('unknown_server', { resolvedInstructions: INSTRUCTIONS })).toBe(false);
  });

  /** The registry validates config identity against a snapshot that can lag by
   *  the cache TTL; the store-side compare-and-set on `updatedAt` is what stops
   *  instructions landing on an entry another replica replaced in between. */
  it('refuses a patch whose expectedUpdatedAt no longer matches the entry', async () => {
    const repo = registry['cacheConfigsRepo'];
    await repo.add('deferred_server', startupDeferredYamlEntry);
    const stale = (await repo.get('deferred_server'))!.updatedAt!;
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(stale + 5000);
    await repo.update('deferred_server', {
      ...startupDeferredYamlEntry,
      url: 'https://replaced.example.com/mcp',
    });
    nowSpy.mockRestore();

    const patched = await repo.patch!(
      'deferred_server',
      { resolvedInstructions: INSTRUCTIONS },
      stale,
    );

    expect(patched).toBe(false);
    expect((await repo.get('deferred_server'))?.resolvedInstructions).toBeUndefined();
  });

  it('passes the validated entry updatedAt into the store patch', async () => {
    const repo = registry['cacheConfigsRepo'];
    await repo.add('deferred_server', startupDeferredYamlEntry);
    const stored = await repo.get('deferred_server');
    const patchSpy = jest.spyOn(repo, 'patch');

    const updated = await registry.setResolvedInstructions('deferred_server', INSTRUCTIONS);

    expect(updated).toBe(true);
    expect(patchSpy).toHaveBeenCalledWith(
      'deferred_server',
      { resolvedInstructions: INSTRUCTIONS },
      stored?.updatedAt,
    );
  });

  it('keeps the first resolved instructions when patches race', async () => {
    const repo = registry['cacheConfigsRepo'];
    await repo.add('deferred_server', startupDeferredYamlEntry);

    await expect(
      repo.patch!('deferred_server', { resolvedInstructions: INSTRUCTIONS }),
    ).resolves.toBe(true);
    await expect(
      repo.patch!('deferred_server', { resolvedInstructions: 'later connection instructions' }),
    ).resolves.toBe(false);
    expect((await repo.get('deferred_server'))?.resolvedInstructions).toBe(INSTRUCTIONS);
  });
});

describe('UserConnectionManager.backfillResolvedInstructions', () => {
  class TestConnectionManager extends UserConnectionManager {}

  let manager: TestConnectionManager;
  let setResolvedInstructions: jest.Mock;

  const connectionWith = (instructions?: string): MCPConnection =>
    ({
      client: { getInstructions: () => instructions },
    }) as unknown as MCPConnection;

  const backfill = (
    config: t.ParsedServerConfig | undefined,
    connection: MCPConnection,
  ): Promise<void> =>
    manager['backfillResolvedInstructions']('deferred_server', config, connection, 'user-1');

  beforeEach(() => {
    manager = new TestConnectionManager();
    setResolvedInstructions = jest.fn().mockResolvedValue(true);
    jest.spyOn(MCPServersRegistry, 'getInstance').mockReturnValue({
      setResolvedInstructions,
    } as unknown as MCPServersRegistry);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('persists instructions delivered by the live connection', async () => {
    const config = { ...startupDeferredYamlEntry };
    await backfill(config, connectionWith(INSTRUCTIONS));

    expect(setResolvedInstructions).toHaveBeenCalledWith(
      'deferred_server',
      INSTRUCTIONS,
      'user-1',
      config,
    );
  });

  it('does not persist instructions for servers with runtime user placeholders', async () => {
    const config = { ...runtimePlaceholderYamlEntry };
    await backfill(config, connectionWith(INSTRUCTIONS));

    expect(setResolvedInstructions).not.toHaveBeenCalled();
  });

  it('skips servers that do not enable serverInstructions', async () => {
    await backfill(
      { ...startupDeferredYamlEntry, serverInstructions: undefined },
      connectionWith(INSTRUCTIONS),
    );
    expect(setResolvedInstructions).not.toHaveBeenCalled();
  });

  it('skips servers whose declaration is already a literal string', async () => {
    await backfill(
      { ...startupDeferredYamlEntry, serverInstructions: 'operator-provided text' },
      connectionWith(INSTRUCTIONS),
    );
    expect(setResolvedInstructions).not.toHaveBeenCalled();
  });

  it('skips servers whose instructions were already resolved', async () => {
    await backfill(
      { ...startupDeferredYamlEntry, resolvedInstructions: INSTRUCTIONS },
      connectionWith('newer text'),
    );
    expect(setResolvedInstructions).not.toHaveBeenCalled();
  });

  it('does not reach the registry when instructions are already resolved', async () => {
    await backfill(
      { ...startupDeferredYamlEntry, resolvedInstructions: INSTRUCTIONS },
      connectionWith('per-identity text for someone else'),
    );

    expect(setResolvedInstructions).not.toHaveBeenCalled();
  });

  it.each([
    ['user', { source: 'user' as const, dbId: 'server-1' }],
    ['plugin', { source: 'plugin' as const }],
    ['config', { source: 'config' as const }],
  ])('does not reach the registry for a %s-tier server', async (_label, overrides) => {
    await backfill({ ...startupDeferredYamlEntry, ...overrides }, connectionWith(INSTRUCTIONS));
    expect(setResolvedInstructions).not.toHaveBeenCalled();
  });

  it.each([
    ['OAuth', oauthDeferredYamlEntry],
    ['OBO', { ...startupDeferredYamlEntry, obo: {} } as unknown as t.ParsedServerConfig],
    [
      'user API keys',
      {
        ...startupDeferredYamlEntry,
        apiKey: { source: 'user' },
      } as unknown as t.ParsedServerConfig,
    ],
    [
      'custom user variables',
      {
        ...startupDeferredYamlEntry,
        customUserVars: { apiKey: { title: 'API key', description: 'Per-user credential' } },
      },
    ],
    ['runtime placeholders', runtimePlaceholderYamlEntry],
    ['runtime placeholders in an admin API key', runtimeApiKeyPlaceholderYamlEntry],
    ['env-expanded runtime placeholders', envExpandedRuntimeApiKeyPlaceholderYamlEntry],
    [
      'a configured oauth block with requiresOAuth stamped false',
      {
        ...startupDeferredYamlEntry,
        oauth: { authorization_url: 'https://idp.example.com/authorize' },
      } as unknown as t.ParsedServerConfig,
    ],
    [
      'configured oauth_headers with requiresOAuth stamped false',
      {
        ...startupDeferredYamlEntry,
        oauth_headers: { 'X-Tenant': 'per-user' },
      } as unknown as t.ParsedServerConfig,
    ],
    [
      'an admin API key whose value is a runtime identity placeholder',
      {
        ...startupDeferredYamlEntry,
        apiKey: {
          source: 'admin',
          authorization_type: 'bearer',
          key: '{{LIBRECHAT_OPENID_ACCESS_TOKEN}}',
        },
      } as unknown as t.ParsedServerConfig,
    ],
  ])('does not persist instructions for %s context', async (_reason, config) => {
    await backfill(config, connectionWith(INSTRUCTIONS));
    expect(setResolvedInstructions).not.toHaveBeenCalled();
  });

  it('still persists instructions for a static admin API key', async () => {
    const config = {
      ...startupDeferredYamlEntry,
      apiKey: { source: 'admin', authorization_type: 'bearer', key: 'static-shared-secret' },
    } as unknown as t.ParsedServerConfig;

    await backfill(config, connectionWith(INSTRUCTIONS));

    expect(setResolvedInstructions).toHaveBeenCalledWith(
      'deferred_server',
      INSTRUCTIONS,
      'user-1',
      config,
    );
  });

  it('still backfills when the stored config carries no source stamp', async () => {
    const { source: _source, ...unstamped } = startupDeferredYamlEntry;
    await backfill(unstamped as t.ParsedServerConfig, connectionWith(INSTRUCTIONS));
    expect(setResolvedInstructions).toHaveBeenCalledWith(
      'deferred_server',
      INSTRUCTIONS,
      'user-1',
      unstamped,
    );
  });

  it('skips connections that advertise no instructions', async () => {
    await backfill({ ...startupDeferredYamlEntry }, connectionWith(undefined));
    expect(setResolvedInstructions).not.toHaveBeenCalled();
  });

  it('never propagates a persistence failure into connection creation', async () => {
    setResolvedInstructions.mockRejectedValue(new Error('cache down'));
    await expect(
      backfill({ ...startupDeferredYamlEntry }, connectionWith(INSTRUCTIONS)),
    ).resolves.toBeUndefined();
  });
});
