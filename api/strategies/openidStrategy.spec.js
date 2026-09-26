const undici = require('undici');
const fetch = require('node-fetch');
const jwtDecode = require('jsonwebtoken/decode');
const { ErrorTypes, FileSources } = require('librechat-data-provider');
const { findUser, createUser, updateUser, findRolesByNames } = require('~/models');
const {
  getOpenIdProxyDispatcher,
  resolveAppConfigForUser,
  getOpenIdIssuer,
  isEnabled,
} = require('@librechat/api');
const { resizeAvatar } = require('~/server/services/Files/images/avatar');
const { getAppConfig } = require('~/server/services/Config');
const { setupOpenId } = require('./openidStrategy');

const mockCloudfrontFileSource = FileSources.cloudfront ?? 'cloudfront';

// --- Mocks ---
jest.mock('node-fetch');
jest.mock('jsonwebtoken/decode');
jest.mock('undici', () => ({
  fetch: jest.fn(),
}));
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
jest.mock('@librechat/api', () => {
  const actual = jest.requireActual('@librechat/api');
  const getStringClaim = (claims, claim) => {
    const value = claims[claim];
    return typeof value === 'string' && value ? value : undefined;
  };

  return {
    ...actual,
    isEnabled: jest.fn(() => false),
    isEmailDomainAllowed: jest.fn(() => true),
    findOpenIDUser: actual.findOpenIDUser,
    getOpenIdEmail: jest.fn((claims, strategyName = 'openidStrategy') => {
      if (claims == null) {
        return undefined;
      }

      const claimKey = process.env.OPENID_EMAIL_CLAIM?.trim();
      if (claimKey) {
        const value = claims[claimKey];
        if (typeof value === 'string' && value) {
          return value;
        }

        const { logger } = require('@librechat/data-schemas');
        if (value != null) {
          logger.warn(
            `[${strategyName}] OPENID_EMAIL_CLAIM="${claimKey}" resolved to a non-string value (type: ${typeof value}). Falling back to: email -> preferred_username -> upn.`,
          );
        } else {
          logger.warn(
            `[${strategyName}] OPENID_EMAIL_CLAIM="${claimKey}" not present in userinfo. Falling back to: email -> preferred_username -> upn.`,
          );
        }
      }

      return (
        getStringClaim(claims, 'email') ??
        getStringClaim(claims, 'preferred_username') ??
        getStringClaim(claims, 'upn')
      );
    }),
    getBalanceConfig: jest.fn(() => ({
      enabled: false,
    })),
    getOpenIdIssuer: jest.fn(() => 'https://fake-issuer.com'),
    getOpenIdProxyDispatcher: jest.fn(() => undefined),
    getAvatarFileStrategy: jest.fn((config, fallbackStrategy) => {
      const { FileSources } = jest.requireActual('librechat-data-provider');
      if (config?.fileStrategies) {
        return config.fileStrategies.avatar ?? config.fileStrategies.default ?? config.fileStrategy;
      }
      return config?.fileStrategy ?? fallbackStrategy ?? FileSources.local;
    }),
    getAvatarSaveParams: jest.fn((strategy, params) => {
      const { FileSources } = jest.requireActual('librechat-data-provider');
      return strategy === FileSources.s3 || strategy === mockCloudfrontFileSource
        ? { ...params, basePath: 'avatars' }
        : params;
    }),
    resolveAppConfigForUser: jest.fn(async (_getAppConfig, _user) => ({})),
  };
});
jest.mock('~/models', () => ({
  findUser: jest.fn(),
  createUser: jest.fn(),
  updateUser: jest.fn(),
  findRolesByNames: jest.fn(),
}));
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
jest.mock('~/cache/getLogStores', () =>
  jest.fn(() => ({
    get: jest.fn(),
    set: jest.fn(),
  })),
);

// Mock the openid-client module and all its dependencies
jest.mock('openid-client', () => {
  return {
    discovery: jest.fn().mockResolvedValue({
      clientId: 'fake_client_id',
      clientSecret: 'fake_client_secret',
      issuer: 'https://fake-issuer.com',
      // Add any other properties needed by the implementation
    }),
    fetchUserInfo: jest.fn().mockImplementation(() => {
      // Only return additional properties, but don't override any claims
      return Promise.resolve({});
    }),
    genericGrantRequest: jest.fn().mockResolvedValue({
      access_token: 'exchanged_graph_token',
      expires_in: 3600,
    }),
    customFetch: Symbol('customFetch'),
  };
});

jest.mock('openid-client/passport', () => {
  /** Store callbacks by strategy name - 'openid' and 'openidAdmin' */
  const verifyCallbacks = {};
  const strategies = {};
  let lastVerifyCallback;

  const mockStrategy = jest.fn(function (options, verify) {
    lastVerifyCallback = verify;
    this.name = 'openid';
    this.options = options;
    this.verify = verify;
  });
  mockStrategy.prototype.authorizationRequestParams = jest.fn(() => new URLSearchParams());

  return {
    Strategy: mockStrategy,
    /** Get the last registered callback (for backward compatibility) */
    __getVerifyCallback: () => lastVerifyCallback,
    __getStrategyByName: (name) => strategies[name],
    /** Store callback by name when passport.use is called */
    __setStrategy: (name, strategy) => {
      strategies[name] = strategy;
      if (strategy?.verify) {
        verifyCallbacks[name] = strategy.verify;
      }
    },
    /** Get callback by strategy name */
    __getVerifyCallbackByName: (name) => verifyCallbacks[name],
  };
});

// Mock passport - capture strategy name and callback
jest.mock('passport', () => ({
  use: jest.fn((name, strategy) => {
    const passportMock = require('openid-client/passport');
    passportMock.__setStrategy(name, strategy);
  }),
}));

describe('setupOpenId', () => {
  // Store a reference to the verify callback once it's set up
  let verifyCallback;

  // Helper to wrap the verify callback in a promise
  const validate = (tokenset) =>
    new Promise((resolve, reject) => {
      verifyCallback(tokenset, (err, user, details) => {
        if (err) {
          reject(err);
        } else {
          resolve({ user, details });
        }
      });
    });

  const tokenset = {
    id_token: 'fake_id_token',
    access_token: 'fake_access_token',
    claims: () => ({
      sub: '1234',
      email: 'test@example.com',
      email_verified: true,
      given_name: 'First',
      family_name: 'Last',
      name: 'My Full',
      preferred_username: 'testusername',
      username: 'flast',
      picture: 'https://example.com/avatar.png',
    }),
  };

  beforeEach(async () => {
    // Clear previous mock calls and reset implementations
    jest.clearAllMocks();
    isEnabled.mockImplementation(jest.requireActual('@librechat/api').isEnabled);
    require('~/cache/getLogStores').mockImplementation(() => ({
      get: jest.fn(),
      set: jest.fn(),
    }));
    getOpenIdProxyDispatcher.mockReturnValue(undefined);
    require('openid-client').genericGrantRequest.mockReset();
    require('openid-client').genericGrantRequest.mockResolvedValue({
      access_token: 'exchanged_graph_token',
      expires_in: 3600,
    });

    // Reset environment variables needed by the strategy
    process.env.OPENID_ISSUER = 'https://fake-issuer.com';
    process.env.OPENID_CLIENT_ID = 'fake_client_id';
    process.env.OPENID_CLIENT_SECRET = 'fake_client_secret';
    process.env.DOMAIN_SERVER = 'https://example.com';
    process.env.OPENID_CALLBACK_URL = '/callback';
    process.env.OPENID_SCOPE = 'openid profile email';
    process.env.OPENID_REQUIRED_ROLE = 'requiredRole';
    process.env.OPENID_REQUIRED_ROLE_PARAMETER_PATH = 'roles';
    process.env.OPENID_REQUIRED_ROLE_TOKEN_KIND = 'id';
    process.env.OPENID_ADMIN_ROLE = 'admin';
    process.env.OPENID_ADMIN_ROLE_PARAMETER_PATH = 'permissions';
    process.env.OPENID_ADMIN_ROLE_TOKEN_KIND = 'id';
    delete process.env.OPENID_USERNAME_CLAIM;
    delete process.env.OPENID_NAME_CLAIM;
    delete process.env.OPENID_EMAIL_CLAIM;
    delete process.env.OPENID_AUDIENCE;
    delete process.env.OPENID_AVATAR_AUTHORIZED_ORIGINS;
    delete process.env.PROXY;
    delete process.env.OPENID_USE_PKCE;
    delete process.env.OPENID_GENERATE_NONCE;
    delete process.env.OPENID_DISCOVERY_RETRIES;
    delete process.env.OPENID_DISCOVERY_RETRY_DELAY_MS;
    delete process.env.OPENID_ROLE_SYNC_ENABLED;
    delete process.env.OPENID_ROLE_SYNC_API_ENABLED;
    delete process.env.OPENID_ROLE_SYNC_SOURCE;
    delete process.env.OPENID_ROLE_SYNC_CLAIM;
    delete process.env.OPENID_ROLE_SYNC_ROLE_PRIORITY;
    delete process.env.OPENID_ROLE_SYNC_FALLBACK_ROLE;
    delete process.env.OPENID_ON_BEHALF_FLOW_FOR_USERINFO_REQUIRED;
    delete process.env.OPENID_ON_BEHALF_FLOW_USERINFO_SCOPE;

    // Default jwtDecode mock returns a token that includes the required role.
    jwtDecode.mockReturnValue({
      roles: ['requiredRole'],
      permissions: ['admin'],
    });

    // By default, assume that no user is found, so createUser will be called
    findUser.mockResolvedValue(null);
    createUser.mockImplementation(async (userData) => {
      // simulate created user with an _id property
      return { _id: 'newUserId', ...userData };
    });
    updateUser.mockImplementation(async (id, userData) => {
      return { _id: id, ...userData };
    });
    findRolesByNames.mockImplementation(async (roleNames) =>
      roleNames.map((roleName) => ({ name: roleName })),
    );

    resizeAvatar.mockResolvedValue(Buffer.from('safe avatar'));

    // Call the setup function and capture the verify callback for the regular 'openid' strategy
    // (not 'openidAdmin' which requires existing users)
    await setupOpenId();
    verifyCallback = require('openid-client/passport').__getVerifyCallbackByName('openid');
  });

  describe('clientMetadata construction in setupOpenId', () => {
    let openidClient;

    beforeEach(() => {
      openidClient = require('openid-client');
      openidClient.discovery.mockClear();
    });

    it('sets token_endpoint_auth_method to none for PKCE without a client secret', async () => {
      process.env.OPENID_USE_PKCE = 'true';
      delete process.env.OPENID_CLIENT_SECRET;

      await setupOpenId();

      const [, , metadata] = openidClient.discovery.mock.calls.at(-1);
      expect(metadata.token_endpoint_auth_method).toBe('none');
      expect(metadata.client_secret).toBeUndefined();
    });

    it('leaves token_endpoint_auth_method unset for secret-based clients without nonce', async () => {
      process.env.OPENID_USE_PKCE = 'false';
      process.env.OPENID_CLIENT_SECRET = 'my-secret';

      await setupOpenId();

      const [, , metadata] = openidClient.discovery.mock.calls.at(-1);
      expect(metadata.client_secret).toBe('my-secret');
      expect(metadata.token_endpoint_auth_method).toBeUndefined();
    });

    it('sets client_secret and client_secret_post when nonce generation is enabled', async () => {
      process.env.OPENID_USE_PKCE = 'false';
      process.env.OPENID_GENERATE_NONCE = 'true';
      process.env.OPENID_CLIENT_SECRET = 'my-secret';

      await setupOpenId();

      const [, , metadata] = openidClient.discovery.mock.calls.at(-1);
      expect(metadata.client_secret).toBe('my-secret');
      expect(metadata.token_endpoint_auth_method).toBe('client_secret_post');
    });

    it('treats whitespace-only secret as absent', async () => {
      process.env.OPENID_USE_PKCE = 'true';
      process.env.OPENID_CLIENT_SECRET = '   ';

      await setupOpenId();

      const [, , metadata] = openidClient.discovery.mock.calls.at(-1);
      expect(metadata.client_secret).toBeUndefined();
      expect(metadata.token_endpoint_auth_method).toBe('none');
    });

    it('does not force an auth method when PKCE and a client secret are both configured without nonce', async () => {
      process.env.OPENID_USE_PKCE = 'true';
      process.env.OPENID_CLIENT_SECRET = 'my-secret';

      await setupOpenId();

      const [, , metadata] = openidClient.discovery.mock.calls.at(-1);
      expect(metadata.client_secret).toBe('my-secret');
      expect(metadata.token_endpoint_auth_method).toBeUndefined();
    });

    it('uses the shared OpenID proxy dispatcher for custom fetch requests', async () => {
      const dispatcher = { dispatch: jest.fn() };
      const response = { status: 204, statusText: 'No Content', headers: new Headers() };
      getOpenIdProxyDispatcher.mockReturnValue(dispatcher);
      undici.fetch.mockResolvedValue(response);

      await setupOpenId();

      const [, , , , options] = openidClient.discovery.mock.calls.at(-1);
      const openIdFetch = options[openidClient.customFetch];
      await expect(
        openIdFetch('https://issuer.example.com/.well-known/openid-configuration', {
          method: 'GET',
        }),
      ).resolves.toBe(response);

      expect(getOpenIdProxyDispatcher).toHaveBeenCalled();
      expect(undici.fetch).toHaveBeenCalledWith(
        'https://issuer.example.com/.well-known/openid-configuration',
        {
          method: 'GET',
          dispatcher,
        },
      );
    });
  });

  describe('OIDC discovery retry', () => {
    let openidClient;

    const DEFAULT_DISCOVERY_RESULT = {
      clientId: 'fake_client_id',
      clientSecret: 'fake_client_secret',
      issuer: 'https://fake-issuer.com',
    };

    beforeEach(() => {
      openidClient = require('openid-client');
      openidClient.discovery.mockReset();
      openidClient.discovery.mockResolvedValue(DEFAULT_DISCOVERY_RESULT);
    });

    afterEach(() => {
      delete process.env.OPENID_DISCOVERY_RETRIES;
      delete process.env.OPENID_DISCOVERY_RETRY_DELAY_MS;
      // The outer beforeEach calls setupOpenId() and relies on discovery resolving;
      // restore it so a rejected mock from these tests never leaks into later tests.
      const client = require('openid-client');
      client.discovery.mockReset();
      client.discovery.mockResolvedValue(DEFAULT_DISCOVERY_RESULT);
    });

    it('registers the strategy after transient discovery failures', async () => {
      process.env.OPENID_DISCOVERY_RETRIES = '3';
      process.env.OPENID_DISCOVERY_RETRY_DELAY_MS = '1';
      openidClient.discovery
        .mockRejectedValueOnce(new Error('connect ECONNREFUSED'))
        .mockRejectedValueOnce(new Error('503 Service Unavailable'));

      const result = await setupOpenId();

      expect(result).toEqual(DEFAULT_DISCOVERY_RESULT);
      expect(openidClient.discovery).toHaveBeenCalledTimes(3);
      expect(require('@librechat/data-schemas').logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('retrying in 1ms'),
      );
    });

    it('gives up and returns null after exhausting the retry budget', async () => {
      process.env.OPENID_DISCOVERY_RETRIES = '1';
      process.env.OPENID_DISCOVERY_RETRY_DELAY_MS = '1';
      openidClient.discovery.mockReset();
      openidClient.discovery.mockRejectedValue(new Error('503 Service Unavailable'));

      const result = await setupOpenId();

      expect(result).toBeNull();
      expect(openidClient.discovery).toHaveBeenCalledTimes(2);
      expect(require('@librechat/data-schemas').logger.error).toHaveBeenCalled();
    });

    it('makes a single attempt when retries are disabled', async () => {
      process.env.OPENID_DISCOVERY_RETRIES = '0';
      openidClient.discovery.mockReset();
      openidClient.discovery.mockRejectedValue(new Error('503 Service Unavailable'));

      const result = await setupOpenId();

      expect(result).toBeNull();
      expect(openidClient.discovery).toHaveBeenCalledTimes(1);
    });
  });

  describe('authorizationRequestParams', () => {
    const getLoginStrategy = () => require('openid-client/passport').__getStrategyByName('openid');

    it('adds a single OpenID audience to authorization requests', () => {
      process.env.OPENID_AUDIENCE = 'librechat';

      const params = getLoginStrategy().authorizationRequestParams({}, { state: 'login-state' });

      expect(params.get('audience')).toBe('librechat');
      expect(params.get('state')).toBe('login-state');
    });

    it('uses the first non-empty audience when OPENID_AUDIENCE accepts multiple JWT audiences', () => {
      process.env.OPENID_AUDIENCE = ' librechat , control-plane-web ';

      const params = getLoginStrategy().authorizationRequestParams({}, {});

      expect(params.get('audience')).toBe('librechat');
    });

    it('does not add an authorization audience when OPENID_AUDIENCE is empty', () => {
      process.env.OPENID_AUDIENCE = ' , ';

      const params = getLoginStrategy().authorizationRequestParams({}, {});

      expect(params.has('audience')).toBe(false);
    });
  });

  it('should create a new user with correct username when preferred_username claim exists', async () => {
    // Arrange – our userinfo already has preferred_username 'testusername'
    const userinfo = tokenset.claims();

    // Act
    const { user } = await validate(tokenset);

    // Assert
    expect(user.username).toBe(userinfo.preferred_username);
    expect(getOpenIdIssuer).toHaveBeenCalledTimes(1);
    expect(getOpenIdIssuer.mock.calls[0]).toHaveLength(2);
    expect(getOpenIdIssuer.mock.calls[0][0]).toEqual(userinfo);
    expect(getOpenIdIssuer.mock.calls[0][1]).toEqual(
      expect.objectContaining({ issuer: 'https://fake-issuer.com' }),
    );
    expect(createUser).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'openid',
        openidId: userinfo.sub,
        openidIssuer: 'https://fake-issuer.com',
        username: userinfo.preferred_username,
        email: userinfo.email,
        name: `${userinfo.given_name} ${userinfo.family_name}`,
      }),
      { enabled: false },
      true,
      true,
    );
  });

  it('should use username as username when preferred_username claim is missing', async () => {
    // Arrange – remove preferred_username from userinfo
    const userinfo = { ...tokenset.claims() };
    delete userinfo.preferred_username;
    // Expect the username to be the "username"
    const expectUsername = userinfo.username;

    // Act
    const { user } = await validate({ ...tokenset, claims: () => userinfo });

    // Assert
    expect(user.username).toBe(expectUsername);
    expect(createUser).toHaveBeenCalledWith(
      expect.objectContaining({ username: expectUsername }),
      { enabled: false },
      true,
      true,
    );
  });

  it('should use email as username when username and preferred_username are missing', async () => {
    // Arrange – remove username and preferred_username
    const userinfo = { ...tokenset.claims() };
    delete userinfo.username;
    delete userinfo.preferred_username;
    const expectUsername = userinfo.email;

    // Act
    const { user } = await validate({ ...tokenset, claims: () => userinfo });

    // Assert
    expect(user.username).toBe(expectUsername);
    expect(createUser).toHaveBeenCalledWith(
      expect.objectContaining({ username: expectUsername }),
      { enabled: false },
      true,
      true,
    );
  });

  it('should override username with OPENID_USERNAME_CLAIM when set', async () => {
    // Arrange – set OPENID_USERNAME_CLAIM so that the sub claim is used
    process.env.OPENID_USERNAME_CLAIM = 'sub';
    const userinfo = tokenset.claims();

    // Act
    const { user } = await validate(tokenset);

    // Assert – username should equal the sub (converted as-is)
    expect(user.username).toBe(userinfo.sub);
    expect(createUser).toHaveBeenCalledWith(
      expect.objectContaining({ username: userinfo.sub }),
      { enabled: false },
      true,
      true,
    );
  });

  it('should set the full name correctly when given_name and family_name exist', async () => {
    // Arrange
    const userinfo = tokenset.claims();
    const expectedFullName = `${userinfo.given_name} ${userinfo.family_name}`;

    // Act
    const { user } = await validate(tokenset);

    // Assert
    expect(user.name).toBe(expectedFullName);
  });

  it('should override full name with OPENID_NAME_CLAIM when set', async () => {
    // Arrange – use the name claim as the full name
    process.env.OPENID_NAME_CLAIM = 'name';
    const userinfo = { ...tokenset.claims(), name: 'Custom Name' };

    // Act
    const { user } = await validate({ ...tokenset, claims: () => userinfo });

    // Assert
    expect(user.name).toBe('Custom Name');
  });

  it('should update an existing user on login', async () => {
    // Arrange – simulate that a user already exists with openid provider
    const existingUser = {
      _id: 'existingUserId',
      provider: 'openid',
      email: tokenset.claims().email,
      openidId: '',
      username: '',
      name: '',
    };
    findUser.mockImplementation(async (query) => {
      if (query.openidId === tokenset.claims().sub || query.email === tokenset.claims().email) {
        return existingUser;
      }
      return null;
    });

    const userinfo = tokenset.claims();

    // Act
    await validate(tokenset);

    // Assert – updateUser should be called and the user object updated
    expect(updateUser).toHaveBeenCalledWith(
      existingUser._id,
      expect.objectContaining({
        provider: 'openid',
        openidId: userinfo.sub,
        openidIssuer: 'https://fake-issuer.com',
        username: userinfo.preferred_username,
        name: `${userinfo.given_name} ${userinfo.family_name}`,
      }),
    );
  });

  it('should block login when email exists with different provider', async () => {
    // Arrange – simulate that a user exists with same email but different provider
    const existingUser = {
      _id: 'existingUserId',
      provider: 'google',
      email: tokenset.claims().email,
      googleId: 'some-google-id',
      username: 'existinguser',
      name: 'Existing User',
    };
    findUser.mockImplementation(async (query) => {
      if (query.email === tokenset.claims().email && !query.provider) {
        return existingUser;
      }
      return null;
    });

    // Act
    const result = await validate(tokenset);

    // Assert – verify that the strategy rejects login
    expect(result.user).toBe(false);
    expect(result.details.message).toBe(ErrorTypes.AUTH_FAILED);
    expect(createUser).not.toHaveBeenCalled();
    expect(updateUser).not.toHaveBeenCalled();
  });

  it('should block login when email fallback finds user with mismatched openidId', async () => {
    const existingUser = {
      _id: 'existingUserId',
      provider: 'openid',
      openidId: 'different-sub-claim',
      email: tokenset.claims().email,
      username: 'existinguser',
      name: 'Existing User',
    };
    findUser.mockImplementation(async (query) => {
      if (query.$or) {
        return null;
      }
      if (query.email === tokenset.claims().email) {
        return existingUser;
      }
      return null;
    });

    const result = await validate(tokenset);

    expect(result.user).toBe(false);
    expect(result.details.message).toBe(ErrorTypes.AUTH_FAILED);
    expect(createUser).not.toHaveBeenCalled();
    expect(updateUser).not.toHaveBeenCalled();
  });

  it('should enforce the required role and reject login if missing', async () => {
    // Arrange – simulate a token without the required role.
    jwtDecode.mockReturnValue({
      roles: ['SomeOtherRole'],
    });

    // Act
    const { user, details } = await validate(tokenset);

    // Assert – verify that the strategy rejects login
    expect(user).toBe(false);
    expect(details.message).toBe('You must have "requiredRole" role to log in.');
  });

  it('should not treat substring matches in string roles as satisfying required role', async () => {
    // Arrange – override required role to "read" then re-setup
    process.env.OPENID_REQUIRED_ROLE = 'read';
    await setupOpenId();
    verifyCallback = require('openid-client/passport').__getVerifyCallbackByName('openid');

    // Token contains "bread" which *contains* "read" as a substring
    jwtDecode.mockReturnValue({
      roles: 'bread',
    });

    // Act
    const { user, details } = await validate(tokenset);

    // Assert – verify that substring match does not grant access
    expect(user).toBe(false);
    expect(details.message).toBe('You must have "read" role to log in.');
  });

  it('should allow login when roles claim is a space-separated string containing the required role', async () => {
    // Arrange – IdP returns roles as a space-delimited string
    jwtDecode.mockReturnValue({
      roles: 'role1 role2 requiredRole',
    });

    // Act
    const { user } = await validate(tokenset);

    // Assert – login succeeds when required role is present after splitting
    expect(user).toBeTruthy();
    expect(createUser).toHaveBeenCalled();
  });

  it('should allow login when roles claim is a comma-separated string containing the required role', async () => {
    // Arrange – IdP returns roles as a comma-delimited string
    jwtDecode.mockReturnValue({
      roles: 'role1,role2,requiredRole',
    });

    // Act
    const { user } = await validate(tokenset);

    // Assert – login succeeds when required role is present after splitting
    expect(user).toBeTruthy();
    expect(createUser).toHaveBeenCalled();
  });

  it('should allow login when roles claim is a mixed comma-and-space-separated string containing the required role', async () => {
    // Arrange – IdP returns roles with comma-and-space delimiters
    jwtDecode.mockReturnValue({
      roles: 'role1, role2, requiredRole',
    });

    // Act
    const { user } = await validate(tokenset);

    // Assert – login succeeds when required role is present after splitting
    expect(user).toBeTruthy();
    expect(createUser).toHaveBeenCalled();
  });

  it('should reject login when roles claim is a space-separated string that does not contain the required role', async () => {
    // Arrange – IdP returns a delimited string but required role is absent
    jwtDecode.mockReturnValue({
      roles: 'role1 role2 otherRole',
    });

    // Act
    const { user, details } = await validate(tokenset);

    // Assert – login is rejected with the correct error message
    expect(user).toBe(false);
    expect(details.message).toBe('You must have "requiredRole" role to log in.');
  });

  it('should allow login when single required role is present (backward compatibility)', async () => {
    // Arrange – ensure single role configuration (as set in beforeEach)
    // OPENID_REQUIRED_ROLE = 'requiredRole'
    // Default jwtDecode mock in beforeEach already returns this role
    jwtDecode.mockReturnValue({
      roles: ['requiredRole', 'anotherRole'],
    });

    // Act
    const { user } = await validate(tokenset);

    // Assert – verify that login succeeds with single role configuration
    expect(user).toBeTruthy();
    expect(user.email).toBe(tokenset.claims().email);
    expect(user.username).toBe(tokenset.claims().preferred_username);
    expect(createUser).toHaveBeenCalled();
  });

  it('should allow login when required role is found in userinfo claims', async () => {
    process.env.OPENID_REQUIRED_ROLE = 'requiredRole';
    process.env.OPENID_REQUIRED_ROLE_PARAMETER_PATH = 'roles';
    process.env.OPENID_REQUIRED_ROLE_TOKEN_KIND = 'userinfo';

    // The role is intentionally absent from the id_token and only present in
    // the userinfo response — exercises the userinfo branch of the switch.
    jwtDecode.mockReturnValue({});
    require('openid-client').fetchUserInfo.mockResolvedValue({
      roles: ['requiredRole'],
    });

    await setupOpenId();
    verifyCallback = require('openid-client/passport').__getVerifyCallbackByName('openid');

    const { user } = await validate(tokenset);

    expect(user).toBeTruthy();
    expect(user.email).toBe(tokenset.claims().email);
  });

  it('should reject login when required role is missing from userinfo claims', async () => {
    const { logger } = require('@librechat/data-schemas');
    process.env.OPENID_REQUIRED_ROLE = 'requiredRole';
    process.env.OPENID_REQUIRED_ROLE_PARAMETER_PATH = 'roles';
    process.env.OPENID_REQUIRED_ROLE_TOKEN_KIND = 'userinfo';

    jwtDecode.mockReturnValue({});
    require('openid-client').fetchUserInfo.mockResolvedValue({
      other_claim: 'value',
    });

    await setupOpenId();
    verifyCallback = require('openid-client/passport').__getVerifyCallbackByName('openid');

    const { user, details } = await validate(tokenset);

    expect(user).toBe(false);
    expect(details.message).toBe('You must have "requiredRole" role to log in.');
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining("Key 'roles' not found in userinfo token!"),
    );
  });

  it('should reject login with invalid required role token kind', async () => {
    const { logger } = require('@librechat/data-schemas');
    process.env.OPENID_REQUIRED_ROLE = 'requiredRole';
    process.env.OPENID_REQUIRED_ROLE_PARAMETER_PATH = 'roles';
    process.env.OPENID_REQUIRED_ROLE_TOKEN_KIND = 'invalid';

    jwtDecode.mockReturnValue({
      roles: ['requiredRole'],
    });

    await setupOpenId();
    verifyCallback = require('openid-client/passport').__getVerifyCallbackByName('openid');

    await expect(validate(tokenset)).rejects.toThrow('Invalid required role token kind');

    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining(
        "Invalid required role token kind: invalid. Must be one of 'access', 'id', or 'userinfo'",
      ),
    );
  });

  describe('group overage and groups handling', () => {
    it.each([
      ['groups array contains required group', ['group-required', 'other-group'], true, undefined],
      [
        'groups array missing required group',
        ['other-group'],
        false,
        'You must have "group-required" role to log in.',
      ],
      ['groups string equals required group', 'group-required', true, undefined],
      [
        'groups string is other group',
        'other-group',
        false,
        'You must have "group-required" role to log in.',
      ],
    ])(
      'uses groups claim directly when %s (no overage)',
      async (_label, groupsClaim, expectedAllowed, expectedMessage) => {
        process.env.OPENID_REQUIRED_ROLE = 'group-required';
        process.env.OPENID_REQUIRED_ROLE_PARAMETER_PATH = 'groups';
        process.env.OPENID_REQUIRED_ROLE_TOKEN_KIND = 'id';

        jwtDecode.mockReturnValue({
          groups: groupsClaim,
          permissions: ['admin'],
        });

        await setupOpenId();
        verifyCallback = require('openid-client/passport').__getVerifyCallbackByName('openid');

        const { user, details } = await validate(tokenset);

        expect(undici.fetch).not.toHaveBeenCalled();
        expect(Boolean(user)).toBe(expectedAllowed);
        expect(details?.message).toBe(expectedMessage);
      },
    );

    it.each([
      ['token kind is not id', { kind: 'access', path: 'groups', decoded: { hasgroups: true } }],
      ['parameter path is not groups', { kind: 'id', path: 'roles', decoded: { hasgroups: true } }],
      ['decoded token is falsy', { kind: 'id', path: 'groups', decoded: null }],
      [
        'no overage indicators in decoded token',
        {
          kind: 'id',
          path: 'groups',
          decoded: {
            permissions: ['admin'],
          },
        },
      ],
      [
        'only _claim_names present (no _claim_sources)',
        {
          kind: 'id',
          path: 'groups',
          decoded: {
            _claim_names: { groups: 'src1' },
            permissions: ['admin'],
          },
        },
      ],
      [
        'only _claim_sources present (no _claim_names)',
        {
          kind: 'id',
          path: 'groups',
          decoded: {
            _claim_sources: { src1: { endpoint: 'https://graph.windows.net/ignored' } },
            permissions: ['admin'],
          },
        },
      ],
    ])('does not attempt overage resolution when %s', async (_label, cfg) => {
      process.env.OPENID_REQUIRED_ROLE = 'group-required';
      process.env.OPENID_REQUIRED_ROLE_PARAMETER_PATH = cfg.path;
      process.env.OPENID_REQUIRED_ROLE_TOKEN_KIND = cfg.kind;

      jwtDecode.mockReturnValue(cfg.decoded);

      await setupOpenId();
      verifyCallback = require('openid-client/passport').__getVerifyCallbackByName('openid');

      const { user, details } = await validate(tokenset);

      expect(undici.fetch).not.toHaveBeenCalled();
      expect(user).toBe(false);
      expect(details.message).toBe('You must have "group-required" role to log in.');
      const { logger } = require('@librechat/data-schemas');
      const expectedTokenKind = cfg.kind === 'access' ? 'access token' : 'id token';
      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining(`Key '${cfg.path}' not found in ${expectedTokenKind}!`),
      );
    });
  });

  describe('resolving groups via Microsoft Graph', () => {
    it('denies login and does not call Graph when access token is missing', async () => {
      process.env.OPENID_REQUIRED_ROLE = 'group-required';
      process.env.OPENID_REQUIRED_ROLE_PARAMETER_PATH = 'groups';
      process.env.OPENID_REQUIRED_ROLE_TOKEN_KIND = 'id';

      const { logger } = require('@librechat/data-schemas');

      jwtDecode.mockReturnValue({
        hasgroups: true,
        permissions: ['admin'],
      });

      await setupOpenId();
      verifyCallback = require('openid-client/passport').__getVerifyCallbackByName('openid');

      const tokensetWithoutAccess = {
        ...tokenset,
        access_token: undefined,
      };

      const { user, details } = await validate(tokensetWithoutAccess);

      expect(user).toBe(false);
      expect(details.message).toBe('You must have "group-required" role to log in.');

      expect(undici.fetch).not.toHaveBeenCalled();
      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('Access token missing; cannot resolve group overage'),
      );
    });

    it.each([
      [
        'Graph returns HTTP error',
        async () => ({
          ok: false,
          status: 403,
          statusText: 'Forbidden',
          json: async () => ({}),
        }),
        [
          '[openidStrategy] Failed to resolve groups via Microsoft Graph getMemberObjects: HTTP 403 Forbidden',
        ],
      ],
      [
        'Graph network error',
        async () => {
          throw new Error('network error');
        },
        [
          '[openidStrategy] Error resolving groups via Microsoft Graph getMemberObjects:',
          expect.any(Error),
        ],
      ],
      [
        'Graph returns unexpected shape (no value)',
        async () => ({
          ok: true,
          status: 200,
          statusText: 'OK',
          json: async () => ({}),
        }),
        [
          '[openidStrategy] Unexpected response format when resolving groups via Microsoft Graph getMemberObjects',
        ],
      ],
      [
        'Graph returns invalid value type',
        async () => ({
          ok: true,
          status: 200,
          statusText: 'OK',
          json: async () => ({ value: 'not-an-array' }),
        }),
        [
          '[openidStrategy] Unexpected response format when resolving groups via Microsoft Graph getMemberObjects',
        ],
      ],
    ])(
      'denies login when overage resolution fails because %s',
      async (_label, setupFetch, expectedErrorArgs) => {
        process.env.OPENID_REQUIRED_ROLE = 'group-required';
        process.env.OPENID_REQUIRED_ROLE_PARAMETER_PATH = 'groups';
        process.env.OPENID_REQUIRED_ROLE_TOKEN_KIND = 'id';

        const { logger } = require('@librechat/data-schemas');

        jwtDecode.mockReturnValue({
          hasgroups: true,
          permissions: ['admin'],
        });

        await setupOpenId();
        verifyCallback = require('openid-client/passport').__getVerifyCallbackByName('openid');

        undici.fetch.mockImplementation(setupFetch);

        const { user, details } = await validate(tokenset);

        expect(undici.fetch).toHaveBeenCalled();
        expect(user).toBe(false);
        expect(details.message).toBe('You must have "group-required" role to log in.');

        expect(logger.error).toHaveBeenCalledWith(...expectedErrorArgs);
      },
    );

    it.each([
      [
        'hasgroups overage and Graph contains required group',
        {
          hasgroups: true,
        },
        ['group-required', 'some-other-group'],
        true,
      ],
      [
        '_claim_* overage and Graph contains required group',
        {
          _claim_names: { groups: 'src1' },
          _claim_sources: { src1: { endpoint: 'https://graph.windows.net/ignored' } },
        },
        ['group-required', 'some-other-group'],
        true,
      ],
      [
        'hasgroups overage and Graph does NOT contain required group',
        {
          hasgroups: true,
        },
        ['some-other-group'],
        false,
      ],
      [
        '_claim_* overage and Graph does NOT contain required group',
        {
          _claim_names: { groups: 'src1' },
          _claim_sources: { src1: { endpoint: 'https://graph.windows.net/ignored' } },
        },
        ['some-other-group'],
        false,
      ],
    ])(
      'resolves groups via Microsoft Graph when %s',
      async (_label, decodedTokenValue, graphGroups, expectedAllowed) => {
        process.env.OPENID_REQUIRED_ROLE = 'group-required';
        process.env.OPENID_REQUIRED_ROLE_PARAMETER_PATH = 'groups';
        process.env.OPENID_REQUIRED_ROLE_TOKEN_KIND = 'id';

        const { logger } = require('@librechat/data-schemas');

        jwtDecode.mockReturnValue(decodedTokenValue);

        await setupOpenId();
        verifyCallback = require('openid-client/passport').__getVerifyCallbackByName('openid');

        undici.fetch.mockResolvedValue({
          ok: true,
          status: 200,
          statusText: 'OK',
          json: async () => ({
            value: graphGroups,
          }),
        });

        const { user } = await validate(tokenset);

        expect(undici.fetch).toHaveBeenCalledWith(
          'https://graph.microsoft.com/v1.0/me/getMemberObjects',
          expect.objectContaining({
            method: 'POST',
            headers: expect.objectContaining({
              Authorization: 'Bearer exchanged_graph_token',
            }),
          }),
        );
        expect(Boolean(user)).toBe(expectedAllowed);

        expect(logger.debug).toHaveBeenCalledWith(
          expect.stringContaining(
            `Successfully resolved ${graphGroups.length} groups via Microsoft Graph getMemberObjects`,
          ),
        );
      },
    );
  });

  describe('OBO token exchange for overage', () => {
    beforeEach(() => {
      delete process.env.OPENID_ADMIN_ROLE;
    });

    it('exchanges access token via OBO before calling Graph API', async () => {
      const openidClient = require('openid-client');
      process.env.OPENID_REQUIRED_ROLE = 'group-required';
      process.env.OPENID_REQUIRED_ROLE_PARAMETER_PATH = 'groups';
      process.env.OPENID_REQUIRED_ROLE_TOKEN_KIND = 'id';

      jwtDecode.mockReturnValue({ hasgroups: true });

      await setupOpenId();
      verifyCallback = require('openid-client/passport').__getVerifyCallbackByName('openid');

      undici.fetch.mockResolvedValue({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({ value: ['group-required'] }),
      });

      await validate(tokenset);

      expect(openidClient.genericGrantRequest).toHaveBeenCalledWith(
        expect.anything(),
        'urn:ietf:params:oauth:grant-type:jwt-bearer',
        expect.objectContaining({
          scope: 'https://graph.microsoft.com/User.Read',
          assertion: tokenset.access_token,
          requested_token_use: 'on_behalf_of',
        }),
      );

      expect(undici.fetch).toHaveBeenCalledWith(
        'https://graph.microsoft.com/v1.0/me/getMemberObjects',
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: 'Bearer exchanged_graph_token',
          }),
        }),
      );
    });

    it('caches the exchanged token and reuses it on subsequent calls', async () => {
      const openidClient = require('openid-client');
      const getLogStores = require('~/cache/getLogStores');
      const mockSet = jest.fn();
      const mockGet = jest
        .fn()
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce({ access_token: 'exchanged_graph_token' });
      getLogStores.mockReturnValue({ get: mockGet, set: mockSet });

      process.env.OPENID_REQUIRED_ROLE = 'group-required';
      process.env.OPENID_REQUIRED_ROLE_PARAMETER_PATH = 'groups';
      process.env.OPENID_REQUIRED_ROLE_TOKEN_KIND = 'id';

      jwtDecode.mockReturnValue({ hasgroups: true });

      await setupOpenId();
      verifyCallback = require('openid-client/passport').__getVerifyCallbackByName('openid');

      undici.fetch.mockResolvedValue({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({ value: ['group-required'] }),
      });

      // First call: cache miss → OBO exchange → cache set
      await validate(tokenset);
      /** The entry expires 30s (OPENID_EXPIRY_BUFFER_SECONDS) before the credential it holds, so a
       *  token served from cache cannot expire in transit and 401 downstream. */
      expect(mockSet).toHaveBeenCalledWith(
        '1234:overage',
        { access_token: 'exchanged_graph_token' },
        3570000,
      );
      expect(openidClient.genericGrantRequest).toHaveBeenCalledTimes(1);

      // Second call: cache hit → no new OBO exchange
      openidClient.genericGrantRequest.mockClear();
      await validate(tokenset);
      expect(openidClient.genericGrantRequest).not.toHaveBeenCalled();
    });
  });

  describe('admin role group overage', () => {
    it('resolves admin groups via Graph when overage is detected for admin role', async () => {
      process.env.OPENID_REQUIRED_ROLE = 'group-required';
      process.env.OPENID_REQUIRED_ROLE_PARAMETER_PATH = 'groups';
      process.env.OPENID_REQUIRED_ROLE_TOKEN_KIND = 'id';
      process.env.OPENID_ADMIN_ROLE = 'admin-group-id';
      process.env.OPENID_ADMIN_ROLE_PARAMETER_PATH = 'groups';
      process.env.OPENID_ADMIN_ROLE_TOKEN_KIND = 'id';

      jwtDecode.mockReturnValue({ hasgroups: true });

      await setupOpenId();
      verifyCallback = require('openid-client/passport').__getVerifyCallbackByName('openid');

      undici.fetch.mockResolvedValue({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({ value: ['group-required', 'admin-group-id'] }),
      });

      const { user } = await validate(tokenset);

      expect(user.role).toBe('ADMIN');
    });

    it('does not grant admin when overage groups do not contain admin role', async () => {
      process.env.OPENID_REQUIRED_ROLE = 'group-required';
      process.env.OPENID_REQUIRED_ROLE_PARAMETER_PATH = 'groups';
      process.env.OPENID_REQUIRED_ROLE_TOKEN_KIND = 'id';
      process.env.OPENID_ADMIN_ROLE = 'admin-group-id';
      process.env.OPENID_ADMIN_ROLE_PARAMETER_PATH = 'groups';
      process.env.OPENID_ADMIN_ROLE_TOKEN_KIND = 'id';

      jwtDecode.mockReturnValue({ hasgroups: true });

      await setupOpenId();
      verifyCallback = require('openid-client/passport').__getVerifyCallbackByName('openid');

      undici.fetch.mockResolvedValue({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({ value: ['group-required', 'other-group'] }),
      });

      const { user } = await validate(tokenset);

      expect(user).toBeTruthy();
      expect(user.role).toBeUndefined();
    });

    it('reuses already-resolved overage groups for admin role check (no duplicate Graph call)', async () => {
      process.env.OPENID_REQUIRED_ROLE = 'group-required';
      process.env.OPENID_REQUIRED_ROLE_PARAMETER_PATH = 'groups';
      process.env.OPENID_REQUIRED_ROLE_TOKEN_KIND = 'id';
      process.env.OPENID_ADMIN_ROLE = 'admin-group-id';
      process.env.OPENID_ADMIN_ROLE_PARAMETER_PATH = 'groups';
      process.env.OPENID_ADMIN_ROLE_TOKEN_KIND = 'id';

      jwtDecode.mockReturnValue({ hasgroups: true });

      await setupOpenId();
      verifyCallback = require('openid-client/passport').__getVerifyCallbackByName('openid');

      undici.fetch.mockResolvedValue({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({ value: ['group-required', 'admin-group-id'] }),
      });

      await validate(tokenset);

      // Graph API should be called only once (for required role), admin role reuses the result
      expect(undici.fetch).toHaveBeenCalledTimes(1);
    });

    it('demotes existing admin when overage groups no longer contain admin role', async () => {
      process.env.OPENID_REQUIRED_ROLE = 'group-required';
      process.env.OPENID_REQUIRED_ROLE_PARAMETER_PATH = 'groups';
      process.env.OPENID_REQUIRED_ROLE_TOKEN_KIND = 'id';
      process.env.OPENID_ADMIN_ROLE = 'admin-group-id';
      process.env.OPENID_ADMIN_ROLE_PARAMETER_PATH = 'groups';
      process.env.OPENID_ADMIN_ROLE_TOKEN_KIND = 'id';

      const existingAdminUser = {
        _id: 'existingAdminId',
        provider: 'openid',
        email: tokenset.claims().email,
        openidId: tokenset.claims().sub,
        username: 'adminuser',
        name: 'Admin User',
        role: 'ADMIN',
      };

      findUser.mockImplementation(async (query) => {
        if (query.openidId === tokenset.claims().sub || query.email === tokenset.claims().email) {
          return existingAdminUser;
        }
        return null;
      });

      jwtDecode.mockReturnValue({ hasgroups: true });

      await setupOpenId();
      verifyCallback = require('openid-client/passport').__getVerifyCallbackByName('openid');

      undici.fetch.mockResolvedValue({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({ value: ['group-required'] }),
      });

      const { user } = await validate(tokenset);

      expect(user.role).toBe('USER');
    });

    it('does not attempt overage for admin role when token kind is not id', async () => {
      process.env.OPENID_REQUIRED_ROLE = 'requiredRole';
      process.env.OPENID_REQUIRED_ROLE_PARAMETER_PATH = 'roles';
      process.env.OPENID_REQUIRED_ROLE_TOKEN_KIND = 'id';
      process.env.OPENID_ADMIN_ROLE = 'admin';
      process.env.OPENID_ADMIN_ROLE_PARAMETER_PATH = 'groups';
      process.env.OPENID_ADMIN_ROLE_TOKEN_KIND = 'access';

      jwtDecode.mockReturnValue({
        roles: ['requiredRole'],
        hasgroups: true,
      });

      await setupOpenId();
      verifyCallback = require('openid-client/passport').__getVerifyCallbackByName('openid');

      const { user } = await validate(tokenset);

      // No Graph call since admin uses access token (not id)
      expect(undici.fetch).not.toHaveBeenCalled();
      expect(user.role).toBeUndefined();
    });

    it('resolves admin via Graph independently when OPENID_REQUIRED_ROLE is not configured', async () => {
      delete process.env.OPENID_REQUIRED_ROLE;
      process.env.OPENID_ADMIN_ROLE = 'admin-group-id';
      process.env.OPENID_ADMIN_ROLE_PARAMETER_PATH = 'groups';
      process.env.OPENID_ADMIN_ROLE_TOKEN_KIND = 'id';

      jwtDecode.mockReturnValue({ hasgroups: true });
      await setupOpenId();
      verifyCallback = require('openid-client/passport').__getVerifyCallbackByName('openid');

      undici.fetch.mockResolvedValue({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({ value: ['admin-group-id'] }),
      });

      const { user } = await validate(tokenset);
      expect(user.role).toBe('ADMIN');
      expect(undici.fetch).toHaveBeenCalledTimes(1);
    });

    it('denies admin when OPENID_REQUIRED_ROLE is absent and Graph does not contain admin group', async () => {
      delete process.env.OPENID_REQUIRED_ROLE;
      process.env.OPENID_ADMIN_ROLE = 'admin-group-id';
      process.env.OPENID_ADMIN_ROLE_PARAMETER_PATH = 'groups';
      process.env.OPENID_ADMIN_ROLE_TOKEN_KIND = 'id';

      jwtDecode.mockReturnValue({ hasgroups: true });
      await setupOpenId();
      verifyCallback = require('openid-client/passport').__getVerifyCallbackByName('openid');

      undici.fetch.mockResolvedValue({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({ value: ['other-group'] }),
      });

      const { user } = await validate(tokenset);
      expect(user).toBeTruthy();
      expect(user.role).toBeUndefined();
    });

    it('denies login and logs error when OBO exchange throws', async () => {
      const openidClient = require('openid-client');
      process.env.OPENID_REQUIRED_ROLE = 'group-required';
      process.env.OPENID_REQUIRED_ROLE_PARAMETER_PATH = 'groups';
      process.env.OPENID_REQUIRED_ROLE_TOKEN_KIND = 'id';

      jwtDecode.mockReturnValue({ hasgroups: true });
      openidClient.genericGrantRequest.mockRejectedValueOnce(new Error('OBO exchange rejected'));

      await setupOpenId();
      verifyCallback = require('openid-client/passport').__getVerifyCallbackByName('openid');

      const { user, details } = await validate(tokenset);
      expect(user).toBe(false);
      expect(details.message).toBe('You must have "group-required" role to log in.');
      expect(undici.fetch).not.toHaveBeenCalled();
    });

    it('denies login when OBO exchange returns no access_token', async () => {
      const openidClient = require('openid-client');
      process.env.OPENID_REQUIRED_ROLE = 'group-required';
      process.env.OPENID_REQUIRED_ROLE_PARAMETER_PATH = 'groups';
      process.env.OPENID_REQUIRED_ROLE_TOKEN_KIND = 'id';

      jwtDecode.mockReturnValue({ hasgroups: true });
      openidClient.genericGrantRequest.mockResolvedValueOnce({ expires_in: 3600 });

      await setupOpenId();
      verifyCallback = require('openid-client/passport').__getVerifyCallbackByName('openid');

      const { user, details } = await validate(tokenset);
      expect(user).toBe(false);
      expect(details.message).toBe('You must have "group-required" role to log in.');
      expect(undici.fetch).not.toHaveBeenCalled();
    });
  });

  it('should process and save the avatar through the shared avatar path if picture is provided', async () => {
    const { getStrategyFunctions } = require('~/server/services/Files/strategies');

    // Act
    const { user } = await validate(tokenset);
    const strategyResult =
      getStrategyFunctions.mock.results[getStrategyFunctions.mock.results.length - 1];
    const { saveBuffer } = strategyResult.value;
    const [saveParams] = saveBuffer.mock.calls[0];

    expect(resizeAvatar).toHaveBeenCalledWith({
      userId: 'newUserId',
      input: 'https://example.com/avatar.png',
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(saveParams).toEqual(
      expect.objectContaining({
        fileName: 'hashed-token.png',
        userId: 'newUserId',
        buffer: expect.any(Buffer),
      }),
    );
    expect(saveParams).not.toHaveProperty('basePath');
    // Our mock getStrategyFunctions.saveBuffer returns '/fake/path/to/avatar.png'
    expect(user.avatar).toBe('/fake/path/to/avatar.png');
  });

  it('uses only the shared avatar processor for OpenID picture URLs', async () => {
    await validate(tokenset);

    expect(resizeAvatar).toHaveBeenCalledWith({
      userId: 'newUserId',
      input: 'https://example.com/avatar.png',
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('adds auth headers for configured OpenID avatar origins', async () => {
    process.env.OPENID_AVATAR_AUTHORIZED_ORIGINS = 'https://example.com';

    await validate(tokenset);

    expect(resizeAvatar).toHaveBeenCalledWith({
      userId: 'newUserId',
      input: 'https://example.com/avatar.png',
      fetchOptions: {
        headers: {
          Authorization: 'Bearer fake_access_token',
        },
      },
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('continues login when shared avatar processing rejects the picture URL', async () => {
    const { getStrategyFunctions } = require('~/server/services/Files/strategies');
    resizeAvatar.mockRejectedValueOnce(new Error('avatar processing failed'));

    const { user } = await validate(tokenset);

    expect(user).toBeTruthy();
    expect(user.avatar).toBeUndefined();
    expect(getStrategyFunctions).not.toHaveBeenCalled();
  });

  it('should save CloudFront IdP avatars under the shared avatar prefix', async () => {
    const { getStrategyFunctions } = require('~/server/services/Files/strategies');
    getAppConfig.mockResolvedValueOnce({ fileStrategy: mockCloudfrontFileSource });

    const { user } = await validate(tokenset);
    const strategyResult =
      getStrategyFunctions.mock.results[getStrategyFunctions.mock.results.length - 1];
    const { saveBuffer } = strategyResult.value;
    const [saveParams] = saveBuffer.mock.calls[0];

    expect(getStrategyFunctions).toHaveBeenLastCalledWith(mockCloudfrontFileSource);
    expect(resizeAvatar).toHaveBeenCalledWith({
      userId: 'newUserId',
      input: 'https://example.com/avatar.png',
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(saveParams).toEqual(
      expect.objectContaining({
        basePath: 'avatars',
        fileName: 'hashed-token.png',
        userId: 'newUserId',
      }),
    );
    expect(user.avatar).toBe('/fake/path/to/avatar.png');
  });

  it('should not attempt to download avatar if picture is not provided', async () => {
    // Arrange – remove picture
    const userinfo = { ...tokenset.claims() };
    delete userinfo.picture;

    // Act
    await validate({ ...tokenset, claims: () => userinfo });

    // Assert – fetch should not be called and avatar should remain undefined or empty
    expect(fetch).not.toHaveBeenCalled();
    expect(resizeAvatar).not.toHaveBeenCalled();
    // Depending on your implementation, user.avatar may be undefined or an empty string.
  });

  it('should support comma-separated multiple roles', async () => {
    // Arrange
    process.env.OPENID_REQUIRED_ROLE = 'someRole,anotherRole,admin';
    await setupOpenId(); // Re-initialize the strategy
    verifyCallback = require('openid-client/passport').__getVerifyCallbackByName('openid');
    jwtDecode.mockReturnValue({
      roles: ['anotherRole', 'aThirdRole'],
    });

    // Act
    const { user } = await validate(tokenset);

    // Assert
    expect(user).toBeTruthy();
    expect(user.email).toBe(tokenset.claims().email);
  });

  it('should reject login when user has none of the required multiple roles', async () => {
    // Arrange
    process.env.OPENID_REQUIRED_ROLE = 'someRole,anotherRole,admin';
    await setupOpenId(); // Re-initialize the strategy
    verifyCallback = require('openid-client/passport').__getVerifyCallbackByName('openid');
    jwtDecode.mockReturnValue({
      roles: ['aThirdRole', 'aFourthRole'],
    });

    // Act
    const { user, details } = await validate(tokenset);

    // Assert
    expect(user).toBe(false);
    expect(details.message).toBe(
      'You must have one of: "someRole", "anotherRole", "admin" role to log in.',
    );
  });

  it('should handle spaces in comma-separated roles', async () => {
    // Arrange
    process.env.OPENID_REQUIRED_ROLE = ' someRole , anotherRole , admin ';
    await setupOpenId(); // Re-initialize the strategy
    verifyCallback = require('openid-client/passport').__getVerifyCallbackByName('openid');
    jwtDecode.mockReturnValue({
      roles: ['someRole'],
    });

    // Act
    const { user } = await validate(tokenset);

    // Assert
    expect(user).toBeTruthy();
  });

  it('should default to usePKCE false when OPENID_USE_PKCE is not defined', async () => {
    const OpenIDStrategy = require('openid-client/passport').Strategy;

    delete process.env.OPENID_USE_PKCE;
    await setupOpenId();

    const callOptions = OpenIDStrategy.mock.calls[OpenIDStrategy.mock.calls.length - 1][0];
    expect(callOptions.usePKCE).toBe(false);
    expect(callOptions.params?.code_challenge_method).toBeUndefined();
  });

  it('should attach federatedTokens to user object for token propagation', async () => {
    // Arrange - setup tokenset with access token, id token, refresh token, and expiration
    const tokensetWithTokens = {
      ...tokenset,
      access_token: 'mock_access_token_abc123',
      id_token: 'mock_id_token_def456',
      refresh_token: 'mock_refresh_token_xyz789',
      expires_at: 1234567890,
    };

    // Act - validate with the tokenset containing tokens
    const { user } = await validate(tokensetWithTokens);

    // Assert - verify federatedTokens object is attached with correct values
    expect(user.federatedTokens).toBeDefined();
    expect(user.federatedTokens).toEqual({
      access_token: 'mock_access_token_abc123',
      id_token: 'mock_id_token_def456',
      refresh_token: 'mock_refresh_token_xyz789',
      expires_at: 1234567890,
    });
  });

  it('should include id_token in federatedTokens distinct from access_token', async () => {
    // Arrange - use different values for access_token and id_token
    const tokensetWithTokens = {
      ...tokenset,
      access_token: 'the_access_token',
      id_token: 'the_id_token',
      refresh_token: 'the_refresh_token',
      expires_at: 9999999999,
    };

    // Act
    const { user } = await validate(tokensetWithTokens);

    // Assert - id_token and access_token must be different values
    expect(user.federatedTokens.access_token).toBe('the_access_token');
    expect(user.federatedTokens.id_token).toBe('the_id_token');
    expect(user.federatedTokens.id_token).not.toBe(user.federatedTokens.access_token);
  });

  it('should include tokenset along with federatedTokens', async () => {
    // Arrange
    const tokensetWithTokens = {
      ...tokenset,
      access_token: 'test_access_token',
      id_token: 'test_id_token',
      refresh_token: 'test_refresh_token',
      expires_at: 9999999999,
    };

    // Act
    const { user } = await validate(tokensetWithTokens);

    // Assert - both tokenset and federatedTokens should be present
    expect(user.tokenset).toBeDefined();
    expect(user.federatedTokens).toBeDefined();
    expect(user.tokenset.access_token).toBe('test_access_token');
    expect(user.tokenset.id_token).toBe('test_id_token');
    expect(user.federatedTokens.access_token).toBe('test_access_token');
    expect(user.federatedTokens.id_token).toBe('test_id_token');
  });

  it('should set role to "ADMIN" if OPENID_ADMIN_ROLE is set and user has that role', async () => {
    // Act
    const { user } = await validate(tokenset);

    // Assert – verify that the user role is set to "ADMIN"
    expect(user.role).toBe('ADMIN');
  });

  it('should not set user role if OPENID_ADMIN_ROLE is set but the user does not have that role', async () => {
    // Arrange – simulate a token without the admin permission
    jwtDecode.mockReturnValue({
      roles: ['requiredRole'],
      permissions: ['not-admin'],
    });

    // Act
    const { user } = await validate(tokenset);

    // Assert – verify that the user role is not defined
    expect(user.role).toBeUndefined();
  });

  describe('OpenID role sync', () => {
    beforeEach(() => {
      process.env.OPENID_ROLE_SYNC_ENABLED = 'true';
      process.env.OPENID_ROLE_SYNC_SOURCE = 'id';
      process.env.OPENID_ROLE_SYNC_CLAIM = 'roles';
      process.env.OPENID_ROLE_SYNC_ROLE_PRIORITY = 'STANDARD-USER,BASIC-USER';
      process.env.OPENID_ROLE_SYNC_FALLBACK_ROLE = 'USER';
    });

    it('selects the highest configured matching role from the OpenID token', async () => {
      jwtDecode.mockReturnValue({
        roles: ['requiredRole', 'BASIC-USER', 'STANDARD-USER'],
        permissions: ['not-admin'],
      });

      const { user } = await validate(tokenset);

      expect(user.role).toBe('STANDARD-USER');
      expect(updateUser).toHaveBeenCalledWith(
        'newUserId',
        expect.objectContaining({ role: 'STANDARD-USER' }),
      );
    });

    it('does not run when disabled', async () => {
      delete process.env.OPENID_ROLE_SYNC_ENABLED;
      jwtDecode.mockReturnValue({
        roles: ['requiredRole', 'STANDARD-USER'],
        permissions: ['not-admin'],
      });

      const { user } = await validate(tokenset);

      expect(user.role).toBeUndefined();
      expect(findRolesByNames).not.toHaveBeenCalled();
    });

    it('leaves ADMIN authoritative when OPENID_ADMIN_ROLE grants admin', async () => {
      jwtDecode.mockReturnValue({
        roles: ['requiredRole', 'STANDARD-USER'],
        permissions: ['admin'],
      });

      const { user } = await validate(tokenset);

      expect(user.role).toBe('ADMIN');
    });

    it('preserves an existing ADMIN role when admin is manually assigned', async () => {
      delete process.env.OPENID_ADMIN_ROLE;
      delete process.env.OPENID_ADMIN_ROLE_PARAMETER_PATH;
      delete process.env.OPENID_ADMIN_ROLE_TOKEN_KIND;
      const existingAdminUser = {
        _id: 'existingAdminId',
        provider: 'openid',
        email: tokenset.claims().email,
        openidId: tokenset.claims().sub,
        username: 'adminuser',
        name: 'Admin User',
        role: 'ADMIN',
      };

      findUser.mockImplementation(async (query) => {
        if (query.openidId === tokenset.claims().sub || query.email === tokenset.claims().email) {
          return existingAdminUser;
        }
        return null;
      });
      jwtDecode.mockReturnValue({
        roles: ['requiredRole', 'STANDARD-USER'],
        permissions: ['not-admin'],
      });

      const { user } = await validate(tokenset);

      expect(user.role).toBe('ADMIN');
      expect(findRolesByNames).not.toHaveBeenCalled();
    });

    it('uses fallback when a valid role claim has no configured role match', async () => {
      jwtDecode.mockReturnValue({
        roles: ['requiredRole', 'external-role'],
        permissions: ['not-admin'],
      });

      const { user } = await validate(tokenset);

      expect(user.role).toBe('USER');
    });

    it('uses fallback when the role claim is present but empty', async () => {
      // The required-role gate reads the same `roles` claim this test empties, so
      // disable it to model an IdP that authenticates the user yet emits no roles.
      delete process.env.OPENID_REQUIRED_ROLE;
      jwtDecode.mockReturnValue({
        roles: '',
        permissions: ['not-admin'],
      });

      const { user } = await validate(tokenset);

      expect(user.role).toBe('USER');
      expect(updateUser).toHaveBeenCalledWith(
        'newUserId',
        expect.objectContaining({ role: 'USER' }),
      );
    });

    it('applies fallback when the role claim is absent from the token', async () => {
      // Required-role gate reads the same `roles` claim; disable it to model an IdP
      // that authenticates the user but stops emitting the role claim entirely.
      delete process.env.OPENID_REQUIRED_ROLE;
      jwtDecode.mockReturnValue({
        permissions: ['not-admin'],
      });

      const { user } = await validate(tokenset);

      expect(user.role).toBe('USER');
      expect(updateUser).toHaveBeenCalledWith(
        'newUserId',
        expect.objectContaining({ role: 'USER' }),
      );
    });

    it('rejects login when configured sync roles do not exist', async () => {
      findRolesByNames.mockImplementation(async (roleNames) =>
        roleNames
          .filter((roleName) => roleName !== 'STANDARD-USER')
          .map((roleName) => ({ name: roleName })),
      );
      jwtDecode.mockReturnValue({
        roles: ['requiredRole', 'STANDARD-USER'],
        permissions: ['not-admin'],
      });

      await expect(validate(tokenset)).rejects.toThrow(
        'OpenID role sync configured roles do not exist: STANDARD-USER',
      );
    });

    it('can assign a non-admin role after the existing admin demotion path runs', async () => {
      const existingAdminUser = {
        _id: 'existingAdminId',
        provider: 'openid',
        email: tokenset.claims().email,
        openidId: tokenset.claims().sub,
        username: 'adminuser',
        name: 'Admin User',
        role: 'ADMIN',
      };

      findUser.mockImplementation(async (query) => {
        if (query.openidId === tokenset.claims().sub || query.email === tokenset.claims().email) {
          return existingAdminUser;
        }
        return null;
      });
      jwtDecode.mockReturnValue({
        roles: ['requiredRole', 'STANDARD-USER'],
        permissions: ['not-admin'],
      });

      const { user } = await validate(tokenset);

      expect(user.role).toBe('STANDARD-USER');
      expect(updateUser).toHaveBeenCalledWith(
        existingAdminUser._id,
        expect.objectContaining({ role: 'STANDARD-USER' }),
      );
    });

    it('wraps role lookup in tenant context for tenant users', async () => {
      const existingUser = {
        _id: 'existingTenantUserId',
        provider: 'openid',
        email: tokenset.claims().email,
        openidId: tokenset.claims().sub,
        username: 'tenantuser',
        name: 'Tenant User',
        tenantId: 'tenant-a',
        role: 'USER',
      };
      const { tenantStorage } = require('@librechat/data-schemas');

      findUser.mockImplementation(async (query) => {
        if (query.openidId === tokenset.claims().sub || query.email === tokenset.claims().email) {
          return existingUser;
        }
        return null;
      });
      jwtDecode.mockReturnValue({
        roles: ['requiredRole', 'BASIC-USER'],
        permissions: ['not-admin'],
      });

      const { user } = await validate(tokenset);

      expect(user.role).toBe('BASIC-USER');
      expect(tenantStorage.run).toHaveBeenCalledWith(
        { tenantId: 'tenant-a' },
        expect.any(Function),
      );
    });

    it('re-enforces tenant login policy after role sync changes the role', async () => {
      const existingUser = {
        _id: 'existingTenantUserId',
        provider: 'openid',
        email: tokenset.claims().email,
        openidId: tokenset.claims().sub,
        username: 'tenantuser',
        name: 'Tenant User',
        tenantId: 'tenant-a',
        role: 'USER',
      };
      const { isEmailDomainAllowed } = require('@librechat/api');

      findUser.mockImplementation(async (query) => {
        if (query.openidId === tokenset.claims().sub || query.email === tokenset.claims().email) {
          return existingUser;
        }
        return null;
      });
      jwtDecode.mockReturnValue({
        roles: ['requiredRole', 'BASIC-USER'],
        permissions: ['not-admin'],
      });
      // Pre-sync domain check passes; the post-sync re-resolved config rejects the domain.
      isEmailDomainAllowed.mockReturnValueOnce(true).mockReturnValueOnce(false);
      resolveAppConfigForUser.mockResolvedValue({
        registration: { allowedDomains: ['restricted.com'] },
      });

      const { user, details } = await validate(tokenset);

      expect(user).toBe(false);
      expect(details).toEqual({ message: 'Email domain not allowed' });
    });

    it('reuses required-role overage groups for role sync', async () => {
      process.env.OPENID_REQUIRED_ROLE = 'group-required';
      process.env.OPENID_REQUIRED_ROLE_PARAMETER_PATH = 'groups';
      process.env.OPENID_ROLE_SYNC_CLAIM = 'groups';

      jwtDecode.mockReturnValue({
        hasgroups: true,
        permissions: ['not-admin'],
      });
      undici.fetch.mockResolvedValue({
        ok: true,
        json: async () => ({ value: ['group-required', 'STANDARD-USER'] }),
      });

      const { user } = await validate(tokenset);

      expect(user.role).toBe('STANDARD-USER');
      expect(undici.fetch).toHaveBeenCalledTimes(1);
    });

    it('leaves the role unchanged when role-sync group overage cannot be resolved', async () => {
      process.env.OPENID_ROLE_SYNC_CLAIM = 'groups';
      const existingUser = {
        _id: 'existingUserId',
        provider: 'openid',
        email: tokenset.claims().email,
        openidId: tokenset.claims().sub,
        username: 'existinguser',
        name: 'Existing User',
        role: 'BASIC-USER',
      };

      findUser.mockImplementation(async (query) => {
        if (query.openidId === tokenset.claims().sub || query.email === tokenset.claims().email) {
          return existingUser;
        }
        return null;
      });
      jwtDecode.mockReturnValue({
        roles: ['requiredRole'],
        hasgroups: true,
        permissions: ['not-admin'],
      });

      const { user } = await validate({ ...tokenset, access_token: undefined });

      expect(user.role).toBe('BASIC-USER');
    });
  });

  it('should demote existing admin user when admin role is removed from token', async () => {
    // Arrange – simulate an existing user who is currently an admin
    const existingAdminUser = {
      _id: 'existingAdminId',
      provider: 'openid',
      email: tokenset.claims().email,
      openidId: tokenset.claims().sub,
      username: 'adminuser',
      name: 'Admin User',
      role: 'ADMIN',
    };

    findUser.mockImplementation(async (query) => {
      if (query.openidId === tokenset.claims().sub || query.email === tokenset.claims().email) {
        return existingAdminUser;
      }
      return null;
    });

    // Token without admin permission
    jwtDecode.mockReturnValue({
      roles: ['requiredRole'],
      permissions: ['not-admin'],
    });

    const { logger } = require('@librechat/data-schemas');

    // Act
    const { user } = await validate(tokenset);

    // Assert – verify that the user was demoted
    expect(user.role).toBe('USER');
    expect(updateUser).toHaveBeenCalledWith(
      existingAdminUser._id,
      expect.objectContaining({
        role: 'USER',
      }),
    );
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining('demoted from admin - role no longer present in token'),
    );
  });

  it('should NOT demote admin user when admin role env vars are not configured', async () => {
    // Arrange – remove admin role env vars
    delete process.env.OPENID_ADMIN_ROLE;
    delete process.env.OPENID_ADMIN_ROLE_PARAMETER_PATH;
    delete process.env.OPENID_ADMIN_ROLE_TOKEN_KIND;

    await setupOpenId();
    verifyCallback = require('openid-client/passport').__getVerifyCallbackByName('openid');

    // Simulate an existing admin user
    const existingAdminUser = {
      _id: 'existingAdminId',
      provider: 'openid',
      email: tokenset.claims().email,
      openidId: tokenset.claims().sub,
      username: 'adminuser',
      name: 'Admin User',
      role: 'ADMIN',
    };

    findUser.mockImplementation(async (query) => {
      if (query.openidId === tokenset.claims().sub || query.email === tokenset.claims().email) {
        return existingAdminUser;
      }
      return null;
    });

    jwtDecode.mockReturnValue({
      roles: ['requiredRole'],
    });

    // Act
    const { user } = await validate(tokenset);

    // Assert – verify that the admin user was NOT demoted
    expect(user.role).toBe('ADMIN');
    expect(updateUser).toHaveBeenCalledWith(
      existingAdminUser._id,
      expect.objectContaining({
        role: 'ADMIN',
      }),
    );
  });

  describe('lodash get - nested path extraction', () => {
    it('should extract roles from deeply nested token path', async () => {
      process.env.OPENID_REQUIRED_ROLE = 'app-user';
      process.env.OPENID_REQUIRED_ROLE_PARAMETER_PATH = 'resource_access.my-client.roles';

      jwtDecode.mockReturnValue({
        resource_access: {
          'my-client': {
            roles: ['app-user', 'viewer'],
          },
        },
      });

      await setupOpenId();
      verifyCallback = require('openid-client/passport').__getVerifyCallbackByName('openid');

      const { user } = await validate(tokenset);

      expect(user).toBeTruthy();
      expect(user.email).toBe(tokenset.claims().email);
    });

    it('should extract roles from three-level nested path', async () => {
      process.env.OPENID_REQUIRED_ROLE = 'editor';
      process.env.OPENID_REQUIRED_ROLE_PARAMETER_PATH = 'data.access.permissions.roles';

      jwtDecode.mockReturnValue({
        data: {
          access: {
            permissions: {
              roles: ['editor', 'reader'],
            },
          },
        },
      });

      await setupOpenId();
      verifyCallback = require('openid-client/passport').__getVerifyCallbackByName('openid');

      const { user } = await validate(tokenset);

      expect(user).toBeTruthy();
    });

    it('should log error and reject login when required role path does not exist in token', async () => {
      const { logger } = require('@librechat/data-schemas');
      process.env.OPENID_REQUIRED_ROLE = 'app-user';
      process.env.OPENID_REQUIRED_ROLE_PARAMETER_PATH = 'resource_access.nonexistent.roles';

      jwtDecode.mockReturnValue({
        resource_access: {
          'my-client': {
            roles: ['app-user'],
          },
        },
      });

      await setupOpenId();
      verifyCallback = require('openid-client/passport').__getVerifyCallbackByName('openid');

      const { user, details } = await validate(tokenset);

      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining("Key 'resource_access.nonexistent.roles' not found in id token!"),
      );
      expect(user).toBe(false);
      expect(details.message).toContain('role to log in');
    });

    it('should handle missing intermediate nested path gracefully', async () => {
      const { logger } = require('@librechat/data-schemas');
      process.env.OPENID_REQUIRED_ROLE = 'user';
      process.env.OPENID_REQUIRED_ROLE_PARAMETER_PATH = 'org.team.roles';

      jwtDecode.mockReturnValue({
        org: {
          other: 'value',
        },
      });

      await setupOpenId();
      verifyCallback = require('openid-client/passport').__getVerifyCallbackByName('openid');

      const { user } = await validate(tokenset);

      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining("Key 'org.team.roles' not found in id token!"),
      );
      expect(user).toBe(false);
    });

    it('should extract admin role from nested path in access token', async () => {
      process.env.OPENID_ADMIN_ROLE = 'admin';
      process.env.OPENID_ADMIN_ROLE_PARAMETER_PATH = 'realm_access.roles';
      process.env.OPENID_ADMIN_ROLE_TOKEN_KIND = 'access';

      jwtDecode.mockImplementation((token) => {
        if (token === 'fake_access_token') {
          return {
            realm_access: {
              roles: ['admin', 'user'],
            },
          };
        }
        return {
          roles: ['requiredRole'],
        };
      });

      await setupOpenId();
      verifyCallback = require('openid-client/passport').__getVerifyCallbackByName('openid');

      const { user } = await validate(tokenset);

      expect(user.role).toBe('ADMIN');
    });

    it('should extract admin role from nested path in userinfo', async () => {
      process.env.OPENID_ADMIN_ROLE = 'admin';
      process.env.OPENID_ADMIN_ROLE_PARAMETER_PATH = 'organization.permissions';
      process.env.OPENID_ADMIN_ROLE_TOKEN_KIND = 'userinfo';

      const userinfoWithNestedGroups = {
        ...tokenset.claims(),
        organization: {
          permissions: ['admin', 'write'],
        },
      };

      require('openid-client').fetchUserInfo.mockResolvedValue({
        organization: {
          permissions: ['admin', 'write'],
        },
      });

      jwtDecode.mockReturnValue({
        roles: ['requiredRole'],
      });

      await setupOpenId();
      verifyCallback = require('openid-client/passport').__getVerifyCallbackByName('openid');

      const { user } = await validate({
        ...tokenset,
        claims: () => userinfoWithNestedGroups,
      });

      expect(user.role).toBe('ADMIN');
    });

    it('should handle boolean admin role value', async () => {
      process.env.OPENID_ADMIN_ROLE = 'admin';
      process.env.OPENID_ADMIN_ROLE_PARAMETER_PATH = 'is_admin';

      jwtDecode.mockReturnValue({
        roles: ['requiredRole'],
        is_admin: true,
      });

      await setupOpenId();
      verifyCallback = require('openid-client/passport').__getVerifyCallbackByName('openid');

      const { user } = await validate(tokenset);

      expect(user.role).toBe('ADMIN');
    });

    it('should handle string admin role value matching exactly', async () => {
      process.env.OPENID_ADMIN_ROLE = 'super-admin';
      process.env.OPENID_ADMIN_ROLE_PARAMETER_PATH = 'role';

      jwtDecode.mockReturnValue({
        roles: ['requiredRole'],
        role: 'super-admin',
      });

      await setupOpenId();
      verifyCallback = require('openid-client/passport').__getVerifyCallbackByName('openid');

      const { user } = await validate(tokenset);

      expect(user.role).toBe('ADMIN');
    });

    it('should not set admin role when string value does not match', async () => {
      process.env.OPENID_ADMIN_ROLE = 'super-admin';
      process.env.OPENID_ADMIN_ROLE_PARAMETER_PATH = 'role';

      jwtDecode.mockReturnValue({
        roles: ['requiredRole'],
        role: 'regular-user',
      });

      await setupOpenId();
      verifyCallback = require('openid-client/passport').__getVerifyCallbackByName('openid');

      const { user } = await validate(tokenset);

      expect(user.role).toBeUndefined();
    });

    it('should handle array admin role value', async () => {
      process.env.OPENID_ADMIN_ROLE = 'site-admin';
      process.env.OPENID_ADMIN_ROLE_PARAMETER_PATH = 'app_roles';

      jwtDecode.mockReturnValue({
        roles: ['requiredRole'],
        app_roles: ['user', 'site-admin', 'moderator'],
      });

      await setupOpenId();
      verifyCallback = require('openid-client/passport').__getVerifyCallbackByName('openid');

      const { user } = await validate(tokenset);

      expect(user.role).toBe('ADMIN');
    });

    it('should not set admin when role is not in array', async () => {
      process.env.OPENID_ADMIN_ROLE = 'site-admin';
      process.env.OPENID_ADMIN_ROLE_PARAMETER_PATH = 'app_roles';

      jwtDecode.mockReturnValue({
        roles: ['requiredRole'],
        app_roles: ['user', 'moderator'],
      });

      await setupOpenId();
      verifyCallback = require('openid-client/passport').__getVerifyCallbackByName('openid');

      const { user } = await validate(tokenset);

      expect(user.role).toBeUndefined();
    });

    it('should grant admin when admin role claim is a space-separated string containing the admin role', async () => {
      // Arrange – IdP returns admin roles as a space-delimited string
      process.env.OPENID_ADMIN_ROLE = 'site-admin';
      process.env.OPENID_ADMIN_ROLE_PARAMETER_PATH = 'app_roles';

      jwtDecode.mockReturnValue({
        roles: ['requiredRole'],
        app_roles: 'user site-admin moderator',
      });

      await setupOpenId();
      verifyCallback = require('openid-client/passport').__getVerifyCallbackByName('openid');

      // Act
      const { user } = await validate(tokenset);

      // Assert – admin role is granted after splitting the delimited string
      expect(user.role).toBe('ADMIN');
    });

    it('should not grant admin when admin role claim is a space-separated string that does not contain the admin role', async () => {
      // Arrange – delimited string present but admin role is absent
      process.env.OPENID_ADMIN_ROLE = 'site-admin';
      process.env.OPENID_ADMIN_ROLE_PARAMETER_PATH = 'app_roles';

      jwtDecode.mockReturnValue({
        roles: ['requiredRole'],
        app_roles: 'user moderator',
      });

      await setupOpenId();
      verifyCallback = require('openid-client/passport').__getVerifyCallbackByName('openid');

      // Act
      const { user } = await validate(tokenset);

      // Assert – admin role is not granted
      expect(user.role).toBeUndefined();
    });

    it('should handle nested path with special characters in keys', async () => {
      process.env.OPENID_REQUIRED_ROLE = 'app-user';
      process.env.OPENID_REQUIRED_ROLE_PARAMETER_PATH = 'resource_access.my-app-123.roles';

      jwtDecode.mockReturnValue({
        resource_access: {
          'my-app-123': {
            roles: ['app-user'],
          },
        },
      });

      await setupOpenId();
      verifyCallback = require('openid-client/passport').__getVerifyCallbackByName('openid');

      const { user } = await validate(tokenset);

      expect(user).toBeTruthy();
    });

    it('should handle empty object at nested path', async () => {
      const { logger } = require('@librechat/data-schemas');
      process.env.OPENID_REQUIRED_ROLE = 'user';
      process.env.OPENID_REQUIRED_ROLE_PARAMETER_PATH = 'access.roles';

      jwtDecode.mockReturnValue({
        access: {},
      });

      await setupOpenId();
      verifyCallback = require('openid-client/passport').__getVerifyCallbackByName('openid');

      const { user } = await validate(tokenset);

      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining("Key 'access.roles' not found in id token!"),
      );
      expect(user).toBe(false);
    });

    it('should handle null value at intermediate path', async () => {
      const { logger } = require('@librechat/data-schemas');
      process.env.OPENID_REQUIRED_ROLE = 'user';
      process.env.OPENID_REQUIRED_ROLE_PARAMETER_PATH = 'data.roles';

      jwtDecode.mockReturnValue({
        data: null,
      });

      await setupOpenId();
      verifyCallback = require('openid-client/passport').__getVerifyCallbackByName('openid');

      const { user } = await validate(tokenset);

      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining("Key 'data.roles' not found in id token!"),
      );
      expect(user).toBe(false);
    });

    it('should reject login with invalid admin role token kind', async () => {
      process.env.OPENID_ADMIN_ROLE = 'admin';
      process.env.OPENID_ADMIN_ROLE_PARAMETER_PATH = 'roles';
      process.env.OPENID_ADMIN_ROLE_TOKEN_KIND = 'invalid';

      const { logger } = require('@librechat/data-schemas');

      jwtDecode.mockReturnValue({
        roles: ['requiredRole', 'admin'],
      });

      await setupOpenId();
      verifyCallback = require('openid-client/passport').__getVerifyCallbackByName('openid');

      await expect(validate(tokenset)).rejects.toThrow('Invalid admin role token kind');

      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining(
          "Invalid admin role token kind: invalid. Must be one of 'access', 'id', or 'userinfo'",
        ),
      );
    });

    it('should reject login when roles path returns invalid type (object)', async () => {
      const { logger } = require('@librechat/data-schemas');
      process.env.OPENID_REQUIRED_ROLE = 'app-user';
      process.env.OPENID_REQUIRED_ROLE_PARAMETER_PATH = 'roles';

      jwtDecode.mockReturnValue({
        roles: { admin: true, user: false },
      });

      await setupOpenId();
      verifyCallback = require('openid-client/passport').__getVerifyCallbackByName('openid');

      const { user, details } = await validate(tokenset);

      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining("Key 'roles' not found in id token!"),
      );
      expect(user).toBe(false);
      expect(details.message).toContain('role to log in');
    });

    it('should reject login when roles path returns invalid type (number)', async () => {
      const { logger } = require('@librechat/data-schemas');
      process.env.OPENID_REQUIRED_ROLE = 'user';
      process.env.OPENID_REQUIRED_ROLE_PARAMETER_PATH = 'roleCount';

      jwtDecode.mockReturnValue({
        roleCount: 5,
      });

      await setupOpenId();
      verifyCallback = require('openid-client/passport').__getVerifyCallbackByName('openid');

      const { user } = await validate(tokenset);

      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining("Key 'roleCount' not found in id token!"),
      );
      expect(user).toBe(false);
    });
  });

  describe('OPENID_EMAIL_CLAIM', () => {
    it('should use the default email when OPENID_EMAIL_CLAIM is not set', async () => {
      const { user } = await validate(tokenset);
      expect(user.email).toBe('test@example.com');
    });

    it('should use the configured claim when OPENID_EMAIL_CLAIM is set', async () => {
      process.env.OPENID_EMAIL_CLAIM = 'upn';
      const userinfo = { ...tokenset.claims(), upn: 'user@corp.example.com' };

      const { user } = await validate({ ...tokenset, claims: () => userinfo });

      expect(user.email).toBe('user@corp.example.com');
      expect(createUser).toHaveBeenCalledWith(
        expect.objectContaining({ email: 'user@corp.example.com' }),
        expect.anything(),
        true,
        true,
      );
    });

    it('should fall back to preferred_username when email is missing and OPENID_EMAIL_CLAIM is not set', async () => {
      const userinfo = { ...tokenset.claims() };
      delete userinfo.email;

      const { user } = await validate({ ...tokenset, claims: () => userinfo });

      expect(user.email).toBe('testusername');
    });

    it('should fall back to upn when email and preferred_username are missing and OPENID_EMAIL_CLAIM is not set', async () => {
      const userinfo = { ...tokenset.claims(), upn: 'user@corp.example.com' };
      delete userinfo.email;
      delete userinfo.preferred_username;

      const { user } = await validate({ ...tokenset, claims: () => userinfo });

      expect(user.email).toBe('user@corp.example.com');
    });

    it('should ignore empty string OPENID_EMAIL_CLAIM and use default fallback', async () => {
      process.env.OPENID_EMAIL_CLAIM = '';

      const { user } = await validate(tokenset);

      expect(user.email).toBe('test@example.com');
    });

    it('should trim whitespace from OPENID_EMAIL_CLAIM and resolve correctly', async () => {
      process.env.OPENID_EMAIL_CLAIM = '  upn  ';
      const userinfo = { ...tokenset.claims(), upn: 'user@corp.example.com' };

      const { user } = await validate({ ...tokenset, claims: () => userinfo });

      expect(user.email).toBe('user@corp.example.com');
    });

    it('should ignore whitespace-only OPENID_EMAIL_CLAIM and use default fallback', async () => {
      process.env.OPENID_EMAIL_CLAIM = '   ';

      const { user } = await validate(tokenset);

      expect(user.email).toBe('test@example.com');
    });

    it('should fall back to default chain with warning when configured claim is missing from userinfo', async () => {
      const { logger } = require('@librechat/data-schemas');
      process.env.OPENID_EMAIL_CLAIM = 'nonexistent_claim';

      const { user } = await validate(tokenset);

      expect(user.email).toBe('test@example.com');
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('OPENID_EMAIL_CLAIM="nonexistent_claim" not present in userinfo'),
      );
    });
  });

  describe('Tenant-scoped config', () => {
    it('should call resolveAppConfigForUser for tenant user', async () => {
      const existingUser = {
        _id: 'openid-tenant-user',
        provider: 'openid',
        openidId: '1234',
        email: 'test@example.com',
        tenantId: 'tenant-d',
        role: 'USER',
      };
      findUser.mockResolvedValue(existingUser);

      await validate(tokenset);

      expect(resolveAppConfigForUser).toHaveBeenCalledWith(getAppConfig, existingUser);
    });

    it('should use baseConfig for new user without calling resolveAppConfigForUser', async () => {
      findUser.mockResolvedValue(null);

      await validate(tokenset);

      expect(resolveAppConfigForUser).not.toHaveBeenCalled();
      expect(getAppConfig).toHaveBeenCalledWith({ baseOnly: true });
    });

    it('should block login when tenant config restricts the domain', async () => {
      const { isEmailDomainAllowed } = require('@librechat/api');
      const existingUser = {
        _id: 'openid-tenant-blocked',
        provider: 'openid',
        openidId: '1234',
        email: 'test@example.com',
        tenantId: 'tenant-restrict',
        role: 'USER',
      };
      findUser.mockResolvedValue(existingUser);
      resolveAppConfigForUser.mockResolvedValue({
        registration: { allowedDomains: ['other.com'] },
      });
      isEmailDomainAllowed.mockReturnValueOnce(true).mockReturnValueOnce(false);

      const { user, details } = await validate(tokenset);
      expect(user).toBe(false);
      expect(details).toEqual({ message: 'Email domain not allowed' });
    });
  });
});

describe('getRoleSource', () => {
  const { getRoleSource } = require('./openidStrategy');
  const { logger } = require('@librechat/data-schemas');

  const accessClaims = { roles: ['from-access'] };
  const idClaims = { roles: ['from-id'] };
  const userinfo = { roles: ['from-userinfo'] };
  const tokenset = { access_token: 'access.jwt', id_token: 'id.jwt' };

  beforeEach(() => {
    jest.clearAllMocks();
    jwtDecode.mockImplementation((token) => {
      if (token === 'access.jwt') return accessClaims;
      if (token === 'id.jwt') return idClaims;
      return {};
    });
  });

  it.each([
    ['access', accessClaims],
    ['id', idClaims],
    ['userinfo', userinfo],
  ])('returns the expected source object for kind=%s', (kind, expected) => {
    expect(getRoleSource(kind, 'required role', tokenset, userinfo)).toEqual(expected);
  });

  it.each([
    ['undefined', undefined],
    ['empty string', ''],
    ['unknown kind', 'bogus'],
  ])('throws and logs for invalid kind: %s', (_name, kind) => {
    expect(() => getRoleSource(kind, 'required role', tokenset, userinfo)).toThrow(
      'Invalid required role token kind',
    );
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining(`Invalid required role token kind: ${kind}`),
    );
  });

  it('uses the provided label in the error message and thrown error', () => {
    expect(() => getRoleSource('bogus', 'admin role', tokenset, userinfo)).toThrow(
      'Invalid admin role token kind',
    );
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('Invalid admin role token kind: bogus'),
    );
  });

  it('propagates jwtDecode errors when the requested token is missing', () => {
    jwtDecode.mockImplementation(() => {
      throw new Error('Invalid token specified');
    });
    expect(() => getRoleSource('access', 'required role', {}, userinfo)).toThrow(
      'Invalid token specified',
    );
  });
});
