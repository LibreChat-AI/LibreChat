const express = require('express');
const request = require('supertest');

jest.mock('passport', () => ({
  authenticate: jest.fn(() => (req, res, next) => next()),
  _strategy: jest.fn(),
}));

jest.mock('openid-client', () => ({
  refreshTokenGrant: jest.fn(),
}));

jest.mock('librechat-data-provider', () => ({
  CacheKeys: { ADMIN_OAUTH_EXCHANGE: 'admin-oauth-exchange' },
}));

jest.mock('@librechat/data-schemas', () => ({
  logger: {
    debug: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
  },
  DEFAULT_SESSION_EXPIRY: 60000,
  SystemCapabilities: { ACCESS_ADMIN: 'ACCESS_ADMIN' },
  getTenantId: jest.fn(() => undefined),
  tenantStorage: { run: jest.fn((ctx, fn) => fn()) },
}));

jest.mock('@librechat/api', () => {
  class AdminRefreshError extends Error {
    constructor(code, status, message) {
      super(message);
      this.name = 'AdminRefreshError';
      this.code = code;
      this.status = status;
    }
  }

  return {
    isEnabled: jest.fn(),
    getAdminPanelUrl: jest.fn(() => 'http://admin.example.com'),
    exchangeAdminCode: jest.fn(),
    createSetBalanceConfig: jest.fn(() => (req, res, next) => next()),
    storeAndStripChallenge: jest.fn(),
    tenantContextMiddleware: jest.fn((req, res, next) => next()),
    preAuthTenantMiddleware: jest.fn((req, res, next) => next()),
    applyAdminRefresh: jest.fn(),
    applyGoogleAdminRefresh: jest.fn(),
    AdminRefreshError,
    buildOpenIDRefreshParams: jest.fn(() => {
      const params = {};
      if (process.env.OPENID_SCOPE) {
        params.scope = process.env.OPENID_SCOPE;
      }
      if (process.env.OPENID_REFRESH_AUDIENCE) {
        params.audience = process.env.OPENID_REFRESH_AUDIENCE;
      }
      return params;
    }),
  };
});

jest.mock('~/server/controllers/auth/LoginController', () => ({
  loginController: jest.fn((req, res) => res.status(200).end()),
}));

jest.mock('~/server/middleware/roles/capabilities', () => ({
  hasCapability: jest.fn(() => Promise.resolve(true)),
  requireCapability: jest.fn(() => (req, res, next) => next()),
}));

jest.mock('~/server/controllers/auth/oauth', () => ({
  createOAuthHandler: jest.fn(() => (req, res) => res.status(200).end()),
}));

jest.mock('~/models', () => ({
  findBalanceByUser: jest.fn(),
  findUsers: jest.fn(),
  generateToken: jest.fn(() => Promise.resolve('minted-token')),
  getUserById: jest.fn(),
  upsertBalanceFields: jest.fn(),
}));

jest.mock('~/server/services/Config', () => ({
  getAppConfig: jest.fn(),
}));

jest.mock('~/cache/getLogStores', () =>
  jest.fn(() => ({
    get: jest.fn(),
    delete: jest.fn(),
  })),
);

jest.mock('~/strategies', () => ({
  getOpenIdConfig: jest.fn(),
}));

jest.mock('~/server/middleware', () => ({
  logHeaders: jest.fn((req, res, next) => next()),
  requireSameOrigin: jest.fn((req, res, next) => next()),
  loginLimiter: jest.fn((req, res, next) => next()),
  checkBan: jest.fn((req, res, next) => next()),
  validateEmailLogin: jest.fn((req, res, next) => next()),
  requireLocalAuth: jest.fn((req, res, next) => next()),
  requireJwtAuth: jest.fn((req, res, next) => next()),
  checkDomainAllowed: jest.fn((req, res, next) => next()),
}));

const passport = require('passport');
const openIdClient = require('openid-client');
const { logger } = require('@librechat/data-schemas');
const {
  isEnabled,
  applyAdminRefresh,
  applyGoogleAdminRefresh,
  storeAndStripChallenge,
  buildOpenIDRefreshParams,
} = require('@librechat/api');
const { getOpenIdConfig } = require('~/strategies');
const middleware = require('~/server/middleware');
const adminAuthRouter = require('./auth');

const ORIGINAL_OPENID_SCOPE = process.env.OPENID_SCOPE;
const ORIGINAL_OPENID_REFRESH_AUDIENCE = process.env.OPENID_REFRESH_AUDIENCE;
const ORIGINAL_SESSION_EXPIRY = process.env.SESSION_EXPIRY;

describe('admin auth OpenID refresh route', () => {
  const openIdConfig = {
    serverMetadata: jest.fn(() => ({ issuer: 'https://issuer.example.com' })),
  };
  const tokenset = {
    access_token: 'new-admin-access',
    id_token: 'new-admin-id',
    refresh_token: 'new-admin-refresh',
    expires_in: 3600,
    claims: jest.fn(() => ({ sub: 'admin-openid-id' })),
  };

  let app;

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.OPENID_SCOPE;
    delete process.env.OPENID_REFRESH_AUDIENCE;
    delete process.env.SESSION_EXPIRY;

    app = express();
    app.use(express.json());
    app.use('/api/admin', adminAuthRouter);

    isEnabled.mockReturnValue(true);
    getOpenIdConfig.mockReturnValue(openIdConfig);
    openIdClient.refreshTokenGrant.mockResolvedValue(tokenset);
    applyAdminRefresh.mockResolvedValue({
      token: 'admin-jwt',
      refreshToken: 'new-admin-refresh',
      user: { id: 'user-id', email: 'admin@example.com' },
      expiresAt: 1234567890,
    });
  });

  afterAll(() => {
    if (ORIGINAL_OPENID_SCOPE === undefined) {
      delete process.env.OPENID_SCOPE;
    } else {
      process.env.OPENID_SCOPE = ORIGINAL_OPENID_SCOPE;
    }

    if (ORIGINAL_OPENID_REFRESH_AUDIENCE === undefined) {
      delete process.env.OPENID_REFRESH_AUDIENCE;
    } else {
      process.env.OPENID_REFRESH_AUDIENCE = ORIGINAL_OPENID_REFRESH_AUDIENCE;
    }

    if (ORIGINAL_SESSION_EXPIRY === undefined) {
      delete process.env.SESSION_EXPIRY;
    } else {
      process.env.SESSION_EXPIRY = ORIGINAL_SESSION_EXPIRY;
    }
  });

  it.each([
    ['scope-only', { OPENID_SCOPE: 'openid profile email' }, { scope: 'openid profile email' }],
    [
      'scope and audience',
      {
        OPENID_SCOPE: 'openid profile email',
        OPENID_REFRESH_AUDIENCE: 'https://api.example.com',
      },
      { scope: 'openid profile email', audience: 'https://api.example.com' },
    ],
    [
      'audience-only',
      { OPENID_REFRESH_AUDIENCE: 'https://api.example.com' },
      { audience: 'https://api.example.com' },
    ],
    ['empty audience', { OPENID_REFRESH_AUDIENCE: '' }, {}],
  ])('passes %s params to the OpenID refresh grant', async (_label, env, expectedParams) => {
    Object.assign(process.env, env);

    const response = await request(app)
      .post('/api/admin/oauth/refresh')
      .send({ refresh_token: 'incoming-refresh-token' });

    expect(response.status).toBe(200);
    expect(buildOpenIDRefreshParams).toHaveBeenCalledTimes(1);
    expect(openIdClient.refreshTokenGrant).toHaveBeenCalledWith(
      openIdConfig,
      'incoming-refresh-token',
      expectedParams,
    );
    expect(applyAdminRefresh).toHaveBeenCalledWith(
      tokenset,
      expect.any(Object),
      expect.objectContaining({ previousRefreshToken: 'incoming-refresh-token' }),
    );
  });

  it('returns the existing refresh failure response when the IdP rejects the grant', async () => {
    openIdClient.refreshTokenGrant.mockRejectedValue({
      code: 'invalid_grant',
      name: 'OAuthError',
    });

    const response = await request(app)
      .post('/api/admin/oauth/refresh')
      .send({ refresh_token: 'incoming-refresh-token' });

    expect(response.status).toBe(401);
    expect(response.body).toEqual({
      error: 'Refresh failed',
      error_code: 'REFRESH_FAILED',
    });
    expect(applyAdminRefresh).not.toHaveBeenCalled();
  });

  it('keeps admin refresh diagnostics free of token and audience values', async () => {
    process.env.OPENID_SCOPE = 'openid profile email';
    process.env.OPENID_REFRESH_AUDIENCE = 'https://api.example.com';

    await request(app)
      .post('/api/admin/oauth/refresh')
      .send({ refresh_token: 'incoming-refresh-token' });

    expect(logger.debug).toHaveBeenCalledWith('[admin/oauth/refresh] OpenID refresh params', {
      has_scope: true,
      has_refresh_audience: true,
    });
    expect(logger.debug).toHaveBeenCalledWith('[admin/oauth/refresh] OpenID refresh succeeded', {
      has_access_token: true,
      has_id_token: true,
      has_refresh_token: true,
      expires_in: 3600,
    });
    const debugOutput = JSON.stringify(logger.debug.mock.calls);
    expect(debugOutput).not.toContain('incoming-refresh-token');
    expect(debugOutput).not.toContain('new-admin-access');
    expect(debugOutput).not.toContain('new-admin-id');
    expect(debugOutput).not.toContain('new-admin-refresh');
    expect(debugOutput).not.toContain('https://api.example.com');
  });
});

describe('admin auth Google refresh route', () => {
  let app;

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.SESSION_EXPIRY;

    app = express();
    app.use(express.json());
    app.use('/api/admin', adminAuthRouter);

    process.env.GOOGLE_CLIENT_ID = 'google-client-id';
    process.env.GOOGLE_CLIENT_SECRET = 'google-client-secret';

    applyGoogleAdminRefresh.mockResolvedValue({
      token: 'admin-jwt',
      refreshToken: 'rotated-refresh',
      user: {
        _id: 'user-id',
        id: 'user-id',
        email: 'admin@example.com',
        name: 'Admin',
        username: 'admin',
        role: 'ADMIN',
        provider: 'google',
      },
      expiresAt: 1234567890,
    });
  });

  it('delegates to applyGoogleAdminRefresh with route-supplied deps and options', async () => {
    const response = await request(app).post('/api/admin/oauth/refresh').send({
      refresh_token: 'incoming-google-refresh',
      user_id: '6a343eb8b5025a84b6ca2767',
      provider: 'google',
    });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      token: 'admin-jwt',
      refreshToken: 'rotated-refresh',
      user: expect.objectContaining({
        _id: 'user-id',
        id: 'user-id',
        email: 'admin@example.com',
        name: 'Admin',
        username: 'admin',
        role: 'ADMIN',
        provider: 'google',
      }),
      expiresAt: 1234567890,
    });
    expect(applyGoogleAdminRefresh).toHaveBeenCalledWith(
      expect.objectContaining({
        findUsers: expect.any(Function),
        getUserById: expect.any(Function),
        canAccessAdmin: expect.any(Function),
        mintToken: expect.any(Function),
      }),
      {
        refreshToken: 'incoming-google-refresh',
        userId: '6a343eb8b5025a84b6ca2767',
        tenantId: undefined,
        clientId: 'google-client-id',
        clientSecret: 'google-client-secret',
      },
    );
  });

  it('forwards the tenant id from getTenantId() to the helper', async () => {
    const { getTenantId } = require('@librechat/data-schemas');
    getTenantId.mockReturnValueOnce('tenant-x');

    const response = await request(app)
      .post('/api/admin/oauth/refresh')
      .send({ refresh_token: 'incoming-google-refresh', provider: 'google' });

    expect(response.status).toBe(200);
    expect(applyGoogleAdminRefresh).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ tenantId: 'tenant-x' }),
    );
  });

  it('canAccessAdmin closure calls hasCapability with the normalized user id', async () => {
    const { hasCapability } = require('~/server/middleware/roles/capabilities');
    let capturedDeps;
    applyGoogleAdminRefresh.mockImplementationOnce(async (deps) => {
      capturedDeps = deps;
      return {
        token: 'jwt',
        refreshToken: 'r',
        user: { id: 'u', _id: 'u', email: 'e@e.com', name: '', username: '', role: 'ADMIN' },
        expiresAt: 0,
      };
    });

    await request(app)
      .post('/api/admin/oauth/refresh')
      .send({ refresh_token: 'google-refresh', provider: 'google' });

    await capturedDeps.canAccessAdmin({ id: 'user-1', role: 'ADMIN', tenantId: 'tenant-a' });
    expect(hasCapability).toHaveBeenCalledWith(
      { id: 'user-1', role: 'ADMIN', tenantId: 'tenant-a' },
      'ACCESS_ADMIN',
    );
  });

  it('does not require OPENID_REUSE_TOKENS for the google provider', async () => {
    isEnabled.mockReturnValue(false);

    const response = await request(app)
      .post('/api/admin/oauth/refresh')
      .send({ refresh_token: 'incoming-google-refresh', provider: 'google' });

    expect(response.status).toBe(200);
  });

  it('maps AdminRefreshError thrown by the helper to the documented status and code', async () => {
    const { AdminRefreshError } = require('@librechat/api');
    applyGoogleAdminRefresh.mockRejectedValueOnce(
      new AdminRefreshError('GOOGLE_NOT_CONFIGURED', 503, 'Google admin OAuth is not configured'),
    );

    const response = await request(app)
      .post('/api/admin/oauth/refresh')
      .send({ refresh_token: 'incoming-google-refresh', provider: 'google' });

    expect(response.status).toBe(503);
    expect(response.body).toEqual({
      error: 'Google admin OAuth is not configured',
      error_code: 'GOOGLE_NOT_CONFIGURED',
    });
  });

  it('returns 500 INTERNAL_ERROR when the helper throws a non-AdminRefreshError', async () => {
    applyGoogleAdminRefresh.mockRejectedValueOnce(new Error('boom'));

    const response = await request(app)
      .post('/api/admin/oauth/refresh')
      .send({ refresh_token: 'incoming-google-refresh', provider: 'google' });

    expect(response.status).toBe(500);
    expect(response.body.error_code).toBe('INTERNAL_ERROR');
  });

  it('rejects unknown provider values with INVALID_PROVIDER before calling either helper', async () => {
    const response = await request(app)
      .post('/api/admin/oauth/refresh')
      .send({ refresh_token: 'incoming-refresh', provider: 'github' });

    expect(response.status).toBe(400);
    expect(response.body.error_code).toBe('INVALID_PROVIDER');
    expect(applyGoogleAdminRefresh).not.toHaveBeenCalled();
    expect(applyAdminRefresh).not.toHaveBeenCalled();
  });

  it('re-runs checkBan with the resolved user identity and blocks a banned user', async () => {
    const middleware = require('~/server/middleware');
    let banCheckCalls = 0;
    middleware.checkBan.mockImplementation((req, res, next) => {
      banCheckCalls++;
      if (banCheckCalls >= 2 && req.user) {
        req.banned = true;
        return res.status(403).json({ message: 'banned' });
      }
      return next();
    });

    const response = await request(app)
      .post('/api/admin/oauth/refresh')
      .send({ refresh_token: 'incoming-google-refresh', provider: 'google' });

    expect(response.status).toBe(403);
    expect(middleware.checkBan).toHaveBeenCalledTimes(2);
    expect(middleware.checkBan.mock.calls[1][0].user).toEqual({ id: 'user-id' });
  });
});

describe('admin auth OpenID route availability', () => {
  let app;

  beforeEach(() => {
    jest.clearAllMocks();
    middleware.checkBan.mockImplementation((req, res, next) => next());

    app = express();
    app.use(express.json());
    app.use('/api/admin', adminAuthRouter);
  });

  it('returns not configured for the OpenID availability check when config lookup throws', async () => {
    getOpenIdConfig.mockImplementation(() => {
      throw new Error('OpenID client is not initialized. Please call setupOpenId first.');
    });

    const response = await request(app).get('/api/admin/oauth/openid/check');

    expect(response.status).toBe(404);
    expect(response.body).toEqual({
      error: 'OpenID configuration not found',
      error_code: 'OPENID_NOT_CONFIGURED',
    });
  });

  it('does not start OpenID admin login when config lookup throws', async () => {
    getOpenIdConfig.mockImplementation(() => {
      throw new Error('OpenID client is not initialized. Please call setupOpenId first.');
    });

    const response = await request(app).get('/api/admin/oauth/openid');

    expect(response.status).toBe(404);
    expect(response.body).toEqual({
      error: 'OpenID configuration not found',
      error_code: 'OPENID_NOT_CONFIGURED',
    });
    expect(storeAndStripChallenge).not.toHaveBeenCalled();
    expect(passport.authenticate).not.toHaveBeenCalled();
  });

  it('does not run OpenID admin callback auth when config lookup throws', async () => {
    getOpenIdConfig.mockImplementation(() => {
      throw new Error('OpenID client is not initialized. Please call setupOpenId first.');
    });

    const response = await request(app).get('/api/admin/oauth/openid/callback?state=state');

    expect(response.status).toBe(404);
    expect(response.body).toEqual({
      error: 'OpenID configuration not found',
      error_code: 'OPENID_NOT_CONFIGURED',
    });
  });
});

describe('admin auth social route availability', () => {
  let app;

  beforeEach(() => {
    jest.clearAllMocks();
    passport._strategy.mockReturnValue(undefined);

    app = express();
    app.use(express.json());
    app.use('/api/admin', adminAuthRouter);
  });

  const startRoutes = [
    ['saml', 'SAML'],
    ['google', 'Google'],
    ['github', 'GitHub'],
    ['discord', 'Discord'],
    ['facebook', 'Facebook'],
    ['apple', 'Apple'],
  ];

  it.each(startRoutes)(
    'does not start %s admin login when the strategy is not registered',
    async (path, provider) => {
      const response = await request(app).get(`/api/admin/oauth/${path}`);

      expect(response.status).toBe(404);
      expect(response.body).toEqual({
        error: `${provider} configuration not found`,
        error_code: `${provider.toUpperCase()}_NOT_CONFIGURED`,
      });
      expect(storeAndStripChallenge).not.toHaveBeenCalled();
      expect(passport.authenticate).not.toHaveBeenCalled();
    },
  );

  const callbackRoutes = [
    [
      'saml',
      'SAML',
      (agent) => agent.post('/api/admin/oauth/saml/callback').send({ RelayState: 'state' }),
    ],
    ['google', 'Google', (agent) => agent.get('/api/admin/oauth/google/callback?state=state')],
    ['github', 'GitHub', (agent) => agent.get('/api/admin/oauth/github/callback?state=state')],
    ['discord', 'Discord', (agent) => agent.get('/api/admin/oauth/discord/callback?state=state')],
    [
      'facebook',
      'Facebook',
      (agent) => agent.get('/api/admin/oauth/facebook/callback?state=state'),
    ],
    [
      'apple',
      'Apple',
      (agent) => agent.post('/api/admin/oauth/apple/callback').send({ state: 'state' }),
    ],
  ];

  it.each(callbackRoutes)(
    'does not run %s admin callback auth when the strategy is not registered',
    async (path, provider, makeRequest) => {
      const response = await makeRequest(request(app));

      expect(response.status).toBe(404);
      expect(response.body).toEqual({
        error: `${provider} configuration not found`,
        error_code: `${provider.toUpperCase()}_NOT_CONFIGURED`,
      });
    },
  );

  it('starts admin login when the strategy is registered', async () => {
    passport._strategy.mockReturnValue({ name: 'googleAdmin' });
    storeAndStripChallenge.mockResolvedValue(true);

    await request(app).get('/api/admin/oauth/google');

    expect(storeAndStripChallenge).toHaveBeenCalledTimes(1);
    expect(passport.authenticate).toHaveBeenCalledWith(
      'googleAdmin',
      expect.objectContaining({ session: false }),
    );
  });
});

describe('admin local login route', () => {
  let app;

  beforeEach(() => {
    jest.clearAllMocks();

    app = express();
    app.use(express.json());
    app.use('/api/admin', adminAuthRouter);
  });

  it('applies the email login gate before local auth', async () => {
    const response = await request(app).post('/api/admin/login/local').send({
      email: 'admin@example.com',
      password: 'password',
    });

    expect(response.status).toBe(200);
    expect(middleware.validateEmailLogin).toHaveBeenCalledTimes(1);
    expect(middleware.requireLocalAuth).toHaveBeenCalledTimes(1);
    expect(middleware.validateEmailLogin.mock.invocationCallOrder[0]).toBeLessThan(
      middleware.requireLocalAuth.mock.invocationCallOrder[0],
    );
  });

  it('rejects cross-site submissions before rate limiting or local auth', async () => {
    const response = await request(app).post('/api/admin/login/local').send({
      email: 'admin@example.com',
      password: 'password',
    });

    expect(response.status).toBe(200);
    expect(middleware.requireSameOrigin).toHaveBeenCalledTimes(1);
    expect(middleware.requireSameOrigin.mock.invocationCallOrder[0]).toBeLessThan(
      middleware.loginLimiter.mock.invocationCallOrder[0],
    );

    jest.clearAllMocks();
    middleware.requireSameOrigin.mockImplementationOnce((req, res) =>
      res.status(403).json({ message: 'Cross-site request rejected' }),
    );

    const rejected = await request(app).post('/api/admin/login/local').send({
      email: 'admin@example.com',
      password: 'password',
    });

    expect(rejected.status).toBe(403);
    expect(middleware.loginLimiter).not.toHaveBeenCalled();
    expect(middleware.requireLocalAuth).not.toHaveBeenCalled();
  });

  it('stops before local auth when the email login gate rejects the request', async () => {
    middleware.validateEmailLogin.mockImplementationOnce((req, res) =>
      res.status(403).json({ message: 'Email login is not allowed.' }),
    );

    const response = await request(app).post('/api/admin/login/local').send({
      email: 'admin@example.com',
      password: 'password',
    });

    expect(response.status).toBe(403);
    expect(response.body).toEqual({ message: 'Email login is not allowed.' });
    expect(middleware.requireLocalAuth).not.toHaveBeenCalled();
  });
});
