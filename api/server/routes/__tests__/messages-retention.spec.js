const express = require('express');
const request = require('supertest');
const { RetentionMode } = require('librechat-data-provider');

jest.mock('@librechat/agents', () => ({
  sleep: jest.fn(),
}));

jest.mock('@librechat/api', () => ({
  unescapeLaTeX: jest.fn((value) => value),
  countTokens: jest.fn().mockResolvedValue(10),
  createContentFilter: jest.fn(() => (_req, _res, next) => next()),
  sendFeedbackScore: jest.fn().mockResolvedValue(undefined),
  traceIdForMessage: jest.fn((messageId) => `trace-${messageId}`),
  mergeQuotedTextForCount: jest.fn((text) => text),
  assertStoredMessageMutationAllowed: jest.fn(),
  assertChatMutationAllowed: jest.fn(),
  assertStoredMessageBranchAllowed: jest.fn(),
  mergeUserSubmittedPaths: (...lists) => [...new Set(lists.flat().filter(Boolean))],
  mergeUserSubmittedMessageFieldPaths: (...lists) => lists.flat().filter(Boolean),
  isContentFilterError: jest.fn(() => false),
  CHILD_THREAD_READ_ONLY_ERROR: 'Child thread is view-only.',
  isSubagentThreadWriteBlocked: jest.fn().mockResolvedValue(false),
  requireFeedbackEnabled: (req, res, next) => next(),
  applyForcedRetention: jest.fn(),
}));

jest.mock('@librechat/data-schemas', () => ({
  ...jest.requireActual('@librechat/data-schemas'),
  logger: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

jest.mock('~/server/services/Endpoints/agents/subagentThreadStore', () => ({}));

jest.mock('~/models', () => ({
  stampForcedRetention: jest.fn(),
  saveConvo: jest.fn(),
  getConvo: jest.fn(),
  getMessage: jest.fn(),
  saveMessage: jest.fn(),
  getMessages: jest.fn(),
  getFiles: jest.fn().mockResolvedValue([]),
  updateMessage: jest.fn(),
  deleteMessages: jest.fn(),
}));

jest.mock('~/server/services/Artifacts/update', () => ({
  findAllArtifacts: jest.fn(),
  replaceArtifactContent: jest.fn(),
}));

jest.mock('~/server/middleware', () => ({
  requireJwtAuth: (req, res, next) => next(),
  validateMessageReq: (req, res, next) => next(),
  configMiddleware: jest.fn((req, res, next) => next()),
  sendValidationResponse: jest.fn(),
  canReadActiveJobConversation: jest.fn().mockResolvedValue(false),
  prepareMessageRequestValidation: jest.fn(),
}));

/**
 * Each of these routes writes a message without going through the conversation, so under
 * forced retention the chat holding it has to be re-stamped too. Whether the helper writes
 * is decided by the retention mode and covered in
 * `packages/api/src/conversations/retention.spec.ts`.
 */
describe('message writes that bypass conversation retention', () => {
  let app;
  const { configMiddleware } = require('~/server/middleware');
  const { getMessage, saveMessage, stampForcedRetention } = require('~/models');
  const { applyForcedRetention } = require('@librechat/api');
  const {
    findAllArtifacts,
    replaceArtifactContent,
  } = require('~/server/services/Artifacts/update');

  const userId = 'user-1';
  const conversationId = 'conversation-1';
  const messageId = 'message-1';
  const interfaceConfig = { retentionMode: RetentionMode.EPHEMERAL, temporaryChatRetention: 1 };

  beforeAll(() => {
    const messagesRouter = require('../messages');

    app = express();
    app.use(express.json());
    app.use((req, res, next) => {
      req.user = { id: userId };
      req.config = { interfaceConfig };
      next();
    });
    app.use('/api/messages', messagesRouter);
  });

  beforeEach(() => {
    jest.clearAllMocks();
    configMiddleware.mockImplementation((req, res, next) => next());
  });

  describe('POST /artifact/:messageId', () => {
    beforeEach(() => {
      getMessage.mockResolvedValue({
        messageId,
        conversationId,
        text: 'original artifact',
        content: undefined,
      });
      findAllArtifacts.mockReturnValue([{ source: 'text', partIndex: 0 }]);
      replaceArtifactContent.mockReturnValue('updated artifact');
      saveMessage.mockResolvedValue({ messageId, conversationId, text: 'updated artifact' });
    });

    it('re-stamps the parent conversation of the edited message', async () => {
      const response = await request(app)
        .post(`/api/messages/artifact/${messageId}`)
        .send({ index: 0, original: 'original artifact', updated: 'updated artifact' });

      expect(response.status).toBe(200);
      expect(saveMessage).toHaveBeenCalledWith(
        expect.objectContaining({ userId, interfaceConfig }),
        expect.objectContaining({ messageId, conversationId, user: userId }),
        { context: 'POST /api/messages/artifact/:messageId' },
      );
      expect(applyForcedRetention).toHaveBeenCalledWith(
        { stampForcedRetention },
        {
          ctx: expect.objectContaining({ userId, interfaceConfig }),
          conversationId,
        },
      );
    });

    it('does not touch the conversation when the artifact edit fails to match', async () => {
      replaceArtifactContent.mockReturnValue(null);

      const response = await request(app)
        .post(`/api/messages/artifact/${messageId}`)
        .send({ index: 0, original: 'missing', updated: 'updated artifact' });

      expect(response.status).toBe(400);
      expect(saveMessage).not.toHaveBeenCalled();
      expect(applyForcedRetention).not.toHaveBeenCalled();
    });
  });

  describe('PUT /:conversationId/:messageId/feedback', () => {
    const { updateMessage } = require('~/models');

    it('re-stamps the chat when feedback is the first write after the mode is enabled', async () => {
      updateMessage.mockResolvedValue({
        messageId,
        conversationId,
        endpoint: 'openAI',
        feedback: { rating: 'thumbsDown', tag: 'inaccurate' },
      });

      const response = await request(app)
        .put(`/api/messages/${conversationId}/${messageId}/feedback`)
        .send({ feedback: { rating: 'thumbsDown', tag: 'inaccurate' } });

      expect(response.status).toBe(200);
      expect(applyForcedRetention).toHaveBeenCalledWith(
        { stampForcedRetention },
        {
          ctx: expect.objectContaining({ userId, interfaceConfig }),
          conversationId,
          messageId,
        },
      );
    });

    it('re-stamps the stored conversation, not the one named in the route', async () => {
      updateMessage.mockResolvedValue({
        messageId,
        conversationId: 'conversation-2',
        endpoint: 'openAI',
        feedback: { rating: 'thumbsDown', tag: 'inaccurate' },
      });

      const response = await request(app)
        .put(`/api/messages/${conversationId}/${messageId}/feedback`)
        .send({ feedback: { rating: 'thumbsDown', tag: 'inaccurate' } });

      expect(response.status).toBe(200);
      expect(applyForcedRetention).toHaveBeenCalledWith(
        { stampForcedRetention },
        expect.objectContaining({ conversationId: 'conversation-2', messageId }),
      );
    });
  });

  describe('POST /branch', () => {
    const agentId = 'agent-1';
    const sourceMessage = {
      messageId,
      conversationId,
      parentMessageId: 'parent-1',
      isCreatedByUser: false,
      isTemporary: false,
      content: [{ type: 'text', text: 'branched part', agentId }],
    };

    beforeEach(() => {
      getMessage.mockResolvedValue(sourceMessage);
      saveMessage.mockImplementation((_ctx, message) =>
        Promise.resolve({ ...message, expiredAt: undefined }),
      );
    });

    it('re-stamps the conversation the branch was created in', async () => {
      const response = await request(app).post('/api/messages/branch').send({ messageId, agentId });

      expect(response.status).toBe(201);
      expect(applyForcedRetention).toHaveBeenCalledWith(
        { stampForcedRetention },
        {
          ctx: expect.objectContaining({ userId, interfaceConfig }),
          conversationId,
        },
      );
    });

    it('does not re-stamp when the branch message cannot be saved', async () => {
      saveMessage.mockResolvedValue(null);

      const response = await request(app).post('/api/messages/branch').send({ messageId, agentId });

      expect(response.status).toBe(500);
      expect(applyForcedRetention).not.toHaveBeenCalled();
    });
  });
});
