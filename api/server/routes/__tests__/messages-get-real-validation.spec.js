const { CLIENT_MESSAGE_SELECT } = require('@librechat/data-schemas');
const express = require('express');
const request = require('supertest');

jest.mock('@librechat/agents', () => ({
  ...jest.requireActual('@librechat/agents'),
  CODE_EXECUTION_TOOLS: new Set(['execute_code', 'bash_tool']),
  BashExecutionToolDefinition: {
    name: 'bash_tool',
    description: 'bash',
    schema: { type: 'object', properties: {} },
  },
  ReadFileToolDefinition: {
    name: 'read_file',
    description: 'Read a file',
    parameters: { type: 'object', properties: {} },
    responseFormat: 'content',
  },
  buildBashExecutionToolDescription: () => 'bash',
  sleep: jest.fn(),
}));

jest.mock('@librechat/api', () => ({
  createPrivateTextView: jest.fn(() => (_req, _res, next) => next()),
  createContentFilter: jest.fn(() => (req, res, next) => next()),
  inspectContent: jest.fn(() => null),
  extractFeedbackContent: jest.fn(() => []),
  extractStoredMessageContent: jest.fn(() => []),
  contentFilterBlockResponse: jest.fn(),
  createMessageRequestMiddleware:
    jest.requireActual('@librechat/api').createMessageRequestMiddleware,
  unescapeLaTeX: jest.fn((x) => x),
  countTokens: jest.fn().mockResolvedValue(10),
  sendFeedbackScore: jest.fn().mockResolvedValue(undefined),
  traceIdForMessage: jest.fn((messageId) => `trace-${messageId}`),
  mergeQuotedTextForCount: jest.fn((text) => text),
  GenerationJobManager: {
    getJob: jest.fn(),
  },
  isPendingActionStale: jest.fn(() => false),
  CHILD_THREAD_READ_ONLY_ERROR: 'Child thread is view-only.',
  isSubagentThreadWriteBlocked: jest.fn().mockResolvedValue(false),
  requireFeedbackEnabled: (req, res, next) => next(),
}));

jest.mock('~/server/services/Endpoints/agents/subagentThreadStore', () => ({}));

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
  saveConvo: jest.fn(),
  getConvoOwnership: jest.fn(),
  getMessage: jest.fn(),
  saveMessage: jest.fn(),
  getMessages: jest.fn(),
  updateMessage: jest.fn(),
  deleteMessages: jest.fn(),
  getConvosQueried: jest.fn(),
  searchMessages: jest.fn(),
  getMessagesByCursor: jest.fn(),
}));

jest.mock('~/server/services/Artifacts/update', () => ({
  findAllArtifacts: jest.fn(),
  replaceArtifactContent: jest.fn(),
}));

jest.mock('~/server/middleware/requireJwtAuth', () => (req, res, next) => next());

jest.mock('~/server/middleware', () => {
  const { sendValidationResponse, validateMessageReq, prepareMessageRequestValidation } =
    jest.requireActual('~/server/middleware/messageValidation');

  return {
    requireJwtAuth: (req, res, next) => next(),
    validateMessageReq,
    sendValidationResponse,
    prepareMessageRequestValidation,
    configMiddleware: (req, res, next) => next(),
  };
});

jest.mock('~/db/models', () => ({
  Message: {
    findOne: jest.fn(),
    find: jest.fn(),
    meiliSearch: jest.fn(),
  },
}));

describe('GET /api/messages/:conversationId with real validation middleware', () => {
  let app;
  const { getConvoOwnership, getMessages } = require('~/models');
  const authenticatedUserId = 'user-owner-123';

  beforeAll(() => {
    const messagesRouter = require('../messages');

    app = express();
    app.use(express.json());
    app.use((req, res, next) => {
      req.user = { id: authenticatedUserId };
      next();
    });
    app.use('/api/messages', messagesRouter);
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns the existing empty response for new conversations without fetching messages', async () => {
    const response = await request(app).get('/api/messages/new');

    expect(response.status).toBe(200);
    expect(response.body).toEqual([]);
    expect(getConvoOwnership).not.toHaveBeenCalled();
    expect(getMessages).not.toHaveBeenCalled();
  });

  it('starts user-scoped message reads before real conversation validation resolves', async () => {
    const events = [];
    let resolveConvo;
    const convoPromise = new Promise((resolve) => {
      resolveConvo = resolve;
    });

    getConvoOwnership.mockImplementation(() => {
      events.push('convo-started');
      return convoPromise;
    });

    let resolveMessagesStarted;
    const messagesStartedPromise = new Promise((resolve) => {
      resolveMessagesStarted = resolve;
    });
    getMessages.mockImplementation(() => {
      events.push('messages-started');
      resolveMessagesStarted();
      return Promise.resolve([{ messageId: 'message-1', conversationId: 'convo-1' }]);
    });

    const responsePromise = new Promise((resolve, reject) => {
      request(app)
        .get('/api/messages/convo-1')
        .end((error, response) => (error ? reject(error) : resolve(response)));
    });

    await Promise.race([
      messagesStartedPromise,
      new Promise((resolve) => setTimeout(resolve, 100)),
    ]);
    const eventsBeforeValidation = [...events];

    resolveConvo({ conversationId: 'convo-1', user: authenticatedUserId });
    const response = await responsePromise;

    expect(eventsBeforeValidation).toEqual(['convo-started', 'messages-started']);
    expect(getConvoOwnership).toHaveBeenCalledWith(authenticatedUserId, 'convo-1');
    expect(getMessages).toHaveBeenCalledWith(
      { conversationId: 'convo-1', user: authenticatedUserId },
      CLIENT_MESSAGE_SELECT,
    );
    expect(response.status).toBe(200);
    expect(response.body).toEqual([{ messageId: 'message-1', conversationId: 'convo-1' }]);
  });

  it('does not return messages for a directly addressed child thread', async () => {
    getConvoOwnership.mockResolvedValue({
      conversationId: 'child-convo',
      user: authenticatedUserId,
      subagentThread: { parentConversationId: 'parent-convo' },
    });
    getMessages.mockResolvedValue([{ messageId: 'child-message', conversationId: 'child-convo' }]);

    const response = await request(app).get('/api/messages/child-convo');

    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: 'Conversation not found' });
  });

  it('does not expose a directly addressed child thread through HEAD', async () => {
    getConvoOwnership.mockResolvedValue({
      conversationId: 'child-convo',
      user: authenticatedUserId,
      subagentThread: { parentConversationId: 'parent-convo' },
    });

    const response = await request(app).head('/api/messages/child-convo');

    expect(response.status).toBe(404);
  });
});
