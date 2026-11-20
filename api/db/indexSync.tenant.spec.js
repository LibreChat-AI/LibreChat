const mockIndex = {
  uid: 'test',
  getSettings: jest.fn().mockResolvedValue({ filterableAttributes: ['user'] }),
  search: jest.fn().mockResolvedValue({ hits: [] }),
  getDocuments: jest.fn().mockResolvedValue({ results: [] }),
  addDocumentsInBatches: jest.fn().mockResolvedValue([{ taskUid: 1 }]),
  deleteDocuments: jest.fn().mockResolvedValue({ taskUid: 1 }),
};

jest.mock('meilisearch', () => ({
  MeiliSearch: jest.fn(() => ({
    health: jest.fn().mockResolvedValue({ status: 'available' }),
    index: jest.fn(() => mockIndex),
    waitForTask: jest.fn().mockResolvedValue({ status: 'succeeded' }),
  })),
}));
jest.mock('~/cache', () => ({ getLogStores: () => undefined }));

// Both plugins and indexSync read their configuration at module load.
process.env.SEARCH = 'true';
process.env.MEILI_HOST = 'http://localhost:7700';
process.env.MEILI_MASTER_KEY = 'test-only';
process.env.TENANT_ISOLATION_STRICT = 'true';

const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const {
  createModels,
  runAsSystem,
  tenantStorage,
  getTenantId,
} = require('@librechat/data-schemas');
const indexSync = require('./indexSync');

let mongo;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create({ instance: { args: ['--nounixsocket'] } });
  await mongoose.connect(mongo.getUri());
  createModels(mongoose);
});

beforeEach(async () => {
  await runAsSystem(async () => {
    await mongoose.models.Message.deleteMany({});
    await mongoose.models.Conversation.deleteMany({});
  });
  // Raw inserts model documents left unindexed by an older deployment.
  for (const tenantId of ['tenant-a', 'tenant-b']) {
    await mongoose.models.Message.collection.insertOne({
      messageId: `message-${tenantId}`,
      conversationId: `conversation-${tenantId}`,
      user: `user-${tenantId}`,
      text: 'Legacy message',
      tenantId,
    });
    await mongoose.models.Conversation.collection.insertOne({
      conversationId: `conversation-${tenantId}`,
      user: `user-${tenantId}`,
      title: 'Legacy conversation',
      tenantId,
    });
  }
  mockIndex.addDocumentsInBatches.mockClear();
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo?.stop();
});

it.each([undefined, 'tenant-a'])(
  'reconciles every tenant with no caller-owned system context (caller: %s)',
  async (tenantId) => {
    const result = await tenantStorage.run({ tenantId }, async () => {
      const synced = await indexSync();
      expect(getTenantId()).toBe(tenantId);
      return synced;
    });
    expect(result).toEqual({ messagesSync: true, convosSync: true });
    const indexed = await runAsSystem(async () =>
      Promise.all([
        mongoose.models.Message.find({ _meiliIndex: true }).lean(),
        mongoose.models.Conversation.find({ _meiliIndex: true }).lean(),
      ]),
    );
    for (const documents of indexed) {
      expect(documents.map((doc) => doc.tenantId).sort()).toEqual(['tenant-a', 'tenant-b']);
    }
    expect(mockIndex.addDocumentsInBatches).toHaveBeenCalledTimes(2);
  },
);
