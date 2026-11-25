import mongoose, { Types } from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { PrincipalType, SystemRoles } from 'librechat-data-provider';
import type * as t from '~/types';
import { runAsSystem, tenantStorage } from '~/config/tenantContext';
import { createUserGroupMethods } from './userGroup';
import groupSchema from '~/schema/group';
import userSchema from '~/schema/user';

jest.mock('~/config/winston', () => ({
  error: jest.fn(),
  info: jest.fn(),
  debug: jest.fn(),
}));

const TENANT = 'tenant-a';

let mongoServer: MongoMemoryServer;
let Group: mongoose.Model<t.IGroup>;
let User: mongoose.Model<t.IUser>;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  Group = mongoose.models.Group || mongoose.model<t.IGroup>('Group', groupSchema);
  User = mongoose.models.User || mongoose.model<t.IUser>('User', userSchema);
  await mongoose.connect(mongoServer.getUri());
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer?.stop();
});

beforeEach(async () => {
  await Group.deleteMany({});
  await User.deleteMany({});
});

function createFakeCache() {
  const store = new Map<string, unknown>();
  return {
    store,
    get: jest.fn(async (key: string) => store.get(key)),
    set: jest.fn(async (key: string, value: unknown) => {
      store.set(key, value);
    }),
    delete: jest.fn(async (key: string) => store.delete(key)),
    clear: jest.fn(async () => store.clear()),
  };
}

async function seedMembership() {
  const user = await User.create({
    name: 'Member',
    email: `member-${new Types.ObjectId()}@test.com`,
    provider: 'local',
    role: SystemRoles.USER,
  });
  const userId = user._id.toString();
  const group = await Group.create({ name: 'Team', source: 'local', memberIds: [userId] });
  const cache = createFakeCache();
  const methods = createUserGroupMethods(mongoose, { getCache: jest.fn(() => cache) });
  const readGroups = () =>
    tenantStorage.run({ tenantId: TENANT }, async () => {
      const principals = await methods.getUserPrincipals({
        userId,
        role: SystemRoles.USER,
        idOnTheSource: null,
      });
      return principals
        .filter((p) => p.principalType === PrincipalType.GROUP)
        .map((p) => p.principalId!.toString());
    });

  expect(await readGroups()).toEqual([group._id.toString()]);
  const scopedKey = `${userId}:${TENANT}`;
  expect(cache.store.has(scopedKey)).toBe(true);
  return { userId, cache, methods, readGroups, scopedKey };
}

describe('group membership cache eviction outside the member tenant context', () => {
  it('leaves the tenant-scoped key cached when runAsSystem omits the tenant', async () => {
    const { userId, cache, methods, scopedKey } = await seedMembership();

    await runAsSystem(() => methods.removeUserFromAllGroups(userId));

    expect(cache.store.has(scopedKey)).toBe(true);
  });

  it('removeUserFromAllGroups evicts the tenant-scoped key when given the tenant', async () => {
    const { userId, cache, methods, readGroups, scopedKey } = await seedMembership();

    await runAsSystem(() => methods.removeUserFromAllGroups(userId, TENANT));

    expect(cache.store.has(scopedKey)).toBe(false);
    expect(await readGroups()).toEqual([]);
  });

  it('invalidatePrincipalMemberships evicts the tenant-scoped key when given the tenant', async () => {
    const { userId, cache, methods, scopedKey } = await seedMembership();

    await runAsSystem(() => methods.invalidatePrincipalMemberships([userId], TENANT));

    expect(cache.store.has(scopedKey)).toBe(false);
    expect(cache.delete).toHaveBeenCalledWith(userId);
  });
});
