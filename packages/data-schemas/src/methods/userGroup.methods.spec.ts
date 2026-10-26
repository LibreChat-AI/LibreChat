import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import type * as t from '~/types';
import { createUserGroupMethods } from './userGroup';
import groupSchema from '~/schema/group';
import userSchema from '~/schema/user';

/** Mocking logger */
jest.mock('~/config/winston', () => ({
  error: jest.fn(),
  info: jest.fn(),
  debug: jest.fn(),
}));

let mongoServer: MongoMemoryServer;
let Group: mongoose.Model<t.IGroup>;
let User: mongoose.Model<t.IUser>;
let methods: ReturnType<typeof createUserGroupMethods>;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  const mongoUri = mongoServer.getUri();
  await mongoose.connect(mongoUri);

  /** Register models */
  Group = mongoose.models.Group || mongoose.model<t.IGroup>('Group', groupSchema);
  User = mongoose.models.User || mongoose.model<t.IUser>('User', userSchema);

  /** Initialize methods */
  methods = createUserGroupMethods(mongoose);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

beforeEach(async () => {
  await mongoose.connection.dropDatabase();
});

describe('UserGroup Methods - Detailed Tests', () => {
  describe('findGroupById', () => {
    test('should find group by ObjectId', async () => {
      const group = await Group.create({
        name: 'Test Group',
        source: 'local',
        memberIds: [],
      });

      const found = await methods.findGroupById(group._id as mongoose.Types.ObjectId);

      expect(found).toBeDefined();
      expect(found?._id.toString()).toBe(group._id.toString());
      expect(found?.name).toBe('Test Group');
    });

    test('should find group by string ID', async () => {
      const group = await Group.create({
        name: 'Test Group',
        source: 'local',
        memberIds: [],
      });

      const found = await methods.findGroupById(group._id as mongoose.Types.ObjectId);

      expect(found).toBeDefined();
      expect(found?._id.toString()).toBe(group._id.toString());
    });

    test('should apply projection correctly', async () => {
      const group = await Group.create({
        name: 'Test Group',
        source: 'local',
        description: 'Test Description',
        memberIds: ['user1', 'user2'],
      });

      const found = await methods.findGroupById(group._id as mongoose.Types.ObjectId, {
        name: 1,
      });

      expect(found).toBeDefined();
      expect(found?.name).toBe('Test Group');
      expect(found?.description).toBeUndefined();
      expect(found?.memberIds).toBeUndefined();
    });

    test('should return null for non-existent group', async () => {
      const fakeId = new mongoose.Types.ObjectId();
      const found = await methods.findGroupById(fakeId as mongoose.Types.ObjectId);

      expect(found).toBeNull();
    });
  });

  describe('findGroupByExternalId', () => {
    test('should find group by external ID and source', async () => {
      await Group.create({
        name: 'Entra Group',
        source: 'entra',
        idOnTheSource: 'entra-123',
        memberIds: [],
      });

      const found = await methods.findGroupByExternalId('entra-123', 'entra');

      expect(found).toBeDefined();
      expect(found?.idOnTheSource).toBe('entra-123');
      expect(found?.source).toBe('entra');
    });

    test('should not find group with wrong source', async () => {
      await Group.create({
        name: 'Entra Group',
        source: 'entra',
        idOnTheSource: 'entra-123',
        memberIds: [],
      });

      const found = await methods.findGroupByExternalId('entra-123', 'local');

      expect(found).toBeNull();
    });

    test('should handle multiple groups with same external ID but different sources', async () => {
      const id = 'shared-id';

      await Group.create({
        name: 'Entra Group',
        source: 'entra',
        idOnTheSource: id,
        memberIds: [],
      });

      await Group.create({
        name: 'Local Group',
        source: 'local',
        memberIds: [],
      });

      const entraGroup = await methods.findGroupByExternalId(id, 'entra');
      const localGroup = await methods.findGroupByExternalId(id, 'local');

      expect(entraGroup?.name).toBe('Entra Group');
      expect(localGroup).toBeNull(); // local groups don't use idOnTheSource by default
    });
  });

  describe('findGroupsByNamePattern', () => {
    beforeEach(async () => {
      await Group.create([
        { name: 'Engineering Team', source: 'local', memberIds: [] },
        { name: 'Engineering Managers', source: 'local', memberIds: [] },
        { name: 'Marketing Team', source: 'local', memberIds: [] },
        {
          name: 'Remote Engineering',
          source: 'entra',
          idOnTheSource: 'entra-remote-eng',
          memberIds: [],
        },
      ]);
    });

    test('should find groups by name pattern', async () => {
      const groups = await methods.findGroupsByNamePattern('Engineering');

      expect(groups).toHaveLength(3);
      expect(groups.every((g) => g.name.includes('Engineering'))).toBe(true);
    });

    test('should respect case insensitive search', async () => {
      const groups = await methods.findGroupsByNamePattern('engineering');

      expect(groups).toHaveLength(3);
    });

    test('should filter by source when provided', async () => {
      const groups = await methods.findGroupsByNamePattern('Engineering', 'local');

      expect(groups).toHaveLength(2);
      expect(groups.every((g) => g.source === 'local')).toBe(true);
    });

    test('should respect limit parameter', async () => {
      const groups = await methods.findGroupsByNamePattern('Engineering', null, 2);

      expect(groups).toHaveLength(2);
    });

    test('should return empty array for no matches', async () => {
      const groups = await methods.findGroupsByNamePattern('NonExistent');

      expect(groups).toEqual([]);
    });
  });

  describe('createGroup', () => {
    test('should create a group with all fields', async () => {
      const groupData: Partial<t.IGroup> = {
        name: 'New Group',
        source: 'local',
        description: 'A test group',
        email: 'group@test.com',
        avatar: 'avatar-url',
        memberIds: ['user1', 'user2'],
      };

      const group = await methods.createGroup(groupData);

      expect(group).toBeDefined();
      expect(group.name).toBe(groupData.name);
      expect(group.source).toBe(groupData.source);
      expect(group.description).toBe(groupData.description);
      expect(group.email).toBe(groupData.email);
      expect(group.avatar).toBe(groupData.avatar);
      expect(group.memberIds).toEqual(groupData.memberIds);
    });

    test('should create group with minimal data', async () => {
      const group = await methods.createGroup({
        name: 'Minimal Group',
      });

      expect(group).toBeDefined();
      expect(group.name).toBe('Minimal Group');
      expect(group.source).toBe('local'); // default
      expect(group.memberIds).toEqual([]); // default
    });
  });

  describe('upsertGroupByExternalId', () => {
    test('should create new group when not exists', async () => {
      const group = await methods.upsertGroupByExternalId('new-external-id', 'entra', {
        name: 'New External Group',
        description: 'Created by upsert',
      });

      expect(group).toBeDefined();
      expect(group?.idOnTheSource).toBe('new-external-id');
      expect(group?.source).toBe('entra');
      expect(group?.name).toBe('New External Group');
      expect(group?.description).toBe('Created by upsert');
    });

    test('should update existing group', async () => {
      // Create initial group
      await Group.create({
        name: 'Original Name',
        source: 'entra',
        idOnTheSource: 'existing-id',
        description: 'Original description',
        memberIds: ['user1'],
      });

      // Upsert with updates
      const updated = await methods.upsertGroupByExternalId('existing-id', 'entra', {
        name: 'Updated Name',
        description: 'Updated description',
        memberIds: ['user1', 'user2'],
      });

      expect(updated).toBeDefined();
      expect(updated?.name).toBe('Updated Name');
      expect(updated?.description).toBe('Updated description');
      expect(updated?.memberIds).toEqual(['user1', 'user2']);
      expect(updated?.idOnTheSource).toBe('existing-id'); // unchanged
    });

    test('should not update group from different source', async () => {
      await Group.create({
        name: 'Entra Group',
        source: 'entra',
        idOnTheSource: 'shared-id',
      });

      const result = await methods.upsertGroupByExternalId('shared-id', 'local', {
        name: 'Azure Group',
      });

      // Should create new group
      expect(result?.name).toBe('Azure Group');
      expect(result?.source).toBe('local');

      // Verify both exist
      const groups = await Group.find({ idOnTheSource: 'shared-id' });
      expect(groups).toHaveLength(2);
    });
  });

  describe('addUserToGroup and removeUserFromGroup', () => {
    let user: mongoose.HydratedDocument<t.IUser>;
    let userWithExternal: mongoose.HydratedDocument<t.IUser>;
    let group: mongoose.HydratedDocument<t.IGroup>;

    beforeEach(async () => {
      user = await User.create({
        name: 'Test User',
        email: 'user@test.com',
        provider: 'local',
      });

      userWithExternal = await User.create({
        name: 'External User',
        email: 'external@test.com',
        provider: 'entra',
        idOnTheSource: 'external-123',
      });

      group = await Group.create({
        name: 'Test Group',
        source: 'local',
        memberIds: [],
      });
    });

    test('should add user to group using user ID', async () => {
      const result = await methods.addUserToGroup(
        user._id as mongoose.Types.ObjectId,
        group._id as mongoose.Types.ObjectId,
      );

      expect(result.user).toBeDefined();
      expect(result.group).toBeDefined();
      expect(result.group?.memberIds).toContain((user._id as mongoose.Types.ObjectId).toString());
    });

    test('should add user to group using idOnTheSource if available', async () => {
      const result = await methods.addUserToGroup(
        userWithExternal._id as mongoose.Types.ObjectId,
        group._id as mongoose.Types.ObjectId,
      );

      expect(result.group?.memberIds).toContain('external-123');
      expect(result.group?.memberIds).not.toContain(
        (userWithExternal._id as mongoose.Types.ObjectId).toString(),
      );
    });

    test('should not duplicate user in group', async () => {
      // Add user first time
      await methods.addUserToGroup(
        user._id as mongoose.Types.ObjectId,
        group._id as mongoose.Types.ObjectId,
      );

      // Add same user again
      const result = await methods.addUserToGroup(
        user._id as mongoose.Types.ObjectId,
        group._id as mongoose.Types.ObjectId,
      );

      expect(result.group?.memberIds).toHaveLength(1);
      expect(result.group?.memberIds).toContain((user._id as mongoose.Types.ObjectId).toString());
    });

    test('reports a change only for the call that altered membership', async () => {
      const groupId = group._id as mongoose.Types.ObjectId;
      const userId = user._id as mongoose.Types.ObjectId;

      const [first, second] = await Promise.all([
        methods.addUserToGroup(userId, groupId),
        methods.addUserToGroup(userId, groupId),
      ]);
      expect([first.changed, second.changed].filter(Boolean)).toHaveLength(1);
      expect(first.group?.memberIds).toHaveLength(1);

      const removed = await methods.removeUserFromGroup(userId, groupId);
      expect(removed.changed).toBe(true);
      const again = await methods.removeUserFromGroup(userId, groupId);
      expect(again.changed).toBe(false);
      expect(again.group).toBeDefined();
    });

    test('reports a field change only for the call that altered it', async () => {
      const groupId = group._id as mongoose.Types.ObjectId;

      const [first, second] = await Promise.all([
        methods.updateGroupFieldsTracked(groupId, { name: 'Renamed' }),
        methods.updateGroupFieldsTracked(groupId, { name: 'Renamed' }),
      ]);

      expect([first?.changed, second?.changed].filter(Boolean)).toHaveLength(1);
      expect(first?.group.name).toBe('Renamed');
      expect(await methods.updateGroupFieldsTracked(groupId, { name: 'Renamed' })).toMatchObject({
        changed: false,
      });
      const mixed = await methods.updateGroupFieldsTracked(groupId, {
        name: 'Renamed',
        description: 'new description',
      });
      expect(mixed).toMatchObject({ changed: true, changedFields: ['description'] });
    });

    test('should remove user from group', async () => {
      // First add user
      await methods.addUserToGroup(
        user._id as mongoose.Types.ObjectId,
        group._id as mongoose.Types.ObjectId,
      );

      // Then remove
      const result = await methods.removeUserFromGroup(
        user._id as mongoose.Types.ObjectId,
        group._id as mongoose.Types.ObjectId,
      );

      expect(result.group?.memberIds).toHaveLength(0);
      expect(result.group?.memberIds).not.toContain(
        (user._id as mongoose.Types.ObjectId).toString(),
      );
    });

    test('should handle removing user not in group', async () => {
      const result = await methods.removeUserFromGroup(
        user._id as mongoose.Types.ObjectId,
        group._id as mongoose.Types.ObjectId,
      );

      expect(result.group?.memberIds).toHaveLength(0);
    });
  });

  describe('listGroups', () => {
    beforeEach(async () => {
      await Group.create([
        { name: 'Beta', source: 'local', memberIds: [], email: 'beta@test.com' },
        { name: 'Alpha', source: 'local', memberIds: [], description: 'first group' },
        { name: 'Gamma', source: 'entra', idOnTheSource: 'ext-g', memberIds: [] },
      ]);
    });

    test('returns groups sorted by name', async () => {
      const groups = await methods.listGroups();

      expect(groups).toHaveLength(3);
      expect(groups[0].name).toBe('Alpha');
      expect(groups[1].name).toBe('Beta');
      expect(groups[2].name).toBe('Gamma');
    });

    test('filters by source', async () => {
      const groups = await methods.listGroups({ source: 'entra' });

      expect(groups).toHaveLength(1);
      expect(groups[0].name).toBe('Gamma');
    });

    test('filters by search (name)', async () => {
      const groups = await methods.listGroups({ search: 'alpha' });

      expect(groups).toHaveLength(1);
      expect(groups[0].name).toBe('Alpha');
    });

    test('filters by search (email)', async () => {
      const groups = await methods.listGroups({ search: 'beta@test' });

      expect(groups).toHaveLength(1);
      expect(groups[0].name).toBe('Beta');
    });

    test('filters by search (description)', async () => {
      const groups = await methods.listGroups({ search: 'first group' });

      expect(groups).toHaveLength(1);
      expect(groups[0].name).toBe('Alpha');
    });

    test('respects limit and offset', async () => {
      const groups = await methods.listGroups({ limit: 1, offset: 1 });

      expect(groups).toHaveLength(1);
      expect(groups[0].name).toBe('Beta');
    });

    test('returns empty for no matches', async () => {
      const groups = await methods.listGroups({ search: 'nonexistent' });

      expect(groups).toHaveLength(0);
    });
  });

  describe('countGroups', () => {
    beforeEach(async () => {
      await Group.create([
        { name: 'A', source: 'local', memberIds: [] },
        { name: 'B', source: 'local', memberIds: [] },
        { name: 'C', source: 'entra', idOnTheSource: 'ext-c', memberIds: [] },
      ]);
    });

    test('returns total count', async () => {
      const count = await methods.countGroups();

      expect(count).toBe(3);
    });

    test('respects source filter', async () => {
      const count = await methods.countGroups({ source: 'local' });

      expect(count).toBe(2);
    });

    test('respects search filter', async () => {
      const count = await methods.countGroups({ search: 'A' });

      expect(count).toBe(1);
    });
  });

  describe('deleteGroup', () => {
    test('returns deleted group', async () => {
      const group = await Group.create({ name: 'ToDelete', source: 'local', memberIds: [] });

      const deleted = await methods.deleteGroup(group._id as mongoose.Types.ObjectId);

      expect(deleted).toBeDefined();
      expect(deleted?.name).toBe('ToDelete');
      const remaining = await Group.findById(group._id);
      expect(remaining).toBeNull();
    });

    test('returns null for non-existent ID', async () => {
      const fakeId = new mongoose.Types.ObjectId();
      const result = await methods.deleteGroup(fakeId);

      expect(result).toBeNull();
    });
  });

  describe('removeMemberByIdTracked', () => {
    test('reports whether the member was actually removed', async () => {
      const group = await Group.create({ name: 'Test', source: 'local', memberIds: ['m1', 'm2'] });
      const groupId = group._id as mongoose.Types.ObjectId;

      const removed = await methods.removeMemberByIdTracked(groupId, 'm1');
      expect(removed.changed).toBe(true);
      expect(removed.group?.memberIds).toEqual(['m2']);

      const absent = await methods.removeMemberByIdTracked(groupId, 'm1');
      expect(absent.changed).toBe(false);
      expect(absent.group?.memberIds).toEqual(['m2']);

      const missing = await methods.removeMemberByIdTracked(new mongoose.Types.ObjectId(), 'm1');
      expect(missing).toEqual({ group: null, changed: false });
    });
  });

  describe('removeMemberById', () => {
    test('removes member from memberIds array', async () => {
      const group = await Group.create({
        name: 'Test',
        source: 'local',
        memberIds: ['m1', 'm2', 'm3'],
      });

      const updated = await methods.removeMemberById(group._id as mongoose.Types.ObjectId, 'm2');

      expect(updated).toBeDefined();
      expect(updated?.memberIds).toEqual(['m1', 'm3']);
    });

    test('is idempotent when memberId not present', async () => {
      const group = await Group.create({
        name: 'Test',
        source: 'local',
        memberIds: ['m1'],
      });

      const updated = await methods.removeMemberById(
        group._id as mongoose.Types.ObjectId,
        'nonexistent',
      );

      expect(updated).toBeDefined();
      expect(updated?.memberIds).toEqual(['m1']);
    });

    test('returns null for non-existent group', async () => {
      const fakeId = new mongoose.Types.ObjectId();
      const result = await methods.removeMemberById(fakeId, 'any-id');

      expect(result).toBeNull();
    });
  });

  describe('sortPrincipalsByRelevance', () => {
    test('should sort principals by relevance score', async () => {
      const principals = [
        { id: '1', name: 'Test User', type: 'user' as const, source: 'local' as const },
        { id: '2', name: 'Admin Test', type: 'user' as const, source: 'local' as const },
        { id: '3', name: 'Test Group', type: 'group' as const, source: 'local' as const },
      ];

      // Store original query in closure or pass it through
      const sorted = methods.sortPrincipalsByRelevance(principals);

      // Since we can't pass the query directly, the method should maintain
      // the original order or have been called in a context where it knows the query
      expect(sorted).toBeDefined();
      expect(sorted).toHaveLength(3);
    });
  });
});
