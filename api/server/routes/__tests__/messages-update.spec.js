const express = require('express');
const request = require('supertest');
const { ContentTypes, RetentionMode } = require('librechat-data-provider');

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
 * The route's job is to hand the edited message to the retention helper. Whether it writes is
 * decided by the retention mode (`packages/api/src/conversations/retention.spec.ts`), and which
 * deadline it writes comes from the stored row (`stampForcedRetention` in
 * `packages/data-schemas/src/methods/conversation.spec.ts`).
 */
describe('PUT /:conversationId/:messageId', () => {
  let app;
  const { configMiddleware } = require('~/server/middleware');
  const { getMessages, stampForcedRetention, updateMessage } = require('~/models');
  const { countTokens, applyForcedRetention } = require('@librechat/api');

  const userId = 'user-1';
  const conversationId = 'conversation-1';
  const messageId = 'message-1';
  const interfaceConfig = { retentionMode: RetentionMode.EPHEMERAL, temporaryChatRetention: 1 };

  const expectRestamp = (ctx) =>
    expect(applyForcedRetention).toHaveBeenCalledWith(
      { stampForcedRetention },
      { ctx: expect.objectContaining(ctx), conversationId, messageId },
    );

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
    updateMessage.mockImplementation((authenticatedUserId, payload) =>
      Promise.resolve({
        messageId: payload.messageId,
        conversationId,
        text: payload.text,
        content: payload.content,
        tokenCount: payload.tokenCount,
      }),
    );
  });

  it('applies forced retention when editing message text', async () => {
    getMessages.mockResolvedValue([{ conversationId, quotes: [], isCreatedByUser: true }]);

    const response = await request(app)
      .put(`/api/messages/${conversationId}/${messageId}`)
      .send({ text: 'edited text', model: 'gpt-5' });

    expect(response.status).toBe(200);
    expect(countTokens).toHaveBeenCalledWith('edited text', 'gpt-5');
    expect(updateMessage).toHaveBeenCalledWith(
      userId,
      expect.objectContaining({ messageId, text: 'edited text', tokenCount: 10 }),
    );
    expectRestamp({ userId, interfaceConfig });
  });

  it('applies forced retention when editing a text content part', async () => {
    getMessages.mockResolvedValue([
      {
        conversationId,
        content: [{ type: ContentTypes.TEXT, [ContentTypes.TEXT]: 'old text' }],
        tokenCount: 8,
      },
    ]);

    const response = await request(app)
      .put(`/api/messages/${conversationId}/${messageId}`)
      .send({ text: 'new text', index: 0, model: 'gpt-5' });

    expect(response.status).toBe(200);
    expect(updateMessage).toHaveBeenCalledWith(
      userId,
      expect.objectContaining({
        messageId,
        content: [{ type: ContentTypes.TEXT, [ContentTypes.TEXT]: 'new text' }],
      }),
    );
    expectRestamp({ userId, interfaceConfig });
  });

  it('rejects a message that belongs to another conversation', async () => {
    getMessages.mockResolvedValue([{ conversationId: 'conversation-2' }]);

    const response = await request(app)
      .put(`/api/messages/${conversationId}/${messageId}`)
      .send({ text: 'edited text', model: 'gpt-5' });

    expect(response.status).toBe(404);
    expect(updateMessage).not.toHaveBeenCalled();
    expect(applyForcedRetention).not.toHaveBeenCalled();
  });

  it('does not apply retention when the message update fails', async () => {
    getMessages.mockResolvedValue([{ conversationId, quotes: [], isCreatedByUser: false }]);
    updateMessage.mockRejectedValue(new Error('Message not found or user not authorized.'));

    const response = await request(app)
      .put(`/api/messages/${conversationId}/${messageId}`)
      .send({ text: 'edited text' });

    expect(response.status).toBe(500);
    expect(applyForcedRetention).not.toHaveBeenCalled();
  });
});
