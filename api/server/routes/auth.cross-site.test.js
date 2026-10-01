const express = require('express');
const request = require('supertest');
const { ErrorTypes } = require('librechat-data-provider');

const mockLoginLimiter = jest.fn((req, res, next) => next());
const mockRequireLocalAuth = jest.fn((req, res, next) => next());
const mockSetTwoFactorTempUser = jest.fn((req, res, next) => next());
const mockLoginController = jest.fn((req, res) => res.status(204).end());
const mockVerify2FAWithTempToken = jest.fn((req, res) => res.status(204).end());

jest.mock('@librechat/data-schemas', () => ({
  ...jest.requireActual('@librechat/data-schemas'),
  logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

jest.mock('@librechat/api', () => ({
  ...jest.requireActual('@librechat/api'),
  createSetBalanceConfig: jest.fn(() => (req, res, next) => next()),
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
  loginController: (...args) => mockLoginController(...args),
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
    requireSameOrigin: jest.requireActual('~/server/middleware/requireSameOrigin'),
    loginLimiter: (...args) => mockLoginLimiter(...args),
    passkeyLimiter: pass,
    passkeyStepUpLimiter: pass,
    setTwoFactorTempUser: (...args) => mockSetTwoFactorTempUser(...args),
    twoFactorTempLimiter: pass,
    checkBan: pass,
    validateEmailLogin: jest.requireActual('~/server/middleware/validateEmailLogin'),
    requireLocalAuth: (...args) => mockRequireLocalAuth(...args),
    requireLdapAuth: (...args) => mockRequireLocalAuth(...args),
    registerLimiter: pass,
    checkInviteUser: pass,
    validateRegistration: pass,
    resetPasswordLimiter: pass,
    resetPasswordSubmissionLimiter: pass,
    validatePasswordReset: pass,
    requireJwtAuth: pass,
  };
});

const ORIGINAL_ENV = process.env;
const APP_ORIGIN = 'https://chat.example.com';
const OTHER_ORIGIN = 'https://other-site.example.net';
const ADMIN_PANEL_ORIGIN = 'https://admin.example.com';

describe('local login endpoints reject cross-site submissions', () => {
  let app;

  beforeAll(() => {
    process.env = {
      ...ORIGINAL_ENV,
      DOMAIN_CLIENT: APP_ORIGIN,
      DOMAIN_SERVER: APP_ORIGIN,
      ADMIN_PANEL_URL: `${ADMIN_PANEL_ORIGIN}/`,
    };
    app = express();
    app.use(express.json());
    app.use(express.urlencoded({ extended: true }));
    app.use('/api/auth', require('./auth'));
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('rejects a login form submitted from another site before authenticating', async () => {
    const response = await request(app)
      .post('/api/auth/login')
      .set('Host', 'chat.example.com')
      .set('Sec-Fetch-Site', 'cross-site')
      .set('Origin', OTHER_ORIGIN)
      .type('form')
      .send({ email: 'other@example.com', password: 'other-password' })
      .expect(403);

    expect(response.body).toEqual({
      message: 'Cross-site request rejected',
      code: ErrorTypes.AUTH_CROSS_ORIGIN,
    });
    expect(response.headers['set-cookie']).toBeUndefined();
    expect(mockLoginLimiter).not.toHaveBeenCalled();
    expect(mockRequireLocalAuth).not.toHaveBeenCalled();
    expect(mockLoginController).not.toHaveBeenCalled();
  });

  it('rejects a cross-site passkey assertion before verifying it', async () => {
    const { authenticatePasskey } = require('~/server/controllers/auth/PasskeyController');

    await request(app)
      .post('/api/auth/passkey/login/verify')
      .set('Host', 'chat.example.com')
      .set('Sec-Fetch-Site', 'cross-site')
      .set('Origin', OTHER_ORIGIN)
      .type('form')
      .send({ sessionId: 'attacker-session', 'credential[id]': 'attacker-credential' })
      .expect(403);

    expect(authenticatePasskey).not.toHaveBeenCalled();
    expect(mockLoginController).not.toHaveBeenCalled();
  });

  it('rejects a cross-site temp-token 2FA submission before verifying it', async () => {
    await request(app)
      .post('/api/auth/2fa/verify-temp')
      .set('Host', 'chat.example.com')
      .set('Sec-Fetch-Site', 'cross-site')
      .set('Origin', OTHER_ORIGIN)
      .type('form')
      .send({ tempToken: 'other-temp-token', token: '123456' })
      .expect(403);

    expect(mockSetTwoFactorTempUser).not.toHaveBeenCalled();
    expect(mockVerify2FAWithTempToken).not.toHaveBeenCalled();
  });

  it('accepts the login form the app submits from its own origin', async () => {
    await request(app)
      .post('/api/auth/login')
      .set('Host', 'chat.example.com')
      .set('Sec-Fetch-Site', 'same-origin')
      .set('Origin', APP_ORIGIN)
      .send({ email: 'user@example.com', password: 'password' })
      .expect(204);

    expect(mockRequireLocalAuth).toHaveBeenCalledTimes(1);
    expect(mockLoginController).toHaveBeenCalledTimes(1);
  });

  it('accepts a 2FA submission from the configured client origin', async () => {
    await request(app)
      .post('/api/auth/2fa/verify-temp')
      .set('Host', 'api.example.com')
      .set('Sec-Fetch-Site', 'same-site')
      .set('Origin', APP_ORIGIN)
      .send({ tempToken: 'temp-token', token: '123456' })
      .expect(204);

    expect(mockVerify2FAWithTempToken).toHaveBeenCalledTimes(1);
  });

  it('accepts a login posted from the configured admin panel origin', async () => {
    await request(app)
      .post('/api/auth/login')
      .set('Host', 'chat.example.com')
      .set('Sec-Fetch-Site', 'same-site')
      .set('Origin', ADMIN_PANEL_ORIGIN)
      .send({ email: 'admin@example.com', password: 'password' })
      .expect(204);

    expect(mockLoginController).toHaveBeenCalledTimes(1);
  });

  it('accepts a server-side client that sends no browser headers', async () => {
    await request(app)
      .post('/api/auth/login')
      .send({ email: 'user@example.com', password: 'password' })
      .expect(204);

    expect(mockLoginController).toHaveBeenCalledTimes(1);
  });

  describe('with email login disabled', () => {
    beforeEach(() => {
      process.env.ALLOW_EMAIL_LOGIN = 'false';
    });

    afterEach(() => {
      delete process.env.ALLOW_EMAIL_LOGIN;
    });

    it('still rejects the password login', async () => {
      await request(app)
        .post('/api/auth/login')
        .send({ email: 'user@example.com', password: 'password' })
        .expect(403);

      expect(mockLoginController).not.toHaveBeenCalled();
    });

    it('keeps passkey sign-in reachable', async () => {
      const {
        authenticatePasskey,
        loginPasskeyOptions,
      } = require('~/server/controllers/auth/PasskeyController');

      await request(app).post('/api/auth/passkey/login/options').expect(204);
      await request(app)
        .post('/api/auth/passkey/login/verify')
        .send({ sessionId: 'session', credential: { id: 'credential' } })
        .expect(204);

      expect(loginPasskeyOptions).toHaveBeenCalledTimes(1);
      expect(authenticatePasskey).toHaveBeenCalledTimes(1);
      expect(mockLoginController).toHaveBeenCalledTimes(1);
    });
  });
});
