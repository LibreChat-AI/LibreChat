const express = require('express');
const request = require('supertest');
const mockGetFiles = jest.fn();
const mockCreateMessageFilterPii = jest.fn(() => (_req, _res, next) => next());
const mockGetSafeErrorMetadata = jest.fn((error) => ({
  type: error instanceof Error ? 'Error' : 'UnknownError',
  ...(Number.isInteger(error?.response?.status) && { status: error.response.status }),
}));
const mockLogger = {
  warn: jest.fn(),
};

jest.mock('@librechat/data-schemas', () => ({
  logger: mockLogger,
}));

jest.mock('@librechat/api', () => ({
  validateChatMessageIds: jest.requireActual(
    '../../../../../packages/api/src/middleware/messageIds',
  ).validateChatMessageIds,
  createMessageFilterPii: mockCreateMessageFilterPii,
  generateCheckAccess: jest.fn(() => (_req, _res, next) => next()),
  skipAgentCheck: jest.fn(),
  applyResumeRequest: jest.fn(),
  GenerationJobManager: {
    getJob: jest.fn(),
  },
  getSafeErrorMetadata: mockGetSafeErrorMetadata,
}));

jest.mock('~/server/middleware', () => ({
  moderateText: (_req, _res, next) => next(),
  validateConvoAccess: (_req, _res, next) => next(),
  buildEndpointOption: (_req, _res, next) => next(),
  canAccessAgentFromBody: jest.fn(() => (_req, _res, next) => next()),
}));

jest.mock('~/server/middleware/validate/subagentThreadTurn', () => (_req, _res, next) => next());

jest.mock('~/server/services/Endpoints/agents', () => ({
  initializeClient: jest.fn(),
}));
jest.mock('~/server/controllers/agents/request', () => jest.fn());
jest.mock('~/server/controllers/agents/resume', () => jest.fn());
jest.mock('~/server/services/Endpoints/agents/title', () => jest.fn());
jest.mock('~/models', () => ({
  getFiles: mockGetFiles,
  getRoleByName: jest.fn(),
}));

describe('agents chat content filtering', () => {
  it('provides owner-scoped canonical file lookup to the message filter', () => {
    require('../chat');

    expect(mockCreateMessageFilterPii).toHaveBeenCalledTimes(1);
    expect(mockCreateMessageFilterPii.mock.calls[0][0]).toMatchObject({
      getFiles: mockGetFiles,
    });
  });

  it('logs only bounded metadata when resume context restoration fails', async () => {
    const api = require('@librechat/api');
    const router = require('../chat');
    const restoreResumeContext = router.stack.find(
      (layer) => layer.handle?.name === 'restoreResumeContext',
    )?.handle;
    const rawValue = 'PRIVATE-RESUME-CONTEXT';
    const restoreError = Object.assign(new Error(rawValue), {
      response: { status: 503, data: rawValue },
    });
    api.GenerationJobManager.getJob.mockRejectedValueOnce(restoreError);
    const next = jest.fn();

    await restoreResumeContext(
      {
        path: '/resume',
        body: { conversationId: 'conversation-1' },
      },
      {},
      next,
    );

    expect(mockGetSafeErrorMetadata).toHaveBeenCalledWith(restoreError);
    expect(mockLogger.warn).toHaveBeenCalledWith('[agents/chat] Failed to restore resume context', {
      type: 'Error',
      status: 503,
    });
    expect(JSON.stringify(mockLogger.warn.mock.calls)).not.toContain(rawValue);
    expect(next).toHaveBeenCalledTimes(1);
  });
});

describe('agents chat message-ID ingress', () => {
  function createAuthenticatedApp() {
    const app = express();
    app.use(express.json({ limit: '3mb' }));
    app.use((req, res, next) => {
      if (req.headers.authorization !== 'Bearer test-user') {
        return res.sendStatus(401);
      }
      req.user = { id: 'user-123' };
      next();
    });
    app.use('/api/agents/chat', require('../chat'));
    app.get('/health', (_req, res) => res.sendStatus(200));
    return app;
  }

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it.each(['/', '/openAI', '/resume'])(
    'rejects oversized message identities before admission at %s',
    async (path) => {
      const app = createAuthenticatedApp();
      const controller = require('~/server/controllers/agents/request');
      const resumeController = require('~/server/controllers/agents/resume');
      const api = require('@librechat/api');
      const payload = '_'.repeat(80_000) + 'X';
      for (const field of ['messageId', 'responseMessageId']) {
        const response = await request(app)
          .post(`/api/agents/chat${path}`)
          .set('Authorization', 'Bearer test-user')
          .send({ [field]: payload, conversationId: 'new' });
        expect(response.status).toBe(400);
        expect(response.body).toEqual({
          code: 'INVALID_MESSAGE_ID',
          error: expect.stringContaining(field),
        });
        expect(JSON.stringify(response.body)).not.toContain(payload);
      }
      expect(controller).not.toHaveBeenCalled();
      expect(resumeController).not.toHaveBeenCalled();
      expect(api.GenerationJobManager.getJob).not.toHaveBeenCalled();
      await request(app).get('/health').set('Authorization', 'Bearer test-user').expect(200);
    },
  );

  it.each(['', 42, {}, [], 'invalid/id', 'invalid id', 'invalid\n'])(
    'rejects malformed message identities',
    async (messageId) => {
      await request(createAuthenticatedApp())
        .post('/api/agents/chat')
        .set('Authorization', 'Bearer test-user')
        .send({ messageId })
        .expect(400);
      expect(require('~/server/controllers/agents/request')).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['fresh user', { messageId: 'a'.repeat(257) + '_' }],
    ['fresh user at 257', { messageId: 'a'.repeat(256) + '_' }],
    ['compaction', { messageId: 'a'.repeat(257) + '_', compact: true }],
    ['response', { responseMessageId: 'a'.repeat(257) + '_' }],
  ])('rejects oversized %s identities at the protocol boundary', async (_label, body) => {
    await request(createAuthenticatedApp())
      .post('/api/agents/chat')
      .set('Authorization', 'Bearer test-user')
      .send(body)
      .expect(400);
    expect(require('~/server/controllers/agents/request')).not.toHaveBeenCalled();
  });

  it.each([
    ['overrideUserMessageId', 'a'.repeat(257)],
    ['overrideUserMessageId', 'a'.repeat(257) + '__0'],
    ['overrideUserMessageId', 'safe__' + '0'.repeat(80_000)],
    ['overrideUserMessageId', 'a'.repeat(256) + '__' + '0'.repeat(17)],
    ['overrideUserMessageId', '_'.repeat(80_000) + 'X'],
    ['overrideUserMessageId', '__0'],
    ['overrideUserMessageId', 'invalid/id__0'],
    ['overrideUserMessageId', 'valid__invalid/id'],
    ['overrideUserMessageId', ''],
    ['overrideUserMessageId', 42],
    ['overrideParentMessageId', 'a'.repeat(257)],
    ['overrideParentMessageId', 'invalid/id'],
    ['parentMessageId', 'a'.repeat(258)],
    ['parentMessageId', {}],
  ])('rejects an invalid effective identity from %s before admission', async (field, value) => {
    const app = createAuthenticatedApp();
    const response = await request(app)
      .post('/api/agents/chat/agents')
      .set('Authorization', 'Bearer test-user')
      .send({ messageId: 'valid-user', responseMessageId: 'valid-response', [field]: value });
    expect(response.status).toBe(400);
    expect(response.body.code).toBe('INVALID_MESSAGE_ID');
    expect(response.body.error).toContain(field);
    expect(require('~/server/controllers/agents/request')).not.toHaveBeenCalled();
    expect(require('@librechat/api').GenerationJobManager.getJob).not.toHaveBeenCalled();
  });

  it.each([
    {},
    {
      messageId: null,
      responseMessageId: null,
      overrideUserMessageId: null,
      overrideParentMessageId: null,
    },
    { messageId: 'valid-user', overrideUserMessageId: 'recovery-user' },
    { messageId: 'valid-user', overrideUserMessageId: 'a'.repeat(256) + '__0' },
    { messageId: 'valid-user', overrideUserMessageId: 'a'.repeat(256) + '__9007199254740991' },
    { messageId: 'valid-user', overrideUserMessageId: 'existing-user__1' },
    { messageId: 'valid-user', overrideParentMessageId: 'a'.repeat(256), isRegenerate: true },
    { messageId: 'valid-user', parentMessageId: 'a'.repeat(257) },
    { messageId: '550e8400-e29b-41d4-a716-446655440000' },
    {
      compact: true,
      conversationId: 'existing-conversation',
      messageId: 'a'.repeat(256) + '_',
      parentMessageId: 'a'.repeat(256) + '_',
    },
    { messageId: 'a'.repeat(256), responseMessageId: 'a'.repeat(256) + '_', isRegenerate: true },
    { messageId: 'nanoid_-', responseMessageId: 'event-turn:assistant', isRegenerate: true },
    { messageId: 'edited-user__', responseMessageId: 'existing-response', editedContent: {} },
  ])('preserves supported turn shapes', async (body) => {
    const controller = require('~/server/controllers/agents/request');
    controller.mockImplementationOnce((_req, res) => res.sendStatus(202));
    await request(createAuthenticatedApp())
      .post('/api/agents/chat')
      .set('Authorization', 'Bearer test-user')
      .send(body)
      .expect(202);
    expect(controller).toHaveBeenCalledTimes(1);
  });
});
