jest.mock(
  '@librechat/data-schemas',
  () => ({
    logger: { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() },
    runAsSystem: (callback) => callback(),
    getTenantId: jest.fn(() => undefined),
    DEFAULT_SESSION_EXPIRY: 900000,
    DEFAULT_REFRESH_TOKEN_EXPIRY: 604800000,
  }),
  { virtual: true },
);
jest.mock(
  'librechat-data-provider',
  () => ({
    ErrorTypes: {},
    SystemRoles: { USER: 'USER', ADMIN: 'ADMIN' },
    errorsToString: jest.fn(),
  }),
  { virtual: true },
);
jest.mock(
  '@librechat/api',
  () => {
    const shouldUseSecureCookie = jest.fn(() => false);
    return {
      isEnabled: jest.fn((val) => val === 'true' || val === true),
      checkEmailConfig: jest.fn(),
      isEmailDomainAllowed: jest.fn(),
      math: jest.fn((val, fallback) => (val ? Number(val) : fallback)),
      storeOpenIdSession: jest.fn(),
      shouldUseSecureCookie,
      setRefreshTokenCookie: jest.fn((res, refreshToken, expires) => {
        res.cookie('refreshToken', refreshToken, {
          expires,
          httpOnly: true,
          secure: shouldUseSecureCookie(),
          sameSite: 'strict',
        });
      }),
      setOpenIDMarkerCookies: jest.fn((res, { userId, expires }) => {
        res.cookie('token_provider', 'openid', {
          expires,
          httpOnly: true,
          secure: shouldUseSecureCookie(),
          sameSite: 'strict',
        });
        if (userId) {
          res.cookie('openid_user_id', `signed:${userId}`, {
            expires,
            httpOnly: true,
            secure: shouldUseSecureCookie(),
            sameSite: 'strict',
          });
        }
      }),
      normalizeExpiresIn: (value) => {
        const normalized = typeof value === 'string' && value.trim() ? Number(value) : value;
        return typeof normalized === 'number' && Number.isFinite(normalized)
          ? normalized
          : undefined;
      },
      resolveAppConfigForUser: jest.fn(async (_getAppConfig, _user) => ({})),
      createOpenIDSessionIdentity: jest.fn(
        ({ user, userId, openidSubject, tenantId, openidIssuer }) => {
          const normalize = (value) => {
            if (value == null) {
              return undefined;
            }
            const normalized = typeof value === 'string' ? value.trim() : value.toString().trim();
            return normalized || undefined;
          };
          const normalizeIssuer = (value) =>
            normalize(value)
              ?.replace(/\/\.well-known\/openid-configuration$/, '')
              .replace(/\/+$/, '');
          return {
            appUserId: normalize(userId) ?? normalize(user?._id) ?? normalize(user?.id),
            openidSubject: normalize(openidSubject) ?? normalize(user?.openidId),
            tenantId: normalize(tenantId) ?? normalize(user?.tenantId),
            openidIssuer: normalizeIssuer(openidIssuer) ?? normalizeIssuer(user?.openidIssuer),
          };
        },
      ),
      setCloudFrontCookies: jest.fn(() => true),
      clearCloudFrontCookies: jest.fn(),
      getCloudFrontConfig: jest.fn(() => ({
        domain: 'https://cdn.example.com',
        imageSigning: 'cookies',
        cookieDomain: '.example.com',
        privateKey: 'test-private-key',
        keyPairId: 'K123ABC',
      })),
      parseCloudFrontCookieScope: jest.fn(() => null),
      CLOUDFRONT_SCOPE_COOKIE: 'LibreChat-CloudFront-Scope',
    };
  },
  { virtual: true },
);
jest.mock('~/models', () => ({
  findUser: jest.fn(),
  findToken: jest.fn(),
  createUser: jest.fn(),
  updateUser: jest.fn(),
  countUsers: jest.fn(),
  getUserById: jest.fn(),
  findSession: jest.fn(),
  createToken: jest.fn(),
  deleteTokens: jest.fn(),
  deleteSession: jest.fn(),
  createSession: jest.fn(),
  upsertSession: jest.fn(),
  generateToken: jest.fn(),
  deleteUserById: jest.fn(),
  generateRefreshToken: jest.fn(),
}));
jest.mock('~/strategies/validators', () => ({
  registerSchema: {
    safeParse: jest.fn((user) => ({
      success: true,
      data: {
        name: user.name,
        username: user.username,
        email: user.email,
        password: user.password,
        confirm_password: user.confirm_password,
      },
    })),
  },
}));
jest.mock('~/server/services/Config', () => ({ getAppConfig: jest.fn() }));
jest.mock('~/server/utils', () => ({ sendEmail: jest.fn() }));

let checkEmailConfig;
let isEmailDomainAllowed;
let resolveAppConfigForUser;
let setRefreshTokenCookie;
let setOpenIDMarkerCookies;
let setCloudFrontCookies;
let getCloudFrontConfig;
let parseCloudFrontCookieScope;
let storeOpenIdSession;
let jwt;
let logger;
let getTenantId;
let findUser;
let findToken;
let createUser;
let updateUser;
let countUsers;
let getUserById;
let generateToken;
let generateRefreshToken;
let createSession;
let upsertSession;
let deleteSession;
let createToken;
let deleteTokens;
let getAppConfig;
let sendEmail;
let bcrypt;
let setOpenIDAuthTokens;
let storeOpenIDSession;
let requestPasswordReset;
let registerUser;
let resetPassword;
let resendVerificationEmail;
let setAuthTokens;
let setCloudFrontAuthCookies;
let verifyEmail;

jest.isolateModules(() => {
  ({
    checkEmailConfig,
    isEmailDomainAllowed,
    resolveAppConfigForUser,
    setRefreshTokenCookie,
    setOpenIDMarkerCookies,
    setCloudFrontCookies,
    getCloudFrontConfig,
    parseCloudFrontCookieScope,
    storeOpenIdSession,
  } = require('@librechat/api'));
  jwt = require('jsonwebtoken');
  ({ logger, getTenantId } = require('@librechat/data-schemas'));
  ({
    findUser,
    findToken,
    createUser,
    updateUser,
    countUsers,
    getUserById,
    generateToken,
    generateRefreshToken,
    createSession,
    upsertSession,
    deleteSession,
    createToken,
    deleteTokens,
  } = require('~/models'));
  ({ getAppConfig } = require('~/server/services/Config'));
  ({ sendEmail } = require('~/server/utils'));
  bcrypt = require('bcryptjs');
  ({
    setOpenIDAuthTokens,
    storeOpenIDSession,
    requestPasswordReset,
    registerUser,
    resetPassword,
    resendVerificationEmail,
    setAuthTokens,
    setCloudFrontAuthCookies,
    verifyEmail,
  } = require('./AuthService'));
});

/** Helper to build a mock Express response */
function mockResponse() {
  const cookies = {};
  const res = {
    cookie: jest.fn((name, value, options) => {
      cookies[name] = { value, options };
    }),
    _cookies: cookies,
  };
  return res;
}

/** Helper to build a mock Express request with session */
function mockRequest(sessionData = {}, cookies = {}) {
  return {
    session: { openidTokens: null, ...sessionData },
    cookies,
  };
}

describe('setOpenIDAuthTokens', () => {
  const env = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = {
      ...env,
      JWT_REFRESH_SECRET: 'test-refresh-secret',
      OPENID_REUSE_TOKENS: 'true',
    };
  });

  afterAll(() => {
    process.env = env;
  });

  describe('token selection (id_token vs access_token)', () => {
    it('should return id_token when both id_token and access_token are present', () => {
      const tokenset = {
        id_token: 'the-id-token',
        access_token: 'the-access-token',
        refresh_token: 'the-refresh-token',
      };
      const req = mockRequest();
      const res = mockResponse();

      const result = setOpenIDAuthTokens(tokenset, req, res, 'user-123');
      expect(result).toBe('the-id-token');
    });

    it('should return access_token when id_token is not available', () => {
      const tokenset = {
        access_token: 'the-access-token',
        refresh_token: 'the-refresh-token',
      };
      const req = mockRequest();
      const res = mockResponse();

      const result = setOpenIDAuthTokens(tokenset, req, res, 'user-123');
      expect(result).toBe('the-access-token');
    });

    it('should return access_token when id_token is undefined', () => {
      const tokenset = {
        id_token: undefined,
        access_token: 'the-access-token',
        refresh_token: 'the-refresh-token',
      };
      const req = mockRequest();
      const res = mockResponse();

      const result = setOpenIDAuthTokens(tokenset, req, res, 'user-123');
      expect(result).toBe('the-access-token');
    });

    it('should return access_token when id_token is null', () => {
      const tokenset = {
        id_token: null,
        access_token: 'the-access-token',
        refresh_token: 'the-refresh-token',
      };
      const req = mockRequest();
      const res = mockResponse();

      const result = setOpenIDAuthTokens(tokenset, req, res, 'user-123');
      expect(result).toBe('the-access-token');
    });

    it('should return id_token even when id_token and access_token differ', () => {
      const tokenset = {
        id_token: 'id-token-jwt-signed-by-idp',
        access_token: 'opaque-graph-api-token',
        refresh_token: 'refresh-token',
      };
      const req = mockRequest();
      const res = mockResponse();

      const result = setOpenIDAuthTokens(tokenset, req, res, 'user-123');
      expect(result).toBe('id-token-jwt-signed-by-idp');
      expect(result).not.toBe('opaque-graph-api-token');
    });
  });

  describe('session token storage', () => {
    it('should store the original access_token in session (not id_token)', () => {
      const tokenset = {
        id_token: 'the-id-token',
        access_token: 'the-access-token',
        refresh_token: 'the-refresh-token',
      };
      const req = mockRequest();
      const res = mockResponse();

      setOpenIDAuthTokens(tokenset, req, res, 'user-123');

      expect(req.session.openidTokens.accessToken).toBe('the-access-token');
      expect(req.session.openidTokens.idToken).toBe('the-id-token');
      expect(req.session.openidTokens.refreshToken).toBe('the-refresh-token');
      expect(req.session.openidTokens.browserRefreshToken).toBe('the-refresh-token');
      expect(req.session.openidTokens.lastRefreshedAt).toEqual(expect.any(Number));
    });

    it('should bind session tokens to the OpenID user identity', () => {
      const tokenset = {
        id_token: 'the-id-token',
        access_token: 'the-access-token',
        refresh_token: 'the-refresh-token',
      };
      const req = mockRequest();
      const res = mockResponse();

      setOpenIDAuthTokens(tokenset, req, res, {
        userId: 'user-123',
        openidSubject: 'oidc-sub-123',
        tenantId: 'tenantA',
        openidIssuer: 'https://issuer.example.com/.well-known/openid-configuration',
      });

      expect(req.session.openidTokens).toEqual(
        expect.objectContaining({
          appUserId: 'user-123',
          openidSubject: 'oidc-sub-123',
          tenantId: 'tenantA',
          openidIssuer: 'https://issuer.example.com',
        }),
      );
    });

    /**
     * Codex Finding 5: persist the access-token's expiry (unix seconds) so the
     * first OBO call after login or SPA refresh can reuse a still-valid OPAQUE
     * access token without burning a redundant inline refresh. The expiry comes
     * from the IdP's `tokenset.expires_in`; downstream consumers (notably
     * `OpenIDSessionRefresh.getAccessTokenExp`) read it as a fallback when the
     * access token isn't a JWT and can't be decoded.
     */
    it('should persist accessTokenExpiresAt when tokenset.expires_in is provided', () => {
      const tokenset = {
        id_token: 'the-id-token',
        access_token: 'the-access-token',
        refresh_token: 'the-refresh-token',
        expires_in: 3600,
      };
      const req = mockRequest();
      const res = mockResponse();
      const beforeSec = Math.floor(Date.now() / 1000);

      setOpenIDAuthTokens(tokenset, req, res, 'user-123');

      const persisted = req.session.openidTokens.accessTokenExpiresAt;
      expect(typeof persisted).toBe('number');
      expect(persisted).toBeGreaterThanOrEqual(beforeSec + 3590);
      expect(persisted).toBeLessThanOrEqual(beforeSec + 3610);
    });

    it('should persist accessTokenExpiresAt when tokenset.expires_in is a numeric string', () => {
      const tokenset = {
        id_token: 'the-id-token',
        access_token: 'the-access-token',
        refresh_token: 'the-refresh-token',
        expires_in: '3600',
      };
      const req = mockRequest();
      const res = mockResponse();
      const beforeSec = Math.floor(Date.now() / 1000);

      setOpenIDAuthTokens(tokenset, req, res, 'user-123');

      expect(req.session.openidTokens.accessTokenExpiresAt).toBeGreaterThanOrEqual(
        beforeSec + 3590,
      );
    });

    it('should NOT persist accessTokenExpiresAt when tokenset.expires_in is missing', () => {
      const tokenset = {
        id_token: 'the-id-token',
        access_token: 'the-access-token',
        refresh_token: 'the-refresh-token',
        // expires_in deliberately omitted
      };
      const req = mockRequest();
      const res = mockResponse();

      setOpenIDAuthTokens(tokenset, req, res, 'user-123');

      expect(req.session.openidTokens).not.toHaveProperty('accessTokenExpiresAt');
    });

    it('should return the existing unexpired session id_token when refresh omits one', () => {
      const existingIdToken = jwt.sign(
        { sub: 'user-123', exp: Math.floor(Date.now() / 1000) + 3600 },
        'idp-signing-secret',
      );
      const tokenset = {
        access_token: 'new-access-token',
        refresh_token: 'new-refresh-token',
      };
      const req = mockRequest({
        openidTokens: {
          accessToken: 'old-access-token',
          idToken: existingIdToken,
          refreshToken: 'old-refresh-token',
        },
      });
      const res = mockResponse();

      const result = setOpenIDAuthTokens(tokenset, req, res, 'user-123');

      expect(result).toBe(existingIdToken);
      expect(req.session.openidTokens.accessToken).toBe('new-access-token');
      expect(req.session.openidTokens.idToken).toBe(existingIdToken);
      expect(req.session.openidTokens.refreshToken).toBe('new-refresh-token');
      expect(req.session.openidTokens.lastRefreshedAt).toEqual(expect.any(Number));
    });

    it('should fall back to access_token when the existing session id_token is expired', () => {
      const expiredIdToken = jwt.sign(
        { sub: 'user-123', exp: Math.floor(Date.now() / 1000) - 60 },
        'idp-signing-secret',
      );
      const tokenset = {
        access_token: 'new-access-token',
        refresh_token: 'new-refresh-token',
      };
      const req = mockRequest({
        openidTokens: {
          accessToken: 'old-access-token',
          idToken: expiredIdToken,
          refreshToken: 'old-refresh-token',
        },
      });
      const res = mockResponse();

      const result = setOpenIDAuthTokens(tokenset, req, res, 'user-123');

      expect(result).toBe('new-access-token');
      expect(req.session.openidTokens.idToken).toBe(expiredIdToken);
      expect(req.session.openidTokens.accessToken).toBe('new-access-token');
    });

    it('falls back to access_token when the refresh carried an expired id_token forward', () => {
      const expiredIdToken = jwt.sign(
        { sub: 'user-123', exp: Math.floor(Date.now() / 1000) - 60 },
        'idp-signing-secret',
      );
      const tokenset = {
        id_token: expiredIdToken,
        access_token: 'new-access-token',
        refresh_token: 'new-refresh-token',
      };
      const req = mockRequest({
        openidTokens: {
          accessToken: 'old-access-token',
          idToken: expiredIdToken,
          refreshToken: 'old-refresh-token',
        },
      });
      const res = mockResponse();

      const result = setOpenIDAuthTokens(tokenset, req, res, 'user-123');

      expect(result).toBe('new-access-token');
      expect(req.session.openidTokens.idToken).toBe(expiredIdToken);
    });

    it('still prefers an id_token whose expiry cannot be read', () => {
      const tokenset = {
        id_token: 'opaque-but-not-a-jwt',
        access_token: 'new-access-token',
        refresh_token: 'new-refresh-token',
      };
      const req = mockRequest();
      const res = mockResponse();

      expect(setOpenIDAuthTokens(tokenset, req, res, 'user-123')).toBe('opaque-but-not-a-jwt');
    });

    it('should fall back to access_token when the existing session id_token is near expiry', () => {
      const nearExpiryIdToken = jwt.sign(
        { sub: 'user-123', exp: Math.floor(Date.now() / 1000) + 10 },
        'idp-signing-secret',
      );
      const tokenset = {
        access_token: 'new-access-token',
        refresh_token: 'new-refresh-token',
      };
      const req = mockRequest({
        openidTokens: {
          accessToken: 'old-access-token',
          idToken: nearExpiryIdToken,
          refreshToken: 'old-refresh-token',
        },
      });
      const res = mockResponse();

      const result = setOpenIDAuthTokens(tokenset, req, res, 'user-123');

      expect(result).toBe('new-access-token');
      expect(req.session.openidTokens.idToken).toBe(nearExpiryIdToken);
      expect(req.session.openidTokens.accessToken).toBe('new-access-token');
    });
  });

  it('stores an OpenID refresh token for durable revocation checks', async () => {
    storeOpenIdSession.mockResolvedValue(true);

    await storeOpenIDSession('user-123', 'the-refresh-token', 'tenant-a');

    expect(storeOpenIdSession).toHaveBeenCalledWith(
      {
        userId: 'user-123',
        refreshToken: 'the-refresh-token',
        tenantId: 'tenant-a',
        previousRefreshToken: undefined,
      },
      { upsertSession, deleteSession },
    );
  });

  it('revokes the previous durable session when the IdP rotates the refresh token', async () => {
    storeOpenIdSession.mockResolvedValue(true);

    await storeOpenIDSession('user-123', 'new-refresh-token', 'tenant-a', 'old-refresh-token');

    expect(storeOpenIdSession).toHaveBeenCalledWith(
      {
        userId: 'user-123',
        refreshToken: 'new-refresh-token',
        tenantId: 'tenant-a',
        previousRefreshToken: 'old-refresh-token',
      },
      { upsertSession, deleteSession },
    );
  });

  describe('OpenID cookie delegation', () => {
    it('delegates session-path refresh and marker cookies to shared cookie helpers', () => {
      const tokenset = {
        id_token: 'the-id-token',
        access_token: 'the-access-token',
        refresh_token: 'the-refresh-token',
      };
      const req = mockRequest();
      const res = mockResponse();

      setOpenIDAuthTokens(tokenset, req, res, 'user-123');

      expect(setRefreshTokenCookie).toHaveBeenCalledWith(
        res,
        'the-refresh-token',
        expect.any(Date),
      );
      expect(setOpenIDMarkerCookies).toHaveBeenCalledWith(res, {
        userId: 'user-123',
        expires: expect.any(Date),
        refreshExpiryMs: 604800000,
        refreshToken: 'the-refresh-token',
      });
      expect(res.cookie).not.toHaveBeenCalledWith(
        'openid_access_token',
        expect.any(String),
        expect.any(Object),
      );
      expect(res.cookie).not.toHaveBeenCalledWith(
        'openid_id_token',
        expect.any(String),
        expect.any(Object),
      );
    });

    it('uses cookie fallback for OpenID access tokens when no session is available', () => {
      const tokenset = {
        id_token: 'the-id-token',
        access_token: 'the-access-token',
        refresh_token: 'the-refresh-token',
      };
      const req = { session: null };
      const res = mockResponse();

      setOpenIDAuthTokens(tokenset, req, res, 'user-123');

      expect(setRefreshTokenCookie).toHaveBeenCalledWith(
        res,
        'the-refresh-token',
        expect.any(Date),
      );
      expect(setOpenIDMarkerCookies).toHaveBeenCalledWith(res, {
        userId: 'user-123',
        expires: expect.any(Date),
        refreshExpiryMs: 604800000,
        refreshToken: 'the-refresh-token',
      });
      expect(res.cookie).toHaveBeenCalledWith(
        'openid_access_token',
        'the-access-token',
        expect.objectContaining({
          expires: expect.any(Date),
          httpOnly: true,
          sameSite: 'strict',
        }),
      );
      expect(res.cookie).toHaveBeenCalledWith(
        'openid_id_token',
        'the-id-token',
        expect.objectContaining({
          expires: expect.any(Date),
          httpOnly: true,
          sameSite: 'strict',
        }),
      );
    });
  });

  describe('edge cases', () => {
    it('should return undefined when tokenset is null', () => {
      const req = mockRequest();
      const res = mockResponse();
      const result = setOpenIDAuthTokens(null, req, res, 'user-123');
      expect(result).toBeUndefined();
    });

    it('should return undefined when access_token is missing', () => {
      const tokenset = { refresh_token: 'refresh' };
      const req = mockRequest();
      const res = mockResponse();
      const result = setOpenIDAuthTokens(tokenset, req, res, 'user-123');
      expect(result).toBeUndefined();
    });

    it('should return undefined when no refresh token is available', () => {
      const tokenset = { access_token: 'access', id_token: 'id' };
      const req = mockRequest();
      const res = mockResponse();
      const result = setOpenIDAuthTokens(tokenset, req, res, 'user-123');
      expect(result).toBeUndefined();
    });

    it('should use existingRefreshToken when tokenset has no refresh_token', () => {
      const tokenset = {
        id_token: 'the-id-token',
        access_token: 'the-access-token',
      };
      const req = mockRequest();
      const res = mockResponse();

      const result = setOpenIDAuthTokens(tokenset, req, res, 'user-123', 'existing-refresh');
      expect(result).toBe('the-id-token');
      expect(req.session.openidTokens.refreshToken).toBe('existing-refresh');
    });
  });
});

describe('registerUser', () => {
  const registrationPayload = {
    name: 'Test User',
    username: 'testuser',
    email: 'test@example.com',
    password: 'Password123!',
    confirm_password: 'Password123!',
  };

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.ALLOW_UNVERIFIED_EMAIL_LOGIN = 'false';
    checkEmailConfig.mockReturnValue(false);
    isEmailDomainAllowed.mockReturnValue(true);
    getAppConfig.mockResolvedValue({
      balance: { enabled: false },
      registration: { allowedDomains: [] },
    });
    findUser.mockResolvedValue(null);
    countUsers.mockResolvedValue(1);
    createUser.mockResolvedValue({ _id: 'new-user-id' });
    updateUser.mockResolvedValue({ _id: 'new-user-id' });
  });

  it('ignores provider values from the public registration payload', async () => {
    const result = await registerUser({ ...registrationPayload, provider: 'google' });

    expect(result.status).toBe(200);
    expect(createUser.mock.calls[0][0]).toEqual(
      expect.objectContaining({
        email: registrationPayload.email,
        provider: 'local',
      }),
    );
  });

  it('allows trusted callers to set provider through additional data', async () => {
    const result = await registerUser(registrationPayload, {
      emailVerified: true,
      provider: 'google',
    });

    expect(result.status).toBe(200);
    expect(createUser.mock.calls[0][0]).toEqual(
      expect.objectContaining({
        email: registrationPayload.email,
        emailVerified: true,
        provider: 'google',
      }),
    );
  });

  it('normalizes mixed-case emails when issuing the verification token and link', async () => {
    checkEmailConfig.mockReturnValue(true);

    const result = await registerUser({
      ...registrationPayload,
      email: 'Mixed.Case@Example.com',
    });

    expect(result.status).toBe(200);
    expect(createToken).toHaveBeenCalledWith(
      expect.objectContaining({
        email: 'mixed.case@example.com',
        type: 'email_verification',
      }),
    );
    expect(sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        email: 'mixed.case@example.com',
        payload: expect.objectContaining({
          verificationLink: expect.stringContaining(encodeURIComponent('mixed.case@example.com')),
        }),
      }),
    );
  });
});

describe('verifyEmail public response handling', () => {
  const email = 'user@example.com';
  const encodedEmail = encodeURIComponent(email);
  const invalidEmailVerificationMessage = 'Invalid or expired email verification token';

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('does not reveal that an account is already verified without a valid token', async () => {
    findUser.mockResolvedValue({ _id: 'user-id', email, emailVerified: true });
    findToken.mockResolvedValue(null);

    const result = await verifyEmail({ body: { email: encodedEmail, token: 'not-the-token' } });

    expect(result).toBeInstanceOf(Error);
    expect(result.message).toBe(invalidEmailVerificationMessage);
    expect(updateUser).not.toHaveBeenCalled();
    expect(deleteTokens).not.toHaveBeenCalled();
  });

  it('returns the same generic error for missing users and invalid tokens', async () => {
    findUser.mockResolvedValueOnce(null);

    const missingUserResult = await verifyEmail({
      body: { email: encodedEmail, token: 'not-the-token' },
    });

    findUser.mockResolvedValueOnce({ _id: 'user-id', email, emailVerified: false });
    findToken.mockResolvedValueOnce({
      userId: 'user-id',
      email,
      token: bcrypt.hashSync('real-token', 10),
    });

    const invalidTokenResult = await verifyEmail({
      body: { email: encodedEmail, token: 'not-the-token' },
    });

    expect(missingUserResult).toBeInstanceOf(Error);
    expect(invalidTokenResult).toBeInstanceOf(Error);
    expect(missingUserResult.message).toBe(invalidEmailVerificationMessage);
    expect(invalidTokenResult.message).toBe(invalidEmailVerificationMessage);
  });

  it('verifies an unverified account when the token is valid', async () => {
    const hashedToken = bcrypt.hashSync('real-token', 10);
    findUser.mockResolvedValue({ _id: 'user-id', email, emailVerified: false });
    findToken.mockResolvedValue({ userId: 'user-id', email, token: hashedToken });
    updateUser.mockResolvedValue({ _id: 'user-id', emailVerified: true });

    const result = await verifyEmail({ body: { email: encodedEmail, token: 'real-token' } });

    expect(result).toEqual({
      message: 'Email verification was successful',
      status: 'success',
    });
    expect(updateUser).toHaveBeenCalledWith('user-id', { emailVerified: true });
    expect(deleteTokens).toHaveBeenCalledWith({
      token: hashedToken,
      userId: 'user-id',
      email,
      identifier: null,
      type: null,
    });
  });

  it('returns the generic error when a valid verification update fails', async () => {
    const hashedToken = bcrypt.hashSync('real-token', 10);
    findUser.mockResolvedValue({ _id: 'user-id', email, emailVerified: false });
    findToken.mockResolvedValue({ userId: 'user-id', email, token: hashedToken });
    updateUser.mockResolvedValue(null);

    const result = await verifyEmail({ body: { email: encodedEmail, token: 'real-token' } });

    expect(result).toBeInstanceOf(Error);
    expect(result.message).toBe(invalidEmailVerificationMessage);
    expect(deleteTokens).not.toHaveBeenCalled();
  });

  it('allows idempotent success only when an already verified account presents a valid token', async () => {
    const hashedToken = bcrypt.hashSync('real-token', 10);
    findUser.mockResolvedValue({ _id: 'user-id', email, emailVerified: true });
    findToken.mockResolvedValue({ userId: 'user-id', email, token: hashedToken });

    const result = await verifyEmail({ body: { email: encodedEmail, token: 'real-token' } });

    expect(result).toEqual({
      message: 'Email verification was successful',
      status: 'success',
    });
    expect(updateUser).not.toHaveBeenCalled();
    expect(deleteTokens).toHaveBeenCalledWith({
      token: hashedToken,
      userId: 'user-id',
      email,
      identifier: null,
      type: null,
    });
  });
});

describe('requestPasswordReset', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    isEmailDomainAllowed.mockReturnValue(true);
    getAppConfig.mockResolvedValue({
      registration: { allowedDomains: ['example.com'] },
    });
    resolveAppConfigForUser.mockResolvedValue({
      registration: { allowedDomains: ['example.com'] },
    });
  });

  it('should fast-fail with base config before DB lookup for blocked domains', async () => {
    isEmailDomainAllowed.mockReturnValue(false);

    const req = { body: { email: 'blocked@evil.com' }, ip: '127.0.0.1' };
    const result = await requestPasswordReset(req);

    expect(getAppConfig).toHaveBeenCalledWith({ baseOnly: true });
    expect(findUser).not.toHaveBeenCalled();
    expect(result).toBeInstanceOf(Error);
  });

  it('should call resolveAppConfigForUser for tenant user', async () => {
    const user = {
      _id: 'user-tenant',
      email: 'user@example.com',
      tenantId: 'tenant-x',
      role: 'USER',
    };
    findUser.mockResolvedValue(user);

    const req = { body: { email: 'user@example.com' }, ip: '127.0.0.1' };
    await requestPasswordReset(req);

    expect(resolveAppConfigForUser).toHaveBeenCalledWith(getAppConfig, user);
  });

  it('should reuse baseConfig for non-tenant user without calling resolveAppConfigForUser', async () => {
    findUser.mockResolvedValue({ _id: 'user-no-tenant', email: 'user@example.com' });

    const req = { body: { email: 'user@example.com' }, ip: '127.0.0.1' };
    await requestPasswordReset(req);

    expect(resolveAppConfigForUser).not.toHaveBeenCalled();
  });

  it('should return generic response when tenant config blocks the domain (non-enumerable)', async () => {
    const user = {
      _id: 'user-tenant',
      email: 'user@example.com',
      tenantId: 'tenant-x',
      role: 'USER',
    };
    findUser.mockResolvedValue(user);
    isEmailDomainAllowed.mockReturnValueOnce(true).mockReturnValueOnce(false);

    const req = { body: { email: 'user@example.com' }, ip: '127.0.0.1' };
    const result = await requestPasswordReset(req);

    expect(result).not.toBeInstanceOf(Error);
    expect(result.message).toContain('If an account with that email exists');
  });

  it('should only delete existing password reset tokens when issuing a new reset link', async () => {
    const user = { _id: 'user-reset', email: 'user@example.com' };
    findUser.mockResolvedValue(user);

    const req = { body: { email: 'user@example.com' }, ip: '127.0.0.1' };
    await requestPasswordReset(req);

    expect(deleteTokens).toHaveBeenCalledWith({
      userId: user._id,
      type: 'password_reset',
    });
    expect(deleteTokens).toHaveBeenCalledWith({
      userId: user._id,
      email: null,
      identifier: null,
      type: null,
    });
    expect(createToken).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: user._id,
        type: 'password_reset',
      }),
    );
  });
});

describe('resetPassword', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    checkEmailConfig.mockReturnValue(false);
  });

  it('should only accept password reset tokens for password reset', async () => {
    const verificationHash = bcrypt.hashSync('verification-token', 10);
    findToken.mockImplementation(async (query) => {
      if (query.type === 'password_reset') {
        return null;
      }
      if (query.type === null && query.email === null && query.identifier === null) {
        return null;
      }
      return { token: verificationHash, userId: 'user-reset', email: 'user@example.com' };
    });
    updateUser.mockResolvedValue({ email: 'user@example.com' });

    const result = await resetPassword('user-reset', 'verification-token', 'new-password');

    expect(result).toBeInstanceOf(Error);
    expect(findToken).toHaveBeenCalledWith(
      {
        userId: 'user-reset',
        type: 'password_reset',
      },
      { sort: { createdAt: -1 } },
    );
    expect(findToken).toHaveBeenCalledWith(
      {
        userId: 'user-reset',
        email: null,
        identifier: null,
        type: null,
      },
      { sort: { createdAt: -1 } },
    );
    expect(updateUser).not.toHaveBeenCalled();
    expect(deleteTokens).not.toHaveBeenCalled();
  });

  it('should delete only the used password reset token after a successful reset', async () => {
    const resetHash = bcrypt.hashSync('reset-token', 10);
    findToken.mockResolvedValue({
      token: resetHash,
      userId: 'user-reset',
      type: 'password_reset',
    });
    updateUser.mockResolvedValue({ email: 'user@example.com' });

    const result = await resetPassword('user-reset', 'reset-token', 'new-password');

    expect(result).toEqual({ message: 'Password reset was successful' });
    expect(findToken).toHaveBeenCalledWith(
      {
        userId: 'user-reset',
        type: 'password_reset',
      },
      { sort: { createdAt: -1 } },
    );
    expect(deleteTokens).toHaveBeenCalledWith({
      token: resetHash,
      type: 'password_reset',
    });
  });

  it('should accept legacy reset tokens without affecting verification-shaped tokens', async () => {
    const legacyResetHash = bcrypt.hashSync('legacy-reset-token', 10);
    findToken.mockImplementation(async (query) => {
      if (query.type === 'password_reset') {
        return null;
      }
      if (query.type === null && query.email === null && query.identifier === null) {
        return {
          token: legacyResetHash,
          userId: 'user-reset',
        };
      }
      return null;
    });
    updateUser.mockResolvedValue({ email: 'user@example.com' });

    const result = await resetPassword('user-reset', 'legacy-reset-token', 'new-password');

    expect(result).toEqual({ message: 'Password reset was successful' });
    expect(findToken).toHaveBeenCalledWith(
      {
        userId: 'user-reset',
        type: 'password_reset',
      },
      { sort: { createdAt: -1 } },
    );
    expect(findToken).toHaveBeenCalledWith(
      {
        userId: 'user-reset',
        email: null,
        identifier: null,
        type: null,
      },
      { sort: { createdAt: -1 } },
    );
    expect(deleteTokens).toHaveBeenCalledWith({
      token: legacyResetHash,
      email: null,
      identifier: null,
      type: null,
    });
  });
});

describe('verifyEmail', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should scope verification token lookup to the user and token category', async () => {
    const verificationHash = bcrypt.hashSync('verification-token', 10);
    const user = {
      _id: 'user-verify',
      email: 'user@example.com',
      emailVerified: false,
    };
    findUser.mockResolvedValue(user);
    findToken.mockImplementation(async (query) => {
      if (query.type === 'email_verification') {
        return {
          userId: user._id,
          email: user.email,
          token: verificationHash,
          type: 'email_verification',
        };
      }
      return null;
    });
    updateUser.mockResolvedValue({ ...user, emailVerified: true });

    const result = await verifyEmail({
      body: {
        email: encodeURIComponent(user.email),
        token: 'verification-token',
      },
    });

    expect(result).toEqual({
      message: 'Email verification was successful',
      status: 'success',
    });
    expect(findToken).toHaveBeenCalledWith(
      {
        userId: user._id,
        email: user.email,
        type: 'email_verification',
      },
      { sort: { createdAt: -1 } },
    );
    expect(deleteTokens).toHaveBeenCalledWith({
      token: verificationHash,
      type: 'email_verification',
    });
  });

  it('should fall back only to legacy verification tokens for the same user', async () => {
    const verificationHash = bcrypt.hashSync('legacy-verification-token', 10);
    const user = {
      _id: 'user-verify',
      email: 'user@example.com',
      emailVerified: false,
    };
    findUser.mockResolvedValue(user);
    findToken.mockImplementation(async (query) => {
      if (query.type === 'email_verification') {
        return null;
      }
      if (query.type === null && query.identifier === null && query.userId === user._id) {
        return {
          userId: user._id,
          email: user.email,
          token: verificationHash,
        };
      }
      return null;
    });
    updateUser.mockResolvedValue({ ...user, emailVerified: true });

    const result = await verifyEmail({
      body: {
        email: encodeURIComponent(user.email),
        token: 'legacy-verification-token',
      },
    });

    expect(result).toEqual({
      message: 'Email verification was successful',
      status: 'success',
    });
    expect(findToken).toHaveBeenCalledWith(
      {
        userId: user._id,
        email: user.email,
        identifier: null,
        type: null,
      },
      { sort: { createdAt: -1 } },
    );
    expect(deleteTokens).toHaveBeenCalledWith({
      token: verificationHash,
      userId: user._id,
      email: user.email,
      identifier: null,
      type: null,
    });
  });
});

describe('resendVerificationEmail', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should not delete tokens when no user exists for the email', async () => {
    findUser.mockResolvedValue(null);

    const result = await resendVerificationEmail({
      body: { email: 'missing@example.com' },
    });

    expect(result).toEqual({
      status: 200,
      message: 'Please check your email to verify your email address.',
    });
    expect(deleteTokens).not.toHaveBeenCalled();
    expect(sendEmail).not.toHaveBeenCalled();
    expect(createToken).not.toHaveBeenCalled();
  });

  it('should delete only verification tokens scoped to the resolved user', async () => {
    const user = {
      _id: 'user-verify',
      email: 'user@example.com',
      name: 'User Verify',
    };
    findUser.mockResolvedValue(user);

    const result = await resendVerificationEmail({
      body: { email: user.email },
    });

    expect(result).toEqual({
      status: 200,
      message: 'Please check your email to verify your email address.',
    });
    expect(deleteTokens).toHaveBeenCalledWith({
      userId: user._id,
      email: user.email,
      type: 'email_verification',
    });
    expect(deleteTokens).toHaveBeenCalledWith({
      userId: user._id,
      email: user.email,
      identifier: null,
      type: null,
    });
    expect(deleteTokens).not.toHaveBeenCalledWith({ email: user.email });
    expect(createToken).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: user._id,
        email: user.email,
        type: 'email_verification',
      }),
    );
  });

  it('returns the generic response when delivery fails', async () => {
    const user = {
      _id: 'user-delivery-failure',
      email: 'delivery-failure@example.com',
      name: 'Delivery Failure',
    };
    findUser.mockResolvedValue(user);
    sendEmail.mockRejectedValue(new Error('mail transport unavailable'));

    const result = await resendVerificationEmail({ body: { email: user.email } });

    expect(result).toEqual({
      status: 200,
      message: 'Please check your email to verify your email address.',
    });
    expect(logger.error).toHaveBeenCalledWith(
      '[resendVerificationEmail] Error resending verification email: mail transport unavailable',
    );
  });
});

describe('CloudFront cookie integration', () => {
  const cloudFrontCookieConfig = {
    domain: 'https://cdn.example.com',
    imageSigning: 'cookies',
    cookieDomain: '.example.com',
    privateKey: 'test-private-key',
    keyPairId: 'K123ABC',
  };

  beforeEach(() => {
    jest.clearAllMocks();
    getCloudFrontConfig.mockReturnValue(cloudFrontCookieConfig);
    setCloudFrontCookies.mockReturnValue(true);
    parseCloudFrontCookieScope.mockReturnValue(null);
  });

  describe('setCloudFrontAuthCookies', () => {
    it('passes user id and tenant scope from the user', () => {
      const req = mockRequest();
      const res = mockResponse();
      const user = {
        _id: { toString: () => 'user-123' },
        tenantId: { toString: () => 'tenantA' },
      };

      const result = setCloudFrontAuthCookies(req, res, user);

      expect(result).toBe(true);
      expect(setCloudFrontCookies).toHaveBeenCalledWith(
        res,
        {
          userId: 'user-123',
          tenantId: 'tenantA',
        },
        null,
      );
      expect(logger.debug).toHaveBeenCalledWith(
        '[setCloudFrontAuthCookies] CloudFront auth cookies refreshed',
        expect.objectContaining({
          attempted: true,
          set: true,
          has_user_id: true,
          has_tenant_scope: true,
        }),
      );
    });

    it('lets explicit scope options override user and request scope', () => {
      const req = mockRequest();
      req.user = { _id: 'request-user', tenantId: 'request-tenant' };
      const res = mockResponse();
      const user = { _id: 'user-123', tenantId: 'tenantA' };

      setCloudFrontAuthCookies(req, res, user, {
        userId: 'option-user',
        tenantId: 'option-tenant',
        storageRegion: 'us-east-2',
      });

      expect(setCloudFrontCookies).toHaveBeenCalledWith(
        res,
        {
          userId: 'option-user',
          tenantId: 'option-tenant',
          storageRegion: 'us-east-2',
        },
        null,
      );
    });

    it('falls back to request tenant scope when the user has none', () => {
      const req = mockRequest();
      req.user = { tenantId: 'request-tenant' };
      const res = mockResponse();

      setCloudFrontAuthCookies(req, res, { _id: 'user-123' });

      expect(setCloudFrontCookies).toHaveBeenCalledWith(
        res,
        {
          userId: 'user-123',
          tenantId: 'request-tenant',
        },
        null,
      );
    });

    it('uses org scope as tenant scope when tenantId is unavailable', () => {
      const req = mockRequest();
      const res = mockResponse();

      setCloudFrontAuthCookies(req, res, { _id: 'user-123', orgId: 'orgA' });

      expect(setCloudFrontCookies).toHaveBeenCalledWith(
        res,
        {
          userId: 'user-123',
          tenantId: 'orgA',
        },
        null,
      );
    });

    it('uses previous CloudFront scope for stale cookie cleanup', () => {
      parseCloudFrontCookieScope.mockReturnValue({ userId: 'old-user', tenantId: 'old-tenant' });
      const req = mockRequest({}, { 'LibreChat-CloudFront-Scope': 'encoded-scope' });
      const res = mockResponse();

      setCloudFrontAuthCookies(req, res, { _id: 'user-123', tenantId: 'tenantA' });

      expect(parseCloudFrontCookieScope).toHaveBeenCalledWith('encoded-scope');
      expect(setCloudFrontCookies).toHaveBeenCalledWith(
        res,
        {
          userId: 'user-123',
          tenantId: 'tenantA',
        },
        { userId: 'old-user', tenantId: 'old-tenant' },
      );
    });

    it('no-ops when CloudFront cookie signing is disabled', () => {
      getCloudFrontConfig.mockReturnValue({ ...cloudFrontCookieConfig, imageSigning: 'none' });
      const req = mockRequest();
      const res = mockResponse();

      const result = setCloudFrontAuthCookies(req, res, { _id: 'user-123' });

      expect(result).toBe(false);
      expect(setCloudFrontCookies).not.toHaveBeenCalled();
      expect(logger.debug).not.toHaveBeenCalledWith(
        '[setCloudFrontAuthCookies] CloudFront auth cookies skipped',
        expect.any(Object),
      );
    });

    it('fails closed when user id is missing', () => {
      const req = mockRequest();
      const res = mockResponse();

      const result = setCloudFrontAuthCookies(req, res, { tenantId: 'tenantA' });

      expect(result).toBe(false);
      expect(setCloudFrontCookies).not.toHaveBeenCalled();
      expect(logger.debug).toHaveBeenCalledWith(
        '[setCloudFrontAuthCookies] CloudFront auth cookies skipped',
        expect.objectContaining({
          attempted: false,
          set: false,
          reason: 'missing_user_id',
        }),
      );
    });

    it('skips when CloudFront cookie domain is missing', () => {
      getCloudFrontConfig.mockReturnValue({ ...cloudFrontCookieConfig, cookieDomain: null });
      const req = mockRequest();
      const res = mockResponse();

      const result = setCloudFrontAuthCookies(req, res, { _id: 'user-123' });

      expect(result).toBe(false);
      expect(setCloudFrontCookies).not.toHaveBeenCalled();
      expect(logger.debug).toHaveBeenCalledWith(
        '[setCloudFrontAuthCookies] CloudFront auth cookies skipped',
        expect.objectContaining({
          attempted: false,
          set: false,
          reason: 'missing_cookie_domain',
        }),
      );
    });

    it('does not log cookie secrets or signed-cookie values', () => {
      const req = mockRequest();
      const res = mockResponse();

      setCloudFrontAuthCookies(req, res, { _id: 'user-123' });

      const debugOutput = JSON.stringify(logger.debug.mock.calls);
      expect(debugOutput).not.toContain('test-private-key');
      expect(debugOutput).not.toContain('K123ABC');
      expect(debugOutput).not.toContain('CloudFront-Policy');
      expect(debugOutput).not.toContain('CloudFront-Signature');
      expect(debugOutput).not.toContain('CloudFront-Key-Pair-Id');
    });
  });

  describe('setOpenIDAuthTokens', () => {
    const validTokenset = {
      id_token: 'the-id-token',
      access_token: 'the-access-token',
      refresh_token: 'the-refresh-token',
    };

    it('calls setCloudFrontCookies with response object and user scope from options', () => {
      const req = mockRequest();
      const res = mockResponse();

      setOpenIDAuthTokens(validTokenset, req, res, {
        userId: 'user-123',
        tenantId: 'tenantA',
      });

      expect(setCloudFrontCookies).toHaveBeenCalledWith(
        res,
        {
          userId: 'user-123',
          tenantId: 'tenantA',
        },
        null,
      );
    });

    it('keeps backward compatibility with positional user and tenant params', () => {
      const req = mockRequest();
      const res = mockResponse();

      setOpenIDAuthTokens(validTokenset, req, res, 'user-123', undefined, 'tenantA');

      expect(setCloudFrontCookies).toHaveBeenCalledWith(
        res,
        {
          userId: 'user-123',
          tenantId: 'tenantA',
        },
        null,
      );
    });

    it('treats a null options argument as an empty legacy user id', () => {
      const req = mockRequest();
      const res = mockResponse();

      const result = setOpenIDAuthTokens(validTokenset, req, res, null);

      expect(result).toBe('the-id-token');
      expect(setCloudFrontCookies).not.toHaveBeenCalled();
      expect(logger.debug).toHaveBeenCalledWith(
        '[setCloudFrontAuthCookies] CloudFront auth cookies skipped',
        expect.objectContaining({
          attempted: false,
          set: false,
          reason: 'missing_user_id',
        }),
      );
    });

    it('treats omitted options as an empty legacy user id', () => {
      const req = mockRequest();
      const res = mockResponse();

      const result = setOpenIDAuthTokens(validTokenset, req, res);

      expect(result).toBe('the-id-token');
      expect(setCloudFrontCookies).not.toHaveBeenCalled();
      expect(logger.debug).toHaveBeenCalledWith(
        '[setCloudFrontAuthCookies] CloudFront auth cookies skipped',
        expect.objectContaining({
          attempted: false,
          set: false,
          reason: 'missing_user_id',
        }),
      );
    });

    it('treats an object without token option keys as empty options', () => {
      const req = mockRequest();
      const res = mockResponse();

      const result = setOpenIDAuthTokens(validTokenset, req, res, {});

      expect(result).toBe('the-id-token');
      expect(setCloudFrontCookies).not.toHaveBeenCalled();
      expect(logger.debug).toHaveBeenCalledWith(
        '[setCloudFrontAuthCookies] CloudFront auth cookies skipped',
        expect.objectContaining({
          attempted: false,
          set: false,
          reason: 'missing_user_id',
        }),
      );
    });

    it('succeeds even when setCloudFrontCookies returns false', () => {
      setCloudFrontCookies.mockReturnValue(false);

      const req = mockRequest();
      const res = mockResponse();

      const result = setOpenIDAuthTokens(validTokenset, req, res, 'user-123');

      expect(result).toBe('the-id-token');
    });
  });

  describe('setAuthTokens', () => {
    beforeEach(() => {
      getUserById.mockResolvedValue({ _id: 'user-123', tenantId: 'tenantA' });
      generateToken.mockResolvedValue('mock-access-token');
      generateRefreshToken.mockReturnValue('mock-refresh-token');
      createSession.mockResolvedValue({
        session: { expiration: new Date(Date.now() + 604800000) },
        refreshToken: 'mock-refresh-token',
      });
    });

    it('calls setCloudFrontCookies with response object and user scope', async () => {
      const res = mockResponse();

      await setAuthTokens('user-123', res);

      expect(setCloudFrontCookies).toHaveBeenCalledWith(
        res,
        {
          userId: 'user-123',
          tenantId: 'tenantA',
        },
        null,
      );
    });

    it('uses the fetched user id as the canonical CloudFront user scope', async () => {
      getUserById.mockResolvedValueOnce({
        _id: { toString: () => 'canonical-user' },
        tenantId: 'tenantA',
      });
      const res = mockResponse();

      await setAuthTokens('input-user-id', res);

      expect(setCloudFrontCookies).toHaveBeenCalledWith(
        res,
        {
          userId: 'canonical-user',
          tenantId: 'tenantA',
        },
        null,
      );
    });

    it('passes the previous CloudFront cookie scope when present', async () => {
      parseCloudFrontCookieScope.mockReturnValue({ userId: 'old-user', tenantId: 'old-tenant' });
      const res = mockResponse();
      const req = mockRequest({}, { 'LibreChat-CloudFront-Scope': 'encoded-scope' });

      await setAuthTokens('user-123', res, null, req);

      expect(parseCloudFrontCookieScope).toHaveBeenCalledWith('encoded-scope');
      expect(setCloudFrontCookies).toHaveBeenCalledWith(
        res,
        {
          userId: 'user-123',
          tenantId: 'tenantA',
        },
        { userId: 'old-user', tenantId: 'old-tenant' },
      );
    });

    it('succeeds even when setCloudFrontCookies returns false', async () => {
      setCloudFrontCookies.mockReturnValue(false);

      const res = mockResponse();

      const result = await setAuthTokens('user-123', res);

      expect(result).toBe('mock-access-token');
    });
  });
});

describe('registerUser - allowedDomains admin-panel override', () => {
  const validUser = {
    email: 'new-user@example.com',
    password: 'a-secure-password',
    name: 'New User',
    username: 'new-user',
  };

  beforeEach(() => {
    jest.clearAllMocks();
    getTenantId.mockReturnValue(undefined);
    isEmailDomainAllowed.mockReturnValue(true);
    getAppConfig.mockResolvedValue({
      registration: { allowedDomains: ['example.com'] },
      balance: undefined,
    });
    findUser.mockResolvedValue(null);
    countUsers.mockResolvedValue(0);
  });

  it('should resolve the full app config so admin-panel overrides on the __base__ principal apply', async () => {
    // Regression guard for getAppConfig({ baseOnly: true }): that option short-circuits
    // before the DB override merge, which silently ignores any admin-panel edits to
    // registration.allowedDomains (the admin panel writes overrides to the __base__
    // principal in the configs collection). registerUser must request the merged config
    // so the global __base__ override is honored, same as it is for SSO callbacks via
    // checkDomainAllowed.
    await registerUser(validUser);

    expect(getAppConfig).toHaveBeenCalledTimes(1);
    expect(getAppConfig).toHaveBeenCalledWith({});
    expect(getAppConfig).not.toHaveBeenCalledWith(expect.objectContaining({ baseOnly: true }));
  });

  it('should pass tenantId from ALS so the merged-config cache key matches tenant-scoped DB queries', async () => {
    // /api/auth runs through preAuthTenantMiddleware, which puts a tenantId into
    // AsyncLocalStorage. Mongoose queries inside getApplicableConfigs are scoped by ALS,
    // but the per-principal merged-config cache key uses the explicit tenantId param.
    // If we don't forward the ALS tenantId, tenant A's request caches at `__default__`
    // and a later tenant B request can hit that entry — leaking config across tenants.
    getTenantId.mockReturnValue('tenant-x');

    await registerUser(validUser);

    expect(getAppConfig).toHaveBeenCalledWith({ tenantId: 'tenant-x' });
  });

  it('does not bootstrap a tenant-scoped registrant as an administrator', async () => {
    getTenantId.mockReturnValue('attacker-selected-tenant');
    createUser.mockResolvedValue({ _id: 'new-user', emailVerified: true });
    checkEmailConfig.mockReturnValue(false);

    await registerUser(validUser);

    expect(countUsers).not.toHaveBeenCalled();
    expect(createUser).toHaveBeenCalledWith(
      expect.objectContaining({ role: 'USER' }),
      undefined,
      expect.any(Boolean),
      true,
    );
  });

  it('preserves first-user administrator bootstrap without a tenant context', async () => {
    createUser.mockResolvedValue({ _id: 'new-user', emailVerified: true });
    checkEmailConfig.mockReturnValue(false);

    await registerUser(validUser);

    expect(countUsers).toHaveBeenCalledTimes(1);
    expect(createUser).toHaveBeenCalledWith(
      expect.objectContaining({ role: 'ADMIN' }),
      undefined,
      expect.any(Boolean),
      true,
    );
  });

  it('should block registration when the resolved allowedDomains rejects the email', async () => {
    isEmailDomainAllowed.mockReturnValue(false);

    const result = await registerUser({ ...validUser, email: 'blocked@evil.com' });

    expect(result.status).toBe(403);
    expect(result.message).toMatch(/cannot be used/i);
    // Domain check must happen before any DB user lookup.
    expect(findUser).not.toHaveBeenCalled();
  });
});
