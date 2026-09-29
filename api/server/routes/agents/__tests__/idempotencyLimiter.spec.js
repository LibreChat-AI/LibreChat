const express = require('express');
const request = require('supertest');

const mockHasGenerationClaim = jest.fn();
const mockIpLimiter = jest.fn((_req, res) => res.status(429).json({ limited: 'ip' }));
const mockUserLimiter = jest.fn((_req, res) => res.status(429).json({ limited: 'user' }));
const mockRetryLimiter = jest.fn((_req, _res, next) => next());
const mockRetryProbeLimiter = jest.fn((_req, _res, next) => next());
const mockExemptAgentTrigger = jest.fn(() => false);
const mockExemptSchedule = jest.fn(() => false);

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
}));

jest.mock('~/server/middleware', () => ({
  uaParser: (_req, _res, next) => next(),
  checkBan: (_req, _res, next) => next(),
  requireJwtAuth: (req, _res, next) => {
    req.user = { id: 'user-1' };
    next();
  },
  moderateText: (_req, _res, next) => next(),
  messageIpLimiter: (...args) => mockIpLimiter(...args),
  configMiddleware: (_req, _res, next) => next(),
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
