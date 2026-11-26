const express = require('express');
const request = require('supertest');

const mockProvider = jest.fn();
const mockCreateProvider = jest.fn(() => mockProvider);
const mockController = jest.fn();
const mockPass = (_req, _res, next) => next();

jest.mock('@librechat/api', () => ({
  ...jest.requireActual('@librechat/api'),
  generateCheckAccess: () => mockPass,
  createMessageFilterPii: () => mockPass,
}));
jest.mock('~/server/middleware', () => ({
  moderateText: mockPass,
  validateConvoAccess: mockPass,
  /** Starts loading the turn's agent, as the real middleware does. */
  buildEndpointOption: (req, _res, next) => {
    req.body.endpointOption = {
      agent: Promise.resolve({ id: 'agent-1', provider: req.body.provider }),
    };
    next();
  },
  canAccessAgentFromBody: () => mockPass,
}));
jest.mock('~/server/middleware/validate/subagentThreadTurn', () => mockPass);
jest.mock('~/server/services/OpenIDSessionRefresh', () => ({
  createOpenIDSessionTokenProvider: (...args) => mockCreateProvider(...args),
}));
jest.mock('~/server/services/Endpoints/agents', () => ({ initializeClient: jest.fn() }));
jest.mock('~/server/services/Endpoints/agents/title', () => jest.fn());
jest.mock('~/models', () => ({ getFiles: jest.fn(), getRoleByName: jest.fn() }));
jest.mock('~/server/controllers/agents/request', () => (req, res) => mockController(req, res));
jest.mock('~/server/controllers/agents/resume', () => (req, res) => mockController(req, res));

const { ErrorController, createSafeUser, resolveHeaders } = require('@librechat/api');
const router = require('../chat');

const now = () => Math.floor(Date.now() / 1000);
const headers = { Authorization: 'Bearer {{LIBRECHAT_OPENID_ACCESS_TOKEN}}' };
const endpoint = (name, endpointHeaders) => ({
  name,
  apiKey: 'key',
  baseURL: `https://${name}.example.com/v1`,
  models: { default: ['model'] },
  headers: endpointHeaders,
});
const config = {
  endpoints: { custom: [endpoint('gateway', headers), endpoint('plain', { 'X-Org': 'org' })] },
};

/** The token the OpenID strategy read from the session when it authenticated the request. */
function fixture(federatedTokens) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.config = config;
    req.authStrategy = 'openidJwt';
    req.user = { id: 'user-1', provider: 'openid', openidId: 'oidc-sub-1', federatedTokens };
    next();
  });
  app.use(router);
  app.use(ErrorController);
  return app;
}

beforeEach(() => {
  jest.clearAllMocks();
  /** Resolves the custom endpoint's headers the way the run does once the turn is accepted. */
  mockController.mockImplementation((req, res) =>
    res.json(resolveHeaders({ headers, user: createSafeUser(req.user), stripUnresolved: true })),
  );
});

it.each(['/', '/resume'])(
  'refreshes an expired OpenID access token before %s resolves the custom endpoint header',
  async (path) => {
    mockProvider.mockResolvedValue({
      access_token: 'fresh-access-token',
      id_token: 'fresh-id-token',
      refresh_token: 'rotated-refresh-token',
      expires_at: now() + 3600,
    });

    await request(fixture({ access_token: 'expired-access-token', expires_at: now() - 60 }))
      .post(path)
      .send({ conversationId: 'conversation-1', provider: 'gateway' })
      .expect(200, { Authorization: 'Bearer fresh-access-token' });

    expect(mockCreateProvider).toHaveBeenCalledWith(
      expect.objectContaining({ tokenPreference: 'access_token' }),
    );
    expect(mockController).toHaveBeenCalledTimes(1);
  },
);

it('answers 401 before the turn starts when the session can no longer refresh', async () => {
  mockProvider.mockRejectedValue(new Error('OpenID session tokens are no longer available'));

  const response = await request(fixture({ refresh_token: 'cookie-refresh-token' }))
    .post('/')
    .send({ conversationId: 'conversation-1', provider: 'gateway' })
    .expect(401);

  expect(response.body).toEqual({
    error: 'invalid_token',
    message: expect.stringContaining('Please sign in again'),
  });
  expect(mockController).not.toHaveBeenCalled();
});

it('accepts a turn on an endpoint that does not forward the token without the session', async () => {
  mockProvider.mockRejectedValue(new Error('OpenID session tokens are no longer available'));
  mockController.mockImplementation((_req, res) => res.json({ accepted: true }));

  await request(fixture({ refresh_token: 'cookie-refresh-token' }))
    .post('/')
    .send({ conversationId: 'conversation-1', provider: 'plain' })
    .expect(200, { accepted: true });

  expect(mockCreateProvider).not.toHaveBeenCalled();
});

it('does not consult the session while the stored access token is current', async () => {
  await request(fixture({ access_token: 'current-access-token', expires_at: now() + 600 }))
    .post('/')
    .send({ conversationId: 'conversation-1', provider: 'gateway' })
    .expect(200, { Authorization: 'Bearer current-access-token' });

  expect(mockProvider).not.toHaveBeenCalled();
});
