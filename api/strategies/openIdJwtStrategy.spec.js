const { SystemRoles } = require('librechat-data-provider');

// --- Capture JwtStrategy inputs ---
let capturedStrategyOptions;
let capturedVerifyCallback;
const mockAuthUserDocCacheStore = {
  get: jest.fn(),
  set: jest.fn(),
  delete: jest.fn(),
};
const mockGetLogStores = jest.fn(() => mockAuthUserDocCacheStore);
const mockGetTenantId = jest.fn();
const mockRunAsSystem = jest.fn((callback) => callback());
jest.mock('passport-jwt', () => ({
  Strategy: jest.fn((opts, verifyCallback) => {
    capturedStrategyOptions = opts;
    capturedVerifyCallback = verifyCallback;
    return { name: 'jwt' };
  }),
  ExtractJwt: {
    fromAuthHeaderAsBearerToken: jest.fn(() => 'mock-extractor'),
  },
}));
jest.mock('jwks-rsa', () => ({
  passportJwtSecret: jest.fn(() => 'mock-secret-provider'),
}));
jest.mock('https-proxy-agent', () => ({
  HttpsProxyAgent: jest.fn(),
}));
jest.mock('@librechat/data-schemas', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() },
  getTenantId: mockGetTenantId,
  runAsSystem: mockRunAsSystem,
}));
jest.mock('@librechat/api', () => ({
  isEnabled: jest.fn(() => false),
  findOpenIDUser: jest.fn(),
  getOpenIdEmail: jest.requireActual('@librechat/api').getOpenIdEmail,
  getOpenIdIssuer: jest.fn(() => 'https://issuer.example.com'),
  normalizeOpenIdIssuer: jest.requireActual('@librechat/api').normalizeOpenIdIssuer,
  isTokenIssuedBeforeCredentialChange:
    jest.requireActual('@librechat/api').isTokenIssuedBeforeCredentialChange,
  buildAuthUserDocCacheKey: jest.fn(() => 'auth-user-doc-key'),
  getAuthUserDocCacheMode: jest.fn(() => 'off'),
  getCachedAuthUserDoc: jest.fn(),
  getValidOpenIdReuseUserId: jest.fn(),
  invalidateCachedAuthUserDoc: jest.fn(),
  setCachedAuthUserDoc: jest.fn(),
  getHttpsProxyAgent: jest.fn(() => undefined),
  isAccessTokenJwt: jest.requireActual('@librechat/api').isAccessTokenJwt,
  math: jest.fn((val, fallback) => fallback),
}));
jest.mock('~/models', () => ({
  findUser: jest.fn(),
  updateUser: jest.fn(),
  isAgentTriggerPrincipalActive: jest.fn(() => true),
}));
jest.mock('~/server/services/Files/strategies', () => ({
  getStrategyFunctions: jest.fn(() => ({
    saveBuffer: jest.fn().mockResolvedValue('/fake/path/to/avatar.png'),
  })),
}));
jest.mock('~/server/services/Config', () => ({
  getAppConfig: jest.fn().mockResolvedValue({}),
}));
jest.mock('~/cache/getLogStores', () => mockGetLogStores);

const {
  buildAuthUserDocCacheKey,
  findOpenIDUser,
  getAuthUserDocCacheMode,
  getCachedAuthUserDoc,
  getValidOpenIdReuseUserId,
  invalidateCachedAuthUserDoc,
  setCachedAuthUserDoc,
} = require('@librechat/api');
const openIdJwtLogin = require('./openIdJwtStrategy');
const { findUser, updateUser, isAgentTriggerPrincipalActive } = require('~/models');

function resetAuthUserDocCacheMocks() {
  mockGetTenantId.mockReturnValue(undefined);
  mockAuthUserDocCacheStore.get.mockResolvedValue(undefined);
  mockAuthUserDocCacheStore.set.mockResolvedValue(undefined);
  mockAuthUserDocCacheStore.delete.mockResolvedValue(undefined);
  mockGetLogStores.mockReturnValue(mockAuthUserDocCacheStore);
  buildAuthUserDocCacheKey.mockReturnValue('auth-user-doc-key');
  getAuthUserDocCacheMode.mockReturnValue('off');
  getCachedAuthUserDoc.mockResolvedValue(undefined);
  getValidOpenIdReuseUserId.mockReturnValue(null);
  invalidateCachedAuthUserDoc.mockResolvedValue(undefined);
  setCachedAuthUserDoc.mockResolvedValue(undefined);
}

beforeEach(() => {
  resetAuthUserDocCacheMocks();
  mockRunAsSystem.mockClear();
  isAgentTriggerPrincipalActive.mockResolvedValue(true);
});

function withEnv(env, callback) {
  const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  Object.entries(env).forEach(([key, value]) => {
    if (value === undefined) {
      delete process.env[key];
      return;
    }
    process.env[key] = value;
  });
  try {
    callback();
  } finally {
    Object.entries(previous).forEach(([key, value]) => {
      if (value === undefined) {
        delete process.env[key];
        return;
      }
      process.env[key] = value;
    });
  }
}

// Helper: build a mock openIdConfig
const mockOpenIdConfig = {
  serverMetadata: () => ({
    issuer: 'https://issuer.example.com',
    jwks_uri: 'https://example.com/.well-known/jwks.json',
  }),
};

// Helper: invoke the captured verify callback
async function invokeVerify(req, payload) {
  return new Promise((resolve, reject) => {
    capturedVerifyCallback(req, payload, (err, user, info) => {
      if (err) {
        return reject(err);
      }
      resolve({ user, info });
    });
  });
}

describe('openIdJwtStrategy – token validation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('requires OpenID JWTs to match the configured client audience and issuer', () => {
    withEnv({ OPENID_CLIENT_ID: 'librechat-client-id', OPENID_AUDIENCE: undefined }, () => {
      openIdJwtLogin(mockOpenIdConfig);
    });

    expect(capturedStrategyOptions).toMatchObject({
      audience: 'librechat-client-id',
      passReqToCallback: true,
    });
    expect(capturedStrategyOptions).not.toHaveProperty('issuer');
  });

  it('also accepts OPENID_AUDIENCE for providers that mint resource-bound JWTs', () => {
    withEnv({ OPENID_CLIENT_ID: 'librechat-client-id', OPENID_AUDIENCE: 'api://librechat' }, () => {
      openIdJwtLogin(mockOpenIdConfig);
    });

    expect(capturedStrategyOptions).toMatchObject({
      audience: ['librechat-client-id', 'api://librechat'],
    });
  });

  it('uses a single OPENID_AUDIENCE value when no client ID is configured', () => {
    withEnv({ OPENID_CLIENT_ID: undefined, OPENID_AUDIENCE: 'librechat' }, () => {
      openIdJwtLogin(mockOpenIdConfig);
    });

    expect(capturedStrategyOptions.audience).toBe('librechat');
  });

  it('splits comma-separated OPENID_AUDIENCE values into multiple accepted audiences', () => {
    withEnv({ OPENID_CLIENT_ID: undefined, OPENID_AUDIENCE: 'librechat,control-plane-web' }, () => {
      openIdJwtLogin(mockOpenIdConfig);
    });

    expect(capturedStrategyOptions.audience).toEqual(['librechat', 'control-plane-web']);
  });

  it('trims whitespace around comma-separated OPENID_AUDIENCE values', () => {
    withEnv(
      { OPENID_CLIENT_ID: undefined, OPENID_AUDIENCE: ' librechat , control-plane-web ' },
      () => {
        openIdJwtLogin(mockOpenIdConfig);
      },
    );

    expect(capturedStrategyOptions.audience).toEqual(['librechat', 'control-plane-web']);
  });

  it('falls back to OPENID_CLIENT_ID when OPENID_AUDIENCE is empty', () => {
    withEnv({ OPENID_CLIENT_ID: 'client-id-only', OPENID_AUDIENCE: '' }, () => {
      openIdJwtLogin(mockOpenIdConfig);
    });

    expect(capturedStrategyOptions.audience).toBe('client-id-only');
  });

  it('combines OPENID_CLIENT_ID with comma-separated OPENID_AUDIENCE values and deduplicates', () => {
    withEnv(
      { OPENID_CLIENT_ID: 'librechat', OPENID_AUDIENCE: 'librechat,control-plane-web' },
      () => {
        openIdJwtLogin(mockOpenIdConfig);
      },
    );

    expect(capturedStrategyOptions.audience).toEqual(['librechat', 'control-plane-web']);
  });

  it('rejects OpenID JWTs whose issuer does not match the configured issuer', async () => {
    findOpenIDUser.mockResolvedValue({ user: null, error: null, migration: false });
    openIdJwtLogin(mockOpenIdConfig);

    const req = { headers: { authorization: 'Bearer tok' }, session: {} };
    const { user, info } = await invokeVerify(req, {
      sub: 'oidc-123',
      email: 'test@example.com',
      iss: 'https://other-issuer.example.com',
      exp: 9999999999,
    });

    expect(user).toBe(false);
    expect(info).toEqual({ message: 'Invalid issuer' });
    expect(findOpenIDUser).not.toHaveBeenCalled();
  });

  it('allows Microsoft Entra tenant issuer values for tenant-independent metadata', async () => {
    const entraConfig = {
      serverMetadata: () => ({
        issuer: 'https://login.microsoftonline.com/{tenantid}/v2.0',
        jwks_uri: 'https://login.microsoftonline.com/common/discovery/v2.0/keys',
      }),
    };
    const user = {
      _id: { toString: () => 'user-abc' },
      role: SystemRoles.USER,
      provider: 'openid',
    };
    findOpenIDUser.mockResolvedValue({ user, error: null, migration: false });
    updateUser.mockResolvedValue({});
    openIdJwtLogin(entraConfig);

    const req = { headers: { authorization: 'Bearer tok' }, session: {} };
    const { user: result } = await invokeVerify(req, {
      sub: 'oidc-123',
      email: 'test@example.com',
      iss: 'https://login.microsoftonline.com/11111111-2222-3333-4444-555555555555/v2.0',
      exp: 9999999999,
    });

    expect(result).toBeTruthy();
    expect(findOpenIDUser).toHaveBeenCalled();
  });

  describe('credentialsChangedAt revocation', () => {
    /** Reset landed 500ms into second 1700000010 */
    const credentialsChangedAt = new Date(1700000010500);

    const runVerify = async (iat) => {
      findOpenIDUser.mockResolvedValue({
        user: {
          _id: { toString: () => 'user-abc' },
          role: SystemRoles.USER,
          provider: 'openid',
          credentialsChangedAt,
        },
        error: null,
        migration: false,
      });
      updateUser.mockResolvedValue({});
      openIdJwtLogin(mockOpenIdConfig);

      const req = { headers: { authorization: 'Bearer tok' }, session: {} };
      return invokeVerify(req, {
        sub: 'oidc-123',
        email: 'test@example.com',
        iss: 'https://issuer.example.com',
        exp: 9999999999,
        iat,
      });
    };

    it('rejects an OpenID JWT issued before the credential change', async () => {
      const { user } = await runVerify(1700000009);

      expect(user).toBe(false);
    });

    it('accepts an OpenID JWT issued after the credential change', async () => {
      const { user } = await runVerify(1700000011);

      expect(user).toBeTruthy();
      expect(user.id).toBe('user-abc');
    });
  });
});

describe('openIdJwtStrategy – token source handling', () => {
  const baseUser = {
    _id: { toString: () => 'user-abc' },
    role: SystemRoles.USER,
    provider: 'openid',
  };

  const payload = {
    sub: 'oidc-123',
    email: 'test@example.com',
    iss: 'https://issuer.example.com',
    exp: 9999999999,
  };

  beforeEach(() => {
    jest.clearAllMocks();
    findOpenIDUser.mockResolvedValue({ user: { ...baseUser }, error: null, migration: false });
    updateUser.mockResolvedValue({});

    // Initialize the strategy so capturedVerifyCallback is set
    openIdJwtLogin(mockOpenIdConfig);
  });

  it('should read all tokens from session when available', async () => {
    const req = {
      headers: { authorization: 'Bearer raw-bearer-token' },
      session: {
        openidTokens: {
          accessToken: 'session-access',
          idToken: 'session-id',
          refreshToken: 'session-refresh',
        },
      },
    };

    const { user } = await invokeVerify(req, payload);

    expect(user.federatedTokens).toEqual({
      access_token: 'session-access',
      id_token: 'session-id',
      refresh_token: 'session-refresh',
      expires_at: undefined,
    });
  });

  it('should fall back to cookies when session is absent', async () => {
    const req = {
      headers: {
        authorization: 'Bearer raw-bearer-token',
        cookie:
          'openid_access_token=cookie-access; openid_id_token=cookie-id; refreshToken=cookie-refresh',
      },
    };

    const { user } = await invokeVerify(req, payload);

    expect(user.federatedTokens).toEqual({
      access_token: 'cookie-access',
      id_token: 'cookie-id',
      refresh_token: 'cookie-refresh',
      expires_at: undefined,
    });
  });

  it('should fall back to cookie for idToken only when session lacks it', async () => {
    const req = {
      headers: {
        authorization: 'Bearer raw-bearer-token',
        cookie: 'openid_id_token=cookie-id',
      },
      session: {
        openidTokens: {
          accessToken: 'session-access',
          // idToken intentionally missing
          refreshToken: 'session-refresh',
        },
      },
    };

    const { user } = await invokeVerify(req, payload);

    expect(user.federatedTokens).toEqual({
      access_token: 'session-access',
      id_token: 'cookie-id',
      refresh_token: 'session-refresh',
      expires_at: undefined,
    });
  });

  const encodeSegment = (value) => Buffer.from(JSON.stringify(value)).toString('base64');
  const makeJwt = (claims, header = { alg: 'RS256' }) =>
    `${encodeSegment(header)}.${encodeSegment(claims)}.signature`;

  const resourceEnv = { OPENID_CLIENT_ID: 'client-id', OPENID_AUDIENCE: 'api://resource-app' };

  it('should decline the raw Bearer token when nothing identifies it as an access token', async () => {
    const req = {
      headers: {
        authorization: 'Bearer raw-bearer-token',
        cookie: 'openid_id_token=cookie-id; refreshToken=cookie-refresh',
      },
    };

    const { user } = await invokeVerify(req, payload);

    expect(user.federatedTokens.access_token).toBeUndefined();
    expect(user.federatedTokens.id_token).toBe('cookie-id');
    expect(user.federatedTokens.refresh_token).toBe('cookie-refresh');
    expect(user.federatedTokens.expires_at).toBeUndefined();
  });

  it('should decline an Entra-shaped ID token rather than reuse it as the OBO assertion', async () => {
    withEnv(resourceEnv, () => openIdJwtLogin(mockOpenIdConfig));

    const claims = { ...payload, aud: 'client-id', nonce: 'n-0S6_WzA2Mj', tid: 'tenant-1' };
    const req = { headers: { authorization: `Bearer ${makeJwt(claims)}` } };

    const { user } = await invokeVerify(req, claims);

    expect(user.federatedTokens.access_token).toBeUndefined();
  });

  it('should decline a multi-audience ID token that also names a configured resource', async () => {
    withEnv(resourceEnv, () => openIdJwtLogin(mockOpenIdConfig));

    const claims = { ...payload, aud: ['client-id', 'api://resource-app'], nonce: 'n-0S6' };
    const req = { headers: { authorization: `Bearer ${makeJwt(claims)}` } };

    const { user } = await invokeVerify(req, claims);

    expect(user.federatedTokens.access_token).toBeUndefined();
  });

  it('should decline an ID token carrying a provider-added scope claim', async () => {
    withEnv(resourceEnv, () => openIdJwtLogin(mockOpenIdConfig));

    const claims = { ...payload, aud: 'client-id', scope: 'openid email profile' };
    const req = { headers: { authorization: `Bearer ${makeJwt(claims)}` } };

    const { user } = await invokeVerify(req, claims);

    expect(user.federatedTokens.access_token).toBeUndefined();
  });

  it('should decline a raw Bearer token carrying the ID-token-only at_hash claim', async () => {
    withEnv(resourceEnv, () => openIdJwtLogin(mockOpenIdConfig));

    const claims = { ...payload, aud: 'api://resource-app', at_hash: 'HK6E_P6Dh8Y93mRN' };
    const req = { headers: { authorization: `Bearer ${makeJwt(claims)}` } };

    const { user } = await invokeVerify(req, claims);

    expect(user.federatedTokens.access_token).toBeUndefined();
  });

  it('should reuse a raw Bearer token whose audience names a configured resource', async () => {
    withEnv(resourceEnv, () => openIdJwtLogin(mockOpenIdConfig));

    const claims = { ...payload, aud: 'api://resource-app' };
    const rawToken = makeJwt(claims);
    const req = { headers: { authorization: `Bearer ${rawToken}` } };

    const { user } = await invokeVerify(req, claims);

    expect(user.federatedTokens.access_token).toBe(rawToken);
    expect(user.federatedTokens.expires_at).toBe(payload.exp);
  });

  it('should reuse a raw Bearer token declaring the RFC 9068 `at+jwt` header type', async () => {
    withEnv(resourceEnv, () => openIdJwtLogin(mockOpenIdConfig));

    const rawToken = makeJwt(payload, { alg: 'RS256', typ: 'at+JWT' });
    const req = { headers: { authorization: `Bearer ${rawToken}` } };

    const { user } = await invokeVerify(req, payload);

    expect(user.federatedTokens.access_token).toBe(rawToken);
  });

  it('should decline a raw Bearer token whose only audience is the OIDC client id', async () => {
    withEnv({ OPENID_CLIENT_ID: 'client-id', OPENID_AUDIENCE: 'client-id' }, () => {
      openIdJwtLogin(mockOpenIdConfig);
    });

    const claims = { ...payload, aud: 'client-id', scp: 'User.Read' };
    const req = { headers: { authorization: `Bearer ${makeJwt(claims)}` } };

    const { user } = await invokeVerify(req, claims);

    expect(user.federatedTokens.access_token).toBeUndefined();
  });

  it('should decode expires_at from a session access token that is itself a JWT', async () => {
    const sessionAccessExp = 1234567890;
    const sessionAccessToken = `header.${Buffer.from(
      JSON.stringify({ sub: 'oidc-123', exp: sessionAccessExp }),
    ).toString('base64')}.signature`;
    const req = {
      headers: { authorization: 'Bearer raw-bearer-token' },
      session: {
        openidTokens: {
          accessToken: sessionAccessToken,
          idToken: 'session-id',
          refreshToken: 'session-refresh',
        },
      },
    };

    const { user } = await invokeVerify(req, payload);

    expect(user.federatedTokens.access_token).toBe(sessionAccessToken);
    expect(user.federatedTokens.expires_at).toBe(sessionAccessExp);
    expect(user.federatedTokens.expires_at).not.toBe(payload.exp);
  });

  it('should store an opaque session access token with no expiry alongside a decodable stale ID token', async () => {
    const staleIdToken = `header.${Buffer.from(
      JSON.stringify({ sub: 'oidc-123', exp: Math.floor(Date.now() / 1000) - 3600 }),
    ).toString('base64')}.signature`;
    const req = {
      headers: { authorization: 'Bearer raw-bearer-token' },
      session: {
        openidTokens: {
          accessToken: 'opaque-session-access',
          idToken: staleIdToken,
          refreshToken: 'session-refresh',
        },
      },
    };

    const { user } = await invokeVerify(req, payload);

    expect(user.federatedTokens.access_token).toBe('opaque-session-access');
    expect(user.federatedTokens.id_token).toBe(staleIdToken);
    expect(user.federatedTokens.expires_at).toBeUndefined();
  });

  it('should set id_token to undefined when not available in session or cookies', async () => {
    const req = {
      headers: {
        authorization: 'Bearer raw-bearer-token',
        cookie: 'openid_access_token=cookie-access; refreshToken=cookie-refresh',
      },
    };

    const { user } = await invokeVerify(req, payload);

    expect(user.federatedTokens.access_token).toBe('cookie-access');
    expect(user.federatedTokens.id_token).toBeUndefined();
    expect(user.federatedTokens.refresh_token).toBe('cookie-refresh');
  });

  it('should keep id_token and access_token as distinct values from cookies', async () => {
    const req = {
      headers: {
        authorization: 'Bearer raw-bearer-token',
        cookie:
          'openid_access_token=the-access-token; openid_id_token=the-id-token; refreshToken=the-refresh',
      },
    };

    const { user } = await invokeVerify(req, payload);

    expect(user.federatedTokens.access_token).toBe('the-access-token');
    expect(user.federatedTokens.id_token).toBe('the-id-token');
    expect(user.federatedTokens.access_token).not.toBe(user.federatedTokens.id_token);
  });
});

describe('openIdJwtStrategy – auth user document cache', () => {
  const payload = {
    sub: 'oidc-123',
    email: 'test@example.com',
    iss: 'https://issuer.example.com',
    exp: 9999999999,
  };

  const req = { headers: { authorization: 'Bearer tok' }, session: {} };

  const baseUser = {
    _id: { toString: () => 'user-abc' },
    role: SystemRoles.USER,
    provider: 'openid',
    email: 'test@example.com',
  };

  beforeEach(() => {
    jest.clearAllMocks();
    resetAuthUserDocCacheMocks();
    updateUser.mockResolvedValue({});
    openIdJwtLogin(mockOpenIdConfig);
  });

  it('does not initialize the cache store while cache mode is off', async () => {
    findOpenIDUser.mockResolvedValue({ user: { ...baseUser }, error: null, migration: false });

    await invokeVerify(req, payload);

    expect(findOpenIDUser).toHaveBeenCalled();
    expect(mockGetLogStores).not.toHaveBeenCalled();
    expect(getCachedAuthUserDoc).not.toHaveBeenCalled();
    expect(setCachedAuthUserDoc).not.toHaveBeenCalled();
  });

  it('uses the cached user document in on mode without a database lookup', async () => {
    mockGetTenantId.mockReturnValue('tenant-a');
    const cachedUser = {
      _id: 'cached-user',
      role: SystemRoles.USER,
      provider: 'openid',
      email: 'cached@example.com',
      tenantId: 'tenant-a',
    };
    getAuthUserDocCacheMode.mockReturnValue('on');
    getCachedAuthUserDoc.mockResolvedValue(cachedUser);

    const { user } = await invokeVerify(req, payload);

    expect(buildAuthUserDocCacheKey).toHaveBeenCalledWith({
      strategy: 'openid-jwt',
      subject: payload.sub,
      issuer: 'https://issuer.example.com',
      tenantId: 'tenant-a',
    });
    expect(findOpenIDUser).not.toHaveBeenCalled();
    expect(user).toMatchObject({
      id: 'cached-user',
      email: 'cached@example.com',
      idOnTheSource: null,
    });
    expect(setCachedAuthUserDoc).not.toHaveBeenCalled();
    expect(invalidateCachedAuthUserDoc).not.toHaveBeenCalled();
  });

  it('rejects a cached OpenID user while account deletion is fenced', async () => {
    mockGetTenantId.mockReturnValue('tenant-a');
    getAuthUserDocCacheMode.mockReturnValue('on');
    getCachedAuthUserDoc.mockResolvedValue({
      _id: 'cached-user',
      role: SystemRoles.USER,
      provider: 'openid',
      tenantId: 'tenant-a',
    });
    isAgentTriggerPrincipalActive.mockResolvedValue(false);

    const result = await invokeVerify(req, payload);

    expect(result).toEqual({
      user: false,
      info: {
        message: 'Account deletion is in progress',
        code: 'ACCOUNT_DELETION_IN_PROGRESS',
      },
    });
    expect(findOpenIDUser).not.toHaveBeenCalled();
    expect(mockRunAsSystem).toHaveBeenCalledWith(expect.any(Function));
    expect(isAgentTriggerPrincipalActive).toHaveBeenCalledWith('cached-user');
    expect(setCachedAuthUserDoc).not.toHaveBeenCalled();
  });

  it('populates the cache after a miss with the fresh user document', async () => {
    getAuthUserDocCacheMode.mockReturnValue('on');
    getCachedAuthUserDoc.mockResolvedValue(undefined);
    findOpenIDUser.mockResolvedValue({ user: { ...baseUser }, error: null, migration: false });

    await invokeVerify(req, payload);

    expect(findOpenIDUser).toHaveBeenCalled();
    expect(setCachedAuthUserDoc).toHaveBeenCalledWith(
      mockAuthUserDocCacheStore,
      'auth-user-doc-key',
      expect.objectContaining({ id: 'user-abc' }),
    );
    expect(invalidateCachedAuthUserDoc).not.toHaveBeenCalled();
  });

  it('rejects a cached user document from another tenant', async () => {
    mockGetTenantId.mockReturnValue('tenant-b');
    getAuthUserDocCacheMode.mockReturnValue('on');
    getCachedAuthUserDoc.mockResolvedValue({
      _id: 'tenant-a-user',
      role: SystemRoles.ADMIN,
      provider: 'openid',
      email: 'cached@example.com',
      tenantId: 'tenant-a',
    });
    findOpenIDUser.mockResolvedValue({
      user: { ...baseUser, _id: { toString: () => 'tenant-b-user' }, tenantId: 'tenant-b' },
      error: null,
      migration: false,
    });

    const { user } = await invokeVerify(req, payload);

    expect(buildAuthUserDocCacheKey).toHaveBeenCalledWith({
      strategy: 'openid-jwt',
      subject: payload.sub,
      issuer: 'https://issuer.example.com',
      tenantId: 'tenant-b',
    });
    expect(findOpenIDUser).toHaveBeenCalled();
    expect(user).toMatchObject({ id: 'tenant-b-user', tenantId: 'tenant-b' });
    expect(setCachedAuthUserDoc).toHaveBeenCalledWith(
      mockAuthUserDocCacheStore,
      'auth-user-doc-key',
      expect.objectContaining({ id: 'tenant-b-user', tenantId: 'tenant-b' }),
    );
  });

  it('uses the signed OpenID user id as cache scope before tenant context is available', async () => {
    getAuthUserDocCacheMode.mockReturnValue('on');
    getValidOpenIdReuseUserId.mockReturnValue('tenant-a-user');
    getCachedAuthUserDoc.mockResolvedValue({
      _id: 'tenant-a-user',
      role: SystemRoles.USER,
      provider: 'openid',
      email: 'cached@example.com',
      tenantId: 'tenant-a',
    });

    const { user } = await invokeVerify(
      {
        headers: {
          authorization: 'Bearer tok',
          cookie: 'openid_user_id=signed-user-id',
        },
        session: {},
      },
      payload,
    );

    expect(getValidOpenIdReuseUserId).toHaveBeenCalledWith('signed-user-id');
    expect(buildAuthUserDocCacheKey).toHaveBeenCalledWith({
      strategy: 'openid-jwt',
      subject: payload.sub,
      issuer: 'https://issuer.example.com',
      userId: 'tenant-a-user',
    });
    expect(findOpenIDUser).not.toHaveBeenCalled();
    expect(user).toMatchObject({ id: 'tenant-a-user', tenantId: 'tenant-a' });
  });

  it('does not cache a lookup result outside the active tenant scope', async () => {
    mockGetTenantId.mockReturnValue('tenant-b');
    getAuthUserDocCacheMode.mockReturnValue('on');
    getCachedAuthUserDoc.mockResolvedValue(undefined);
    findOpenIDUser.mockResolvedValue({
      user: { ...baseUser, tenantId: 'tenant-a' },
      error: null,
      migration: false,
    });

    await invokeVerify(req, payload);

    expect(findOpenIDUser).toHaveBeenCalled();
    expect(setCachedAuthUserDoc).not.toHaveBeenCalled();
  });

  it('invalidates instead of populating when login mutates the user', async () => {
    getAuthUserDocCacheMode.mockReturnValue('on');
    findOpenIDUser.mockResolvedValue({
      user: { ...baseUser, role: undefined },
      error: null,
      migration: false,
    });

    await invokeVerify(req, payload);

    expect(updateUser).toHaveBeenCalledWith('user-abc', { role: SystemRoles.USER });
    expect(setCachedAuthUserDoc).not.toHaveBeenCalled();
    expect(invalidateCachedAuthUserDoc).toHaveBeenCalledWith(mockAuthUserDocCacheStore, {
      userId: 'user-abc',
      cacheKey: 'auth-user-doc-key',
    });
  });
});

describe('openIdJwtStrategy – idOnTheSource boundary coercion', () => {
  const payload = {
    sub: 'oidc-123',
    email: 'test@example.com',
    iss: 'https://issuer.example.com',
    exp: 9999999999,
  };
  const req = { headers: { authorization: 'Bearer tok' }, session: {} };

  beforeEach(() => {
    jest.clearAllMocks();
    updateUser.mockResolvedValue({});
    openIdJwtLogin(mockOpenIdConfig);
  });

  it('coerces missing idOnTheSource to null', async () => {
    findOpenIDUser.mockResolvedValue({
      user: { _id: { toString: () => 'user-abc' }, role: SystemRoles.USER, provider: 'openid' },
      error: null,
      migration: false,
    });

    const { user } = await invokeVerify(req, payload);

    expect(user.idOnTheSource).toBeNull();
  });

  it('preserves a stored idOnTheSource', async () => {
    findOpenIDUser.mockResolvedValue({
      user: {
        _id: { toString: () => 'user-abc' },
        role: SystemRoles.USER,
        provider: 'openid',
        idOnTheSource: 'entra-oid-123',
      },
      error: null,
      migration: false,
    });

    const { user } = await invokeVerify(req, payload);

    expect(user.idOnTheSource).toBe('entra-oid-123');
  });
});

describe('openIdJwtStrategy – OPENID_EMAIL_CLAIM', () => {
  const payload = {
    sub: 'oidc-123',
    email: 'test@example.com',
    preferred_username: 'testuser',
    upn: 'test@corp.example.com',
    iss: 'https://issuer.example.com',
    exp: 9999999999,
  };

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.OPENID_EMAIL_CLAIM;

    // Use real findOpenIDUser so it delegates to the findUser mock
    const realFindOpenIDUser = jest.requireActual('@librechat/api').findOpenIDUser;
    findOpenIDUser.mockImplementation(realFindOpenIDUser);

    findUser.mockResolvedValue(null);
    updateUser.mockResolvedValue({});

    openIdJwtLogin(mockOpenIdConfig);
  });

  afterEach(() => {
    delete process.env.OPENID_EMAIL_CLAIM;
  });

  it('should use the default email when OPENID_EMAIL_CLAIM is not set', async () => {
    const existingUser = {
      _id: 'user-id-1',
      provider: 'openid',
      openidId: payload.sub,
      openidIssuer: 'https://issuer.example.com',
      email: payload.email,
      role: SystemRoles.USER,
    };
    findUser.mockImplementation(async (query) => {
      if (query.openidId === payload.sub && query.openidIssuer === 'https://issuer.example.com') {
        return existingUser;
      }
      return null;
    });

    const req = { headers: { authorization: 'Bearer tok' }, session: {} };
    await invokeVerify(req, payload);

    expect(findUser).toHaveBeenCalledWith({
      openidId: payload.sub,
      openidIssuer: 'https://issuer.example.com',
    });
  });

  it('should use OPENID_EMAIL_CLAIM when set for email lookup', async () => {
    process.env.OPENID_EMAIL_CLAIM = 'upn';
    findUser.mockResolvedValue(null);

    const req = { headers: { authorization: 'Bearer tok' }, session: {} };
    const { user } = await invokeVerify(req, payload);

    expect(findUser).toHaveBeenCalledTimes(2);
    expect(findUser.mock.calls[0][0]).toEqual({
      openidId: payload.sub,
      openidIssuer: 'https://issuer.example.com',
    });
    expect(findUser.mock.calls[1][0]).toEqual({
      email: 'test@corp.example.com',
    });
    expect(user).toBe(false);
  });

  it('should fall back to default chain when OPENID_EMAIL_CLAIM points to missing claim', async () => {
    process.env.OPENID_EMAIL_CLAIM = 'nonexistent_claim';
    findUser.mockResolvedValue(null);

    const req = { headers: { authorization: 'Bearer tok' }, session: {} };
    const { user } = await invokeVerify(req, payload);

    expect(findUser).toHaveBeenCalledWith({ email: payload.email });
    expect(user).toBe(false);
  });

  it('should reject login when email fallback finds user with mismatched openidId', async () => {
    const emailMatchWithDifferentSub = {
      _id: 'user-id-2',
      provider: 'openid',
      openidId: 'different-sub',
      email: payload.email,
      role: SystemRoles.USER,
    };

    findUser.mockImplementation(async (query) => {
      if (query.$or) {
        return null;
      }
      if (query.email === payload.email) {
        return emailMatchWithDifferentSub;
      }
      return null;
    });

    const req = { headers: { authorization: 'Bearer tok' }, session: {} };
    const { user, info } = await invokeVerify(req, payload);

    expect(user).toBe(false);
    expect(info).toEqual({ message: 'auth_failed' });
  });

  it('should trim whitespace from OPENID_EMAIL_CLAIM', async () => {
    process.env.OPENID_EMAIL_CLAIM = '  upn  ';
    findUser.mockResolvedValue(null);

    const req = { headers: { authorization: 'Bearer tok' }, session: {} };
    await invokeVerify(req, payload);

    expect(findUser).toHaveBeenCalledWith({ email: 'test@corp.example.com' });
  });

  it('should ignore empty string OPENID_EMAIL_CLAIM and use default fallback', async () => {
    process.env.OPENID_EMAIL_CLAIM = '';
    findUser.mockResolvedValue(null);

    const req = { headers: { authorization: 'Bearer tok' }, session: {} };
    await invokeVerify(req, payload);

    expect(findUser).toHaveBeenCalledWith({ email: payload.email });
  });

  it('should ignore whitespace-only OPENID_EMAIL_CLAIM and use default fallback', async () => {
    process.env.OPENID_EMAIL_CLAIM = '   ';
    findUser.mockResolvedValue(null);

    const req = { headers: { authorization: 'Bearer tok' }, session: {} };
    await invokeVerify(req, payload);

    expect(findUser).toHaveBeenCalledWith({ email: payload.email });
  });

  it('should resolve undefined email when payload is null', async () => {
    const req = { headers: { authorization: 'Bearer tok' }, session: {} };
    const { user } = await invokeVerify(req, null);

    expect(user).toBe(false);
  });

  it('should attempt email lookup via preferred_username fallback when email claim is absent', async () => {
    const payloadNoEmail = {
      sub: 'oidc-new-sub',
      preferred_username: 'legacy@corp.com',
      upn: 'legacy@corp.com',
      iss: 'https://issuer.example.com',
      exp: 9999999999,
    };

    const legacyUser = {
      _id: 'legacy-db-id',
      email: 'legacy@corp.com',
      openidId: null,
      role: SystemRoles.USER,
    };

    findUser.mockImplementation(async (query) => {
      if (query.$or) {
        return null;
      }
      if (query.email === 'legacy@corp.com') {
        return legacyUser;
      }
      return null;
    });

    const req = { headers: { authorization: 'Bearer tok' }, session: {} };
    const { user } = await invokeVerify(req, payloadNoEmail);

    expect(findUser).toHaveBeenCalledTimes(2);
    expect(findUser.mock.calls[1][0]).toEqual({ email: 'legacy@corp.com' });
    expect(user).toBeTruthy();
    expect(updateUser).toHaveBeenCalledWith(
      'legacy-db-id',
      expect.objectContaining({
        provider: 'openid',
        openidId: payloadNoEmail.sub,
        openidIssuer: 'https://issuer.example.com',
      }),
    );
  });
});
