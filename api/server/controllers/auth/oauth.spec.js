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
const mockEstablishOAuthCallback = jest.fn();
const mockPersistOAuthAdminBinding = jest.fn();
const mockResolveAuthMethod = jest.fn();
const mockLogger = { info: jest.fn(), error: jest.fn(), warn: jest.fn() };

jest.mock('librechat-data-provider', () => ({
  CacheKeys: { ADMIN_OAUTH_EXCHANGE: 'admin-oauth-exchange' },
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
  resolveAuthMethod: (...args) => mockResolveAuthMethod(...args),
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

jest.mock('~/server/services/ProviderSession', () => ({
  establishOAuthCallback: (...args) => mockEstablishOAuthCallback(...args),
  persistOAuthAdminBinding: (...args) => mockPersistOAuthAdminBinding(...args),
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

const { createOAuthHandler } = require('./oauth');

const ORIGINAL_ENV = process.env;

function buildReq(overrides = {}) {
  return {
    user: {
      _id: 'user-123',
      email: 'admin@example.com',
      provider: 'openid',
      openidIssuer: 'https://issuer.example.com',
      tokenset: {
        refresh_token: 'openid-refresh-token',
        access_token: 'openid-access-token',
        claims: () => ({ sub: 'sub-123', sid: 'sid-123' }),
      },
      federatedTokens: { refresh_token: 'federated-refresh-token' },
    },
    session: { openidLoginIssuedAt: Date.now() },
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
    mockResolveAuthMethod.mockImplementation((provider) =>
      provider === 'openid' ? 'openid' : 'social',
    );
    mockEstablishOAuthCallback.mockResolvedValue(null);
    mockPersistOAuthAdminBinding.mockResolvedValue(undefined);
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  it('delegates the provider-session check with the request and response', async () => {
    mockIsAdminPanelRedirect.mockReturnValue(false);
    const handler = createOAuthHandler('http://localhost:3080');
    const req = buildReq();
    const res = buildRes();
    const next = jest.fn();

    await handler(req, res, next);

    expect(mockEstablishOAuthCallback).toHaveBeenCalledWith(expect.objectContaining({ req, res }));
  });

  it('passes the resolved ref into setAuthTokens with the explicit openid auth method', async () => {
    mockIsAdminPanelRedirect.mockReturnValue(false);
    const ref = { issuer: 'https://issuer.example.com', clientId: 'client-1', sid: 'sid-123' };
    mockEstablishOAuthCallback.mockResolvedValue(ref);
    const handler = createOAuthHandler('http://localhost:3080');
    const req = buildReq();
    const res = buildRes();
    const next = jest.fn();

    await handler(req, res, next);

    expect(mockSetAuthTokens).toHaveBeenCalledWith(req.user._id, res, null, req, {
      providerSession: ref,
      authMethod: 'openid',
    });
    expect(res.redirect).toHaveBeenCalledWith('http://localhost:3080');
  });

  it('passes a null ref into setAuthTokens for a non-OpenID login', async () => {
    mockIsAdminPanelRedirect.mockReturnValue(false);
    const handler = createOAuthHandler('http://localhost:3080');
    const req = buildReq({
      user: { _id: 'user-9', email: 'g@example.com', provider: 'google' },
    });
    const res = buildRes();
    const next = jest.fn();

    await handler(req, res, next);

    expect(mockSetAuthTokens).toHaveBeenCalledWith('user-9', res, null, req, {
      providerSession: null,
      authMethod: 'social',
    });
    expect(res.redirect).toHaveBeenCalledWith('http://localhost:3080');
  });

  it('stops without publishing when the provider-session check denies the callback', async () => {
    mockIsAdminPanelRedirect.mockReturnValue(false);
    mockEstablishOAuthCallback.mockResolvedValue(undefined);
    const handler = createOAuthHandler('http://localhost:3080');
    const req = buildReq();
    const res = buildRes();
    const next = jest.fn();

    await handler(req, res, next);

    expect(mockSetAuthTokens).not.toHaveBeenCalled();
    expect(mockSendOpenIDAuthResponse).not.toHaveBeenCalled();
    expect(res.redirect).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
  });

  it('propagates a provider-session check failure that is not caught as a denial', async () => {
    mockIsAdminPanelRedirect.mockReturnValue(false);
    const unrelatedError = new Error('boom');
    mockEstablishOAuthCallback.mockRejectedValue(unrelatedError);
    const handler = createOAuthHandler('http://localhost:3080');
    const req = buildReq();
    const res = buildRes();
    const next = jest.fn();

    await handler(req, res, next);

    expect(next).toHaveBeenCalledWith(unrelatedError);
  });

  it('publishes the standard OpenID login through the durable generation service', async () => {
    process.env.OPENID_REUSE_TOKENS = 'true';
    mockIsAdminPanelRedirect.mockReturnValue(false);
    const ref = { issuer: 'https://issuer.example.com', clientId: 'client-1', sid: 'sid-123' };
    mockEstablishOAuthCallback.mockResolvedValue(ref);
    const handler = createOAuthHandler('http://localhost:3080');
    const req = buildReq();
    const res = buildRes();
    const next = jest.fn();

    await handler(req, res, next);

    expect(mockSendOpenIDAuthResponse).toHaveBeenCalledWith({
      tokenset: req.user.tokenset,
      user: req.user,
      existingRefreshToken: 'openid-refresh-token',
      openidSubject: undefined,
      openidIssuer: 'https://issuer.example.com',
      discardSessionTokens: true,
      providerSession: ref,
      req,
      res,
    });
    expect(res.redirect).toHaveBeenCalledWith('http://localhost:3080');
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
      null,
    );
    expect(res.redirect).toHaveBeenCalledWith(
      'http://admin.example.com/auth/openid/callback?code=exchange-code',
    );
    expect(mockPersistOAuthAdminBinding).toHaveBeenCalledWith({
      provider: 'openid',
      refreshToken: undefined,
      userId: 'user-123',
      tenantId: undefined,
      providerSession: null,
    });
    expect(mockSendOpenIDAuthResponse).not.toHaveBeenCalled();
    expect(mockSetAuthTokens).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
  });

  it('includes refresh token in admin exchange when OPENID_REUSE_TOKENS is enabled, and delegates binding persistence', async () => {
    process.env.OPENID_REUSE_TOKENS = 'true';
    const ref = { issuer: 'https://issuer.example.com', clientId: 'client-1', sid: 'sid-123' };
    mockEstablishOAuthCallback.mockResolvedValue(ref);
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
      ref,
    );
    expect(mockPersistOAuthAdminBinding).toHaveBeenCalledWith({
      provider: 'openid',
      refreshToken: 'openid-refresh-token',
      userId: 'user-123',
      tenantId: undefined,
      providerSession: ref,
    });
    expect(res.redirect).toHaveBeenCalledWith(
      'http://admin.example.com/auth/openid/callback?code=exchange-code',
    );
    expect(mockSendOpenIDAuthResponse).not.toHaveBeenCalled();
    expect(mockSetAuthTokens).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
  });

  it('denies the admin callback before an exchange code is issued when the provider-session check denies', async () => {
    process.env.OPENID_REUSE_TOKENS = 'true';
    mockEstablishOAuthCallback.mockResolvedValue(undefined);
    const handler = createOAuthHandler('http://admin.example.com/auth/openid/callback');
    const req = buildReq();
    const res = buildRes();
    const next = jest.fn();

    await handler(req, res, next);

    expect(mockGenerateAdminExchangeCode).not.toHaveBeenCalled();
    expect(mockPersistOAuthAdminBinding).not.toHaveBeenCalled();
    expect(res.redirect).not.toHaveBeenCalled();
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
      null,
    );
    expect(mockPersistOAuthAdminBinding).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'google', refreshToken: 'google-refresh-token' }),
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
      null,
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
      null,
    );
  });
});
