const express = require('express');
const request = require('supertest');

const callOrder = [];
const mockGetBackchannelLogoutConfig = jest.fn();
const mockGetProviderSessionClient = jest.fn();
const mockRevokeProviderSession = jest.fn();
const mockBackchannelLogoutLimiter = jest.fn((_req, res, next) => {
  callOrder.push('limiter');
  next();
});
const mockLoginLimiter = jest.fn((_req, _res, next) => next());

jest.mock('~/server/services/ProviderSession', () => ({
  getBackchannelLogoutConfig: (...args) => {
    callOrder.push('config-check');
    return mockGetBackchannelLogoutConfig(...args);
  },
  getProviderSessionClient: (...args) => mockGetProviderSessionClient(...args),
  revokeProviderSession: (...args) => mockRevokeProviderSession(...args),
}));

jest.mock('~/server/middleware', () => {
  const actual = jest.requireActual('~/server/middleware');
  return {
    ...actual,
    loginLimiter: (...args) => mockLoginLimiter(...args),
    logHeaders: (_req, _res, next) => next(),
    markOAuthNavigation: (_req, _res, next) => next(),
    backchannelLogoutLimiter: (...args) => mockBackchannelLogoutLimiter(...args),
  };
});

const ENABLED_CONFIG = {
  mode: 'enforce',
  algorithms: ['RS256'],
  clockToleranceSec: 60,
  maxTokenAgeSec: 120,
  maxBodyBytes: 16384,
  rateLimit: { windowMs: 60_000, max: 60 },
  processingTimeoutMs: 5000,
  callbackGraceMs: 600_000,
};
const ENABLED_CLIENT = { issuer: 'https://idp.example.com', clientId: 'librechat' };

describe('POST /oauth/openid/backchannel-logout', () => {
  let app;

  beforeAll(() => {
    process.env.DOMAIN_CLIENT = 'http://localhost:3080';
    process.env.DOMAIN_SERVER = 'http://localhost:3080';
    process.env.TENANT_ISOLATION_STRICT = 'true';

    const { preAuthTenantMiddleware } = require('@librechat/api');
    const oauthRouter = require('../oauth');

    app = express();
    app.use('/oauth', preAuthTenantMiddleware, oauthRouter);
  });

  beforeEach(() => {
    callOrder.length = 0;
    mockGetBackchannelLogoutConfig.mockReset();
    mockGetProviderSessionClient.mockReset();
    mockRevokeProviderSession.mockReset();
    mockBackchannelLogoutLimiter.mockClear();
    mockBackchannelLogoutLimiter.mockImplementation((_req, res, next) => {
      callOrder.push('limiter');
      next();
    });
    mockLoginLimiter.mockReset();
    mockLoginLimiter.mockImplementation((_req, _res, next) => next());
  });

  it('returns 503 without reaching the limiter when the config load fails', async () => {
    mockGetBackchannelLogoutConfig.mockRejectedValue(new Error('config load failed'));

    const response = await request(app)
      .post('/oauth/openid/backchannel-logout')
      .type('form')
      .send('logout_token=anything');

    expect(response.status).toBe(503);
    expect(response.body).toEqual({ code: 'AUTH_SESSION_CHECK_UNAVAILABLE' });
    expect(mockBackchannelLogoutLimiter).not.toHaveBeenCalled();
  });

  it('returns 404, same as an unmatched route, when mode is off', async () => {
    mockGetBackchannelLogoutConfig.mockResolvedValue({ ...ENABLED_CONFIG, mode: 'off' });
    mockGetProviderSessionClient.mockReturnValue(ENABLED_CLIENT);

    const response = await request(app)
      .post('/oauth/openid/backchannel-logout')
      .type('form')
      .send('logout_token=anything');

    expect(response.status).toBe(404);
    expect(mockBackchannelLogoutLimiter).not.toHaveBeenCalled();
  });

  it('returns 404 when OpenID is not configured, even in record/enforce mode', async () => {
    mockGetBackchannelLogoutConfig.mockResolvedValue(ENABLED_CONFIG);
    mockGetProviderSessionClient.mockReturnValue(null);

    const response = await request(app)
      .post('/oauth/openid/backchannel-logout')
      .type('form')
      .send('logout_token=anything');

    expect(response.status).toBe(404);
    expect(mockBackchannelLogoutLimiter).not.toHaveBeenCalled();
  });

  it('rejects a body over the configured limit with 413, before the handler runs', async () => {
    mockGetBackchannelLogoutConfig.mockResolvedValue({ ...ENABLED_CONFIG, maxBodyBytes: 32 });
    mockGetProviderSessionClient.mockReturnValue(ENABLED_CLIENT);

    const response = await request(app)
      .post('/oauth/openid/backchannel-logout')
      .type('form')
      .send(`logout_token=${'a'.repeat(200)}`);

    expect(response.status).toBe(413);
    expect(mockRevokeProviderSession).not.toHaveBeenCalled();
  });

  it('denies through the dedicated rate limiter, ordered after the enabled check', async () => {
    mockGetBackchannelLogoutConfig.mockResolvedValue(ENABLED_CONFIG);
    mockGetProviderSessionClient.mockReturnValue(ENABLED_CLIENT);
    mockBackchannelLogoutLimiter.mockImplementation((_req, res) => {
      callOrder.push('limiter');
      res.status(429).json({ error: 'rate_limited' });
    });

    const response = await request(app)
      .post('/oauth/openid/backchannel-logout')
      .type('form')
      .send('logout_token=anything');

    expect(response.status).toBe(429);
    expect(callOrder).toEqual(['config-check', 'limiter']);
    expect(mockRevokeProviderSession).not.toHaveBeenCalled();
  });

  it('runs the limiter, body parsing, and handler in order once enabled', async () => {
    mockGetBackchannelLogoutConfig.mockResolvedValue(ENABLED_CONFIG);
    mockGetProviderSessionClient.mockReturnValue(ENABLED_CLIENT);

    const response = await request(app)
      .post('/oauth/openid/backchannel-logout')
      .type('form')
      .send({});

    expect(callOrder).toEqual(['config-check', 'limiter']);
    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: 'invalid_request' });
    expect(response.headers['cache-control']).toBe('no-store');
  });

  it('does not require a tenant, unlike the login and callback routes on the same router', async () => {
    mockGetBackchannelLogoutConfig.mockResolvedValue(ENABLED_CONFIG);
    mockGetProviderSessionClient.mockReturnValue(ENABLED_CLIENT);

    const response = await request(app)
      .post('/oauth/openid/backchannel-logout')
      .type('form')
      .send({});

    expect(response.status).not.toBe(403);
    expect(response.body).toEqual({ error: 'invalid_request' });
  });

  it('reaches the handler with loginLimiter exhausted, since it is registered before loginLimiter', async () => {
    mockLoginLimiter.mockImplementation((_req, res) => {
      res.status(429).json({ error: 'rate_limited_login' });
    });
    mockGetBackchannelLogoutConfig.mockResolvedValue(ENABLED_CONFIG);
    mockGetProviderSessionClient.mockReturnValue(ENABLED_CLIENT);

    const response = await request(app)
      .post('/oauth/openid/backchannel-logout')
      .type('form')
      .send({});

    expect(mockLoginLimiter).not.toHaveBeenCalled();
    expect(callOrder).toEqual(['config-check', 'limiter']);
    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: 'invalid_request' });
  });

  it('still applies loginLimiter to other /oauth routes', async () => {
    mockLoginLimiter.mockImplementation((_req, res) => {
      res.status(429).json({ error: 'rate_limited_login' });
    });

    const response = await request(app).get('/oauth/openid');

    expect(mockLoginLimiter).toHaveBeenCalled();
    expect(response.status).toBe(429);
    expect(response.body).toEqual({ error: 'rate_limited_login' });
  });
});
