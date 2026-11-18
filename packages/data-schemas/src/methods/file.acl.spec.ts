import mongoose from 'mongoose';
import { v4 as uuidv4 } from 'uuid';
import { MongoMemoryServer } from 'mongodb-memory-server';
import {
  ResourceType,
  AccessRoleIds,
  PrincipalType,
  PermissionBits,
} from 'librechat-data-provider';
import type { AccessRole as TAccessRole, AclEntry as TAclEntry } from '..';
import type { Types } from 'mongoose';
import { createAclEntryMethods } from './aclEntry';
import { createModels } from '../models';
import { createMethods } from './index';

/** Lean access role object from .lean() */
type LeanAccessRole = TAccessRole & { _id: mongoose.Types.ObjectId };

/** Lean ACL entry from .lean() */
type LeanAclEntry = TAclEntry & { _id: mongoose.Types.ObjectId };

/** Tool resources shape for agent file access */
type AgentToolResources = {
  file_search?: { file_ids?: string[] };
  code_interpreter?: { file_ids?: string[] };
};

let File: mongoose.Model<unknown>;
let Agent: mongoose.Model<unknown>;
let AclEntry: mongoose.Model<unknown>;
let AccessRole: mongoose.Model<unknown>;
let User: mongoose.Model<unknown>;
let methods: ReturnType<typeof createMethods>;
let aclMethods: ReturnType<typeof createAclEntryMethods>;

describe('File Access Control', () => {
  let mongoServer: MongoMemoryServer;

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    const mongoUri = mongoServer.getUri();
    await mongoose.connect(mongoUri);

    createModels(mongoose);
    File = mongoose.models.File;
    Agent = mongoose.models.Agent;
    AclEntry = mongoose.models.AclEntry;
    AccessRole = mongoose.models.AccessRole;
    User = mongoose.models.User;

    methods = createMethods(mongoose);
    aclMethods = createAclEntryMethods(mongoose);

    // Seed default access roles
    await methods.seedDefaultRoles();
  });

  afterAll(async () => {
    const collections = mongoose.connection.collections;
    for (const key in collections) {
      await collections[key].deleteMany({});
    }
    await mongoose.disconnect();
    await mongoServer?.stop();
  });

  beforeEach(async () => {
    await File.deleteMany({});
    await Agent.deleteMany({});
    await AclEntry.deleteMany({});
    await User.deleteMany({});
  });

  describe('File ACL entry operations', () => {
    it('should create ACL entries for agent file access', async () => {
      const userId = new mongoose.Types.ObjectId();
      const authorId = new mongoose.Types.ObjectId();
      const agentId = uuidv4();
      const fileIds = [uuidv4(), uuidv4(), uuidv4(), uuidv4()];

      // Create users
      await User.create({
        _id: userId,
        email: 'user@example.com',
        emailVerified: true,
        provider: 'local',
      });

      await User.create({
        _id: authorId,
        email: 'author@example.com',
        emailVerified: true,
        provider: 'local',
      });

      // Create files
      for (const fileId of fileIds) {
        await methods.createFile({
          user: authorId,
          file_id: fileId,
          filename: `file-${fileId}.txt`,
          filepath: `/uploads/${fileId}`,
        });
      }

      // Create agent with only first two files attached
      const agent = await methods.createAgent({
        id: agentId,
        name: 'Test Agent',
        author: authorId,
        model: 'gpt-4',
        provider: 'openai',
        tool_resources: {
          file_search: {
            file_ids: [fileIds[0], fileIds[1]],
          },
        },
      });

      // Grant EDIT permission to user on the agent
      const editorRole = (await AccessRole.findOne({
        accessRoleId: AccessRoleIds.AGENT_EDITOR,
      }).lean()) as LeanAccessRole | null;

      if (editorRole) {
        await aclMethods.grantPermission(
          PrincipalType.USER,
          userId,
          ResourceType.AGENT,
          agent._id as string | Types.ObjectId,
          editorRole.permBits,
          authorId,
          undefined,
          editorRole._id,
        );
      }

      // Verify ACL entry exists for the user
      const aclEntry = (await AclEntry.findOne({
        principalType: PrincipalType.USER,
        principalId: userId,
        resourceType: ResourceType.AGENT,
        resourceId: agent._id,
      }).lean()) as LeanAclEntry | null;

      expect(aclEntry).toBeTruthy();

      // Check that agent has correct file_ids in tool_resources
      const agentRecord = await methods.getAgent({ id: agentId });
      const toolResources = agentRecord?.tool_resources as AgentToolResources | undefined;
      expect(toolResources?.file_search?.file_ids).toContain(fileIds[0]);
      expect(toolResources?.file_search?.file_ids).toContain(fileIds[1]);
      expect(toolResources?.file_search?.file_ids).not.toContain(fileIds[2]);
      expect(toolResources?.file_search?.file_ids).not.toContain(fileIds[3]);
    });

    it('should grant access to agent author via ACL', async () => {
      const authorId = new mongoose.Types.ObjectId();
      const agentId = uuidv4();

      await User.create({
        _id: authorId,
        email: 'author@example.com',
        emailVerified: true,
        provider: 'local',
      });

      const agent = await methods.createAgent({
        id: agentId,
        name: 'Test Agent',
        author: authorId,
        model: 'gpt-4',
        provider: 'openai',
      });

      // Grant owner permissions
      const ownerRole = (await AccessRole.findOne({
        accessRoleId: AccessRoleIds.AGENT_OWNER,
      }).lean()) as LeanAccessRole | null;

      if (ownerRole) {
        await aclMethods.grantPermission(
          PrincipalType.USER,
          authorId,
          ResourceType.AGENT,
          agent._id as string | Types.ObjectId,
          ownerRole.permBits,
          authorId,
          undefined,
          ownerRole._id,
        );
      }

      // Author should have full permission bits on the agent
      const hasView = await aclMethods.hasPermission(
        [{ principalType: PrincipalType.USER, principalId: authorId }],
        ResourceType.AGENT,
        agent._id as string | Types.ObjectId,
        PermissionBits.VIEW,
      );

      const hasEdit = await aclMethods.hasPermission(
        [{ principalType: PrincipalType.USER, principalId: authorId }],
        ResourceType.AGENT,
        agent._id as string | Types.ObjectId,
        PermissionBits.EDIT,
      );

      expect(hasView).toBe(true);
      expect(hasEdit).toBe(true);
    });

    it('should deny access when no ACL entry exists', async () => {
      const userId = new mongoose.Types.ObjectId();
      const agentId = new mongoose.Types.ObjectId();

      const hasAccess = await aclMethods.hasPermission(
        [{ principalType: PrincipalType.USER, principalId: userId }],
        ResourceType.AGENT,
        agentId,
        PermissionBits.VIEW,
      );

      expect(hasAccess).toBe(false);
    });

    it('should deny EDIT when user only has VIEW permission', async () => {
      const userId = new mongoose.Types.ObjectId();
      const authorId = new mongoose.Types.ObjectId();
      const agentId = uuidv4();

      await User.create({
        _id: userId,
        email: 'user@example.com',
        emailVerified: true,
        provider: 'local',
      });

      await User.create({
        _id: authorId,
        email: 'author@example.com',
        emailVerified: true,
        provider: 'local',
      });

      const agent = await methods.createAgent({
        id: agentId,
        name: 'View-Only Agent',
        author: authorId,
        model: 'gpt-4',
        provider: 'openai',
      });

      // Grant only VIEW permission
      const viewerRole = (await AccessRole.findOne({
        accessRoleId: AccessRoleIds.AGENT_VIEWER,
      }).lean()) as LeanAccessRole | null;

      if (viewerRole) {
        await aclMethods.grantPermission(
          PrincipalType.USER,
          userId,
          ResourceType.AGENT,
          agent._id as string | Types.ObjectId,
          viewerRole.permBits,
          authorId,
          undefined,
          viewerRole._id,
        );
      }

      const canView = await aclMethods.hasPermission(
        [{ principalType: PrincipalType.USER, principalId: userId }],
        ResourceType.AGENT,
        agent._id as string | Types.ObjectId,
        PermissionBits.VIEW,
      );

      const canEdit = await aclMethods.hasPermission(
        [{ principalType: PrincipalType.USER, principalId: userId }],
        ResourceType.AGENT,
        agent._id as string | Types.ObjectId,
        PermissionBits.EDIT,
      );

      expect(canView).toBe(true);
      expect(canEdit).toBe(false);
    });

    it('should support role-based permission grants', async () => {
      const userId = new mongoose.Types.ObjectId();
      const authorId = new mongoose.Types.ObjectId();
      const agentId = uuidv4();

      await User.create({
        _id: userId,
        email: 'user@example.com',
        emailVerified: true,
        provider: 'local',
        role: 'ADMIN',
      });

      await User.create({
        _id: authorId,
        email: 'author@example.com',
        emailVerified: true,
        provider: 'local',
      });

      const agent = await methods.createAgent({
        id: agentId,
        name: 'Test Agent',
        author: authorId,
        model: 'gpt-4',
        provider: 'openai',
      });

      // Grant permission to ADMIN role
      const editorRole = (await AccessRole.findOne({
        accessRoleId: AccessRoleIds.AGENT_EDITOR,
      }).lean()) as LeanAccessRole | null;

      if (editorRole) {
        await aclMethods.grantPermission(
          PrincipalType.ROLE,
          'ADMIN',
          ResourceType.AGENT,
          agent._id as string | Types.ObjectId,
          editorRole.permBits,
          authorId,
          undefined,
          editorRole._id,
        );
      }

      // User with ADMIN role should have access through role-based ACL
      const hasAccess = await aclMethods.hasPermission(
        [
          { principalType: PrincipalType.USER, principalId: userId },
          {
            principalType: PrincipalType.ROLE,
            principalId: 'ADMIN' as unknown as mongoose.Types.ObjectId,
          },
        ],
        ResourceType.AGENT,
        agent._id as string | Types.ObjectId,
        PermissionBits.VIEW,
      );

      expect(hasAccess).toBe(true);
    });
  });

  describe('getFiles with file queries', () => {
    it('should return files created by user', async () => {
      const userId = new mongoose.Types.ObjectId();
      const fileId1 = `file_${uuidv4()}`;
      const fileId2 = `file_${uuidv4()}`;

      await methods.createFile({
        file_id: fileId1,
        user: userId,
        filename: 'file1.txt',
        filepath: '/uploads/file1.txt',
        type: 'text/plain',
        bytes: 100,
      });

      await methods.createFile({
        file_id: fileId2,
        user: new mongoose.Types.ObjectId(),
        filename: 'file2.txt',
        filepath: '/uploads/file2.txt',
        type: 'text/plain',
        bytes: 200,
      });

      const files = await methods.getFiles({ file_id: { $in: [fileId1, fileId2] } });
      expect(files).toHaveLength(2);
    });

    it('should return all files matching query', async () => {
      const userId = new mongoose.Types.ObjectId();
      const fileId1 = `file_${uuidv4()}`;
      const fileId2 = `file_${uuidv4()}`;

      await methods.createFile({
        file_id: fileId1,
        user: userId,
        filename: 'file1.txt',
        filepath: '/uploads/file1.txt',
      });

      await methods.createFile({
        file_id: fileId2,
        user: userId,
        filename: 'file2.txt',
        filepath: '/uploads/file2.txt',
      });

      const files = await methods.getFiles({ user: userId });
      expect(files).toHaveLength(2);
    });
  });
});
