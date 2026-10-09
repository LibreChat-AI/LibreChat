import mongoose, { Types } from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { PrincipalType, SystemRoles } from 'librechat-data-provider';
import type * as t from '~/types';
import { tenantStorage } from '~/config/tenantContext';
import { createUserGroupMethods } from './userGroup';
import groupSchema from '~/schema/group';
import userSchema from '~/schema/user';
import roleSchema from '~/schema/role';

jest.mock('~/config/winston', () => ({
  error: jest.fn(),
  info: jest.fn(),
  debug: jest.fn(),
}));

let mongoServer: MongoMemoryReplSet;
let Group: mongoose.Model<t.IGroup>;
let User: mongoose.Model<t.IUser>;
let Role: mongoose.Model<t.IRole>;
let methods: ReturnType<typeof createUserGroupMethods>;

beforeAll(async () => {
  /** Single-node replica set so transactional invalidation deferral is tested for real */
  mongoServer = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  Group = mongoose.models.Group || mongoose.model<t.IGroup>('Group', groupSchema);
  User = mongoose.models.User || mongoose.model<t.IUser>('User', userSchema);
  Role = mongoose.models.Role || mongoose.model<t.IRole>('Role', roleSchema);
  methods = createUserGroupMethods(mongoose);
  await mongoose.connect(mongoServer.getUri());
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

beforeEach(async () => {
  await Group.deleteMany({});
  await User.deleteMany({});
  await Role.deleteMany({});
});

async function createTestUser(overrides: Partial<t.IUser> = {}) {
  return User.create({
    name: 'Test User',
    email: `user-${new Types.ObjectId()}@test.com`,
    password: 'password123',
    provider: 'local',
    role: SystemRoles.USER,
    ...overrides,
  });
}

describe('userGroup methods', () => {
  describe('findGroupById', () => {
    it('returns the group when it exists', async () => {
      const group = await Group.create({ name: 'Engineering', source: 'local' });
      const found = await methods.findGroupById(group._id);
      expect(found).toBeTruthy();
      expect(found!.name).toBe('Engineering');
    });

    it('returns null when group does not exist', async () => {
      const found = await methods.findGroupById(new Types.ObjectId());
      expect(found).toBeNull();
    });

    it('respects projection parameter', async () => {
      const group = await Group.create({
        name: 'Engineering',
        description: 'The eng team',
        source: 'local',
      });
      const found = await methods.findGroupById(group._id, { name: 1 });
      expect(found!.name).toBe('Engineering');
      expect(found!.description).toBeUndefined();
    });
  });

  describe('findGroupByExternalId', () => {
    it('finds a group by its external Entra ID', async () => {
      await Group.create({
        name: 'Entra Group',
        source: 'entra',
        idOnTheSource: 'entra-abc-123',
      });
      const found = await methods.findGroupByExternalId('entra-abc-123', 'entra');
      expect(found).toBeTruthy();
      expect(found!.name).toBe('Entra Group');
    });

    it('returns null when no match', async () => {
      const found = await methods.findGroupByExternalId('nonexistent', 'entra');
      expect(found).toBeNull();
    });
  });

  describe('findGroupsByNamePattern', () => {
    beforeEach(async () => {
      await Group.create([
        { name: 'Engineering', source: 'local', description: 'Eng team' },
        { name: 'Design', source: 'local', email: 'design@co.com' },
        { name: 'Entra Eng', source: 'entra', idOnTheSource: 'ext-1' },
        { name: 'Literal .* Group', source: 'local' },
      ]);
    });

    it('finds groups by name pattern (case-insensitive)', async () => {
      const results = await methods.findGroupsByNamePattern('eng');
      expect(results.length).toBeGreaterThanOrEqual(2);
    });

    it('matches on email field', async () => {
      const results = await methods.findGroupsByNamePattern('design@');
      expect(results).toHaveLength(1);
      expect(results[0].name).toBe('Design');
    });

    it('matches on description field', async () => {
      const results = await methods.findGroupsByNamePattern('Eng team');
      expect(results).toHaveLength(1);
      expect(results[0].name).toBe('Engineering');
    });

    it('treats regex metacharacters as literal text', async () => {
      const results = await methods.findGroupsByNamePattern('.*');
      expect(results).toHaveLength(1);
      expect(results[0].name).toBe('Literal .* Group');
    });

    it('filters by source when provided', async () => {
      const results = await methods.findGroupsByNamePattern('eng', 'entra');
      expect(results).toHaveLength(1);
      expect(results[0].source).toBe('entra');
    });

    it('respects limit parameter', async () => {
      for (let i = 0; i < 5; i++) {
        await Group.create({ name: `Numbered Group ${i}`, source: 'local' });
      }
      const results = await methods.findGroupsByNamePattern('Numbered', null, 2);
      expect(results).toHaveLength(2);
    });
  });

  describe('findGroupsByMemberId', () => {
    it('returns groups the user is a member of via idOnTheSource', async () => {
      const user = await createTestUser({ idOnTheSource: 'user-ext-1' });
      await Group.create([
        { name: 'Group A', source: 'local', memberIds: ['user-ext-1'] },
        { name: 'Group B', source: 'local', memberIds: ['user-ext-1'] },
        { name: 'Group C', source: 'local', memberIds: ['other-user'] },
      ]);

      const groups = await methods.findGroupsByMemberId(user._id);
      expect(groups).toHaveLength(2);
      const names = groups.map((g) => g.name).sort();
      expect(names).toEqual(['Group A', 'Group B']);
    });

    it('returns empty array when user does not exist', async () => {
      const groups = await methods.findGroupsByMemberId(new Types.ObjectId());
      expect(groups).toEqual([]);
    });

    it('falls back to userId string when user has no idOnTheSource', async () => {
      const user = await createTestUser();
      await Group.create({
        name: 'Group X',
        source: 'local',
        memberIds: [user._id.toString()],
      });

      const groups = await methods.findGroupsByMemberId(user._id);
      expect(groups).toHaveLength(1);
    });
  });

  describe('createGroup', () => {
    it('creates a group and returns the document', async () => {
      const group = await methods.createGroup({ name: 'New Group', source: 'local' });
      expect(group).toBeTruthy();
      expect(group.name).toBe('New Group');
      expect(group._id).toBeDefined();
    });
  });

  describe('upsertGroupByExternalId', () => {
    it('creates a new group when none exists', async () => {
      const group = await methods.upsertGroupByExternalId('ext-new', 'entra', {
        name: 'New Entra Group',
      });
      expect(group).toBeTruthy();
      expect(group!.name).toBe('New Entra Group');
      expect(group!.idOnTheSource).toBe('ext-new');
    });

    it('updates existing group when found', async () => {
      await Group.create({ name: 'Old Name', source: 'entra', idOnTheSource: 'ext-1' });
      const group = await methods.upsertGroupByExternalId('ext-1', 'entra', {
        name: 'Updated Name',
      });
      expect(group!.name).toBe('Updated Name');
      const count = await Group.countDocuments({ idOnTheSource: 'ext-1' });
      expect(count).toBe(1);
    });
  });

  describe('addUserToGroup', () => {
    it('adds user to group using idOnTheSource', async () => {
      const user = await createTestUser({ idOnTheSource: 'user-ext-1' });
      const group = await Group.create({ name: 'Team', source: 'local' });

      const { group: updatedGroup } = await methods.addUserToGroup(user._id, group._id);
      expect(updatedGroup!.memberIds).toContain('user-ext-1');
    });

    it('falls back to userId string when user has no idOnTheSource', async () => {
      const user = await createTestUser();
      const group = await Group.create({ name: 'Team', source: 'local' });

      const { group: updatedGroup } = await methods.addUserToGroup(user._id, group._id);
      expect(updatedGroup!.memberIds).toContain(user._id.toString());
    });

    it('is idempotent — $addToSet prevents duplicates', async () => {
      const user = await createTestUser({ idOnTheSource: 'user-ext-1' });
      const group = await Group.create({ name: 'Team', source: 'local' });

      await methods.addUserToGroup(user._id, group._id);
      const { group: updatedGroup } = await methods.addUserToGroup(user._id, group._id);
      expect(updatedGroup!.memberIds!.filter((id) => id === 'user-ext-1')).toHaveLength(1);
    });

    it('throws when user does not exist', async () => {
      const group = await Group.create({ name: 'Team', source: 'local' });
      await expect(methods.addUserToGroup(new Types.ObjectId(), group._id)).rejects.toThrow(
        /User not found/,
      );
    });
  });

  describe('removeUserFromGroup', () => {
    it('removes user from group', async () => {
      const user = await createTestUser({ idOnTheSource: 'user-ext-1' });
      const group = await Group.create({
        name: 'Team',
        source: 'local',
        memberIds: ['user-ext-1'],
      });

      const { group: updatedGroup } = await methods.removeUserFromGroup(user._id, group._id);
      expect(updatedGroup!.memberIds).not.toContain('user-ext-1');
    });

    it('throws when user does not exist', async () => {
      const group = await Group.create({ name: 'Team', source: 'local' });
      await expect(methods.removeUserFromGroup(new Types.ObjectId(), group._id)).rejects.toThrow(
        /User not found/,
      );
    });

    it('is safe when user is not a member', async () => {
      const user = await createTestUser({ idOnTheSource: 'user-ext-1' });
      const group = await Group.create({
        name: 'Team',
        source: 'local',
        memberIds: ['other-user'],
      });

      const { group: updatedGroup } = await methods.removeUserFromGroup(user._id, group._id);
      expect(updatedGroup!.memberIds).toEqual(['other-user']);
    });
  });

  describe('removeUserFromAllGroups', () => {
    it('removes user from every group they belong to', async () => {
      const userId = new Types.ObjectId();
      await Group.create([
        { name: 'Group A', source: 'local', memberIds: [userId.toString(), 'other'] },
        { name: 'Group B', source: 'local', memberIds: [userId.toString()] },
        { name: 'Group C', source: 'local', memberIds: ['other'] },
      ]);

      await methods.removeUserFromAllGroups(userId.toString());

      const groups = await Group.find({ memberIds: userId.toString() });
      expect(groups).toHaveLength(0);

      const groupC = await Group.findOne({ name: 'Group C' });
      expect(groupC!.memberIds).toContain('other');
    });

    it('is a no-op when user is not in any groups', async () => {
      await Group.create({ name: 'Group A', source: 'local', memberIds: ['other'] });
      await expect(
        methods.removeUserFromAllGroups(new Types.ObjectId().toString()),
      ).resolves.not.toThrow();
    });
  });

  describe('getUserGroups', () => {
    it('delegates to findGroupsByMemberId', async () => {
      const user = await createTestUser({ idOnTheSource: 'user-ext-1' });
      await Group.create({ name: 'Team', source: 'local', memberIds: ['user-ext-1'] });

      const groups = await methods.getUserGroups(user._id);
      expect(groups).toHaveLength(1);
      expect(groups[0].name).toBe('Team');
    });
  });

  describe('getUserPrincipals', () => {
    it('returns USER, ROLE, and PUBLIC principals', async () => {
      const user = await createTestUser({ role: SystemRoles.ADMIN });
      const principals = await methods.getUserPrincipals({
        userId: user._id.toString(),
        role: SystemRoles.ADMIN,
      });

      const types = principals.map((p) => p.principalType);
      expect(types).toContain(PrincipalType.USER);
      expect(types).toContain(PrincipalType.ROLE);
      expect(types).toContain(PrincipalType.PUBLIC);
    });

    it('includes group principals when user is a member', async () => {
      const user = await createTestUser({ idOnTheSource: 'user-ext-1' });
      const group = await Group.create({
        name: 'Team',
        source: 'local',
        memberIds: ['user-ext-1'],
      });

      const principals = await methods.getUserPrincipals({
        userId: user._id.toString(),
        role: SystemRoles.USER,
      });

      const groupPrincipal = principals.find((p) => p.principalType === PrincipalType.GROUP);
      expect(groupPrincipal).toBeTruthy();
      expect(groupPrincipal!.principalId!.toString()).toBe(group._id.toString());
    });

    it('queries user role from DB when role param is undefined', async () => {
      const user = await createTestUser({ role: SystemRoles.ADMIN });
      const principals = await methods.getUserPrincipals({ userId: user._id.toString() });

      const rolePrincipal = principals.find((p) => p.principalType === PrincipalType.ROLE);
      expect(rolePrincipal).toBeTruthy();
      expect(rolePrincipal!.principalId).toBe(SystemRoles.ADMIN);
    });

    it('omits role principal when role is empty/whitespace', async () => {
      const user = await createTestUser({ role: '  ' });
      const principals = await methods.getUserPrincipals({
        userId: user._id.toString(),
        role: '  ',
      });

      const rolePrincipal = principals.find((p) => p.principalType === PrincipalType.ROLE);
      expect(rolePrincipal).toBeUndefined();
    });

    it('converts string userId to ObjectId for USER principal', async () => {
      const user = await createTestUser();
      const principals = await methods.getUserPrincipals({
        userId: user._id.toString(),
        role: SystemRoles.USER,
      });

      const userPrincipal = principals.find((p) => p.principalType === PrincipalType.USER);
      expect(userPrincipal!.principalId).toBeInstanceOf(Types.ObjectId);
    });

    it('includes null role when role param is null', async () => {
      const user = await createTestUser({ role: SystemRoles.USER });
      const principals = await methods.getUserPrincipals({
        userId: user._id.toString(),
        role: null,
      });

      const rolePrincipal = principals.find((p) => p.principalType === PrincipalType.ROLE);
      expect(rolePrincipal).toBeUndefined();
    });

    it('uses a supplied idOnTheSource authoritatively over the stored value', async () => {
      const user = await createTestUser({ idOnTheSource: 'stored-ext-id' });
      const group = await Group.create({
        name: 'Team',
        source: 'entra',
        idOnTheSource: 'grp-ext',
        memberIds: ['passed-ext-id'],
      });

      const principals = await methods.getUserPrincipals({
        userId: user._id.toString(),
        role: SystemRoles.USER,
        idOnTheSource: 'passed-ext-id',
      });

      const groupPrincipal = principals.find((p) => p.principalType === PrincipalType.GROUP);
      expect(groupPrincipal!.principalId!.toString()).toBe(group._id.toString());
    });

    it('resolves groups without a user document when idOnTheSource is supplied', async () => {
      const missingUserId = new Types.ObjectId().toString();
      const group = await Group.create({
        name: 'Orphan Team',
        source: 'entra',
        idOnTheSource: 'grp-orphan',
        memberIds: ['ext-orphan'],
      });

      const principals = await methods.getUserPrincipals({
        userId: missingUserId,
        role: SystemRoles.USER,
        idOnTheSource: 'ext-orphan',
      });

      const groupPrincipal = principals.find((p) => p.principalType === PrincipalType.GROUP);
      expect(groupPrincipal!.principalId!.toString()).toBe(group._id.toString());
    });

    it('treats idOnTheSource null as a local user keyed by user id', async () => {
      const user = await createTestUser();
      const group = await Group.create({
        name: 'Local Team',
        source: 'local',
        memberIds: [user._id.toString()],
      });

      const principals = await methods.getUserPrincipals({
        userId: user._id.toString(),
        role: SystemRoles.USER,
        idOnTheSource: null,
      });

      const groupPrincipal = principals.find((p) => p.principalType === PrincipalType.GROUP);
      expect(groupPrincipal!.principalId!.toString()).toBe(group._id.toString());
    });

    it('falls back to resolving role and idOnTheSource from the DB when both are omitted', async () => {
      const user = await createTestUser({ role: SystemRoles.ADMIN, idOnTheSource: 'ext-99' });
      const group = await Group.create({
        name: 'Entra Team',
        source: 'entra',
        idOnTheSource: 'grp-99',
        memberIds: ['ext-99'],
      });

      const principals = await methods.getUserPrincipals({ userId: user._id.toString() });

      const rolePrincipal = principals.find((p) => p.principalType === PrincipalType.ROLE);
      expect(rolePrincipal!.principalId).toBe(SystemRoles.ADMIN);
      const groupPrincipal = principals.find((p) => p.principalType === PrincipalType.GROUP);
      expect(groupPrincipal!.principalId!.toString()).toBe(group._id.toString());
    });

    it('returns only the group id from the projected group query', async () => {
      const user = await createTestUser({ idOnTheSource: 'ext-proj' });
      await Group.create({
        name: 'Projected Team',
        source: 'entra',
        idOnTheSource: 'grp-proj',
        description: 'should not leak',
        memberIds: ['ext-proj'],
      });

      const principals = await methods.getUserPrincipals({
        userId: user._id.toString(),
        role: SystemRoles.USER,
        idOnTheSource: 'ext-proj',
      });

      const groupPrincipal = principals.find((p) => p.principalType === PrincipalType.GROUP);
      expect(groupPrincipal).toEqual({
        principalType: PrincipalType.GROUP,
        principalId: expect.anything(),
      });
      expect(Object.keys(groupPrincipal!)).toEqual(['principalType', 'principalId']);
    });
  });

  describe('getUserPrincipals caching', () => {
    function createFakeCache({ onRead }: { onRead?: () => Promise<void> } = {}) {
      const store = new Map<string, unknown>();
      return {
        store,
        get: jest.fn(async (key: string) => {
          await onRead?.();
          return store.get(key);
        }),
        set: jest.fn(async (key: string, value: unknown) => {
          store.set(key, value);
        }),
        delete: jest.fn(async (key: string) => store.delete(key)),
        clear: jest.fn(async () => store.clear()),
      };
    }

    /**
     * Holds each cache read until `callers` of them are inside the miss window together, so a
     * test about deduplicating concurrent builds actually gets concurrent builds. Delaying
     * every read by a fixed few milliseconds instead leaves the overlap up to the scheduler:
     * under load the first build can finish before a later caller reads, and that caller then
     * takes the miss path on its own, which is correct behaviour but not what such a test is
     * asserting. Reads after the barrier opens pass straight through, so a caller that reads
     * again mid-build (after taking the lock, say) cannot deadlock.
     */
    function arrivalBarrier(callers: number) {
      let arrived = 0;
      let open!: () => void;
      const allArrived = new Promise<void>((resolve) => {
        open = resolve;
      });
      return async () => {
        if (++arrived >= callers) {
          open();
        }
        await allArrived;
      };
    }

    function createCachedMethods(cache: ReturnType<typeof createFakeCache>) {
      return createUserGroupMethods(mongoose, { getCache: jest.fn(() => cache) });
    }

    const groupPrincipalIds = (
      principals: Array<{ principalType: PrincipalType; principalId?: string | Types.ObjectId }>,
    ) =>
      principals
        .filter((p) => p.principalType === PrincipalType.GROUP)
        .map((p) => p.principalId!.toString())
        .sort();

    it('serves repeat lookups from the cache without re-querying groups', async () => {
      const user = await createTestUser({ idOnTheSource: 'cache-ext-1' });
      const group = await Group.create({
        name: 'Cached Team',
        source: 'entra',
        idOnTheSource: 'cache-grp-1',
        memberIds: ['cache-ext-1'],
      });
      const cache = createFakeCache();
      const cachedMethods = createCachedMethods(cache);
      const params = {
        userId: user._id.toString(),
        role: SystemRoles.USER,
        idOnTheSource: 'cache-ext-1',
      };

      const first = await cachedMethods.getUserPrincipals(params);
      const findSpy = jest.spyOn(Group, 'find');
      const second = await cachedMethods.getUserPrincipals(params);
      expect(findSpy).not.toHaveBeenCalled();
      findSpy.mockRestore();

      expect(first).toEqual(second);
      expect(groupPrincipalIds(second)).toEqual([group._id.toString()]);
      expect(cache.set).toHaveBeenCalledTimes(1);
      expect(cache.set).toHaveBeenCalledWith('cache-ext-1', [group._id.toString()]);
    });

    it('caches empty memberships and hydrates group ids as ObjectIds', async () => {
      const user = await createTestUser({ idOnTheSource: 'cache-ext-empty' });
      const cache = createFakeCache();
      const cachedMethods = createCachedMethods(cache);
      const params = {
        userId: user._id.toString(),
        role: SystemRoles.USER,
        idOnTheSource: 'cache-ext-empty',
      };

      await cachedMethods.getUserPrincipals(params);
      expect(cache.store.get('cache-ext-empty')).toEqual([]);

      const group = await Group.create({
        name: 'Late Team',
        source: 'entra',
        idOnTheSource: 'cache-grp-late',
        memberIds: ['cache-ext-empty'],
      });
      /** Still served from the cached empty entry until invalidation or expiry */
      const cached = await cachedMethods.getUserPrincipals(params);
      expect(groupPrincipalIds(cached)).toEqual([]);

      cache.store.set('cache-ext-empty', [group._id.toString()]);
      const hydrated = await cachedMethods.getUserPrincipals(params);
      const groupPrincipal = hydrated.find((p) => p.principalType === PrincipalType.GROUP);
      expect(groupPrincipal!.principalId).toBeInstanceOf(Types.ObjectId);
    });

    it('never caches role resolution', async () => {
      const user = await createTestUser({ role: SystemRoles.USER });
      const cache = createFakeCache();
      const cachedMethods = createCachedMethods(cache);
      const params = { userId: user._id.toString(), idOnTheSource: null };

      const before = await cachedMethods.getUserPrincipals(params);
      expect(before).toContainEqual({
        principalType: PrincipalType.ROLE,
        principalId: SystemRoles.USER,
      });

      await User.updateOne({ _id: user._id }, { $set: { role: SystemRoles.ADMIN } });
      const after = await cachedMethods.getUserPrincipals(params);
      expect(after).toContainEqual({
        principalType: PrincipalType.ROLE,
        principalId: SystemRoles.ADMIN,
      });
      expect(cache.set).toHaveBeenCalledTimes(1);
    });

    it('bypasses the cache for session-scoped reads', async () => {
      const user = await createTestUser({ idOnTheSource: 'cache-ext-session' });
      const cache = createFakeCache();
      const cachedMethods = createCachedMethods(cache);
      const session = await mongoose.startSession();

      try {
        await cachedMethods.getUserPrincipals(
          { userId: user._id.toString(), role: SystemRoles.USER, idOnTheSource: null },
          session,
        );
      } finally {
        await session.endSession();
      }

      expect(cache.get).not.toHaveBeenCalled();
      expect(cache.set).not.toHaveBeenCalled();
    });

    it('reflects membership changes immediately via invalidation', async () => {
      const user = await createTestUser({ idOnTheSource: 'inv-ext-1' });
      const group = await Group.create({
        name: 'Invalidation Team',
        source: 'entra',
        idOnTheSource: 'inv-grp-1',
        memberIds: [],
      });
      const cache = createFakeCache();
      const cachedMethods = createCachedMethods(cache);
      const params = {
        userId: user._id.toString(),
        role: SystemRoles.USER,
        idOnTheSource: 'inv-ext-1',
      };

      expect(groupPrincipalIds(await cachedMethods.getUserPrincipals(params))).toEqual([]);

      await cachedMethods.addUserToGroup(user._id, group._id);
      expect(groupPrincipalIds(await cachedMethods.getUserPrincipals(params))).toEqual([
        group._id.toString(),
      ]);

      await cachedMethods.removeUserFromGroup(user._id, group._id);
      expect(groupPrincipalIds(await cachedMethods.getUserPrincipals(params))).toEqual([]);
    });

    it('invalidates members when a group is created with members or deleted', async () => {
      const user = await createTestUser({ idOnTheSource: 'inv-ext-2' });
      const cache = createFakeCache();
      const cachedMethods = createCachedMethods(cache);
      const params = {
        userId: user._id.toString(),
        role: SystemRoles.USER,
        idOnTheSource: 'inv-ext-2',
      };

      expect(groupPrincipalIds(await cachedMethods.getUserPrincipals(params))).toEqual([]);

      const group = await cachedMethods.createGroup({
        name: 'Created Team',
        source: 'entra',
        idOnTheSource: 'inv-grp-2',
        memberIds: ['inv-ext-2'],
      });
      expect(groupPrincipalIds(await cachedMethods.getUserPrincipals(params))).toEqual([
        group._id.toString(),
      ]);

      await cachedMethods.deleteGroup(group._id);
      expect(groupPrincipalIds(await cachedMethods.getUserPrincipals(params))).toEqual([]);
    });

    it('invalidates member keys extracted from bulk membership updates', async () => {
      const user = await createTestUser({ idOnTheSource: 'bulk-ext-1' });
      const group = await Group.create({
        name: 'Bulk Team',
        source: 'entra',
        idOnTheSource: 'bulk-grp-1',
        memberIds: ['bulk-ext-1'],
      });
      const cache = createFakeCache();
      const cachedMethods = createCachedMethods(cache);
      const params = {
        userId: user._id.toString(),
        role: SystemRoles.USER,
        idOnTheSource: 'bulk-ext-1',
      };

      expect(groupPrincipalIds(await cachedMethods.getUserPrincipals(params))).toEqual([
        group._id.toString(),
      ]);

      await cachedMethods.bulkUpdateGroups(
        { _id: group._id },
        { $pullAll: { memberIds: ['bulk-ext-1'] } },
      );

      expect(cache.delete).toHaveBeenCalledWith('bulk-ext-1');
      expect(cache.clear).not.toHaveBeenCalled();
      expect(groupPrincipalIds(await cachedMethods.getUserPrincipals(params))).toEqual([]);
    });

    it('clears the cache when a bulk update replaces memberIds wholesale', async () => {
      const group = await Group.create({
        name: 'Wholesale Team',
        source: 'entra',
        idOnTheSource: 'bulk-grp-2',
        memberIds: ['bulk-ext-old'],
      });
      const cache = createFakeCache();
      const cachedMethods = createCachedMethods(cache);

      await cachedMethods.bulkUpdateGroups(
        { _id: group._id },
        { $set: { memberIds: ['bulk-ext-new'] } },
      );

      expect(cache.clear).toHaveBeenCalledTimes(1);
    });

    it('invalidates previous and new members when memberIds are replaced by id', async () => {
      const user = await createTestUser({ idOnTheSource: 'upd-ext-old' });
      const group = await Group.create({
        name: 'Update Team',
        source: 'entra',
        idOnTheSource: 'upd-grp-1',
        memberIds: ['upd-ext-old'],
      });
      const cache = createFakeCache();
      const cachedMethods = createCachedMethods(cache);
      const params = {
        userId: user._id.toString(),
        role: SystemRoles.USER,
        idOnTheSource: 'upd-ext-old',
      };

      expect(groupPrincipalIds(await cachedMethods.getUserPrincipals(params))).toEqual([
        group._id.toString(),
      ]);

      await cachedMethods.updateGroupById(group._id, { memberIds: ['upd-ext-new'] });

      expect(cache.delete).toHaveBeenCalledWith('upd-ext-old');
      expect(cache.delete).toHaveBeenCalledWith('upd-ext-new');
      expect(groupPrincipalIds(await cachedMethods.getUserPrincipals(params))).toEqual([]);
    });

    it('ignores cached entries with invalid shapes and rebuilds them', async () => {
      const user = await createTestUser({ idOnTheSource: 'shape-ext-1' });
      const group = await Group.create({
        name: 'Shape Team',
        source: 'entra',
        idOnTheSource: 'shape-grp-1',
        memberIds: ['shape-ext-1'],
      });
      const cache = createFakeCache();
      cache.store.set('shape-ext-1', ['not-an-object-id']);
      const cachedMethods = createCachedMethods(cache);

      const principals = await cachedMethods.getUserPrincipals({
        userId: user._id.toString(),
        role: SystemRoles.USER,
        idOnTheSource: 'shape-ext-1',
      });

      expect(groupPrincipalIds(principals)).toEqual([group._id.toString()]);
      expect(cache.set).toHaveBeenCalledWith('shape-ext-1', [group._id.toString()]);
    });

    it('deduplicates concurrent cache builds for the same member key', async () => {
      const user = await createTestUser({ idOnTheSource: 'dedup-ext-1' });
      const cache = createFakeCache({ onRead: arrivalBarrier(3) });
      const cachedMethods = createCachedMethods(cache);
      const params = {
        userId: user._id.toString(),
        role: SystemRoles.USER,
        idOnTheSource: 'dedup-ext-1',
      };

      const [first, second, third] = await Promise.all([
        cachedMethods.getUserPrincipals(params),
        cachedMethods.getUserPrincipals(params),
        cachedMethods.getUserPrincipals(params),
      ]);

      expect(first).toEqual(second);
      expect(second).toEqual(third);
      expect(cache.get).toHaveBeenCalledTimes(3);
      expect(cache.set).toHaveBeenCalledTimes(1);
    });

    it('shares one lock and DB build across concurrent same-process callers', async () => {
      const user = await createTestUser({ idOnTheSource: 'lock-ext-1' });
      const cache = {
        ...createFakeCache({ onRead: arrivalBarrier(3) }),
        acquireLock: jest.fn(async () => 'lock-token'),
        releaseLock: jest.fn(async () => undefined),
        lockWaitMs: 5000,
      };
      const cachedMethods = createUserGroupMethods(mongoose, { getCache: jest.fn(() => cache) });
      const params = {
        userId: user._id.toString(),
        role: SystemRoles.USER,
        idOnTheSource: 'lock-ext-1',
      };

      const [first, second, third] = await Promise.all([
        cachedMethods.getUserPrincipals(params),
        cachedMethods.getUserPrincipals(params),
        cachedMethods.getUserPrincipals(params),
      ]);

      expect(first).toEqual(second);
      expect(second).toEqual(third);
      expect(cache.acquireLock).toHaveBeenCalledTimes(1);
      expect(cache.acquireLock).toHaveBeenCalledWith('USER_PRINCIPALS_LOCK:lock-ext-1');
      expect(cache.set).toHaveBeenCalledTimes(1);
      expect(cache.releaseLock).toHaveBeenCalledTimes(1);
    });

    it('waits for a locked build from another process instead of querying', async () => {
      const user = await createTestUser({ idOnTheSource: 'wait-ext-1' });
      const groupId = new Types.ObjectId();
      const cache = {
        get: jest.fn().mockResolvedValueOnce(undefined).mockResolvedValue([groupId.toString()]),
        set: jest.fn(async () => undefined),
        acquireLock: jest.fn(async () => null),
        releaseLock: jest.fn(async () => undefined),
        lockWaitMs: 5000,
      };
      const cachedMethods = createUserGroupMethods(mongoose, { getCache: jest.fn(() => cache) });

      const principals = await cachedMethods.getUserPrincipals({
        userId: user._id.toString(),
        role: SystemRoles.USER,
        idOnTheSource: 'wait-ext-1',
      });

      expect(groupPrincipalIds(principals)).toEqual([groupId.toString()]);
      expect(cache.acquireLock).toHaveBeenCalledTimes(1);
      expect(cache.set).not.toHaveBeenCalled();
      expect(cache.releaseLock).not.toHaveBeenCalled();
    });

    it('builds immediately when lock acquisition fails', async () => {
      const user = await createTestUser({ idOnTheSource: 'fail-ext-1' });
      const cache = {
        get: jest.fn(async () => undefined),
        set: jest.fn(async () => undefined),
        acquireLock: jest.fn(async () => {
          throw new Error('redis unavailable');
        }),
        releaseLock: jest.fn(async () => undefined),
        lockWaitMs: 5000,
      };
      const cachedMethods = createUserGroupMethods(mongoose, { getCache: jest.fn(() => cache) });

      const principals = await cachedMethods.getUserPrincipals({
        userId: user._id.toString(),
        idOnTheSource: 'fail-ext-1',
      });

      expect(principals).toContainEqual({
        principalType: PrincipalType.ROLE,
        principalId: SystemRoles.USER,
      });
      expect(cache.set).toHaveBeenCalledTimes(1);
      expect(cache.releaseLock).not.toHaveBeenCalled();
    });

    it('skips the cache write when the entry is invalidated mid-build', async () => {
      const user = await createTestUser({ idOnTheSource: 'stale-ext-1' });
      const group = await Group.create({
        name: 'Stale Team',
        source: 'entra',
        idOnTheSource: 'stale-grp-1',
        memberIds: [],
      });
      const cache = createFakeCache();
      let openLockGate: (() => void) | undefined;
      const lockGate = new Promise<void>((resolve) => {
        openLockGate = resolve;
      });
      const lockedCache = Object.assign(cache, {
        acquireLock: jest.fn(async () => {
          await lockGate;
          return 'lock-token';
        }),
        releaseLock: jest.fn(async () => undefined),
        lockWaitMs: 1000,
      });
      const cachedMethods = createUserGroupMethods(mongoose, {
        getCache: jest.fn(() => lockedCache),
      });
      const params = {
        userId: user._id.toString(),
        role: SystemRoles.USER,
        idOnTheSource: 'stale-ext-1',
      };

      const pendingRead = cachedMethods.getUserPrincipals(params);
      await new Promise((resolve) => setTimeout(resolve, 10));
      /** Mutation lands while the pending build is parked on the lock */
      await cachedMethods.addUserToGroup(user._id, group._id);
      openLockGate!();
      const principals = await pendingRead;

      expect(groupPrincipalIds(principals)).toEqual([group._id.toString()]);
      expect(cache.set).not.toHaveBeenCalled();
      expect(cache.store.has('stale-ext-1')).toBe(false);

      const fresh = await cachedMethods.getUserPrincipals(params);
      expect(groupPrincipalIds(fresh)).toEqual([group._id.toString()]);
      expect(cache.set).toHaveBeenCalledTimes(1);
    });

    it('starts a fresh build for reads after invalidation instead of joining a stale one', async () => {
      const user = await createTestUser({ idOnTheSource: 'rejoin-ext-1' });
      const group = await Group.create({
        name: 'Rejoin Team',
        source: 'entra',
        idOnTheSource: 'rejoin-grp-1',
        memberIds: [],
      });
      const cache = createFakeCache();
      let openReleaseGate: (() => void) | undefined;
      const releaseGate = new Promise<void>((resolve) => {
        openReleaseGate = resolve;
      });
      const lockedCache = Object.assign(cache, {
        acquireLock: jest.fn(async () => 'lock-token'),
        releaseLock: jest
          .fn(async () => undefined)
          .mockImplementationOnce(async () => {
            await releaseGate;
          }),
        lockWaitMs: 1000,
      });
      const cachedMethods = createUserGroupMethods(mongoose, {
        getCache: jest.fn(() => lockedCache),
      });
      const params = {
        userId: user._id.toString(),
        role: SystemRoles.USER,
        idOnTheSource: 'rejoin-ext-1',
      };

      /** First read finishes its DB work but stays unsettled, parked on releaseLock */
      const parkedRead = cachedMethods.getUserPrincipals(params);
      await new Promise((resolve) => setTimeout(resolve, 25));
      await cachedMethods.addUserToGroup(user._id, group._id);

      /** A read issued after the mutation must not join the parked pre-mutation build */
      const freshRead = await cachedMethods.getUserPrincipals(params);
      expect(groupPrincipalIds(freshRead)).toEqual([group._id.toString()]);

      openReleaseGate!();
      expect(groupPrincipalIds(await parkedRead)).toEqual([]);
    });

    it('defers invalidation for transactional writes until the session commits', async () => {
      const user = await createTestUser({ idOnTheSource: 'txn-ext-1' });
      const group = await Group.create({
        name: 'Transactional Team',
        source: 'entra',
        idOnTheSource: 'txn-grp-1',
        memberIds: [],
      });
      const cache = createFakeCache();
      const cachedMethods = createCachedMethods(cache);
      const params = {
        userId: user._id.toString(),
        role: SystemRoles.USER,
        idOnTheSource: 'txn-ext-1',
      };

      expect(groupPrincipalIds(await cachedMethods.getUserPrincipals(params))).toEqual([]);

      const session = await mongoose.startSession();
      session.startTransaction();
      await cachedMethods.addUserToGroup(user._id, group._id, session);

      /** Mid-transaction: no invalidation, reads keep the pre-commit membership */
      expect(cache.delete).not.toHaveBeenCalled();
      expect(groupPrincipalIds(await cachedMethods.getUserPrincipals(params))).toEqual([]);

      await session.commitTransaction();

      expect(cache.delete).toHaveBeenCalledWith('txn-ext-1');
      expect(groupPrincipalIds(await cachedMethods.getUserPrincipals(params))).toEqual([
        group._id.toString(),
      ]);
      await session.endSession();
    });

    it('caches and invalidates under tenant-scoped keys within a tenant context', async () => {
      const user = await createTestUser({ idOnTheSource: 'tenant-ext-1' });
      const group = await Group.create({
        name: 'Tenant Team',
        source: 'entra',
        idOnTheSource: 'tenant-grp-1',
        memberIds: ['tenant-ext-1'],
      });
      const cache = createFakeCache();
      const cachedMethods = createCachedMethods(cache);
      const params = {
        userId: user._id.toString(),
        role: SystemRoles.USER,
        idOnTheSource: 'tenant-ext-1',
      };

      await tenantStorage.run({ tenantId: 'tenant-a' }, async () => {
        expect(groupPrincipalIds(await cachedMethods.getUserPrincipals(params))).toEqual([
          group._id.toString(),
        ]);
      });
      expect(cache.store.has('tenant-ext-1:tenant-a')).toBe(true);

      await tenantStorage.run({ tenantId: 'tenant-a' }, async () => {
        await cachedMethods.removeUserFromGroup(user._id, group._id);
      });
      expect(cache.store.has('tenant-ext-1:tenant-a')).toBe(false);
      expect(cache.delete).toHaveBeenCalledWith('tenant-ext-1:tenant-a');
      expect(cache.delete).toHaveBeenCalledWith('tenant-ext-1');
    });

    it('keeps tenant scoping for invalidations deferred past the transaction', async () => {
      const user = await createTestUser({ idOnTheSource: 'txn-tenant-ext-1' });
      const group = await Group.create({
        name: 'Tenant Transactional Team',
        source: 'entra',
        idOnTheSource: 'txn-tenant-grp-1',
        memberIds: [],
      });
      const cache = createFakeCache();
      const cachedMethods = createCachedMethods(cache);

      let session!: mongoose.ClientSession;
      await tenantStorage.run({ tenantId: 'tenant-b' }, async () => {
        session = await mongoose.startSession();
        session.startTransaction();
        await cachedMethods.addUserToGroup(user._id, group._id, session);
      });
      expect(cache.delete).not.toHaveBeenCalled();

      /** Commit runs outside the tenant context; the snapshot must preserve it */
      await session.commitTransaction();

      expect(cache.delete).toHaveBeenCalledWith('txn-tenant-ext-1:tenant-b');
      expect(cache.delete).toHaveBeenCalledWith('txn-tenant-ext-1');
      await session.endSession();
    });

    it('runs a delayed second invalidation to evict cross-process stale rewrites', async () => {
      const user = await createTestUser({ idOnTheSource: 'second-ext-1' });
      const group = await Group.create({
        name: 'Second Pass Team',
        source: 'entra',
        idOnTheSource: 'second-grp-1',
        memberIds: [],
      });
      const cache = createFakeCache();
      const lockedCache = Object.assign(cache, {
        crossProcess: true,
        acquireLock: jest.fn(async () => 'lock-token'),
        releaseLock: jest.fn(async () => undefined),
        lockWaitMs: 0,
        staleEvictionDelayMs: 200,
      });
      const cachedMethods = createUserGroupMethods(mongoose, {
        getCache: jest.fn(() => lockedCache),
      });
      const params = {
        userId: user._id.toString(),
        role: SystemRoles.USER,
        idOnTheSource: 'second-ext-1',
      };

      await cachedMethods.addUserToGroup(user._id, group._id);
      expect(cache.delete).toHaveBeenCalledTimes(1);

      /** Another container re-caches pre-mutation memberships after the first delete */
      cache.store.set('second-ext-1', []);
      await new Promise((resolve) => setTimeout(resolve, 700));

      expect(cache.store.has('second-ext-1')).toBe(false);
      expect(groupPrincipalIds(await cachedMethods.getUserPrincipals(params))).toEqual([
        group._id.toString(),
      ]);
    });

    it('runs the delayed second invalidation on cross-process stores without build locks', async () => {
      const user = await createTestUser({ idOnTheSource: 'nolock-ext-1' });
      await Group.create({
        name: 'No Lock Team',
        source: 'entra',
        idOnTheSource: 'nolock-grp-1',
        memberIds: ['nolock-ext-1'],
      });
      const cache = createFakeCache();
      const crossProcessCache = Object.assign(cache, {
        crossProcess: true,
        lockWaitMs: 0,
        staleEvictionDelayMs: 200,
      });
      const cachedMethods = createUserGroupMethods(mongoose, {
        getCache: jest.fn(() => crossProcessCache),
      });

      await cachedMethods.removeUserFromAllGroups(user._id.toString());
      expect(cache.delete).toHaveBeenCalledTimes(1);

      cache.store.set(user._id.toString(), []);
      await new Promise((resolve) => setTimeout(resolve, 700));

      expect(cache.store.has(user._id.toString())).toBe(false);
    });

    it('takes over the build when the lock frees without a cache fill', async () => {
      const user = await createTestUser({ idOnTheSource: 'takeover-ext-1' });
      const group = await Group.create({
        name: 'Takeover Team',
        source: 'entra',
        idOnTheSource: 'takeover-grp-1',
        memberIds: ['takeover-ext-1'],
      });
      const cache = createFakeCache();
      const lockedCache = Object.assign(cache, {
        crossProcess: true,
        acquireLock: jest
          .fn(async (): Promise<string | null> => 'lock-token')
          .mockResolvedValueOnce(null),
        releaseLock: jest.fn(async () => undefined),
        lockWaitMs: 5000,
      });
      const cachedMethods = createUserGroupMethods(mongoose, {
        getCache: jest.fn(() => lockedCache),
      });

      const startedAt = Date.now();
      const principals = await cachedMethods.getUserPrincipals({
        userId: user._id.toString(),
        role: SystemRoles.USER,
        idOnTheSource: 'takeover-ext-1',
      });

      /** The poller re-attempts the lock instead of sleeping out the 5s wait budget */
      expect(Date.now() - startedAt).toBeLessThan(1500);
      expect(groupPrincipalIds(principals)).toEqual([group._id.toString()]);
      expect(lockedCache.acquireLock).toHaveBeenCalledTimes(2);
      expect(lockedCache.releaseLock).toHaveBeenCalledWith(
        'USER_PRINCIPALS_LOCK:takeover-ext-1',
        'lock-token',
      );
    });

    it('reads cache builds from the primary, and uncached reads from the connection default', async () => {
      const user = await createTestUser({ idOnTheSource: 'primary-ext-1' });
      await Group.create({
        name: 'Primary Team',
        source: 'entra',
        idOnTheSource: 'primary-grp-1',
        memberIds: ['primary-ext-1'],
      });
      const cache = createFakeCache();
      const cachedMethods = createCachedMethods(cache);
      const params = {
        userId: user._id.toString(),
        role: SystemRoles.USER,
        idOnTheSource: 'primary-ext-1',
      };

      const readSpy = jest.spyOn(mongoose.Query.prototype, 'read');
      await cachedMethods.getUserPrincipals(params);
      expect(readSpy).toHaveBeenCalledWith('primary');

      readSpy.mockClear();
      await methods.getUserPrincipals(params);
      expect(readSpy).not.toHaveBeenCalledWith('primary');
      readSpy.mockRestore();
    });

    it('coalesces deferred invalidations into one session listener', async () => {
      const user = await createTestUser({ idOnTheSource: 'coalesce-ext-1' });
      const groups = await Group.create(
        Array.from({ length: 12 }, (_, index) => ({
          name: `Coalesce Team ${index}`,
          source: 'entra' as const,
          idOnTheSource: `coalesce-grp-${index}`,
          memberIds: [],
        })),
      );
      const cache = createFakeCache();
      const cachedMethods = createCachedMethods(cache);

      const session = await mongoose.startSession();
      session.startTransaction();
      const baseListenerCount = session.listenerCount('ended');
      for (const group of groups) {
        await cachedMethods.addUserToGroup(user._id, group._id, session);
      }
      expect(session.listenerCount('ended')).toBe(baseListenerCount + 1);
      expect(cache.delete).not.toHaveBeenCalled();

      await session.commitTransaction();
      await session.endSession();
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(cache.delete).toHaveBeenCalledWith('coalesce-ext-1');
      expect(cache.delete.mock.calls.length).toBeGreaterThanOrEqual(groups.length);
    });

    it('clears the cache for aggregation-pipeline bulk updates touching memberIds', async () => {
      await Group.create({
        name: 'Pipeline Team',
        source: 'entra',
        idOnTheSource: 'pipe-grp-1',
        memberIds: ['pipe-ext-1'],
      });
      const cache = createFakeCache();
      const cachedMethods = createCachedMethods(cache);
      const pipelineUpdate = [{ $set: { memberIds: ['pipe-ext-2'] } }] as unknown as Record<
        string,
        unknown
      >;

      await cachedMethods.bulkUpdateGroups({ idOnTheSource: 'pipe-grp-1' }, pipelineUpdate);

      expect(cache.clear).toHaveBeenCalledTimes(1);
    });

    it('skips the namespace clear for no-op bulk membership replacements', async () => {
      await Group.create({
        name: 'Noop Team',
        source: 'entra',
        idOnTheSource: 'noop-grp-1',
        memberIds: ['noop-ext-1'],
      });
      const cache = createFakeCache();
      const cachedMethods = createCachedMethods(cache);

      await cachedMethods.bulkUpdateGroups(
        { _id: new Types.ObjectId() },
        { $set: { memberIds: ['noop-ext-2'] } },
      );

      expect(cache.clear).not.toHaveBeenCalled();
      expect(cache.delete).not.toHaveBeenCalled();
    });
  });

  describe('syncUserEntraGroups', () => {
    it('creates new groups and adds user as member', async () => {
      const user = await createTestUser({ idOnTheSource: 'user-ext-1' });

      const { addedGroups, removedGroups } = await methods.syncUserEntraGroups(user._id, [
        { id: 'entra-g1', name: 'Entra Group 1' },
        { id: 'entra-g2', name: 'Entra Group 2', description: 'desc', email: 'g2@co.com' },
      ]);

      expect(addedGroups).toHaveLength(2);
      expect(removedGroups).toHaveLength(0);

      const groups = await Group.find({ source: 'entra' });
      expect(groups).toHaveLength(2);
      expect(groups.every((g) => g.memberIds!.includes('user-ext-1'))).toBe(true);
    });

    it('adds user to existing group they are not a member of', async () => {
      const user = await createTestUser({ idOnTheSource: 'user-ext-1' });
      await Group.create({
        name: 'Existing Entra Group',
        source: 'entra',
        idOnTheSource: 'entra-g1',
        memberIds: ['other-user'],
      });

      const { addedGroups } = await methods.syncUserEntraGroups(user._id, [
        { id: 'entra-g1', name: 'Existing Entra Group' },
      ]);

      expect(addedGroups).toHaveLength(1);
      const group = await Group.findOne({ idOnTheSource: 'entra-g1' });
      expect(group!.memberIds).toContain('user-ext-1');
      expect(group!.memberIds).toContain('other-user');
    });

    it('skips groups the user is already a member of', async () => {
      const user = await createTestUser({ idOnTheSource: 'user-ext-1' });
      await Group.create({
        name: 'Already Member',
        source: 'entra',
        idOnTheSource: 'entra-g1',
        memberIds: ['user-ext-1'],
      });

      const { addedGroups } = await methods.syncUserEntraGroups(user._id, [
        { id: 'entra-g1', name: 'Already Member' },
      ]);

      expect(addedGroups).toHaveLength(0);
    });

    it('removes user from stale entra groups', async () => {
      const user = await createTestUser({ idOnTheSource: 'user-ext-1' });
      await Group.create({
        name: 'Stale Group',
        source: 'entra',
        idOnTheSource: 'entra-stale',
        memberIds: ['user-ext-1'],
      });

      const { removedGroups } = await methods.syncUserEntraGroups(user._id, []);

      expect(removedGroups).toHaveLength(1);
      expect(removedGroups[0].name).toBe('Stale Group');
      const group = await Group.findOne({ idOnTheSource: 'entra-stale' });
      expect(group!.memberIds).not.toContain('user-ext-1');
    });

    it('handles add-and-remove in one sync call', async () => {
      const user = await createTestUser({ idOnTheSource: 'user-ext-1' });

      await Group.create({
        name: 'Keep Group',
        source: 'entra',
        idOnTheSource: 'entra-keep',
        memberIds: ['user-ext-1'],
      });
      await Group.create({
        name: 'Remove Group',
        source: 'entra',
        idOnTheSource: 'entra-remove',
        memberIds: ['user-ext-1'],
      });

      const { addedGroups, removedGroups } = await methods.syncUserEntraGroups(user._id, [
        { id: 'entra-keep', name: 'Keep Group' },
        { id: 'entra-new', name: 'New Group' },
      ]);

      expect(addedGroups).toHaveLength(1);
      expect(addedGroups[0].name).toBe('New Group');
      expect(removedGroups).toHaveLength(1);
      expect(removedGroups[0].name).toBe('Remove Group');
    });

    it('preserves local groups during entra sync', async () => {
      const user = await createTestUser({ idOnTheSource: 'user-ext-1' });
      await Group.create({
        name: 'Local Group',
        source: 'local',
        memberIds: ['user-ext-1'],
      });

      await methods.syncUserEntraGroups(user._id, []);

      const localGroup = await Group.findOne({ name: 'Local Group' });
      expect(localGroup!.memberIds).toContain('user-ext-1');
    });

    it('throws when user does not exist', async () => {
      await expect(
        methods.syncUserEntraGroups(new Types.ObjectId(), [{ id: 'g1', name: 'Group' }]),
      ).rejects.toThrow(/User not found/);
    });

    it('returns the updated user document', async () => {
      const user = await createTestUser({ idOnTheSource: 'user-ext-1' });
      const { user: updatedUser } = await methods.syncUserEntraGroups(user._id, []);
      expect((updatedUser._id as Types.ObjectId).toString()).toBe(user._id.toString());
    });
  });

  describe('calculateRelevanceScore', () => {
    it('returns 100 for exact match', () => {
      const score = methods.calculateRelevanceScore(
        { type: PrincipalType.USER, name: 'alice', source: 'local' },
        'alice',
      );
      expect(score).toBe(100);
    });

    it('returns 80 for starts-with match', () => {
      const score = methods.calculateRelevanceScore(
        { type: PrincipalType.USER, name: 'alice-smith', source: 'local' },
        'alice',
      );
      expect(score).toBe(80);
    });

    it('returns 50 for contains match', () => {
      const score = methods.calculateRelevanceScore(
        { type: PrincipalType.USER, name: 'bob-alice-jones', source: 'local' },
        'alice',
      );
      expect(score).toBe(50);
    });

    it('returns 10 (default) when no substring or exact match', () => {
      const score = methods.calculateRelevanceScore(
        { type: PrincipalType.USER, name: 'bob', source: 'local' },
        'zzz',
      );
      expect(score).toBe(10);
    });

    it('checks email and username for USER type', () => {
      const score = methods.calculateRelevanceScore(
        {
          type: PrincipalType.USER,
          name: 'other',
          email: 'alice@test.com',
          username: 'alice',
          source: 'local',
        },
        'alice',
      );
      expect(score).toBe(100);
    });

    it('checks description for GROUP type', () => {
      const score = methods.calculateRelevanceScore(
        {
          type: PrincipalType.GROUP,
          name: 'other',
          description: 'alice team',
          source: 'local',
        },
        'alice',
      );
      expect(score).toBe(80);
    });

    it('picks the highest score across multiple fields', () => {
      const score = methods.calculateRelevanceScore(
        {
          type: PrincipalType.USER,
          name: 'contains-alice-here',
          email: 'alice@test.com',
          source: 'local',
        },
        'alice',
      );
      expect(score).toBe(80);
    });

    it('does not treat regex metacharacters as wildcards', () => {
      const score = methods.calculateRelevanceScore(
        { type: PrincipalType.USER, name: 'xYz', source: 'local' },
        'x.z',
      );
      expect(score).toBe(10);
    });
  });

  describe('sortPrincipalsByRelevance', () => {
    it('sorts by score descending', () => {
      const items = [
        { type: PrincipalType.USER, name: 'low', _searchScore: 10 },
        { type: PrincipalType.USER, name: 'high', _searchScore: 100 },
        { type: PrincipalType.USER, name: 'mid', _searchScore: 50 },
      ];

      const sorted = methods.sortPrincipalsByRelevance(items);
      expect(sorted.map((i) => i._searchScore)).toEqual([100, 50, 10]);
    });

    it('prioritizes USER over GROUP at equal scores', () => {
      const items = [
        { type: PrincipalType.GROUP, name: 'group', _searchScore: 80 },
        { type: PrincipalType.USER, name: 'user', _searchScore: 80 },
      ];

      const sorted = methods.sortPrincipalsByRelevance(items);
      expect(sorted[0].type).toBe(PrincipalType.USER);
    });

    it('sorts alphabetically by name at equal scores and types', () => {
      const items = [
        { type: PrincipalType.USER, name: 'charlie', _searchScore: 80 },
        { type: PrincipalType.USER, name: 'alice', _searchScore: 80 },
        { type: PrincipalType.USER, name: 'bob', _searchScore: 80 },
      ];

      const sorted = methods.sortPrincipalsByRelevance(items);
      expect(sorted.map((i) => i.name)).toEqual(['alice', 'bob', 'charlie']);
    });

    it('handles missing _searchScore (falls back to 0)', () => {
      const items = [
        { type: PrincipalType.USER, name: 'a' },
        { type: PrincipalType.USER, name: 'b', _searchScore: 50 },
      ];

      const sorted = methods.sortPrincipalsByRelevance(items);
      expect(sorted[0]._searchScore).toBe(50);
    });

    it('uses email as fallback name for sorting', () => {
      const items = [
        { type: PrincipalType.USER, email: 'z@test.com', _searchScore: 80 },
        { type: PrincipalType.USER, email: 'a@test.com', _searchScore: 80 },
      ];

      const sorted = methods.sortPrincipalsByRelevance(items);
      expect(sorted[0].email).toBe('a@test.com');
    });
  });

  describe('searchPrincipals', () => {
    beforeEach(async () => {
      await User.create([
        {
          name: 'Alice Smith',
          email: 'alice@test.com',
          username: 'alice',
          password: 'password123',
          provider: 'local',
          role: SystemRoles.ADMIN,
        },
        {
          name: 'Bob Jones',
          email: 'bob@test.com',
          username: 'bob',
          password: 'password123',
          provider: 'local',
        },
      ]);
      await Group.create([
        { name: 'Alpha Team', source: 'local' },
        { name: 'Beta Team', source: 'local' },
      ]);
      await Role.create([{ name: 'admin' }, { name: 'moderator' }]);
    });

    it('returns empty array for empty search pattern', async () => {
      const results = await methods.searchPrincipals('');
      expect(results).toEqual([]);
    });

    it('returns empty array for whitespace-only pattern', async () => {
      const results = await methods.searchPrincipals('   ');
      expect(results).toEqual([]);
    });

    it('treats regex metacharacters as literal search text', async () => {
      await User.create({
        name: 'Literal .* User',
        email: 'literal-star@test.com',
        username: 'literal-star',
        password: 'password123',
        provider: 'local',
      });

      const results = await methods.searchPrincipals('.*', 10, [PrincipalType.USER]);

      expect(results).toHaveLength(1);
      expect(results[0].name).toBe('Literal .* User');
    });

    it('handles invalid regex syntax as literal search text', async () => {
      await User.create({
        name: 'Regex [invalid User',
        email: 'regex-invalid@test.com',
        username: 'regex-invalid',
        password: 'password123',
        provider: 'local',
      });

      const results = await methods.searchPrincipals('[invalid', 10, [PrincipalType.USER]);

      expect(results).toHaveLength(1);
      expect(results[0].name).toBe('Regex [invalid User');
    });

    it('finds matching users', async () => {
      const results = await methods.searchPrincipals('alice');
      const userResults = results.filter((r) => r.type === PrincipalType.USER);
      expect(userResults.length).toBeGreaterThanOrEqual(1);
      expect(userResults[0].name).toBe('Alice Smith');
      expect(userResults[0].isAdmin).toBe(true);
    });

    it('finds matching groups', async () => {
      const results = await methods.searchPrincipals('alpha');
      const groupResults = results.filter((r) => r.type === PrincipalType.GROUP);
      expect(groupResults.length).toBeGreaterThanOrEqual(1);
      expect(groupResults[0].name).toBe('Alpha Team');
    });

    it('finds matching roles', async () => {
      const results = await methods.searchPrincipals('admin');
      const roleResults = results.filter((r) => r.type === PrincipalType.ROLE);
      expect(roleResults.length).toBeGreaterThanOrEqual(1);
      expect(roleResults[0].name).toBe('admin');
    });

    it('filters by USER type only', async () => {
      const results = await methods.searchPrincipals('a', 10, [PrincipalType.USER]);
      expect(results.every((r) => r.type === PrincipalType.USER)).toBe(true);
    });

    it('filters by GROUP type only', async () => {
      const results = await methods.searchPrincipals('team', 10, [PrincipalType.GROUP]);
      expect(results.every((r) => r.type === PrincipalType.GROUP)).toBe(true);
      expect(results.length).toBeGreaterThanOrEqual(1);
    });

    it('filters by ROLE type only', async () => {
      const results = await methods.searchPrincipals('mod', 10, [PrincipalType.ROLE]);
      expect(results.every((r) => r.type === PrincipalType.ROLE)).toBe(true);
      expect(results.length).toBeGreaterThanOrEqual(1);
    });

    it('excludes users from a GROUP and ROLE filter', async () => {
      const results = await methods.searchPrincipals('a', 10, [
        PrincipalType.GROUP,
        PrincipalType.ROLE,
      ]);
      expect(new Set(results.map((r) => r.type))).toEqual(
        new Set([PrincipalType.GROUP, PrincipalType.ROLE]),
      );
    });

    it('returns no principals for an empty type filter', async () => {
      const results = await methods.searchPrincipals('a', 10, []);
      expect(results).toEqual([]);
    });

    it('respects limitPerType', async () => {
      const results = await methods.searchPrincipals('a', 1);
      const userResults = results.filter((r) => r.type === PrincipalType.USER);
      expect(userResults.length).toBeLessThanOrEqual(1);
    });

    it('returns combined results across types without filter', async () => {
      const results = await methods.searchPrincipals('a');
      const types = new Set(results.map((r) => r.type));
      expect(types.size).toBeGreaterThanOrEqual(2);
    });

    it('finds users by username', async () => {
      const results = await methods.searchPrincipals('alice', 10, [PrincipalType.USER]);
      expect(results.length).toBeGreaterThanOrEqual(1);
    });

    it('transforms user results to TPrincipalSearchResult format', async () => {
      const results = await methods.searchPrincipals('alice', 10, [PrincipalType.USER]);
      expect(results[0]).toEqual(
        expect.objectContaining({
          type: PrincipalType.USER,
          name: 'Alice Smith',
          source: 'local',
        }),
      );
      expect(results[0].id).toBeDefined();
    });

    it('transforms group results to TPrincipalSearchResult format', async () => {
      const results = await methods.searchPrincipals('alpha', 10, [PrincipalType.GROUP]);
      expect(results[0]).toEqual(
        expect.objectContaining({
          type: PrincipalType.GROUP,
          name: 'Alpha Team',
          source: 'local',
        }),
      );
      expect(results[0].id).toBeDefined();
      expect(results[0].memberCount).toBeDefined();
    });
  });

  describe('findGroupByQuery', () => {
    it('finds a group by custom filter', async () => {
      await Group.create({ name: 'Target', source: 'local', email: 'target@co.com' });
      const found = await methods.findGroupByQuery({ email: 'target@co.com' });
      expect(found).toBeTruthy();
      expect(found!.name).toBe('Target');
    });

    it('returns null when no match', async () => {
      const found = await methods.findGroupByQuery({ name: 'Nonexistent' });
      expect(found).toBeNull();
    });
  });

  describe('updateGroupById', () => {
    it('updates the group and returns the new document', async () => {
      const group = await Group.create({ name: 'Old Name', source: 'local' });
      const updated = await methods.updateGroupById(group._id, { name: 'New Name' });
      expect(updated!.name).toBe('New Name');
    });

    it('returns null when group does not exist', async () => {
      const updated = await methods.updateGroupById(new Types.ObjectId(), { name: 'X' });
      expect(updated).toBeNull();
    });
  });

  describe('bulkUpdateGroups', () => {
    it('updates all groups matching the filter', async () => {
      await Group.create([
        { name: 'Group A', source: 'entra', idOnTheSource: 'ext-a' },
        { name: 'Group B', source: 'entra', idOnTheSource: 'ext-b' },
        { name: 'Group C', source: 'local' },
      ]);

      const result = await methods.bulkUpdateGroups(
        { source: 'entra' },
        { $set: { description: 'synced' } },
      );

      expect(result.modifiedCount).toBe(2);
      const synced = await Group.find({ description: 'synced' });
      expect(synced).toHaveLength(2);
    });

    it('returns zero when no groups match', async () => {
      const result = await methods.bulkUpdateGroups(
        { source: 'entra' },
        { $set: { description: 'x' } },
      );
      expect(result.modifiedCount).toBe(0);
    });
  });
});
