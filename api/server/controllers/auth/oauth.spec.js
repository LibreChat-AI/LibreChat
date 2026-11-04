const mockIsEnabled = jest.fn();
const mockGetAdminPanelUrl = jest.fn();
const mockIsAdminPanelRedirect = jest.fn();
const mockGenerateAdminExchangeCode = jest.fn();
const mockSyncUserEntraGroupMemberships = jest.fn();
const mockSetAuthTokens = jest.fn();
const mockSendOpenIDAuthResponse = jest.fn();
const mockGetLogStores = jest.fn();
const mockCheckBan = jest.fn();
const mockGenerateToken = jest.fn();
const mockResolveOpenIDLoginCompletion = jest.fn();
const mockGetLoginDeps = jest.fn();
const mockGetOpenIdClientId = jest.fn();
const mockRememberAdminOpenIDSessionRef = jest.fn();
const mockLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };

jest.mock('librechat-data-provider', () => ({
  CacheKeys: { ADMIN_OAUTH_EXCHANGE: 'admin-oauth-exchange' },
  DEFAULT_OPENID_AUTHORIZATION_TIMEOUT_MS: 3_000,
}));

jest.mock('@librechat/data-schemas', () => ({
  logger: mockLogger,
  DEFAULT_SESSION_EXPIRY: 60000,
}));

jest.mock('@librechat/api', () => ({
  isEnabled: (...args) => mockIsEnabled(...args),
  getAdminPanelUrl: (...args) => mockGetAdminPanelUrl(...args),
  isAdminPanelRedirect: (...args) => mockIsAdminPanelRedirect(...args),
  generateAdminExchangeCode: (...args) => mockGenerateAdminExchangeCode(...args),
  resolveOpenIDLoginCompletion: (...args) => mockResolveOpenIDLoginCompletion(...args),
}));

jest.mock('~/server/services/PermissionService', () => ({
  syncUserEntraGroupMemberships: (...args) => mockSyncUserEntraGroupMemberships(...args),
}));

jest.mock('~/server/services/AuthService', () => ({
  setAuthTokens: (...args) => mockSetAuthTokens(...args),
}));

jest.mock('~/server/services/OpenIDRefreshRecovery', () => ({
  sendOpenIDAuthResponse: (...args) => mockSendOpenIDAuthResponse(...args),
}));

jest.mock('~/server/services/OpenIDSessions', () => ({
  getLoginDeps: (...args) => mockGetLoginDeps(...args),
  getOpenIdClientId: (...args) => mockGetOpenIdClientId(...args),
  sessionAuthorizationRef: {},
}));

jest.mock('~/server/services/AdminOpenIDSessionRef', () => ({
  rememberAdminOpenIDSessionRef: (...args) => mockRememberAdminOpenIDSessionRef(...args),
}));

jest.mock(
  '~/cache/getLogStores',
  () =>
    (...args) =>
      mockGetLogStores(...args),
);

jest.mock('~/server/middleware', () => ({
  checkBan: (...args) => mockCheckBan(...args),
}));

jest.mock('~/models', () => ({
  generateToken: (...args) => mockGenerateToken(...args),
}));

// `oauth.js` captures `process.env.DOMAIN_CLIENT` into a module-level constant at require
// time, before `beforeEach` runs, so it must be set before this require.
process.env.DOMAIN_CLIENT = 'http://localhost:3080';

const { createOAuthHandler } = require('./oauth');
const openIdSessions = require('~/server/services/OpenIDSessions');
const { rememberAdminOpenIDSessionRef } = require('~/server/services/AdminOpenIDSessionRef');

const ORIGINAL_ENV = process.env;

function buildReq(overrides = {}) {
  return {
    user: {
      _id: 'user-123',
      email: 'admin@example.com',
      provider: 'openid',
      openidId: 'openid-subject-1',
      openidIssuer: 'https://idp.example.com',
      tenantId: 'tenant-1',
      tokenset: {
        refresh_token: 'openid-refresh-token',
        access_token: 'openid-access-token',
        claims: () => ({ sid: 'sid-1', iat: 1700000000 }),
      },
      federatedTokens: { refresh_token: 'federated-refresh-token' },
    },
    session: {},
    pkceChallenge: 'pkce-challenge',
    banned: false,
    ...overrides,
  };
}

function buildRes() {
  return {
    headersSent: false,
    redirect: jest.fn(),
  };
}

describe('createOAuthHandler', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    for (const key of Object.keys(openIdSessions.sessionAuthorizationRef)) {
      delete openIdSessions.sessionAuthorizationRef[key];
    }
    process.env = {
      ...ORIGINAL_ENV,
      DOMAIN_CLIENT: 'http://localhost:3080',
      DOMAIN_SERVER: 'http://localhost:3080',
      OPENID_REUSE_TOKENS: 'false',
    };
    mockIsEnabled.mockImplementation((value) => value === 'true' || value === true);
    mockGetAdminPanelUrl.mockReturnValue('http://admin.example.com');
    mockIsAdminPanelRedirect.mockReturnValue(true);
    mockGetLogStores.mockReturnValue({});
    mockCheckBan.mockResolvedValue(undefined);
    mockGenerateToken.mockResolvedValue('jwt-token');
    mockGenerateAdminExchangeCode.mockResolvedValue('exchange-code');
    mockSendOpenIDAuthResponse.mockResolvedValue('app-token');
    mockGetLoginDeps.mockReturnValue({});
    mockGetOpenIdClientId.mockReturnValue('client-id');
    mockResolveOpenIDLoginCompletion.mockResolvedValue({
      kind: 'continue',
      openidSessionId: 'session-login-1',
    });
    mockRememberAdminOpenIDSessionRef.mockResolvedValue(undefined);
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  it('omits refresh token from admin exchange when OPENID_REUSE_TOKENS is disabled', async () => {
    const handler = createOAuthHandler('http://admin.example.com/auth/openid/callback');
    const req = buildReq();
    const res = buildRes();
    const next = jest.fn();

    await handler(req, res, next);

    expect(mockGenerateAdminExchangeCode).toHaveBeenCalledWith(
      {},
      req.user,
      'jwt-token',
      undefined,
      'http://admin.example.com',
      'pkce-challenge',
      expect.any(Number),
    );
    expect(res.redirect).toHaveBeenCalledWith(
      'http://admin.example.com/auth/openid/callback?code=exchange-code',
    );
    expect(mockSendOpenIDAuthResponse).not.toHaveBeenCalled();
    expect(mockSetAuthTokens).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
  });

  it('includes refresh token in admin exchange when OPENID_REUSE_TOKENS is enabled', async () => {
    process.env.OPENID_REUSE_TOKENS = 'true';
    const handler = createOAuthHandler('http://admin.example.com/auth/openid/callback');
    const req = buildReq();
    const res = buildRes();
    const next = jest.fn();

    await handler(req, res, next);

    expect(mockGenerateAdminExchangeCode).toHaveBeenCalledWith(
      {},
      req.user,
      'jwt-token',
      'openid-refresh-token',
      'http://admin.example.com',
      'pkce-challenge',
      expect.any(Number),
    );
    expect(res.redirect).toHaveBeenCalledWith(
      'http://admin.example.com/auth/openid/callback?code=exchange-code',
    );
  });

  it('calls resolveOpenIDLoginCompletion with the built input and deps', async () => {
    process.env.OPENID_REUSE_TOKENS = 'true';
    openIdSessions.sessionAuthorizationRef.enforcement = true;
    openIdSessions.sessionAuthorizationRef.timeoutMs = 9_999;
    const handler = createOAuthHandler('http://admin.example.com/auth/openid/callback');
    const req = buildReq();
    const res = buildRes();
    const next = jest.fn();

    await handler(req, res, next);

    expect(mockResolveOpenIDLoginCompletion).toHaveBeenCalledWith(
      {
        provider: 'openid',
        user: {
          id: 'user-123',
          tenantId: 'tenant-1',
          openidIssuer: 'https://idp.example.com',
          openidId: 'openid-subject-1',
        },
        tokenset: req.user.tokenset,
        session: req.session,
        retryRoute: '/oauth/openid',
        loginFailureRedirectBase: 'http://localhost:3080',
        isAdminExchange: true,
        adminRefreshToken: 'openid-refresh-token',
      },
      {
        loginDeps: {},
        clientId: 'client-id',
        sessionAuthorizationEnforcement: true,
        sessionAuthorizationTimeoutMs: 9_999,
        rememberAdminSessionRef: rememberAdminOpenIDSessionRef,
        logger: mockLogger,
      },
    );
  });

  it('falls back to the default authorization timeout when none is configured', async () => {
    const handler = createOAuthHandler('http://admin.example.com/auth/openid/callback');
    const req = buildReq();
    const res = buildRes();
    const next = jest.fn();

    await handler(req, res, next);

    expect(mockResolveOpenIDLoginCompletion).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ sessionAuthorizationTimeoutMs: 3_000 }),
    );
  });

  it('redirects using the completion result and does nothing else', async () => {
    mockResolveOpenIDLoginCompletion.mockResolvedValue({
      kind: 'redirect',
      url: '/oauth/openid?prompt=login',
    });
    const handler = createOAuthHandler('http://localhost:3080');
    const req = buildReq();
    const res = buildRes();
    const next = jest.fn();

    await handler(req, res, next);

    expect(res.redirect).toHaveBeenCalledWith('/oauth/openid?prompt=login');
    expect(mockSendOpenIDAuthResponse).not.toHaveBeenCalled();
    expect(mockSetAuthTokens).not.toHaveBeenCalled();
    expect(mockGenerateAdminExchangeCode).not.toHaveBeenCalled();
  });

  it('publishes the standard OpenID login through the durable generation service', async () => {
    process.env.OPENID_REUSE_TOKENS = 'true';
    mockIsAdminPanelRedirect.mockReturnValue(false);
    const handler = createOAuthHandler('http://localhost:3080');
    const req = buildReq();
    const res = buildRes();
    const next = jest.fn();

    await handler(req, res, next);

    expect(mockSendOpenIDAuthResponse).toHaveBeenCalledWith({
      tokenset: req.user.tokenset,
      user: req.user,
      existingRefreshToken: 'openid-refresh-token',
      openidSubject: 'openid-subject-1',
      openidIssuer: 'https://idp.example.com',
      discardSessionTokens: true,
      openidSessionId: 'session-login-1',
      req,
      res,
    });
    expect(res.redirect).toHaveBeenCalledWith('http://localhost:3080');
  });

  it('threads the completion session id into the admin exchange token claims', async () => {
    const handler = createOAuthHandler('http://admin.example.com/auth/openid/callback');
    const req = buildReq();
    const res = buildRes();
    const next = jest.fn();

    await handler(req, res, next);

    expect(mockGenerateToken).toHaveBeenCalledWith(req.user, expect.any(Number), {
      openidSessionId: 'session-login-1',
      tenantId: 'tenant-1',
    });
  });

  it('threads the completion session id into the non-reuse LibreChat token', async () => {
    mockIsAdminPanelRedirect.mockReturnValue(false);
    const handler = createOAuthHandler('http://localhost:3080');
    const req = buildReq();
    const res = buildRes();
    const next = jest.fn();

    await handler(req, res, next);

    expect(mockSetAuthTokens).toHaveBeenCalledWith(req.user._id, res, null, req, {
      openidSessionId: 'session-login-1',
      tenantId: 'tenant-1',
    });
  });

  it('forwards the refresh token from req.authInfo for non-openid admin providers', async () => {
    const handler = createOAuthHandler('http://admin.example.com/auth/google/callback');
    const req = buildReq({
      user: { _id: 'user-9', email: 'g@example.com', provider: 'google' },
      authInfo: { refreshToken: 'google-refresh-token' },
    });
    const res = buildRes();
    const next = jest.fn();

    await handler(req, res, next);

    expect(mockGenerateAdminExchangeCode).toHaveBeenCalledWith(
      {},
      req.user,
      'jwt-token',
      'google-refresh-token',
      'http://admin.example.com',
      'pkce-challenge',
      expect.any(Number),
    );
  });

  it('omits the refresh token when a non-openid admin login has no authInfo', async () => {
    const handler = createOAuthHandler('http://admin.example.com/auth/google/callback');
    const req = buildReq({
      user: { _id: 'user-9', email: 'g@example.com', provider: 'google' },
    });
    const res = buildRes();
    const next = jest.fn();

    await handler(req, res, next);

    expect(mockGenerateAdminExchangeCode).toHaveBeenCalledWith(
      {},
      req.user,
      'jwt-token',
      undefined,
      'http://admin.example.com',
      'pkce-challenge',
      expect.any(Number),
    );
  });

  it('does not forward refresh tokens for admin providers other than google or openid', async () => {
    const handler = createOAuthHandler('http://admin.example.com/auth/discord/callback');
    const req = buildReq({
      user: { _id: 'user-9', email: 'd@example.com', provider: 'discord' },
      authInfo: { refreshToken: 'discord-refresh-token' },
    });
    const res = buildRes();
    const next = jest.fn();

    await handler(req, res, next);

    expect(mockGenerateAdminExchangeCode).toHaveBeenCalledWith(
      {},
      req.user,
      'jwt-token',
      undefined,
      'http://admin.example.com',
      'pkce-challenge',
      expect.any(Number),
    );
  });
});
