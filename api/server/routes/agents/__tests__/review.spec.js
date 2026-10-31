const express = require('express');
const request = require('supertest');

const mockOrder = [];
let mockLimit;
jest.mock('@librechat/api', () => ({
  ...jest.requireActual('@librechat/api'),
  isEnabled: () => true,
  captureScheduleFireContext: jest.fn(),
}));
jest.mock('~/server/middleware', () => ({
  uaParser: (_req, _res, next) => next(),
  checkBan: (_req, _res, next) => next(),
  requireJwtAuth: (req, res, next) => {
    if (req.headers['x-test-owner'] !== 'yes') return res.sendStatus(401);
    req.user = { id: 'owner' };
    mockOrder.push('auth');
    next();
  },
  requireTermsAcceptance: (_req, _res, next) => {
    mockOrder.push('terms');
    next();
  },
  configMiddleware: (req, _res, next) => {
    mockOrder.push('config');
    req.config = {};
    next();
  },
  messageIpLimiter: (_req, res, next) => {
    mockOrder.push('ip');
    if (mockLimit === 'ip') return res.sendStatus(429);
    next();
  },
  messageUserLimiter: (_req, res, next) => {
    mockOrder.push('user');
    if (mockLimit === 'user') return res.sendStatus(429);
    next();
  },
  moderateText: (_req, _res, next) => next(),
}));
jest.mock('~/server/services/Responses', () => ({
  reviewBackgroundResponse: (_req, res) => res.sendStatus(200),
  submitBackgroundResponseReview: (req, res) => {
    mockOrder.push('submit');
    res.status(202).json(req.body);
  },
  cancelOwnerBackgroundResponse: (_req, res) => {
    mockOrder.push('cancel');
    res.status(200).json({ status: 'cancelled' });
  },
}));
jest.mock('~/server/routes/agents/chat', () => require('express').Router());
jest.mock('~/server/routes/agents/openai', () => require('express').Router());
jest.mock('~/server/routes/agents/responses', () => require('express').Router());
jest.mock('~/server/routes/agents/skills', () => require('express').Router());
jest.mock('~/server/routes/agents/management', () => require('express').Router());
jest.mock('~/server/routes/agents/v1', () => ({ v1: require('express').Router() }));

const router = require('../index');
const app = express();
app.use(express.json());
app.use('/agents', router);
beforeEach(() => {
  mockOrder.length = 0;
  mockLimit = undefined;
});

it('authenticates, loads policy, and applies existing rate limits before saving owner consent', async () => {
  const decision = { actionId: 'action', answer: 'answer' };
  await request(app)
    .post('/agents/responses/response/review')
    .set('x-test-owner', 'yes')
    .send(decision)
    .expect(202, decision);
  expect(mockOrder).toEqual(['auth', 'terms', 'config', 'ip', 'user', 'submit']);
});

it.each(['ip', 'user'])('does not submit a decision when the %s limit denies it', async (limit) => {
  mockLimit = limit;
  await request(app)
    .post('/agents/responses/response/review')
    .set('x-test-owner', 'yes')
    .send({ actionId: 'action', answer: 'answer' })
    .expect(429);
  expect(mockOrder).not.toContain('submit');
});

it('does not reach policy or submission without owner authentication', async () => {
  await request(app).post('/agents/responses/response/review').send({}).expect(401);
  expect(mockOrder).toEqual([]);
});

it('does not consume write rate limits when the owner polls review status', async () => {
  await request(app)
    .get('/agents/responses/response/review')
    .set('x-test-owner', 'yes')
    .expect(200);
  expect(mockOrder).toEqual(['auth', 'terms']);
});

it('applies owner authentication, terms, current policy and write limits before cancellation', async () => {
  await request(app)
    .post('/agents/responses/response/cancel')
    .set('x-test-owner', 'yes')
    .send({})
    .expect(200, { status: 'cancelled' });
  expect(mockOrder).toEqual(['auth', 'terms', 'config', 'ip', 'user', 'cancel']);
});

it.each(['ip', 'user'])('does not cancel when the %s write limit denies it', async (limit) => {
  mockLimit = limit;
  await request(app)
    .post('/agents/responses/response/cancel')
    .set('x-test-owner', 'yes')
    .send({})
    .expect(429);
  expect(mockOrder).not.toContain('cancel');
});

it('does not reach cancellation or policy without owner authentication', async () => {
  await request(app).post('/agents/responses/response/cancel').send({}).expect(401);
  expect(mockOrder).toEqual([]);
});
