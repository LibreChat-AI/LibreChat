const express = require('express');
const request = require('supertest');

const originalDomainClient = process.env.DOMAIN_CLIENT;
process.env.DOMAIN_CLIENT = 'http://client.test';

const mockLogger = {
  warn: jest.fn(),
  error: jest.fn(),
  info: jest.fn(),
  debug: jest.fn(),
};

const mockOAuthHandler = jest.fn((_req, res) => res.status(204).end());
const mockOpenIDCallbackMiddleware = jest.fn((_req, _res, next) => next());
let mockOpenIDCallbackAuthenticatorOptions;
const mockCreateOpenIDCallbackAuthenticator = jest.fn((options) => {
  mockOpenIDCallbackAuthenticatorOptions = options;
  return mockOpenIDCallbackMiddleware;
});
const mockOAuthErrorHandler = jest.fn((_req, res) => res.status(204).end());
let mockOAuthErrorHandlerOptions;
const mockCreateOAuthErrorHandler = jest.fn((options) => {
  mockOAuthErrorHandlerOptions = options;
  return mockOAuthErrorHandler;
});
const mockPassportAuthenticate = jest.fn(() => (_req, _res, next) => next());

jest.mock('passport', () => ({
  authenticate: (...args) => mockPassportAuthenticate(...args),
}));

jest.mock('openid-client', () => ({
  randomState: jest.fn(() => 'random-state'),
}));

jest.mock('@librechat/data-schemas', () => ({
  ...jest.requireActual('@librechat/data-schemas'),
  logger: mockLogger,
}));

jest.mock('librechat-data-provider', () => ({
  ...jest.requireActual('librechat-data-provider'),
  ErrorTypes: {
    AUTH_FAILED: 'auth_failed',
  },
}));

jest.mock('@librechat/api', () => ({
  ...jest.requireActual('@librechat/api'),
  createOAuthErrorHandler: (...args) => mockCreateOAuthErrorHandler(...args),
  createOpenIDCallbackAuthenticator: (...args) => mockCreateOpenIDCallbackAuthenticator(...args),
  createSetBalanceConfig: jest.fn(() => (_req, _res, next) => next()),
}));

const mockMarkOAuthNavigation = jest.fn((req, _res, next) => {
  req.isOAuthNavigation = true;
  next();
});

jest.mock('~/server/middleware', () => ({
  checkDomainAllowed: jest.fn((_req, _res, next) => next()),
  loginLimiter: jest.fn((_req, _res, next) => next()),
  logHeaders: jest.fn((_req, _res, next) => next()),
  markOAuthNavigation: (...args) => mockMarkOAuthNavigation(...args),
}));

jest.mock('~/server/controllers/auth/oauth', () => ({
  createOAuthHandler: jest.fn(() => mockOAuthHandler),
}));

jest.mock('~/models', () => ({
  findBalanceByUser: jest.fn(),
  upsertBalanceFields: jest.fn(),
}));

jest.mock('~/server/services/Config', () => ({
  getAppConfig: jest.fn(),
}));

afterAll(() => {
  if (originalDomainClient === undefined) {
    delete process.env.DOMAIN_CLIENT;
    return;
  }
  process.env.DOMAIN_CLIENT = originalDomainClient;
});

function getOAuthRouter() {
  jest.resetModules();
  return require('./oauth');
}

function createApp(sessionMessages) {
  const app = express();
  app.use((req, _res, next) => {
    if (sessionMessages) {
      req.session = { messages: [...sessionMessages] };
    }
    next();
  });
  app.use('/oauth', getOAuthRouter());
  app.use((err, _req, res, _next) => {
    res.status(500).json({ message: err.message });
  });
  return app;
}

describe('OAuth route failure logging', () => {
  beforeEach(() => {
    mockLogger.warn.mockClear();
    mockLogger.error.mockClear();
    mockLogger.info.mockClear();
    mockLogger.debug.mockClear();
    mockOAuthHandler.mockClear();
    mockOpenIDCallbackMiddleware.mockClear();
    mockOAuthErrorHandler.mockClear();
    mockPassportAuthenticate.mockClear();
    mockMarkOAuthNavigation.mockClear();
    mockOpenIDCallbackAuthenticatorOptions = undefined;
    mockOAuthErrorHandlerOptions = undefined;
    mockPassportAuthenticate.mockImplementation(() => (_req, _res, next) => next());
    mockOpenIDCallbackMiddleware.mockImplementation((_req, _res, next) => next());
  });

  it('marks OAuth requests as browser navigations so rejections can redirect', async () => {
    const app = createApp();

    await request(app).get('/oauth/openid/callback?code=secret-code').expect(204);

    expect(mockMarkOAuthNavigation).toHaveBeenCalled();
    expect(mockOAuthHandler.mock.calls[0][0].isOAuthNavigation).toBe(true);
  });

  it('wires the package OpenID callback middleware into the route', async () => {
    const app = createApp();

    await request(app)
      .get('/oauth/openid/callback?code=secret-code&state=secret-state')
      .expect(204);

    expect(mockOpenIDCallbackAuthenticatorOptions).toEqual({
      passport: expect.objectContaining({ authenticate: expect.any(Function) }),
      logger: mockLogger,
      clientDomain: 'http://client.test',
      authFailedError: 'auth_failed',
    });
    expect(mockOpenIDCallbackMiddleware).toHaveBeenCalledWith(
      expect.any(Object),
      expect.any(Object),
      expect.any(Function),
    );
    expect(mockOAuthHandler).toHaveBeenCalled();
  });

  it('wires the package error handler into the /oauth/error route', async () => {
    const app = createApp();

    await request(app).get('/oauth/error?error=access_denied').expect(204);

    expect(mockOAuthErrorHandlerOptions).toEqual({
      logger: mockLogger,
      clientDomain: 'http://client.test',
      authFailedError: 'auth_failed',
    });
    expect(mockOAuthErrorHandler).toHaveBeenCalledTimes(1);
  });
});
