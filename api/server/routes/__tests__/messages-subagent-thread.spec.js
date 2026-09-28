const express = require('express');
const request = require('supertest');

const mockIsSubagentThreadWriteBlocked = jest.fn();

jest.mock('@librechat/agents', () => ({ sleep: jest.fn() }));

jest.mock('@librechat/api', () => ({
  withoutTraceRefs: jest.fn((message) => message),
  createContentFilter: jest.fn(() => (_req, _res, next) => next()),
  unescapeLaTeX: jest.fn((value) => value),
  countTokens: jest.fn().mockResolvedValue(1),
  sendFeedbackScore: jest.fn().mockResolvedValue(undefined),
  traceIdForMessage: jest.fn((messageId) => `trace-${messageId}`),
  mergeQuotedTextForCount: jest.fn((text) => text),
  assertStoredMessageMutationAllowed: jest.fn(),
  assertChatMutationAllowed: jest.fn(),
  assertStoredMessageBranchAllowed: jest.fn(),
  mergeUserSubmittedPaths: (...lists) => [...new Set(lists.flat().filter(Boolean))],
  mergeUserSubmittedMessageFieldPaths: (...lists) => lists.flat().filter(Boolean),
  isContentFilterError: jest.fn(() => false),
  CHILD_THREAD_READ_ONLY_ERROR: 'This subagent thread is view-only.',
  isSubagentThreadWriteBlocked: (...args) => mockIsSubagentThreadWriteBlocked(...args),
  requireFeedbackEnabled: (req, res, next) => next(),
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

jest.mock('librechat-data-provider', () => ({
  ...jest.requireActual('librechat-data-provider'),
}));

jest.mock('~/models', () => ({
  getConvo: jest.fn(),
  getMessage: jest.fn(),
  getMessages: jest.fn(),
  saveConvo: jest.fn(),
  saveMessage: jest.fn(),
  updateMessage: jest.fn(),
  deleteMessages: jest.fn(),
  getConvosQueried: jest.fn(),
  searchMessages: jest.fn(),
  getMessagesByCursor: jest.fn(),
}));

jest.mock('~/server/services/Endpoints/agents/subagentThreadStore', () => ({
  isThreadActiveForOwner: jest.fn(),
}));

jest.mock('~/server/services/Artifacts/update', () => ({
  findAllArtifacts: jest.fn(),
  replaceArtifactContent: jest.fn(),
}));

jest.mock('~/server/middleware', () => ({
  requireJwtAuth: (req, _res, next) => next(),
  validateMessageReq: (req, _res, next) => next(),
  configMiddleware: (req, _res, next) => next(),
  sendValidationResponse: jest.fn(),
  prepareMessageRequestValidation: jest.fn(),
}));

describe('message mutation policy for durable subagent threads', () => {
  let app;
  const db = require('~/models');

  beforeAll(() => {
    const messagesRouter = require('../messages');
    app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.user = { id: 'owner-user', tenantId: 'tenant-a' };
      next();
    });
    app.use('/api/messages', messagesRouter);
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockIsSubagentThreadWriteBlocked.mockResolvedValue(true);
    db.getMessage.mockResolvedValue({
      messageId: 'message-1',
      conversationId: 'child-conversation',
      isCreatedByUser: false,
      content: [],
    });
    db.getMessages.mockResolvedValue([
      {
        messageId: 'message-1',
        conversationId: 'child-conversation',
        isCreatedByUser: false,
        content: [],
      },
    ]);
  });

  it('blocks every transcript-affecting message route through one shared policy', async () => {
    const responses = await Promise.all([
      request(app)
        .post('/api/messages/child-conversation')
        .send({ messageId: 'new-message', text: 'write' }),
      request(app)
        .put('/api/messages/child-conversation/message-1')
        .send({ text: 'edit', model: 'gpt-5' }),
      request(app).delete('/api/messages/child-conversation/message-1'),
      request(app).post('/api/messages/branch').send({
        messageId: 'message-1',
        agentId: 'agent-1',
      }),
      request(app).post('/api/messages/artifact/message-1').send({
        index: 0,
        original: 'before',
        updated: 'after',
      }),
    ]);

    expect(responses.map((response) => response.status)).toEqual([409, 409, 409, 409, 409]);
    for (const response of responses) {
      expect(response.body).toEqual({ error: 'This subagent thread is view-only.' });
    }
    expect(mockIsSubagentThreadWriteBlocked).toHaveBeenCalledTimes(5);
    expect(mockIsSubagentThreadWriteBlocked).toHaveBeenCalledWith(
      expect.objectContaining({ getConvo: expect.any(Function) }),
      {
        userId: 'owner-user',
        conversationId: 'child-conversation',
        tenantId: 'tenant-a',
      },
    );
    expect(db.saveMessage).not.toHaveBeenCalled();
    expect(db.saveConvo).not.toHaveBeenCalled();
    expect(db.updateMessage).not.toHaveBeenCalled();
    expect(db.deleteMessages).not.toHaveBeenCalled();
  });

  it('authorizes edits against the message owner conversation, not a writable URL', async () => {
    mockIsSubagentThreadWriteBlocked.mockResolvedValue(true);
    db.getMessages.mockResolvedValue([
      {
        messageId: 'message-1',
        conversationId: 'child-conversation',
        isCreatedByUser: true,
        content: [],
      },
    ]);

    const response = await request(app)
      .put('/api/messages/ordinary-conversation/message-1')
      .send({ text: 'forged edit', model: 'gpt-5' });

    expect(response.status).toBe(404);
    expect(mockIsSubagentThreadWriteBlocked).not.toHaveBeenCalled();
    expect(db.updateMessage).not.toHaveBeenCalled();
  });
});
