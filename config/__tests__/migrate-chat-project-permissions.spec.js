jest.mock('../connect', () => jest.fn().mockResolvedValue(true));
jest.mock('@librechat/api', () => ({
  ensureRequiredCollectionsExist: jest.fn().mockResolvedValue(undefined),
  createMessageBudgetReader: jest.fn(() => ({ initialize: jest.fn(), getBudget: jest.fn() })),
  matchModelName: jest.fn(),
  findMatchingPattern: jest.fn(),
}));
jest.mock('@librechat/data-schemas', () => ({
  ...jest.requireActual('@librechat/data-schemas'),
  logger: { error: jest.fn(), info: jest.fn(), warn: jest.fn(), debug: jest.fn() },
}));
jest.mock('~/cache/getLogStores', () => jest.fn());

const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const { createMethods } = require('@librechat/data-schemas');

describe('migrate-chat-project-permissions', () => {
  let mongoServer;
  let ChatProject, AclEntry;
  let migrateChatProjectPermissions;

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri());

    ({ migrateChatProjectPermissions } = require('../migrate-chat-project-permissions'));
    ChatProject = mongoose.models.ChatProject;
    AclEntry = mongoose.models.AclEntry;

    await createMethods(mongoose).seedDefaultRoles();
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
  });

  beforeEach(async () => {
    await AclEntry.deleteMany({});
    await ChatProject.deleteMany({});
  });

  const createProject = (user, name = 'Project') =>
    ChatProject.create({ name, user, conversationCount: 0 });

  test('reports what it would do on a dry run without writing', async () => {
    await createProject(new mongoose.Types.ObjectId().toString());
    await createProject('not-an-object-id');

    const result = await migrateChatProjectPermissions({ dryRun: true });

    expect(result.summary).toMatchObject({
      totalProjects: 2,
      migratableProjects: 1,
      skippedNonObjectIdOwner: 1,
    });
    expect(await AclEntry.countDocuments({})).toBe(0);
  });

  test('grants each project owner the owner role, idempotently', async () => {
    const ownerId = new mongoose.Types.ObjectId();
    const project = await createProject(ownerId.toString());

    const first = await migrateChatProjectPermissions({ dryRun: false });
    const second = await migrateChatProjectPermissions({ dryRun: false });

    expect(first).toMatchObject({ migrated: 1, ownerGrants: 1, errors: 0 });
    expect(second).toMatchObject({ migrated: 1, ownerGrants: 0, errors: 0 });
    const entries = await AclEntry.find({ resourceType: 'chatProject' }).lean();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      resourceId: project._id,
      principalType: 'user',
      principalModel: 'User',
      permBits: 15,
    });
    expect(entries[0].principalId.toString()).toBe(ownerId.toString());
  });

  test('records failed grants without stopping the run', async () => {
    const good = await createProject(new mongoose.Types.ObjectId().toString(), 'Good');
    const bad = await createProject(new mongoose.Types.ObjectId().toString(), 'Bad');

    jest.spyOn(AclEntry, 'bulkWrite').mockImplementationOnce(async (ops) => {
      const index = ops.findIndex((op) => op.updateOne.filter.resourceId.equals(bad._id));
      const error = new Error('write failed');
      error.writeErrors = [{ index, errmsg: 'write failed' }];
      throw error;
    });

    const result = await migrateChatProjectPermissions({ dryRun: false });

    expect(result.errors).toBe(1);
    expect(result.failedProjectIds).toEqual([bad._id.toString()]);
    expect(result.failedProjectIds).not.toContain(good._id.toString());
  });
});
