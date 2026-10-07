import mongoose from 'mongoose';
import { ObjectId } from 'mongodb';
import { logger, createModels } from '..';
import { MongoMemoryServer } from 'mongodb-memory-server';
import {
  SystemRoles,
  ResourceType,
  AccessRoleIds,
  PrincipalType,
  PermissionBits,
} from 'librechat-data-provider';
import type { IPromptGroup, AccessRole as TAccessRole, AclEntry as TAclEntry } from '..';
import { createAclEntryMethods } from './aclEntry';
import { createMethods } from './index';

// Disable console for tests
logger.silent = true;

/** Lean user object from .toObject() */
type LeanUser = {
  _id: mongoose.Types.ObjectId | string;
  name?: string;
  email: string;
  role?: string;
};

/** Lean group object from .toObject() */
type LeanGroup = {
  _id: mongoose.Types.ObjectId | string;
  name: string;
  description?: string;
};

/** Lean access role object from .toObject() / .lean() */
type LeanAccessRole = TAccessRole & { _id: mongoose.Types.ObjectId | string };

/** Lean ACL entry from .lean() */
type LeanAclEntry = TAclEntry & { _id: mongoose.Types.ObjectId | string };

/** Lean prompt group from .toObject() */
type LeanPromptGroup = IPromptGroup & { _id: mongoose.Types.ObjectId | string };

let Prompt: mongoose.Model<unknown>;
let PromptGroup: mongoose.Model<unknown>;
let AclEntry: mongoose.Model<unknown>;
let AccessRole: mongoose.Model<unknown>;
let User: mongoose.Model<unknown>;
let Group: mongoose.Model<unknown>;
let methods: ReturnType<typeof createMethods>;
let aclMethods: ReturnType<typeof createAclEntryMethods>;
let testUsers: Record<string, LeanUser>;
let testGroups: Record<string, LeanGroup>;
let testRoles: Record<string, LeanAccessRole>;

let mongoServer: MongoMemoryServer;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  const mongoUri = mongoServer.getUri();
  await mongoose.connect(mongoUri);

  createModels(mongoose);
  Prompt = mongoose.models.Prompt;
  PromptGroup = mongoose.models.PromptGroup;
  AclEntry = mongoose.models.AclEntry;
  AccessRole = mongoose.models.AccessRole;
  User = mongoose.models.User;
  Group = mongoose.models.Group;

  methods = createMethods(mongoose, {
    removeAllPermissions: async ({ resourceType, resourceId }) => {
      await AclEntry.deleteMany({ resourceType, resourceId });
    },
  });
  aclMethods = createAclEntryMethods(mongoose);

  await setupTestData();
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

async function setupTestData() {
  testRoles = {
    viewer: (
      await AccessRole.create({
        accessRoleId: AccessRoleIds.PROMPTGROUP_VIEWER,
        name: 'Viewer',
        description: 'Can view promptGroups',
        resourceType: ResourceType.PROMPTGROUP,
        permBits: PermissionBits.VIEW,
      })
    ).toObject() as unknown as LeanAccessRole,
    editor: (
      await AccessRole.create({
        accessRoleId: AccessRoleIds.PROMPTGROUP_EDITOR,
        name: 'Editor',
        description: 'Can view and edit promptGroups',
        resourceType: ResourceType.PROMPTGROUP,
        permBits: PermissionBits.VIEW | PermissionBits.EDIT,
      })
    ).toObject() as unknown as LeanAccessRole,
    owner: (
      await AccessRole.create({
        accessRoleId: AccessRoleIds.PROMPTGROUP_OWNER,
        name: 'Owner',
        description: 'Full control over promptGroups',
        resourceType: ResourceType.PROMPTGROUP,
        permBits:
          PermissionBits.VIEW | PermissionBits.EDIT | PermissionBits.DELETE | PermissionBits.SHARE,
      })
    ).toObject() as unknown as LeanAccessRole,
  };

  testUsers = {
    owner: (
      await User.create({
        name: 'Prompt Owner',
        email: 'owner@example.com',
        role: SystemRoles.USER,
      })
    ).toObject() as unknown as LeanUser,
    editor: (
      await User.create({
        name: 'Prompt Editor',
        email: 'editor@example.com',
        role: SystemRoles.USER,
      })
    ).toObject() as unknown as LeanUser,
    viewer: (
      await User.create({
        name: 'Prompt Viewer',
        email: 'viewer@example.com',
        role: SystemRoles.USER,
      })
    ).toObject() as unknown as LeanUser,
    admin: (
      await User.create({
        name: 'Admin User',
        email: 'admin@example.com',
        role: SystemRoles.ADMIN,
      })
    ).toObject() as unknown as LeanUser,
    noAccess: (
      await User.create({
        name: 'No Access User',
        email: 'noaccess@example.com',
        role: SystemRoles.USER,
      })
    ).toObject() as unknown as LeanUser,
  };

  testGroups = {
    editors: (
      await Group.create({
        name: 'Prompt Editors',
        description: 'Group with editor access',
      })
    ).toObject() as unknown as LeanGroup,
    viewers: (
      await Group.create({
        name: 'Prompt Viewers',
        description: 'Group with viewer access',
      })
    ).toObject() as unknown as LeanGroup,
  };
}

/** Helper: grant permission via direct AclEntry.create */
async function grantPermission(params: {
  principalType: string;
  principalId: mongoose.Types.ObjectId | string;
  resourceType: string;
  resourceId: mongoose.Types.ObjectId | string;
  accessRoleId: string;
  grantedBy: mongoose.Types.ObjectId | string;
}) {
  const role = (await AccessRole.findOne({
    accessRoleId: params.accessRoleId,
  }).lean()) as LeanAccessRole | null;
  if (!role) {
    throw new Error(`AccessRole ${params.accessRoleId} not found`);
  }
  return aclMethods.grantPermission(
    params.principalType,
    params.principalId,
    params.resourceType,
    params.resourceId,
    role.permBits,
    params.grantedBy,
    undefined,
    role._id,
  );
}

/** Helper: check permission via getUserPrincipals + hasPermission */
async function checkPermission(params: {
  userId: mongoose.Types.ObjectId | string;
  resourceType: string;
  resourceId: mongoose.Types.ObjectId | string;
  requiredPermission: number;
  includePublic?: boolean;
}) {
  // getUserPrincipals already includes user, role, groups, and public
  const principals = await methods.getUserPrincipals({
    userId: params.userId,
  });

  // If not including public, filter it out
  const filteredPrincipals = params.includePublic
    ? principals
    : principals.filter((p) => p.principalType !== PrincipalType.PUBLIC);

  return aclMethods.hasPermission(
    filteredPrincipals,
    params.resourceType,
    params.resourceId,
    params.requiredPermission,
  );
}

describe('Prompt ACL Permissions', () => {
  describe('Creating Prompts with Permissions', () => {
    it('should grant owner permissions when creating a prompt', async () => {
      const testGroup = (
        await PromptGroup.create({
          name: 'Test Group',
          category: 'testing',
          author: testUsers.owner._id,
          authorName: testUsers.owner.name,
          productionId: new mongoose.Types.ObjectId(),
        })
      ).toObject() as unknown as LeanPromptGroup;

      const promptData = {
        prompt: {
          prompt: 'Test prompt content',
          name: 'Test Prompt',
          type: 'text',
          groupId: testGroup._id,
        },
        author: testUsers.owner._id,
      };

      await methods.savePrompt(promptData);

      // Grant owner permission
      await grantPermission({
        principalType: PrincipalType.USER,
        principalId: testUsers.owner._id,
        resourceType: ResourceType.PROMPTGROUP,
        resourceId: testGroup._id,
        accessRoleId: AccessRoleIds.PROMPTGROUP_OWNER,
        grantedBy: testUsers.owner._id,
      });

      // Check ACL entry
      const aclEntry = (await AclEntry.findOne({
        resourceType: ResourceType.PROMPTGROUP,
        resourceId: testGroup._id,
        principalType: PrincipalType.USER,
        principalId: testUsers.owner._id,
      }).lean()) as LeanAclEntry | null;

      expect(aclEntry).toBeTruthy();
      expect(aclEntry!.permBits).toBe(testRoles.owner.permBits);
    });
  });

  describe('Accessing Prompts', () => {
    let testPromptGroup: LeanPromptGroup;

    beforeEach(async () => {
      testPromptGroup = (
        await PromptGroup.create({
          name: 'Test Group',
          author: testUsers.owner._id,
          authorName: testUsers.owner.name,
          productionId: new ObjectId(),
        })
      ).toObject() as unknown as LeanPromptGroup;

      await Prompt.create({
        prompt: 'Test prompt for access control',
        name: 'Access Test Prompt',
        author: testUsers.owner._id,
        groupId: testPromptGroup._id,
        type: 'text',
      });

      await grantPermission({
        principalType: PrincipalType.USER,
        principalId: testUsers.owner._id,
        resourceType: ResourceType.PROMPTGROUP,
        resourceId: testPromptGroup._id,
        accessRoleId: AccessRoleIds.PROMPTGROUP_OWNER,
        grantedBy: testUsers.owner._id,
      });
    });

    afterEach(async () => {
      await Prompt.deleteMany({});
      await PromptGroup.deleteMany({});
      await AclEntry.deleteMany({});
    });

    it('owner should have full access to their prompt', async () => {
      const hasAccess = await checkPermission({
        userId: testUsers.owner._id,
        resourceType: ResourceType.PROMPTGROUP,
        resourceId: testPromptGroup._id,
        requiredPermission: PermissionBits.VIEW,
      });

      expect(hasAccess).toBe(true);

      const canEdit = await checkPermission({
        userId: testUsers.owner._id,
        resourceType: ResourceType.PROMPTGROUP,
        resourceId: testPromptGroup._id,
        requiredPermission: PermissionBits.EDIT,
      });

      expect(canEdit).toBe(true);
    });

    it('user with viewer role should only have view access', async () => {
      await grantPermission({
        principalType: PrincipalType.USER,
        principalId: testUsers.viewer._id,
        resourceType: ResourceType.PROMPTGROUP,
        resourceId: testPromptGroup._id,
        accessRoleId: AccessRoleIds.PROMPTGROUP_VIEWER,
        grantedBy: testUsers.owner._id,
      });

      const canView = await checkPermission({
        userId: testUsers.viewer._id,
        resourceType: ResourceType.PROMPTGROUP,
        resourceId: testPromptGroup._id,
        requiredPermission: PermissionBits.VIEW,
      });

      const canEdit = await checkPermission({
        userId: testUsers.viewer._id,
        resourceType: ResourceType.PROMPTGROUP,
        resourceId: testPromptGroup._id,
        requiredPermission: PermissionBits.EDIT,
      });

      expect(canView).toBe(true);
      expect(canEdit).toBe(false);
    });

    it('user without permissions should have no access', async () => {
      const hasAccess = await checkPermission({
        userId: testUsers.noAccess._id,
        resourceType: ResourceType.PROMPTGROUP,
        resourceId: testPromptGroup._id,
        requiredPermission: PermissionBits.VIEW,
      });

      expect(hasAccess).toBe(false);
    });

    it('admin should have access regardless of permissions', async () => {
      // Admin users should work through normal permission system
      // The middleware layer handles admin bypass, not the permission service
      const hasAccess = await checkPermission({
        userId: testUsers.admin._id,
        resourceType: ResourceType.PROMPTGROUP,
        resourceId: testPromptGroup._id,
        requiredPermission: PermissionBits.VIEW,
      });

      // Without explicit permissions, even admin won't have access at this layer
      expect(hasAccess).toBe(false);

      // The actual admin bypass happens in the middleware layer
    });
  });

  describe('Group-based Access', () => {
    afterEach(async () => {
      await Prompt.deleteMany({});
      await AclEntry.deleteMany({});
      await User.updateMany({}, { $set: { groups: [] } });
    });

    it('group members should inherit group permissions', async () => {
      const testPromptGroup = (
        await PromptGroup.create({
          name: 'Group Test Group',
          author: testUsers.owner._id,
          authorName: testUsers.owner.name,
          productionId: new ObjectId(),
        })
      ).toObject() as unknown as LeanPromptGroup;

      // Add user to group
      await methods.addUserToGroup(testUsers.editor._id, testGroups.editors._id);

      await methods.savePrompt({
        author: testUsers.owner._id,
        prompt: {
          prompt: 'Group test prompt',
          name: 'Group Test',
          groupId: testPromptGroup._id,
          type: 'text',
        },
      });

      // Grant edit permissions to the group
      await grantPermission({
        principalType: PrincipalType.GROUP,
        principalId: testGroups.editors._id,
        resourceType: ResourceType.PROMPTGROUP,
        resourceId: testPromptGroup._id,
        accessRoleId: AccessRoleIds.PROMPTGROUP_EDITOR,
        grantedBy: testUsers.owner._id,
      });

      // Check if group member has access
      const hasAccess = await checkPermission({
        userId: testUsers.editor._id,
        resourceType: ResourceType.PROMPTGROUP,
        resourceId: testPromptGroup._id,
        requiredPermission: PermissionBits.EDIT,
      });

      expect(hasAccess).toBe(true);

      // Check that non-member doesn't have access
      const nonMemberAccess = await checkPermission({
        userId: testUsers.viewer._id,
        resourceType: ResourceType.PROMPTGROUP,
        resourceId: testPromptGroup._id,
        requiredPermission: PermissionBits.EDIT,
      });

      expect(nonMemberAccess).toBe(false);
    });
  });

  describe('Public Access', () => {
    let publicPromptGroup: LeanPromptGroup;
    let privatePromptGroup: LeanPromptGroup;

    beforeEach(async () => {
      publicPromptGroup = (
        await PromptGroup.create({
          name: 'Public Access Test Group',
          author: testUsers.owner._id,
          authorName: testUsers.owner.name,
          productionId: new ObjectId(),
        })
      ).toObject() as unknown as LeanPromptGroup;

      privatePromptGroup = (
        await PromptGroup.create({
          name: 'Private Access Test Group',
          author: testUsers.owner._id,
          authorName: testUsers.owner.name,
          productionId: new ObjectId(),
        })
      ).toObject() as unknown as LeanPromptGroup;

      await Prompt.create({
        prompt: 'Public prompt',
        name: 'Public',
        author: testUsers.owner._id,
        groupId: publicPromptGroup._id,
        type: 'text',
      });

      await Prompt.create({
        prompt: 'Private prompt',
        name: 'Private',
        author: testUsers.owner._id,
        groupId: privatePromptGroup._id,
        type: 'text',
      });

      // Grant public view access
      await aclMethods.grantPermission(
        PrincipalType.PUBLIC,
        null,
        ResourceType.PROMPTGROUP,
        publicPromptGroup._id,
        PermissionBits.VIEW,
        testUsers.owner._id,
      );

      // Grant only owner access to private
      await grantPermission({
        principalType: PrincipalType.USER,
        principalId: testUsers.owner._id,
        resourceType: ResourceType.PROMPTGROUP,
        resourceId: privatePromptGroup._id,
        accessRoleId: AccessRoleIds.PROMPTGROUP_OWNER,
        grantedBy: testUsers.owner._id,
      });
    });

    afterEach(async () => {
      await Prompt.deleteMany({});
      await PromptGroup.deleteMany({});
      await AclEntry.deleteMany({});
    });

    it('public prompt should be accessible to any user', async () => {
      const hasAccess = await checkPermission({
        userId: testUsers.noAccess._id,
        resourceType: ResourceType.PROMPTGROUP,
        resourceId: publicPromptGroup._id,
        requiredPermission: PermissionBits.VIEW,
        includePublic: true,
      });

      expect(hasAccess).toBe(true);
    });

    it('private prompt should not be accessible to unauthorized users', async () => {
      const hasAccess = await checkPermission({
        userId: testUsers.noAccess._id,
        resourceType: ResourceType.PROMPTGROUP,
        resourceId: privatePromptGroup._id,
        requiredPermission: PermissionBits.VIEW,
        includePublic: true,
      });

      expect(hasAccess).toBe(false);
    });
  });

  describe('Prompt Deletion', () => {
    it('should remove ACL entries when prompt is deleted', async () => {
      const testPromptGroup = (
        await PromptGroup.create({
          name: 'Deletion Test Group',
          author: testUsers.owner._id,
          authorName: testUsers.owner.name,
          productionId: new ObjectId(),
        })
      ).toObject() as unknown as LeanPromptGroup;

      const result = await methods.savePrompt({
        author: testUsers.owner._id,
        prompt: {
          prompt: 'To be deleted',
          name: 'Delete Test',
          groupId: testPromptGroup._id,
          type: 'text',
        },
      });

      const savedPrompt = result as { prompt?: { _id: mongoose.Types.ObjectId } } | null;
      if (!savedPrompt?.prompt) {
        throw new Error('Failed to save prompt');
      }
      const testPromptId = savedPrompt.prompt._id;

      await grantPermission({
        principalType: PrincipalType.USER,
        principalId: testUsers.owner._id,
        resourceType: ResourceType.PROMPTGROUP,
        resourceId: testPromptGroup._id,
        accessRoleId: AccessRoleIds.PROMPTGROUP_OWNER,
        grantedBy: testUsers.owner._id,
      });

      // Verify ACL entry exists
      const beforeDelete = await AclEntry.find({
        resourceType: ResourceType.PROMPTGROUP,
        resourceId: testPromptGroup._id,
      });
      expect(beforeDelete).toHaveLength(1);

      // Delete the prompt
      await methods.deletePrompt({
        promptId: testPromptId,
        groupId: testPromptGroup._id,
      });

      // Verify ACL entries are removed
      const aclEntries = await AclEntry.find({
        resourceType: ResourceType.PROMPTGROUP,
        resourceId: testPromptGroup._id,
      });

      expect(aclEntries).toHaveLength(0);
    });
  });

  describe('Backwards Compatibility', () => {
    it('should handle prompts without ACL entries gracefully', async () => {
      const promptGroup = (
        await PromptGroup.create({
          name: 'Legacy Test Group',
          author: testUsers.owner._id,
          authorName: testUsers.owner.name,
          productionId: new ObjectId(),
        })
      ).toObject() as unknown as LeanPromptGroup;

      const legacyPrompt = (
        await Prompt.create({
          prompt: 'Legacy prompt without ACL',
          name: 'Legacy',
          author: testUsers.owner._id,
          groupId: promptGroup._id,
          type: 'text',
        })
      ).toObject() as { _id: mongoose.Types.ObjectId };

      const prompt = (await methods.getPrompt({ _id: legacyPrompt._id })) as {
        _id: mongoose.Types.ObjectId;
      } | null;
      expect(prompt).toBeTruthy();
      expect(String(prompt!._id)).toBe(String(legacyPrompt._id));
    });
  });
});

describe('Prompt method failure contracts', () => {
  const dbError = new Error('database unavailable');

  afterEach(() => {
    jest.restoreAllMocks();
  });

  async function createGroupWithPrompt(name: string, category = '') {
    const { prompt, group } = await methods.createPromptGroup({
      prompt: { prompt: `${name} text`, type: 'text' },
      group: { name, category },
      author: String(testUsers.owner._id),
      authorName: testUsers.owner.name ?? '',
    });
    return {
      groupId: String((group as { _id: unknown })._id),
      promptId: String((prompt as { _id: unknown })._id),
    };
  }

  it('returns null for an absent group or revision', async () => {
    await expect(methods.getPromptGroup({ _id: new ObjectId().toString() })).resolves.toBeNull();
    await expect(methods.getPrompt({ _id: new ObjectId() })).resolves.toBeNull();
  });

  it('throws database failures from reads instead of returning data', async () => {
    jest.spyOn(PromptGroup, 'aggregate').mockImplementationOnce(() => {
      throw dbError;
    });
    await expect(methods.getPromptGroup({ _id: new ObjectId().toString() })).rejects.toBe(dbError);

    jest.spyOn(Prompt, 'findOne').mockImplementationOnce(() => {
      throw dbError;
    });
    await expect(methods.getPrompt({ _id: new ObjectId() })).rejects.toBe(dbError);

    jest.spyOn(Prompt, 'find').mockImplementationOnce(() => {
      throw dbError;
    });
    await expect(methods.getPrompts({ groupId: new ObjectId() })).rejects.toBe(dbError);
  });

  it('saves a revision as plain data and throws save failures', async () => {
    const { groupId } = await createGroupWithPrompt('Save contract');
    const { prompt } = await methods.savePrompt({
      prompt: { prompt: 'second', type: 'chat', groupId },
      author: String(testUsers.owner._id),
    });
    expect(prompt).not.toBeInstanceOf(mongoose.Document);
    expect(String(prompt.groupId)).toBe(groupId);

    jest.spyOn(Prompt, 'create').mockImplementationOnce(() => {
      throw dbError;
    });
    await expect(
      methods.savePrompt({
        prompt: { prompt: 'third', type: 'text', groupId },
        author: String(testUsers.owner._id),
      }),
    ).rejects.toBe(dbError);
  });

  it('keeps the index repair retry when saving a revision', async () => {
    const { groupId } = await createGroupWithPrompt('Index repair');
    const dropIndex = jest.fn().mockResolvedValue(undefined);
    jest
      .spyOn(Prompt.db, 'collection')
      .mockReturnValueOnce({ dropIndex } as unknown as ReturnType<typeof Prompt.db.collection>);
    const create = jest.spyOn(Prompt, 'create');
    create.mockImplementationOnce(() => {
      throw new Error('E11000 duplicate key error index: groupId_1_version_1');
    });

    const { prompt } = await methods.savePrompt({
      prompt: { prompt: 'retried', type: 'text', groupId },
      author: String(testUsers.owner._id),
    });

    expect(dropIndex).toHaveBeenCalledWith('groupId_1_version_1');
    expect(create).toHaveBeenCalledTimes(2);
    expect(prompt.prompt).toBe('retried');
  });

  it('returns the updated group as plain data and throws update failures', async () => {
    const { groupId } = await createGroupWithPrompt('Update contract');
    const updated = await methods.updatePromptGroup({ _id: groupId }, { name: 'Renamed' });
    expect(updated).not.toBeInstanceOf(mongoose.Document);
    expect(updated.name).toBe('Renamed');

    await expect(
      methods.updatePromptGroup({ _id: new ObjectId().toString() }, { name: 'Missing' }),
    ).rejects.toThrow('Prompt group not found');

    jest.spyOn(PromptGroup, 'findOneAndUpdate').mockImplementationOnce(() => {
      throw dbError;
    });
    await expect(methods.updatePromptGroup({ _id: groupId }, { name: 'x' })).rejects.toBe(dbError);
  });

  it('distinguishes a missing promotion revision from a database failure', async () => {
    const { groupId, promptId } = await createGroupWithPrompt('Promotion contract');
    const { prompt } = await methods.savePrompt({
      prompt: { prompt: 'next', type: 'text', groupId },
      author: String(testUsers.owner._id),
    });

    await expect(methods.makePromptProduction(String(prompt._id))).resolves.toEqual({
      message: 'Prompt production made successfully',
    });
    const group = (await methods.getPromptGroup({ _id: groupId })) as { productionId: unknown };
    expect(String(group.productionId)).toBe(String(prompt._id));

    await expect(methods.makePromptProduction(new ObjectId().toString())).rejects.toThrow(
      'Prompt not found',
    );

    jest.spyOn(Prompt, 'findById').mockImplementationOnce(() => {
      throw dbError;
    });
    await expect(methods.makePromptProduction(promptId)).rejects.toBe(dbError);
  });

  it('filters the access listing by plain name and category inputs', async () => {
    const first = await createGroupWithPrompt('Listing Alpha (v1)', 'writing');
    const second = await createGroupWithPrompt('Listing Beta', '');
    const accessibleIds = [first.groupId, second.groupId];

    const byName = await methods.getListPromptGroupsByAccess({
      accessibleIds,
      name: 'alpha (v1',
    });
    expect(byName.data.map((group) => String(group._id))).toEqual([first.groupId]);

    const uncategorized = await methods.getListPromptGroupsByAccess({
      accessibleIds,
      category: '',
    });
    expect(uncategorized.data.map((group) => String(group._id))).toEqual([second.groupId]);

    const all = await methods.getListPromptGroupsByAccess({ accessibleIds });
    expect(all.data).toHaveLength(2);
  });
});
