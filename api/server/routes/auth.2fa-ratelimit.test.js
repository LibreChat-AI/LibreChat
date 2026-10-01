const express = require('express');
const request = require('supertest');

const mockSetTwoFactorTempUser = jest.fn((req, res, next) => next());
const mockTwoFactorTempLimiter = jest.fn((req, res, next) => next());
const mockCheckBan = jest.fn((req, res, next) => next());
const mockVerify2FAWithTempToken = jest.fn((req, res) => res.status(204).end());

jest.mock('@librechat/api', () => ({
  limiterCache: jest.fn(() => undefined),
  createTwoFactorManagementLimiter: (...args) =>
    require('../../../packages/api/src/middleware/twoFactor').createTwoFactorManagementLimiter(
      ...args,
    ),
  createSetBalanceConfig: jest.fn(() => (req, res, next) => next()),
  forceRefreshCloudFrontAuthCookies: jest.fn(),
}));

jest.mock('~/server/controllers/AuthController', () => ({
  refreshController: jest.fn((req, res) => res.status(204).end()),
  registrationController: jest.fn((req, res) => res.status(204).end()),
  resetPasswordController: jest.fn((req, res) => res.status(204).end()),
  resetPasswordRequestController: jest.fn((req, res) => res.status(204).end()),
  graphTokenController: jest.fn((req, res) => res.status(204).end()),
}));

jest.mock('~/server/controllers/TwoFactorController', () => ({
  enable2FA: jest.fn((req, res) => res.status(204).end()),
  verify2FA: jest.fn((req, res) => res.status(204).end()),
  confirm2FA: jest.fn((req, res) => res.status(204).end()),
  disable2FA: jest.fn((req, res) => res.status(204).end()),
  regenerateBackupCodes: jest.fn((req, res) => res.status(204).end()),
}));

jest.mock('~/server/controllers/auth/TwoFactorAuthController', () => ({
  verify2FAWithTempToken: (...args) => mockVerify2FAWithTempToken(...args),
}));

jest.mock('~/server/controllers/auth/PasskeyController', () => ({
  listPasskeys: jest.fn((req, res) => res.status(204).end()),
  updatePasskey: jest.fn((req, res) => res.status(204).end()),
  removePasskey: jest.fn((req, res) => res.status(204).end()),
  authenticatePasskey: jest.fn((req, res, next) => next()),
  loginPasskeyOptions: jest.fn((req, res) => res.status(204).end()),
  registerPasskeyOptions: jest.fn((req, res) => res.status(204).end()),
  registerPasskeyVerify: jest.fn((req, res) => res.status(204).end()),
}));

jest.mock('~/server/controllers/auth/LogoutController', () => ({
  logoutController: jest.fn((req, res) => res.status(204).end()),
}));

jest.mock('~/server/controllers/auth/LoginController', () => ({
  loginController: jest.fn((req, res) => res.status(204).end()),
}));

jest.mock('~/models', () => ({
  findBalanceByUser: jest.fn(),
  upsertBalanceFields: jest.fn(),
}));

jest.mock('~/server/services/Config', () => ({
  getAppConfig: jest.fn(async () => ({ config: { rateLimits: {} } })),
}));

jest.mock('~/server/middleware', () => {
  const pass = (req, res, next) => next();
  return {
    logHeaders: pass,
    requireSameOrigin: pass,
    loginLimiter: pass,
    passkeyLimiter: pass,
    passkeyStepUpLimiter: pass,
    setTwoFactorTempUser: (...args) => mockSetTwoFactorTempUser(...args),
    twoFactorTempLimiter: (...args) => mockTwoFactorTempLimiter(...args),
    checkBan: (...args) => mockCheckBan(...args),
    validateEmailLogin: pass,
    requireLocalAuth: pass,
    requireLdapAuth: pass,
    registerLimiter: pass,
    checkInviteUser: pass,
    validateRegistration: pass,
    resetPasswordLimiter: pass,
    resetPasswordSubmissionLimiter: pass,
    validatePasswordReset: pass,
    requireJwtAuth: (req, res, next) => {
      if (!req.headers['x-user']) return res.sendStatus(401);
      req.user = { id: req.headers['x-user'], tenantId: req.headers['x-tenant'] };
      next();
    },
  };
});

describe('authenticated 2FA management budget', () => {
  let app;
  const paths = ['enable', 'verify', 'confirm', 'disable', 'backup/regenerate'];
  beforeEach(() => {
    require('~/server/services/Config').getAppConfig.mockResolvedValue({
      config: { rateLimits: {} },
    });
    app = express();
    app.use(express.json());
    app.use('/api/auth', authRouter);
  });

  it('shares one budget across routes and rejects before invoking the controller', async () => {
    for (let i = 0; i < 7; i++) {
      await request(app)
        .post(`/api/auth/2fa/${paths[i % paths.length]}`)
        .set('x-user', 'cross-route-user')
        .send({ token: '111111' })
        .expect(204);
    }
    const controllers = require('~/server/controllers/TwoFactorController');
    const calls = controllers.regenerateBackupCodes.mock.calls.length;
    const blocked = await request(app)
      .post('/api/auth/2fa/backup/regenerate')
      .set('x-user', 'cross-route-user')
      .send({ token: '111111' })
      .expect(429);
    expect(blocked.headers['retry-after']).toBeDefined();
    expect(controllers.regenerateBackupCodes.mock.calls).toHaveLength(calls);
    await request(app).post('/api/auth/2fa/disable').set('x-user', 'cross-route-user').expect(429);
  });

  it('isolates accounts and tenants and authenticates before counting', async () => {
    const controllers = require('~/server/controllers/TwoFactorController');
    const calls = controllers.regenerateBackupCodes.mock.calls.length;
    for (let i = 0; i < 8; i++) {
      await request(app).post('/api/auth/2fa/backup/regenerate').expect(401);
    }
    expect(controllers.regenerateBackupCodes.mock.calls).toHaveLength(calls);
    for (let i = 0; i < 7; i++) {
      await request(app)
        .post('/api/auth/2fa/verify')
        .set('x-user', 'tenant-user')
        .set('x-tenant', 'one')
        .expect(204);
    }
    await request(app)
      .post('/api/auth/2fa/verify')
      .set('x-user', 'tenant-user')
      .set('x-tenant', 'one')
      .expect(429);
    await request(app)
      .post('/api/auth/2fa/verify')
      .set('x-user', 'tenant-user')
      .set('x-tenant', 'two')
      .expect(204);
    await request(app)
      .post('/api/auth/2fa/verify')
      .set('x-user', 'other-user')
      .set('x-tenant', 'one')
      .expect(204);
  });

  it('admits only seven concurrent requests across operations', async () => {
    const responses = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        request(app)
          .post(`/api/auth/2fa/${paths[i % paths.length]}`)
          .set('x-user', 'concurrent-user')
          .send({ token: '111111' }),
      ),
    );
    expect(responses.filter(({ status }) => status === 204)).toHaveLength(7);
    expect(responses.filter(({ status }) => status === 429)).toHaveLength(13);
  });

  it('admits the entire setup sequence with the minimum configured budget', async () => {
    require('~/server/services/Config').getAppConfig.mockResolvedValue({
      config: { rateLimits: { twoFactorManagement: { requestsPerFiveMinutes: 3 } } },
    });
    for (const operation of ['enable', 'verify', 'confirm']) {
      await request(app)
        .post(`/api/auth/2fa/${operation}`)
        .set('x-user', 'minimum-budget-user')
        .expect(204);
    }
    const blocked = await request(app)
      .post('/api/auth/2fa/verify')
      .set('x-user', 'minimum-budget-user')
      .expect(429);
    expect(blocked.headers['ratelimit-limit']).toBe('3');
  });
});

const authRouter = require('./auth');

describe('POST /api/auth/2fa/verify-temp rate limiting', () => {
  let app;

  beforeEach(() => {
    jest.clearAllMocks();
    mockSetTwoFactorTempUser.mockImplementation((req, res, next) => next());
    mockTwoFactorTempLimiter.mockImplementation((req, res, next) => next());
    mockCheckBan.mockImplementation((req, res, next) => next());
    mockVerify2FAWithTempToken.mockImplementation((req, res) => res.status(204).end());

    app = express();
    app.use(express.json());
    app.use('/api/auth', authRouter);
  });

  it('sets the temp user before limiting, checking bans, and verifying temp 2FA tokens', async () => {
    await request(app).post('/api/auth/2fa/verify-temp').send({ token: '123456' }).expect(204);

    expect(mockSetTwoFactorTempUser).toHaveBeenCalledTimes(1);
    expect(mockTwoFactorTempLimiter).toHaveBeenCalledTimes(1);
    expect(mockCheckBan).toHaveBeenCalledTimes(1);
    expect(mockVerify2FAWithTempToken).toHaveBeenCalledTimes(1);
    expect(mockSetTwoFactorTempUser.mock.invocationCallOrder[0]).toBeLessThan(
      mockTwoFactorTempLimiter.mock.invocationCallOrder[0],
    );
    expect(mockTwoFactorTempLimiter.mock.invocationCallOrder[0]).toBeLessThan(
      mockCheckBan.mock.invocationCallOrder[0],
    );
    expect(mockCheckBan.mock.invocationCallOrder[0]).toBeLessThan(
      mockVerify2FAWithTempToken.mock.invocationCallOrder[0],
    );
  });

  it('does not verify the temp 2FA token after the limiter rejects the request', async () => {
    mockTwoFactorTempLimiter.mockImplementation((req, res) =>
      res.status(429).json({ message: 'Too many verification attempts' }),
    );

    const response = await request(app)
      .post('/api/auth/2fa/verify-temp')
      .send({ token: '123456' })
      .expect(429);

    expect(response.body).toEqual({ message: 'Too many verification attempts' });
    expect(mockSetTwoFactorTempUser).toHaveBeenCalledTimes(1);
    expect(mockCheckBan).not.toHaveBeenCalled();
    expect(mockVerify2FAWithTempToken).not.toHaveBeenCalled();
  });
});
