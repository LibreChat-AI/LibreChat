const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const { Constants, EModelEndpoint, ForkOptions } = require('librechat-data-provider');
const { createModels, runAsSystem, tenantStorage } = require('@librechat/data-schemas');

jest.mock('~/server/services/Config', () => ({
  getAppConfig: jest.fn().mockResolvedValue({ interfaceConfig: {} }),
  getEndpointsConfig: jest.fn().mockResolvedValue({ openAI: { userProvide: false } }),
}));

jest.mock('~/server/controllers/ModelController', () => ({
  getModelsConfig: jest.fn().mockResolvedValue({ openAI: ['gpt-4o'] }),
}));

createModels(mongoose);
const { forkConversation } = require('./fork');

const owner = 'fork-owner';
const tenantId = 'fork-tenant';
const conversationId = 'source-conversation';

const screenshot = {
  file_id: 'screenshot-1',
  filename: 'screenshot.png',
  filepath: '/images/screenshot.png',
  type: 'image/png',
};
const chart = {
  file_id: 'chart-1',
  filename: 'chart.png',
  filepath: '/images/chart.png',
  type: 'image/png',
  toolCallId: 'call-1',
};

/** One branch: a question with a screenshot, an answer with a code output, a follow-up, and a
 *  failed answer; plus a sibling branch off the first question that the direct path skips. */
const sourceMessages = [
  {
    messageId: 'user-1',
    parentMessageId: Constants.NO_PARENT,
    text: 'What does this screenshot show?',
    isCreatedByUser: true,
    files: [screenshot],
    tokenCount: 1500,
  },
  {
    messageId: 'assistant-1',
    parentMessageId: 'user-1',
    text: 'A chart of weekly sales.',
    isCreatedByUser: false,
    content: [
      { type: 'text', text: 'A chart of weekly sales.' },
      {
        type: 'steer',
        steer: 'Use this screenshot instead',
        steerId: 'steer-1',
        files: [screenshot],
      },
    ],
    attachments: [chart],
    tokenCount: 12,
  },
  {
    messageId: 'user-2',
    parentMessageId: 'assistant-1',
    text: 'Plot it again in blue.',
    isCreatedByUser: true,
    tokenCount: 8,
  },
  {
    messageId: 'assistant-2',
    parentMessageId: 'user-2',
    text: 'Error uploading code environment file: 429',
    isCreatedByUser: false,
    error: true,
  },
  {
    messageId: 'assistant-sibling',
    parentMessageId: 'user-1',
    text: 'An alternate answer.',
    isCreatedByUser: false,
  },
];

async function seedSourceConversation() {
  await runAsSystem(async () => {
    await mongoose.models.Conversation.create({
      conversationId,
      user: owner,
      tenantId,
      title: 'Screenshots',
      endpoint: EModelEndpoint.openAI,
      model: 'gpt-4o',
      files: [screenshot.file_id, chart.file_id],
    });
    await mongoose.models.Message.insertMany(
      sourceMessages.map((message, index) => ({
        ...message,
        conversationId,
        user: owner,
        tenantId,
        sender: message.isCreatedByUser ? 'User' : 'GPT-4o',
        endpoint: EModelEndpoint.openAI,
        model: 'gpt-4o',
        createdAt: new Date(Date.UTC(2026, 0, 1, 0, index)),
      })),
    );
  });
}

function fork(options) {
  return tenantStorage.run({ tenantId, userId: owner }, () =>
    forkConversation({
      requestUserId: owner,
      originalConvoId: conversationId,
      targetMessageId: 'assistant-2',
      option: ForkOptions.DIRECT_PATH,
      records: true,
      ...options,
    }),
  );
}

function readPersisted(forkedConversationId) {
  return runAsSystem(async () => ({
    conversation: await mongoose.models.Conversation.findOne({
      conversationId: forkedConversationId,
    }).lean(),
    messages: await mongoose.models.Message.find({ conversationId: forkedConversationId })
      .sort({ createdAt: 1 })
      .lean(),
  }));
}

describe('forkConversation with excludeFiles (database)', () => {
  let mongoServer;

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri());
  });

  beforeEach(async () => {
    await mongoose.connection.dropDatabase();
    await seedSourceConversation();
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer?.stop();
  });

  it('copies the visible branch with no uploads, code outputs or conversation file list', async () => {
    const result = await fork({ excludeFiles: true });
    const persisted = await readPersisted(result.conversation.conversationId);

    expect(persisted.conversation.conversationId).not.toBe(conversationId);
    expect(persisted.conversation.files ?? []).toEqual([]);
    expect(persisted.messages.map((message) => message.text)).toEqual([
      'What does this screenshot show?',
      'A chart of weekly sales.',
      'Plot it again in blue.',
      'Error uploading code environment file: 429',
    ]);
    for (const message of persisted.messages) {
      expect(message.files ?? []).toEqual([]);
      expect(message.attachments ?? []).toEqual([]);
    }
    expect(persisted.messages[1].content).toEqual([
      { type: 'text', text: 'A chart of weekly sales.' },
      { type: 'steer', steer: 'Use this screenshot instead', steerId: 'steer-1' },
    ]);

    const [question, answer, followUp, failure] = persisted.messages;
    expect(question.parentMessageId).toBe(Constants.NO_PARENT);
    expect(answer.parentMessageId).toBe(question.messageId);
    expect(followUp.parentMessageId).toBe(answer.messageId);
    expect(failure.parentMessageId).toBe(followUp.messageId);
    /** A count that covered dropped uploads or steered files goes with them; text-only turns
     *  keep theirs. */
    expect(question.tokenCount).toBeUndefined();
    expect(answer.tokenCount).toBeUndefined();
    expect(followUp.tokenCount).toBe(8);
  });

  it('keeps the original conversation and its files intact', async () => {
    await fork({ excludeFiles: true });
    const original = await readPersisted(conversationId);

    expect(original.conversation.files).toEqual([screenshot.file_id, chart.file_id]);
    expect(original.messages).toHaveLength(sourceMessages.length);
    const byId = new Map(original.messages.map((message) => [message.messageId, message]));
    expect(byId.get('user-1').files).toEqual([screenshot]);
    expect(byId.get('assistant-1').attachments).toEqual([chart]);
  });

  it('still copies files when the option is off', async () => {
    const result = await fork({});
    const persisted = await readPersisted(result.conversation.conversationId);

    expect(persisted.conversation.files).toEqual([screenshot.file_id, chart.file_id]);
    expect(persisted.messages[0].files).toEqual([screenshot]);
    expect(persisted.messages[1].attachments).toEqual([chart]);
  });
});
