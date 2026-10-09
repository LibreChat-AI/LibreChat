import mongoose, { Types, Model } from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createModels, createMethods, logger, RoleBits } from '@librechat/data-schemas';
import {
  ResourceType,
  AccessRoleIds,
  PermissionBits,
  PrincipalModel,
  PrincipalType,
} from 'librechat-data-provider';
import type { IAclEntry } from '@librechat/data-schemas';
import { AccessControlService } from './accessControlService';

// Mock the logger
jest.mock('@librechat/data-schemas', () => ({
  ...jest.requireActual('@librechat/data-schemas'),
  logger: {
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
    info: jest.fn(),
  },
}));

let mongoServer: MongoMemoryServer;
let AclEntry: Model<IAclEntry>;
let service: AccessControlService;
let dbMethods: ReturnType<typeof createMethods>;

// Mock getUserPrincipals to control test scenarios
const mockGetUserPrincipals = jest.fn();

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  const mongoUri = mongoServer.getUri();
  await mongoose.connect(mongoUri);

  // Initialize all models
  createModels(mongoose);

  AclEntry = mongoose.models.AclEntry as Model<IAclEntry>;

  // Create methods and seed default roles
  dbMethods = createMethods(mongoose);
  await dbMethods.seedDefaultRoles();

  // Create service instance
  service = new AccessControlService(mongoose);

  // Mock getUserPrincipals in the dbMethods
  const originalMethods = service['_dbMethods'];
  service['_dbMethods'] = {
    ...originalMethods,
    getUserPrincipals: mockGetUserPrincipals,
  };
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

beforeEach(async () => {
  // Clear test data but keep seeded roles
  await AclEntry.deleteMany({});
  mockGetUserPrincipals.mockReset();
});

describe('AccessControlService', () => {
  // Common test data
  const userId = new Types.ObjectId();
  const groupId = new Types.ObjectId();
  const resourceId = new Types.ObjectId();
  const grantedById = new Types.ObjectId();

  describe('bulkUpdateResourcePermissions', () => {
    test('records only the revocation that actually deleted Insights access', async () => {
      await service.bulkUpdateResourcePermissions({
        resourceType: ResourceType.AGENT,
        resourceId,
        updatedPrincipals: [
          {
            type: PrincipalType.USER,
            id: userId.toString(),
            accessRoleId: AccessRoleIds.AGENT_VIEWER,
            viewInsights: true,
          },
        ],
        grantedBy: grantedById,
      });

      const revoke = () =>
        service.bulkUpdateResourcePermissions({
          resourceType: ResourceType.AGENT,
          resourceId,
          revokedPrincipals: [{ type: PrincipalType.USER, id: userId.toString() }],
          grantedBy: grantedById,
        });
      const results = await Promise.all([revoke(), revoke()]);

      expect(results.flatMap((result) => result.insightsChanges)).toEqual([
        expect.objectContaining({ action: 'removed' }),
      ]);
      await expect(
        AclEntry.exists({
          principalType: PrincipalType.USER,
          principalId: userId,
          resourceType: ResourceType.AGENT,
          resourceId,
          permBits: { $bitsAllSet: PermissionBits.VIEW_INSIGHTS },
        }),
      ).resolves.toBeNull();
    });

    test('removes duplicate ACL entries for a revoked principal', async () => {
      await service.bulkUpdateResourcePermissions({
        resourceType: ResourceType.AGENT,
        resourceId,
        updatedPrincipals: [
          {
            type: PrincipalType.USER,
            id: userId.toString(),
            accessRoleId: AccessRoleIds.AGENT_VIEWER,
            viewInsights: true,
          },
        ],
        grantedBy: grantedById,
      });
      const entry = await AclEntry.findOne({
        principalType: PrincipalType.USER,
        principalId: userId,
        resourceType: ResourceType.AGENT,
        resourceId,
      }).lean();
      await AclEntry.create({ ...entry, _id: new Types.ObjectId() });

      const result = await service.bulkUpdateResourcePermissions({
        resourceType: ResourceType.AGENT,
        resourceId,
        revokedPrincipals: [{ type: PrincipalType.USER, id: userId.toString() }],
        grantedBy: grantedById,
      });

      expect(result.insightsChanges).toHaveLength(1);
      await expect(
        AclEntry.countDocuments({
          principalType: PrincipalType.USER,
          principalId: userId,
          resourceType: ResourceType.AGENT,
          resourceId,
        }),
      ).resolves.toBe(0);
    });

    test('removes Insights access from every duplicate ACL entry', async () => {
      await service.bulkUpdateResourcePermissions({
        resourceType: ResourceType.AGENT,
        resourceId,
        updatedPrincipals: [
          {
            type: PrincipalType.USER,
            id: userId.toString(),
            accessRoleId: AccessRoleIds.AGENT_VIEWER,
            viewInsights: true,
          },
        ],
        grantedBy: grantedById,
      });
      const entry = await AclEntry.findOne({
        principalType: PrincipalType.USER,
        principalId: userId,
        resourceType: ResourceType.AGENT,
        resourceId,
      }).lean();
      await AclEntry.create({
        ...entry,
        _id: new Types.ObjectId(),
        permBits: PermissionBits.VIEW,
      });

      const result = await service.bulkUpdateResourcePermissions({
        resourceType: ResourceType.AGENT,
        resourceId,
        updatedPrincipals: [
          {
            type: PrincipalType.USER,
            id: userId.toString(),
            accessRoleId: AccessRoleIds.AGENT_VIEWER,
            viewInsights: false,
          },
        ],
        grantedBy: grantedById,
      });

      expect(result.insightsChanges).toEqual([expect.objectContaining({ action: 'removed' })]);
      const entries = await AclEntry.find({
        principalType: PrincipalType.USER,
        principalId: userId,
        resourceType: ResourceType.AGENT,
        resourceId,
      }).lean();
      expect(entries).toHaveLength(2);
      expect(
        entries.every((candidate) => (candidate.permBits & PermissionBits.VIEW_INSIGHTS) === 0),
      ).toBe(true);
    });

    test('removes Insights from every duplicate when an assignment is rolled back', async () => {
      await service.bulkUpdateResourcePermissions({
        resourceType: ResourceType.AGENT,
        resourceId,
        updatedPrincipals: [
          {
            type: PrincipalType.USER,
            id: userId.toString(),
            accessRoleId: AccessRoleIds.AGENT_VIEWER,
            viewInsights: false,
          },
        ],
        grantedBy: grantedById,
      });
      const entry = await AclEntry.findOne({
        principalType: PrincipalType.USER,
        principalId: userId,
        resourceType: ResourceType.AGENT,
        resourceId,
      }).lean();
      await AclEntry.create({ ...entry, _id: new Types.ObjectId() });

      const result = await service.bulkUpdateResourcePermissions({
        resourceType: ResourceType.AGENT,
        resourceId,
        updatedPrincipals: [
          {
            type: PrincipalType.USER,
            id: userId.toString(),
            accessRoleId: AccessRoleIds.AGENT_VIEWER,
            viewInsights: true,
          },
        ],
        grantedBy: grantedById,
      });
      await service.restoreInsightsPermissionChanges({
        resourceType: ResourceType.AGENT,
        resourceId,
        changes: result.insightsChanges,
      });

      const entries = await AclEntry.find({
        principalType: PrincipalType.USER,
        principalId: userId,
        resourceType: ResourceType.AGENT,
        resourceId,
      }).lean();
      expect(entries).toHaveLength(2);
      expect(
        entries.every((candidate) => (candidate.permBits & PermissionBits.VIEW_INSIGHTS) === 0),
      ).toBe(true);
    });

    test('audits a revoke when any duplicate ACL entry has Insights access', async () => {
      const viewerRole = await dbMethods.findRoleByIdentifier(AccessRoleIds.AGENT_VIEWER);
      await AclEntry.create([
        {
          principalType: PrincipalType.USER,
          principalId: userId,
          principalModel: PrincipalModel.USER,
          resourceType: ResourceType.AGENT,
          resourceId,
          permBits: PermissionBits.VIEW,
          roleId: viewerRole?._id,
          grantedBy: grantedById,
          grantedAt: new Date(),
        },
        {
          principalType: PrincipalType.USER,
          principalId: userId,
          principalModel: PrincipalModel.USER,
          resourceType: ResourceType.AGENT,
          resourceId,
          permBits: PermissionBits.VIEW | PermissionBits.VIEW_INSIGHTS,
          roleId: viewerRole?._id,
          grantedBy: grantedById,
          grantedAt: new Date(),
        },
      ]);

      const result = await service.bulkUpdateResourcePermissions({
        resourceType: ResourceType.AGENT,
        resourceId,
        revokedPrincipals: [{ type: PrincipalType.USER, id: userId.toString() }],
        grantedBy: grantedById,
      });

      expect(result.insightsChanges).toEqual([
        expect.objectContaining({
          action: 'removed',
          previousEntry: expect.objectContaining({
            permBits: PermissionBits.VIEW | PermissionBits.VIEW_INSIGHTS,
          }),
        }),
      ]);
    });

    test('does not treat a non-agent permission bit as an Insights revocation', async () => {
      await AclEntry.create({
        principalType: PrincipalType.USER,
        principalId: userId,
        principalModel: PrincipalModel.USER,
        resourceType: ResourceType.PROMPTGROUP,
        resourceId,
        permBits: PermissionBits.VIEW | PermissionBits.VIEW_INSIGHTS,
        grantedBy: grantedById,
        grantedAt: new Date(),
      });

      const result = await service.bulkUpdateResourcePermissions({
        resourceType: ResourceType.PROMPTGROUP,
        resourceId,
        revokedPrincipals: [{ type: PrincipalType.USER, id: userId.toString() }],
        grantedBy: grantedById,
      });

      expect(result.insightsChanges).toEqual([]);
      await expect(
        AclEntry.exists({ resourceType: ResourceType.PROMPTGROUP, resourceId }),
      ).resolves.toBeNull();
    });

    test('rejects a missing user id instead of generating an orphan ACL id', async () => {
      const result = await service.bulkUpdateResourcePermissions({
        resourceType: ResourceType.AGENT,
        resourceId,
        updatedPrincipals: [
          {
            type: PrincipalType.USER,
            accessRoleId: AccessRoleIds.AGENT_VIEWER,
          },
        ],
        grantedBy: grantedById,
      });

      expect(result.granted).toEqual([]);
      expect(result.errors).toEqual([
        expect.objectContaining({ error: 'Invalid principal ID: undefined' }),
      ]);
      await expect(
        AclEntry.exists({ resourceType: ResourceType.AGENT, resourceId }),
      ).resolves.toBeNull();
    });
  });

  describe('grantPermission', () => {
    describe('validation', () => {
      test('should throw error for invalid principal type', async () => {
        await expect(
          service.grantPermission({
            principalType: 'invalid' as PrincipalType,
            principalId: userId,
            resourceType: ResourceType.AGENT,
            resourceId,
            accessRoleId: AccessRoleIds.AGENT_VIEWER,
            grantedBy: grantedById,
          }),
        ).rejects.toThrow('Invalid principal type: invalid');
      });

      test('should throw error for missing principalId with user type', async () => {
        await expect(
          service.grantPermission({
            principalType: PrincipalType.USER,
            principalId: null,
            resourceType: ResourceType.AGENT,
            resourceId,
            accessRoleId: AccessRoleIds.AGENT_VIEWER,
            grantedBy: grantedById,
          }),
        ).rejects.toThrow('Principal ID is required for user, group, and role principals');
      });

      test('should throw error for missing principalId with group type', async () => {
        await expect(
          service.grantPermission({
            principalType: PrincipalType.GROUP,
            principalId: null,
            resourceType: ResourceType.AGENT,
            resourceId,
            accessRoleId: AccessRoleIds.AGENT_VIEWER,
            grantedBy: grantedById,
          }),
        ).rejects.toThrow('Principal ID is required for user, group, and role principals');
      });

      test('should throw error for missing principalId with role type', async () => {
        await expect(
          service.grantPermission({
            principalType: PrincipalType.ROLE,
            principalId: null,
            resourceType: ResourceType.AGENT,
            resourceId,
            accessRoleId: AccessRoleIds.AGENT_VIEWER,
            grantedBy: grantedById,
          }),
        ).rejects.toThrow('Principal ID is required for user, group, and role principals');
      });

      test('should throw error for invalid role ID (empty string)', async () => {
        // Empty string is falsy, so it triggers the "principalId required" check first
        await expect(
          service.grantPermission({
            principalType: PrincipalType.ROLE,
            principalId: '',
            resourceType: ResourceType.AGENT,
            resourceId,
            accessRoleId: AccessRoleIds.AGENT_VIEWER,
            grantedBy: grantedById,
          }),
        ).rejects.toThrow('Principal ID is required for user, group, and role principals');
      });

      test('should throw error for invalid role ID (whitespace only)', async () => {
        await expect(
          service.grantPermission({
            principalType: PrincipalType.ROLE,
            principalId: '   ',
            resourceType: ResourceType.AGENT,
            resourceId,
            accessRoleId: AccessRoleIds.AGENT_VIEWER,
            grantedBy: grantedById,
          }),
        ).rejects.toThrow('Invalid role ID:');
      });

      test('should throw error for invalid user principal ID (non-ObjectId)', async () => {
        await expect(
          service.grantPermission({
            principalType: PrincipalType.USER,
            principalId: 'invalid-id',
            resourceType: ResourceType.AGENT,
            resourceId,
            accessRoleId: AccessRoleIds.AGENT_VIEWER,
            grantedBy: grantedById,
          }),
        ).rejects.toThrow('Invalid principal ID: invalid-id');
      });

      test('should throw error for invalid resource ID', async () => {
        await expect(
          service.grantPermission({
            principalType: PrincipalType.USER,
            principalId: userId,
            resourceType: ResourceType.AGENT,
            resourceId: 'invalid-id',
            accessRoleId: AccessRoleIds.AGENT_VIEWER,
            grantedBy: grantedById,
          }),
        ).rejects.toThrow('Invalid resource ID: invalid-id');
      });

      test('should throw error for invalid resource type', async () => {
        await expect(
          service.grantPermission({
            principalType: PrincipalType.USER,
            principalId: userId,
            resourceType: 'invalidType' as ResourceType,
            resourceId,
            accessRoleId: AccessRoleIds.AGENT_VIEWER,
            grantedBy: grantedById,
          }),
        ).rejects.toThrow('Invalid resourceType: invalidType');
      });
    });

    describe('role lookup', () => {
      test('should throw error for non-existent role', async () => {
        await expect(
          service.grantPermission({
            principalType: PrincipalType.USER,
            principalId: userId,
            resourceType: ResourceType.AGENT,
            resourceId,
            accessRoleId: 'non_existent_role' as AccessRoleIds,
            grantedBy: grantedById,
          }),
        ).rejects.toThrow('Role non_existent_role not found');
      });

      test('should throw error for role-resource type mismatch', async () => {
        await expect(
          service.grantPermission({
            principalType: PrincipalType.USER,
            principalId: userId,
            resourceType: ResourceType.AGENT,
            resourceId,
            accessRoleId: AccessRoleIds.PROMPTGROUP_VIEWER, // PromptGroup role for agent resource
            grantedBy: grantedById,
          }),
        ).rejects.toThrow('Role promptGroup_viewer is for promptGroup resources, not agent');
      });
    });

    describe('successful grant', () => {
      test('should grant permission to a user with a role', async () => {
        const entry = await service.grantPermission({
          principalType: PrincipalType.USER,
          principalId: userId,
          resourceType: ResourceType.AGENT,
          resourceId,
          accessRoleId: AccessRoleIds.AGENT_VIEWER,
          grantedBy: grantedById,
        });

        expect(entry).toBeDefined();
        expect(entry!.principalType).toBe(PrincipalType.USER);
        expect(entry!.principalId!.toString()).toBe(userId.toString());
        expect(entry!.resourceType).toBe(ResourceType.AGENT);
        expect(entry!.resourceId.toString()).toBe(resourceId.toString());
        expect(entry!.permBits).toBe(RoleBits.VIEWER);
      });

      test('should grant permission to a group with a role', async () => {
        const entry = await service.grantPermission({
          principalType: PrincipalType.GROUP,
          principalId: groupId,
          resourceType: ResourceType.AGENT,
          resourceId,
          accessRoleId: AccessRoleIds.AGENT_EDITOR,
          grantedBy: grantedById,
        });

        expect(entry).toBeDefined();
        expect(entry!.principalType).toBe(PrincipalType.GROUP);
        expect(entry!.principalId!.toString()).toBe(groupId.toString());
        expect(entry!.permBits).toBe(RoleBits.EDITOR);
      });

      test('should grant public permission with a role', async () => {
        const entry = await service.grantPermission({
          principalType: PrincipalType.PUBLIC,
          principalId: null,
          resourceType: ResourceType.AGENT,
          resourceId,
          accessRoleId: AccessRoleIds.AGENT_VIEWER,
          grantedBy: grantedById,
        });

        expect(entry).toBeDefined();
        expect(entry!.principalType).toBe(PrincipalType.PUBLIC);
        expect(entry!.principalId).toBeUndefined();
        expect(entry!.permBits).toBe(RoleBits.VIEWER);
      });

      test('should grant permission to a role principal', async () => {
        const entry = await service.grantPermission({
          principalType: PrincipalType.ROLE,
          principalId: 'admin',
          resourceType: ResourceType.AGENT,
          resourceId,
          accessRoleId: AccessRoleIds.AGENT_EDITOR,
          grantedBy: grantedById,
        });

        expect(entry).toBeDefined();
        expect(entry!.principalType).toBe(PrincipalType.ROLE);
        expect(entry!.principalId).toBe('admin');
        expect(entry!.permBits).toBe(RoleBits.EDITOR);
      });

      test('should update existing permission when granting to same principal and resource', async () => {
        // First grant with viewer role
        await service.grantPermission({
          principalType: PrincipalType.USER,
          principalId: userId,
          resourceType: ResourceType.AGENT,
          resourceId,
          accessRoleId: AccessRoleIds.AGENT_VIEWER,
          grantedBy: grantedById,
        });

        // Then update to editor role
        const updated = await service.grantPermission({
          principalType: PrincipalType.USER,
          principalId: userId,
          resourceType: ResourceType.AGENT,
          resourceId,
          accessRoleId: AccessRoleIds.AGENT_EDITOR,
          grantedBy: grantedById,
        });

        expect(updated!.permBits).toBe(RoleBits.EDITOR);

        // Verify there's only one entry
        const entries = await AclEntry.find({
          principalType: PrincipalType.USER,
          principalId: userId,
          resourceType: ResourceType.AGENT,
          resourceId,
        });
        expect(entries).toHaveLength(1);
      });
    });
  });

  describe('findAccessibleResources', () => {
    const resource1 = new Types.ObjectId();
    const resource2 = new Types.ObjectId();
    const resource3 = new Types.ObjectId();

    beforeEach(async () => {
      // User can view resource 1
      await service.grantPermission({
        principalType: PrincipalType.USER,
        principalId: userId,
        resourceType: ResourceType.AGENT,
        resourceId: resource1,
        accessRoleId: AccessRoleIds.AGENT_VIEWER,
        grantedBy: grantedById,
      });

      // User can edit resource 2
      await service.grantPermission({
        principalType: PrincipalType.USER,
        principalId: userId,
        resourceType: ResourceType.AGENT,
        resourceId: resource2,
        accessRoleId: AccessRoleIds.AGENT_EDITOR,
        grantedBy: grantedById,
      });

      // Group can view resource 3
      await service.grantPermission({
        principalType: PrincipalType.GROUP,
        principalId: groupId,
        resourceType: ResourceType.AGENT,
        resourceId: resource3,
        accessRoleId: AccessRoleIds.AGENT_VIEWER,
        grantedBy: grantedById,
      });
    });

    describe('validation errors', () => {
      test('should throw error when requiredPermissions is not a positive number', async () => {
        mockGetUserPrincipals.mockResolvedValue([
          { principalType: PrincipalType.USER, principalId: userId },
        ]);

        await expect(
          service.findAccessibleResources({
            userId,
            resourceType: ResourceType.AGENT,
            requiredPermissions: 0,
          }),
        ).rejects.toThrow('requiredPermissions must be a positive number');
      });

      test('should throw error when requiredPermissions is negative', async () => {
        await expect(
          service.findAccessibleResources({
            userId,
            resourceType: ResourceType.AGENT,
            requiredPermissions: -1,
          }),
        ).rejects.toThrow('requiredPermissions must be a positive number');
      });

      test('should return empty array for invalid resource type (error is caught)', async () => {
        // The service catches invalid resourceType errors and returns empty array
        const result = await service.findAccessibleResources({
          userId,
          resourceType: 'invalid' as ResourceType,
          requiredPermissions: 1,
        });

        expect(result).toEqual([]);
      });
    });

    describe('empty principals', () => {
      test('should return empty array when no principals found', async () => {
        mockGetUserPrincipals.mockResolvedValue([]);

        const result = await service.findAccessibleResources({
          userId,
          resourceType: ResourceType.AGENT,
          requiredPermissions: 1,
        });

        expect(result).toEqual([]);
      });
    });

    describe('successful queries', () => {
      test('should find resources user can view', async () => {
        mockGetUserPrincipals.mockResolvedValue([
          { principalType: PrincipalType.USER, principalId: userId },
        ]);

        const viewableResources = await service.findAccessibleResources({
          userId,
          resourceType: ResourceType.AGENT,
          requiredPermissions: 1, // VIEW
        });

        expect(viewableResources).toHaveLength(2);
        const resourceIds = viewableResources.map((id) => id.toString());
        expect(resourceIds).toContain(resource1.toString());
        expect(resourceIds).toContain(resource2.toString());
      });

      test('should find resources user can edit', async () => {
        mockGetUserPrincipals.mockResolvedValue([
          { principalType: PrincipalType.USER, principalId: userId },
        ]);

        const editableResources = await service.findAccessibleResources({
          userId,
          resourceType: ResourceType.AGENT,
          requiredPermissions: 3, // EDIT
        });

        expect(editableResources).toHaveLength(1);
        expect(editableResources[0].toString()).toBe(resource2.toString());
      });

      test('should find resources accessible via group membership', async () => {
        mockGetUserPrincipals.mockResolvedValue([
          { principalType: PrincipalType.USER, principalId: userId },
          { principalType: PrincipalType.GROUP, principalId: groupId },
        ]);

        const viewableResources = await service.findAccessibleResources({
          userId,
          resourceType: ResourceType.AGENT,
          requiredPermissions: 1, // VIEW
        });

        expect(viewableResources).toHaveLength(3);
      });

      test('should pass role when provided', async () => {
        mockGetUserPrincipals.mockResolvedValue([
          { principalType: PrincipalType.USER, principalId: userId },
          { principalType: PrincipalType.ROLE, principalId: 'admin' },
        ]);

        await service.findAccessibleResources({
          userId,
          role: 'admin',
          resourceType: ResourceType.AGENT,
          requiredPermissions: 1,
        });

        expect(mockGetUserPrincipals).toHaveBeenCalledWith({
          userId,
          role: 'admin',
        });
      });
    });
  });

  describe('findPubliclyAccessibleResources', () => {
    const publicResource1 = new Types.ObjectId();
    const publicResource2 = new Types.ObjectId();
    const privateResource = new Types.ObjectId();

    beforeEach(async () => {
      // Public can view resource 1
      await service.grantPermission({
        principalType: PrincipalType.PUBLIC,
        principalId: null,
        resourceType: ResourceType.AGENT,
        resourceId: publicResource1,
        accessRoleId: AccessRoleIds.AGENT_VIEWER,
        grantedBy: grantedById,
      });

      // Public can edit resource 2
      await service.grantPermission({
        principalType: PrincipalType.PUBLIC,
        principalId: null,
        resourceType: ResourceType.AGENT,
        resourceId: publicResource2,
        accessRoleId: AccessRoleIds.AGENT_EDITOR,
        grantedBy: grantedById,
      });

      // Private resource - only user access
      await service.grantPermission({
        principalType: PrincipalType.USER,
        principalId: userId,
        resourceType: ResourceType.AGENT,
        resourceId: privateResource,
        accessRoleId: AccessRoleIds.AGENT_OWNER,
        grantedBy: grantedById,
      });
    });

    describe('validation', () => {
      test('should throw error when requiredPermissions is not a positive number', async () => {
        await expect(
          service.findPubliclyAccessibleResources({
            resourceType: ResourceType.AGENT,
            requiredPermissions: 0,
          }),
        ).rejects.toThrow('requiredPermissions must be a positive number');
      });

      test('should return empty array for invalid resource type (error is caught)', async () => {
        // The service catches invalid resourceType errors and returns empty array
        const result = await service.findPubliclyAccessibleResources({
          resourceType: 'invalid' as ResourceType,
          requiredPermissions: 1,
        });

        expect(result).toEqual([]);
      });
    });

    describe('finding public resources', () => {
      test('should find publicly viewable resources', async () => {
        const publicResources = await service.findPubliclyAccessibleResources({
          resourceType: ResourceType.AGENT,
          requiredPermissions: 1, // VIEW
        });

        expect(publicResources).toHaveLength(2);
        const resourceIds = publicResources.map((id) => id.toString());
        expect(resourceIds).toContain(publicResource1.toString());
        expect(resourceIds).toContain(publicResource2.toString());
        expect(resourceIds).not.toContain(privateResource.toString());
      });

      test('should find publicly editable resources', async () => {
        const editableResources = await service.findPubliclyAccessibleResources({
          resourceType: ResourceType.AGENT,
          requiredPermissions: 3, // EDIT
        });

        expect(editableResources).toHaveLength(1);
        expect(editableResources[0].toString()).toBe(publicResource2.toString());
      });

      test('should return empty array when no public permissions exist', async () => {
        const noPublicResources = await service.findPubliclyAccessibleResources({
          resourceType: ResourceType.PROMPTGROUP,
          requiredPermissions: 1,
        });

        expect(noPublicResources).toEqual([]);
      });
    });
  });

  describe('getResourcePermissionsMap', () => {
    const resource1 = new Types.ObjectId();
    const resource2 = new Types.ObjectId();
    const resource3 = new Types.ObjectId();

    beforeEach(async () => {
      // User has VIEW on resource1
      await service.grantPermission({
        principalType: PrincipalType.USER,
        principalId: userId,
        resourceType: ResourceType.AGENT,
        resourceId: resource1,
        accessRoleId: AccessRoleIds.AGENT_VIEWER,
        grantedBy: grantedById,
      });

      // User has EDIT on resource2
      await service.grantPermission({
        principalType: PrincipalType.USER,
        principalId: userId,
        resourceType: ResourceType.AGENT,
        resourceId: resource2,
        accessRoleId: AccessRoleIds.AGENT_EDITOR,
        grantedBy: grantedById,
      });

      // Group has EDIT on resource1 (higher permission)
      await service.grantPermission({
        principalType: PrincipalType.GROUP,
        principalId: groupId,
        resourceType: ResourceType.AGENT,
        resourceId: resource1,
        accessRoleId: AccessRoleIds.AGENT_EDITOR,
        grantedBy: grantedById,
      });
      // resource3 has no permissions
    });

    describe('empty arrays', () => {
      test('should return empty map for empty resourceIds array', async () => {
        mockGetUserPrincipals.mockResolvedValue([
          { principalType: PrincipalType.USER, principalId: userId },
        ]);

        const permissionsMap = await service.getResourcePermissionsMap({
          userId,
          role: 'user',
          resourceType: ResourceType.AGENT,
          resourceIds: [],
        });

        expect(permissionsMap).toBeInstanceOf(Map);
        expect(permissionsMap.size).toBe(0);
      });

      test('should throw on invalid resource type', async () => {
        await expect(
          service.getResourcePermissionsMap({
            userId,
            role: 'user',
            resourceType: 'invalid' as ResourceType,
            resourceIds: [resource1],
          }),
        ).rejects.toThrow('Invalid resourceType: invalid');
      });
    });

    describe('batch queries', () => {
      test('should get permissions for multiple resources in single query', async () => {
        mockGetUserPrincipals.mockResolvedValue([
          { principalType: PrincipalType.USER, principalId: userId },
          { principalType: PrincipalType.PUBLIC },
        ]);

        const permissionsMap = await service.getResourcePermissionsMap({
          userId,
          role: 'user',
          resourceType: ResourceType.AGENT,
          resourceIds: [resource1, resource2, resource3],
        });

        expect(permissionsMap).toBeInstanceOf(Map);
        expect(permissionsMap.size).toBe(2); // resource1 and resource2
        expect(permissionsMap.get(resource1.toString())).toBe(RoleBits.VIEWER);
        expect(permissionsMap.get(resource2.toString())).toBe(RoleBits.EDITOR);
        expect(permissionsMap.get(resource3.toString())).toBeUndefined();
      });

      test('should combine permissions from multiple principals', async () => {
        mockGetUserPrincipals.mockResolvedValue([
          { principalType: PrincipalType.USER, principalId: userId },
          { principalType: PrincipalType.GROUP, principalId: groupId },
        ]);

        const permissionsMap = await service.getResourcePermissionsMap({
          userId,
          role: 'user',
          resourceType: ResourceType.AGENT,
          resourceIds: [resource1, resource2],
        });

        expect(permissionsMap.size).toBe(2);
        // Resource1 should have VIEW (1) | EDIT (3) = 3 from combined user+group
        expect(permissionsMap.get(resource1.toString())).toBe(RoleBits.EDITOR);
        expect(permissionsMap.get(resource2.toString())).toBe(RoleBits.EDITOR);
      });

      test('should use role optimization when provided', async () => {
        mockGetUserPrincipals.mockResolvedValue([
          { principalType: PrincipalType.USER, principalId: userId },
          { principalType: PrincipalType.ROLE, principalId: 'admin' },
        ]);

        await service.getResourcePermissionsMap({
          userId,
          role: 'admin',
          resourceType: ResourceType.AGENT,
          resourceIds: [resource1],
        });

        expect(mockGetUserPrincipals).toHaveBeenCalledWith({ userId, role: 'admin' });
      });

      test('logs principal resolution failures before propagating them', async () => {
        const error = new Error('principal lookup unavailable');
        mockGetUserPrincipals.mockRejectedValue(error);

        await expect(
          service.getResourcePermissionsMap({
            userId,
            role: 'user',
            resourceType: ResourceType.AGENT,
            resourceIds: [resource1],
          }),
        ).rejects.toBe(error);

        expect(logger.error).toHaveBeenCalledWith(
          expect.stringContaining('Error resolving principals: principal lookup unavailable'),
          error,
        );
      });
    });
  });

  describe('removeAllPermissions', () => {
    const resourceToDelete = new Types.ObjectId();

    beforeEach(async () => {
      // Grant multiple permissions to the resource
      await service.grantPermission({
        principalType: PrincipalType.USER,
        principalId: userId,
        resourceType: ResourceType.AGENT,
        resourceId: resourceToDelete,
        accessRoleId: AccessRoleIds.AGENT_VIEWER,
        grantedBy: grantedById,
      });

      await service.grantPermission({
        principalType: PrincipalType.GROUP,
        principalId: groupId,
        resourceType: ResourceType.AGENT,
        resourceId: resourceToDelete,
        accessRoleId: AccessRoleIds.AGENT_EDITOR,
        grantedBy: grantedById,
      });

      await service.grantPermission({
        principalType: PrincipalType.PUBLIC,
        principalId: null,
        resourceType: ResourceType.AGENT,
        resourceId: resourceToDelete,
        accessRoleId: AccessRoleIds.AGENT_VIEWER,
        grantedBy: grantedById,
      });
    });

    describe('validation', () => {
      test('should throw error for invalid resource type', async () => {
        await expect(
          service.removeAllPermissions({
            resourceType: 'invalid' as ResourceType,
            resourceId: resourceToDelete,
          }),
        ).rejects.toThrow('Invalid resourceType: invalid');
      });

      test('should throw error for invalid resource ID', async () => {
        await expect(
          service.removeAllPermissions({
            resourceType: ResourceType.AGENT,
            resourceId: 'invalid-id',
          }),
        ).rejects.toThrow('Invalid resource ID: invalid-id');
      });
    });

    describe('cleanup', () => {
      test('should delete all permissions for a resource', async () => {
        // Verify permissions exist
        const beforeCount = await AclEntry.countDocuments({
          resourceType: ResourceType.AGENT,
          resourceId: resourceToDelete,
        });
        expect(beforeCount).toBe(3);

        const result = await service.removeAllPermissions({
          resourceType: ResourceType.AGENT,
          resourceId: resourceToDelete,
        });

        expect(result.acknowledged).toBe(true);
        expect(result.deletedCount).toBe(3);

        // Verify permissions are deleted
        const afterCount = await AclEntry.countDocuments({
          resourceType: ResourceType.AGENT,
          resourceId: resourceToDelete,
        });
        expect(afterCount).toBe(0);
      });

      test('should return result even when no permissions existed', async () => {
        const newResourceId = new Types.ObjectId();

        const result = await service.removeAllPermissions({
          resourceType: ResourceType.AGENT,
          resourceId: newResourceId,
        });

        expect(result.acknowledged).toBe(true);
        expect(result.deletedCount).toBe(0);
      });

      test('should not affect other resources permissions', async () => {
        const otherResource = new Types.ObjectId();

        // Grant permission to another resource
        await service.grantPermission({
          principalType: PrincipalType.USER,
          principalId: userId,
          resourceType: ResourceType.AGENT,
          resourceId: otherResource,
          accessRoleId: AccessRoleIds.AGENT_VIEWER,
          grantedBy: grantedById,
        });

        await service.removeAllPermissions({
          resourceType: ResourceType.AGENT,
          resourceId: resourceToDelete,
        });

        // Verify other resource still has permissions
        const otherResourcePerms = await AclEntry.countDocuments({
          resourceType: ResourceType.AGENT,
          resourceId: otherResource,
        });
        expect(otherResourcePerms).toBe(1);
      });
    });
  });

  describe('hasPublicAccess', () => {
    const publicResource = new Types.ObjectId();
    const privateResource = new Types.ObjectId();

    beforeEach(async () => {
      await service.grantPermission({
        principalType: PrincipalType.PUBLIC,
        principalId: null,
        resourceType: ResourceType.AGENT,
        resourceId: publicResource,
        accessRoleId: AccessRoleIds.AGENT_VIEWER,
        grantedBy: grantedById,
      });

      await service.grantPermission({
        principalType: PrincipalType.USER,
        principalId: userId,
        resourceType: ResourceType.AGENT,
        resourceId: privateResource,
        accessRoleId: AccessRoleIds.AGENT_OWNER,
        grantedBy: grantedById,
      });
    });

    test('should return true for resource with PUBLIC AclEntry', async () => {
      const findPublicResourceIdsSpy = jest.spyOn(service['_dbMethods'], 'findPublicResourceIds');
      const result = await service.hasPublicAccess({
        resourceType: ResourceType.AGENT,
        resourceId: publicResource,
      });
      expect(result).toBe(true);
      expect(findPublicResourceIdsSpy).not.toHaveBeenCalled();
      findPublicResourceIdsSpy.mockRestore();
    });

    test('should return false for resource with only user AclEntry', async () => {
      const result = await service.hasPublicAccess({
        resourceType: ResourceType.AGENT,
        resourceId: privateResource,
      });
      expect(result).toBe(false);
    });

    test('should return false for non-existent resource', async () => {
      const result = await service.hasPublicAccess({
        resourceType: ResourceType.AGENT,
        resourceId: new Types.ObjectId(),
      });
      expect(result).toBe(false);
    });

    test('should return false for invalid resource type', async () => {
      const result = await service.hasPublicAccess({
        resourceType: 'invalid' as ResourceType,
        resourceId: publicResource,
      });
      expect(result).toBe(false);
    });
  });

  describe('checkPermission', () => {
    const testResource = new Types.ObjectId();
    const groupResource = new Types.ObjectId();

    beforeEach(async () => {
      // User has VIEW on testResource
      await service.grantPermission({
        principalType: PrincipalType.USER,
        principalId: userId,
        resourceType: ResourceType.AGENT,
        resourceId: testResource,
        accessRoleId: AccessRoleIds.AGENT_VIEWER,
        grantedBy: grantedById,
      });

      // Group has EDIT on groupResource
      await service.grantPermission({
        principalType: PrincipalType.GROUP,
        principalId: groupId,
        resourceType: ResourceType.AGENT,
        resourceId: groupResource,
        accessRoleId: AccessRoleIds.AGENT_EDITOR,
        grantedBy: grantedById,
      });
    });

    describe('validation', () => {
      test('should throw error when requiredPermission is not a positive number', async () => {
        await expect(
          service.checkPermission({
            userId: userId.toString(),
            resourceType: ResourceType.AGENT,
            resourceId: testResource,
            requiredPermission: 0,
          }),
        ).rejects.toThrow('requiredPermission must be a positive number');
      });

      test('should throw error when requiredPermission is negative', async () => {
        await expect(
          service.checkPermission({
            userId: userId.toString(),
            resourceType: ResourceType.AGENT,
            resourceId: testResource,
            requiredPermission: -1,
          }),
        ).rejects.toThrow('requiredPermission must be a positive number');
      });

      test('should return false for invalid resource type (error is caught)', async () => {
        // The service catches invalid resourceType errors and returns false
        const hasPermission = await service.checkPermission({
          userId: userId.toString(),
          resourceType: 'invalid' as ResourceType,
          resourceId: testResource,
          requiredPermission: 1,
        });

        expect(hasPermission).toBe(false);
      });
    });

    describe('permission scenarios', () => {
      test('should return true when user has required permission', async () => {
        mockGetUserPrincipals.mockResolvedValue([
          { principalType: PrincipalType.USER, principalId: userId },
        ]);

        const hasPermission = await service.checkPermission({
          userId: userId.toString(),
          resourceType: ResourceType.AGENT,
          resourceId: testResource,
          requiredPermission: 1, // VIEW
        });

        expect(hasPermission).toBe(true);
      });

      test('should return false when user lacks required permission', async () => {
        mockGetUserPrincipals.mockResolvedValue([
          { principalType: PrincipalType.USER, principalId: userId },
        ]);

        const hasPermission = await service.checkPermission({
          userId: userId.toString(),
          resourceType: ResourceType.AGENT,
          resourceId: testResource,
          requiredPermission: 3, // EDIT
        });

        expect(hasPermission).toBe(false);
      });

      test('should return false when no principals found', async () => {
        mockGetUserPrincipals.mockResolvedValue([]);

        const hasPermission = await service.checkPermission({
          userId: userId.toString(),
          resourceType: ResourceType.AGENT,
          resourceId: testResource,
          requiredPermission: 1,
        });

        expect(hasPermission).toBe(false);
      });

      test('should check permission via group membership', async () => {
        mockGetUserPrincipals.mockResolvedValue([
          { principalType: PrincipalType.USER, principalId: userId },
          { principalType: PrincipalType.GROUP, principalId: groupId },
        ]);

        const hasPermission = await service.checkPermission({
          userId: userId.toString(),
          resourceType: ResourceType.AGENT,
          resourceId: groupResource,
          requiredPermission: 1, // VIEW (editor includes view)
        });

        expect(hasPermission).toBe(true);
      });

      test('should return false for non-existent resource', async () => {
        mockGetUserPrincipals.mockResolvedValue([
          { principalType: PrincipalType.USER, principalId: userId },
        ]);

        const hasPermission = await service.checkPermission({
          userId: userId.toString(),
          resourceType: ResourceType.AGENT,
          resourceId: new Types.ObjectId(),
          requiredPermission: 1,
        });

        expect(hasPermission).toBe(false);
      });

      test('should pass role when provided for optimization', async () => {
        mockGetUserPrincipals.mockResolvedValue([
          { principalType: PrincipalType.USER, principalId: userId },
          { principalType: PrincipalType.ROLE, principalId: 'admin' },
        ]);

        await service.checkPermission({
          userId: userId.toString(),
          role: 'admin',
          resourceType: ResourceType.AGENT,
          resourceId: testResource,
          requiredPermission: 1,
        });

        expect(mockGetUserPrincipals).toHaveBeenCalledWith({
          userId: userId.toString(),
          role: 'admin',
        });
      });
    });

    describe('public access', () => {
      test('should check permission for public access', async () => {
        const publicResource = new Types.ObjectId();

        await service.grantPermission({
          principalType: PrincipalType.PUBLIC,
          principalId: null,
          resourceType: ResourceType.AGENT,
          resourceId: publicResource,
          accessRoleId: AccessRoleIds.AGENT_VIEWER,
          grantedBy: grantedById,
        });

        mockGetUserPrincipals.mockResolvedValue([
          { principalType: PrincipalType.USER, principalId: userId },
          { principalType: PrincipalType.PUBLIC },
        ]);

        const hasPermission = await service.checkPermission({
          userId: userId.toString(),
          resourceType: ResourceType.AGENT,
          resourceId: publicResource,
          requiredPermission: 1,
        });

        expect(hasPermission).toBe(true);
      });
    });
  });

  describe('validateResourceType (via public methods)', () => {
    test('should accept AGENT resource type', async () => {
      mockGetUserPrincipals.mockResolvedValue([]);

      const result = await service.findAccessibleResources({
        userId,
        resourceType: ResourceType.AGENT,
        requiredPermissions: 1,
      });

      expect(result).toEqual([]);
    });

    test('should accept PROMPTGROUP resource type', async () => {
      mockGetUserPrincipals.mockResolvedValue([]);

      const result = await service.findAccessibleResources({
        userId,
        resourceType: ResourceType.PROMPTGROUP,
        requiredPermissions: 1,
      });

      expect(result).toEqual([]);
    });

    test('should accept MCPSERVER resource type', async () => {
      mockGetUserPrincipals.mockResolvedValue([]);

      const result = await service.findAccessibleResources({
        userId,
        resourceType: ResourceType.MCPSERVER,
        requiredPermissions: 1,
      });

      expect(result).toEqual([]);
    });

    test('should return empty array for unknown resource type (error caught)', async () => {
      // findAccessibleResources catches invalid resource type and returns empty array
      const result = await service.findAccessibleResources({
        userId,
        resourceType: 'unknown_type' as ResourceType,
        requiredPermissions: 1,
      });

      expect(result).toEqual([]);
    });

    test('should return empty array for empty string resource type (error caught)', async () => {
      // findAccessibleResources catches invalid resource type and returns empty array
      const result = await service.findAccessibleResources({
        userId,
        resourceType: '' as ResourceType,
        requiredPermissions: 1,
      });

      expect(result).toEqual([]);
    });

    test('should throw for invalid resource type in grantPermission', async () => {
      // grantPermission throws directly for invalid resource type
      await expect(
        service.grantPermission({
          principalType: PrincipalType.USER,
          principalId: userId,
          resourceType: 'unknown_type' as ResourceType,
          resourceId,
          accessRoleId: AccessRoleIds.AGENT_VIEWER,
          grantedBy: grantedById,
        }),
      ).rejects.toThrow('Invalid resourceType: unknown_type');
    });

    test('should throw for empty string resource type in removeAllPermissions', async () => {
      // removeAllPermissions throws directly for invalid resource type
      await expect(
        service.removeAllPermissions({
          resourceType: '' as ResourceType,
          resourceId,
        }),
      ).rejects.toThrow('Invalid resourceType:');
    });
  });
});
