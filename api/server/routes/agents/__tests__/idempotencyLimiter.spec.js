const express = require('express');
const request = require('supertest');

const mockHasGenerationClaim = jest.fn();
const mockIpLimiter = jest.fn((_req, res) => res.status(429).json({ limited: 'ip' }));
const mockUserLimiter = jest.fn((_req, res) => res.status(429).json({ limited: 'user' }));
const mockRetryLimiter = jest.fn((_req, _res, next) => next());
const mockRetryProbeLimiter = jest.fn((_req, _res, next) => next());
const mockExemptAgentTrigger = jest.fn(() => false);
const mockExemptSchedule = jest.fn(() => false);
const mockIngress = jest.fn((req, _res, next) => {
  if (req.config?.filters?.messages?.pii?.action === 'redact') {
    req.body.text = '[EMAIL_1]';
  }
  next();
});
const mockCheckBan = jest.fn((_req, _res, next) => next());
const mockConfigMiddleware = jest.fn((req, _res, next) => {
  if (req.headers['x-test-private'] === 'yes') {
    req.config = { filters: { messages: { pii: { action: 'redact' } } } };
  }
  next();
});

jest.mock('@librechat/data-schemas', () => ({
  logger: {
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    info: jest.fn(),
  },
}));

jest.mock('@librechat/api', () => ({
  isEnabled: jest.fn(() => true),
  detectGenerationRetry: async (req, _res, next) => {
    req._isConfirmedGenerationRetry = await mockHasGenerationClaim(
      req.user?.id,
      req.body?.clientRequestId,
    );
    next();
  },
  isConfirmedGenerationRetry: (req) => req._isConfirmedGenerationRetry === true,
  generationRetryProbeLimiter: (...args) => mockRetryProbeLimiter(...args),
  generationRetryLimiter: (...args) => mockRetryLimiter(...args),
  isAgentTriggerRequest: jest.fn(() => false),
  captureScheduleFireContext: jest.fn(),
  exemptAgentTriggerFromIpLimiter: (...args) => mockExemptAgentTrigger(...args),
  exemptFromUserLimiter: (...args) => mockExemptSchedule(...args),
  createMessageFilterPii: jest.fn(() => (_req, _res, next) => next()),
  createPrivateTextIngress: jest.fn(
    () =>
      (...args) =>
        mockIngress(...args),
  ),
  isPreDenialTextSubmission: (req) => req.method === 'POST' && typeof req.body?.text === 'string',
  isPrivateTextChatSubmission: (req) =>
    req.method === 'POST' &&
    req.originalUrl === '/agents/chat' &&
    typeof req.body?.text === 'string',
}));

jest.mock('~/server/middleware', () => ({
  uaParser: (_req, _res, next) => next(),
  checkBan: (...args) => mockCheckBan(...args),
  requireJwtAuth: (req, _res, next) => {
    req.user = { id: 'user-1' };
    next();
  },
  moderateText: (_req, _res, next) => next(),
  messageIpLimiter: (...args) => mockIpLimiter(...args),
  configMiddleware: (...args) => mockConfigMiddleware(...args),
  messageUserLimiter: (...args) => mockUserLimiter(...args),
}));

jest.mock('~/server/routes/agents/chat', () => {
  const router = require('express').Router();
  router.post('/', (_req, res) => res.status(201).json({ admitted: true }));
  return router;
});
jest.mock('~/server/routes/agents/v1', () => ({
  v1: require('express').Router(),
}));
jest.mock('~/server/routes/agents/openai', () => require('express').Router());
jest.mock('~/server/routes/agents/responses', () => require('express').Router());
jest.mock('~/server/routes/agents/skills', () => require('express').Router());
jest.mock('~/server/routes/agents/management', () => {
  const router = require('express').Router();
  router.use((_req, res) => res.status(200).json({ surface: 'management' }));
  return router;
});
jest.mock('~/server/controllers/agents/steer', () => {
  const controller = (_req, _res, next) => next();
  controller.SteerDeliveryController = (_req, _res, next) => next();
  controller.SteerCancelController = (_req, _res, next) => next();
  controller.SteerArmController = (_req, _res, next) => next();
  return controller;
});
jest.mock('~/server/controllers/agents/queuedTurns', () => ({
  AgentQueuedTurnEnqueueController: (_req, res) => res.status(202).json({ queued: true }),
  AgentQueuedTurnEnqueueV2Controller: (_req, res) => res.status(202).json({ queued: true }),
  AgentQueuedTurnListController: (_req, res) => res.status(200).json({ queuedTurns: [] }),
  AgentQueuedTurnCancelController: (_req, res) => res.status(200).json({ cancelled: true }),
}));
jest.mock('~/models', () => ({}));
jest.mock('~/server/services/Schedules', () => ({}));

const agentsRouter = require('../index');
const app = express();
app.use(express.json());
app.use('/agents', agentsRouter);

describe('Agent Management route precedence', () => {
  it('reaches management before the catch-all execution router', async () => {
    const response = await request(app).get('/agents/v1/agents');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ surface: 'management' });
  });
});

describe('start-generation idempotency before message limiters', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockExemptAgentTrigger.mockReturnValue(false);
    mockExemptSchedule.mockReturnValue(false);
  });

  it('filters before a ban denial, IP limit, and user limit without charging config twice', async () => {
    mockHasGenerationClaim.mockResolvedValue(false);
    const payload = { text: 'alice@example.com', clientRequestId: 'request-privacy' };
    mockCheckBan.mockImplementationOnce((req, res) => {
      expect(req.body.text).toBe('[EMAIL_1]');
      res.status(403).json({ banned: true });
    });
    const banned = await request(app)
      .post('/agents/chat')
      .set('X-Test-Private', 'yes')
      .send(payload);
    expect(banned.status).toBe(403);
    expect(mockIpLimiter).not.toHaveBeenCalled();

    mockIpLimiter.mockImplementationOnce((req, res) => {
      expect(req.body.text).toBe('[EMAIL_1]');
      res.status(429).json({ limited: 'ip' });
    });
    const ipLimited = await request(app)
      .post('/agents/chat')
      .set('X-Test-Private', 'yes')
      .send(payload);
    expect(ipLimited.status).toBe(429);
    expect(mockUserLimiter).not.toHaveBeenCalled();

    mockIpLimiter.mockImplementationOnce((_req, _res, next) => next());
    mockUserLimiter.mockImplementationOnce((req, res) => {
      expect(req.body.text).toBe('[EMAIL_1]');
      res.status(429).json({ limited: 'user' });
    });
    const userLimited = await request(app)
      .post('/agents/chat')
      .set('X-Test-Private', 'yes')
      .send(payload);
    expect(userLimited.status).toBe(429);
    expect(mockIngress).toHaveBeenCalledTimes(3);
    expect(mockConfigMiddleware).toHaveBeenCalledTimes(3);
  });

  it.each(['/agents/chat/queued-turns', '/agents/chat/queued-turns/v2', '/agents/chat/steer'])(
    'loads policy once ahead of a banned text submission to %s without transforming it',
    async (path) => {
      mockCheckBan.mockImplementationOnce((req, res) => {
        expect(req.config?.filters?.messages?.pii?.action).toBe('redact');
        expect(req.body.text).toBe('alice@example.com');
        res.status(403).json({ banned: true });
      });
      const response = await request(app)
        .post(path)
        .set('X-Test-Private', 'yes')
        .send({ text: 'alice@example.com' });
      expect(response.status).toBe(403);
      expect(mockConfigMiddleware).toHaveBeenCalledTimes(1);
      expect(mockIngress).not.toHaveBeenCalled();
    },
  );

  it('does not reload pre-denial config on an admitted queued submission', async () => {
    mockIpLimiter.mockImplementationOnce((_req, _res, next) => next());
    mockUserLimiter.mockImplementationOnce((_req, _res, next) => next());
    const response = await request(app)
      .post('/agents/chat/queued-turns')
      .set('X-Test-Private', 'yes')
      .send({ text: 'clean queued turn' });
    expect(response.status).toBe(202);
    expect(mockConfigMiddleware).toHaveBeenCalledTimes(1);
  });

  it('keeps a confirmed retry behind the shared IP limiter', async () => {
    mockHasGenerationClaim.mockResolvedValue(true);
    mockIpLimiter.mockImplementationOnce((_req, _res, next) => next());

    const response = await request(app).post('/agents/chat').send({ clientRequestId: 'request-1' });

    expect(response.status).toBe(201);
    expect(mockRetryProbeLimiter).toHaveBeenCalledTimes(1);
    expect(mockRetryLimiter).toHaveBeenCalledTimes(1);
    expect(mockIpLimiter).toHaveBeenCalledTimes(1);
    expect(mockUserLimiter).not.toHaveBeenCalled();
  });

  it('keeps a new submission behind the configured message limiters', async () => {
    mockHasGenerationClaim.mockResolvedValue(false);

    const response = await request(app).post('/agents/chat').send({ clientRequestId: 'request-2' });

    expect(response.status).toBe(429);
    expect(response.body).toEqual({ limited: 'ip' });
    expect(mockRetryProbeLimiter).toHaveBeenCalledTimes(1);
    expect(mockRetryLimiter).toHaveBeenCalledTimes(1);
    expect(mockIpLimiter).toHaveBeenCalledTimes(1);
    expect(mockUserLimiter).not.toHaveBeenCalled();
  });

  it('defers an excessive confirmed retry before the chat pipeline', async () => {
    mockHasGenerationClaim.mockResolvedValue(true);
    mockRetryLimiter.mockImplementationOnce((_req, res) =>
      res.status(503).json({ code: 'SERVER_NOT_READY' }),
    );

    const response = await request(app).post('/agents/chat').send({ clientRequestId: 'request-3' });

    expect(response.status).toBe(503);
    expect(response.body.code).toBe('SERVER_NOT_READY');
    expect(mockIpLimiter).not.toHaveBeenCalled();
    expect(mockUserLimiter).not.toHaveBeenCalled();
  });

  it('bounds candidate probes before durable storage inspection', async () => {
    mockRetryProbeLimiter.mockImplementationOnce((_req, res) =>
      res.status(503).json({ code: 'SERVER_NOT_READY' }),
    );

    const response = await request(app).post('/agents/chat').send({ clientRequestId: 'request-5' });

    expect(response.status).toBe(503);
    expect(mockHasGenerationClaim).not.toHaveBeenCalled();
    expect(mockRetryLimiter).not.toHaveBeenCalled();
    expect(mockIpLimiter).not.toHaveBeenCalled();
    expect(mockUserLimiter).not.toHaveBeenCalled();
  });

  it('keeps an agent-trigger delivery outside the human retry bucket', async () => {
    mockHasGenerationClaim.mockResolvedValue(true);
    mockExemptAgentTrigger.mockReturnValue(true);

    const response = await request(app).post('/agents/chat').send({ clientRequestId: 'request-4' });

    expect(response.status).toBe(201);
    expect(mockRetryProbeLimiter).not.toHaveBeenCalled();
    expect(mockRetryLimiter).not.toHaveBeenCalled();
    expect(mockIpLimiter).not.toHaveBeenCalled();
    expect(mockUserLimiter).not.toHaveBeenCalled();
  });

  it('keeps a scheduled delivery outside the user retry bucket', async () => {
    mockHasGenerationClaim.mockResolvedValue(true);
    mockExemptSchedule.mockReturnValue(true);

    const response = await request(app).post('/agents/chat').send({ clientRequestId: 'request-4' });

    expect(response.status).toBe(429);
    expect(response.body).toEqual({ limited: 'ip' });
    expect(mockRetryProbeLimiter).not.toHaveBeenCalled();
    expect(mockRetryLimiter).not.toHaveBeenCalled();
    expect(mockIpLimiter).toHaveBeenCalledTimes(1);
    expect(mockUserLimiter).not.toHaveBeenCalled();
  });

  it('keeps read-only queued-turn polling outside message admission limiters', async () => {
    const responses = await Promise.all(
      Array.from({ length: 3 }, () =>
        request(app).get('/agents/chat/queued-turns').query({ conversationId: 'conversation-1' }),
      ),
    );

    expect(responses.map((response) => response.status)).toEqual([200, 200, 200]);
    expect(responses[0].body).toEqual({ queuedTurns: [] });
    expect(mockIpLimiter).not.toHaveBeenCalled();
    expect(mockUserLimiter).not.toHaveBeenCalled();
  });

  it.each([
    ['enqueue', () => request(app).post('/agents/chat/queued-turns').send({ text: 'next' })],
    [
      'v2 enqueue',
      () =>
        request(app)
          .post('/agents/chat/queued-turns/v2')
          .send({ text: 'next', codeApprovalMode: 'ask' }),
    ],
    ['cancel', () => request(app).delete('/agents/chat/queued-turns/queued-turn-1')],
  ])('keeps queued-turn %s mutations behind message admission limiters', async (_label, send) => {
    const response = await send();

    expect(response.status).toBe(429);
    expect(response.body).toEqual({ limited: 'ip' });
    expect(mockIpLimiter).toHaveBeenCalledTimes(1);
    expect(mockUserLimiter).not.toHaveBeenCalled();
  });
});
