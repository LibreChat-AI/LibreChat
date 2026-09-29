/**
 * Integration test: verifies that requireJwtAuth chains tenantContextMiddleware
 * after successful passport authentication, so ALS tenant context is set for
 * all downstream middleware and route handlers.
 *
 * requireJwtAuth must chain tenantContextMiddleware after passport populates
 * req.user (not at global app.use() scope where req.user is undefined).
 * If the chaining is removed, these tests fail.
 */

const jwt = require('jsonwebtoken');

// ── Mocks ──────────────────────────────────────────────────────────────

let mockPassportError = null;
let mockRegisteredStrategies = new Set(['jwt']);
/** The post-mint retirement read; defaults to an account no recovery has touched. */
let mockGetUserById = jest.fn(async () => ({}));

jest.mock('~/models', () => ({
  getUserById: (...args) => mockGetUserById(...args),
}));

jest.mock('passport', () => ({
  _strategy: jest.fn((strategy) => (mockRegisteredStrategies.has(strategy) ? {} : undefined)),
  authenticate: jest.fn((strategy, _options, callback) => {
    return (req, _res, _done) => {
      if (mockPassportError) {
        return callback(mockPassportError);
      }
      const strategyResult = req._mockStrategies?.[strategy];
      if (strategyResult) {
        return callback(
          strategyResult.err ?? null,
          strategyResult.user ?? false,
          strategyResult.info,
          strategyResult.status,
        );
      }
      return callback(null, req._mockUser ?? false, { message: 'Unauthorized' }, 401);
    };
  }),
}));

jest.mock('@librechat/data-schemas', () => {
  const { AsyncLocalStorage } = require('async_hooks');
  const tenantStorage = new AsyncLocalStorage();
  return {
    getTenantId: () => tenantStorage.getStore()?.tenantId,
    getUserId: () => tenantStorage.getStore()?.userId,
    getRequestId: () => tenantStorage.getStore()?.requestId,
    logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
    runAsSystem: (fn) => tenantStorage.run({ tenantId: '__SYSTEM__' }, fn),
    tenantStorage,
  };
});

// Mock @librechat/api — the real tenantContextMiddleware is TS and cannot be
// required directly from CJS tests. This thin wrapper mirrors the real logic
// (read request context, call tenantStorage.run) using the same data-schemas
// primitives. The real implementation is covered by packages/api tenant.spec.ts.
jest.mock('@librechat/api', () => {
  const { tenantStorage } = require('@librechat/data-schemas');
  const actualApi = jest.requireActual('@librechat/api');
  const normalizeContextValue = (value) => {
    const trimmed = value?.trim?.();
    return trimmed || undefined;
  };
  const getUserId = (user) =>
    normalizeContextValue(user?.id?.toString?.()) ?? normalizeContextValue(user?._id?.toString?.());
  const getRequestId = (req) =>
    normalizeContextValue(req.requestId) ??
    normalizeContextValue(req.id) ??
    normalizeContextValue(req.headers?.['x-request-id']) ??
    normalizeContextValue(req.headers?.['x-correlation-id']);
  return {
    isEnabled: jest.fn(() => false),
    createRequiredTwoFactorGate: actualApi.createRequiredTwoFactorGate,
    clearCloudFrontCookies: jest.fn(),
    generateTwoFactorSetupToken: jest.fn(() => 'setup-token'),
    isTwoFactorEnrollmentRequired: jest.fn(() => false),
    /** Real dating logic: the ordering these tests exercise is the whole point. */
    isTokenRetired: actualApi.isTokenRetired,
    TOKEN_RETIREMENT_FIELDS: actualApi.TOKEN_RETIREMENT_FIELDS,
    recordRumProxyRequest: jest.fn(),
    getAuthFailureReasonCategory: actualApi.getAuthFailureReasonCategory,
    buildSafeAuthLogContext: actualApi.buildSafeAuthLogContext,
    getValidOpenIdReuseUserId: (token) => {
      if (!token || !process.env.JWT_REFRESH_SECRET) {
        return null;
      }
      try {
        const payload = require('jsonwebtoken').verify(token, process.env.JWT_REFRESH_SECRET);
        return typeof payload === 'object' && payload != null && typeof payload.id === 'string'
          ? payload.id
          : null;
      } catch {
        return null;
      }
    },
    maybeRefreshCloudFrontAuthCookiesMiddleware: jest.fn((req, res, next) => next()),
    tenantContextMiddleware: (req, res, next) => {
      const context = {
        tenantId: normalizeContextValue(req.user?.tenantId),
        userId: getUserId(req.user),
        requestId: getRequestId(req),
      };
      if (!context.tenantId && !context.userId && !context.requestId) {
        return next();
      }
      return tenantStorage.run(context, async () => next());
    },
  };
});

// ── Helpers ─────────────────────────────────────────────────────────────

const requireJwtAuth = require('../requireJwtAuth');
const { requireRumProxyAuth } = requireJwtAuth;
const { getTenantId, getUserId, logger } = require('@librechat/data-schemas');
const {
  isEnabled,
  clearCloudFrontCookies,
  maybeRefreshCloudFrontAuthCookiesMiddleware,
  recordRumProxyRequest,
  generateTwoFactorSetupToken,
  isTwoFactorEnrollmentRequired,
} = require('@librechat/api');
const passport = require('passport');

const jwtSecret = 'test-refresh-secret';

function mockReq(user, extra = {}) {
  return { headers: {}, _mockUser: user, ...extra };
}

function signedOpenIdUserCookie(userId = 'user-openid') {
  return jwt.sign({ id: userId }, jwtSecret);
}

function mockRes() {
  return {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
    end: jest.fn().mockReturnThis(),
  };
}

/** The enrollment policy re-reads the retirement cutoff, so its response lands a tick later. */
const flushPolicy = () => new Promise((resolve) => setImmediate(resolve));

/** Runs requireJwtAuth and returns the tenantId observed inside next(). */
function runAuth(user) {
  return new Promise((resolve) => {
    const req = mockReq(user);
    const res = mockRes();
    requireJwtAuth(req, res, () => {
      resolve(getTenantId());
    });
  });
}

// ── Tests ──────────────────────────────────────────────────────────────

describe('requireJwtAuth tenant context chaining', () => {
  const originalJwtSecret = process.env.JWT_REFRESH_SECRET;

  beforeEach(() => {
    process.env.JWT_REFRESH_SECRET = jwtSecret;
  });

  afterEach(() => {
    mockPassportError = null;
    mockRegisteredStrategies = new Set(['jwt']);
    mockGetUserById = jest.fn(async () => ({}));
    isEnabled.mockReturnValue(false);
    isTwoFactorEnrollmentRequired.mockReturnValue(false);
    generateTwoFactorSetupToken.mockClear();
    clearCloudFrontCookies.mockClear();
    maybeRefreshCloudFrontAuthCookiesMiddleware.mockClear();
    logger.debug.mockClear();
    logger.info.mockClear();
    logger.warn.mockClear();
    logger.error.mockClear();
    recordRumProxyRequest.mockClear();
    passport.authenticate.mockClear();
    passport._strategy.mockClear();
    if (originalJwtSecret === undefined) {
      delete process.env.JWT_REFRESH_SECRET;
    } else {
      process.env.JWT_REFRESH_SECRET = originalJwtSecret;
    }
  });

  it('forwards passport errors to next() without entering tenant middleware', async () => {
    mockPassportError = new Error('JWT signature invalid');
    const req = mockReq(undefined);
    const res = mockRes();
    const err = await new Promise((resolve) => {
      requireJwtAuth(req, res, (e) => resolve(e));
    });
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe('JWT signature invalid');
    expect(getTenantId()).toBeUndefined();
  });

  it('sets ALS tenant context after passport auth succeeds', async () => {
    const tenantId = await runAuth({ tenantId: 'tenant-abc', role: 'user' });
    expect(tenantId).toBe('tenant-abc');
  });

  it('refreshes CloudFront auth cookies after passport auth succeeds', () => {
    const req = mockReq({ tenantId: 'tenant-abc', role: 'user' });
    const res = mockRes();
    const next = jest.fn();

    requireJwtAuth(req, res, next);

    expect(maybeRefreshCloudFrontAuthCookiesMiddleware).toHaveBeenCalledWith(
      req,
      res,
      expect.any(Function),
    );
    expect(next).toHaveBeenCalled();
  });

  it('blocks protected API access for unenrolled local users', async () => {
    isTwoFactorEnrollmentRequired.mockReturnValue(true);
    const req = mockReq(
      { id: 'user-123', provider: 'local', twoFactorEnabled: false },
      { method: 'GET', baseUrl: '/api/convos', path: '/' },
    );
    const res = mockRes();
    const next = jest.fn();

    requireJwtAuth(req, res, next);
    await flushPolicy();

    expect(generateTwoFactorSetupToken).toHaveBeenCalledWith('user-123', process.env.JWT_SECRET);
    expect(clearCloudFrontCookies).toHaveBeenCalledWith(res, {
      userId: 'user-123',
      tenantId: undefined,
      storageRegion: undefined,
    });
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({
      code: 'TWO_FACTOR_ENROLLMENT_REQUIRED',
      twoFAPending: true,
      twoFASetupRequired: true,
      tempToken: 'setup-token',
    });
    expect(next).not.toHaveBeenCalled();
  });

  it('allows only the exact logout route through the enrollment policy', () => {
    isTwoFactorEnrollmentRequired.mockReturnValue(true);
    const req = mockReq(
      { id: 'user-123', provider: 'local', twoFactorEnabled: false },
      { method: 'POST', baseUrl: '/api/auth', path: '/logout' },
    );
    const res = mockRes();
    const next = jest.fn();

    requireJwtAuth(req, res, next);

    expect(generateTwoFactorSetupToken).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['a trailing slash', { method: 'POST', baseUrl: '/api/auth', path: '/logout/' }],
    ['an uppercase path', { method: 'POST', baseUrl: '/API/AUTH', path: '/LOGOUT' }],
    ['mixed case and a trailing slash', { method: 'POST', baseUrl: '/Api/Auth', path: '/Logout/' }],
  ])('allows the logout route through the enrollment policy with %s', (_label, requestShape) => {
    isTwoFactorEnrollmentRequired.mockReturnValue(true);
    const req = mockReq(
      { id: 'user-123', provider: 'local', twoFactorEnabled: false },
      requestShape,
    );
    const res = mockRes();
    const next = jest.fn();

    requireJwtAuth(req, res, next);

    expect(generateTwoFactorSetupToken).not.toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalledWith(403);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('still blocks a non-logout route that merely ends in a slash', async () => {
    isTwoFactorEnrollmentRequired.mockReturnValue(true);
    const req = mockReq(
      { id: 'user-123', provider: 'local', twoFactorEnabled: false },
      { method: 'POST', baseUrl: '/api/auth', path: '/logout/extra' },
    );
    const res = mockRes();
    const next = jest.fn();

    requireJwtAuth(req, res, next);
    await flushPolicy();

    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  it('withdraws the setup token when recovery lands between the strategy read and the mint', async () => {
    isTwoFactorEnrollmentRequired.mockReturnValue(true);
    const issuedAtMs = Date.now();
    /** The reset commits after the bearer was minted, so it revokes the credential in flight. */
    mockGetUserById = jest.fn(async () => ({ credentialsChangedAt: new Date(issuedAtMs + 1000) }));
    const req = mockReq(
      { id: 'user-123', provider: 'local', twoFactorEnabled: false },
      {
        method: 'GET',
        baseUrl: '/api/convos',
        path: '/',
        headers: {
          authorization: `Bearer ${jwt.sign({ id: 'user-123', issuedAtMs }, jwtSecret)}`,
        },
      },
    );
    const res = mockRes();
    const next = jest.fn();

    requireJwtAuth(req, res, next);
    await flushPolicy();

    expect(mockGetUserById).toHaveBeenCalledWith(
      'user-123',
      'twoFactorEnrolledAt credentialsChangedAt',
    );
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ message: 'Unauthorized' });
    expect(res.json).not.toHaveBeenCalledWith(
      expect.objectContaining({ tempToken: 'setup-token' }),
    );
    expect(next).not.toHaveBeenCalled();
  });

  it('still hands back a setup token when no recovery raced the request', async () => {
    isTwoFactorEnrollmentRequired.mockReturnValue(true);
    const issuedAtMs = Date.now();
    mockGetUserById = jest.fn(async () => ({ credentialsChangedAt: new Date(issuedAtMs - 1000) }));
    const req = mockReq(
      { id: 'user-123', provider: 'local', twoFactorEnabled: false },
      {
        method: 'GET',
        baseUrl: '/api/convos',
        path: '/',
        headers: {
          authorization: `Bearer ${jwt.sign({ id: 'user-123', issuedAtMs }, jwtSecret)}`,
        },
      },
    );
    const res = mockRes();
    const next = jest.fn();

    requireJwtAuth(req, res, next);
    await flushPolicy();

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ tempToken: 'setup-token' }));
    expect(next).not.toHaveBeenCalled();
  });

  it('withdraws the setup token for a bearer that carries no datable claim', async () => {
    isTwoFactorEnrollmentRequired.mockReturnValue(true);
    mockGetUserById = jest.fn(async () => ({ credentialsChangedAt: new Date() }));
    const req = mockReq(
      { id: 'user-123', provider: 'local', twoFactorEnabled: false },
      { method: 'GET', baseUrl: '/api/convos', path: '/', headers: {} },
    );
    const res = mockRes();
    const next = jest.fn();

    requireJwtAuth(req, res, next);
    await flushPolicy();

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('refreshes CloudFront auth cookies inside the request context', () => {
    let observedContext;
    maybeRefreshCloudFrontAuthCookiesMiddleware.mockImplementationOnce(
      (_req, _res, middlewareNext) => {
        observedContext = {
          tenantId: getTenantId(),
          userId: getUserId(),
        };
        middlewareNext();
      },
    );
    const req = mockReq({ id: 'user-123', tenantId: 'tenant-abc', role: 'user' });
    const res = mockRes();
    const next = jest.fn();

    requireJwtAuth(req, res, next);

    expect(observedContext).toEqual({ tenantId: 'tenant-abc', userId: 'user-123' });
    expect(next).toHaveBeenCalled();
  });

  it('ALS tenant context is NOT set when user has no tenantId', async () => {
    const tenantId = await runAuth({ role: 'user' });
    expect(tenantId).toBeUndefined();
  });

  it('returns 401 when no strategy authenticates a user', async () => {
    const req = mockReq(undefined);
    const res = mockRes();
    const next = jest.fn();

    requireJwtAuth(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
    expect(getTenantId()).toBeUndefined();
    expect(logger.debug).toHaveBeenCalledWith(
      expect.objectContaining({
        message: '[requireJwtAuth] Authentication failed after all strategies',
        event_name: 'jwt_auth_rejected',
        primary_strategy: 'jwt',
        fallback_attempted: false,
        fallback_succeeded: false,
        attempted_strategies: ['jwt'],
        final_strategy: 'jwt',
        reason_category: 'missing_or_unrecognized_token',
        recovery_classification: 'terminal_rejection',
        response_status: 401,
      }),
    );
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('preserves the typed account-deletion fence in an authentication rejection', () => {
    const req = mockReq(undefined, {
      _mockStrategies: {
        jwt: {
          user: false,
          info: {
            message: 'Account deletion is in progress',
            code: 'ACCOUNT_DELETION_IN_PROGRESS',
          },
          status: 401,
        },
      },
    });
    const res = mockRes();

    requireJwtAuth(req, res, jest.fn());

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({
      message: 'Account deletion is in progress',
      code: 'ACCOUNT_DELETION_IN_PROGRESS',
    });
  });

  it('logs OpenID JWT expiry when JWT fallback succeeds', () => {
    isEnabled.mockReturnValue(true);
    mockRegisteredStrategies.add('openidJwt');
    const req = mockReq(undefined, {
      requestId: 'req-expired-success',
      method: 'GET',
      path: '/api/messages',
      headers: {
        authorization: 'Bearer valid-openid-token',
        cookie: `token_provider=openid; openid_user_id=${signedOpenIdUserCookie('user-jwt')}`,
      },
      _mockStrategies: {
        openidJwt: {
          user: false,
          info: { message: 'jwt expired', name: 'TokenExpiredError' },
          status: 401,
        },
        jwt: { user: { id: 'user-jwt', tenantId: 'tenant-jwt', role: 'user' } },
      },
    });
    const res = mockRes();
    const next = jest.fn();

    requireJwtAuth(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(req.authStrategy).toBe('jwt');
    expect(res.status).not.toHaveBeenCalled();
    expect(logger.debug).toHaveBeenCalledWith(
      expect.objectContaining({
        message: '[requireJwtAuth] OpenID JWT auth failed; trying fallback',
        event_name: 'jwt_auth_fallback_attempt',
        request_id: 'req-expired-success',
        request_method: 'GET',
        request_path: '/api/messages',
        token_provider: 'openid',
        token_source: 'bearer',
        openid_reuse_enabled: true,
        openid_jwt_available: true,
        has_openid_reuse_user_id: true,
        primary_strategy: 'openidJwt',
        fallback_strategy: 'jwt',
        fallback_attempted: true,
        reason_category: 'expired_jwt',
        recovery_classification: 'fallback_attempted',
        strategy_status: 401,
      }),
    );
    expect(logger.debug).toHaveBeenCalledWith(
      expect.objectContaining({
        message: '[requireJwtAuth] JWT fallback succeeded after OpenID JWT failure',
        event_name: 'jwt_auth_recovered',
        request_id: 'req-expired-success',
        auth_strategy: 'jwt',
        primary_strategy: 'openidJwt',
        fallback_strategy: 'jwt',
        fallback_attempted: true,
        fallback_succeeded: true,
        primary_failure_reason_category: 'expired_jwt',
        recovery_classification: 'fallback_succeeded',
      }),
    );
    expect(JSON.stringify(logger.debug.mock.calls)).not.toContain('jwt expired');
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('does not let malformed Passport info break JWT fallback logging', () => {
    isEnabled.mockReturnValue(true);
    mockRegisteredStrategies.add('openidJwt');
    const info = {};
    Object.defineProperties(info, {
      message: {
        get() {
          throw new TypeError('message getter failed');
        },
      },
      name: {
        get() {
          throw new TypeError('name getter failed');
        },
      },
    });
    const req = mockReq(undefined, {
      requestId: 'req-malformed-info',
      method: 'GET',
      path: '/api/messages',
      headers: {
        cookie: `token_provider=openid; openid_user_id=${signedOpenIdUserCookie('user-jwt')}`,
      },
      _mockStrategies: {
        openidJwt: {
          user: false,
          info,
          status: 401,
        },
        jwt: { user: { id: 'user-jwt', tenantId: 'tenant-jwt', role: 'user' } },
      },
    });
    const res = mockRes();
    const next = jest.fn();

    expect(() => requireJwtAuth(req, res, next)).not.toThrow();

    expect(next).toHaveBeenCalled();
    expect(req.authStrategy).toBe('jwt');
    expect(res.status).not.toHaveBeenCalled();
    expect(logger.debug).toHaveBeenCalledWith(
      expect.objectContaining({
        message: '[requireJwtAuth] OpenID JWT auth failed; trying fallback',
        request_id: 'req-malformed-info',
        fallback_attempted: true,
        reason_category: 'missing_or_unrecognized_token',
        strategy_status: 401,
      }),
    );
    expect(logger.debug).toHaveBeenCalledWith(
      expect.objectContaining({
        message: '[requireJwtAuth] JWT fallback succeeded after OpenID JWT failure',
        request_id: 'req-malformed-info',
        fallback_succeeded: true,
        primary_failure_reason_category: 'missing_or_unrecognized_token',
      }),
    );
  });

  it('logs OpenID JWT expiry when JWT fallback fails', () => {
    isEnabled.mockReturnValue(true);
    mockRegisteredStrategies.add('openidJwt');
    const req = mockReq(undefined, {
      id: 'req-expired-fail',
      method: 'POST',
      originalUrl: '/api/ask?access_token=hidden',
      headers: {
        cookie: `token_provider=openid; openid_user_id=${signedOpenIdUserCookie('user-jwt')}`,
      },
      _mockStrategies: {
        openidJwt: {
          user: false,
          info: { message: 'jwt expired', name: 'TokenExpiredError' },
          status: 401,
        },
        jwt: {
          user: false,
          info: { message: 'invalid signature', name: 'JsonWebTokenError' },
          status: 401,
        },
      },
    });
    const res = mockRes();
    const next = jest.fn();

    requireJwtAuth(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
    expect(logger.debug).toHaveBeenCalledWith(
      expect.objectContaining({
        message: '[requireJwtAuth] OpenID JWT auth failed; trying fallback',
        event_name: 'jwt_auth_fallback_attempt',
        request_id: 'req-expired-fail',
        request_method: 'POST',
        request_path: '/api/ask',
        fallback_attempted: true,
        reason_category: 'expired_jwt',
        strategy_status: 401,
      }),
    );
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        message: '[requireJwtAuth] Authentication failed after all strategies',
        event_name: 'jwt_auth_rejected',
        request_id: 'req-expired-fail',
        request_method: 'POST',
        request_path: '/api/ask',
        token_provider: 'openid',
        attempted_strategies: ['openidJwt', 'jwt'],
        final_strategy: 'jwt',
        primary_strategy: 'openidJwt',
        fallback_strategy: 'jwt',
        fallback_attempted: true,
        fallback_succeeded: false,
        primary_failure_reason_category: 'expired_jwt',
        reason_category: 'malformed_jwt',
        recovery_classification: 'terminal_rejection',
        response_status: 401,
      }),
    );
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('invalid signature');
  });

  it('attributes malformed bearer rejections as structured 401s without an OpenID fallback', () => {
    isEnabled.mockReturnValue(true);
    mockRegisteredStrategies.add('openidJwt');
    const req = mockReq(undefined, {
      id: 'malformed-bearer-401',
      method: 'GET',
      originalUrl: '/api/banner?access_token=not-logged',
      headers: { authorization: 'Bearer malformed-token' },
      _mockStrategies: {
        jwt: { user: false, info: { message: 'invalid signature' }, status: 401 },
        openidJwt: { user: { tenantId: 'tenant-openid', role: 'user' } },
      },
    });
    const res = mockRes();
    const next = jest.fn();

    requireJwtAuth(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
    expect(req.authStrategy).toBeUndefined();
    expect(passport.authenticate).toHaveBeenCalledTimes(1);
    expect(passport.authenticate).toHaveBeenCalledWith(
      'jwt',
      { session: false },
      expect.any(Function),
    );
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event_name: 'jwt_auth_rejected',
        request_id: 'malformed-bearer-401',
        request_method: 'GET',
        request_path: '/api/banner',
        token_source: 'bearer',
        reason_category: 'malformed_jwt',
        recovery_classification: 'terminal_rejection',
        response_status: 401,
      }),
    );
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('malformed-token');
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('invalid signature');
  });

  it('uses OpenID JWT before LibreChat JWT when the OpenID cookie is present', async () => {
    isEnabled.mockReturnValue(true);
    mockRegisteredStrategies.add('openidJwt');
    const req = mockReq(undefined, {
      headers: { cookie: `token_provider=openid; openid_user_id=${signedOpenIdUserCookie()}` },
      _mockStrategies: {
        openidJwt: { user: { id: 'user-openid', tenantId: 'tenant-openid', role: 'user' } },
        jwt: { user: false, info: { message: 'invalid signature' }, status: 401 },
      },
    });
    const res = mockRes();
    const tenantId = await new Promise((resolve) => {
      requireJwtAuth(req, res, () => {
        resolve(getTenantId());
      });
    });

    expect(tenantId).toBe('tenant-openid');
    expect(req.authStrategy).toBe('openidJwt');
    expect(res.status).not.toHaveBeenCalled();
    expect(passport.authenticate).toHaveBeenCalledWith(
      'openidJwt',
      { session: false },
      expect.any(Function),
    );
    expect(maybeRefreshCloudFrontAuthCookiesMiddleware).toHaveBeenCalledWith(
      req,
      res,
      expect.any(Function),
    );
  });

  it('logs OpenID user-id mismatch when JWT fallback succeeds', () => {
    isEnabled.mockReturnValue(true);
    mockRegisteredStrategies.add('openidJwt');
    const req = mockReq(undefined, {
      requestId: 'req-mismatch-success',
      method: 'GET',
      path: '/api/auth/me',
      headers: {
        cookie: `token_provider=openid; openid_user_id=${signedOpenIdUserCookie('user-a')}`,
      },
      _mockStrategies: {
        openidJwt: { user: { id: 'user-b', tenantId: 'tenant-openid', role: 'user' } },
        jwt: { user: { id: 'user-a', tenantId: 'tenant-jwt', role: 'user' } },
      },
    });
    const res = mockRes();
    const next = jest.fn();

    requireJwtAuth(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(req.authStrategy).toBe('jwt');
    expect(logger.debug).toHaveBeenCalledWith(
      expect.objectContaining({
        message: '[requireJwtAuth] OpenID JWT auth failed; trying fallback',
        request_id: 'req-mismatch-success',
        primary_strategy: 'openidJwt',
        fallback_strategy: 'jwt',
        fallback_attempted: true,
        reason_category: 'principal_mismatch',
        strategy_status: 401,
      }),
    );
    expect(logger.debug).toHaveBeenCalledWith(
      expect.objectContaining({
        message: '[requireJwtAuth] JWT fallback succeeded after OpenID JWT failure',
        request_id: 'req-mismatch-success',
        auth_strategy: 'jwt',
        fallback_attempted: true,
        fallback_succeeded: true,
        primary_failure_reason_category: 'principal_mismatch',
      }),
    );
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('logs OpenID user-id mismatch when JWT fallback fails', () => {
    isEnabled.mockReturnValue(true);
    mockRegisteredStrategies.add('openidJwt');
    const req = mockReq(undefined, {
      requestId: 'req-mismatch-fail',
      method: 'GET',
      path: '/api/auth/me',
      headers: {
        cookie: `token_provider=openid; openid_user_id=${signedOpenIdUserCookie('user-a')}`,
      },
      _mockStrategies: {
        openidJwt: { user: { id: 'user-b', tenantId: 'tenant-openid', role: 'user' } },
        jwt: { user: false, info: { message: 'Unauthorized' }, status: 401 },
      },
    });
    const res = mockRes();
    const next = jest.fn();

    requireJwtAuth(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
    expect(logger.debug).toHaveBeenCalledWith(
      expect.objectContaining({
        message: '[requireJwtAuth] OpenID JWT auth failed; trying fallback',
        request_id: 'req-mismatch-fail',
        fallback_attempted: true,
        reason_category: 'principal_mismatch',
        strategy_status: 401,
      }),
    );
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        message: '[requireJwtAuth] Authentication failed after all strategies',
        request_id: 'req-mismatch-fail',
        attempted_strategies: ['openidJwt', 'jwt'],
        final_strategy: 'jwt',
        fallback_attempted: true,
        fallback_succeeded: false,
        primary_failure_reason_category: 'principal_mismatch',
        reason_category: 'missing_or_unrecognized_token',
        response_status: 401,
      }),
    );
  });

  it('does not authenticate OpenID JWT when the reuse cookie belongs to another user', () => {
    isEnabled.mockReturnValue(true);
    mockRegisteredStrategies.add('openidJwt');
    const req = mockReq(undefined, {
      headers: {
        cookie: `token_provider=openid; openid_user_id=${signedOpenIdUserCookie('user-a')}`,
      },
      _mockStrategies: {
        openidJwt: { user: { id: 'user-b', tenantId: 'tenant-openid', role: 'user' } },
        jwt: { user: false, info: { message: 'invalid signature' }, status: 401 },
      },
    });
    const res = mockRes();
    const next = jest.fn();

    requireJwtAuth(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
    expect(req.authStrategy).toBeUndefined();
    expect(passport.authenticate).toHaveBeenCalledTimes(2);
    expect(passport.authenticate).toHaveBeenNthCalledWith(
      1,
      'openidJwt',
      { session: false },
      expect.any(Function),
    );
    expect(passport.authenticate).toHaveBeenNthCalledWith(
      2,
      'jwt',
      { session: false },
      expect.any(Function),
    );
    expect(maybeRefreshCloudFrontAuthCookiesMiddleware).not.toHaveBeenCalled();
  });

  it('does not use OpenID JWT when the signed OpenID reuse cookie is missing', () => {
    isEnabled.mockReturnValue(true);
    mockRegisteredStrategies.add('openidJwt');
    const req = mockReq(undefined, {
      headers: { cookie: 'token_provider=openid' },
      _mockStrategies: {
        jwt: { user: false, info: { message: 'invalid signature' }, status: 401 },
        openidJwt: { user: { tenantId: 'tenant-openid', role: 'user' } },
      },
    });
    const res = mockRes();
    const next = jest.fn();

    requireJwtAuth(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
    expect(req.authStrategy).toBeUndefined();
    expect(passport.authenticate).toHaveBeenCalledTimes(1);
    expect(passport.authenticate).toHaveBeenCalledWith(
      'jwt',
      { session: false },
      expect.any(Function),
    );
    expect(maybeRefreshCloudFrontAuthCookiesMiddleware).not.toHaveBeenCalled();
  });

  it('does not use OpenID JWT when the OpenID reuse cookie is invalid', () => {
    isEnabled.mockReturnValue(true);
    mockRegisteredStrategies.add('openidJwt');
    const req = mockReq(undefined, {
      headers: { cookie: 'token_provider=openid; openid_user_id=invalid-jwt' },
      _mockStrategies: {
        jwt: { user: false, info: { message: 'invalid signature' }, status: 401 },
        openidJwt: { user: { tenantId: 'tenant-openid', role: 'user' } },
      },
    });
    const res = mockRes();
    const next = jest.fn();

    requireJwtAuth(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
    expect(req.authStrategy).toBeUndefined();
    expect(passport.authenticate).toHaveBeenCalledTimes(1);
    expect(passport.authenticate).toHaveBeenCalledWith(
      'jwt',
      { session: false },
      expect.any(Function),
    );
    expect(maybeRefreshCloudFrontAuthCookiesMiddleware).not.toHaveBeenCalled();
  });

  it('skips OpenID JWT fallback when the strategy was not registered', async () => {
    isEnabled.mockReturnValue(true);
    const req = mockReq(undefined, {
      _mockStrategies: {
        jwt: { user: false, info: { message: 'invalid signature' }, status: 401 },
        openidJwt: { user: { tenantId: 'tenant-openid', role: 'user' } },
      },
    });
    const res = mockRes();
    const next = jest.fn();

    requireJwtAuth(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
    expect(req.authStrategy).toBeUndefined();
    expect(passport.authenticate).toHaveBeenCalledTimes(1);
    expect(passport.authenticate).toHaveBeenCalledWith(
      'jwt',
      { session: false },
      expect.any(Function),
    );
  });

  it('concurrent requests get isolated tenant contexts', async () => {
    const results = await Promise.all(
      ['tenant-1', 'tenant-2', 'tenant-3'].map((tid) => runAuth({ tenantId: tid, role: 'user' })),
    );
    expect(results).toEqual(['tenant-1', 'tenant-2', 'tenant-3']);
  });

  it('ALS context is not set at top-level scope (outside any request)', () => {
    expect(getTenantId()).toBeUndefined();
  });
});

describe('requireRumProxyAuth', () => {
  const originalJwtSecret = process.env.JWT_REFRESH_SECRET;

  beforeEach(() => {
    process.env.JWT_REFRESH_SECRET = jwtSecret;
  });

  afterEach(() => {
    mockPassportError = null;
    mockRegisteredStrategies = new Set(['jwt']);
    isEnabled.mockReturnValue(false);
    maybeRefreshCloudFrontAuthCookiesMiddleware.mockClear();
    logger.debug.mockClear();
    logger.info.mockClear();
    logger.warn.mockClear();
    logger.error.mockClear();
    recordRumProxyRequest.mockClear();
    passport.authenticate.mockClear();
    passport._strategy.mockClear();
    if (originalJwtSecret === undefined) {
      delete process.env.JWT_REFRESH_SECRET;
    } else {
      process.env.JWT_REFRESH_SECRET = originalJwtSecret;
    }
  });

  it('authenticates telemetry with the LibreChat JWT strategy without tenant or cookie refresh middleware', () => {
    const req = mockReq({ id: 'user-jwt', tenantId: 'tenant-jwt', role: 'user' });
    const res = mockRes();
    const next = jest.fn();

    requireRumProxyAuth(req, res, next);

    expect(passport.authenticate).toHaveBeenCalledWith(
      'jwt',
      { session: false },
      expect.any(Function),
    );
    expect(req.authStrategy).toBe('jwt');
    expect(maybeRefreshCloudFrontAuthCookiesMiddleware).not.toHaveBeenCalled();
    // Success is recorded by the proxy.
    expect(recordRumProxyRequest).not.toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalled();
  });

  it('authenticates telemetry with OpenID JWT reuse when the reuse cookie is present', () => {
    isEnabled.mockReturnValue(true);
    mockRegisteredStrategies.add('openidJwt');
    const req = mockReq(undefined, {
      headers: { cookie: `token_provider=openid; openid_user_id=${signedOpenIdUserCookie()}` },
      _mockStrategies: {
        openidJwt: { user: { id: 'user-openid', tenantId: 'tenant-openid', role: 'user' } },
        jwt: { user: false, info: { message: 'invalid signature' }, status: 401 },
      },
    });
    const res = mockRes();
    const next = jest.fn();

    requireRumProxyAuth(req, res, next);

    expect(passport.authenticate).toHaveBeenCalledWith(
      'openidJwt',
      { session: false },
      expect.any(Function),
    );
    expect(req.authStrategy).toBe('openidJwt');
    expect(maybeRefreshCloudFrontAuthCookiesMiddleware).not.toHaveBeenCalled();
    expect(recordRumProxyRequest).not.toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalled();
  });

  it('falls back to LibreChat JWT when OpenID JWT telemetry auth fails', () => {
    isEnabled.mockReturnValue(true);
    mockRegisteredStrategies.add('openidJwt');
    const req = mockReq(undefined, {
      headers: { cookie: `token_provider=openid; openid_user_id=${signedOpenIdUserCookie()}` },
      _mockStrategies: {
        openidJwt: {
          user: false,
          info: { message: 'jwt expired', name: 'TokenExpiredError' },
          status: 401,
        },
        jwt: { user: { id: 'user-openid', tenantId: 'tenant-jwt', role: 'user' } },
      },
    });
    const res = mockRes();
    const next = jest.fn();

    requireRumProxyAuth(req, res, next);

    expect(passport.authenticate).toHaveBeenCalledTimes(2);
    expect(req.authStrategy).toBe('jwt');
    expect(recordRumProxyRequest).not.toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalled();
  });

  it('drops invalid telemetry auth with 204 instead of returning an app auth error', () => {
    const req = mockReq(undefined, {
      path: '/v1/traces',
      _mockStrategies: {
        jwt: {
          user: false,
          info: { message: 'invalid signature', name: 'JsonWebTokenError' },
          status: 401,
        },
      },
    });
    const res = mockRes();
    const next = jest.fn();

    requireRumProxyAuth(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(maybeRefreshCloudFrontAuthCookiesMiddleware).not.toHaveBeenCalled();
    expect(recordRumProxyRequest).toHaveBeenCalledWith('traces', 'auth_drop');
    expect(res.status).toHaveBeenCalledWith(204);
    expect(res.end).toHaveBeenCalled();
  });

  it('records passport errors separately from ordinary telemetry auth drops', () => {
    mockPassportError = new Error('passport unavailable');
    const req = mockReq(undefined, { path: '/v1/logs' });
    const res = mockRes();
    const next = jest.fn();

    requireRumProxyAuth(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
    expect(recordRumProxyRequest).toHaveBeenCalledWith('logs', 'auth_error');
    expect(res.status).toHaveBeenCalledWith(204);
    expect(res.end).toHaveBeenCalled();
  });
});
