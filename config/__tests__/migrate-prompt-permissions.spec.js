const mongoose = require('mongoose');
const { ObjectId } = require('mongodb');
const { logger } = require('@librechat/data-schemas');
const { MongoMemoryServer } = require('mongodb-memory-server');
const {
  ResourceType,
  AccessRoleIds,
  PrincipalType,
  PrincipalModel,
  PermissionBits,
} = require('librechat-data-provider');

// Mock the config/connect module to prevent connection attempts during tests
jest.mock('../connect', () => jest.fn().mockResolvedValue(true));

// Disable console for tests
logger.silent = true;

describe('PromptGroup Migration Script', () => {
  let mongoServer;
  let Prompt, PromptGroup, AclEntry, AccessRole, User;
  let migrateToPromptGroupPermissions;
  let testOwner;
  let ownerRole, viewerRole;

  beforeAll(async () => {
    // Set up MongoDB memory server
    mongoServer = await MongoMemoryServer.create();
    const mongoUri = mongoServer.getUri();
    await mongoose.connect(mongoUri);

    // Initialize models
    const dbModels = require('~/db/models');
    Prompt = dbModels.Prompt;
    PromptGroup = dbModels.PromptGroup;
    AclEntry = dbModels.AclEntry;
    AccessRole = dbModels.AccessRole;
    User = dbModels.User;

    // Create test user
    testOwner = await User.create({
      name: 'Test Owner',
      email: 'owner@test.com',
      role: 'USER',
    });

    // Create test project document in the raw `projects` collection
    const projectName = 'instance';
    await mongoose.connection.db.collection('projects').insertOne({
      name: projectName,
      promptGroupIds: [],
    });

    // Create promptGroup access roles
    ownerRole = await AccessRole.create({
      accessRoleId: AccessRoleIds.PROMPTGROUP_OWNER,
      name: 'Owner',
      description: 'Full control over promptGroups',
      resourceType: ResourceType.PROMPTGROUP,
      permBits:
        PermissionBits.VIEW | PermissionBits.EDIT | PermissionBits.DELETE | PermissionBits.SHARE,
    });

    viewerRole = await AccessRole.create({
      accessRoleId: AccessRoleIds.PROMPTGROUP_VIEWER,
      name: 'Viewer',
      description: 'Can view promptGroups',
      resourceType: ResourceType.PROMPTGROUP,
      permBits: PermissionBits.VIEW,
    });

    await AccessRole.create({
      accessRoleId: AccessRoleIds.PROMPTGROUP_EDITOR,
      name: 'Editor',
      description: 'Can view and edit promptGroups',
      resourceType: ResourceType.PROMPTGROUP,
      permBits: PermissionBits.VIEW | PermissionBits.EDIT,
    });

    // Import migration function
    const migration = require('../migrate-prompt-permissions');
    migrateToPromptGroupPermissions = migration.migrateToPromptGroupPermissions;
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
  });

  beforeEach(async () => {
    // Clean up before each test
    await Prompt.deleteMany({});
    await PromptGroup.deleteMany({});
    await AclEntry.deleteMany({});
    await mongoose.connection.db
      .collection('projects')
      .updateOne({ name: 'instance' }, { $set: { promptGroupIds: [] } });
  });

  it('should categorize promptGroups correctly in dry run', async () => {
    // Create global prompt group (in Global project)
    const globalPromptGroup = await PromptGroup.create({
      name: 'Global Group',
      author: testOwner._id,
      authorName: testOwner.name,
      productionId: new ObjectId(),
    });

    // Create private prompt group (not in any project)
    await PromptGroup.create({
      name: 'Private Group',
      author: testOwner._id,
      authorName: testOwner.name,
      productionId: new ObjectId(),
    });

    // Add global group to project's promptGroupIds array
    await mongoose.connection.db
      .collection('projects')
      .updateOne({ name: 'instance' }, { $set: { promptGroupIds: [globalPromptGroup._id] } });

    const result = await migrateToPromptGroupPermissions({ dryRun: true });

    expect(result.dryRun).toBe(true);
    expect(result.summary.total).toBe(2);
    expect(result.summary.globalViewAccess).toBe(1);
    expect(result.summary.privateGroups).toBe(1);
  });

  it('should grant appropriate permissions during migration', async () => {
    // Create prompt groups
    const globalPromptGroup = await PromptGroup.create({
      name: 'Global Group',
      author: testOwner._id,
      authorName: testOwner.name,
      productionId: new ObjectId(),
    });

    const privatePromptGroup = await PromptGroup.create({
      name: 'Private Group',
      author: testOwner._id,
      authorName: testOwner.name,
      productionId: new ObjectId(),
    });

    // Add global group to project's promptGroupIds array
    await mongoose.connection.db
      .collection('projects')
      .updateOne({ name: 'instance' }, { $set: { promptGroupIds: [globalPromptGroup._id] } });

    const result = await migrateToPromptGroupPermissions({ dryRun: false });

    expect(result.migrated).toBe(2);
    expect(result.errors).toBe(0);
    expect(result.ownerGrants).toBe(2);
    expect(result.publicViewGrants).toBe(1);

    // Check global promptGroup permissions
    const globalOwnerEntry = await AclEntry.findOne({
      resourceType: ResourceType.PROMPTGROUP,
      resourceId: globalPromptGroup._id,
      principalType: PrincipalType.USER,
      principalId: testOwner._id,
    });
    expect(globalOwnerEntry).toBeTruthy();
    expect(globalOwnerEntry.permBits).toBe(ownerRole.permBits);

    const globalPublicEntry = await AclEntry.findOne({
      resourceType: ResourceType.PROMPTGROUP,
      resourceId: globalPromptGroup._id,
      principalType: PrincipalType.PUBLIC,
    });
    expect(globalPublicEntry).toBeTruthy();
    expect(globalPublicEntry.permBits).toBe(viewerRole.permBits);

    // Check private promptGroup permissions
    const privateOwnerEntry = await AclEntry.findOne({
      resourceType: ResourceType.PROMPTGROUP,
      resourceId: privatePromptGroup._id,
      principalType: PrincipalType.USER,
      principalId: testOwner._id,
    });
    expect(privateOwnerEntry).toBeTruthy();
    expect(privateOwnerEntry.permBits).toBe(ownerRole.permBits);

    const privatePublicEntry = await AclEntry.findOne({
      resourceType: ResourceType.PROMPTGROUP,
      resourceId: privatePromptGroup._id,
      principalType: PrincipalType.PUBLIC,
    });
    expect(privatePublicEntry).toBeNull();
  });

  it('should skip promptGroups that already have ACL entries', async () => {
    // Create prompt groups
    const promptGroup1 = await PromptGroup.create({
      name: 'Group 1',
      author: testOwner._id,
      authorName: testOwner.name,
      productionId: new ObjectId(),
    });

    const promptGroup2 = await PromptGroup.create({
      name: 'Group 2',
      author: testOwner._id,
      authorName: testOwner.name,
      productionId: new ObjectId(),
    });

    // Grant permission to one promptGroup manually (simulating it already has ACL)
    await AclEntry.create({
      principalType: PrincipalType.USER,
      principalId: testOwner._id,
      principalModel: PrincipalModel.USER,
      resourceType: ResourceType.PROMPTGROUP,
      resourceId: promptGroup1._id,
      permBits: ownerRole.permBits,
      roleId: ownerRole._id,
      grantedBy: testOwner._id,
      grantedAt: new Date(),
    });

    const result = await migrateToPromptGroupPermissions({ dryRun: false });

    // Should only migrate promptGroup2, skip promptGroup1
    expect(result.migrated).toBe(1);
    expect(result.errors).toBe(0);

    // Verify promptGroup2 now has permissions
    const group2Entry = await AclEntry.findOne({
      resourceType: ResourceType.PROMPTGROUP,
      resourceId: promptGroup2._id,
    });
    expect(group2Entry).toBeTruthy();
  });

  it('should handle promptGroups with prompts correctly', async () => {
    // Create a promptGroup with some prompts
    const promptGroup = await PromptGroup.create({
      name: 'Group with Prompts',
      author: testOwner._id,
      authorName: testOwner.name,
      productionId: new ObjectId(),
    });

    // Create some prompts in this group
    await Prompt.create({
      prompt: 'First prompt',
      author: testOwner._id,
      groupId: promptGroup._id,
      type: 'text',
    });

    await Prompt.create({
      prompt: 'Second prompt',
      author: testOwner._id,
      groupId: promptGroup._id,
      type: 'text',
    });

    const result = await migrateToPromptGroupPermissions({ dryRun: false });

    expect(result.migrated).toBe(1);
    expect(result.errors).toBe(0);

    // Verify the promptGroup has permissions
    const groupEntry = await AclEntry.findOne({
      resourceType: ResourceType.PROMPTGROUP,
      resourceId: promptGroup._id,
    });
    expect(groupEntry).toBeTruthy();

    // Verify no prompt-level permissions were created
    const promptEntries = await AclEntry.find({
      resourceType: 'prompt',
    });
    expect(promptEntries).toHaveLength(0);
  });

  it('should skip a Langfuse-source promptGroup in dry run', async () => {
    await PromptGroup.create({
      name: 'Native Group',
      author: testOwner._id,
      authorName: testOwner.name,
      productionId: new ObjectId(),
    });

    await PromptGroup.create({
      name: 'Langfuse Group',
      author: testOwner._id,
      authorName: 'Langfuse Sync',
      source: 'langfuse',
      sourcePromptName: 'langfuse-prompt',
      sourceProjectId: 'project-1',
      sourceDestination: 'destination-1',
    });

    const result = await migrateToPromptGroupPermissions({ dryRun: true });

    expect(result.summary.total).toBe(1);
    expect(result.details.privateGroups).toHaveLength(1);
    expect(result.details.privateGroups[0].name).toBe('Native Group');
  });

  it('should skip a Langfuse-source promptGroup during a live run and write no owner grant for it', async () => {
    const nativeGroup = await PromptGroup.create({
      name: 'Native Group',
      author: testOwner._id,
      authorName: testOwner.name,
      productionId: new ObjectId(),
    });

    const langfuseGroup = await PromptGroup.create({
      name: 'Langfuse Group',
      author: testOwner._id,
      authorName: 'Langfuse Sync',
      source: 'langfuse',
      sourcePromptName: 'langfuse-prompt',
      sourceProjectId: 'project-1',
      sourceDestination: 'destination-1',
    });

    const result = await migrateToPromptGroupPermissions({ dryRun: false });

    expect(result.migrated).toBe(1);
    expect(result.ownerGrants).toBe(1);

    const nativeOwnerEntry = await AclEntry.findOne({
      resourceType: ResourceType.PROMPTGROUP,
      resourceId: nativeGroup._id,
      principalType: PrincipalType.USER,
    });
    expect(nativeOwnerEntry).toBeTruthy();

    const langfuseOwnerEntry = await AclEntry.findOne({
      resourceType: ResourceType.PROMPTGROUP,
      resourceId: langfuseGroup._id,
    });
    expect(langfuseOwnerEntry).toBeNull();
  });
});
