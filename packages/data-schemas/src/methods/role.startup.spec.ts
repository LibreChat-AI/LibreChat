import mongoose from 'mongoose';
import { SystemRoles } from 'librechat-data-provider';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { _resetStrictCache } from '~/models/plugins/tenantIsolation';
import { runAsSystem, tenantStorage } from '~/config/tenantContext';
import { createModels } from '~/models';
import { createMethods } from './index';

let mongo: MongoMemoryServer;
let methods: ReturnType<typeof createMethods>;
const originalStrict = process.env.TENANT_ISOLATION_STRICT;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create({ instance: { args: ['--nounixsocket'] } });
  await mongoose.connect(mongo.getUri());
  createModels(mongoose);
  methods = createMethods(mongoose);
});

beforeEach(async () => {
  process.env.TENANT_ISOLATION_STRICT = 'true';
  _resetStrictCache();
  await runAsSystem(async () => mongoose.models.Role.deleteMany({}));
});

afterAll(async () => {
  if (originalStrict === undefined) {
    delete process.env.TENANT_ISOLATION_STRICT;
  } else {
    process.env.TENANT_ISOLATION_STRICT = originalStrict;
  }
  _resetStrictCache();
  await mongoose.disconnect();
  await mongo?.stop();
});

it.each([undefined, 'tenant-a'])(
  'initializes platform roles without changing a tenant-only USER (caller: %s)',
  async (tenantId) => {
    const Role = mongoose.models.Role;
    await tenantStorage.run({ tenantId: 'tenant-a' }, async () =>
      Role.collection.insertOne({
        name: SystemRoles.USER,
        tenantId: 'tenant-a',
        permissions: {
          AGENTS: { SHARED_GLOBAL: false },
          PROMPTS: { SHARED_GLOBAL: false },
        },
      }),
    );
    const before = await tenantStorage.run({ tenantId: 'tenant-a' }, async () =>
      Role.collection.findOne({ name: SystemRoles.USER, tenantId: 'tenant-a' }),
    );

    await tenantStorage.run({ tenantId }, async () => methods.initializeRoles());

    const roles = await runAsSystem(async () => Role.find({}).lean());
    const platformRoles = roles.filter((role) => !role.tenantId);
    expect(platformRoles.map((role) => role.name).sort()).toEqual([
      SystemRoles.ADMIN,
      SystemRoles.USER,
    ]);
    const after = await tenantStorage.run({ tenantId: 'tenant-a' }, async () =>
      Role.collection.findOne({ name: SystemRoles.USER, tenantId: 'tenant-a' }),
    );
    expect(after).toEqual(before);
  },
);

it.each([undefined, null, ''])(
  'migrates only platform legacy permissions (tenantId: %s)',
  async (tenantId) => {
    const Role = mongoose.models.Role;
    await runAsSystem(async () =>
      Role.collection.insertOne({
        name: SystemRoles.USER,
        ...(tenantId === undefined ? {} : { tenantId }),
        permissions: { AGENTS: { SHARED_GLOBAL: false } },
      }),
    );

    await runAsSystem(async () => methods.initializeRoles());

    const platform = await runAsSystem(async () =>
      Role.collection.findOne({ name: SystemRoles.USER }),
    );
    expect(platform?.permissions.AGENTS.SHARE).toBe(false);
    expect(platform?.permissions.AGENTS).not.toHaveProperty('SHARED_GLOBAL');
  },
);

it.each([undefined, 'tenant-a'])(
  'upgrades the platform USER when a tenant USER was inserted first (caller: %s)',
  async (tenantId) => {
    const Role = mongoose.models.Role;
    const tenantRoleId = new mongoose.Types.ObjectId();
    const platformRoleId = new mongoose.Types.ObjectId();
    await runAsSystem(async () =>
      Role.collection.insertMany([
        {
          _id: tenantRoleId,
          name: SystemRoles.USER,
          tenantId: 'tenant-a',
          permissions: {
            AGENTS: { SHARED_GLOBAL: true },
            PROMPTS: { SHARED_GLOBAL: true },
          },
        },
        {
          _id: platformRoleId,
          name: SystemRoles.USER,
          permissions: {
            AGENTS: { SHARED_GLOBAL: false },
            PROMPTS: { SHARED_GLOBAL: false },
          },
        },
      ]),
    );
    const before = await Role.collection.findOne({ _id: tenantRoleId });

    await tenantStorage.run({ tenantId }, async () => methods.initializeRoles());

    expect(await Role.collection.findOne({ _id: tenantRoleId })).toEqual(before);
    const platform = await Role.collection.findOne({ _id: platformRoleId });
    for (const permissionType of ['AGENTS', 'PROMPTS']) {
      expect(platform?.permissions[permissionType].SHARE).toBe(false);
      expect(platform?.permissions[permissionType]).not.toHaveProperty('SHARED_GLOBAL');
      expect(platform?.permissions[permissionType].USE).toBeDefined();
    }
    expect(await runAsSystem(async () => Role.countDocuments({}))).toBe(3);
  },
);
