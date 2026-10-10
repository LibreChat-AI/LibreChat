const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

const mockTitles = new Map();
const mockInitializeClient = jest.fn();
jest.mock('~/cache/getLogStores', () => () => ({
  get: async (key) => mockTitles.get(key),
  set: async (key, value) => mockTitles.set(key, value),
  delete: async (key) => mockTitles.delete(key),
}));
jest.mock(
  './assistants/initalize',
  () =>
    (...args) =>
      mockInitializeClient(...args),
);

const { Conversation, Message } = require('~/db/models');
const addAssistantTitle = require('./assistants/title');
const addAgentTitle = require('./agents/title');

describe('generated title reply provenance', () => {
  let mongo;
  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    await mongoose.connect(mongo.getUri());
  });
  afterAll(async () => {
    await mongoose.disconnect();
    await mongo.stop();
  });
  beforeEach(async () => {
    await Conversation.deleteMany({});
    mockTitles.clear();
    mockInitializeClient.mockReset();
  });

  it.each(['assistant', 'assistant fallback', 'agent'])(
    'preserves reply activity through an automatic %s title without loading history',
    async (mode) => {
      const conversationId = 'automatic-title';
      const replyAt = new Date('2026-08-16T10:00:00.000Z');
      await Conversation.create({
        conversationId,
        user: 'title-user',
        endpoint: 'assistants',
        title: 'New Chat',
        createdAt: replyAt,
        updatedAt: replyAt,
        lastResponseAt: replyAt,
      });
      const create = jest.fn();
      if (mode === 'assistant fallback') {
        create.mockRejectedValue(new Error('title service unavailable'));
      } else {
        create.mockResolvedValue({ choices: [{ message: { content: 'Automatic title' } }] });
      }
      mockInitializeClient.mockResolvedValue({ openai: { chat: { completions: { create } } } });
      const req = { user: { id: 'title-user' }, body: {}, config: {} };
      const history = jest.spyOn(Message, 'find');
      try {
        if (mode === 'agent') {
          await addAgentTitle(req, {
            text: 'Automatic title',
            response: { conversationId },
            client: {
              options: { titleConvo: true },
              titleConvo: async () => 'Automatic title',
            },
          });
        } else {
          await addAssistantTitle(req, {
            text: 'Automatic title',
            responseText: 'Assistant reply',
            conversationId,
          });
        }
        expect(history).not.toHaveBeenCalled();
        const saved = await Conversation.findOne({ conversationId }).lean();
        expect(saved.title).toBe('Automatic title');
        expect(saved.lastResponseAt).toEqual(replyAt);
        expect(saved.updatedAt).toEqual(replyAt);
      } finally {
        history.mockRestore();
      }
    },
  );
});
