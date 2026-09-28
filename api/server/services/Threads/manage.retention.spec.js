const mongoose = require('mongoose');
const { v4 } = require('uuid');
const { MongoMemoryServer } = require('mongodb-memory-server');

jest.mock('@librechat/api', () => ({
  ...jest.requireActual('@librechat/api'),
  countTokens: jest.fn().mockResolvedValue(1),
}));

jest.mock('~/server/services/Files/process', () => ({ retrieveAndProcessFile: jest.fn() }));

const { Message, Conversation } = require('~/db/models');
const { saveUserMessage, saveAssistantMessage, checkMessageGaps } = require('./manage');

describe('Assistants message retention', () => {
  let mongoServer;

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri());
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
  });

  it.each([false, true])(
    'retains the full turn and gap sync with isTemporary=%s',
    async (isTemporary) => {
      const user = new mongoose.Types.ObjectId().toString();
      const conversationId = v4();
      const req = {
        user: { id: user },
        body: { conversationId, isTemporary },
        resolvedConversation: null,
        config: {
          interfaceConfig: {
            retentionMode: 'all',
            generalChatRetention: 24,
            temporaryChatRetention: 1,
          },
        },
      };
      const params = {
        user,
        conversationId,
        endpoint: 'assistants',
        assistant_id: 'asst_test',
        thread_id: 'thread_test',
        text: 'hello',
      };
      const startedAt = Date.now();
      const userMessage = await saveUserMessage(req, { ...params, messageId: v4() });
      expect(userMessage.expiredAt.getTime()).toBeGreaterThanOrEqual(
        startedAt + (isTemporary ? 1 : 24) * 3600000,
      );
      expect(userMessage.expiredAt.getTime()).toBeLessThan(
        startedAt + (isTemporary ? 1 : 24) * 3600000 + 5000,
      );
      // A response must retain the admission policy even if request fields change.
      req.body.isTemporary = !isTemporary;
      await saveAssistantMessage(req, {
        ...params,
        messageId: v4(),
        parentMessageId: userMessage.messageId,
        content: [],
      });
      await checkMessageGaps({
        openai: {
          req,
          beta: {
            threads: {
              messages: {
                update: jest.fn().mockResolvedValue({}),
                list: jest.fn().mockResolvedValue({
                  data: [{ id: 'msg_user', role: 'user', content: [], created_at: 1 }],
                }),
              },
              runs: { steps: { list: jest.fn().mockResolvedValue({ data: [] }) } },
            },
          },
        },
        endpoint: 'assistants',
        thread_id: 'thread_test',
        conversationId,
        latestMessageId: v4(),
        run_id: 'run_test',
      });
      const rows = await Message.find({ user, conversationId }).lean();
      const convo = await Conversation.findOne({ user, conversationId }).lean();
      expect(rows).toHaveLength(4);
      for (const row of [...rows, convo]) {
        expect(row.isTemporary).toBe(isTemporary);
        expect(row.expiredAt).toEqual(userMessage.expiredAt);
      }
    },
  );
});
