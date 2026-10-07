import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { PrincipalModel, PrincipalType } from 'librechat-data-provider';
import { createModels, runAsSystem, tenantStorage } from '@librechat/data-schemas';
import type { IConfig, IRole } from '@librechat/data-schemas';
import { createBaseRoleAdminService } from './base';

let mongoServer: MongoMemoryServer;
const invalidateRoleCache = jest.fn(async () => undefined);
const invalidateConfigCaches = jest.fn(async () => undefined);

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  mongoose.set('autoIndex', false);
  await mongoose.connect(mongoServer.getUri());
  createModels(mongoose);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

beforeEach(async () => {
  await runAsSystem(async () => {
    await mongoose.models.Role.deleteMany({});
    await mongoose.models.Config.deleteMany({});
  });
  invalidateRoleCache.mockClear();
  invalidateConfigCaches.mockClear();
});

function createService() {
  return createBaseRoleAdminService(mongoose, {
    invalidateRoleCache,
    invalidateConfigCaches,
  });
}

describe('base role admin service', () => {
  it('updates only the base role when a tenant has a role with the same name', async () => {
    await runAsSystem(async () => {
      await mongoose.models.Role.create({
        name: 'BETA',
        description: 'base',
        permissions: {},
      });
    });
    await tenantStorage.run({ tenantId: 'tenant-a' }, async () => {
      await mongoose.models.Role.create({
        name: 'BETA',
        description: 'tenant',
        permissions: {},
      });
    });

    await runAsSystem(() => createService().updateRole('BETA', { description: 'updated' }));

    const [base, tenant] = await runAsSystem(async () =>
      Promise.all([
        mongoose.models.Role.findOne({
          name: 'BETA',
          tenantId: { $in: [null, undefined] },
        }).lean<IRole>(),
        mongoose.models.Role.findOne({ name: 'BETA', tenantId: 'tenant-a' }).lean<IRole>(),
      ]),
    );
    expect(base?.description).toBe('updated');
    expect(tenant?.description).toBe('tenant');
    expect(invalidateRoleCache).toHaveBeenCalledWith('BETA');
  });

  it('upserts only the base config when a tenant has the same principal', async () => {
    const config = {
      principalType: PrincipalType.ROLE,
      principalId: 'BETA',
      principalModel: PrincipalModel.ROLE,
      priority: 5,
      overrides: {},
      tombstones: ['memory.tokenLimit'],
    };
    await runAsSystem(async () => {
      await mongoose.models.Config.create(config);
    });
    await tenantStorage.run({ tenantId: 'tenant-a' }, async () => {
      await mongoose.models.Config.create({ ...config, priority: 20 });
    });

    await runAsSystem(() =>
      createService().upsertRoleConfig('BETA', {
        priority: 10,
        overrides: { memory: { disabled: false } },
      }),
    );

    const [base, tenant] = await runAsSystem(async () =>
      Promise.all([
        mongoose.models.Config.findOne({
          principalType: PrincipalType.ROLE,
          principalId: 'BETA',
          tenantId: { $in: [null, undefined] },
        }).lean<IConfig>(),
        mongoose.models.Config.findOne({
          principalType: PrincipalType.ROLE,
          principalId: 'BETA',
          tenantId: 'tenant-a',
        }).lean<IConfig>(),
      ]),
    );
    expect(base?.priority).toBe(10);
    expect(base?.overrides).toEqual({ memory: { disabled: false } });
    expect(base?.tombstones).toEqual([]);
    expect(tenant?.priority).toBe(20);
    expect(tenant?.tombstones).toEqual(['memory.tokenLimit']);
    expect(invalidateConfigCaches).toHaveBeenCalledTimes(1);
  });

  it('rejects system role names case-insensitively', async () => {
    await expect(
      runAsSystem(() => createService().createRole({ name: 'admin', permissions: {} })),
    ).rejects.toThrow('reserved system name');
  });
});
