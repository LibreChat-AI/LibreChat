import mongoose, { Types } from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { PrincipalType, PrincipalModel } from 'librechat-data-provider';
import type { ConfigRecord } from '~/app/store';
import { tenantStorage, runAsSystem } from '~/config/tenantContext';
import { createConfigMethods, createConfigStore } from './config';
import { resetTenantStrictCache } from '~/tenant/policy';
import { createConfigModel } from '~/models/config';

let mongoServer: MongoMemoryServer;
let methods: ReturnType<typeof createConfigMethods>;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  await createConfigModel(mongoose).init();
  methods = createConfigMethods(mongoose);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

beforeEach(async () => {
  await mongoose.models.Config.deleteMany({});
});

describe('restoreConfig', () => {
  it('restores tombstones and the inactive flag, and never overwrites a newer document', async () => {
    await methods.upsertConfig(PrincipalType.ROLE, 'admin', PrincipalModel.ROLE, {}, 10);
    await methods.tombstoneConfigField(PrincipalType.ROLE, 'admin', PrincipalModel.ROLE, 'a.b', 10);
    await methods.toggleConfigActive(PrincipalType.ROLE, 'admin', false);
    const deleted = await methods.deleteConfig(PrincipalType.ROLE, 'admin');
    const snapshot = { ...deleted! };

    expect(await methods.restoreConfig(snapshot)).toBe(true);
    const restored = await methods.findConfigByPrincipal(PrincipalType.ROLE, 'admin', {
      includeInactive: true,
    });
    expect(restored!.isActive).toBe(false);
    expect(restored!.tombstones).toContain('a.b');

    await methods.upsertConfig(
      PrincipalType.ROLE,
      'admin',
      PrincipalModel.ROLE,
      { interface: { modelSelect: false } },
      99,
    );
    expect(await methods.restoreConfig(snapshot)).toBe(false);
    const kept = await methods.findConfigByPrincipal(PrincipalType.ROLE, 'admin');
    expect(kept!.priority).toBe(99);
  });
});

describe('upsertConfig tombstone preservation', () => {
  it('creates a new config document', async () => {
    const result = await methods.upsertConfig(
      PrincipalType.ROLE,
      'admin',
      PrincipalModel.ROLE,
      { interface: { modelSelect: false } },
      10,
    );

    expect(result).toBeTruthy();
    expect(result!.principalType).toBe(PrincipalType.ROLE);
    expect(result!.principalId).toBe('admin');
    expect(result!.priority).toBe(10);
    expect(result!.isActive).toBe(true);
    expect(result!.configVersion).toBe(1);
  });

  it('is idempotent — second upsert updates the same doc', async () => {
    await methods.upsertConfig(
      PrincipalType.ROLE,
      'admin',
      PrincipalModel.ROLE,
      { interface: { modelSelect: false } },
      10,
    );

    await methods.upsertConfig(
      PrincipalType.ROLE,
      'admin',
      PrincipalModel.ROLE,
      { interface: { modelSelect: true } },
      10,
    );

    const count = await mongoose.models.Config.countDocuments({});
    expect(count).toBe(1);
  });

  it('increments configVersion on each upsert', async () => {
    const first = await methods.upsertConfig(
      PrincipalType.ROLE,
      'admin',
      PrincipalModel.ROLE,
      { interface: { modelSelect: true } },
      10,
    );

    const second = await methods.upsertConfig(
      PrincipalType.ROLE,
      'admin',
      PrincipalModel.ROLE,
      { interface: { modelSelect: false } },
      10,
    );

    expect(first!.configVersion).toBe(1);
    expect(second!.configVersion).toBe(2);
  });

  it('normalizes ObjectId principalId to string', async () => {
    const oid = new Types.ObjectId();
    await methods.upsertConfig(PrincipalType.USER, oid, PrincipalModel.USER, { cache: true }, 100);

    const found = await methods.findConfigByPrincipal(PrincipalType.USER, oid.toString());
    expect(found).toBeTruthy();
    expect(found!.principalId).toBe(oid.toString());
  });
});

describe('findConfigByPrincipal', () => {
  it('finds an active config', async () => {
    await methods.upsertConfig(
      PrincipalType.ROLE,
      'admin',
      PrincipalModel.ROLE,
      { cache: true },
      10,
    );

    const result = await methods.findConfigByPrincipal(PrincipalType.ROLE, 'admin');
    expect(result).toBeTruthy();
    expect(result!.principalType).toBe(PrincipalType.ROLE);
  });

  it('returns null when no config exists', async () => {
    const result = await methods.findConfigByPrincipal(PrincipalType.ROLE, 'nonexistent');
    expect(result).toBeNull();
  });

  it('does not find inactive configs', async () => {
    await methods.upsertConfig(
      PrincipalType.ROLE,
      'admin',
      PrincipalModel.ROLE,
      { cache: true },
      10,
    );
    await methods.toggleConfigActive(PrincipalType.ROLE, 'admin', false);

    const result = await methods.findConfigByPrincipal(PrincipalType.ROLE, 'admin');
    expect(result).toBeNull();
  });
});

describe('listAllConfigs', () => {
  it('returns all configs when no filter', async () => {
    await methods.upsertConfig(PrincipalType.ROLE, 'a', PrincipalModel.ROLE, {}, 10);
    await methods.upsertConfig(PrincipalType.ROLE, 'b', PrincipalModel.ROLE, {}, 20);
    await methods.toggleConfigActive(PrincipalType.ROLE, 'b', false);

    const all = await methods.listAllConfigs();
    expect(all).toHaveLength(2);
  });

  it('filters by isActive when specified', async () => {
    await methods.upsertConfig(PrincipalType.ROLE, 'a', PrincipalModel.ROLE, {}, 10);
    await methods.upsertConfig(PrincipalType.ROLE, 'b', PrincipalModel.ROLE, {}, 20);
    await methods.toggleConfigActive(PrincipalType.ROLE, 'b', false);

    const active = await methods.listAllConfigs({ isActive: true });
    expect(active).toHaveLength(1);
    expect(active[0].principalId).toBe('a');

    const inactive = await methods.listAllConfigs({ isActive: false });
    expect(inactive).toHaveLength(1);
    expect(inactive[0].principalId).toBe('b');
  });

  it('returns configs sorted by priority ascending', async () => {
    await methods.upsertConfig(PrincipalType.ROLE, 'high', PrincipalModel.ROLE, {}, 100);
    await methods.upsertConfig(PrincipalType.ROLE, 'low', PrincipalModel.ROLE, {}, 0);
    await methods.upsertConfig(PrincipalType.ROLE, 'mid', PrincipalModel.ROLE, {}, 50);

    const configs = await methods.listAllConfigs();
    expect(configs.map((c) => c.principalId)).toEqual(['low', 'mid', 'high']);
  });
});

describe('listConfigTombstones', () => {
  it('returns only active profiles with a tombstone at or below the path, without their overrides', async () => {
    const tombstone = (principalId: string, fieldPath: string, priority: number) =>
      methods.tombstoneConfigField(
        PrincipalType.ROLE,
        principalId,
        PrincipalModel.ROLE,
        fieldPath,
        priority,
      );
    await methods.upsertConfig(
      PrincipalType.ROLE,
      'hides',
      PrincipalModel.ROLE,
      { interface: { modelSelect: false }, mcpServers: { docs: { url: 'https://docs.test/mcp' } } },
      20,
    );
    await tombstone('hides', 'mcpServers.github', 20);
    await tombstone('section', 'mcpServers', 10);
    await tombstone('other', 'webSearch', 5);
    await tombstone('prefix', 'mcpServersArchive', 5);
    await tombstone('inactive', 'mcpServers.github', 5);
    await methods.toggleConfigActive(PrincipalType.ROLE, 'inactive', false);
    await mongoose.models.Config.create({
      principalType: PrincipalType.ROLE,
      principalId: 'USER',
      principalModel: PrincipalModel.ROLE,
      priority: 30,
      tenantId: 'acme',
      overrides: { mcpServers: { github: { timeout: 1 } } },
      tombstones: ['mcpServers.github.headers', 'webSearch'],
    });

    const found = await methods.listConfigTombstones('mcpServers');

    expect(found).toEqual([
      { principalType: PrincipalType.ROLE, principalId: 'section', tombstones: ['mcpServers'] },
      {
        principalType: PrincipalType.ROLE,
        principalId: 'hides',
        tombstones: ['mcpServers.github'],
      },
      {
        principalType: PrincipalType.ROLE,
        principalId: 'USER',
        tenantId: 'acme',
        tombstones: ['mcpServers.github.headers', 'webSearch'],
      },
    ]);
  });
});

describe('getApplicableConfigs', () => {
  it('always includes the __base__ config', async () => {
    await methods.upsertConfig(
      PrincipalType.ROLE,
      '__base__',
      PrincipalModel.ROLE,
      { cache: true },
      0,
    );

    const configs = await methods.getApplicableConfigs([]);
    expect(configs).toHaveLength(1);
    expect(configs[0].principalId).toBe('__base__');
  });

  it('returns base + matching principals', async () => {
    await methods.upsertConfig(
      PrincipalType.ROLE,
      '__base__',
      PrincipalModel.ROLE,
      { cache: true },
      0,
    );
    await methods.upsertConfig(
      PrincipalType.ROLE,
      'admin',
      PrincipalModel.ROLE,
      { version: '2' },
      10,
    );
    await methods.upsertConfig(
      PrincipalType.ROLE,
      'user',
      PrincipalModel.ROLE,
      { version: '3' },
      10,
    );

    const configs = await methods.getApplicableConfigs([
      { principalType: PrincipalType.ROLE, principalId: 'admin' },
    ]);

    expect(configs).toHaveLength(2);
    expect(configs.map((c) => c.principalId).sort()).toEqual(['__base__', 'admin']);
  });

  it('returns sorted by priority', async () => {
    await methods.upsertConfig(PrincipalType.ROLE, '__base__', PrincipalModel.ROLE, {}, 0);
    await methods.upsertConfig(PrincipalType.ROLE, 'admin', PrincipalModel.ROLE, {}, 10);

    const configs = await methods.getApplicableConfigs([
      { principalType: PrincipalType.ROLE, principalId: 'admin' },
    ]);

    expect(configs[0].principalId).toBe('__base__');
    expect(configs[1].principalId).toBe('admin');
  });

  it('returns Base first and a stable order for equal priorities, whatever the stored ones', async () => {
    const groups = Array.from({ length: 5 }, () => new Types.ObjectId().toString());
    for (const groupId of groups) {
      await methods.upsertConfig(PrincipalType.GROUP, groupId, PrincipalModel.GROUP, {}, 20);
    }
    await methods.upsertConfig(PrincipalType.USER, 'u1', PrincipalModel.USER, {}, 20);
    await methods.upsertConfig(PrincipalType.ROLE, 'admin', PrincipalModel.ROLE, {}, 20);
    await methods.upsertConfig(PrincipalType.ROLE, '__base__', PrincipalModel.ROLE, {}, 90);
    const principals = [
      { principalType: PrincipalType.USER, principalId: 'u1' },
      { principalType: PrincipalType.ROLE, principalId: 'admin' },
      ...groups.map((principalId) => ({ principalType: PrincipalType.GROUP, principalId })),
    ];
    const order = async () =>
      (await methods.getApplicableConfigs(principals)).map(
        (config) => `${config.principalType}:${config.principalId}`,
      );

    const first = await order();
    expect(first[0]).toBe('role:__base__');
    expect(first[1]).toBe('role:admin');
    expect(first[first.length - 1]).toBe('user:u1');
    for (let round = 0; round < 5; round++) {
      expect(await order()).toEqual(first);
    }
    expect(
      (await methods.listAllConfigs()).map(
        (config) => `${config.principalType}:${config.principalId}`,
      ),
    ).toEqual(first);
  });

  it('skips principals with undefined principalId', async () => {
    await methods.upsertConfig(PrincipalType.ROLE, '__base__', PrincipalModel.ROLE, {}, 0);

    const configs = await methods.getApplicableConfigs([
      { principalType: PrincipalType.GROUP, principalId: undefined },
    ]);

    expect(configs).toHaveLength(1);
  });

  describe('tenant partition', () => {
    const USER_ROLE = [{ principalType: PrincipalType.ROLE, principalId: 'USER' }];

    /** Inserts documents directly so each one keeps exactly the `tenantId` form it is given. */
    async function seed(
      docs: Array<{ principalId: string; label: string; tenantId?: string | null }>,
    ): Promise<void> {
      await mongoose.connection.db!.collection('configs').insertMany(
        docs.map(({ principalId, label, tenantId }, index) => ({
          principalType: PrincipalType.ROLE,
          principalId,
          principalModel: PrincipalModel.ROLE,
          priority: principalId === '__base__' ? 0 : 10 + index,
          overrides: { registration: { allowedDomains: [label] } },
          tombstones: [],
          isActive: true,
          configVersion: 1,
          ...(tenantId !== undefined && { tenantId }),
        })),
      );
    }

    const labels = (configs: ConfigRecord[]): string[] =>
      configs.map((config) => config.overrides.registration?.allowedDomains?.[0] ?? '');

    beforeEach(async () => {
      await seed([
        { principalId: '__base__', label: 'deployment-base' },
        { principalId: '__base__', label: 'a-base', tenantId: 'tenant-a' },
        { principalId: '__base__', label: 'b-base', tenantId: 'tenant-b' },
        { principalId: 'USER', label: 'deployment-user' },
        { principalId: 'USER', label: 'a-user', tenantId: 'tenant-a' },
        { principalId: 'USER', label: 'b-user', tenantId: 'tenant-b' },
      ]);
    });

    afterEach(() => {
      delete process.env.TENANT_ISOLATION_STRICT;
      resetTenantStrictCache();
    });

    it('reads only tenantless documents outside a tenant', async () => {
      expect(labels(await methods.getApplicableConfigs(USER_ROLE))).toEqual([
        'deployment-base',
        'deployment-user',
      ]);
    });

    it('reads only tenantless documents under the system sentinel', async () => {
      const configs = await runAsSystem(() => methods.getApplicableConfigs(USER_ROLE));
      expect(labels(configs)).toEqual(['deployment-base', 'deployment-user']);
    });

    it("reads only the active tenant's documents", async () => {
      const configs = await tenantStorage.run({ tenantId: 'tenant-a' }, () =>
        methods.getApplicableConfigs(USER_ROLE),
      );
      expect(labels(configs)).toEqual(['a-base', 'a-user']);
    });

    it("never falls back to the deployment's documents inside a tenant", async () => {
      const configs = await tenantStorage.run({ tenantId: 'tenant-c' }, () =>
        methods.getApplicableConfigs(USER_ROLE),
      );
      expect(configs).toEqual([]);
    });

    it('treats a stored null or empty tenantId as tenantless', async () => {
      await mongoose.models.Config.deleteMany({});
      await seed([
        { principalId: '__base__', label: 'null-base', tenantId: null },
        { principalId: 'USER', label: 'empty-user', tenantId: '' },
        { principalId: 'ADMIN', label: 'a-admin', tenantId: 'tenant-a' },
      ]);

      const configs = await methods.getApplicableConfigs([
        ...USER_ROLE,
        { principalType: PrincipalType.ROLE, principalId: 'ADMIN' },
      ]);
      expect(labels(configs)).toEqual(['null-base', 'empty-user']);
    });

    it('refuses a read with no tenant context in strict mode', async () => {
      process.env.TENANT_ISOLATION_STRICT = 'true';
      resetTenantStrictCache();

      await expect(methods.getApplicableConfigs(USER_ROLE)).rejects.toThrow('[TenantIsolation]');
    });
  });
});

describe('patchConfigFields', () => {
  it('atomically sets specific fields via $set', async () => {
    await methods.upsertConfig(
      PrincipalType.ROLE,
      'admin',
      PrincipalModel.ROLE,
      { interface: { modelSelect: true, parameters: true } },
      10,
    );

    const result = await methods.patchConfigFields(
      PrincipalType.ROLE,
      'admin',
      PrincipalModel.ROLE,
      { 'interface.modelSelect': false },
      10,
    );

    const overrides = result!.overrides as Record<string, unknown>;
    const iface = overrides.interface as Record<string, unknown>;
    expect(iface.modelSelect).toBe(false);
    expect(iface.parameters).toBe(true);
  });

  it('creates a config if none exists (upsert)', async () => {
    const result = await methods.patchConfigFields(
      PrincipalType.ROLE,
      'newrole',
      PrincipalModel.ROLE,
      { 'interface.modelSelect': false },
      10,
    );

    expect(result).toBeTruthy();
    expect(result!.principalId).toBe('newrole');
  });

  it('clears tombstones for patched paths and their ancestors', async () => {
    await methods.tombstoneConfigField(
      PrincipalType.ROLE,
      'admin',
      PrincipalModel.ROLE,
      'mcpServers.github',
      10,
    );

    const result = await methods.patchConfigFields(
      PrincipalType.ROLE,
      'admin',
      PrincipalModel.ROLE,
      { 'mcpServers.github.url': 'https://scoped.example.com' },
      10,
    );

    expect(result!.tombstones).not.toContain('mcpServers.github');
  });

  it('does not clear a whole-section tombstone when patching a nested path', async () => {
    await methods.tombstoneConfigField(
      PrincipalType.ROLE,
      'admin',
      PrincipalModel.ROLE,
      'mcpServers',
      10,
    );

    const result = await methods.patchConfigFields(
      PrincipalType.ROLE,
      'admin',
      PrincipalModel.ROLE,
      { 'mcpServers.github.url': 'https://scoped.example.com' },
      10,
    );

    expect(result!.tombstones).toContain('mcpServers');
  });
});

describe('tombstoneConfigField', () => {
  it('adds a tombstone and removes the overridden subtree', async () => {
    await methods.upsertConfig(
      PrincipalType.ROLE,
      'admin',
      PrincipalModel.ROLE,
      {
        mcpServers: {
          github: {
            type: 'streamable-http',
            url: 'https://github.example.com',
          },
          slack: {
            type: 'streamable-http',
            url: 'https://slack.example.com',
          },
        },
      },
      10,
    );

    const result = await methods.tombstoneConfigField(
      PrincipalType.ROLE,
      'admin',
      PrincipalModel.ROLE,
      'mcpServers.github',
      10,
    );
    const overrides = result!.overrides as Record<string, unknown>;
    const mcpServers = overrides.mcpServers as Record<string, unknown>;

    expect(result!.tombstones).toContain('mcpServers.github');
    expect(mcpServers.github).toBeUndefined();
    expect(mcpServers.slack).toEqual({
      type: 'streamable-http',
      url: 'https://slack.example.com',
    });
  });

  it('creates a config if none exists', async () => {
    const result = await methods.tombstoneConfigField(
      PrincipalType.ROLE,
      'admin',
      PrincipalModel.ROLE,
      'mcpServers.github',
      10,
    );

    expect(result).toBeTruthy();
    expect(result!.tombstones).toContain('mcpServers.github');
  });

  it('preserves inactive configs when adding a tombstone', async () => {
    await methods.upsertConfig(PrincipalType.ROLE, 'admin', PrincipalModel.ROLE, {}, 10);
    await methods.toggleConfigActive(PrincipalType.ROLE, 'admin', false);

    const result = await methods.tombstoneConfigField(
      PrincipalType.ROLE,
      'admin',
      PrincipalModel.ROLE,
      'mcpServers.github',
      10,
    );

    expect(result!.isActive).toBe(false);
    expect(result!.tombstones).toContain('mcpServers.github');
  });
});

describe('upsertConfig', () => {
  it('preserves tombstones when replacing overrides', async () => {
    await methods.tombstoneConfigField(
      PrincipalType.ROLE,
      'admin',
      PrincipalModel.ROLE,
      'mcpServers.github',
      10,
    );

    const result = await methods.upsertConfig(
      PrincipalType.ROLE,
      'admin',
      PrincipalModel.ROLE,
      { interface: { modelSelect: false } },
      10,
    );

    expect(result!.tombstones).toContain('mcpServers.github');
  });
});

describe('upsertConfig priority', () => {
  it('keeps the stored priority when none is given, and defaults by principal type on create', async () => {
    const groupId = new Types.ObjectId().toString();
    const created = await methods.upsertConfig(PrincipalType.GROUP, groupId, PrincipalModel.GROUP, {
      interface: { modelSelect: false },
    });
    expect(created!.priority).toBe(20);

    await methods.setConfigPriority(PrincipalType.GROUP, groupId, 35);
    const replaced = await methods.upsertConfig(
      PrincipalType.GROUP,
      groupId,
      PrincipalModel.GROUP,
      { interface: { modelSelect: true } },
    );
    expect(replaced!.priority).toBe(35);
  });
});

describe('setConfigPriority', () => {
  it('changes only the priority of a stored document', async () => {
    await methods.patchConfigFields(PrincipalType.ROLE, 'prio', PrincipalModel.ROLE, {
      'interface.customWelcome': 'hi',
    });
    await methods.tombstoneConfigField(PrincipalType.ROLE, 'prio', PrincipalModel.ROLE, 'memory');
    await methods.toggleConfigActive(PrincipalType.ROLE, 'prio', false);

    const result = await methods.setConfigPriority(PrincipalType.ROLE, 'prio', 3);

    expect(result!.changed).toBe(true);
    const stored = await methods.findConfigByPrincipal(PrincipalType.ROLE, 'prio', {
      includeInactive: true,
    });
    expect(stored).toMatchObject({
      priority: 3,
      overrides: { interface: { customWelcome: 'hi' } },
      tombstones: ['memory'],
      isActive: false,
      configVersion: 4,
    });
    expect(await methods.setConfigPriority(PrincipalType.ROLE, 'missing', 3)).toBeNull();
  });
});

describe('renameConfigPrincipal', () => {
  it('moves a profile with dotted keys, storing them as the engine accepts them', async () => {
    const profiles = { 'us.anthropic.claude-sonnet-4-5': 'arn:aws:x' };
    await methods.patchConfigFields(PrincipalType.ROLE, 'editor', PrincipalModel.ROLE, {
      'endpoints.bedrock.inferenceProfiles': profiles,
    });

    const moved = await methods.renameConfigPrincipal(PrincipalType.ROLE, 'editor', 'writer');

    expect(moved!.principalId).toBe('writer');
    expect(moved!.overrides).toEqual({ endpoints: { bedrock: { inferenceProfiles: profiles } } });
    expect(await raw().findOne({ principalId: 'editor' })).toBeNull();
    const stored = await raw().findOne({ principalId: 'writer' });
    expect(stored!.overrides.endpoints.bedrock.inferenceProfiles).toEqual(profiles);
    expect(stored!.keyEncoding).toBeUndefined();
  });

  it('refuses to move onto a principal that has a profile, changing nothing', async () => {
    await methods.patchConfigFields(PrincipalType.ROLE, 'a', PrincipalModel.ROLE, { x: 1 });
    await methods.patchConfigFields(PrincipalType.ROLE, 'b', PrincipalModel.ROLE, { y: 1 });

    await expect(methods.renameConfigPrincipal(PrincipalType.ROLE, 'a', 'b')).rejects.toMatchObject(
      { code: 'CONFIG_PRINCIPAL_EXISTS' },
    );
    expect((await methods.findConfigByPrincipal(PrincipalType.ROLE, 'a'))!.overrides).toEqual({
      x: 1,
    });
    expect((await methods.findConfigByPrincipal(PrincipalType.ROLE, 'b'))!.overrides).toEqual({
      y: 1,
    });
  });
});

const inTenant = <T>(tenantId: string, run: () => Promise<T>): Promise<T> =>
  tenantStorage.run({ tenantId }, run);
const seedTenant = (tenantId: string, principalId: string, overrides: Record<string, unknown>) =>
  inTenant(tenantId, () =>
    methods.patchConfigFields(PrincipalType.ROLE, principalId, PrincipalModel.ROLE, overrides),
  );
/**
 * A platform-level document, inserted directly so it keeps exactly the tenantless form it is
 * given: no `tenantId`, or an unclaimed `null` or `''`.
 */
const seedPlatform = (
  principalId: string,
  overrides: Record<string, unknown>,
  tenant: { tenantId?: string | null } = {},
) =>
  raw().insertOne({
    principalType: PrincipalType.ROLE,
    principalId,
    principalModel: PrincipalModel.ROLE,
    priority: 10,
    overrides,
    tombstones: [],
    isActive: true,
    configVersion: 1,
    ...tenant,
  });
/** Every stored role document as `tenant/principalId`, platform-level ones as `-/…`. */
const layout = async () =>
  (
    await raw()
      .find({ principalType: PrincipalType.ROLE })
      .project<{ principalId: string; tenantId?: string | null }>({ principalId: 1, tenantId: 1 })
      .toArray()
  )
    .map((document) => `${document.tenantId || '-'}/${document.principalId}`)
    .sort();
/** Every stored role document as `tenant/principalId:priority`, platform-level ones as `-/…`. */
const priorities = async () =>
  (
    await raw()
      .find({ principalType: PrincipalType.ROLE })
      .project<{ principalId: string; priority: number; tenantId?: string | null }>({
        principalId: 1,
        priority: 1,
        tenantId: 1,
      })
      .toArray()
  )
    .map((document) => `${document.tenantId || '-'}/${document.principalId}:${document.priority}`)
    .sort();

describe('renameConfigPrincipal in the caller tenant partition', () => {
  it('moves only the platform-level profile for a caller without a tenant', async () => {
    await seedTenant('tenant-a', 'editor', { x: 'tenant-a' });
    await seedPlatform('editor', { x: 'platform' });

    const moved = await methods.renameConfigPrincipal(PrincipalType.ROLE, 'editor', 'writer');

    expect(moved!.overrides).toEqual({ x: 'platform' });
    expect(moved!.tenantId).toBeUndefined();
    expect(await layout()).toEqual(['-/writer', 'tenant-a/editor']);
  });

  it("never moves a tenant's profile to the platform when the platform role has none", async () => {
    await seedTenant('tenant-a', 'editor', { x: 'tenant-a' });

    expect(await methods.renameConfigPrincipal(PrincipalType.ROLE, 'editor', 'writer')).toBeNull();
    expect(await layout()).toEqual(['tenant-a/editor']);
  });

  it('is refused only by a profile at the new name in the same partition', async () => {
    await seedTenant('tenant-a', 'writer', { x: 'tenant-a' });
    await seedPlatform('editor', { x: 'platform' });

    const moved = await methods.renameConfigPrincipal(PrincipalType.ROLE, 'editor', 'writer');

    expect(moved!.overrides).toEqual({ x: 'platform' });
    expect(await layout()).toEqual(['-/writer', 'tenant-a/writer']);
    await seedPlatform('editor', { x: 'again' });
    await expect(
      methods.renameConfigPrincipal(PrincipalType.ROLE, 'editor', 'writer'),
    ).rejects.toMatchObject({ code: 'CONFIG_PRINCIPAL_EXISTS' });
    expect(await layout()).toEqual(['-/editor', '-/writer', 'tenant-a/writer']);
  });

  it("moves only the active tenant's profile inside a tenant", async () => {
    await seedPlatform('editor', { x: 'platform' });
    await seedTenant('tenant-b', 'editor', { x: 'tenant-b' });
    await seedTenant('tenant-a', 'editor', { x: 'tenant-a' });

    const moved = await inTenant('tenant-a', () =>
      methods.renameConfigPrincipal(PrincipalType.ROLE, 'editor', 'writer'),
    );

    expect(moved!.overrides).toEqual({ x: 'tenant-a' });
    expect(moved!.tenantId).toBe('tenant-a');
    expect(await layout()).toEqual(['-/editor', 'tenant-a/writer', 'tenant-b/editor']);
  });

  it('treats an unclaimed profile (null or empty tenant) as platform-level', async () => {
    await seedTenant('tenant-a', 'editor', { x: 'tenant-a' });
    await seedPlatform('editor', { x: 'unclaimed' }, { tenantId: '' });
    await seedPlatform('author', { x: 'unclaimed' }, { tenantId: null });

    const moved = await Promise.all([
      methods.renameConfigPrincipal(PrincipalType.ROLE, 'editor', 'writer'),
      methods.renameConfigPrincipal(PrincipalType.ROLE, 'author', 'reader'),
    ]);

    expect(moved.map((record) => record!.overrides)).toEqual([
      { x: 'unclaimed' },
      { x: 'unclaimed' },
    ]);
    expect(await layout()).toEqual(['-/reader', '-/writer', 'tenant-a/editor']);
  });

  it("reads a role's profile only in the caller partition, as a rename's target check does", async () => {
    await seedTenant('tenant-a', 'editor', { x: 'tenant-a' });

    const platformRead = await methods.findConfigByPrincipal(PrincipalType.ROLE, 'editor', {
      includeInactive: true,
    });
    const tenantRead = await inTenant('tenant-a', () =>
      methods.findConfigByPrincipal(PrincipalType.ROLE, 'editor'),
    );

    expect(platformRead).toBeNull();
    expect(tenantRead!.overrides).toEqual({ x: 'tenant-a' });
  });

  /**
   * The driver applies the next insert and reports a dropped connection instead of its reply;
   * with `unsettled`, the lookup that would settle it fails as well.
   */
  function loseNextCreateAcknowledgement(options: { unsettled?: boolean } = {}): Error {
    const collection = mongoose.models.Config.collection;
    const findOneAndUpdate = collection.findOneAndUpdate.bind(collection);
    const lost = new mongoose.mongo.MongoNetworkError('connection reset after the write applied');
    jest.spyOn(collection, 'findOneAndUpdate').mockImplementationOnce((async (
      ...args: Parameters<typeof findOneAndUpdate>
    ) => {
      await findOneAndUpdate(...args);
      if (options.unsettled) {
        jest
          .spyOn(collection, 'findOne')
          .mockRejectedValueOnce(new mongoose.mongo.MongoNetworkError('still disconnected'));
      }
      throw lost;
    }) as unknown as typeof collection.findOneAndUpdate);
    return lost;
  }

  it("settles a copy whose acknowledgement was lost and finishes the move in the caller's tenant", async () => {
    await seedTenant('tenant-b', 'writer', { x: 'tenant-b' });
    await seedTenant('tenant-a', 'editor', { x: 'tenant-a' });
    loseNextCreateAcknowledgement();

    const moved = await inTenant('tenant-a', () =>
      methods.renameConfigPrincipal(PrincipalType.ROLE, 'editor', 'writer'),
    );

    expect(moved!.overrides).toEqual({ x: 'tenant-a' });
    expect(moved!.tenantId).toBe('tenant-a');
    expect(await layout()).toEqual(['tenant-a/writer', 'tenant-b/writer']);
  });

  it('keeps both documents and rethrows when a lost acknowledgement cannot be settled', async () => {
    await seedPlatform('editor', { x: 'platform' });
    const lost = loseNextCreateAcknowledgement({ unsettled: true });

    await expect(
      methods.renameConfigPrincipal(PrincipalType.ROLE, 'editor', 'writer'),
    ).rejects.toBe(lost);
    expect(await layout()).toEqual(['-/editor', '-/writer']);
  });
});

describe('setConfigPriority in the caller tenant partition', () => {
  it('changes only the platform-level profile for a caller without a tenant', async () => {
    await seedTenant('tenant-a', 'editor', { x: 'tenant-a' });
    await seedPlatform('editor', { x: 'platform' });
    await seedPlatform('author', { x: 'unclaimed' }, { tenantId: '' });

    const result = await methods.setConfigPriority(PrincipalType.ROLE, 'editor', 40);
    const unclaimed = await methods.setConfigPriority(PrincipalType.ROLE, 'author', 30);

    expect(result).toMatchObject({ changed: true, config: { priority: 40 } });
    expect(result!.config.overrides).toEqual({ x: 'platform' });
    expect(result!.config.tenantId).toBeUndefined();
    expect(unclaimed).toMatchObject({ changed: true, config: { overrides: { x: 'unclaimed' } } });
    expect(await priorities()).toEqual(['-/author:30', '-/editor:40', 'tenant-a/editor:10']);
  });

  it("never changes or returns a tenant's profile when the platform role has none", async () => {
    const tenantProfile = await seedTenant('tenant-a', 'editor', { x: 'tenant-a' });

    expect(await methods.setConfigPriority(PrincipalType.ROLE, 'editor', 40)).toBeNull();
    await expect(
      methods.setConfigPriority(PrincipalType.ROLE, 'editor', 40, {
        expectedRevision: `${tenantProfile!._id}:${tenantProfile!.configVersion}`,
      }),
    ).rejects.toMatchObject({ code: 'CONFIG_VERSION_CONFLICT', currentRevision: null });
    expect(await priorities()).toEqual(['tenant-a/editor:10']);
  });

  it("changes only the active tenant's profile inside a tenant", async () => {
    await seedPlatform('editor', { x: 'platform' });
    await seedTenant('tenant-b', 'editor', { x: 'tenant-b' });
    await seedTenant('tenant-a', 'editor', { x: 'tenant-a' });

    const result = await inTenant('tenant-a', () =>
      methods.setConfigPriority(PrincipalType.ROLE, 'editor', 40),
    );

    expect(result!.config).toMatchObject({ tenantId: 'tenant-a', overrides: { x: 'tenant-a' } });
    expect(await priorities()).toEqual(['-/editor:10', 'tenant-a/editor:40', 'tenant-b/editor:10']);
  });
});

describe('unsetConfigField', () => {
  it('removes a field from overrides via $unset', async () => {
    await methods.upsertConfig(
      PrincipalType.ROLE,
      'admin',
      PrincipalModel.ROLE,
      { interface: { modelSelect: false, parameters: false } },
      10,
    );

    const result = await methods.unsetConfigField(
      PrincipalType.ROLE,
      'admin',
      'interface.modelSelect',
    );
    const overrides = result!.overrides as Record<string, unknown>;
    const iface = overrides.interface as Record<string, unknown>;
    expect(iface.modelSelect).toBeUndefined();
    expect(iface.parameters).toBe(false);
  });

  it('returns null for non-existent config', async () => {
    const result = await methods.unsetConfigField(PrincipalType.ROLE, 'ghost', 'a.b');
    expect(result).toBeNull();
  });

  it('clears tombstones for the reset path and descendants', async () => {
    await methods.tombstoneConfigField(
      PrincipalType.ROLE,
      'admin',
      PrincipalModel.ROLE,
      'mcpServers.github',
      10,
    );

    const result = await methods.unsetConfigField(PrincipalType.ROLE, 'admin', 'mcpServers.github');

    expect(result!.tombstones).not.toContain('mcpServers.github');
  });
});

/** Storage half of removing one inherited MCP record key; the merge half is in `resolution.spec.ts`. */
describe('MCP record-key tombstones', () => {
  const KEY = 'mcpServers.github.headers.Authorization';

  async function tombstoneKey(): Promise<void> {
    await methods.tombstoneConfigField(PrincipalType.ROLE, 'admin', PrincipalModel.ROLE, KEY, 10);
  }

  it('survives a write to a sibling key of the same record', async () => {
    await tombstoneKey();

    const result = await methods.patchConfigFields(
      PrincipalType.ROLE,
      'admin',
      PrincipalModel.ROLE,
      { 'mcpServers.github.headers.X-Extra': 'added' },
      10,
    );

    expect(result!.tombstones).toEqual([KEY]);
  });

  it('is cleared when the profile writes that key itself', async () => {
    await tombstoneKey();

    const result = await methods.patchConfigFields(
      PrincipalType.ROLE,
      'admin',
      PrincipalModel.ROLE,
      { [KEY]: 'Bearer {{SCOPED}}' },
      10,
    );

    expect(result!.tombstones).toEqual([]);
  });

  it('is removed alone by a reset of the same path', async () => {
    await tombstoneKey();
    await methods.tombstoneConfigField(
      PrincipalType.ROLE,
      'admin',
      PrincipalModel.ROLE,
      'mcpServers.github.headers.X-Team',
      10,
    );

    const result = await methods.unsetConfigField(PrincipalType.ROLE, 'admin', KEY);

    expect(result!.tombstones).toEqual(['mcpServers.github.headers.X-Team']);
  });

  it('is removed by a reset of the whole record, along with the keys the profile wrote', async () => {
    await methods.patchConfigFields(
      PrincipalType.ROLE,
      'admin',
      PrincipalModel.ROLE,
      { 'mcpServers.github.headers.X-Extra': 'added' },
      10,
    );
    await tombstoneKey();

    const result = await methods.unsetConfigField(
      PrincipalType.ROLE,
      'admin',
      'mcpServers.github.headers',
    );

    expect(result!.tombstones).toEqual([]);
    expect(result!.overrides).toEqual({});
  });
});

describe('keyed tombstones of custom endpoints', () => {
  const HIDE = 'endpoints.custom["My \\"Gateway\\" v1.2"]';
  const own = { name: 'gw', baseURL: 'https://gw.example.com', headers: { A: 'a', B: 'b' } };

  async function stored(): Promise<ConfigRecord | null> {
    return methods.findConfigByPrincipal(PrincipalType.ROLE, 'admin');
  }

  it('hides an entry on a document with no array, storing the canonical keyed path as is', async () => {
    const result = await methods.tombstoneConfigField(
      PrincipalType.ROLE,
      'admin',
      PrincipalModel.ROLE,
      'endpoints.custom["My \\u0022Gateway\\u0022 v1.2"]',
      10,
    );

    expect(result.tombstones).toEqual([HIDE]);
    expect(result.overrides).toEqual({});
    const raw = await mongoose.models.Config.collection.findOne({ principalId: 'admin' });
    expect(raw?.tombstones).toEqual([HIDE]);
  });

  it('removes a path inside an entry an earlier write created, and keeps the rest of it', async () => {
    await methods.patchConfigFields(PrincipalType.ROLE, 'admin', PrincipalModel.ROLE, {
      'endpoints.custom': [own],
    });

    const result = await methods.tombstoneConfigField(
      PrincipalType.ROLE,
      'admin',
      PrincipalModel.ROLE,
      'endpoints.custom["gw"].headers.A',
    );

    expect(result.overrides).toEqual({
      endpoints: { custom: [{ ...own, headers: { B: 'b' } }] },
    });
    expect(result.tombstones).toEqual(['endpoints.custom["gw"].headers.A']);
  });

  it('clears the hide of an entry the profile writes again, keeping the tombstones inside it', async () => {
    await methods.tombstoneConfigField(PrincipalType.ROLE, 'admin', PrincipalModel.ROLE, [
      'endpoints.custom["gw"]',
      'endpoints.custom["gw"].headers.A',
      'endpoints.custom["other"]',
    ]);

    const result = await methods.patchConfigFields(
      PrincipalType.ROLE,
      'admin',
      PrincipalModel.ROLE,
      { 'endpoints.custom': [{ name: 'gw', titleModel: 'x' }] },
    );

    expect(result.tombstones).toEqual([
      'endpoints.custom["gw"].headers.A',
      'endpoints.custom["other"]',
    ]);
  });

  it('unsets an entry by key, and the collection with every keyed tombstone under it', async () => {
    await methods.patchConfigFields(PrincipalType.ROLE, 'admin', PrincipalModel.ROLE, {
      'endpoints.custom': [own, { name: 'kept', baseURL: 'https://kept' }],
    });
    await methods.tombstoneConfigField(PrincipalType.ROLE, 'admin', PrincipalModel.ROLE, [
      'endpoints.custom["gw"].headers.A',
      'endpoints.custom["yaml"]',
      'memory.agent',
    ]);

    const entry = await methods.unsetConfigField(
      PrincipalType.ROLE,
      'admin',
      'endpoints.custom["gw"]',
    );
    expect(entry!.overrides).toEqual({
      endpoints: { custom: [{ name: 'kept', baseURL: 'https://kept' }] },
    });
    expect(entry!.tombstones).toEqual(['endpoints.custom["yaml"]', 'memory.agent']);

    const collection = await methods.unsetConfigField(
      PrincipalType.ROLE,
      'admin',
      'endpoints.custom',
    );
    expect(collection!.overrides).toEqual({});
    expect(collection!.tombstones).toEqual(['memory.agent']);
  });

  it('counts a document holding only keyed tombstones as not empty', async () => {
    await methods.tombstoneConfigField(
      PrincipalType.ROLE,
      'admin',
      PrincipalModel.ROLE,
      'endpoints.custom["gw"]',
    );

    const deleted = await methods.deleteConfig(PrincipalType.ROLE, 'admin', undefined, {
      expectEmpty: true,
    });

    expect(deleted).toBeNull();
    expect((await stored())?.tombstones).toEqual(['endpoints.custom["gw"]']);
  });

  it('refuses a malformed keyed path, or one after an array not merged by key', async () => {
    for (const path of ['endpoints.custom["gw"', 'modelSpecs.list["a"]']) {
      await expect(
        methods.tombstoneConfigField(PrincipalType.ROLE, 'admin', PrincipalModel.ROLE, path),
      ).rejects.toMatchObject({ code: 'CONFIG_PATH_INVALID', reason: 'keyed_path' });
    }
    expect(await stored()).toBeNull();
  });
});

describe('deleteConfig', () => {
  it('deletes and returns the config', async () => {
    await methods.upsertConfig(PrincipalType.ROLE, 'admin', PrincipalModel.ROLE, {}, 10);
    const deleted = await methods.deleteConfig(PrincipalType.ROLE, 'admin');
    expect(deleted).toBeTruthy();

    const found = await methods.findConfigByPrincipal(PrincipalType.ROLE, 'admin');
    expect(found).toBeNull();
  });

  it('returns null when deleting non-existent config', async () => {
    const result = await methods.deleteConfig(PrincipalType.ROLE, 'ghost');
    expect(result).toBeNull();
  });
});

describe('toggleConfigActive', () => {
  it('deactivates an active config', async () => {
    await methods.upsertConfig(PrincipalType.ROLE, 'admin', PrincipalModel.ROLE, {}, 10);

    const result = await methods.toggleConfigActive(PrincipalType.ROLE, 'admin', false);
    expect(result!.isActive).toBe(false);
  });

  it('reactivates an inactive config', async () => {
    await methods.upsertConfig(PrincipalType.ROLE, 'admin', PrincipalModel.ROLE, {}, 10);
    await methods.toggleConfigActive(PrincipalType.ROLE, 'admin', false);

    const result = await methods.toggleConfigActive(PrincipalType.ROLE, 'admin', true);
    expect(result!.isActive).toBe(true);
  });
});

describe('expectEmpty atomic guard', () => {
  it('deleteConfig with expectEmpty matches and deletes an empty doc', async () => {
    await methods.upsertConfig(PrincipalType.ROLE, 'admin', PrincipalModel.ROLE, {}, 10);

    const result = await methods.deleteConfig(PrincipalType.ROLE, 'admin', undefined, {
      expectEmpty: true,
    });
    expect(result).toBeTruthy();

    const remaining = await mongoose.models.Config.countDocuments({});
    expect(remaining).toBe(0);
  });

  it('deleteConfig with expectEmpty returns null when overrides is non-empty (doc preserved)', async () => {
    await methods.upsertConfig(
      PrincipalType.ROLE,
      'admin',
      PrincipalModel.ROLE,
      { interface: { modelSelect: false } },
      10,
    );

    const result = await methods.deleteConfig(PrincipalType.ROLE, 'admin', undefined, {
      expectEmpty: true,
    });
    expect(result).toBeNull();

    const remaining = await mongoose.models.Config.countDocuments({});
    expect(remaining).toBe(1);
  });

  it('deleteConfig with expectEmpty returns null when tombstones is non-empty (doc preserved)', async () => {
    await mongoose.models.Config.create({
      principalType: PrincipalType.ROLE,
      principalId: 'admin',
      principalModel: PrincipalModel.ROLE,
      overrides: {},
      tombstones: ['endpoints.openai.apiKey'],
      priority: 10,
      isActive: true,
      configVersion: 1,
    });

    const result = await methods.deleteConfig(PrincipalType.ROLE, 'admin', undefined, {
      expectEmpty: true,
    });
    expect(result).toBeNull();

    const remaining = await mongoose.models.Config.countDocuments({});
    expect(remaining).toBe(1);
  });

  it('toggleConfigActive with expectEmpty matches and toggles an empty doc', async () => {
    await methods.upsertConfig(PrincipalType.ROLE, 'admin', PrincipalModel.ROLE, {}, 10);

    const result = await methods.toggleConfigActive(PrincipalType.ROLE, 'admin', false, undefined, {
      expectEmpty: true,
    });
    expect(result).toBeTruthy();
    expect(result!.isActive).toBe(false);
  });

  it('toggleConfigActive with expectEmpty returns null on non-empty doc (isActive preserved)', async () => {
    await methods.upsertConfig(
      PrincipalType.ROLE,
      'admin',
      PrincipalModel.ROLE,
      { interface: { modelSelect: false } },
      10,
    );

    const result = await methods.toggleConfigActive(PrincipalType.ROLE, 'admin', false, undefined, {
      expectEmpty: true,
    });
    expect(result).toBeNull();

    const doc = await methods.findConfigByPrincipal(PrincipalType.ROLE, 'admin');
    expect(doc!.isActive).toBe(true);
  });

  it('upsertConfig with expectEmpty inserts when no doc exists', async () => {
    const result = await methods.upsertConfig(
      PrincipalType.ROLE,
      'admin',
      PrincipalModel.ROLE,
      {},
      10,
      undefined,
      { expectEmpty: true },
    );
    expect(result).toBeTruthy();
    expect(result!.principalId).toBe('admin');
  });

  it('upsertConfig with expectEmpty updates an empty existing doc', async () => {
    await methods.upsertConfig(PrincipalType.ROLE, 'admin', PrincipalModel.ROLE, {}, 5);

    const result = await methods.upsertConfig(
      PrincipalType.ROLE,
      'admin',
      PrincipalModel.ROLE,
      {},
      99,
      undefined,
      { expectEmpty: true },
    );
    expect(result).toBeTruthy();
    expect(result!.priority).toBe(99);
  });

  it('upsertConfig with preservePriority inserts with the requested priority', async () => {
    const result = await methods.upsertConfig(
      PrincipalType.ROLE,
      'admin',
      PrincipalModel.ROLE,
      {},
      10,
      undefined,
      { expectEmpty: true, preservePriority: true },
    );

    expect(result).toBeTruthy();
    expect(result!.priority).toBe(10);
  });

  it('upsertConfig with preservePriority keeps an empty existing doc priority', async () => {
    await methods.upsertConfig(PrincipalType.ROLE, 'admin', PrincipalModel.ROLE, {}, 5);

    const result = await methods.upsertConfig(
      PrincipalType.ROLE,
      'admin',
      PrincipalModel.ROLE,
      {},
      99,
      undefined,
      { expectEmpty: true, preservePriority: true },
    );

    expect(result).toBeTruthy();
    expect(result!.priority).toBe(5);
    expect(result!.configVersion).toBe(2);
  });

  it('upsertConfig with expectEmpty returns null when existing doc has non-empty overrides', async () => {
    await methods.upsertConfig(
      PrincipalType.ROLE,
      'admin',
      PrincipalModel.ROLE,
      { interface: { modelSelect: false } },
      10,
    );

    const result = await methods.upsertConfig(
      PrincipalType.ROLE,
      'admin',
      PrincipalModel.ROLE,
      {},
      99,
      undefined,
      { expectEmpty: true },
    );
    expect(result).toBeNull();

    const doc = await methods.findConfigByPrincipal(PrincipalType.ROLE, 'admin');
    expect(doc!.priority).toBe(10);
    expect(Object.keys(doc!.overrides ?? {}).length).toBeGreaterThan(0);
  });
});

describe('toggleConfigActiveTracked', () => {
  it('reports a change once and returns the persisted document', async () => {
    await methods.upsertConfig(PrincipalType.ROLE, 'admin', PrincipalModel.ROLE, {}, 10);

    const first = await methods.toggleConfigActiveTracked(PrincipalType.ROLE, 'admin', false);
    const second = await methods.toggleConfigActiveTracked(PrincipalType.ROLE, 'admin', false);
    const missing = await methods.toggleConfigActiveTracked(PrincipalType.ROLE, 'none', false);

    expect(first).toMatchObject({ changed: true, config: { isActive: false } });
    expect(second).toMatchObject({ changed: false, config: { isActive: false } });
    expect(missing).toBeNull();
  });
});

const raw = () => mongoose.connection.db!.collection('configs');

describe('role-addressed operations stay in one tenant partition', () => {
  const BASE = '__base__';
  const inTenantA = <T>(fn: () => Promise<T>): Promise<T> =>
    tenantStorage.run({ tenantId: 'tenant-a' }, fn);
  const revisionOf = (config: { _id: unknown; configVersion: number }) =>
    `${String(config._id)}:${config.configVersion}`;

  /** Inserts directly, so the document keeps exactly the `tenantId` form it is given. */
  async function seedBase(label: string, tenantId?: string | null): Promise<void> {
    await mongoose.connection.db!.collection('configs').insertOne({
      principalType: PrincipalType.ROLE,
      principalId: BASE,
      principalModel: PrincipalModel.ROLE,
      priority: 0,
      overrides: { registration: { allowedDomains: [label] } },
      tombstones: [],
      isActive: true,
      configVersion: 1,
      ...(tenantId !== undefined && { tenantId }),
    });
  }

  const stored = () =>
    mongoose.connection
      .db!.collection('configs')
      .find({}, { projection: { _id: 0, tenantId: 1, overrides: 1, isActive: 1, tombstones: 1 } })
      .sort({ tenantId: 1 })
      .toArray();

  afterEach(() => {
    delete process.env.TENANT_ISOLATION_STRICT;
    resetTenantStrictCache();
  });

  it("does not read a tenant's document as the deployment's", async () => {
    await seedBase('a-base', 'tenant-a');

    expect(await methods.findConfigByPrincipal(PrincipalType.ROLE, BASE)).toBeNull();
    expect(await methods.listAllConfigs()).toEqual([]);
  });

  it('reads the tenantless document outside a tenant and the tenant document inside it', async () => {
    await seedBase('a-base', 'tenant-a');
    await seedBase('deployment-base');

    const deployment = await methods.findConfigByPrincipal(PrincipalType.ROLE, BASE);
    const tenant = await inTenantA(() => methods.findConfigByPrincipal(PrincipalType.ROLE, BASE));

    expect(deployment?.overrides).toEqual({
      registration: { allowedDomains: ['deployment-base'] },
    });
    expect(tenant?.overrides).toEqual({ registration: { allowedDomains: ['a-base'] } });
    expect((await methods.listAllConfigs()).map((config) => config.tenantId)).toEqual([undefined]);
  });

  it("writes the deployment's own document instead of a tenant's", async () => {
    await seedBase('a-base', 'tenant-a');

    await methods.patchConfigFields(
      PrincipalType.ROLE,
      BASE,
      PrincipalModel.ROLE,
      { 'registration.socialLogins': ['google'] },
      0,
    );

    expect(await stored()).toEqual([
      expect.objectContaining({
        overrides: { registration: { socialLogins: ['google'] } },
      }),
      expect.objectContaining({
        tenantId: 'tenant-a',
        overrides: { registration: { allowedDomains: ['a-base'] } },
      }),
    ]);
    expect((await stored())[0]).not.toHaveProperty('tenantId');
  });

  it("writes a tenant's document inside the tenant, leaving the deployment's alone", async () => {
    await seedBase('deployment-base');

    await inTenantA(() =>
      methods.upsertConfig(
        PrincipalType.ROLE,
        BASE,
        PrincipalModel.ROLE,
        { registration: { allowedDomains: ['a-only'] } },
        0,
      ),
    );

    expect(await stored()).toEqual([
      expect.objectContaining({
        overrides: { registration: { allowedDomains: ['deployment-base'] } },
      }),
      expect.objectContaining({
        tenantId: 'tenant-a',
        overrides: { registration: { allowedDomains: ['a-only'] } },
      }),
    ]);
  });

  it("replaces, tombstones, unsets, toggles and deletes only the deployment's document", async () => {
    await seedBase('a-base', 'tenant-a');
    await seedBase('deployment-base', null);

    await methods.upsertConfig(
      PrincipalType.ROLE,
      BASE,
      PrincipalModel.ROLE,
      { registration: { allowedDomains: ['replaced'] }, interface: { customWelcome: 'hi' } },
      0,
    );
    await methods.tombstoneConfigField(
      PrincipalType.ROLE,
      BASE,
      PrincipalModel.ROLE,
      'interface.theme',
      0,
    );
    await methods.unsetConfigField(PrincipalType.ROLE, BASE, 'registration.allowedDomains');
    await methods.toggleConfigActive(PrincipalType.ROLE, BASE, false);
    await methods.toggleConfigActiveTracked(PrincipalType.ROLE, BASE, false);

    const [deployment, tenant] = await stored();
    expect(deployment).toEqual({
      tenantId: null,
      overrides: { interface: { customWelcome: 'hi' } },
      tombstones: ['interface.theme'],
      isActive: false,
    });
    expect(tenant).toEqual({
      tenantId: 'tenant-a',
      overrides: { registration: { allowedDomains: ['a-base'] } },
      tombstones: [],
      isActive: true,
    });

    const deleted = await methods.deleteConfig(PrincipalType.ROLE, BASE);
    expect(deleted?.overrides).toEqual({ interface: { customWelcome: 'hi' } });
    expect(deleted).not.toHaveProperty('tenantId');
    expect(await stored()).toEqual([expect.objectContaining({ tenantId: 'tenant-a' })]);
  });

  it("deletes nothing outside a tenant when only a tenant's document exists", async () => {
    await seedBase('a-base', 'tenant-a');

    expect(await methods.deleteConfig(PrincipalType.ROLE, BASE)).toBeNull();
    expect(await stored()).toEqual([expect.objectContaining({ tenantId: 'tenant-a' })]);
  });

  it("refuses a store write or delete pinned to a tenant document's revision outside the tenant", async () => {
    await seedBase('a-base', 'tenant-a');
    const tenantDocument = await raw().findOne({ tenantId: 'tenant-a' });
    const store = createConfigStore(mongoose);
    const principal = { principalType: PrincipalType.ROLE, principalId: BASE };
    const revision = revisionOf({ _id: tenantDocument!._id, configVersion: 1 });

    await expect(
      store.write(
        principal,
        {
          principalModel: PrincipalModel.ROLE,
          priority: 0,
          overrides: { registration: { allowedDomains: ['stale'] } },
          tombstones: [],
          isActive: true,
        },
        revision,
      ),
    ).rejects.toMatchObject({ code: 'CONFIG_VERSION_CONFLICT' });
    await expect(store.remove(principal, revision)).rejects.toMatchObject({
      code: 'CONFIG_VERSION_CONFLICT',
    });
    expect(await stored()).toEqual([
      {
        tenantId: 'tenant-a',
        overrides: { registration: { allowedDomains: ['a-base'] } },
        tombstones: [],
        isActive: true,
      },
    ]);
  });

  it('lists every tenant role document only when a listing asks for all tenants', async () => {
    await seedBase('a-base', 'tenant-a');
    await seedBase('deployment-base');
    const store = createConfigStore(mongoose);
    const tenants = (records: ConfigRecord[]) => records.map((record) => record.tenantId);

    expect(tenants(await store.list())).toEqual([undefined]);
    expect(tenants(await store.list({ acrossTenants: true })).sort()).toEqual([
      'tenant-a',
      undefined,
    ]);
    expect(tenants(await inTenantA(() => store.list({ acrossTenants: true })))).toEqual([
      'tenant-a',
    ]);
  });

  it("restores the deployment's document while a tenant's document exists", async () => {
    await seedBase('a-base', 'tenant-a');
    await seedBase('deployment-base');
    const deleted = await methods.deleteConfig(PrincipalType.ROLE, BASE);

    const restored = await methods.restoreConfig(deleted!);

    expect(restored).toBe(true);
    expect((await stored()).map((config) => config.overrides)).toEqual([
      { registration: { allowedDomains: ['deployment-base'] } },
      { registration: { allowedDomains: ['a-base'] } },
    ]);
  });

  it("applies revision-conditioned writes to the deployment's document, never a tenant's", async () => {
    await seedBase('a-base', 'tenant-a');
    const tenantDocument = await raw().findOne({ tenantId: 'tenant-a' });

    const created = await methods.patchConfigFields(
      PrincipalType.ROLE,
      BASE,
      PrincipalModel.ROLE,
      { 'interface.customWelcome': 'deployment' },
      0,
      undefined,
      { expectedRevision: 'absent' },
    );
    const tombstoned = await methods.tombstoneConfigField(
      PrincipalType.ROLE,
      BASE,
      PrincipalModel.ROLE,
      'interface.theme',
      0,
      undefined,
      { expectedRevision: revisionOf(created) },
    );
    const unset = await methods.unsetConfigField(
      PrincipalType.ROLE,
      BASE,
      'interface.theme',
      undefined,
      { expectedRevision: revisionOf(tombstoned) },
    );
    const stale = methods.upsertConfig(
      PrincipalType.ROLE,
      BASE,
      PrincipalModel.ROLE,
      { registration: { allowedDomains: ['stale'] } },
      0,
      undefined,
      { expectedRevision: revisionOf({ _id: tenantDocument!._id, configVersion: 1 }) },
    );

    expect([created, tombstoned, unset].map((config) => config?.configVersion)).toEqual([1, 2, 3]);
    await expect(stale).rejects.toMatchObject({ code: 'CONFIG_VERSION_CONFLICT' });
    const [deployment, tenant] = await stored();
    expect(deployment).toEqual({
      overrides: { interface: { customWelcome: 'deployment' } },
      tombstones: [],
      isActive: true,
    });
    expect(tenant).toEqual({
      tenantId: 'tenant-a',
      overrides: { registration: { allowedDomains: ['a-base'] } },
      tombstones: [],
      isActive: true,
    });
  });

  it('refuses an unscoped write in strict mode', async () => {
    process.env.TENANT_ISOLATION_STRICT = 'true';
    resetTenantStrictCache();

    await expect(
      methods.patchConfigFields(
        PrincipalType.ROLE,
        BASE,
        PrincipalModel.ROLE,
        { 'registration.socialLogins': ['google'] },
        0,
      ),
    ).rejects.toThrow('[TenantIsolation]');
  });
});

describe('group and user documents are addressed by id in any tenant', () => {
  const groupId = new Types.ObjectId().toString();
  const userId = new Types.ObjectId().toString();
  const inTenant = <T>(tenantId: string, fn: () => Promise<T>): Promise<T> =>
    tenantStorage.run({ tenantId }, fn);

  async function seed(
    principalType: PrincipalType,
    principalId: string,
    label: string,
    tenantId?: string,
  ): Promise<void> {
    await mongoose.connection.db!.collection('configs').insertOne({
      principalType,
      principalId,
      principalModel:
        principalType === PrincipalType.GROUP ? PrincipalModel.GROUP : PrincipalModel.USER,
      priority: 10,
      overrides: { registration: { allowedDomains: [label] } },
      tombstones: [],
      isActive: true,
      configVersion: 1,
      ...(tenantId !== undefined && { tenantId }),
    });
  }

  beforeEach(async () => {
    await seed(PrincipalType.GROUP, groupId, 'a-group', 'tenant-a');
    await seed(PrincipalType.USER, userId, 'a-user', 'tenant-a');
    await seed(PrincipalType.ROLE, '__base__', 'a-base', 'tenant-a');
  });

  afterEach(() => {
    delete process.env.TENANT_ISOLATION_STRICT;
    resetTenantStrictCache();
  });

  it("reads and lists a tenant's group and user documents outside a tenant", async () => {
    const group = await methods.findConfigByPrincipal(PrincipalType.GROUP, groupId);
    const user = await methods.findConfigByPrincipal(PrincipalType.USER, userId);

    expect(group?.tenantId).toBe('tenant-a');
    expect(user?.tenantId).toBe('tenant-a');
    expect((await methods.listAllConfigs()).map((config) => config.principalId).sort()).toEqual(
      [groupId, userId].sort(),
    );
  });

  it("updates and deletes a tenant's group document outside a tenant, as a group cascade does", async () => {
    await methods.patchConfigFields(
      PrincipalType.GROUP,
      groupId,
      PrincipalModel.GROUP,
      { 'registration.socialLogins': ['google'] },
      10,
    );
    const deleted = await methods.deleteConfig(PrincipalType.GROUP, groupId);

    expect(deleted?.tenantId).toBe('tenant-a');
    expect(deleted?.overrides).toEqual({
      registration: { allowedDomains: ['a-group'], socialLogins: ['google'] },
    });
    expect(await methods.deleteConfig(PrincipalType.USER, userId)).toEqual(
      expect.objectContaining({ tenantId: 'tenant-a' }),
    );
    expect(await raw().countDocuments()).toBe(1);
  });

  it("does not reach another tenant's group or user document inside a tenant", async () => {
    expect(
      await inTenant('tenant-b', () => methods.findConfigByPrincipal(PrincipalType.GROUP, groupId)),
    ).toBeNull();
    expect(
      await inTenant('tenant-b', () => methods.deleteConfig(PrincipalType.USER, userId)),
    ).toBeNull();
    expect(await inTenant('tenant-b', () => methods.listAllConfigs())).toEqual([]);
    expect(await inTenant('tenant-a', () => methods.listAllConfigs())).toHaveLength(3);
  });

  it('keeps resolution in one partition for group and user principals', async () => {
    const principals = [
      { principalType: PrincipalType.GROUP, principalId: groupId },
      { principalType: PrincipalType.USER, principalId: userId },
    ];

    expect(await methods.getApplicableConfigs(principals)).toEqual([]);
    expect(await inTenant('tenant-a', () => methods.getApplicableConfigs(principals))).toHaveLength(
      3,
    );
  });

  it('refuses an unscoped group read in strict mode', async () => {
    process.env.TENANT_ISOLATION_STRICT = 'true';
    resetTenantStrictCache();

    await expect(methods.findConfigByPrincipal(PrincipalType.GROUP, groupId)).rejects.toThrow(
      '[TenantIsolation]',
    );
  });
});

function collectKeys(value: unknown, keys: string[] = []): string[] {
  if (Array.isArray(value)) {
    value.forEach((item) => collectKeys(item, keys));
  } else if (value != null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      keys.push(key);
      collectKeys(child, keys);
    }
  }
  return keys;
}

describe('key encoding at rest', () => {
  const dotted = {
    endpoints: {
      bedrock: { inferenceProfiles: { 'us.anthropic.claude-sonnet-4-5': 'arn:aws:x' } },
      azureOpenAI: { groups: [{ group: 'g', models: { 'gpt-4.1': { deploymentName: 'd' } } }] },
    },
    fileConfig: { endpoints: { custom: { supportedMimeTypes: ['image/.*'] } } },
    $top: { 'a.b': '$value.stays' },
  };

  /** Makes the engine refuse a dotted or `$` field name anywhere in a stored value, as DocumentDB, Cosmos or MongoDB 4.4 may. */
  function refuseRawKeyNames() {
    const collection = mongoose.models.Config.collection;
    const findOneAndUpdate = collection.findOneAndUpdate.bind(collection);
    const hasRawName = (value: unknown) =>
      collectKeys(value).some((key) => key.includes('.') || key.startsWith('$'));
    return jest.spyOn(collection, 'findOneAndUpdate').mockImplementation((async (
      filter: Record<string, unknown>,
      update: { $set?: Record<string, unknown>; $setOnInsert?: Record<string, unknown> },
      options: Record<string, unknown>,
    ) => {
      if (hasRawName(update.$set?.overrides) || hasRawName(update.$setOnInsert?.overrides)) {
        throw new mongoose.mongo.MongoServerError({
          ok: 0,
          code: 57,
          errmsg: "The dotted field 'us.a.b' in 'overrides' is not valid for storage.",
        });
      }
      return findOneAndUpdate(filter, update as never, options);
    }) as unknown as typeof collection.findOneAndUpdate);
  }

  it('stores record keys raw where the engine accepts them, as servers before the encoding read them', async () => {
    await methods.upsertConfig(PrincipalType.ROLE, 'enc', PrincipalModel.ROLE, dotted as never, 10);

    const stored = await raw().findOne({ principalId: 'enc' });
    expect(stored!.overrides).toEqual(dotted);
    expect(stored!.keyEncoding).toBeUndefined();

    const read = await methods.findConfigByPrincipal(PrincipalType.ROLE, 'enc');
    expect(read!.overrides).toEqual(dotted);
    expect(
      (await methods.getApplicableConfigs([{ principalType: 'role', principalId: 'enc' }]))[0]
        .overrides,
    ).toEqual(dotted);
  });

  it('encodes keys once the engine refuses a raw key name, and reads them back decoded', async () => {
    const refusing = createConfigMethods(mongoose);
    const findOneAndUpdate = refuseRawKeyNames();

    await refusing.upsertConfig(
      PrincipalType.ROLE,
      'enc',
      PrincipalModel.ROLE,
      dotted as never,
      10,
    );

    const stored = await raw().findOne({ principalId: 'enc' });
    expect(
      collectKeys(stored!.overrides).filter((key) => key.includes('.') || key.startsWith('$')),
    ).toEqual([]);
    expect(stored!.keyEncoding).toBe(1);
    expect(stored!.overrides['%24top']).toEqual({ 'a%2Eb': '$value.stays' });
    expect((await refusing.findConfigByPrincipal(PrincipalType.ROLE, 'enc'))!.overrides).toEqual(
      dotted,
    );

    findOneAndUpdate.mockClear();
    const patched = await refusing.patchConfigFields(
      PrincipalType.ROLE,
      'enc',
      PrincipalModel.ROLE,
      {
        'endpoints.bedrock.inferenceProfiles': { 'eu.meta.llama': 'arn:eu' },
      },
    );
    expect(findOneAndUpdate).toHaveBeenCalledTimes(1);
    expect(patched.overrides.endpoints).toMatchObject({
      bedrock: { inferenceProfiles: { 'eu.meta.llama': 'arn:eu' } },
    });
  });

  it('moves a profile on an engine that refuses raw key names, keeping its keys encoded', async () => {
    const refusing = createConfigMethods(mongoose);
    const findOneAndUpdate = refuseRawKeyNames();
    await refusing.upsertConfig(PrincipalType.ROLE, 'from', PrincipalModel.ROLE, dotted as never);

    const moved = await refusing.renameConfigPrincipal(PrincipalType.ROLE, 'from', 'to');

    expect(moved!.overrides).toEqual(dotted);
    expect(await raw().findOne({ principalId: 'from' })).toBeNull();
    const stored = await raw().findOne({ principalId: 'to' });
    expect(stored!.keyEncoding).toBe(1);
    expect(stored!.overrides['%24top']).toEqual({ 'a%2Eb': '$value.stays' });
    expect(findOneAndUpdate).toHaveBeenCalled();
  });

  it('restores a deleted document with dotted keys in the form the engine accepts', async () => {
    await methods.upsertConfig(
      PrincipalType.ROLE,
      'snap',
      PrincipalModel.ROLE,
      dotted as never,
      10,
    );
    const deleted = await methods.deleteConfig(PrincipalType.ROLE, 'snap');

    expect(await methods.restoreConfig(deleted!)).toBe(true);
    expect((await raw().findOne({ principalId: 'snap' }))!.overrides).toEqual(dotted);

    const refusing = createConfigMethods(mongoose);
    const updateOne = jest
      .spyOn(mongoose.models.Config.collection, 'updateOne')
      .mockRejectedValueOnce(
        new mongoose.mongo.MongoServerError({
          ok: 0,
          code: 57,
          errmsg: "The dotted field 'us.a.b' in 'overrides' is not valid for storage.",
        }),
      );
    const again = await refusing.deleteConfig(PrincipalType.ROLE, 'snap');

    expect(await refusing.restoreConfig(again!)).toBe(true);
    expect(updateOne).toHaveBeenCalledTimes(2);
    const stored = await raw().findOne({ principalId: 'snap' });
    expect(stored!.keyEncoding).toBe(1);
    expect(stored!.overrides['%24top']).toEqual({ 'a%2Eb': '$value.stays' });
    expect((await refusing.findConfigByPrincipal(PrincipalType.ROLE, 'snap'))!.overrides).toEqual(
      dotted,
    );
  });

  it('keeps a field under a dotted record key raw when it is patched by segments of its parent', async () => {
    await methods.upsertConfig(
      PrincipalType.ROLE,
      'enc2',
      PrincipalModel.ROLE,
      dotted as never,
      10,
    );

    const patched = await methods.patchConfigFields(
      PrincipalType.ROLE,
      'enc2',
      PrincipalModel.ROLE,
      { 'endpoints.bedrock.inferenceProfiles': { 'eu.meta.llama': 'arn:eu' } },
      10,
    );

    expect(patched.overrides).toEqual({
      ...dotted,
      endpoints: {
        ...dotted.endpoints,
        bedrock: { inferenceProfiles: { 'eu.meta.llama': 'arn:eu' } },
      },
    });
    const stored = await raw().findOne({ principalId: 'enc2' });
    expect(stored!.overrides.endpoints.bedrock.inferenceProfiles).toEqual({
      'eu.meta.llama': 'arn:eu',
    });
  });

  it('removes dotted record keys by their segments, pruning what they empty, in one write', async () => {
    await methods.upsertConfig(
      PrincipalType.ROLE,
      'enc3',
      PrincipalModel.ROLE,
      dotted as never,
      10,
    );
    const profile = ['endpoints', 'bedrock', 'inferenceProfiles', 'us.anthropic.claude-sonnet-4-5'];

    const removed = await methods.unsetConfigField(PrincipalType.ROLE, 'enc3', [
      { segments: profile },
      { segments: ['endpoints', 'azureOpenAI', 'groups', '0', 'models', 'gpt-4.1'] },
    ]);

    expect(removed!.overrides).toEqual({
      endpoints: { azureOpenAI: { groups: [{ group: 'g' }] } },
      fileConfig: dotted.fileConfig,
      $top: dotted.$top,
    });
    expect(removed!.configVersion).toBe(2);
    const stored = await raw().findOne({ principalId: 'enc3' });
    expect(stored!.overrides.endpoints).toEqual({ azureOpenAI: { groups: [{ group: 'g' }] } });
  });

  it('reads a legacy document without the marker verbatim, even keys that look encoded', async () => {
    await raw().insertOne({
      principalType: 'role',
      principalId: 'legacy',
      principalModel: 'Role',
      priority: 10,
      isActive: true,
      configVersion: 3,
      tombstones: [],
      overrides: { endpoints: { azureOpenAI: { 'gpt-4.1': true, 'literal%2Ekey': 1 } } },
    });

    const read = await methods.findConfigByPrincipal(PrincipalType.ROLE, 'legacy');

    expect(read!.overrides).toEqual({
      endpoints: { azureOpenAI: { 'gpt-4.1': true, 'literal%2Ekey': 1 } },
    });
  });

  it('keeps a legacy document raw on its next write without changing its keys', async () => {
    const legacyOverrides = {
      endpoints: { azureOpenAI: { 'gpt-4.1': true, 'literal%2Ekey': 1 } },
      interface: { customWelcome: 'hi' },
    };
    await raw().insertOne({
      principalType: 'role',
      principalId: 'lazy',
      principalModel: 'Role',
      priority: 10,
      isActive: true,
      tombstones: [],
      overrides: legacyOverrides,
    });

    const written = await methods.patchConfigFields(
      PrincipalType.ROLE,
      'lazy',
      PrincipalModel.ROLE,
      { 'interface.customWelcome': 'hello' },
    );

    const expected = { ...legacyOverrides, interface: { customWelcome: 'hello' } };
    expect(written.overrides).toEqual(expected);
    expect(written.configVersion).toBe(1);
    const stored = await raw().findOne({ principalId: 'lazy' });
    expect(stored!.keyEncoding).toBeUndefined();
    expect(stored!.overrides).toEqual(expected);
    expect((await methods.findConfigByPrincipal(PrincipalType.ROLE, 'lazy'))!.overrides).toEqual(
      expected,
    );
  });

  it('encodes a document whose raw keys a read would take for escape sequences', async () => {
    const overrides = { endpoints: { custom: [{ name: 'gw', headers: { 'X-Ratio%25': 'a' } }] } };

    await methods.upsertConfig(
      PrincipalType.ROLE,
      'pct',
      PrincipalModel.ROLE,
      overrides as never,
      10,
    );

    const stored = await raw().findOne({ principalId: 'pct' });
    expect(stored!.keyEncoding).toBe(1);
    expect(stored!.overrides.endpoints.custom[0].headers).toEqual({ 'X-Ratio%2525': 'a' });
    expect((await methods.findConfigByPrincipal(PrincipalType.ROLE, 'pct'))!.overrides).toEqual(
      overrides,
    );
  });

  describe('documents an older server wrote over', () => {
    const encoded = {
      endpoints: { bedrock: { inferenceProfiles: { 'us%2Eanthropic%2Eclaude': 'arn:aws:x' } } },
      '%24top': { 'a%2Eb': 1 },
    };
    const decoded = {
      endpoints: { bedrock: { inferenceProfiles: { 'us.anthropic.claude': 'arn:aws:x' } } },
      $top: { 'a.b': 1 },
    };

    async function insert(principalId: string, document: Record<string, unknown>) {
      await raw().insertOne({
        principalType: 'role',
        principalId,
        principalModel: 'Role',
        priority: 10,
        isActive: true,
        configVersion: 2,
        tombstones: [],
        ...document,
      });
    }

    it('decodes an encoded document whose marker an older server dropped', async () => {
      /** A pre-encoding schema has no `keyEncoding`, so its restore re-inserts the keys without it. */
      await insert('dropped', { overrides: encoded });

      const read = await methods.findConfigByPrincipal(PrincipalType.ROLE, 'dropped');

      expect(read!.overrides).toEqual(decoded);
    });

    it('reads raw keys an older server wrote under a marker it left in place', async () => {
      await insert('stale', {
        keyEncoding: 1,
        overrides: { endpoints: { azureOpenAI: { 'gpt-4.1': true } }, interface: { a: 1 } },
      });

      const read = await methods.findConfigByPrincipal(PrincipalType.ROLE, 'stale');

      expect(read!.overrides).toEqual({
        endpoints: { azureOpenAI: { 'gpt-4.1': true } },
        interface: { a: 1 },
      });
    });

    it('reads raw keys an older server added beside encoded ones', async () => {
      await insert('mixed', { keyEncoding: 1, overrides: encoded });
      await raw().updateOne(
        { principalId: 'mixed' },
        {
          $set: {
            'overrides.interface.contextCost': true,
            'overrides.endpoints.azureOpenAI': { models: { 'gpt-4.1': true } },
          },
        },
      );

      const read = await methods.findConfigByPrincipal(PrincipalType.ROLE, 'mixed');

      expect(read!.overrides).toEqual({
        ...decoded,
        endpoints: { ...decoded.endpoints, azureOpenAI: { models: { 'gpt-4.1': true } } },
        interface: { contextCost: true },
      });
    });

    it('rewrites an encoded document raw on its next write and clears the marker', async () => {
      await insert('rewrite', { keyEncoding: 1, overrides: encoded });

      await methods.patchConfigFields(PrincipalType.ROLE, 'rewrite', PrincipalModel.ROLE, {
        'interface.customWelcome': 'hi',
      });

      const stored = await raw().findOne({ principalId: 'rewrite' });
      expect(stored!.keyEncoding).toBeUndefined();
      expect(stored!.overrides).toEqual({ ...decoded, interface: { customWelcome: 'hi' } });
    });
  });
});

describe('revision preconditions', () => {
  const revisionOf = (config: { _id: string; configVersion: number }) =>
    `${config._id}:${config.configVersion}`;

  async function seed(principalId: string) {
    return methods.patchConfigFields(PrincipalType.ROLE, principalId, PrincipalModel.ROLE, {
      'interface.customWelcome': 'v1',
    });
  }

  it('writes at the matching revision and bumps the version by one', async () => {
    const first = await seed('rev');

    const next = await methods.patchConfigFields(
      PrincipalType.ROLE,
      'rev',
      PrincipalModel.ROLE,
      { 'interface.customWelcome': 'v2' },
      undefined,
      undefined,
      { expectedRevision: revisionOf(first) },
    );

    expect(next.configVersion).toBe(first.configVersion + 1);
    expect(next._id).toBe(first._id);
  });

  it('refuses a stale revision with a typed conflict and changes nothing', async () => {
    const first = await seed('stale');
    const second = await methods.patchConfigFields(
      PrincipalType.ROLE,
      'stale',
      PrincipalModel.ROLE,
      {
        'interface.customWelcome': 'v2',
      },
    );

    await expect(
      methods.unsetConfigField(PrincipalType.ROLE, 'stale', 'interface.customWelcome', undefined, {
        expectedRevision: revisionOf(first),
      }),
    ).rejects.toMatchObject({
      code: 'CONFIG_VERSION_CONFLICT',
      currentRevision: revisionOf(second),
    });
    expect((await methods.findConfigByPrincipal(PrincipalType.ROLE, 'stale'))!.configVersion).toBe(
      2,
    );
  });

  it('never creates a document for a revision of one that does not exist', async () => {
    await expect(
      methods.tombstoneConfigField(
        PrincipalType.ROLE,
        'ghost',
        PrincipalModel.ROLE,
        'memory',
        10,
        undefined,
        {
          expectedRevision: `${new Types.ObjectId().toString()}:4`,
        },
      ),
    ).rejects.toMatchObject({ code: 'CONFIG_VERSION_CONFLICT', currentRevision: null });
    expect(await raw().countDocuments({ principalId: 'ghost' })).toBe(0);
  });

  it("creates with 'absent' and then conflicts on a second create", async () => {
    const created = await methods.upsertConfig(
      PrincipalType.ROLE,
      'once',
      PrincipalModel.ROLE,
      {},
      10,
      undefined,
      {
        expectedRevision: 'absent',
      },
    );
    expect(created!.configVersion).toBe(1);

    await expect(
      methods.upsertConfig(
        PrincipalType.ROLE,
        'once',
        PrincipalModel.ROLE,
        { a: 1 } as never,
        10,
        undefined,
        {
          expectedRevision: 'absent',
        },
      ),
    ).rejects.toMatchObject({
      code: 'CONFIG_VERSION_CONFLICT',
      currentRevision: revisionOf(created!),
    });
  });

  it('matches a legacy document without configVersion at version 0', async () => {
    const { insertedId } = await raw().insertOne({
      principalType: 'role',
      principalId: 'old',
      principalModel: 'Role',
      priority: 10,
      isActive: true,
      overrides: { a: { b: 1 } },
    });
    const read = await methods.findConfigByPrincipal(PrincipalType.ROLE, 'old');
    expect(revisionOf(read!)).toBe(`${insertedId.toString()}:0`);

    const written = await methods.unsetConfigField(PrincipalType.ROLE, 'old', 'a.b', undefined, {
      expectedRevision: `${insertedId.toString()}:0`,
    });

    expect(written!.configVersion).toBe(1);
    expect(written!.overrides).toEqual({});
  });

  it('lets exactly one of two concurrent conditioned patches win', async () => {
    const first = await seed('race');

    const results = await Promise.allSettled(
      ['a', 'b'].map((value) =>
        methods.patchConfigFields(
          PrincipalType.ROLE,
          'race',
          PrincipalModel.ROLE,
          { 'interface.customWelcome': value },
          undefined,
          undefined,
          { expectedRevision: revisionOf(first) },
        ),
      ),
    );

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect((await methods.findConfigByPrincipal(PrincipalType.ROLE, 'race'))!.configVersion).toBe(
      2,
    );
  });

  it('keeps every concurrent unconditioned patch by re-reading on conflict', async () => {
    await seed('merge');

    await Promise.all(
      ['a', 'b', 'c'].map((key) =>
        methods.patchConfigFields(PrincipalType.ROLE, 'merge', PrincipalModel.ROLE, {
          [`speech.${key}`]: key,
        }),
      ),
    );

    const stored = await methods.findConfigByPrincipal(PrincipalType.ROLE, 'merge');
    expect((stored!.overrides as Record<string, unknown>).speech).toEqual({
      a: 'a',
      b: 'b',
      c: 'c',
    });
    expect(stored!.configVersion).toBe(4);
  });

  it('refuses a revision of a deleted and recreated document (ABA)', async () => {
    const original = await seed('aba');
    await methods.deleteConfig(PrincipalType.ROLE, 'aba');
    await seed('aba');

    await expect(
      methods.patchConfigFields(
        PrincipalType.ROLE,
        'aba',
        PrincipalModel.ROLE,
        { 'a.b': 1 },
        10,
        undefined,
        {
          expectedRevision: revisionOf(original),
        },
      ),
    ).rejects.toMatchObject({ code: 'CONFIG_VERSION_CONFLICT' });
  });

  it('deletes and toggles only at the expected revision; toggling bumps the version', async () => {
    const first = await seed('life');

    const toggled = await methods.toggleConfigActiveTracked(PrincipalType.ROLE, 'life', false, {
      expectedRevision: revisionOf(first),
    });
    expect(toggled).toMatchObject({ changed: true, config: { isActive: false, configVersion: 2 } });

    await expect(
      methods.deleteConfig(PrincipalType.ROLE, 'life', undefined, {
        expectedRevision: revisionOf(first),
      }),
    ).rejects.toMatchObject({ code: 'CONFIG_VERSION_CONFLICT' });
    const deleted = await methods.deleteConfig(PrincipalType.ROLE, 'life', undefined, {
      expectedRevision: revisionOf(toggled!.config),
    });
    expect(deleted!._id).toBe(first._id);
  });
});

describe('pruning emptied parents', () => {
  const read = (principalId: string) =>
    methods.findConfigByPrincipal(PrincipalType.ROLE, principalId, { includeInactive: true });

  it('removes the parents a field reset leaves empty, keeping siblings', async () => {
    await methods.upsertConfig(
      PrincipalType.ROLE,
      'prune',
      PrincipalModel.ROLE,
      { balance: { startBalance: 5 }, interface: { a: 1, b: 2 } } as never,
      10,
    );

    await methods.unsetConfigField(PrincipalType.ROLE, 'prune', 'balance.startBalance');
    await methods.unsetConfigField(PrincipalType.ROLE, 'prune', 'interface.a');

    expect((await read('prune'))!.overrides).toEqual({ interface: { b: 2 } });
  });

  it('prunes inside an array element without nulling it', async () => {
    await methods.upsertConfig(
      PrincipalType.ROLE,
      'arr',
      PrincipalModel.ROLE,
      { endpoints: { custom: [{ name: 'a', headers: { A: '1' } }] } } as never,
      10,
    );

    await methods.unsetConfigField(PrincipalType.ROLE, 'arr', 'endpoints.custom.0.headers.A');

    expect((await read('arr'))!.overrides).toEqual({ endpoints: { custom: [{ name: 'a' }] } });
    await expect(
      methods.unsetConfigField(PrincipalType.ROLE, 'arr', 'endpoints.custom.0'),
    ).rejects.toMatchObject({ code: 'CONFIG_PATH_INVALID', reason: 'array_element' });
    expect((await read('arr'))!.overrides).toEqual({ endpoints: { custom: [{ name: 'a' }] } });
  });

  it('keeps a sibling tombstone when its parent is pruned', async () => {
    await methods.patchConfigFields(PrincipalType.ROLE, 'tomb', PrincipalModel.ROLE, {
      'mcpServers.foo.title': 'Foo',
    });
    await methods.tombstoneConfigField(
      PrincipalType.ROLE,
      'tomb',
      PrincipalModel.ROLE,
      'mcpServers.github',
      10,
    );

    const result = await methods.unsetConfigField(PrincipalType.ROLE, 'tomb', 'mcpServers.foo');

    expect(result!.overrides).toEqual({});
    expect(result!.tombstones).toEqual(['mcpServers.github']);
  });

  it('prunes on tombstone and removes a secret with its preview in one write', async () => {
    const seeded = await methods.patchConfigFields(
      PrincipalType.ROLE,
      'secret',
      PrincipalModel.ROLE,
      {
        'ocr.apiKey': 'v3:cipher',
        'ocr.apiKeyPreview': '...abcd',
      },
    );

    const result = await methods.tombstoneConfigField(
      PrincipalType.ROLE,
      'secret',
      PrincipalModel.ROLE,
      ['ocr.apiKey', 'ocr.apiKeyPreview'],
    );

    expect(result.overrides).toEqual({});
    expect(result.tombstones).toEqual(['ocr.apiKey', 'ocr.apiKeyPreview']);
    expect(result.configVersion).toBe(seeded.configVersion + 1);
    expect(result.priority).toBe(seeded.priority);
  });

  it('treats a document holding only shells as empty for assign-only lifecycle calls', async () => {
    await raw().insertOne({
      principalType: 'role',
      principalId: 'shells',
      principalModel: 'Role',
      priority: 10,
      isActive: true,
      configVersion: 2,
      tombstones: [],
      overrides: { balance: {}, interface: { theme: {} } },
    });

    expect(
      await methods.toggleConfigActive(PrincipalType.ROLE, 'shells', false, undefined, {
        expectEmpty: true,
      }),
    ).toMatchObject({ isActive: false });
    expect(
      await methods.upsertConfig(
        PrincipalType.ROLE,
        'shells',
        PrincipalModel.ROLE,
        {},
        10,
        undefined,
        {
          expectEmpty: true,
          preservePriority: true,
        },
      ),
    ).toMatchObject({ isActive: true, overrides: {} });
    expect(
      await methods.deleteConfig(PrincipalType.ROLE, 'shells', undefined, { expectEmpty: true }),
    ).not.toBeNull();
  });
});

/** The write preconditions web search binding writes rely on, carried by store revisions. */
describe('web search write preconditions', () => {
  const ROLE = 'precondition-role';
  const revisionOf = (config: { _id: string; configVersion: number }) =>
    `${config._id}:${config.configVersion}`;

  function seed(): Promise<ConfigRecord> {
    return methods.patchConfigFields(PrincipalType.ROLE, ROLE, PrincipalModel.ROLE, {
      'webSearch.searxngInstanceUrl': 'https://searx.example.com',
    });
  }

  function readStored() {
    return raw().findOne({ principalId: ROLE });
  }

  type Write = (expectedRevision: string) => Promise<ConfigRecord | null>;
  const writes: Array<{ name: string; write: Write }> = [
    {
      name: 'patchConfigFields',
      write: (expectedRevision) =>
        methods.patchConfigFields(
          PrincipalType.ROLE,
          ROLE,
          PrincipalModel.ROLE,
          { 'webSearch.searxngInstanceUrl': 'https://attacker.example.com' },
          10,
          undefined,
          { expectedRevision },
        ),
    },
    {
      name: 'upsertConfig',
      write: (expectedRevision) =>
        methods.upsertConfig(
          PrincipalType.ROLE,
          ROLE,
          PrincipalModel.ROLE,
          { webSearch: { searxngInstanceUrl: 'https://attacker.example.com' } },
          10,
          undefined,
          { expectedRevision },
        ),
    },
    {
      name: 'tombstoneConfigField',
      write: (expectedRevision) =>
        methods.tombstoneConfigField(
          PrincipalType.ROLE,
          ROLE,
          PrincipalModel.ROLE,
          'webSearch.searxngInstanceUrl',
          10,
          undefined,
          { expectedRevision },
        ),
    },
  ];

  /** Makes the database refuse every write, after `beforeRefusal` runs. */
  function refuseWrites(beforeRefusal: () => Promise<void> = async () => undefined) {
    const collection = mongoose.models.Config.collection;
    jest.spyOn(collection, 'findOneAndUpdate').mockImplementation((async () => {
      await beforeRefusal();
      throw new mongoose.mongo.MongoServerError({
        ok: 0,
        code: 57,
        errmsg: "The dotted field 'us.a.b' in 'overrides' is not valid for storage.",
      });
    }) as unknown as typeof collection.findOneAndUpdate);
  }

  it.each(writes)('$name applies at the revision the caller read', async ({ write }) => {
    const seeded = await seed();

    const result = await write(revisionOf(seeded));

    expect(result!.configVersion).toBe(seeded.configVersion + 1);
    expect(result!._id).toBe(seeded._id);
  });

  it.each(writes)(
    '$name changes nothing once another write moved the revision',
    async ({ write }) => {
      const seeded = await seed();
      const moved = await methods.patchConfigFields(
        PrincipalType.ROLE,
        ROLE,
        PrincipalModel.ROLE,
        { 'webSearch.searxngApiKey': 'v3:concurrent' },
        10,
      );
      const before = await readStored();

      await expect(write(revisionOf(seeded))).rejects.toMatchObject({
        code: 'CONFIG_VERSION_CONFLICT',
        currentRevision: revisionOf(moved),
      });
      expect(await readStored()).toEqual(before);
    },
  );

  it.each(writes)('$name creates the document the caller saw absent', async ({ write }) => {
    const result = await write('absent');

    expect(result!.configVersion).toBe(1);
    expect(result!.createdAt).toBeInstanceOf(Date);
    expect(await raw().countDocuments({ principalId: ROLE })).toBe(1);
  });

  it.each(writes)(
    '$name changes nothing when a document appeared after the caller saw none',
    async ({ write }) => {
      await seed();
      const before = await readStored();

      await expect(write('absent')).rejects.toMatchObject({ code: 'CONFIG_VERSION_CONFLICT' });
      expect(await readStored()).toEqual(before);
    },
  );

  it.each(writes)(
    '$name does not recreate a document deleted since the read',
    async ({ write }) => {
      const seeded = await seed();
      await methods.deleteConfig(PrincipalType.ROLE, ROLE);

      await expect(write(revisionOf(seeded))).rejects.toMatchObject({
        code: 'CONFIG_VERSION_CONFLICT',
        currentRevision: null,
      });
      expect(await raw().countDocuments({ principalId: ROLE })).toBe(0);
    },
  );

  it('detects a document that appeared without relying on the unique index', async () => {
    const seeded = await seed();
    const before = await readStored();
    const Config = mongoose.models.Config;
    await Config.collection.dropIndexes();
    try {
      await expect(
        methods.writeConfigDocument(
          PrincipalType.ROLE,
          ROLE,
          {
            principalModel: PrincipalModel.ROLE,
            priority: 10,
            overrides: { webSearch: { searxngInstanceUrl: 'https://attacker.example.com' } },
            tombstones: [],
            isActive: true,
          },
          'absent',
        ),
      ).rejects.toMatchObject({
        code: 'CONFIG_VERSION_CONFLICT',
        currentRevision: revisionOf(seeded),
      });
      expect(await raw().countDocuments({ principalId: ROLE })).toBe(1);
      expect(await readStored()).toEqual(before);
    } finally {
      await Config.syncIndexes();
    }
  });

  it.each(writes)(
    '$name leaves no document when the database refuses a write the caller saw absent',
    async ({ write }) => {
      refuseWrites();

      await expect(write('absent')).rejects.toMatchObject({ code: 57 });
      expect(await raw().countDocuments({ principalId: ROLE })).toBe(0);
    },
  );

  it('keeps a document another write created before the database refused this one', async () => {
    refuseWrites(async () => {
      await raw().insertOne({
        principalType: PrincipalType.ROLE,
        principalId: ROLE,
        principalModel: PrincipalModel.ROLE,
        priority: 10,
        isActive: true,
        configVersion: 1,
        overrides: { webSearch: { safeSearch: 2 } },
      });
    });

    await expect(writes[0].write('absent')).rejects.toMatchObject({ code: 57 });
    expect(await readStored()).toMatchObject({
      configVersion: 1,
      overrides: { webSearch: { safeSearch: 2 } },
    });
  });

  it.each(writes)(
    '$name leaves the stored document as it was when the database refuses the write',
    async ({ write }) => {
      const seeded = await seed();
      const before = await readStored();
      refuseWrites();

      await expect(write(revisionOf(seeded))).rejects.toMatchObject({ code: 57 });
      expect(await readStored()).toEqual(before);
    },
  );

  it('unsetConfigField removes a field only at the revision the caller read', async () => {
    const seeded = await seed();
    const unset = (expectedRevision: string) =>
      methods.unsetConfigField(
        PrincipalType.ROLE,
        ROLE,
        'webSearch.searxngInstanceUrl',
        undefined,
        { expectedRevision },
      );

    await expect(unset(`${seeded._id}:${seeded.configVersion + 1}`)).rejects.toMatchObject({
      code: 'CONFIG_VERSION_CONFLICT',
    });
    expect(await readStored()).toMatchObject({
      overrides: { webSearch: { searxngInstanceUrl: 'https://searx.example.com' } },
    });

    const result = await unset(revisionOf(seeded));
    expect(result!.configVersion).toBe(seeded.configVersion + 1);
    expect(result!.overrides).toEqual({});
  });

  it('keeps unconditioned upsertConfig calls that race to create the document', async () => {
    const results = await Promise.all(
      [1, 2].map((safeSearch) =>
        methods.upsertConfig(
          PrincipalType.ROLE,
          ROLE,
          PrincipalModel.ROLE,
          { webSearch: { safeSearch } },
          10,
        ),
      ),
    );

    expect(results.map((result) => result!.configVersion).sort()).toEqual([1, 2]);
    expect(await raw().countDocuments({ principalId: ROLE })).toBe(1);
    const stored = await methods.findConfigByPrincipal(PrincipalType.ROLE, ROLE);
    expect(stored!.configVersion).toBe(2);
  });
});
