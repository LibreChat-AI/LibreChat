const express = require('express');
const request = require('supertest');

const mockOrder = [];
jest.mock('~/server/controllers/agents/responses', () => ({
  createResponse: (req, res) => {
    mockOrder.push('create');
    if (req.body.stream) {
      return res.type('text/event-stream').send('event: response.completed\ndata: {}\n\n');
    }
    res.json({ status: 'completed' });
  },
  getResponse: (req, res) => res.json({ id: req.params.id }),
  listModels: (_req, res) => res.json({ object: 'list', data: [] }),
}));
jest.mock('~/server/services/Responses', () => ({
  createBackgroundResponseHandlers: ({ create, retrieve }) => ({
    create,
    retrieve,
    cancel: (req, res) => res.json({ id: req.params.id, status: 'cancelled' }),
  }),
  authenticateBackgroundResponses: (ordinaryAuth) => ordinaryAuth,
}));
jest.mock('~/server/middleware', () => ({
  requireTermsAcceptance: (_req, _res, next) => {
    mockOrder.push('terms');
    next();
  },
  configMiddleware: (_req, _res, next) => {
    mockOrder.push('config');
    next();
  },
}));
jest.mock('../middleware', () => ({
  preAuthTenantMiddleware: (_req, _res, next) => {
    mockOrder.push('tenant');
    next();
  },
  requireRemoteAgentAuth: (req, res, next) => {
    mockOrder.push('auth');
    if (req.headers.authorization !== 'Bearer fixture') return res.sendStatus(401);
    next();
  },
  checkRemoteAgentsFeature: (_req, _res, next) => {
    mockOrder.push('feature');
    next();
  },
  checkAgentPermission: (_req, _res, next) => {
    mockOrder.push('agent');
    next();
  },
}));

const app = express();
app.use(express.json());
app.use('/responses', require('../responses'));
beforeEach(() => {
  mockOrder.length = 0;
});

it.each([false, true])('retains ordinary create routing and SSE=%s', async (stream) => {
  const result = await request(app)
    .post('/responses')
    .auth('fixture', { type: 'bearer' })
    .send({ model: 'agent', input: 'hello', stream });
  expect(result.status).toBe(200);
  expect(mockOrder).toEqual(['tenant', 'auth', 'terms', 'config', 'feature', 'agent', 'create']);
  if (stream) expect(result.headers['content-type']).toContain('text/event-stream');
  else expect(result.body.status).toBe('completed');
});

it('keeps model listing ahead of the response ID route', async () => {
  const result = await request(app).get('/responses/models').auth('fixture', { type: 'bearer' });
  expect(result.body).toEqual({ object: 'list', data: [] });
});

it('routes retrieval and cancellation through the background host after authentication', async () => {
  const retrieved = await request(app)
    .get('/responses/resp_exact')
    .auth('fixture', { type: 'bearer' });
  expect(retrieved.body).toEqual({ id: 'resp_exact' });
  const cancelled = await request(app)
    .post('/responses/resp_exact/cancel')
    .auth('fixture', { type: 'bearer' });
  expect(cancelled.body).toEqual({ id: 'resp_exact', status: 'cancelled' });
});

it.each(['get', 'post'])('rejects unauthenticated %s before response dispatch', async (method) => {
  const path = method === 'get' ? '/responses/resp_exact' : '/responses/resp_exact/cancel';
  await request(app)[method](path).expect(401);
  expect(mockOrder).toEqual(['tenant', 'auth']);
});
