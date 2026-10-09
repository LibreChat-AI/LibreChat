import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { AccessRoleIds, ResourceType, PermissionBits } from 'librechat-data-provider';
import type * as t from '~/types';
import { createAccessRoleMethods } from './accessRole';
import accessRoleSchema from '~/schema/accessRole';
import { RoleBits } from '~/common';

let mongoServer: MongoMemoryServer;
let AccessRole: mongoose.Model<t.IAccessRole>;
let methods: ReturnType<typeof createAccessRoleMethods>;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  const mongoUri = mongoServer.getUri();
  AccessRole = mongoose.models.AccessRole || mongoose.model('AccessRole', accessRoleSchema);
  methods = createAccessRoleMethods(mongoose);
  await mongoose.connect(mongoUri);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

beforeEach(async () => {
  await mongoose.connection.dropDatabase();
});

describe('AccessRole Model Tests', () => {
  describe('Basic CRUD Operations', () => {
    const sampleRole: t.AccessRole = {
      accessRoleId: 'test_viewer',
      name: 'Test Viewer',
      description: 'Test role for viewer permissions',
      resourceType: ResourceType.AGENT,
      permBits: RoleBits.VIEWER,
    };

    test('should create a new role', async () => {
      const role = await methods.createRole(sampleRole);

      expect(role).toBeDefined();
      expect(role.accessRoleId).toBe(sampleRole.accessRoleId);
      expect(role.name).toBe(sampleRole.name);
      expect(role.permBits).toBe(sampleRole.permBits);
    });

    test('should create a code environment role', async () => {
      const role = await methods.createRole({
        accessRoleId: AccessRoleIds.CODE_ENVIRONMENT_OWNER,
        name: 'Code Environment Owner',
        resourceType: ResourceType.CODE_ENVIRONMENT,
        permBits: PermissionBits.VIEW | PermissionBits.EDIT | PermissionBits.DELETE,
      });

      expect(role.resourceType).toBe(ResourceType.CODE_ENVIRONMENT);
    });

    test('should find a role by its ID', async () => {
      const createdRole = await methods.createRole(sampleRole);
      const foundRole = await methods.findRoleById(createdRole._id);

      expect(foundRole).toBeDefined();
      expect(foundRole?._id.toString()).toBe(createdRole._id.toString());
      expect(foundRole?.accessRoleId).toBe(sampleRole.accessRoleId);
    });

    test('should find a role by its identifier', async () => {
      await methods.createRole(sampleRole);
      const foundRole = await methods.findRoleByIdentifier(sampleRole.accessRoleId);

      expect(foundRole).toBeDefined();
      expect(foundRole?.accessRoleId).toBe(sampleRole.accessRoleId);
      expect(foundRole?.name).toBe(sampleRole.name);
    });

    test('should update an existing role', async () => {
      await methods.createRole(sampleRole);

      const updatedData = {
        name: 'Updated Test Role',
        description: 'Updated description',
      };

      const updatedRole = await methods.updateRole(sampleRole.accessRoleId, updatedData);

      expect(updatedRole).toBeDefined();
      expect(updatedRole?.name).toBe(updatedData.name);
      expect(updatedRole?.description).toBe(updatedData.description);
      // Check that other fields remain unchanged
      expect(updatedRole?.accessRoleId).toBe(sampleRole.accessRoleId);
      expect(updatedRole?.permBits).toBe(sampleRole.permBits);
    });

    test('should delete a role', async () => {
      await methods.createRole(sampleRole);

      const deleteResult = await methods.deleteRole(sampleRole.accessRoleId);
      expect(deleteResult.deletedCount).toBe(1);

      const foundRole = await methods.findRoleByIdentifier(sampleRole.accessRoleId);
      expect(foundRole).toBeNull();
    });

    test('should get all roles', async () => {
      const roles = [
        sampleRole,
        {
          accessRoleId: 'test_editor',
          name: 'Test Editor',
          description: 'Test role for editor permissions',
          resourceType: ResourceType.AGENT,
          permBits: RoleBits.EDITOR,
        },
      ];

      await Promise.all(roles.map((role) => methods.createRole(role)));

      const allRoles = await methods.getAllRoles();
      expect(allRoles).toHaveLength(2);
      expect(allRoles.map((r) => r.accessRoleId).sort()).toEqual(
        ['test_editor', 'test_viewer'].sort(),
      );
    });
  });

  describe('Resource and Permission Queries', () => {
    beforeEach(async () => {
      await AccessRole.deleteMany({});

      // Create sample roles for testing
      await Promise.all([
        methods.createRole({
          accessRoleId: AccessRoleIds.AGENT_VIEWER,
          name: 'Agent Viewer',
          description: 'Can view agents',
          resourceType: ResourceType.AGENT,
          permBits: RoleBits.VIEWER,
        }),
        methods.createRole({
          accessRoleId: AccessRoleIds.AGENT_EDITOR,
          name: 'Agent Editor',
          description: 'Can edit agents',
          resourceType: ResourceType.AGENT,
          permBits: RoleBits.EDITOR,
        }),
        methods.createRole({
          accessRoleId: 'project_viewer',
          name: 'Project Viewer',
          description: 'Can view projects',
          resourceType: 'project',
          permBits: RoleBits.VIEWER,
        }),
        methods.createRole({
          accessRoleId: 'project_editor',
          name: 'Project Editor',
          description: 'Can edit projects',
          resourceType: 'project',
          permBits: RoleBits.EDITOR,
        }),
      ]);
    });

    test('should find roles by resource type', async () => {
      const agentRoles = await methods.findRolesByResourceType('agent');
      expect(agentRoles).toHaveLength(2);
      expect(agentRoles.map((r) => r.accessRoleId).sort()).toEqual(
        [AccessRoleIds.AGENT_EDITOR, AccessRoleIds.AGENT_VIEWER].sort(),
      );

      const projectRoles = await methods.findRolesByResourceType('project');
      expect(projectRoles).toHaveLength(2);
      expect(projectRoles.map((r) => r.accessRoleId).sort()).toEqual(
        ['project_editor', 'project_viewer'].sort(),
      );
    });

    test('should find role by permissions', async () => {
      const viewerRole = await methods.findRoleByPermissions('agent', RoleBits.VIEWER);
      expect(viewerRole).toBeDefined();
      expect(viewerRole?.accessRoleId).toBe(AccessRoleIds.AGENT_VIEWER);

      const editorRole = await methods.findRoleByPermissions('agent', RoleBits.EDITOR);
      expect(editorRole).toBeDefined();
      expect(editorRole?.accessRoleId).toBe(AccessRoleIds.AGENT_EDITOR);
    });

    test('should return null when no role matches the permissions', async () => {
      // Create a custom permission that doesn't match any existing role
      const customPerm = PermissionBits.VIEW | PermissionBits.SHARE;
      const role = await methods.findRoleByPermissions('agent', customPerm);
      expect(role).toBeNull();
    });
  });

  describe('seedDefaultRoles', () => {
    beforeEach(async () => {
      await AccessRole.deleteMany({});
    });

    test('should seed default roles', async () => {
      const result = await methods.seedDefaultRoles();

      // Verify the result contains the default roles
      expect(Object.keys(result).sort()).toEqual(
        [
          AccessRoleIds.AGENT_EDITOR,
          AccessRoleIds.AGENT_OWNER,
          AccessRoleIds.AGENT_VIEWER,
          AccessRoleIds.CODE_ENVIRONMENT_EDITOR,
          AccessRoleIds.CODE_ENVIRONMENT_OWNER,
          AccessRoleIds.CODE_ENVIRONMENT_VIEWER,
          AccessRoleIds.PROMPTGROUP_EDITOR,
          AccessRoleIds.PROMPTGROUP_OWNER,
          AccessRoleIds.PROMPTGROUP_VIEWER,
          AccessRoleIds.MCPSERVER_EDITOR,
          AccessRoleIds.MCPSERVER_OWNER,
          AccessRoleIds.MCPSERVER_VIEWER,
          AccessRoleIds.REMOTE_AGENT_EDITOR,
          AccessRoleIds.REMOTE_AGENT_OWNER,
          AccessRoleIds.REMOTE_AGENT_VIEWER,
          AccessRoleIds.SHARED_LINK_OWNER,
          AccessRoleIds.SHARED_LINK_VIEWER,
          AccessRoleIds.SKILL_EDITOR,
          AccessRoleIds.SKILL_OWNER,
          AccessRoleIds.SKILL_VIEWER,
        ].sort(),
      );

      // Verify each role exists in the database
      const agentViewerRole = await methods.findRoleByIdentifier(AccessRoleIds.AGENT_VIEWER);
      expect(agentViewerRole).toBeDefined();
      expect(agentViewerRole?.permBits).toBe(RoleBits.VIEWER);

      const agentEditorRole = await methods.findRoleByIdentifier(AccessRoleIds.AGENT_EDITOR);
      expect(agentEditorRole).toBeDefined();
      expect(agentEditorRole?.permBits).toBe(RoleBits.EDITOR);

      const agentOwnerRole = await methods.findRoleByIdentifier(AccessRoleIds.AGENT_OWNER);
      expect(agentOwnerRole).toBeDefined();
      expect(agentOwnerRole?.permBits).toBe(RoleBits.OWNER);
    });

    test('should not modify existing roles when seeding', async () => {
      // Create a modified version of a default role
      const customRole = {
        accessRoleId: AccessRoleIds.AGENT_VIEWER,
        name: 'Custom Viewer',
        description: 'Custom viewer description',
        resourceType: ResourceType.AGENT,
        permBits: RoleBits.VIEWER,
      };

      await methods.createRole(customRole);

      // Seed default roles
      await methods.seedDefaultRoles();

      // Verify the custom role was not modified
      const role = await methods.findRoleByIdentifier(AccessRoleIds.AGENT_VIEWER);
      expect(role?.name).toBe(customRole.name);
      expect(role?.description).toBe(customRole.description);
    });
  });

  describe('getRoleForPermissions', () => {
    beforeEach(async () => {
      await AccessRole.deleteMany({});

      // Create sample roles with ascending permission levels
      await Promise.all([
        methods.createRole({
          accessRoleId: AccessRoleIds.AGENT_VIEWER,
          name: 'Agent Viewer',
          resourceType: ResourceType.AGENT,
          permBits: RoleBits.VIEWER, // 1
        }),
        methods.createRole({
          accessRoleId: AccessRoleIds.AGENT_EDITOR,
          name: 'Agent Editor',
          resourceType: ResourceType.AGENT,
          permBits: RoleBits.EDITOR, // 3
        }),
        methods.createRole({
          accessRoleId: 'agent_manager',
          name: 'Agent Manager',
          resourceType: ResourceType.AGENT,
          permBits: RoleBits.MANAGER, // 7
        }),
        methods.createRole({
          accessRoleId: AccessRoleIds.AGENT_OWNER,
          name: 'Agent Owner',
          resourceType: ResourceType.AGENT,
          permBits: RoleBits.OWNER, // 15
        }),
      ]);
    });

    test('should find exact matching role', async () => {
      const role = await methods.getRoleForPermissions('agent', RoleBits.EDITOR);
      expect(role).toBeDefined();
      expect(role?.accessRoleId).toBe(AccessRoleIds.AGENT_EDITOR);
      expect(role?.permBits).toBe(RoleBits.EDITOR);
    });

    test('should find closest compatible role without exceeding permissions', async () => {
      // Create a custom permission between VIEWER and EDITOR
      const customPerm = PermissionBits.VIEW | PermissionBits.SHARE; // 9

      // Should return VIEWER (1) as closest matching role without exceeding the permission bits
      const role = await methods.getRoleForPermissions('agent', customPerm);
      expect(role).toBeDefined();
      expect(role?.accessRoleId).toBe(AccessRoleIds.AGENT_VIEWER);
    });

    test('should return null when no compatible role is found', async () => {
      // Create a permission that doesn't match any existing permission pattern
      const invalidPerm = 100;

      const role = await methods.getRoleForPermissions('agent', invalidPerm as PermissionBits);
      expect(role).toBeNull();
    });

    test('should find role for resource-specific permissions', async () => {
      // Create a role for a different resource type
      await methods.createRole({
        accessRoleId: 'project_viewer',
        name: 'Project Viewer',
        resourceType: 'project',
        permBits: RoleBits.VIEWER,
      });

      // Query for agent roles
      const agentRole = await methods.getRoleForPermissions('agent', RoleBits.VIEWER);
      expect(agentRole).toBeDefined();
      expect(agentRole?.accessRoleId).toBe(AccessRoleIds.AGENT_VIEWER);

      // Query for project roles
      const projectRole = await methods.getRoleForPermissions('project', RoleBits.VIEWER);
      expect(projectRole).toBeDefined();
      expect(projectRole?.accessRoleId).toBe('project_viewer');
    });
  });
});
