import mongoose, { Types } from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { PrincipalType, PrincipalModel } from 'librechat-data-provider';
import type { IConfig } from '~/types';
import { createConfigMethods } from './config';
import configSchema from '~/schema/config';

let mongoServer: MongoMemoryServer;
let methods: ReturnType<typeof createConfigMethods>;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  if (!mongoose.models.Config) {
    mongoose.model<IConfig>('Config', configSchema);
  }
  await mongoose.models.Config.init();
  methods = createConfigMethods(mongoose);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

beforeEach(async () => {
  await mongoose.models.Config.deleteMany({});
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

  it('skips principals with undefined principalId', async () => {
    await methods.upsertConfig(PrincipalType.ROLE, '__base__', PrincipalModel.ROLE, {}, 0);

    const configs = await methods.getApplicableConfigs([
      { principalType: PrincipalType.GROUP, principalId: undefined },
    ]);

    expect(configs).toHaveLength(1);
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
