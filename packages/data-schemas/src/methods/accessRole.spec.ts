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
});
