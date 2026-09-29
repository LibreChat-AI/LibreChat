import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import {
  ResourceType,
  PrincipalType,
  PrincipalModel,
  PermissionBits,
} from 'librechat-data-provider';
import type * as t from '~/types';
import { createAclEntryMethods, permissionBitSupersets } from './aclEntry';
import aclEntrySchema from '~/schema/aclEntry';

let mongoServer: MongoMemoryServer;
let AclEntry: mongoose.Model<t.IAclEntry>;
let methods: ReturnType<typeof createAclEntryMethods>;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  const mongoUri = mongoServer.getUri();
  AclEntry = mongoose.models.AclEntry || mongoose.model('AclEntry', aclEntrySchema);
  methods = createAclEntryMethods(mongoose);
  await mongoose.connect(mongoUri);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

beforeEach(async () => {
  await mongoose.connection.dropDatabase();
});

describe('AclEntry Model Tests', () => {
  /** Common test data */
  const userId = new mongoose.Types.ObjectId();
  const groupId = new mongoose.Types.ObjectId();
  const resourceId = new mongoose.Types.ObjectId();
  const grantedById = new mongoose.Types.ObjectId();

  describe('Permission Grant and Query', () => {
    test('should grant permission to a user', async () => {
      const entry = await methods.grantPermission(
        PrincipalType.USER,
        userId,
        ResourceType.AGENT,
        resourceId,
        PermissionBits.VIEW,
        grantedById,
      );

      expect(entry).toBeDefined();
      expect(entry?.principalType).toBe(PrincipalType.USER);
      expect(entry?.principalId?.toString()).toBe(userId.toString());
      expect(entry?.principalModel).toBe(PrincipalModel.USER);
      expect(entry?.resourceType).toBe(ResourceType.AGENT);
      expect(entry?.resourceId.toString()).toBe(resourceId.toString());
      expect(entry?.permBits).toBe(PermissionBits.VIEW);
      expect(entry?.grantedBy?.toString()).toBe(grantedById.toString());
      expect(entry?.grantedAt).toBeInstanceOf(Date);
    });

    test('should grant permission to a group', async () => {
      const entry = await methods.grantPermission(
        PrincipalType.GROUP,
        groupId,
        ResourceType.AGENT,
        resourceId,
        PermissionBits.VIEW | PermissionBits.EDIT,
        grantedById,
      );

      expect(entry).toBeDefined();
      expect(entry?.principalType).toBe(PrincipalType.GROUP);
      expect(entry?.principalId?.toString()).toBe(groupId.toString());
      expect(entry?.principalModel).toBe(PrincipalModel.GROUP);
      expect(entry?.permBits).toBe(PermissionBits.VIEW | PermissionBits.EDIT);
    });

    test('should grant public permission', async () => {
      const entry = await methods.grantPermission(
        PrincipalType.PUBLIC,
        null,
        ResourceType.AGENT,
        resourceId,
        PermissionBits.VIEW,
        grantedById,
      );

      expect(entry).toBeDefined();
      expect(entry?.principalType).toBe(PrincipalType.PUBLIC);
      expect(entry?.principalId).toBeUndefined();
      expect(entry?.principalModel).toBeUndefined();
    });

    test('should find entries by principal', async () => {
      /** Create two different permissions for the same user */
      await methods.grantPermission(
        PrincipalType.USER,
        userId,
        ResourceType.AGENT,
        resourceId,
        PermissionBits.VIEW,
        grantedById,
      );
      await methods.grantPermission(
        PrincipalType.USER,
        userId,
        'project',
        new mongoose.Types.ObjectId(),
        PermissionBits.EDIT,
        grantedById,
      );

      /** Find all entries for the user */
      const entries = await methods.findEntriesByPrincipal(PrincipalType.USER, userId);
      expect(entries).toHaveLength(2);

      /** Find entries filtered by resource type */
      const agentEntries = await methods.findEntriesByPrincipal(
        PrincipalType.USER,
        userId,
        ResourceType.AGENT,
      );
      expect(agentEntries).toHaveLength(1);
      expect(agentEntries[0].resourceType).toBe(ResourceType.AGENT);
    });

    test('should find entries by resource', async () => {
      /** Grant permissions to different principals for the same resource */
      await methods.grantPermission(
        PrincipalType.USER,
        userId,
        ResourceType.AGENT,
        resourceId,
        PermissionBits.VIEW,
        grantedById,
      );
      await methods.grantPermission(
        PrincipalType.GROUP,
        groupId,
        ResourceType.AGENT,
        resourceId,
        PermissionBits.EDIT,
        grantedById,
      );
      await methods.grantPermission(
        PrincipalType.PUBLIC,
        null,
        ResourceType.AGENT,
        resourceId,
        PermissionBits.VIEW,
        grantedById,
      );

      const entries = await methods.findEntriesByResource(ResourceType.AGENT, resourceId);
      expect(entries).toHaveLength(3);
    });
  });

  describe('Permission Checks', () => {
    beforeEach(async () => {
      /** Setup test data with various permissions */
      await methods.grantPermission(
        PrincipalType.USER,
        userId,
        ResourceType.AGENT,
        resourceId,
        PermissionBits.VIEW,
        grantedById,
      );
      await methods.grantPermission(
        PrincipalType.GROUP,
        groupId,
        ResourceType.AGENT,
        resourceId,
        PermissionBits.EDIT,
        grantedById,
      );

      const otherResourceId = new mongoose.Types.ObjectId();
      await methods.grantPermission(
        PrincipalType.PUBLIC,
        null,
        ResourceType.AGENT,
        otherResourceId,
        PermissionBits.VIEW,
        grantedById,
      );
    });

    test('should find entries by principals and resource', async () => {
      const principalsList = [
        { principalType: PrincipalType.USER, principalId: userId },
        { principalType: PrincipalType.GROUP, principalId: groupId },
      ];

      const entries = await methods.findEntriesByPrincipalsAndResource(
        principalsList,
        ResourceType.AGENT,
        resourceId,
      );
      expect(entries).toHaveLength(2);
    });

    test('should check if user has permission', async () => {
      const principalsList = [{ principalType: PrincipalType.USER, principalId: userId }];

      /** User has VIEW permission */
      const hasViewPermission = await methods.hasPermission(
        principalsList,
        ResourceType.AGENT,
        resourceId,
        PermissionBits.VIEW,
      );
      expect(hasViewPermission).toBe(true);

      /** User doesn't have EDIT permission */
      const hasEditPermission = await methods.hasPermission(
        principalsList,
        ResourceType.AGENT,
        resourceId,
        PermissionBits.EDIT,
      );
      expect(hasEditPermission).toBe(false);
    });

    test('should check if group has permission', async () => {
      const principalsList = [{ principalType: PrincipalType.GROUP, principalId: groupId }];

      /** Group has EDIT permission */
      const hasEditPermission = await methods.hasPermission(
        principalsList,
        ResourceType.AGENT,
        resourceId,
        PermissionBits.EDIT,
      );
      expect(hasEditPermission).toBe(true);
    });

    test('should check permission for multiple principals', async () => {
      const principalsList = [
        { principalType: PrincipalType.USER, principalId: userId },
        { principalType: PrincipalType.GROUP, principalId: groupId },
      ];

      /** User has VIEW and group has EDIT, together they should have both */
      const hasViewPermission = await methods.hasPermission(
        principalsList,
        ResourceType.AGENT,
        resourceId,
        PermissionBits.VIEW,
      );
      expect(hasViewPermission).toBe(true);

      const hasEditPermission = await methods.hasPermission(
        principalsList,
        ResourceType.AGENT,
        resourceId,
        PermissionBits.EDIT,
      );
      expect(hasEditPermission).toBe(true);

      /** Neither has DELETE permission */
      const hasDeletePermission = await methods.hasPermission(
        principalsList,
        ResourceType.AGENT,
        resourceId,
        PermissionBits.DELETE,
      );
      expect(hasDeletePermission).toBe(false);
    });

    test('should get effective permissions', async () => {
      const principalsList = [
        { principalType: PrincipalType.USER, principalId: userId },
        { principalType: PrincipalType.GROUP, principalId: groupId },
      ];

      const effective = await methods.getEffectivePermissions(
        principalsList,
        ResourceType.AGENT,
        resourceId,
      );

      /** Combined permissions should be VIEW | EDIT */
      expect(effective).toBe(PermissionBits.VIEW | PermissionBits.EDIT);
    });
  });

  describe('Permission Modification', () => {
    test('should revoke permission', async () => {
      /** Grant permission first */
      await methods.grantPermission(
        PrincipalType.USER,
        userId,
        ResourceType.AGENT,
        resourceId,
        PermissionBits.VIEW,
        grantedById,
      );

      /** Check it exists */
      const entriesBefore = await methods.findEntriesByPrincipal(PrincipalType.USER, userId);
      expect(entriesBefore).toHaveLength(1);

      /** Revoke it */
      const result = await methods.revokePermission(
        PrincipalType.USER,
        userId,
        ResourceType.AGENT,
        resourceId,
      );
      expect(result.deletedCount).toBe(1);

      /** Verify it's gone */
      const entriesAfter = await methods.findEntriesByPrincipal(PrincipalType.USER, userId);
      expect(entriesAfter).toHaveLength(0);
    });

    test('should modify permission bits - add permissions', async () => {
      /** Start with VIEW permission */
      await methods.grantPermission(
        PrincipalType.USER,
        userId,
        ResourceType.AGENT,
        resourceId,
        PermissionBits.VIEW,
        grantedById,
      );

      /** Add EDIT permission */
      const updated = await methods.modifyPermissionBits(
        PrincipalType.USER,
        userId,
        ResourceType.AGENT,
        resourceId,
        PermissionBits.EDIT,
        null,
      );

      expect(updated).toBeDefined();
      expect(updated?.permBits).toBe(PermissionBits.VIEW | PermissionBits.EDIT);
    });

    test('should modify permission bits - remove permissions', async () => {
      /** Start with VIEW | EDIT permissions */
      await methods.grantPermission(
        PrincipalType.USER,
        userId,
        ResourceType.AGENT,
        resourceId,
        PermissionBits.VIEW | PermissionBits.EDIT,
        grantedById,
      );

      /** Remove EDIT permission */
      const updated = await methods.modifyPermissionBits(
        PrincipalType.USER,
        userId,
        ResourceType.AGENT,
        resourceId,
        null,
        PermissionBits.EDIT,
      );

      expect(updated).toBeDefined();
      expect(updated?.permBits).toBe(PermissionBits.VIEW);
    });

    test('should modify permission bits - add and remove at once', async () => {
      /** Start with VIEW permission */
      await methods.grantPermission(
        PrincipalType.USER,
        userId,
        ResourceType.AGENT,
        resourceId,
        PermissionBits.VIEW,
        grantedById,
      );

      /** Add EDIT and remove VIEW in one operation */
      const updated = await methods.modifyPermissionBits(
        PrincipalType.USER,
        userId,
        ResourceType.AGENT,
        resourceId,
        PermissionBits.EDIT,
        PermissionBits.VIEW,
      );

      expect(updated).toBeDefined();
      expect(updated?.permBits).toBe(PermissionBits.EDIT);
    });
  });

  describe('String vs ObjectId Edge Cases', () => {
    test('should handle string userId in grantPermission', async () => {
      const userIdString = userId.toString();

      const entry = await methods.grantPermission(
        PrincipalType.USER,
        userIdString, // Pass string instead of ObjectId
        ResourceType.AGENT,
        resourceId,
        PermissionBits.VIEW,
        grantedById,
      );

      expect(entry).toBeDefined();
      expect(entry?.principalType).toBe(PrincipalType.USER);
      // Should be stored as ObjectId
      expect(entry?.principalId).toBeInstanceOf(mongoose.Types.ObjectId);
      expect(entry?.principalId?.toString()).toBe(userIdString);
    });

    test('should handle string groupId in grantPermission', async () => {
      const groupIdString = groupId.toString();

      const entry = await methods.grantPermission(
        PrincipalType.GROUP,
        groupIdString, // Pass string instead of ObjectId
        ResourceType.AGENT,
        resourceId,
        PermissionBits.VIEW,
        grantedById,
      );

      expect(entry).toBeDefined();
      expect(entry?.principalType).toBe(PrincipalType.GROUP);
      // Should be stored as ObjectId
      expect(entry?.principalId).toBeInstanceOf(mongoose.Types.ObjectId);
      expect(entry?.principalId?.toString()).toBe(groupIdString);
    });

    test('should handle string roleId in grantPermission for ROLE type', async () => {
      const roleString = 'admin';

      const entry = await methods.grantPermission(
        PrincipalType.ROLE,
        roleString,
        ResourceType.AGENT,
        resourceId,
        PermissionBits.VIEW,
        grantedById,
      );

      expect(entry).toBeDefined();
      expect(entry?.principalType).toBe(PrincipalType.ROLE);
      // Should remain as string for ROLE type
      expect(typeof entry?.principalId).toBe('string');
      expect(entry?.principalId).toBe(roleString);
      expect(entry?.principalModel).toBe(PrincipalModel.ROLE);
    });

    test('should handle string principalId in revokePermission', async () => {
      // First grant permission with ObjectId
      await methods.grantPermission(
        PrincipalType.USER,
        userId,
        ResourceType.AGENT,
        resourceId,
        PermissionBits.VIEW,
        grantedById,
      );

      // Then revoke with string ID
      const result = await methods.revokePermission(
        PrincipalType.USER,
        userId.toString(), // Pass string
        ResourceType.AGENT,
        resourceId,
      );

      expect(result.deletedCount).toBe(1);

      // Verify it's actually deleted
      const entries = await methods.findEntriesByPrincipal(PrincipalType.USER, userId);
      expect(entries).toHaveLength(0);
    });

    test('should handle string principalId in modifyPermissionBits', async () => {
      // First grant permission with ObjectId
      await methods.grantPermission(
        PrincipalType.USER,
        userId,
        ResourceType.AGENT,
        resourceId,
        PermissionBits.VIEW,
        grantedById,
      );

      // Then modify with string ID
      const updated = await methods.modifyPermissionBits(
        PrincipalType.USER,
        userId.toString(), // Pass string
        ResourceType.AGENT,
        resourceId,
        PermissionBits.EDIT,
        null,
      );

      expect(updated).toBeDefined();
      expect(updated?.permBits).toBe(PermissionBits.VIEW | PermissionBits.EDIT);
    });

    test('should handle mixed string and ObjectId in hasPermission', async () => {
      // Grant permission with string ID
      await methods.grantPermission(
        PrincipalType.USER,
        userId.toString(),
        ResourceType.AGENT,
        resourceId,
        PermissionBits.VIEW,
        grantedById,
      );

      // Check permission with ObjectId in principals list
      const hasPermWithObjectId = await methods.hasPermission(
        [{ principalType: PrincipalType.USER, principalId: userId }],
        ResourceType.AGENT,
        resourceId,
        PermissionBits.VIEW,
      );
      expect(hasPermWithObjectId).toBe(true);

      // Check permission with string in principals list
      const hasPermWithString = await methods.hasPermission(
        [{ principalType: PrincipalType.USER, principalId: userId.toString() }],
        ResourceType.AGENT,
        resourceId,
        PermissionBits.VIEW,
      );
      expect(hasPermWithString).toBe(false); // This should fail because hasPermission doesn't convert

      // Check with converted ObjectId
      const hasPermWithConvertedId = await methods.hasPermission(
        [
          {
            principalType: PrincipalType.USER,
            principalId: new mongoose.Types.ObjectId(userId.toString()),
          },
        ],
        ResourceType.AGENT,
        resourceId,
        PermissionBits.VIEW,
      );
      expect(hasPermWithConvertedId).toBe(true);
    });

    test('should update existing permission when granting with string ID', async () => {
      // First grant with ObjectId
      await methods.grantPermission(
        PrincipalType.USER,
        userId,
        ResourceType.AGENT,
        resourceId,
        PermissionBits.VIEW,
        grantedById,
      );

      // Grant again with string ID and different permissions
      const updated = await methods.grantPermission(
        PrincipalType.USER,
        userId.toString(),
        ResourceType.AGENT,
        resourceId,
        PermissionBits.VIEW | PermissionBits.EDIT | PermissionBits.DELETE,
        grantedById,
      );

      expect(updated).toBeDefined();
      expect(updated?.permBits).toBe(
        PermissionBits.VIEW | PermissionBits.EDIT | PermissionBits.DELETE,
      );

      // Should still only be one entry
      const entries = await methods.findEntriesByPrincipal(PrincipalType.USER, userId);
      expect(entries).toHaveLength(1);
    });
  });

  describe('Resource Access Queries', () => {
    test('should find accessible resources', async () => {
      /** Create multiple resources with different permissions */
      const resourceId1 = new mongoose.Types.ObjectId();
      const resourceId2 = new mongoose.Types.ObjectId();
      const resourceId3 = new mongoose.Types.ObjectId();

      /** User can view resource 1 */
      await methods.grantPermission(
        PrincipalType.USER,
        userId,
        ResourceType.AGENT,
        resourceId1,
        PermissionBits.VIEW,
        grantedById,
      );

      /** User can view and edit resource 2 */
      await methods.grantPermission(
        PrincipalType.USER,
        userId,
        ResourceType.AGENT,
        resourceId2,
        PermissionBits.VIEW | PermissionBits.EDIT,
        grantedById,
      );

      /** Group can view resource 3 */
      await methods.grantPermission(
        PrincipalType.GROUP,
        groupId,
        ResourceType.AGENT,
        resourceId3,
        PermissionBits.VIEW,
        grantedById,
      );

      /** Find resources with VIEW permission for user */
      const userViewableResources = await methods.findAccessibleResources(
        [{ principalType: PrincipalType.USER, principalId: userId }],
        ResourceType.AGENT,
        PermissionBits.VIEW,
      );

      expect(userViewableResources).toHaveLength(2);
      expect(userViewableResources.map((r) => r.toString()).sort()).toEqual(
        [resourceId1.toString(), resourceId2.toString()].sort(),
      );

      /** Find resources with VIEW permission for user or group */
      const allViewableResources = await methods.findAccessibleResources(
        [
          { principalType: PrincipalType.USER, principalId: userId },
          { principalType: PrincipalType.GROUP, principalId: groupId },
        ],
        ResourceType.AGENT,
        PermissionBits.VIEW,
      );

      expect(allViewableResources).toHaveLength(3);

      /** Find resources with EDIT permission for user */
      const editableResources = await methods.findAccessibleResources(
        [{ principalType: PrincipalType.USER, principalId: userId }],
        ResourceType.AGENT,
        PermissionBits.EDIT,
      );

      expect(editableResources).toHaveLength(1);
      expect(editableResources[0].toString()).toBe(resourceId2.toString());
    });

    test('should handle inherited permissions', async () => {
      const projectId = new mongoose.Types.ObjectId();
      const childResourceId = new mongoose.Types.ObjectId();

      /** Grant inherited permission on child resource */
      await AclEntry.create({
        principalType: PrincipalType.USER,
        principalId: userId,
        principalModel: PrincipalModel.USER,
        resourceType: ResourceType.AGENT,
        resourceId: childResourceId,
        permBits: PermissionBits.VIEW,
        grantedBy: grantedById,
        inheritedFrom: projectId,
      });

      /** Get effective permissions */
      const effective = await methods.getEffectivePermissions(
        [{ principalType: PrincipalType.USER, principalId: userId }],
        ResourceType.AGENT,
        childResourceId,
      );

      /** Should have VIEW permission from inherited entry */
      expect(effective).toBe(PermissionBits.VIEW);
    });
  });

  describe('Batch Permission Queries', () => {
    test('should get effective permissions for multiple resources in single query', async () => {
      const resource1 = new mongoose.Types.ObjectId();
      const resource2 = new mongoose.Types.ObjectId();
      const resource3 = new mongoose.Types.ObjectId();

      /** Grant different permissions to different resources */
      await methods.grantPermission(
        PrincipalType.USER,
        userId,
        ResourceType.MCPSERVER,
        resource1,
        PermissionBits.VIEW,
        grantedById,
      );

      await methods.grantPermission(
        PrincipalType.USER,
        userId,
        ResourceType.MCPSERVER,
        resource2,
        PermissionBits.VIEW | PermissionBits.EDIT,
        grantedById,
      );

      await methods.grantPermission(
        PrincipalType.GROUP,
        groupId,
        ResourceType.MCPSERVER,
        resource3,
        PermissionBits.DELETE,
        grantedById,
      );

      /** Get permissions for all resources */
      const permissionsMap = await methods.getEffectivePermissionsForResources(
        [{ principalType: PrincipalType.USER, principalId: userId }],
        ResourceType.MCPSERVER,
        [resource1, resource2, resource3],
      );

      expect(permissionsMap.size).toBe(2); // Only resource1 and resource2 for user
      expect(permissionsMap.get(resource1.toString())).toBe(PermissionBits.VIEW);
      expect(permissionsMap.get(resource2.toString())).toBe(
        PermissionBits.VIEW | PermissionBits.EDIT,
      );
      expect(permissionsMap.get(resource3.toString())).toBeUndefined(); // User has no access
    });

    test('should combine permissions from multiple principals in batch query', async () => {
      const resource1 = new mongoose.Types.ObjectId();
      const resource2 = new mongoose.Types.ObjectId();

      /** User has VIEW on both resources */
      await methods.grantPermission(
        PrincipalType.USER,
        userId,
        ResourceType.MCPSERVER,
        resource1,
        PermissionBits.VIEW,
        grantedById,
      );

      await methods.grantPermission(
        PrincipalType.USER,
        userId,
        ResourceType.MCPSERVER,
        resource2,
        PermissionBits.VIEW,
        grantedById,
      );

      /** Group has EDIT on resource1 */
      await methods.grantPermission(
        PrincipalType.GROUP,
        groupId,
        ResourceType.MCPSERVER,
        resource1,
        PermissionBits.EDIT,
        grantedById,
      );

      /** Get combined permissions for user + group */
      const permissionsMap = await methods.getEffectivePermissionsForResources(
        [
          { principalType: PrincipalType.USER, principalId: userId },
          { principalType: PrincipalType.GROUP, principalId: groupId },
        ],
        ResourceType.MCPSERVER,
        [resource1, resource2],
      );

      expect(permissionsMap.size).toBe(2);
      /** Resource1 should have VIEW | EDIT (from user + group) */
      expect(permissionsMap.get(resource1.toString())).toBe(
        PermissionBits.VIEW | PermissionBits.EDIT,
      );
      /** Resource2 should have only VIEW (from user) */
      expect(permissionsMap.get(resource2.toString())).toBe(PermissionBits.VIEW);
    });

    test('should handle empty resource list', async () => {
      const permissionsMap = await methods.getEffectivePermissionsForResources(
        [{ principalType: PrincipalType.USER, principalId: userId }],
        ResourceType.MCPSERVER,
        [],
      );

      expect(permissionsMap.size).toBe(0);
    });

    test('should handle resources with no permissions', async () => {
      const resource1 = new mongoose.Types.ObjectId();
      const resource2 = new mongoose.Types.ObjectId();

      /** Only grant permission to resource1 */
      await methods.grantPermission(
        PrincipalType.USER,
        userId,
        ResourceType.MCPSERVER,
        resource1,
        PermissionBits.VIEW,
        grantedById,
      );

      const permissionsMap = await methods.getEffectivePermissionsForResources(
        [{ principalType: PrincipalType.USER, principalId: userId }],
        ResourceType.MCPSERVER,
        [resource1, resource2], // resource2 has no permissions
      );

      expect(permissionsMap.size).toBe(1);
      expect(permissionsMap.get(resource1.toString())).toBe(PermissionBits.VIEW);
      expect(permissionsMap.get(resource2.toString())).toBeUndefined();
    });

    test('should include public permissions in batch query', async () => {
      const resource1 = new mongoose.Types.ObjectId();
      const resource2 = new mongoose.Types.ObjectId();

      /** User has VIEW on resource1 */
      await methods.grantPermission(
        PrincipalType.USER,
        userId,
        ResourceType.MCPSERVER,
        resource1,
        PermissionBits.VIEW | PermissionBits.EDIT,
        grantedById,
      );

      /** Public has VIEW on resource2 */
      await methods.grantPermission(
        PrincipalType.PUBLIC,
        null,
        ResourceType.MCPSERVER,
        resource2,
        PermissionBits.VIEW,
        grantedById,
      );

      /** Query with user + public principals */
      const permissionsMap = await methods.getEffectivePermissionsForResources(
        [
          { principalType: PrincipalType.USER, principalId: userId },
          { principalType: PrincipalType.PUBLIC },
        ],
        ResourceType.MCPSERVER,
        [resource1, resource2],
      );

      expect(permissionsMap.size).toBe(2);
      expect(permissionsMap.get(resource1.toString())).toBe(
        PermissionBits.VIEW | PermissionBits.EDIT,
      );
      expect(permissionsMap.get(resource2.toString())).toBe(PermissionBits.VIEW);
    });

    test('should handle large batch efficiently', async () => {
      /** Create 50 resources with various permissions */
      const resources = Array.from({ length: 50 }, () => new mongoose.Types.ObjectId());

      /** Grant permissions to first 30 resources */
      for (let i = 0; i < 30; i++) {
        await methods.grantPermission(
          PrincipalType.USER,
          userId,
          ResourceType.MCPSERVER,
          resources[i],
          PermissionBits.VIEW,
          grantedById,
        );
      }

      /** Grant group permissions to resources 20-40 (overlap with user) */
      for (let i = 20; i < 40; i++) {
        await methods.grantPermission(
          PrincipalType.GROUP,
          groupId,
          ResourceType.MCPSERVER,
          resources[i],
          PermissionBits.EDIT,
          grantedById,
        );
      }

      const startTime = Date.now();
      const permissionsMap = await methods.getEffectivePermissionsForResources(
        [
          { principalType: PrincipalType.USER, principalId: userId },
          { principalType: PrincipalType.GROUP, principalId: groupId },
        ],
        ResourceType.MCPSERVER,
        resources,
      );
      const duration = Date.now() - startTime;

      /** Should be reasonably fast (under 1 second for 50 resources) */
      expect(duration).toBeLessThan(1000);

      /** Verify results */
      expect(permissionsMap.size).toBe(40); // Resources 0-39 have permissions

      /** Resources 0-19: USER VIEW only */
      for (let i = 0; i < 20; i++) {
        expect(permissionsMap.get(resources[i].toString())).toBe(PermissionBits.VIEW);
      }

      /** Resources 20-29: USER VIEW | GROUP EDIT */
      for (let i = 20; i < 30; i++) {
        expect(permissionsMap.get(resources[i].toString())).toBe(
          PermissionBits.VIEW | PermissionBits.EDIT,
        );
      }

      /** Resources 30-39: GROUP EDIT only */
      for (let i = 30; i < 40; i++) {
        expect(permissionsMap.get(resources[i].toString())).toBe(PermissionBits.EDIT);
      }

      /** Resources 40-49: No permissions */
      for (let i = 40; i < 50; i++) {
        expect(permissionsMap.get(resources[i].toString())).toBeUndefined();
      }
    });

    test('should handle mixed ObjectId and string resource IDs', async () => {
      const resource1 = new mongoose.Types.ObjectId();
      const resource2 = new mongoose.Types.ObjectId();

      await methods.grantPermission(
        PrincipalType.USER,
        userId,
        ResourceType.MCPSERVER,
        resource1,
        PermissionBits.VIEW,
        grantedById,
      );

      await methods.grantPermission(
        PrincipalType.USER,
        userId,
        ResourceType.MCPSERVER,
        resource2,
        PermissionBits.EDIT,
        grantedById,
      );

      /** Pass mix of ObjectId and string */
      const permissionsMap = await methods.getEffectivePermissionsForResources(
        [{ principalType: PrincipalType.USER, principalId: userId }],
        ResourceType.MCPSERVER,
        [resource1, resource2.toString()], // Mix of ObjectId and string
      );

      expect(permissionsMap.size).toBe(2);
      expect(permissionsMap.get(resource1.toString())).toBe(PermissionBits.VIEW);
      expect(permissionsMap.get(resource2.toString())).toBe(PermissionBits.EDIT);
    });
  });

  describe('deleteAclEntries', () => {
    test('should delete entries matching the filter', async () => {
      await methods.grantPermission(
        PrincipalType.USER,
        userId,
        ResourceType.AGENT,
        resourceId,
        PermissionBits.VIEW,
        grantedById,
      );
      await methods.grantPermission(
        PrincipalType.USER,
        userId,
        ResourceType.MCPSERVER,
        resourceId,
        PermissionBits.EDIT,
        grantedById,
      );

      const result = await methods.deleteAclEntries({
        principalType: PrincipalType.USER,
        principalId: userId,
        resourceType: ResourceType.AGENT,
      });

      expect(result.deletedCount).toBe(1);
      const remaining = await AclEntry.countDocuments({ principalId: userId });
      expect(remaining).toBe(1);
    });

    test('should delete all entries when filter matches multiple', async () => {
      await methods.grantPermission(
        PrincipalType.USER,
        userId,
        ResourceType.AGENT,
        new mongoose.Types.ObjectId(),
        PermissionBits.VIEW,
        grantedById,
      );
      await methods.grantPermission(
        PrincipalType.USER,
        userId,
        ResourceType.AGENT,
        new mongoose.Types.ObjectId(),
        PermissionBits.EDIT,
        grantedById,
      );

      const result = await methods.deleteAclEntries({
        principalType: PrincipalType.USER,
        principalId: userId,
      });

      expect(result.deletedCount).toBe(2);
    });

    test('should return zero deletedCount when no match', async () => {
      const result = await methods.deleteAclEntries({
        principalId: new mongoose.Types.ObjectId(),
      });
      expect(result.deletedCount).toBe(0);
    });
  });

  describe('bulkWriteAclEntries', () => {
    test('should perform bulk inserts', async () => {
      const res1 = new mongoose.Types.ObjectId();
      const res2 = new mongoose.Types.ObjectId();

      const result = await methods.bulkWriteAclEntries([
        {
          insertOne: {
            document: {
              principalType: PrincipalType.USER,
              principalId: userId,
              principalModel: PrincipalModel.USER,
              resourceType: ResourceType.AGENT,
              resourceId: res1,
              permBits: PermissionBits.VIEW,
              grantedBy: grantedById,
              grantedAt: new Date(),
            },
          },
        },
        {
          insertOne: {
            document: {
              principalType: PrincipalType.USER,
              principalId: userId,
              principalModel: PrincipalModel.USER,
              resourceType: ResourceType.AGENT,
              resourceId: res2,
              permBits: PermissionBits.EDIT,
              grantedBy: grantedById,
              grantedAt: new Date(),
            },
          },
        },
      ]);

      expect(result.insertedCount).toBe(2);
      const entries = await AclEntry.countDocuments({ principalId: userId });
      expect(entries).toBe(2);
    });

    test('should perform bulk updates', async () => {
      await methods.grantPermission(
        PrincipalType.USER,
        userId,
        ResourceType.AGENT,
        resourceId,
        PermissionBits.VIEW,
        grantedById,
      );

      await methods.bulkWriteAclEntries([
        {
          updateOne: {
            filter: {
              principalType: PrincipalType.USER,
              principalId: userId,
              resourceId,
            },
            update: { $set: { permBits: PermissionBits.VIEW | PermissionBits.EDIT } },
          },
        },
      ]);

      const entry = await AclEntry.findOne({ principalId: userId, resourceId }).lean();
      expect(entry?.permBits).toBe(PermissionBits.VIEW | PermissionBits.EDIT);
    });
  });

  describe('findPublicResourceIds', () => {
    test('should find resources with public VIEW access', async () => {
      const publicRes1 = new mongoose.Types.ObjectId();
      const publicRes2 = new mongoose.Types.ObjectId();
      const privateRes = new mongoose.Types.ObjectId();

      await methods.grantPermission(
        PrincipalType.PUBLIC,
        null,
        ResourceType.AGENT,
        publicRes1,
        PermissionBits.VIEW,
        grantedById,
      );
      await methods.grantPermission(
        PrincipalType.PUBLIC,
        null,
        ResourceType.AGENT,
        publicRes2,
        PermissionBits.VIEW | PermissionBits.EDIT,
        grantedById,
      );
      await methods.grantPermission(
        PrincipalType.USER,
        userId,
        ResourceType.AGENT,
        privateRes,
        PermissionBits.VIEW,
        grantedById,
      );

      const publicIds = await methods.findPublicResourceIds(
        ResourceType.AGENT,
        PermissionBits.VIEW,
      );

      expect(publicIds).toHaveLength(2);
      const idStrings = publicIds.map((id) => id.toString()).sort();
      expect(idStrings).toEqual([publicRes1.toString(), publicRes2.toString()].sort());
    });

    test('should filter by required permission bits', async () => {
      const viewOnly = new mongoose.Types.ObjectId();
      const viewEdit = new mongoose.Types.ObjectId();

      await methods.grantPermission(
        PrincipalType.PUBLIC,
        null,
        ResourceType.AGENT,
        viewOnly,
        PermissionBits.VIEW,
        grantedById,
      );
      await methods.grantPermission(
        PrincipalType.PUBLIC,
        null,
        ResourceType.AGENT,
        viewEdit,
        PermissionBits.VIEW | PermissionBits.EDIT,
        grantedById,
      );

      const editableIds = await methods.findPublicResourceIds(
        ResourceType.AGENT,
        PermissionBits.EDIT,
      );

      expect(editableIds).toHaveLength(1);
      expect(editableIds[0].toString()).toBe(viewEdit.toString());
    });

    test('should return empty array when no public resources exist', async () => {
      const ids = await methods.findPublicResourceIds(ResourceType.AGENT, PermissionBits.VIEW);
      expect(ids).toEqual([]);
    });

    test('should filter by resource type', async () => {
      const agentRes = new mongoose.Types.ObjectId();
      const mcpRes = new mongoose.Types.ObjectId();

      await methods.grantPermission(
        PrincipalType.PUBLIC,
        null,
        ResourceType.AGENT,
        agentRes,
        PermissionBits.VIEW,
        grantedById,
      );
      await methods.grantPermission(
        PrincipalType.PUBLIC,
        null,
        ResourceType.MCPSERVER,
        mcpRes,
        PermissionBits.VIEW,
        grantedById,
      );

      const agentIds = await methods.findPublicResourceIds(ResourceType.AGENT, PermissionBits.VIEW);
      expect(agentIds).toHaveLength(1);
      expect(agentIds[0].toString()).toBe(agentRes.toString());
    });

    test('should have a public-principal compound index available for the planner', async () => {
      await AclEntry.syncIndexes();
      const indexes = await AclEntry.collection.indexes();
      const publicIndex = indexes.find(
        (idx) =>
          idx.key?.principalType === 1 &&
          idx.key?.resourceType === 1 &&
          idx.key?.permBits === 1 &&
          idx.key?.resourceId === 1,
      );
      expect(publicIndex).toBeDefined();

      await methods.grantPermission(
        PrincipalType.PUBLIC,
        null,
        ResourceType.AGENT,
        new mongoose.Types.ObjectId(),
        PermissionBits.VIEW,
        grantedById,
      );

      const explain = (await AclEntry.find({
        principalType: PrincipalType.PUBLIC,
        resourceType: ResourceType.AGENT,
        permBits: { $in: [PermissionBits.VIEW] },
      })
        .hint(publicIndex!.name as string)
        .explain('queryPlanner')) as unknown as {
        queryPlanner?: { winningPlan?: Record<string, unknown> };
      };

      const planString = JSON.stringify(explain?.queryPlanner?.winningPlan ?? {});
      expect(planString).toContain('IXSCAN');
      expect(planString).not.toContain('COLLSCAN');
    });
  });

  describe('aggregateAclEntries', () => {
    test('should run an aggregation pipeline and return results', async () => {
      await methods.grantPermission(
        PrincipalType.USER,
        userId,
        ResourceType.AGENT,
        resourceId,
        PermissionBits.VIEW,
        grantedById,
      );
      await methods.grantPermission(
        PrincipalType.GROUP,
        groupId,
        ResourceType.AGENT,
        resourceId,
        PermissionBits.EDIT,
        grantedById,
      );
      await methods.grantPermission(
        PrincipalType.USER,
        userId,
        ResourceType.MCPSERVER,
        new mongoose.Types.ObjectId(),
        PermissionBits.VIEW,
        grantedById,
      );

      const results = (await methods.aggregateAclEntries([
        { $group: { _id: '$resourceType', count: { $sum: 1 } } },
        { $sort: { _id: 1 } },
      ])) as Array<{ _id: string; count: number }>;

      expect(results).toHaveLength(2);
      const agentResult = results.find((r) => r._id === ResourceType.AGENT);
      expect(agentResult?.count).toBe(2);
    });

    test('should return empty array for non-matching pipeline', async () => {
      const results = await methods.aggregateAclEntries([
        { $match: { principalType: 'nonexistent' } },
      ]);
      expect(results).toEqual([]);
    });
  });

  /**
   * These cases exercise the application-layer bitwise filtering that replaced
   * the `$bitsAllSet` query operator (which is not supported by MongoDB forks
   * such as Azure Cosmos DB for MongoDB). They verify logical equivalence:
   * a query for bit B must match entries whose `permBits` are a superset of B,
   * and must not match subset or disjoint entries.
   */
  describe('Application-layer bitwise filtering (Cosmos DB compatibility)', () => {
    describe('hasPermission', () => {
      test('returns true when entry has exact required bit', async () => {
        await methods.grantPermission(
          PrincipalType.USER,
          userId,
          ResourceType.AGENT,
          resourceId,
          PermissionBits.VIEW,
          grantedById,
        );
        const result = await methods.hasPermission(
          [{ principalType: PrincipalType.USER, principalId: userId }],
          ResourceType.AGENT,
          resourceId,
          PermissionBits.VIEW,
        );
        expect(result).toBe(true);
      });

      test('returns true when entry has superset of required bits', async () => {
        await methods.grantPermission(
          PrincipalType.USER,
          userId,
          ResourceType.AGENT,
          resourceId,
          PermissionBits.VIEW | PermissionBits.EDIT | PermissionBits.DELETE,
          grantedById,
        );
        const result = await methods.hasPermission(
          [{ principalType: PrincipalType.USER, principalId: userId }],
          ResourceType.AGENT,
          resourceId,
          PermissionBits.VIEW | PermissionBits.EDIT,
        );
        expect(result).toBe(true);
      });

      test('returns false when entry has only subset of required bits', async () => {
        await methods.grantPermission(
          PrincipalType.USER,
          userId,
          ResourceType.AGENT,
          resourceId,
          PermissionBits.VIEW,
          grantedById,
        );
        const result = await methods.hasPermission(
          [{ principalType: PrincipalType.USER, principalId: userId }],
          ResourceType.AGENT,
          resourceId,
          PermissionBits.VIEW | PermissionBits.EDIT,
        );
        expect(result).toBe(false);
      });

      test('returns false when no entries match', async () => {
        const result = await methods.hasPermission(
          [{ principalType: PrincipalType.USER, principalId: userId }],
          ResourceType.AGENT,
          resourceId,
          PermissionBits.VIEW,
        );
        expect(result).toBe(false);
      });
    });

    describe('findAccessibleResources', () => {
      test('returns deduplicated resource IDs across multiple matching entries', async () => {
        const shared = new mongoose.Types.ObjectId();
        await methods.grantPermission(
          PrincipalType.USER,
          userId,
          ResourceType.AGENT,
          shared,
          PermissionBits.VIEW,
          grantedById,
        );
        await methods.grantPermission(
          PrincipalType.GROUP,
          groupId,
          ResourceType.AGENT,
          shared,
          PermissionBits.VIEW | PermissionBits.EDIT,
          grantedById,
        );

        const result = await methods.findAccessibleResources(
          [
            { principalType: PrincipalType.USER, principalId: userId },
            { principalType: PrincipalType.GROUP, principalId: groupId },
          ],
          ResourceType.AGENT,
          PermissionBits.VIEW,
        );
        expect(result).toHaveLength(1);
        expect(result[0].toString()).toBe(shared.toString());
      });

      test('excludes resources whose entries only hold subset bits', async () => {
        const viewOnly = new mongoose.Types.ObjectId();
        const viewEdit = new mongoose.Types.ObjectId();
        await methods.grantPermission(
          PrincipalType.USER,
          userId,
          ResourceType.AGENT,
          viewOnly,
          PermissionBits.VIEW,
          grantedById,
        );
        await methods.grantPermission(
          PrincipalType.USER,
          userId,
          ResourceType.AGENT,
          viewEdit,
          PermissionBits.VIEW | PermissionBits.EDIT,
          grantedById,
        );

        const result = await methods.findAccessibleResources(
          [{ principalType: PrincipalType.USER, principalId: userId }],
          ResourceType.AGENT,
          PermissionBits.EDIT,
        );
        expect(result).toHaveLength(1);
        expect(result[0].toString()).toBe(viewEdit.toString());
      });

      describe('resourceIds bound', () => {
        const otherResource = new mongoose.Types.ObjectId();
        beforeEach(async () => {
          await methods.grantPermission(
            PrincipalType.USER,
            userId,
            ResourceType.AGENT,
            resourceId,
            PermissionBits.VIEW,
            grantedById,
          );
          await methods.grantPermission(
            PrincipalType.USER,
            userId,
            ResourceType.AGENT,
            otherResource,
            PermissionBits.VIEW,
            grantedById,
          );
        });

        test('intersects access with the bound candidate ids only', async () => {
          const result = await methods.findAccessibleResources(
            [{ principalType: PrincipalType.USER, principalId: userId }],
            ResourceType.AGENT,
            PermissionBits.VIEW,
            [resourceId, new mongoose.Types.ObjectId()],
          );
          expect(result).toHaveLength(1);
          expect(result[0].toString()).toBe(resourceId.toString());
        });

        test('returns nothing when every accessible resource is outside the bound', async () => {
          const result = await methods.findAccessibleResources(
            [{ principalType: PrincipalType.USER, principalId: userId }],
            ResourceType.AGENT,
            PermissionBits.VIEW,
            [new mongoose.Types.ObjectId()],
          );
          expect(result).toHaveLength(0);
        });

        test('an empty bound matches nothing rather than lifting the filter', async () => {
          const result = await methods.findAccessibleResources(
            [{ principalType: PrincipalType.USER, principalId: userId }],
            ResourceType.AGENT,
            PermissionBits.VIEW,
            [],
          );
          expect(result).toHaveLength(0);
        });

        test('an unbound call still returns every accessible resource', async () => {
          const result = await methods.findAccessibleResources(
            [{ principalType: PrincipalType.USER, principalId: userId }],
            ResourceType.AGENT,
            PermissionBits.VIEW,
          );
          expect(result).toHaveLength(2);
        });
      });
    });

    describe('findPublicResourceIds', () => {
      test('returns the public resource ID when required bits are present', async () => {
        const shared = new mongoose.Types.ObjectId();
        await methods.grantPermission(
          PrincipalType.PUBLIC,
          null,
          ResourceType.AGENT,
          shared,
          PermissionBits.VIEW | PermissionBits.EDIT,
          grantedById,
        );

        const result = await methods.findPublicResourceIds(
          ResourceType.AGENT,
          PermissionBits.VIEW | PermissionBits.EDIT,
        );
        expect(result).toHaveLength(1);
        expect(result[0].toString()).toBe(shared.toString());
      });

      test('with resourceIds bound, intersects public access with the candidate ids', async () => {
        const shared = new mongoose.Types.ObjectId();
        const unreachable = new mongoose.Types.ObjectId();
        await methods.grantPermission(
          PrincipalType.PUBLIC,
          null,
          ResourceType.AGENT,
          shared,
          PermissionBits.VIEW,
          grantedById,
        );
        await methods.grantPermission(
          PrincipalType.PUBLIC,
          null,
          ResourceType.AGENT,
          unreachable,
          PermissionBits.VIEW,
          grantedById,
        );

        const result = await methods.findPublicResourceIds(
          ResourceType.AGENT,
          PermissionBits.VIEW,
          [shared, new mongoose.Types.ObjectId()],
        );
        expect(result).toHaveLength(1);
        expect(result[0].toString()).toBe(shared.toString());

        const emptyBound = await methods.findPublicResourceIds(
          ResourceType.AGENT,
          PermissionBits.VIEW,
          [],
        );
        expect(emptyBound).toHaveLength(0);
      });

      test('deduplicates when duplicate public entries exist for the same resource', async () => {
        /**
         * `grantPermission` upserts, so duplicates are not reachable through the
         * public API. Bypass it with `AclEntry.create` to confirm the
         * application-layer dedup logic handles the defensive case.
         */
        const shared = new mongoose.Types.ObjectId();
        await AclEntry.create([
          {
            principalType: PrincipalType.PUBLIC,
            resourceType: ResourceType.AGENT,
            resourceId: shared,
            permBits: PermissionBits.VIEW,
            grantedBy: grantedById,
          },
          {
            principalType: PrincipalType.PUBLIC,
            resourceType: ResourceType.AGENT,
            resourceId: shared,
            permBits: PermissionBits.VIEW | PermissionBits.EDIT,
            grantedBy: grantedById,
          },
        ]);

        const result = await methods.findPublicResourceIds(ResourceType.AGENT, PermissionBits.VIEW);
        expect(result).toHaveLength(1);
        expect(result[0].toString()).toBe(shared.toString());
      });
    });

    describe('getSoleOwnedResourceIds', () => {
      test('returns resources where the user is the only DELETE holder', async () => {
        const soleRes = new mongoose.Types.ObjectId();
        await methods.grantPermission(
          PrincipalType.USER,
          userId,
          ResourceType.AGENT,
          soleRes,
          PermissionBits.VIEW | PermissionBits.EDIT | PermissionBits.DELETE,
          grantedById,
        );

        const result = await methods.getSoleOwnedResourceIds(userId, ResourceType.AGENT);
        expect(result).toHaveLength(1);
        expect(result[0].toString()).toBe(soleRes.toString());
      });

      test('excludes resources where another principal also holds DELETE', async () => {
        const sharedRes = new mongoose.Types.ObjectId();
        await methods.grantPermission(
          PrincipalType.USER,
          userId,
          ResourceType.AGENT,
          sharedRes,
          PermissionBits.VIEW | PermissionBits.EDIT | PermissionBits.DELETE,
          grantedById,
        );
        await methods.grantPermission(
          PrincipalType.GROUP,
          groupId,
          ResourceType.AGENT,
          sharedRes,
          PermissionBits.VIEW | PermissionBits.EDIT | PermissionBits.DELETE,
          grantedById,
        );

        const result = await methods.getSoleOwnedResourceIds(userId, ResourceType.AGENT);
        expect(result).toHaveLength(0);
      });

      test('ignores other principals that lack the DELETE bit', async () => {
        const soleRes = new mongoose.Types.ObjectId();
        await methods.grantPermission(
          PrincipalType.USER,
          userId,
          ResourceType.AGENT,
          soleRes,
          PermissionBits.VIEW | PermissionBits.DELETE,
          grantedById,
        );
        await methods.grantPermission(
          PrincipalType.GROUP,
          groupId,
          ResourceType.AGENT,
          soleRes,
          PermissionBits.VIEW,
          grantedById,
        );

        const result = await methods.getSoleOwnedResourceIds(userId, ResourceType.AGENT);
        expect(result).toHaveLength(1);
        expect(result[0].toString()).toBe(soleRes.toString());
      });

      test('excludes resources where the user entry lacks DELETE', async () => {
        const noDelete = new mongoose.Types.ObjectId();
        await methods.grantPermission(
          PrincipalType.USER,
          userId,
          ResourceType.AGENT,
          noDelete,
          PermissionBits.VIEW | PermissionBits.EDIT,
          grantedById,
        );

        const result = await methods.getSoleOwnedResourceIds(userId, ResourceType.AGENT);
        expect(result).toHaveLength(0);
      });

      test('handles an array of resource types', async () => {
        const agentRes = new mongoose.Types.ObjectId();
        const mcpRes = new mongoose.Types.ObjectId();
        await methods.grantPermission(
          PrincipalType.USER,
          userId,
          ResourceType.AGENT,
          agentRes,
          PermissionBits.VIEW | PermissionBits.DELETE,
          grantedById,
        );
        await methods.grantPermission(
          PrincipalType.USER,
          userId,
          ResourceType.MCPSERVER,
          mcpRes,
          PermissionBits.VIEW | PermissionBits.DELETE,
          grantedById,
        );

        const result = await methods.getSoleOwnedResourceIds(userId, [
          ResourceType.AGENT,
          ResourceType.MCPSERVER,
        ]);
        expect(result).toHaveLength(2);
        const idStrings = result.map((id) => id.toString()).sort();
        expect(idStrings).toEqual([agentRes.toString(), mcpRes.toString()].sort());
      });

      test('returns empty array when no owned entries exist', async () => {
        const result = await methods.getSoleOwnedResourceIds(userId, ResourceType.AGENT);
        expect(result).toEqual([]);
      });
    });
  });

  /**
   * Focused unit tests for the `permissionBitSupersets` helper. The helper is
   * the single point of correctness for every ACL read path (every query uses
   * `permBits: { $in: permissionBitSupersets(X) }`), so it warrants direct
   * coverage independent of the higher-level parity and behavior specs.
   */
  describe('modifyPermissionBits (atomic guarded writes, issue #16163)', () => {
    const principal = new mongoose.Types.ObjectId();
    const resource = new mongoose.Types.ObjectId();
    const INSIGHTS = PermissionBits.VIEW_INSIGHTS;

    const seed = (permBits: number) =>
      AclEntry.create({
        principalType: PrincipalType.USER,
        principalId: principal,
        principalModel: PrincipalModel.USER,
        resourceType: ResourceType.AGENT,
        resourceId: resource,
        permBits,
        grantedBy: grantedById,
      });

    const modify = (add?: number | null, remove?: number | null) =>
      methods.modifyPermissionBits(
        PrincipalType.USER,
        principal,
        ResourceType.AGENT,
        resource,
        add,
        remove,
      );

    test('adds bits, leaving independently administered bits alone', async () => {
      await seed(PermissionBits.VIEW | INSIGHTS);
      const updated = await modify(PermissionBits.EDIT, null);
      expect(updated?.permBits).toBe(PermissionBits.VIEW | PermissionBits.EDIT | INSIGHTS);
    });

    test('removes bits, leaving independently administered bits alone', async () => {
      await seed(PermissionBits.VIEW | PermissionBits.EDIT | INSIGHTS);
      const updated = await modify(null, PermissionBits.EDIT);
      expect(updated?.permBits).toBe(PermissionBits.VIEW | INSIGHTS);
    });

    test('applies an add and a remove in one stored value', async () => {
      await seed(PermissionBits.VIEW | PermissionBits.EDIT | INSIGHTS);
      const updated = await modify(PermissionBits.SHARE, PermissionBits.EDIT);
      expect(updated?.permBits).toBe(PermissionBits.VIEW | PermissionBits.SHARE | INSIGHTS);
    });

    test('changes bits in one guarded write and never emits $bit', async () => {
      await seed(PermissionBits.VIEW);
      const spy = jest.spyOn(AclEntry, 'bulkWrite');
      try {
        await modify(PermissionBits.EDIT, PermissionBits.VIEW);
        expect(spy).toHaveBeenCalledTimes(1);
        expect(spy.mock.calls[0][0]).toHaveLength(1);
        expect(spy.mock.calls[0][0][0]).toMatchObject({
          updateOne: {
            filter: { permBits: PermissionBits.VIEW },
            update: { $set: { permBits: PermissionBits.EDIT } },
          },
        });
        expect(JSON.stringify(spy.mock.calls)).not.toContain('$bit');
      } finally {
        spy.mockRestore();
      }
    });

    test('retries a concurrent Insights grant without overwriting it', async () => {
      await seed(PermissionBits.VIEW | PermissionBits.EDIT);
      const real = AclEntry.bulkWrite.bind(AclEntry);
      const race = (async (...args: Parameters<typeof real>) => {
        await AclEntry.updateMany({ principalId: principal }, { $set: { permBits: 19 } });
        return real(...args);
      }) as unknown as typeof AclEntry.bulkWrite;
      const spy = jest.spyOn(AclEntry, 'bulkWrite').mockImplementationOnce(race);
      try {
        const updated = await modify(PermissionBits.SHARE, PermissionBits.EDIT);
        expect(updated?.permBits).toBe(PermissionBits.VIEW | PermissionBits.SHARE | INSIGHTS);
        expect(spy).toHaveBeenCalledTimes(2);
      } finally {
        spy.mockRestore();
      }
    });

    test('removes a bit named in both masks, matching the prior precedence', async () => {
      await seed(PermissionBits.VIEW | INSIGHTS);
      const updated = await modify(PermissionBits.EDIT | PermissionBits.SHARE, PermissionBits.EDIT);
      expect(updated?.permBits).toBe(PermissionBits.VIEW | PermissionBits.SHARE | INSIGHTS);
    });

    test('initializes an absent permission field without inheriting anything', async () => {
      await seed(PermissionBits.VIEW);
      await mongoose.models.AclEntry.collection.updateMany(
        { principalId: principal },
        { $unset: { permBits: '' } },
      );
      const updated = await modify(PermissionBits.EDIT, PermissionBits.VIEW);
      expect(updated?.permBits).toBe(PermissionBits.EDIT);
    });

    test('returns null when no entry matches', async () => {
      expect(await modify(PermissionBits.EDIT, PermissionBits.VIEW)).toBeNull();
    });

    test('returns the entry unchanged when neither side is requested', async () => {
      await seed(PermissionBits.VIEW | INSIGHTS);
      const updated = await modify(null, null);
      expect(updated?.permBits).toBe(PermissionBits.VIEW | INSIGHTS);
    });
  });

  describe('permissionBitSupersets', () => {
    test('requiredBits=0 matches every permBits value in [0, 31]', () => {
      const result = permissionBitSupersets(0);
      expect(result).toHaveLength(32);
      expect([...result].sort((a, b) => a - b)).toEqual(
        Array.from({ length: 32 }, (_, value) => value),
      );
    });

    test('all permission bits match only the upper bound', () => {
      const result = permissionBitSupersets(
        PermissionBits.VIEW |
          PermissionBits.EDIT |
          PermissionBits.DELETE |
          PermissionBits.SHARE |
          PermissionBits.VIEW_INSIGHTS,
      );
      expect([...result].sort((a, b) => a - b)).toEqual([31]);
    });

    test('every returned value is a bitwise superset of requiredBits', () => {
      for (const required of [
        PermissionBits.VIEW,
        PermissionBits.EDIT,
        PermissionBits.DELETE,
        PermissionBits.SHARE,
        PermissionBits.VIEW_INSIGHTS,
        PermissionBits.VIEW | PermissionBits.VIEW_INSIGHTS,
        PermissionBits.VIEW | PermissionBits.EDIT,
        PermissionBits.VIEW | PermissionBits.EDIT | PermissionBits.DELETE,
      ]) {
        const result = permissionBitSupersets(required);
        for (const v of result) {
          expect((v & required) === required).toBe(true);
        }
      }
    });

    test('returns exactly the values satisfying $bitsAllSet semantics', () => {
      /**
       * Parity check against the literal definition: for every required mask,
       * the returned set must equal the set of all v in [0,31] whose bits
       * include `required`.
       */
      for (let required = 0; required <= 31; required++) {
        const expected: number[] = [];
        for (let v = 0; v <= 31; v++) {
          if ((v & required) === required) {
            expected.push(v);
          }
        }
        expect([...permissionBitSupersets(required)].sort((a, b) => a - b)).toEqual(expected);
      }
    });

    test('memoizes: repeat calls return the same frozen reference', () => {
      const first = permissionBitSupersets(PermissionBits.SHARE);
      const second = permissionBitSupersets(PermissionBits.SHARE);
      expect(second).toBe(first);
      expect(Object.isFrozen(first)).toBe(true);
    });

    test('frozen result throws on mutation attempts in strict mode', () => {
      const result = permissionBitSupersets(PermissionBits.VIEW);
      /**
       * `Object.freeze` in strict mode (TypeScript compiles to strict) causes
       * mutation attempts to throw rather than silently corrupt the cache.
       */
      expect(() => {
        (result as number[]).push(99);
      }).toThrow(TypeError);
    });

    /**
     * Controllers forward user input directly into this path (e.g.
     * `req.query.requiredPermission` in agents/v1.js is parsed by `parseInt`
     * and passed to `findAccessibleResources`). Without a guard, attacker-
     * supplied unique integers would grow the process-global `supersetCache`
     * indefinitely (a DoS vector). Verify the function rejects every
     * out-of-range shape without touching the cache.
     */
    describe('rejection of out-of-range inputs (cache-growth safety)', () => {
      const MAX =
        PermissionBits.VIEW |
        PermissionBits.EDIT |
        PermissionBits.DELETE |
        PermissionBits.SHARE |
        PermissionBits.VIEW_INSIGHTS;
      const FIRST_TRUNCATED_32_BIT_VALUE = 2 ** 32;
      const SHARED_EMPTY = permissionBitSupersets(MAX + 1);

      test('returns a frozen empty array for requiredBits above MAX_PERM_BITS', () => {
        expect(permissionBitSupersets(MAX + 1)).toEqual([]);
        expect(Object.isFrozen(permissionBitSupersets(MAX + 1))).toBe(true);
      });

      test('returns the same shared empty instance for every rejected input', () => {
        /**
         * Shared reference identity means rejected inputs do not each allocate
         * a fresh array on every call — key to avoiding GC churn under load.
         */
        expect(permissionBitSupersets(MAX + 1)).toBe(SHARED_EMPTY);
        expect(permissionBitSupersets(MAX + 100)).toBe(SHARED_EMPTY);
        expect(permissionBitSupersets(-1)).toBe(SHARED_EMPTY);
        expect(permissionBitSupersets(FIRST_TRUNCATED_32_BIT_VALUE)).toBe(SHARED_EMPTY);
        expect(permissionBitSupersets(FIRST_TRUNCATED_32_BIT_VALUE * 2)).toBe(SHARED_EMPTY);
        expect(permissionBitSupersets(Number.MAX_SAFE_INTEGER)).toBe(SHARED_EMPTY);
        expect(permissionBitSupersets(NaN)).toBe(SHARED_EMPTY);
        expect(permissionBitSupersets(1.5)).toBe(SHARED_EMPTY);
      });

      test('rejects large integers that truncate to in-range 32-bit values', () => {
        expect(FIRST_TRUNCATED_32_BIT_VALUE & ~MAX).toBe(0);
        expect(permissionBitSupersets(FIRST_TRUNCATED_32_BIT_VALUE)).toBe(SHARED_EMPTY);
        expect(permissionBitSupersets(FIRST_TRUNCATED_32_BIT_VALUE + PermissionBits.VIEW)).toBe(
          SHARED_EMPTY,
        );
      });

      test('rejects inputs with bits above MAX_PERM_BITS even if some in-range bits are set', () => {
        /**
         * `permBits = 33 = 0b100001` has VIEW set and an out-of-range bit. A
         * stored `permBits` can never be both ≤ 31 and have bit 5 set, so the
         * match set is necessarily empty — reject before caching.
         */
        expect(permissionBitSupersets(MAX + 1 + PermissionBits.VIEW)).toBe(SHARED_EMPTY);
      });

      test('does NOT cache rejected inputs (reference identity)', () => {
        /**
         * Fire a burst of unique attacker-supplied integers and verify that
         * none of them can be retrieved from the cache via a legitimate call
         * — i.e., they were never cached. We do this by asserting shared
         * reference identity across repeated calls with varied bogus values.
         * If any of these were being cached, repeat calls would return
         * distinct frozen arrays.
         */
        const ref = permissionBitSupersets(MAX + 1);
        for (let i = 0; i < 1000; i++) {
          expect(permissionBitSupersets(MAX + 1 + i)).toBe(ref);
        }
        for (let i = 0; i < 1000; i++) {
          expect(permissionBitSupersets(-(i + 1))).toBe(ref);
        }
      });

      test('does NOT call `supersetCache.set` for rejected inputs (Map-write probe)', () => {
        /**
         * Stronger guarantee than reference identity alone: spy on
         * `Map.prototype.set` and assert zero invocations during a burst of
         * rejected inputs. This closes the hypothetical gap where a future
         * regression like `supersetCache.set(requiredBits, EMPTY_SUPERSETS)`
         * could pass the reference-identity check while still leaking memory
         * one entry per attacker request.
         *
         * The spy is global (it intercepts every `Map.prototype.set` call),
         * so we snapshot the call count before and after and assert the
         * delta is zero. The body does no async work and no other Map
         * writes, so any delta would come from `permissionBitSupersets`.
         */
        const setSpy = jest.spyOn(Map.prototype, 'set');
        try {
          const before = setSpy.mock.calls.length;
          for (let i = 0; i < 500; i++) {
            permissionBitSupersets(MAX + 1 + i);
            permissionBitSupersets(FIRST_TRUNCATED_32_BIT_VALUE + i);
            permissionBitSupersets(-(i + 1));
            permissionBitSupersets(i + 0.5);
          }
          const delta = setSpy.mock.calls.length - before;
          expect(delta).toBe(0);
        } finally {
          setSpy.mockRestore();
        }
      });

      test('in-range inputs are still cached normally (memoized reference)', () => {
        const first = permissionBitSupersets(PermissionBits.EDIT);
        const second = permissionBitSupersets(PermissionBits.EDIT);
        expect(second).toBe(first);
        expect(Object.isFrozen(first)).toBe(true);
        expect(first).not.toBe(SHARED_EMPTY);
      });
    });
  });

  /**
   * These tests enforce the invariant that `permBits` stays within the
   * `[0, MAX_PERM_BITS]` range that `permissionBitSupersets` enumerates. Rows
   * with out-of-range bits would be silently excluded from the `$in` filter
   * (false permission denials), so the schema rejects them at write time.
   * See the second review pass on issue #12729.
   */
  describe('permBits schema bounds', () => {
    const MAX_PERM_BITS =
      PermissionBits.VIEW |
      PermissionBits.EDIT |
      PermissionBits.DELETE |
      PermissionBits.SHARE |
      PermissionBits.VIEW_INSIGHTS;

    test('accepts permBits at the upper bound (all enum bits set)', async () => {
      const resource = new mongoose.Types.ObjectId();
      await expect(
        AclEntry.create({
          principalType: PrincipalType.USER,
          principalId: userId,
          principalModel: PrincipalModel.USER,
          resourceType: ResourceType.AGENT,
          resourceId: resource,
          permBits: MAX_PERM_BITS,
          grantedBy: grantedById,
        }),
      ).resolves.toBeDefined();
    });

    test('rejects permBits above MAX_PERM_BITS', async () => {
      const resource = new mongoose.Types.ObjectId();
      await expect(
        AclEntry.create({
          principalType: PrincipalType.USER,
          principalId: userId,
          principalModel: PrincipalModel.USER,
          resourceType: ResourceType.AGENT,
          resourceId: resource,
          permBits: MAX_PERM_BITS + 1,
          grantedBy: grantedById,
        }),
      ).rejects.toThrow(mongoose.Error.ValidationError);
    });

    test('rejects negative permBits', async () => {
      const resource = new mongoose.Types.ObjectId();
      await expect(
        AclEntry.create({
          principalType: PrincipalType.USER,
          principalId: userId,
          principalModel: PrincipalModel.USER,
          resourceType: ResourceType.AGENT,
          resourceId: resource,
          permBits: -1,
          grantedBy: grantedById,
        }),
      ).rejects.toThrow(mongoose.Error.ValidationError);
    });

    test('rejects non-integer permBits', async () => {
      const resource = new mongoose.Types.ObjectId();
      await expect(
        AclEntry.create({
          principalType: PrincipalType.USER,
          principalId: userId,
          principalModel: PrincipalModel.USER,
          resourceType: ResourceType.AGENT,
          resourceId: resource,
          permBits: 1.5,
          grantedBy: grantedById,
        }),
      ).rejects.toThrow(mongoose.Error.ValidationError);
    });
  });
});
