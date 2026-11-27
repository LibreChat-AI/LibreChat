const fs = require('fs').promises;
const os = require('os');
const path = require('path');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const { createModels, runAsSystem, tenantStorage } = require('@librechat/data-schemas');
const {
  MAX_CONVERSATION_IMPORT_BSON_BYTES,
  MAX_CONVERSATION_IMPORT_DOCUMENT_BYTES,
} = require('@librechat/api');
const { Constants, EModelEndpoint } = require('librechat-data-provider');

jest.mock('~/server/services/Config', () => ({
  getEndpointsConfig: jest.fn().mockResolvedValue({
    openAI: { userProvide: false },
  }),
}));

jest.mock('~/server/controllers/ModelController', () => ({
  getModelsConfig: jest.fn().mockResolvedValue({
    openAI: ['gpt-4o'],
  }),
}));

createModels(mongoose);
const importConversations = require('./importConversations');

describe('importConversations database hardening', () => {
  let mongoServer;
  let tempDir;

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri());
  });

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'librechat-import-database-'));
    await mongoose.connection.dropDatabase();
  });

  afterEach(async () => {
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  afterAll(async () => {
    await mongoose.disconnect();
    if (mongoServer) {
      await mongoServer.stop();
    }
  });

  it('round-trips an existing browser export for its owner and tenant', async () => {
    const filepath = path.join(tempDir, 'browser-export.json');
    const fixture = path.join(__dirname, '__data__', 'librechat-export.json');
    const owner = 'browser-import-user';
    const tenantId = 'browser-tenant';
    await fs.copyFile(fixture, filepath);

    await tenantStorage.run({ tenantId, userId: owner }, async () => {
      await importConversations({ filepath, requestUserId: owner, userRole: 'USER' });
    });

    await expect(fs.stat(filepath)).rejects.toMatchObject({ code: 'ENOENT' });
    const persisted = await runAsSystem(async () => {
      const conversations = await mongoose.models.Conversation.find({ user: owner }).lean();
      const messages = await mongoose.models.Message.find({ user: owner }).lean();
      return { conversations, messages };
    });
    expect(persisted.conversations).toHaveLength(1);
    expect(persisted.conversations[0]).toMatchObject({
      user: owner,
      tenantId,
      title: 'Conversation 1. Web Search',
    });
    expect(persisted.messages).toHaveLength(6);
    expect(persisted.messages.every((message) => message.tenantId === tenantId)).toBe(true);
  });

  it('rejects an oversized BSON record before persisting any part of a browser import', async () => {
    const filepath = path.join(tempDir, 'oversized-conversation.json');
    const owner = 'browser-import-user';
    const tenantId = 'browser-tenant';
    await fs.writeFile(
      filepath,
      JSON.stringify({
        conversationId: 'source-conversation',
        endpoint: EModelEndpoint.openAI,
        title: 'x'.repeat(MAX_CONVERSATION_IMPORT_BSON_BYTES),
        options: { endpoint: EModelEndpoint.openAI, model: 'gpt-4o' },
        messages: [
          {
            messageId: 'source-message',
            conversationId: 'source-conversation',
            parentMessageId: Constants.NO_PARENT,
            sender: 'User',
            text: 'Hello',
            isCreatedByUser: true,
          },
        ],
      }),
      'utf8',
    );

    await expect(
      tenantStorage.run({ tenantId, userId: owner }, async () =>
        importConversations({ filepath, requestUserId: owner, userRole: 'USER' }),
      ),
    ).rejects.toThrow(`at most ${MAX_CONVERSATION_IMPORT_DOCUMENT_BYTES} bytes`);

    await new Promise((resolve) => setTimeout(resolve, 100));
    await expect(fs.stat(filepath)).rejects.toMatchObject({ code: 'ENOENT' });
    const persisted = await runAsSystem(async () => {
      const conversations = await mongoose.models.Conversation.find({ user: owner }).lean();
      const messages = await mongoose.models.Message.find({ user: owner }).lean();
      return { conversations, messages };
    });
    expect(persisted.conversations).toEqual([]);
    expect(persisted.messages).toEqual([]);
  });
});
