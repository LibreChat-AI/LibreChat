const mockGenerate2FATempToken = jest.fn(() => 'challenge-token');
const mockSetAuthTokens = jest.fn(() => Promise.resolve('auth-token'));
const mockClearCloudFrontCookies = jest.fn();
const mockDeleteAllUserSessions = jest.fn(() => Promise.resolve({ deletedCount: 1 }));

/** What the record carries right now, so a reset can land mid-request the way recovery does. */
const record = { credentialsChangedAt: null };
const mockGetUserById = jest.fn(async () => ({
  credentialsChangedAt: record.credentialsChangedAt,
}));

jest.mock('@librechat/data-schemas', () => ({
  logger: { error: jest.fn(), warn: jest.fn() },
}));

jest.mock('@librechat/api', () => ({
  ...jest.requireActual('@librechat/api'),
  clearCloudFrontCookies: (...args) => mockClearCloudFrontCookies(...args),
}));

jest.mock('~/server/services/twoFactorService', () => ({
  generate2FATempToken: (...args) => mockGenerate2FATempToken(...args),
}));

jest.mock('~/server/services/AuthService', () => ({
  setAuthTokens: (...args) => mockSetAuthTokens(...args),
}));

jest.mock('~/models', () => ({
  getUserById: (...args) => mockGetUserById(...args),
  deleteAllUserSessions: (...args) => mockDeleteAllUserSessions(...args),
}));

const { loginController } = require('./LoginController');
const { verifyTwoFactorSetupToken } = require('@librechat/api');

function createResponse() {
  return {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
    send: jest.fn().mockReturnThis(),
    clearCookie: jest.fn().mockReturnThis(),
  };
}

describe('loginController', () => {
  const originalPolicy = process.env.ENFORCE_TWO_FACTOR_AUTHENTICATION;
  const originalSecret = process.env.JWT_SECRET;

  beforeEach(() => {
    jest.clearAllMocks();
    record.credentialsChangedAt = null;
    process.env.JWT_SECRET = 'jwt-secret';
    delete process.env.ENFORCE_TWO_FACTOR_AUTHENTICATION;
  });

  afterAll(() => {
    if (originalPolicy === undefined) {
      delete process.env.ENFORCE_TWO_FACTOR_AUTHENTICATION;
    } else {
      process.env.ENFORCE_TWO_FACTOR_AUTHENTICATION = originalPolicy;
    }
    if (originalSecret === undefined) {
      delete process.env.JWT_SECRET;
    } else {
      process.env.JWT_SECRET = originalSecret;
    }
  });

  it('uses the existing 2FA challenge for enrolled users', async () => {
    const req = { user: { _id: 'user-1', twoFactorEnabled: true } };
    const res = createResponse();

    await loginController(req, res);

    expect(mockGenerate2FATempToken).toHaveBeenCalledWith('user-1');
    expect(res.json).toHaveBeenCalledWith({
      twoFAPending: true,
      tempToken: 'challenge-token',
    });
    expect(mockSetAuthTokens).not.toHaveBeenCalled();
  });

  it('requires purpose-scoped enrollment before issuing auth tokens', async () => {
    process.env.ENFORCE_TWO_FACTOR_AUTHENTICATION = 'true';
    const req = { user: { _id: 'user-2', twoFactorEnabled: false } };
    const res = createResponse();

    await loginController(req, res);

    expect(mockClearCloudFrontCookies).toHaveBeenCalledWith(res, {
      userId: 'user-2',
      tenantId: undefined,
      storageRegion: undefined,
    });
    expect(res.json).toHaveBeenCalledWith({
      code: 'TWO_FACTOR_ENROLLMENT_REQUIRED',
      twoFAPending: true,
      twoFASetupRequired: true,
      tempToken: expect.any(String),
    });
    expect(mockSetAuthTokens).not.toHaveBeenCalled();
    expect(verifyTwoFactorSetupToken(res.json.mock.calls[0][0].tempToken, 'jwt-secret')).toEqual(
      expect.objectContaining({ userId: 'user-2' }),
    );
  });

  it('keeps optional 2FA login behavior unchanged when enforcement is disabled', async () => {
    process.env.ENFORCE_TWO_FACTOR_AUTHENTICATION = 'false';
    const req = {
      user: {
        _id: 'user-3',
        password: 'secret',
        totpSecret: 'totp',
        email: 'user@example.com',
      },
    };
    const res = createResponse();

    await loginController(req, res);

    expect(mockSetAuthTokens).toHaveBeenCalledWith('user-3', res, null, req);
    expect(res.send).toHaveBeenCalledWith({
      token: 'auth-token',
      user: {
        _id: 'user-3',
        email: 'user@example.com',
        id: 'user-3',
      },
    });
  });

  it('does not offer local enrollment to federated users', async () => {
    process.env.ENFORCE_TWO_FACTOR_AUTHENTICATION = 'true';
    const req = {
      user: { _id: 'user-4', provider: 'openid', email: 'federated@example.com' },
    };
    const res = createResponse();

    await loginController(req, res);

    expect(mockSetAuthTokens).not.toHaveBeenCalled();
  });

  /**
   * A password reset assigns a password without consulting `provider`, so a federated record can
   * be signed in through the local strategy. Under enforcement that login checks neither the
   * identity provider's MFA nor this policy, and enrollment cannot remedy it.
   */
  it('refuses a password login for a federated record under enforcement', async () => {
    process.env.ENFORCE_TWO_FACTOR_AUTHENTICATION = 'true';
    const req = {
      user: { _id: 'user-4', provider: 'openid', email: 'federated@example.com' },
    };
    const res = createResponse();

    await loginController(req, res);

    expect(res.status).toHaveBeenCalledWith(403);
    /** The code carries the reason: a bare 403 is rendered as a ban by getLoginError. */
    expect(res.json).toHaveBeenCalledWith({
      code: 'TWO_FACTOR_FEDERATED_LOGIN_BLOCKED',
      message: 'Sign in with your identity provider to continue.',
    });
    expect(mockSetAuthTokens).not.toHaveBeenCalled();
    expect(res.send).not.toHaveBeenCalled();
  });

  it('refuses a federated password login even when LibreChat 2FA is already enabled', async () => {
    process.env.ENFORCE_TWO_FACTOR_AUTHENTICATION = 'true';
    const req = { user: { _id: 'user-5', provider: 'openid', twoFactorEnabled: true } };
    const res = createResponse();

    await loginController(req, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({
      code: 'TWO_FACTOR_FEDERATED_LOGIN_BLOCKED',
      message: 'Sign in with your identity provider to continue.',
    });
    expect(mockGenerate2FATempToken).not.toHaveBeenCalled();
    expect(mockSetAuthTokens).not.toHaveBeenCalled();
  });

  it('leaves federated password logins alone when enforcement is disabled', async () => {
    process.env.ENFORCE_TWO_FACTOR_AUTHENTICATION = 'false';
    const req = {
      user: { _id: 'user-6', provider: 'openid', email: 'federated@example.com' },
    };
    const res = createResponse();

    await loginController(req, res);

    expect(mockSetAuthTokens).toHaveBeenCalledWith('user-6', res, null, req);
  });

  /**
   * The strategy compared the password against a document read before hashing it, so recovery
   * landing before the response revokes the credential this request is still holding. Everything
   * minted here is stamped after that reset, which is precisely what `isTokenRetired` cannot catch,
   * so the reset lands during the mint in each of these and the login has to lose the race.
   */
  describe('a password reset landing mid-login', () => {
    const resetDuring = (mock, value) =>
      mock.mockImplementationOnce(() => {
        record.credentialsChangedAt = new Date('2026-01-01T00:00:00.000Z');
        return value;
      });

    it('refuses the session it had already minted', async () => {
      process.env.ENFORCE_TWO_FACTOR_AUTHENTICATION = 'false';
      resetDuring(mockSetAuthTokens, Promise.resolve('auth-token'));
      const req = { user: { _id: 'user-7', email: 'user@example.com' } };
      const res = createResponse();

      await loginController(req, res);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({ message: 'Invalid credentials' });
      expect(res.send).not.toHaveBeenCalled();
      expect(mockDeleteAllUserSessions).toHaveBeenCalledWith({ userId: 'user-7' });
      expect(res.clearCookie).toHaveBeenCalledWith('refreshToken');
      expect(res.clearCookie).toHaveBeenCalledWith('token_provider');
    });

    it('withdraws the session it had already minted when the recheck cannot complete', async () => {
      process.env.ENFORCE_TWO_FACTOR_AUTHENTICATION = 'false';
      mockGetUserById.mockRejectedValueOnce(new Error('database unavailable'));
      const req = { user: { _id: 'user-9', email: 'user@example.com' } };
      const res = createResponse();

      await loginController(req, res);

      expect(mockSetAuthTokens).toHaveBeenCalledTimes(1);
      expect(mockDeleteAllUserSessions).toHaveBeenCalledWith({ userId: 'user-9' });
      expect(res.clearCookie).toHaveBeenCalledWith('refreshToken');
      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.send).not.toHaveBeenCalled();
    });

    /** Otherwise the holder of the revoked password picks the second factor the account keeps. */
    it('withholds the enrollment token it had already minted', async () => {
      process.env.ENFORCE_TWO_FACTOR_AUTHENTICATION = 'true';
      mockGetUserById.mockImplementationOnce(async () => {
        record.credentialsChangedAt = new Date('2026-01-01T00:00:00.000Z');
        return { credentialsChangedAt: record.credentialsChangedAt };
      });
      const req = { user: { _id: 'user-8', twoFactorEnabled: false } };
      const res = createResponse();

      await loginController(req, res);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({ message: 'Invalid credentials' });
      expect(res.json).not.toHaveBeenCalledWith(
        expect.objectContaining({ tempToken: expect.any(String) }),
      );
    });

    it('withholds the second-factor challenge it had already minted', async () => {
      resetDuring(mockGenerate2FATempToken, 'challenge-token');
      const req = { user: { _id: 'user-9', twoFactorEnabled: true } };
      const res = createResponse();

      await loginController(req, res);

      expect(mockGenerate2FATempToken).toHaveBeenCalledWith('user-9');
      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({ message: 'Invalid credentials' });
      expect(res.json).not.toHaveBeenCalledWith(
        expect.objectContaining({ tempToken: 'challenge-token' }),
      );
    });

    it('reads the stamp again only after the credential exists', async () => {
      process.env.ENFORCE_TWO_FACTOR_AUTHENTICATION = 'false';
      const order = [];
      mockSetAuthTokens.mockImplementationOnce(async () => {
        order.push('mint');
        return 'auth-token';
      });
      mockGetUserById.mockImplementationOnce(async () => {
        order.push('recheck');
        return { credentialsChangedAt: record.credentialsChangedAt };
      });
      const res = createResponse();

      await loginController({ user: { _id: 'user-10', email: 'user@example.com' } }, res);

      expect(order).toEqual(['mint', 'recheck']);
      expect(mockGetUserById).toHaveBeenCalledWith(
        'user-10',
        'twoFactorEnrolledAt credentialsChangedAt',
      );
    });
  });

  /** A stamp the authenticating read already saw is not a reset, and must not refuse the login. */
  it('signs in an account whose password reset predates the login', async () => {
    process.env.ENFORCE_TWO_FACTOR_AUTHENTICATION = 'false';
    record.credentialsChangedAt = new Date('2026-01-01T00:00:00.000Z');
    const req = {
      user: {
        _id: 'user-11',
        email: 'user@example.com',
        credentialsChangedAt: new Date('2026-01-01T00:00:00.000Z'),
      },
    };
    const res = createResponse();

    await loginController(req, res);

    expect(res.send).toHaveBeenCalledWith({
      token: 'auth-token',
      user: expect.objectContaining({ id: 'user-11' }),
    });
    expect(mockDeleteAllUserSessions).not.toHaveBeenCalled();
  });
});
