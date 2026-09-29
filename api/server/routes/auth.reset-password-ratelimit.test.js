const express = require('express');
const request = require('supertest');

const mockCheckBan = jest.fn((req, res, next) => next());
const mockResetPasswordSubmissionLimiter = jest.fn((req, res, next) => next());
const mockValidatePasswordReset = jest.fn((req, res, next) => next());
const mockResetPasswordController = jest.fn((req, res) => res.status(204).end());

jest.mock('@librechat/api', () => ({
  createSetBalanceConfig: jest.fn(() => (req, res, next) => next()),
  forceRefreshCloudFrontAuthCookies: jest.fn(),
}));

jest.mock('~/server/controllers/AuthController', () => ({
  refreshController: jest.fn((req, res) => res.status(204).end()),
  registrationController: jest.fn((req, res) => res.status(204).end()),
  resetPasswordController: (...args) => mockResetPasswordController(...args),
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
  verify2FAWithTempToken: jest.fn((req, res) => res.status(204).end()),
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
    setTwoFactorTempUser: pass,
    twoFactorTempLimiter: pass,
    checkBan: (...args) => mockCheckBan(...args),
    validateEmailLogin: pass,
    requireLocalAuth: pass,
    requireLdapAuth: pass,
    registerLimiter: pass,
    checkInviteUser: pass,
    validateRegistration: pass,
    resetPasswordLimiter: pass,
    resetPasswordSubmissionLimiter: (...args) => mockResetPasswordSubmissionLimiter(...args),
    validatePasswordReset: (...args) => mockValidatePasswordReset(...args),
    requireJwtAuth: pass,
  };
});

const authRouter = require('./auth');

describe('POST /api/auth/resetPassword rate limiting', () => {
  let app;

  beforeEach(() => {
    jest.clearAllMocks();
    mockCheckBan.mockImplementation((req, res, next) => next());
    mockResetPasswordSubmissionLimiter.mockImplementation((req, res, next) => next());
    mockValidatePasswordReset.mockImplementation((req, res, next) => next());
    mockResetPasswordController.mockImplementation((req, res) => res.status(204).end());

    app = express();
    app.use(express.json());
    app.use('/api/auth', authRouter);
  });

  it('limits before ban checks, validation, and password reset work', async () => {
    await request(app).post('/api/auth/resetPassword').send({ token: 'token' }).expect(204);

    expect(mockResetPasswordSubmissionLimiter).toHaveBeenCalledTimes(1);
    expect(mockCheckBan).toHaveBeenCalledTimes(1);
    expect(mockValidatePasswordReset).toHaveBeenCalledTimes(1);
    expect(mockResetPasswordController).toHaveBeenCalledTimes(1);
    expect(mockResetPasswordSubmissionLimiter.mock.invocationCallOrder[0]).toBeLessThan(
      mockCheckBan.mock.invocationCallOrder[0],
    );
    expect(mockCheckBan.mock.invocationCallOrder[0]).toBeLessThan(
      mockValidatePasswordReset.mock.invocationCallOrder[0],
    );
    expect(mockValidatePasswordReset.mock.invocationCallOrder[0]).toBeLessThan(
      mockResetPasswordController.mock.invocationCallOrder[0],
    );
  });

  it('does not validate or reset passwords after the limiter rejects the request', async () => {
    mockResetPasswordSubmissionLimiter.mockImplementation((req, res) =>
      res.status(429).json({ message: 'Too many password reset attempts' }),
    );

    const response = await request(app)
      .post('/api/auth/resetPassword')
      .send({ token: 'token' })
      .expect(429);

    expect(response.body).toEqual({ message: 'Too many password reset attempts' });
    expect(mockCheckBan).not.toHaveBeenCalled();
    expect(mockValidatePasswordReset).not.toHaveBeenCalled();
    expect(mockResetPasswordController).not.toHaveBeenCalled();
  });
});
