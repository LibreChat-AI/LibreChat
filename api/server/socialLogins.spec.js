const mockSessionMiddleware = jest.fn((req, res, next) => next());
const mockPassportSessionMiddleware = jest.fn((req, res, next) => next());
const mockSession = jest.fn(() => mockSessionMiddleware);
const mockPassportUse = jest.fn();
const mockPassportSession = jest.fn(() => mockPassportSessionMiddleware);
const mockGetLogStores = jest.fn(() => 'openid-session-store');
const mockOpenIdJwtLogin = jest.fn(() => 'openid-jwt-strategy');
const mockSetupOpenId = jest.fn();
const mockSetupSaml = jest.fn();
const mockIsEnabled = jest.fn();
const mockShouldUseSecureCookie = jest.fn(() => true);
const mockRegisterOpenIdWithRetry = jest.fn(
  async ({ setupOpenId, registerJwtStrategy, reuseTokens }) => {
    const config = await setupOpenId();
    if (config && reuseTokens) {
      registerJwtStrategy(config);
    }
  },
);
const mockMath = jest.fn((value, fallback) => {
  if (value == null || value === '') {
    return fallback;
  }
  if (typeof value === 'number') {
    return value;
  }
  return value
    .split('*')
    .map((part) => Number(part.trim()))
    .reduce((result, part) => result * part, 1);
});

jest.mock(
  'express-session',
  () =>
    (...args) =>
      mockSession(...args),
);
jest.mock('passport', () => ({
  use: (...args) => mockPassportUse(...args),
  session: (...args) => mockPassportSession(...args),
}));
jest.mock('librechat-data-provider', () => ({
  CacheKeys: {
    OPENID_SESSION: 'openid-session',
    SAML_SESSION: 'saml-session',
  },
}));
jest.mock('@librechat/api', () => ({
  math: (...args) => mockMath(...args),
  isEnabled: (...args) => mockIsEnabled(...args),
  shouldUseSecureCookie: (...args) => mockShouldUseSecureCookie(...args),
  registerOpenIdWithRetry: (...args) => mockRegisterOpenIdWithRetry(...args),
}));
jest.mock('@librechat/data-schemas', () => ({
  DEFAULT_SESSION_EXPIRY: 900000,
  logger: { error: jest.fn(), info: jest.fn(), warn: jest.fn() },
}));
jest.mock('~/cache', () => ({ getLogStores: (...args) => mockGetLogStores(...args) }));
jest.mock('~/strategies', () => ({
  openIdJwtLogin: (...args) => mockOpenIdJwtLogin(...args),
  facebookLogin: jest.fn(),
  facebookAdminLogin: jest.fn(),
  discordLogin: jest.fn(),
  discordAdminLogin: jest.fn(),
  setupOpenId: (...args) => mockSetupOpenId(...args),
  googleLogin: jest.fn(),
  googleAdminLogin: jest.fn(),
  githubLogin: jest.fn(),
  githubAdminLogin: jest.fn(),
  appleLogin: jest.fn(),
  appleAdminLogin: jest.fn(),
  setupSaml: (...args) => mockSetupSaml(...args),
}));

const configureSocialLogins = require('./socialLogins');

describe('configureSocialLogins OpenID session expiry', () => {
  const ORIGINAL_ENV = process.env;

  const setupOpenIdEnv = () => {
    process.env.OPENID_CLIENT_ID = 'client-id';
    process.env.OPENID_CLIENT_SECRET = 'client-secret';
    process.env.OPENID_ISSUER = 'https://issuer.example.com';
    process.env.OPENID_SCOPE = 'openid profile email';
    process.env.OPENID_SESSION_SECRET = 'openid-session-secret';
    process.env.OPENID_USE_PKCE = 'false';
  };

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = {};
    setupOpenIdEnv();
    mockSetupOpenId.mockResolvedValue({ issuer: 'https://issuer.example.com' });
    mockIsEnabled.mockImplementation((value) => value === 'true');
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('extends the OpenID session cookie to the reuse window when token reuse is enabled', async () => {
    process.env.SESSION_EXPIRY = '1000 * 60 * 15';
    process.env.OPENID_REUSE_TOKENS = 'true';
    process.env.OPENID_REUSE_MAX_SESSION_AGE_MS = '1000 * 60 * 60';
    const app = { use: jest.fn() };

    await configureSocialLogins(app);

    expect(mockSession).toHaveBeenCalledWith(
      expect.objectContaining({
        cookie: {
          maxAge: 3600000,
          secure: true,
        },
      }),
    );
    expect(mockOpenIdJwtLogin).toHaveBeenCalledWith({ issuer: 'https://issuer.example.com' });
    expect(mockPassportUse).toHaveBeenCalledWith('openidJwt', 'openid-jwt-strategy');
  });

  it('keeps a longer SESSION_EXPIRY when the reuse window is shorter', async () => {
    process.env.SESSION_EXPIRY = '1000 * 60 * 60 * 2';
    process.env.OPENID_REUSE_TOKENS = 'true';
    process.env.OPENID_REUSE_MAX_SESSION_AGE_MS = '1000 * 60 * 60';
    const app = { use: jest.fn() };

    await configureSocialLogins(app);

    expect(mockSession).toHaveBeenCalledWith(
      expect.objectContaining({
        cookie: expect.objectContaining({ maxAge: 7200000 }),
      }),
    );
  });

  it('uses SESSION_EXPIRY when OpenID token reuse is disabled', async () => {
    process.env.SESSION_EXPIRY = '1000 * 60 * 15';
    process.env.OPENID_REUSE_TOKENS = '';
    process.env.OPENID_REUSE_MAX_SESSION_AGE_MS = '1000 * 60 * 60';
    const app = { use: jest.fn() };

    await configureSocialLogins(app);

    expect(mockSession).toHaveBeenCalledWith(
      expect.objectContaining({
        cookie: expect.objectContaining({ maxAge: 900000 }),
      }),
    );
    expect(mockPassportUse).not.toHaveBeenCalled();
  });

  it('passes OpenID strategy wiring and both retry sources to the API package', async () => {
    process.env.OPENID_DISCOVERY_RETRY_ATTEMPTS = '2';
    process.env.OPENID_DISCOVERY_RETRY_DELAY_MS = '1000';
    const discovery = { startupAttempts: 0, retryDelayMs: 250 };
    const app = { use: jest.fn() };

    await configureSocialLogins(app, { registration: { openidDiscovery: discovery } });

    expect(mockRegisterOpenIdWithRetry).toHaveBeenCalledWith({
      setupOpenId: expect.any(Function),
      registerJwtStrategy: expect.any(Function),
      reuseTokens: false,
      discovery,
      env: { startupAttempts: '2', retryDelayMs: '1000' },
    });
    expect(mockSetupOpenId).toHaveBeenCalledTimes(1);
  });
});

describe('configureSocialLogins OAuth state options', () => {
  const ORIGINAL_ENV = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = {
      JWT_SECRET: 'jwt-secret',
      GITHUB_CLIENT_ID: 'github-client',
      GITHUB_CLIENT_SECRET: 'github-secret',
      APPLE_CLIENT_ID: 'apple-client',
      APPLE_PRIVATE_KEY_PATH: '/keys/apple.p8',
    };
    mockIsEnabled.mockReturnValue(false);
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  it('passes the cookie security setting and configured state lifetime to user strategies', async () => {
    const strategies = require('~/strategies');
    const app = { use: jest.fn() };

    await configureSocialLogins(app, { registration: { oauthStateTtlMs: 120000 } });

    const expected = { secret: 'jwt-secret', secureCookie: true, maxAgeMs: 120000 };
    expect(strategies.githubLogin).toHaveBeenCalledWith(expected);
    expect(strategies.appleLogin).toHaveBeenCalledWith(expected);
    expect(strategies.githubAdminLogin).toHaveBeenCalledWith();
    expect(strategies.appleAdminLogin).toHaveBeenCalledWith();
  });

  it('leaves the state lifetime to the store default when the config omits it', async () => {
    const strategies = require('~/strategies');
    mockShouldUseSecureCookie.mockReturnValueOnce(false);

    await configureSocialLogins({ use: jest.fn() });

    expect(strategies.githubLogin).toHaveBeenCalledWith({
      secret: 'jwt-secret',
      secureCookie: false,
      maxAgeMs: undefined,
    });
  });
});
