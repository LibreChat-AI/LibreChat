import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { FileContext, PermissionBits, PrincipalType, ResourceType } from 'librechat-data-provider';
import type { IAclEntry, IChatProject, IConversation, IMongoFile, IUser } from '~/types';
import { createChatProjectMethods, type ChatProjectMethods } from './chatProject';
import { createConversationMethods } from './conversation';
import { createUserGroupMethods } from './userGroup';
import { createAclEntryMethods } from './aclEntry';
import { RoleBits } from '~/common/enum';
import { createModels } from '~/models';

jest.mock('~/config/winston', () => ({
  error: jest.fn(),
  warn: jest.fn(),
  info: jest.fn(),
  debug: jest.fn(),
}));

let mongoServer: InstanceType<typeof MongoMemoryServer>;
let ChatProject: mongoose.Model<IChatProject>;
let Conversation: mongoose.Model<IConversation>;
let AclEntry: mongoose.Model<IAclEntry>;
let File: mongoose.Model<IMongoFile>;
let User: mongoose.Model<IUser>;
let acl: ReturnType<typeof createAclEntryMethods>;
let methods: ChatProjectMethods;
let modelsToCleanup: string[] = [];

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  const models = createModels(mongoose);
  modelsToCleanup = Object.keys(models);
  Object.assign(mongoose.models, models);

  ChatProject = mongoose.models.ChatProject as mongoose.Model<IChatProject>;
  Conversation = mongoose.models.Conversation as mongoose.Model<IConversation>;
  AclEntry = mongoose.models.AclEntry as mongoose.Model<IAclEntry>;
  File = mongoose.models.File as mongoose.Model<IMongoFile>;
  User = mongoose.models.User as mongoose.Model<IUser>;

  acl = createAclEntryMethods(mongoose);
  const userGroups = createUserGroupMethods(mongoose, {});
  methods = createChatProjectMethods(mongoose, {
    getUserPrincipals: userGroups.getUserPrincipals,
    getEffectivePermissions: acl.getEffectivePermissions,
    getEffectivePermissionsForResources: acl.getEffectivePermissionsForResources,
    findAccessibleResources: acl.findAccessibleResources,
    deleteAclEntries: acl.deleteAclEntries,
  });

  await mongoose.connect(mongoServer.getUri());
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
  for (const modelName of modelsToCleanup) {
    delete mongoose.models[modelName];
  }
});

afterEach(async () => {
  await Promise.all([
    ChatProject.deleteMany({}),
    Conversation.deleteMany({}),
    AclEntry.deleteMany({}),
    File.deleteMany({}),
    User.deleteMany({}),
  ]);
});

async function createUser(role = 'USER'): Promise<string> {
  const user = await User.create({
    email: `${new mongoose.Types.ObjectId().toString()}@example.com`,
    provider: 'local',
    role,
  });
  return user._id.toString();
}

async function share(projectId: string, userId: string, permBits: number): Promise<void> {
  await acl.grantPermission(
    PrincipalType.USER,
    userId,
    ResourceType.CHAT_PROJECT,
    projectId,
    permBits,
  );
}

async function createConversation(user: string, chatProjectId?: string) {
  return await Conversation.create({
    conversationId: new mongoose.Types.ObjectId().toString(),
    title: 'chat',
    user,
    endpoint: 'openAI',
    ...(chatProjectId ? { chatProjectId } : {}),
  });
}

describe('shared chat projects', () => {
  it('keeps a project private until it is shared', async () => {
    const owner = await createUser();
    const member = await createUser();
    const project = await methods.createChatProject(owner, { name: 'Private' });
    const id = project._id!.toString();

    expect(await methods.getChatProject(member, id)).toBeNull();
    expect(await methods.hasChatProjectAccess(member, id)).toBe(false);
    expect((await methods.listChatProjects(member)).projects).toEqual([]);
  });

  it('lets a viewer read the project and list it as shared', async () => {
    const owner = await createUser();
    const member = await createUser();
    const project = await methods.createChatProject(owner, {
      name: 'Shared',
      instructions: 'Use the team style guide.',
    });
    const id = project._id!.toString();
    await share(id, member, RoleBits.VIEWER);

    const access = await methods.getChatProjectAccess(member, id);
    expect(access?.isOwner).toBe(false);
    expect(access?.permissions).toBe(RoleBits.VIEWER);
    expect(access?.project.instructions).toBe('Use the team style guide.');

    const { projects } = await methods.listChatProjects(member);
    expect(projects).toHaveLength(1);
    expect(projects[0]).toMatchObject({ name: 'Shared', isShared: true, permissions: 1 });
  });

  it('includes projects shared through the public principal', async () => {
    const owner = await createUser();
    const member = await createUser();
    const project = await methods.createChatProject(owner, { name: 'Everyone' });
    await acl.grantPermission(
      PrincipalType.PUBLIC,
      null,
      ResourceType.CHAT_PROJECT,
      project._id!,
      RoleBits.VIEWER,
    );

    expect(await methods.hasChatProjectAccess(member, project._id!.toString())).toBe(true);
  });

  it('lists owned and shared projects together without flagging owned ones', async () => {
    const owner = await createUser();
    const member = await createUser();
    await methods.createChatProject(member, { name: 'Mine' });
    const shared = await methods.createChatProject(owner, { name: 'Theirs' });
    await share(shared._id!.toString(), member, RoleBits.VIEWER);

    const { projects } = await methods.listChatProjects(member, {
      sortBy: 'name',
      sortDirection: 'asc',
    });
    expect(projects.map((project) => [project.name, project.isShared === true])).toEqual([
      ['Mine', false],
      ['Theirs', true],
    ]);
  });

  it('refuses edits from a viewer and accepts them from an editor', async () => {
    const owner = await createUser();
    const viewer = await createUser();
    const editor = await createUser();
    const project = await methods.createChatProject(owner, { name: 'Draft' });
    const id = project._id!.toString();
    await share(id, viewer, RoleBits.VIEWER);
    await share(id, editor, RoleBits.EDITOR);

    expect(await methods.updateChatProject(viewer, id, { instructions: 'nope' })).toBeNull();
    const updated = await methods.updateChatProject(editor, id, {
      name: 'Final',
      instructions: 'Edited by a member',
    });
    expect(updated).toMatchObject({ name: 'Final', instructions: 'Edited by a member' });
    expect(updated?.user).toBe(owner);
  });

  it('only lets the owner delete the project', async () => {
    const owner = await createUser();
    const editor = await createUser();
    const project = await methods.createChatProject(owner, { name: 'Keep' });
    const id = project._id!.toString();
    await share(id, editor, RoleBits.EDITOR);

    expect((await methods.deleteChatProject(editor, id)).deletedCount).toBe(0);
    expect(await ChatProject.exists({ _id: id })).not.toBeNull();
  });

  it("keeps files owner-only, even for an editor's own uploads", async () => {
    const owner = await createUser();
    const editor = await createUser();
    const project = await methods.createChatProject(owner, { name: 'Files' });
    const id = project._id!.toString();
    await share(id, editor, RoleBits.EDITOR);
    await File.create({
      user: editor,
      file_id: 'editor-file',
      filename: 'notes.txt',
      filepath: '/notes.txt',
      type: 'text/plain',
      bytes: 10,
      object: 'file',
      embedded: true,
      context: FileContext.message_attachment,
    });

    expect(await methods.addChatProjectFile(editor, id, 'editor-file')).toBeNull();
    expect(await methods.removeChatProjectFile(editor, id, 'editor-file')).toBeNull();
  });

  it("shows a member their own chat stats, never the owner's", async () => {
    const owner = await createUser();
    const member = await createUser();
    const project = await methods.createChatProject(owner, { name: 'Stats' });
    const id = project._id!.toString();
    await share(id, member, RoleBits.VIEWER);
    await createConversation(owner, id);
    await createConversation(owner, id);
    const memberChat = await createConversation(member, id);
    await ChatProject.updateOne(
      { _id: id },
      { $set: { conversationCount: 2, lastConversationId: 'owner-chat' } },
    );

    const view = await methods.getChatProjectView(member, id);
    expect(view).toMatchObject({
      conversationCount: 1,
      lastConversationId: memberChat.conversationId,
      isShared: true,
    });
    const { projects } = await methods.listChatProjects(member);
    expect(projects[0]).toMatchObject({ conversationCount: 1 });
    expect((await methods.getChatProjectView(owner, id))?.conversationCount).toBe(2);
  });

  it('lets a member move their own chat into a shared project', async () => {
    const owner = await createUser();
    const member = await createUser();
    const project = await methods.createChatProject(owner, { name: 'Shared' });
    const id = project._id!.toString();
    const chat = await createConversation(member);

    await expect(
      methods.assignConversationToProject(member, chat.conversationId, id),
    ).rejects.toThrow('Project not found');

    await share(id, member, RoleBits.VIEWER);
    const result = await methods.assignConversationToProject(member, chat.conversationId, id);
    expect(result?.conversation.chatProjectId).toBe(id);
  });

  it("detaches members' chats and removes grants when the owner deletes the project", async () => {
    const owner = await createUser();
    const member = await createUser();
    const project = await methods.createChatProject(owner, { name: 'Gone' });
    const id = project._id!.toString();
    await share(id, member, RoleBits.VIEWER);
    const memberChat = await createConversation(member, id);

    expect((await methods.deleteChatProject(owner, id)).deletedCount).toBe(1);
    const reloaded = await Conversation.findById(memberChat._id).lean();
    expect(reloaded?.chatProjectId ?? null).toBeNull();
    expect(await AclEntry.countDocuments({ resourceType: ResourceType.CHAT_PROJECT })).toBe(0);
  });

  it("cleans up members' chats and grants when the owner's account is erased", async () => {
    const owner = await createUser();
    const member = await createUser();
    const project = await methods.createChatProject(owner, { name: 'Erased' });
    const id = project._id!.toString();
    await share(id, member, RoleBits.VIEWER);
    const memberChat = await createConversation(member, id);

    expect(await methods.deleteUserChatProjects(owner)).toBe(1);
    const reloaded = await Conversation.findById(memberChat._id).lean();
    expect(reloaded?.chatProjectId ?? null).toBeNull();
    expect(await AclEntry.countDocuments({ resourceType: ResourceType.CHAT_PROJECT })).toBe(0);
  });

  it('stops granting access once the share is removed', async () => {
    const owner = await createUser();
    const member = await createUser();
    const project = await methods.createChatProject(owner, { name: 'Revoked' });
    const id = project._id!.toString();
    await share(id, member, RoleBits.VIEWER);
    expect(await methods.hasChatProjectAccess(member, id)).toBe(true);

    await AclEntry.deleteMany({ resourceType: ResourceType.CHAT_PROJECT });
    expect(await methods.hasChatProjectAccess(member, id)).toBe(false);
    const ownerAccess = await methods.getChatProjectAccess(owner, id);
    expect((ownerAccess?.permissions ?? 0) & PermissionBits.SHARE).toBe(PermissionBits.SHARE);
  });
});

describe('conversation saves in shared projects', () => {
  it("seeds a member's new chat into a project shared with them", async () => {
    const owner = await createUser();
    const member = await createUser();
    const outsider = await createUser();
    const project = await methods.createChatProject(owner, { name: 'Shared' });
    const id = project._id!.toString();
    await share(id, member, RoleBits.VIEWER);

    const convos = createConversationMethods(mongoose, {
      getMessages: jest.fn().mockResolvedValue([]),
      deleteMessages: jest.fn(),
      hasChatProjectAccess: methods.hasChatProjectAccess,
    });
    const save = (user: string) =>
      convos.saveConvo(
        { userId: user },
        {
          conversationId: new mongoose.Types.ObjectId().toString(),
          endpoint: 'openAI',
          chatProjectId: id,
        },
      );

    const memberChat = (await save(member)) as IConversation | null;
    const outsiderChat = (await save(outsider)) as IConversation | null;
    expect(memberChat?.chatProjectId).toBe(id);
    expect(outsiderChat?.chatProjectId ?? null).toBeNull();
  });
});

describe('unassigned chat list after a share is revoked', () => {
  it("lists a member's chat as unassigned once the project is unshared", async () => {
    const owner = await createUser();
    const member = await createUser();
    const project = await methods.createChatProject(owner, { name: 'Revoked' });
    const id = project._id!.toString();
    await share(id, member, RoleBits.VIEWER);
    const chat = await createConversation(member, id);

    const convos = createConversationMethods(mongoose, {
      getMessages: jest.fn().mockResolvedValue([]),
      deleteMessages: jest.fn(),
      listAccessibleChatProjectIds: methods.listAccessibleChatProjectIds,
    });
    const unassignedIds = async () =>
      (await convos.getConvosByCursor(member, { projectId: 'unassigned' })).conversations.map(
        (convo) => convo.conversationId,
      );

    expect(await unassignedIds()).not.toContain(chat.conversationId);
    await AclEntry.deleteMany({ resourceType: ResourceType.CHAT_PROJECT });
    expect(await unassignedIds()).toContain(chat.conversationId);
  });
});
