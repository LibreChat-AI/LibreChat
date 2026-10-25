const client = require('openid-client');
const { ErrorTypes } = require('librechat-data-provider');
const { isEnabled, fetchOAuth2UserInfo } = require('@librechat/api');
const { findUser, createUser, updateUser } = require('~/models');
const { setupOpenId } = require('./openidStrategy');

// --- Mocks ---
jest.mock('~/server/services/Files/strategies', () => ({
  getStrategyFunctions: jest.fn(() => ({
    saveBuffer: jest.fn().mockResolvedValue('/fake/path/to/avatar.png'),
  })),
}));
jest.mock('~/server/services/Files/images/avatar', () => ({
  resizeAvatar: jest.fn().mockResolvedValue(Buffer.from('safe avatar')),
}));
jest.mock('~/server/services/Config', () => ({
  getAppConfig: jest.fn().mockResolvedValue({}),
}));
jest.mock('~/models', () => ({
  findUser: jest.fn(),
  createUser: jest.fn(),
  updateUser: jest.fn(),
  findRolesByNames: jest.fn(),
}));
jest.mock('~/cache/getLogStores', () =>
  jest.fn(() => ({
    get: jest.fn(),
    set: jest.fn(),
  })),
);
jest.mock('@librechat/data-schemas', () => ({
  ...jest.requireActual('@librechat/api'),
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
    error: jest.fn(),
  },
  tenantStorage: {
    run: jest.fn((_context, fn) => fn()),
  },
  hashToken: jest.fn().mockResolvedValue('hashed-token'),
}));
jest.mock('@librechat/api', () => {
  const actual = jest.requireActual('@librechat/api');
  return {
    ...actual,
    isEnabled: jest.fn(() => false),
    isEmailDomainAllowed: jest.fn(() => true),
    /** pure helpers stay real; only the network call is stubbed */
    fetchOAuth2UserInfo: jest.fn(),
    getBalanceConfig: jest.fn(() => ({ enabled: false })),
    resolveAppConfigForUser: jest.fn(async () => ({})),
    getOpenIdProxyDispatcher: jest.fn(() => undefined),
  };
});
jest.mock('openid-client', () => ({
  discovery: jest.fn().mockResolvedValue({ issuer: 'https://fake-issuer.com' }),
  fetchUserInfo: jest.fn().mockResolvedValue({}),
  customFetch: Symbol('customFetch'),
}));

/** Capture the strategy passport-oauth2 is constructed with. */
jest.mock('passport-oauth2', () => {
  let last;
  const MockStrategy = jest.fn(function (options, verify) {
    this.name = 'oauth2';
    this.options = options;
    this.verify = verify;
    last = this;
  });
  return {
    Strategy: MockStrategy,
    __getLast: () => last,
    __reset: () => {
      last = undefined;
    },
  };
});
jest.mock('passport', () => ({
  use: jest.fn(),
}));

const passport = require('passport');
const oauth2 = require('passport-oauth2');

describe('setupOpenId - OAuth2-only providers', () => {
  const stateOptions = { secret: 'state-signing-secret', secureCookie: false };
  const userinfo = {
    account_id: '712020:abc-123',
    email: 'test@example.com',
    name: 'Test User',
    nickname: 'testuser',
  };

  /** Wrap the passport-oauth2 verify callback in a promise. */
  const validate = (verify, { accessToken = 'fake_access_token', params = {} } = {}) =>
    new Promise((resolve, reject) => {
      verify(accessToken, 'fake_refresh_token', params, null, (err, user, details) => {
        if (err) {
          reject(err);
        } else {
          resolve({ user, details });
        }
      });
    });

  const mockUserinfoResponse = (body) => {
    fetchOAuth2UserInfo.mockResolvedValue(body);
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    oauth2.__reset();

    process.env.OPENID_CLIENT_ID = 'fake_client_id';
    process.env.OPENID_CLIENT_SECRET = 'fake_client_secret';
    process.env.DOMAIN_SERVER = 'https://example.com';
    process.env.OPENID_CALLBACK_URL = '/oauth/openid/callback';
    process.env.OPENID_SCOPE = 'read:me read:account';
    process.env.OPENID_AUTHORIZATION_URL = 'https://auth.example.com/authorize';
    process.env.OPENID_TOKEN_URL = 'https://auth.example.com/oauth/token';
    process.env.OPENID_USERINFO_URL = 'https://api.example.com/me';
    delete process.env.OPENID_USE_PKCE;
    delete process.env.OPENID_REQUIRED_ROLE;
    delete process.env.OPENID_ADMIN_ROLE;
    delete process.env.OPENID_AUDIENCE;
    delete process.env.OPENID_USERNAME_CLAIM;
    delete process.env.OPENID_NAME_CLAIM;

    /** OPENID_USE_OAUTH2 and nothing else is enabled. */
    isEnabled.mockImplementation((value) => value === 'true');
    process.env.OPENID_USE_OAUTH2 = 'true';

    findUser.mockResolvedValue(null);
    createUser.mockImplementation(async (data) => ({ _id: 'new_user_id', ...data }));
    /** the strategy reassigns `user` from updateUser's return value */
    updateUser.mockImplementation(async (_id, data) => ({ _id, ...data }));
    mockUserinfoResponse(userinfo);
  });

  it('registers an OAuth2 strategy with the configured endpoints', async () => {
    await setupOpenId({ stateOptions });

    expect(oauth2.Strategy).toHaveBeenCalledTimes(1);
    expect(passport.use).toHaveBeenCalledWith('openid', expect.anything());

    const { options } = oauth2.__getLast();
    expect(options.authorizationURL).toBe('https://auth.example.com/authorize');
    expect(options.tokenURL).toBe('https://auth.example.com/oauth/token');
    expect(options.clientID).toBe('fake_client_id');
    expect(options.callbackURL).toBe('https://example.com/oauth/openid/callback');
    expect(options.scope).toEqual(['read:me', 'read:account']);
    expect(options.store).toEqual({ store: expect.any(Function), verify: expect.any(Function) });
  });

  /** Drives the registered store the way passport-oauth2 does across the redirect. */
  const startLogin = (store) =>
    new Promise((resolve, reject) => {
      const cookies = {};
      const req = {
        cookies: {},
        res: { cookie: (name, value) => (cookies[name] = value) },
      };
      store.store(req, (err, state) => (err ? reject(err) : resolve({ state, cookies })));
    });
  const verifyState = (store, cookies, state) =>
    new Promise((resolve) => {
      store.verify({ cookies }, state, (err, ok, info) => resolve({ err, ok, info }));
    });

  it('verifies a state issued to the same browser', async () => {
    await setupOpenId({ stateOptions });
    const { store } = oauth2.__getLast().options;

    const { state, cookies } = await startLogin(store);
    const { err, ok } = await verifyState(store, cookies, state);

    expect(err).toBeNull();
    expect(ok).toBe(true);
  });

  it('rejects a callback whose state was issued to another browser', async () => {
    await setupOpenId({ stateOptions });
    const { store } = oauth2.__getLast().options;

    const attacker = await startLogin(store);
    const victim = await startLogin(store);
    const { ok } = await verifyState(store, victim.cookies, attacker.state);

    expect(ok).toBe(false);
  });

  it('returns null and registers nothing without a state signing secret', async () => {
    const result = await setupOpenId();

    expect(result).toBeNull();
    expect(passport.use).not.toHaveBeenCalled();
  });

  it('passes the configured audience on the authorization request', async () => {
    process.env.OPENID_AUDIENCE = 'api.example.com';
    await setupOpenId({ stateOptions });

    expect(oauth2.__getLast().authorizationParams()).toEqual({ audience: 'api.example.com' });
  });

  it('sends no audience when none is configured', async () => {
    delete process.env.OPENID_AUDIENCE;
    await setupOpenId({ stateOptions });

    expect(oauth2.__getLast().authorizationParams()).toEqual({});
  });

  it('does not perform OIDC discovery in OAuth2 mode', async () => {
    await setupOpenId({ stateOptions });
    expect(client.discovery).not.toHaveBeenCalled();
  });

  it('returns null and registers nothing when required URLs are missing', async () => {
    delete process.env.OPENID_TOKEN_URL;

    const result = await setupOpenId({ stateOptions });

    expect(result).toBeNull();
    expect(oauth2.Strategy).not.toHaveBeenCalled();
    expect(passport.use).not.toHaveBeenCalled();
  });

  it('ignores OPENID_USE_PKCE, which passport-oauth2 cannot honour in this mode', async () => {
    process.env.OPENID_USE_PKCE = 'true';
    await setupOpenId({ stateOptions });
    expect(oauth2.__getLast().options).not.toHaveProperty('pkce');
  });

  it('resolves identity from the userinfo endpoint using the access token', async () => {
    await setupOpenId({ stateOptions });
    await validate(oauth2.__getLast().verify);

    expect(fetchOAuth2UserInfo).toHaveBeenCalledWith(
      'https://api.example.com/me',
      'fake_access_token',
    );
  });

  it('normalises account_id to sub so the user is keyed consistently', async () => {
    await setupOpenId({ stateOptions });
    const { user } = await validate(oauth2.__getLast().verify);

    expect(createUser).toHaveBeenCalledWith(
      expect.objectContaining({ openidId: '712020:abc-123', email: 'test@example.com' }),
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
    expect(user).toBeTruthy();
  });

  it('prefers an explicit sub over account_id', async () => {
    mockUserinfoResponse({ ...userinfo, sub: 'explicit-sub' });
    await setupOpenId({ stateOptions });
    await validate(oauth2.__getLast().verify);

    expect(createUser).toHaveBeenCalledWith(
      expect.objectContaining({ openidId: 'explicit-sub' }),
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
  });

  it('fails authentication when the userinfo request fails', async () => {
    fetchOAuth2UserInfo.mockResolvedValue(null);
    await setupOpenId({ stateOptions });

    const { user, details } = await validate(oauth2.__getLast().verify);

    expect(user).toBe(false);
    expect(details).toEqual({ message: ErrorTypes.AUTH_FAILED });
    expect(createUser).not.toHaveBeenCalled();
  });

  it('fails authentication when userinfo carries no usable identifier', async () => {
    mockUserinfoResponse({ email: 'test@example.com', name: 'No Id' });
    await setupOpenId({ stateOptions });

    const { user, details } = await validate(oauth2.__getLast().verify);

    expect(user).toBe(false);
    expect(details).toEqual({ message: ErrorTypes.AUTH_FAILED });
    expect(createUser).not.toHaveBeenCalled();
  });

  it('rejects logins whose email domain is not allowed', async () => {
    const { isEmailDomainAllowed } = require('@librechat/api');
    isEmailDomainAllowed.mockReturnValue(false);

    await setupOpenId({ stateOptions });
    const { user, details } = await validate(oauth2.__getLast().verify);

    expect(user).toBe(false);
    expect(details).toEqual({ message: 'Email domain not allowed' });
  });
});
