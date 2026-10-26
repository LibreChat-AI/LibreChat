import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { PrincipalType, SystemRoles } from 'librechat-data-provider';
import { tenantStorage, runAsSystem } from '~/config/tenantContext';
import { createPrincipalMethods } from './principal';
import { createModels } from '~/models';

let mongoServer: MongoMemoryServer;
let methods: ReturnType<typeof createPrincipalMethods>;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  createModels(mongoose);
  methods = createPrincipalMethods(mongoose);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

beforeEach(async () => {
  await Promise.all(['Role', 'Group', 'User'].map((name) => mongoose.models[name].deleteMany({})));
});

const inTenant = <T>(tenantId: string, run: () => Promise<T>): Promise<T> =>
  tenantStorage.run({ tenantId }, run);

/** A role, group and user, created in the active tenant context (or at platform level). */
async function seedPrincipals(label: string): Promise<{ groupId: string; userId: string }> {
  await new mongoose.models.Role({ name: `${label}-role` }).save();
  const group = await new mongoose.models.Group({ name: `${label} group`, source: 'local' }).save();
  const user = await new mongoose.models.User({
    email: `${label}@example.com`,
    provider: 'local',
  }).save();
  return { groupId: group._id.toString(), userId: user._id.toString() };
}

const existence = ({ groupId, userId }: { groupId: string; userId: string }, label: string) =>
  Promise.all([
    methods.principalExists(PrincipalType.ROLE, `${label}-role`),
    methods.principalExists(PrincipalType.GROUP, groupId),
    methods.principalExists(PrincipalType.USER, userId),
  ]);

describe('principalExists', () => {
  it('finds platform-level principals, and never a tenant one, for a caller without a tenant', async () => {
    const platform = await seedPrincipals('platform');
    const tenant = await inTenant('tenant-a', () => seedPrincipals('tenant'));

    expect(await existence(platform, 'platform')).toEqual([true, true, true]);
    expect(await existence(tenant, 'tenant')).toEqual([false, false, false]);
  });

  it('finds only the active tenant principals inside a tenant', async () => {
    const platform = await seedPrincipals('platform');
    const tenantA = await inTenant('tenant-a', () => seedPrincipals('a'));
    const tenantB = await inTenant('tenant-b', () => seedPrincipals('b'));

    const [ownA, otherB, platformFromA] = await inTenant('tenant-a', () =>
      Promise.all([
        existence(tenantA, 'a'),
        existence(tenantB, 'b'),
        existence(platform, 'platform'),
      ]),
    );

    expect(ownA).toEqual([true, true, true]);
    expect(otherB).toEqual([false, false, false]);
    expect(platformFromA).toEqual([false, false, false]);
  });

  it('treats an unclaimed principal (null or empty tenant) as platform-level', async () => {
    const unclaimed = await seedPrincipals('unclaimed');
    await Promise.all([
      mongoose.models.Role.collection.updateOne(
        { name: 'unclaimed-role' },
        { $set: { tenantId: null } },
      ),
      mongoose.models.Group.collection.updateOne(
        { _id: new mongoose.Types.ObjectId(unclaimed.groupId) },
        { $set: { tenantId: '' } },
      ),
    ]);

    expect(await existence(unclaimed, 'unclaimed')).toEqual([true, true, true]);
  });

  it('matches a role by its exact name only', async () => {
    await new mongoose.models.Role({ name: 'Editor' }).save();

    expect(await methods.principalExists(PrincipalType.ROLE, 'Editor')).toBe(true);
    expect(await methods.principalExists(PrincipalType.ROLE, 'editor')).toBe(false);
    expect(await methods.principalExists(PrincipalType.ROLE, 'Edit.*')).toBe(false);
  });

  it('counts the system roles as existing without creating their documents', async () => {
    const found = await inTenant('tenant-a', () =>
      Promise.all(
        Object.values(SystemRoles).map((name) => methods.principalExists(PrincipalType.ROLE, name)),
      ),
    );

    expect(found.every(Boolean)).toBe(true);
    expect(await runAsSystem(() => mongoose.models.Role.countDocuments({}))).toBe(0);
  });

  it('refuses an uppercase spelling of a real group or user id, which config lookups never match', async () => {
    const groupId = 'a1b2c3d4e5f6a1b2c3d4e5f6';
    const userId = 'f6e5d4c3b2a1f6e5d4c3b2a1';
    await new mongoose.models.Group({ _id: groupId, name: 'upper group', source: 'local' }).save();
    await new mongoose.models.User({
      _id: userId,
      email: 'upper@example.com',
      provider: 'local',
    }).save();
    const groupFind = jest.spyOn(mongoose.models.Group, 'findOne');
    const userFind = jest.spyOn(mongoose.models.User, 'findOne');

    expect(await methods.principalExists(PrincipalType.GROUP, groupId.toUpperCase())).toBe(false);
    expect(await methods.principalExists(PrincipalType.USER, userId.toUpperCase())).toBe(false);
    expect(groupFind).not.toHaveBeenCalled();
    expect(userFind).not.toHaveBeenCalled();
    expect(await methods.principalExists(PrincipalType.GROUP, groupId)).toBe(true);
    expect(await methods.principalExists(PrincipalType.USER, userId)).toBe(true);
    groupFind.mockRestore();
    userFind.mockRestore();
  });

  it('answers false without a query for an id that cannot name a group or user', async () => {
    const findOne = jest.spyOn(mongoose.models.Group, 'findOne');

    expect(await methods.principalExists(PrincipalType.GROUP, 'grp_engineering')).toBe(false);
    expect(await methods.principalExists(PrincipalType.USER, 'not-an-id')).toBe(false);
    expect(await methods.principalExists(PrincipalType.PUBLIC, 'anyone')).toBe(false);
    expect(findOne).not.toHaveBeenCalled();
    findOne.mockRestore();
  });
});

describe('findPrincipalUser', () => {
  it('returns what principal resolution reads and the tenant that holds the user', async () => {
    const platform = await seedPrincipals('platform');
    const tenant = await inTenant('tenant-a', async () => {
      const user = await new mongoose.models.User({
        email: 'sso@example.com',
        provider: 'openid',
        role: 'EDITOR',
        idOnTheSource: 'entra-oid',
      }).save();
      return user._id.toString();
    });
    const tenantUser = {
      id: tenant,
      role: 'EDITOR',
      idOnTheSource: 'entra-oid',
      tenantId: 'tenant-a',
    };

    expect(await methods.findPrincipalUser(platform.userId)).toEqual({
      id: platform.userId,
      role: SystemRoles.USER,
      idOnTheSource: null,
    });
    /** Outside a tenant a user is addressed by id, as group and user profiles are. */
    expect(await methods.findPrincipalUser(tenant)).toEqual(tenantUser);
    expect(await inTenant('tenant-a', () => methods.findPrincipalUser(tenant))).toEqual(tenantUser);
    expect(await inTenant('tenant-b', () => methods.findPrincipalUser(tenant))).toBeNull();
    expect(await inTenant('tenant-a', () => methods.findPrincipalUser(platform.userId))).toBeNull();
  });

  it('treats an unclaimed user (null or empty tenant) as platform-level', async () => {
    const [unset, empty] = await Promise.all(
      [null, ''].map(async (tenantId, index) => {
        const { insertedId } = await mongoose.models.User.collection.insertOne({
          email: `unclaimed-${index}@example.com`,
          provider: 'local',
          role: 'USER',
          tenantId,
        });
        return insertedId.toString();
      }),
    );

    for (const userId of [unset, empty]) {
      expect(await methods.findPrincipalUser(userId)).toEqual({
        id: userId,
        role: 'USER',
        idOnTheSource: null,
      });
    }
  });

  it('answers null without a query for an id that cannot name a user', async () => {
    const findOne = jest.spyOn(mongoose.models.User, 'findOne');
    expect(await methods.findPrincipalUser('not-an-id')).toBeNull();
    expect(await methods.findPrincipalUser('F6E5D4C3B2A1F6E5D4C3B2A1')).toBeNull();
    expect(findOne).not.toHaveBeenCalled();
    findOne.mockRestore();
  });
});
