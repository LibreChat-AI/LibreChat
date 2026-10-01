const express = require('express');
const request = require('supertest');

const MOCKS = '../__test-utils__/convos-route-mocks';
jest.mock('~/server/services/Config/app', () => ({ getAppConfig: jest.fn() }));

jest.mock('@librechat/agents', () => require(MOCKS).agents());
jest.mock('@librechat/api', () =>
  require(MOCKS).api({
    limiterCache: jest.fn(() => undefined),
    createContentFilter: jest.fn(() => (req, res, next) => next()),
    inspectContent: jest.fn(() => null),
    extractConversationTitleContent: jest.fn(() => []),
    contentFilterBlockResponse: jest.fn(),
  }),
);
jest.mock('@librechat/data-schemas', () => require(MOCKS).dataSchemas());
jest.mock('librechat-data-provider', () =>
  require(MOCKS).dataProvider({ ViolationTypes: { FILE_UPLOAD_LIMIT: 'file_upload_limit' } }),
);

jest.mock('~/cache/logViolation', () => jest.fn().mockResolvedValue(undefined));
jest.mock('~/cache/getLogStores', () => require(MOCKS).logStores());
jest.mock('~/models', () => ({
  ...require(MOCKS).sharedModels(),
  ...require(MOCKS).conversationModel(),
  ...require(MOCKS).toolCallModel(),
}));
jest.mock('~/server/middleware/requireJwtAuth', () => require(MOCKS).requireJwtAuth());

jest.mock('~/server/middleware', () => {
  const { createForkLimiters } = jest.requireActual('~/server/middleware/limiters/forkLimiters');
  return {
    createImportLimiters: jest.fn(() => ({
      importIpLimiter: (req, res, next) => next(),
      importUserLimiter: (req, res, next) => next(),
    })),
    createForkLimiters,
    configMiddleware: (req, res, next) => next(),
    validateConvoAccess: (req, res, next) => next(),
  };
});

jest.mock('~/server/utils/import/fork', () => require(MOCKS).forkUtils());
jest.mock('~/server/utils/import', () => require(MOCKS).importUtils());
jest.mock('~/server/routes/files/multer', () => require(MOCKS).multerSetup());
jest.mock('multer', () => require(MOCKS).multerLib());
jest.mock('~/server/services/Endpoints/azureAssistants', () => require(MOCKS).assistantEndpoint());
jest.mock('~/server/services/Endpoints/assistants', () => require(MOCKS).assistantEndpoint());
jest.mock('~/server/services/Endpoints/agents/subagentThreadStore', () =>
  require(MOCKS).subagentThreadStore(),
);
jest.mock('~/server/services/Endpoints/agents/backgroundCompletion', () => ({
  pendingBackgroundToolCompletions: { list: jest.fn() },
}));

describe('POST /api/convos/duplicate - Rate Limiting', () => {
  let app;
  let duplicateConversation;
  const savedEnv = {};

  beforeAll(() => {
    savedEnv.FORK_USER_MAX = process.env.FORK_USER_MAX;
    savedEnv.FORK_USER_WINDOW = process.env.FORK_USER_WINDOW;
    savedEnv.FORK_IP_MAX = process.env.FORK_IP_MAX;
    savedEnv.FORK_IP_WINDOW = process.env.FORK_IP_WINDOW;
  });

  afterAll(() => {
    for (const key of Object.keys(savedEnv)) {
      if (savedEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = savedEnv[key];
      }
    }
  });

  const setupApp = () => {
    jest.clearAllMocks();
    jest.isolateModules(() => {
      const convosRouter = require('../convos');
      ({ duplicateConversation } = require('~/server/utils/import/fork'));

      app = express();
      app.use(express.json());
      app.use((req, res, next) => {
        req.user = { id: 'rate-limit-test-user' };
        next();
      });
      app.use('/api/convos', convosRouter);
    });

    duplicateConversation.mockResolvedValue({
      conversation: { conversationId: 'duplicated-conv' },
    });
  };

  describe('user limit', () => {
    beforeEach(() => {
      process.env.FORK_USER_MAX = '2';
      process.env.FORK_USER_WINDOW = '1';
      process.env.FORK_IP_MAX = '100';
      process.env.FORK_IP_WINDOW = '1';
      setupApp();
    });

    it('should return 429 after exceeding the user rate limit', async () => {
      const userMax = parseInt(process.env.FORK_USER_MAX, 10);

      for (let i = 0; i < userMax; i++) {
        const res = await request(app)
          .post('/api/convos/duplicate')
          .send({ conversationId: 'conv-123' });
        expect(res.status).toBe(201);
      }

      const res = await request(app)
        .post('/api/convos/duplicate')
        .send({ conversationId: 'conv-123' });
      expect(res.status).toBe(429);
      expect(res.body.message).toMatch(/too many/i);
    });
  });

  describe('IP limit', () => {
    beforeEach(() => {
      process.env.FORK_USER_MAX = '100';
      process.env.FORK_USER_WINDOW = '1';
      process.env.FORK_IP_MAX = '2';
      process.env.FORK_IP_WINDOW = '1';
      setupApp();
    });

    it('should return 429 after exceeding the IP rate limit', async () => {
      const ipMax = parseInt(process.env.FORK_IP_MAX, 10);

      for (let i = 0; i < ipMax; i++) {
        const res = await request(app)
          .post('/api/convos/duplicate')
          .send({ conversationId: 'conv-123' });
        expect(res.status).toBe(201);
      }

      const res = await request(app)
        .post('/api/convos/duplicate')
        .send({ conversationId: 'conv-123' });
      expect(res.status).toBe(429);
      expect(res.body.message).toMatch(/too many/i);
    });
  });
});
