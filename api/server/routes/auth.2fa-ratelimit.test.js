const express = require('express');
const request = require('supertest');

const mockSetTwoFactorTempUser = jest.fn((req, res, next) => next());
const mockTwoFactorTempLimiter = jest.fn((req, res, next) => next());
const mockCheckBan = jest.fn((req, res, next) => next());
const mockVerify2FAWithTempToken = jest.fn((req, res) => res.status(204).end());

jest.mock('@librechat/api', () => ({
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
  getAppConfig: jest.fn(),
}));

jest.mock('~/server/middleware', () => {
  const pass = (req, res, next) => next();
  return {
    logHeaders: pass,
    requireSameOrigin: pass,
    loginLimiter: pass,
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
    requireJwtAuth: pass,
  };
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
