const mongoose = require('mongoose');
const { v4 } = require('uuid');
const { MongoMemoryServer } = require('mongodb-memory-server');

jest.mock('@librechat/api', () => ({
  ...jest.requireActual('@librechat/api'),
  countTokens: jest.fn().mockResolvedValue(1),
}));

jest.mock('~/server/services/Files/process', () => ({ retrieveAndProcessFile: jest.fn() }));

const { Message, Conversation, ChatProject } = require('~/db/models');
const { createChatProject, assignConversationToProject } = require('~/models');
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

  it('seeds Project membership once and preserves a concurrent move without revalidation', async () => {
    const user = new mongoose.Types.ObjectId().toString();
    const conversationId = v4();
    const firstProject = await createChatProject(user, { name: 'Original project' });
    const nextProject = await createChatProject(user, { name: 'Moved project' });
    const firstProjectId = firstProject._id.toString();
    const nextProjectId = nextProject._id.toString();
    const req = {
      user: { id: user },
      body: { conversationId },
      resolvedConversation: null,
      chatProjectContext: { projectId: firstProjectId },
      config: {},
    };
    const params = {
      user,
      conversationId,
      endpoint: 'assistants',
      assistant_id: 'asst_project',
      thread_id: 'thread_project',
      text: 'Continue with the authorized context.',
    };
    await saveUserMessage(req, { ...params, messageId: v4() });
    expect(req.resolvedConversation.chatProjectId).toBe(firstProjectId);

    await assignConversationToProject(user, conversationId, nextProjectId);
    const projectLookup = jest.spyOn(ChatProject, 'exists');
    try {
      await saveUserMessage(req, { ...params, messageId: v4() });
      const saved = await Conversation.findOne({ user, conversationId }).lean();
      expect(saved.chatProjectId).toBe(nextProjectId);
      expect(projectLookup).not.toHaveBeenCalled();
    } finally {
      projectLookup.mockRestore();
    }
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
      const attachments = [
        {
          type: 'ui_resources',
          messageId: 'assistant-app-message',
          conversationId,
          toolCallId: 'call_1',
          ui_resources: [{ uri: 'ui://app', mimeType: 'text/html;profile=mcp-app' }],
        },
      ];
      await saveAssistantMessage(req, {
        ...params,
        messageId: v4(),
        parentMessageId: userMessage.messageId,
        content: [],
        attachments,
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
      expect(rows.find((row) => row.isCreatedByUser === false)?.attachments).toEqual(attachments);
      expect(convo.lastResponseAt != null).toBe(!isTemporary);
    },
  );

  it('appends the saved turn IDs without reloading message history', async () => {
    const user = new mongoose.Types.ObjectId().toString();
    const conversationId = v4();
    const req = { user: { id: user }, body: {}, config: {} };
    const params = {
      user,
      conversationId,
      endpoint: 'assistants',
      assistant_id: 'asst_test',
      thread_id: 'thread_test',
      text: 'hello',
    };
    const history = jest.spyOn(Message, 'find');
    try {
      const userMessage = await saveUserMessage(req, { ...params, messageId: v4() });
      const { message, conversation } = await saveAssistantMessage(req, {
        ...params,
        messageId: v4(),
        parentMessageId: userMessage.messageId,
        content: [],
      });

      expect(history).not.toHaveBeenCalled();
      expect(new Set(conversation.messages.map(String))).toEqual(
        new Set([String(userMessage._id), String(message._id)]),
      );
    } finally {
      history.mockRestore();
    }
  });
});
