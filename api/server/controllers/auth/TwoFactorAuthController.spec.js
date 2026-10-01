const jwt = require('jsonwebtoken');

const mockLogger = { warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
const mockGetUserById = jest.fn();
const mockGetTOTPSecret = jest.fn();
const mockVerifyTOTP = jest.fn();
const mockVerifyBackupCode = jest.fn();
const mockSetAuthTokens = jest.fn();

jest.mock('@librechat/data-schemas', () => ({ logger: mockLogger }));

jest.mock('~/server/services/twoFactorService', () => ({
  getTOTPSecret: (...args) => mockGetTOTPSecret(...args),
  verifyTOTP: (...args) => mockVerifyTOTP(...args),
  verifyBackupCode: (...args) => mockVerifyBackupCode(...args),
}));

jest.mock('~/server/services/AuthService', () => ({
  setAuthTokens: (...args) => mockSetAuthTokens(...args),
}));

jest.mock('~/models', () => ({
  getUserById: (...args) => mockGetUserById(...args),
}));

const { verify2FAWithTempToken } = require('./TwoFactorAuthController');

const USER_ID = '65f0c1b2c3d4e5f6a7b8c9d0';
const SECRET = 'test-jwt-secret';

const buildRes = () => {
  const res = {};
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  return res;
};

/** Signs a real temp token so `iat` is genuine rather than hand-stamped. */
const tempTokenFor = (userId) => jwt.sign({ userId }, SECRET, { expiresIn: '5m' });

beforeEach(() => {
  jest.clearAllMocks();
  process.env.JWT_SECRET = SECRET;
  mockGetTOTPSecret.mockResolvedValue('totp-secret');
  mockVerifyTOTP.mockResolvedValue(true);
  mockSetAuthTokens.mockResolvedValue('auth-token');
});

describe('verify2FAWithTempToken credential-change cutoff', () => {
  const userDoc = (overrides = {}) => ({
    _id: { toString: () => USER_ID },
    twoFactorEnabled: true,
    totpSecret: 'totp-secret',
    ...overrides,
  });

  it('rejects a temp token minted before the credentials changed', async () => {
    const tempToken = tempTokenFor(USER_ID);
    /** Stamp the reset a minute into the future so the token unambiguously predates it. */
    mockGetUserById.mockResolvedValue(
      userDoc({ credentialsChangedAt: new Date(Date.now() + 60_000) }),
    );
    const res = buildRes();

    await verify2FAWithTempToken({ body: { tempToken, token: '123456' } }, res);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(mockSetAuthTokens).not.toHaveBeenCalled();
  });

  it('accepts a temp token minted after the credentials changed', async () => {
    const tempToken = tempTokenFor(USER_ID);
    mockGetUserById.mockResolvedValue(
      userDoc({ credentialsChangedAt: new Date(Date.now() - 60_000) }),
    );
    const res = buildRes();

    await verify2FAWithTempToken({ body: { tempToken, token: '123456' } }, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(mockSetAuthTokens).toHaveBeenCalled();
  });

  it('accepts a temp token when the account never changed credentials', async () => {
    const tempToken = tempTokenFor(USER_ID);
    mockGetUserById.mockResolvedValue(userDoc());
    const res = buildRes();

    await verify2FAWithTempToken({ body: { tempToken, token: '123456' } }, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(mockSetAuthTokens).toHaveBeenCalled();
  });
});
