import mongoose from 'mongoose';
import { PrincipalType } from 'librechat-data-provider';
import { MongoMemoryServer } from 'mongodb-memory-server';
import type * as t from '~/types';
import { createUserGroupMethods } from './userGroup';
import groupSchema from '~/schema/group';
import userSchema from '~/schema/user';
import roleSchema from '~/schema/role';

/** Mocking logger */
jest.mock('~/config/winston', () => ({
  error: jest.fn(),
  info: jest.fn(),
  debug: jest.fn(),
}));

let mongoServer: MongoMemoryServer;
let Group: mongoose.Model<t.IGroup>;
let User: mongoose.Model<t.IUser>;
let Role: mongoose.Model<t.IRole>;
let methods: ReturnType<typeof createUserGroupMethods>;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  const mongoUri = mongoServer.getUri();
  await mongoose.connect(mongoUri);

  /** Register models */
  Group = mongoose.models.Group || mongoose.model<t.IGroup>('Group', groupSchema);
  User = mongoose.models.User || mongoose.model<t.IUser>('User', userSchema);
  Role = mongoose.models.Role || mongoose.model<t.IRole>('Role', roleSchema);

  /** Initialize methods */
  methods = createUserGroupMethods(mongoose);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer?.stop();
});

beforeEach(async () => {
  await mongoose.connection.dropDatabase();
});

describe('Role-based Permissions Integration', () => {
  describe('getUserPrincipals with roles', () => {
    test('should include role principal for user with role', async () => {
      const adminUser = await User.create({
        name: 'Admin User',
        email: 'admin@test.com',
        provider: 'local',
        role: 'admin',
      });

      const principals = await methods.getUserPrincipals({
        userId: adminUser._id as mongoose.Types.ObjectId,
      });

      // Should have user, role, and public principals
      expect(principals).toHaveLength(3);

      const userPrincipal = principals.find((p) => p.principalType === PrincipalType.USER);
      const rolePrincipal = principals.find((p) => p.principalType === PrincipalType.ROLE);
      const publicPrincipal = principals.find((p) => p.principalType === PrincipalType.PUBLIC);

      expect(userPrincipal).toBeDefined();
      expect(userPrincipal?.principalId?.toString()).toBe(
        (adminUser._id as mongoose.Types.ObjectId).toString(),
      );

      expect(rolePrincipal).toBeDefined();
      expect(rolePrincipal?.principalType).toBe(PrincipalType.ROLE);
      expect(rolePrincipal?.principalId).toBe('admin');

      expect(publicPrincipal).toBeDefined();
      expect(publicPrincipal?.principalType).toBe(PrincipalType.PUBLIC);
      expect(publicPrincipal?.principalId).toBeUndefined();
    });

    test('should not include role principal for user without role', async () => {
      const regularUser = await User.create({
        name: 'Regular User',
        email: 'user@test.com',
        provider: 'local',
        role: null, // Explicitly set to null to override default
      });

      const principals = await methods.getUserPrincipals({
        userId: regularUser._id as mongoose.Types.ObjectId,
      });

      // Should only have user and public principals
      expect(principals).toHaveLength(2);

      const rolePrincipal = principals.find((p) => p.principalType === PrincipalType.ROLE);
      expect(rolePrincipal).toBeUndefined();
    });

    test('should include all principal types for user with role and groups', async () => {
      const user = await User.create({
        name: 'Complete User',
        email: 'complete@test.com',
        provider: 'local',
        role: 'moderator',
      });

      // Add user to groups
      const group1 = await Group.create({
        name: 'Group 1',
        source: 'local',
        memberIds: [(user._id as mongoose.Types.ObjectId).toString()],
      });

      const group2 = await Group.create({
        name: 'Group 2',
        source: 'local',
        memberIds: [(user._id as mongoose.Types.ObjectId).toString()],
      });

      const principals = await methods.getUserPrincipals({
        userId: user._id as mongoose.Types.ObjectId,
      });

      // Should have user, role, 2 groups, and public
      expect(principals).toHaveLength(5);

      const principalTypes = principals.map((p) => p.principalType);
      expect(principalTypes).toContain(PrincipalType.USER);
      expect(principalTypes).toContain(PrincipalType.ROLE);
      expect(principalTypes).toContain(PrincipalType.GROUP);
      expect(principalTypes).toContain(PrincipalType.PUBLIC);

      // Check role principal
      const rolePrincipal = principals.find((p) => p.principalType === PrincipalType.ROLE);
      expect(rolePrincipal?.principalId).toBe('moderator');

      // Check group principals
      const groupPrincipals = principals.filter((p) => p.principalType === PrincipalType.GROUP);
      expect(groupPrincipals).toHaveLength(2);
      const groupIds = groupPrincipals.map((p) => p.principalId?.toString());
      expect(groupIds).toContain(group1._id.toString());
      expect(groupIds).toContain(group2._id.toString());
    });

    test('should handle different role values', async () => {
      const testCases = [
        { role: 'admin', expected: 'admin' },
        { role: 'moderator', expected: 'moderator' },
        { role: 'editor', expected: 'editor' },
        { role: 'viewer', expected: 'viewer' },
        { role: 'custom_role', expected: 'custom_role' },
      ];

      for (const testCase of testCases) {
        const user = await User.create({
          name: `User with ${testCase.role}`,
          email: `${testCase.role}@test.com`,
          provider: 'local',
          role: testCase.role,
        });

        const principals = await methods.getUserPrincipals({
          userId: user._id as mongoose.Types.ObjectId,
        });
        const rolePrincipal = principals.find((p) => p.principalType === PrincipalType.ROLE);

        expect(rolePrincipal).toBeDefined();
        expect(rolePrincipal?.principalId).toBe(testCase.expected);
      }
    });
  });

  describe('searchPrincipals with role support', () => {
    beforeEach(async () => {
      // Create some roles in the database
      await Role.create([
        { name: 'admin', description: 'Administrator role' },
        { name: 'moderator', description: 'Moderator role' },
        { name: 'editor', description: 'Editor role' },
        { name: 'viewer', description: 'Viewer role' },
        { name: 'guest', description: 'Guest role' },
      ]);

      // Create some users
      await User.create([
        {
          name: 'Admin User',
          email: 'admin@test.com',
          username: 'adminuser',
          provider: 'local',
          role: 'admin',
        },
        {
          name: 'Moderator User',
          email: 'moderator@test.com',
          username: 'moduser',
          provider: 'local',
          role: 'moderator',
        },
      ]);

      // Create some groups
      await Group.create([
        {
          name: 'Admin Group',
          source: 'local',
          memberIds: [],
        },
        {
          name: 'Moderator Group',
          source: 'local',
          memberIds: [],
        },
      ]);
    });

    test('should search for roles when Role model exists', async () => {
      const results = await methods.searchPrincipals('admin');

      const roleResults = results.filter((r) => r.type === PrincipalType.ROLE);
      const userResults = results.filter((r) => r.type === PrincipalType.USER);
      const groupResults = results.filter((r) => r.type === PrincipalType.GROUP);

      // Should find the admin role
      expect(roleResults).toHaveLength(1);
      expect(roleResults[0].id).toBe('admin');
      expect(roleResults[0].name).toBe('admin');
      expect(roleResults[0].type).toBe(PrincipalType.ROLE);

      // Should also find admin user and group
      expect(userResults.some((u) => u.name === 'Admin User')).toBe(true);
      expect(groupResults.some((g) => g.name === 'Admin Group')).toBe(true);
    });

    test('should filter search results by role type', async () => {
      const results = await methods.searchPrincipals('mod', 10, [PrincipalType.ROLE]);

      expect(results.every((r) => r.type === PrincipalType.ROLE)).toBe(true);
      expect(results).toHaveLength(1);
      expect(results[0].name).toBe('moderator');
    });

    test('should respect limit for role search', async () => {
      // Create many roles
      for (let i = 0; i < 10; i++) {
        await Role.create({ name: `testrole${i}` });
      }

      const results = await methods.searchPrincipals('testrole', 5, [PrincipalType.ROLE]);

      expect(results).toHaveLength(5);
      expect(results.every((r) => r.type === PrincipalType.ROLE)).toBe(true);
    });

    test('should search across all principal types', async () => {
      const results = await methods.searchPrincipals('mod');

      // Should find moderator role, user, and group
      const types = new Set(results.map((r) => r.type));
      expect(types.has(PrincipalType.ROLE)).toBe(true);
      expect(types.has(PrincipalType.USER)).toBe(true);
      expect(types.has(PrincipalType.GROUP)).toBe(true);

      // Check specific results
      expect(results.some((r) => r.type === PrincipalType.ROLE && r.name === 'moderator')).toBe(
        true,
      );
      expect(
        results.some((r) => r.type === PrincipalType.USER && r.name === 'Moderator User'),
      ).toBe(true);
      expect(
        results.some((r) => r.type === PrincipalType.GROUP && r.name === 'Moderator Group'),
      ).toBe(true);
    });

    test('should handle case-insensitive role search', async () => {
      const results = await methods.searchPrincipals('ADMIN', 10, [PrincipalType.ROLE]);

      expect(results).toHaveLength(1);
      expect(results[0].name).toBe('admin');
    });

    test('should return empty array for no role matches', async () => {
      const results = await methods.searchPrincipals('nonexistentrole', 10, [PrincipalType.ROLE]);

      expect(results).toEqual([]);
    });
  });

  describe('Role principals in complex scenarios', () => {
    test('should handle user role changes', async () => {
      const user = await User.create({
        name: 'Changing User',
        email: 'change@test.com',
        provider: 'local',
        role: 'viewer',
      });

      // Initial principals
      let principals = await methods.getUserPrincipals({
        userId: user._id as mongoose.Types.ObjectId,
      });
      let rolePrincipal = principals.find((p) => p.principalType === PrincipalType.ROLE);
      expect(rolePrincipal?.principalId).toBe('viewer');

      // Change role
      user.role = 'editor';
      await user.save();

      // Get principals again
      principals = await methods.getUserPrincipals({
        userId: user._id as mongoose.Types.ObjectId,
      });
      rolePrincipal = principals.find((p) => p.principalType === PrincipalType.ROLE);
      expect(rolePrincipal?.principalId).toBe('editor');
    });

    test('should handle user role removal', async () => {
      const user = await User.create({
        name: 'Demoted User',
        email: 'demoted@test.com',
        provider: 'local',
        role: 'admin',
      });

      // Initial check
      let principals = await methods.getUserPrincipals({
        userId: user._id as mongoose.Types.ObjectId,
      });
      expect(principals).toHaveLength(3); // user, role, public

      // Remove role
      user.role = undefined;
      await user.save();

      // Check again
      principals = await methods.getUserPrincipals({
        userId: user._id as mongoose.Types.ObjectId,
      });
      expect(principals).toHaveLength(2); // user, public
      const rolePrincipal = principals.find((p) => p.principalType === PrincipalType.ROLE);
      expect(rolePrincipal).toBeUndefined();
    });

    test('should handle empty or null role values', async () => {
      const testCases = [
        { role: '', expected: false },
        { role: null, expected: false },
        { role: undefined, expected: true, expectedRole: 'USER' }, // undefined gets default 'USER'
        { role: '   ', expected: false }, // whitespace-only is not a valid role
        { role: 'valid_role', expected: true, expectedRole: 'valid_role' },
      ];

      for (const testCase of testCases) {
        const userData: Partial<t.IUser> = {
          name: `User ${Math.random()}`,
          email: `test${Math.random()}@test.com`,
          provider: 'local',
        };

        // Only set role if it's not undefined (to test undefined case)
        if (testCase.role !== undefined) {
          userData.role = testCase.role as string;
        }

        const user = await User.create(userData);

        const principals = await methods.getUserPrincipals({
          userId: user._id as mongoose.Types.ObjectId,
        });
        const rolePrincipal = principals.find((p) => p.principalType === PrincipalType.ROLE);

        if (testCase.expected) {
          expect(rolePrincipal).toBeDefined();
          expect(rolePrincipal?.principalId).toBe(testCase.expectedRole || testCase.role);
        } else {
          expect(rolePrincipal).toBeUndefined();
        }
      }
    });
  });
});
