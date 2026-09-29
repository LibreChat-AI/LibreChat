let mockActiveTenantId;
const mockRunAsSystem = jest.fn(async (fn) => {
  const previousTenantId = mockActiveTenantId;
  mockActiveTenantId = '__SYSTEM__';
  try {
    return await fn();
  } finally {
    mockActiveTenantId = previousTenantId;
  }
});
const mockTenantStorageRun = jest.fn(async (context, fn) => {
  const previousTenantId = mockActiveTenantId;
  mockActiveTenantId = context.tenantId;
  try {
    return await fn();
  } finally {
    mockActiveTenantId = previousTenantId;
  }
});
jest.mock('@librechat/data-schemas', () => ({
  logger: { error: jest.fn(), debug: jest.fn(), warn: jest.fn(), info: jest.fn() },
  runAsSystem: (fn) => mockRunAsSystem(fn),
  tenantStorage: { run: (context, fn) => mockTenantStorageRun(context, fn) },
}));
jest.mock('~/server/services/GraphTokenService', () => ({
  getGraphApiToken: jest.fn(),
}));
jest.mock('~/server/services/AuthService', () => ({
  clearOpenIDAuthTokens: jest.fn(),
  getOpenIDAppAuthToken: jest.fn(),
  requestPasswordReset: jest.fn(),
  setOpenIDAuthTokens: jest.fn(),
  storeOpenIDSession: jest.fn(),
  setCloudFrontAuthCookies: jest.fn(),
  resetPassword: jest.fn(),
  setAuthTokens: jest.fn(),
  registerUser: jest.fn(),
}));
jest.mock('~/strategies', () => ({ getOpenIdConfig: jest.fn(), getOpenIdEmail: jest.fn() }));
jest.mock('openid-client', () => ({ refreshTokenGrant: jest.fn() }));
jest.mock('~/models', () => ({
  deleteSession: jest.fn(),
  deleteAllUserSessions: jest.fn(),
  getUserById: jest.fn(),
  findSession: jest.fn(),
  updateUser: jest.fn(),
  findUser: jest.fn(),
  deleteTokens: jest.fn(),
}));
jest.mock('~/server/services/RefreshTokenBridge', () => ({
  OPENID_REFRESH_BRIDGE_GRACE_MS: 60 * 1000,
  createRefreshTokenBridgeFlightKey: jest.fn(() => 'bridge-flight-key'),
  deleteRefreshTokenBridges: jest.fn(),
  getRefreshTokenBridge: jest.fn(),
  storeRefreshTokenBridge: jest.fn(),
}));
jest.mock('~/server/services/OpenIDRefreshFlight', () => ({
  acquireOpenIDRefreshFlight: jest.fn(),
  assertOpenIDRefreshFlightDeliveryAvailable: jest.fn(),
  assertOpenIDRefreshFlightAvailable: jest.fn(),
  assertOpenIDRefreshSessionGenerationAvailable: jest.fn(),
  claimOpenIDRefreshFlightDelivery: jest.fn(),
  completeOpenIDRefreshFlight: jest.fn(),
  createOpenIDRefreshFlightKey: jest.fn(),
  failOpenIDRefreshFlight: jest.fn(),
  releaseOpenIDRefreshFlightDelivery: jest.fn(),
  revokeOpenIDRefreshFlights: jest.fn(),
  waitForOpenIDRefreshFlight: jest.fn(),
  withOpenIDRefreshFlightLease: jest.fn(),
}));
jest.mock('~/server/services/OpenIDSessionRefresh', () => ({
  refreshOpenIDSession: jest.fn(),
}));
jest.mock('@librechat/api', () => ({
  ...jest.requireActual('@librechat/api'),
  OPENID_EXPIRY_BUFFER_SECONDS: 30,
  math: jest.fn((value, fallback) => fallback),
  isEnabled: jest.fn(),
  findOpenIDUser: jest.fn(),
  getOpenIdIssuer: jest.fn(() => 'https://issuer.example.com'),
  createAuthIdentityContext: jest.fn(({ user }) => ({
    appUserId: user?._id?.toString?.() ?? user?.id,
    openidSubject: user?.openidId,
    tenantId: user?.tenantId,
    openidIssuer: user?.openidIssuer,
  })),
  isOpenIDSessionIdentityMatch: jest.fn((sessionIdentity, expectedIdentity) => {
    const normalize = (value) => {
      if (value == null) {
        return undefined;
      }
      const normalized = typeof value === 'string' ? value.trim() : value.toString().trim();
      return normalized || undefined;
    };
    const normalizeIssuer = (value) => normalize(value)?.replace(/\/+$/, '');
    return (
      Boolean(normalize(sessionIdentity?.appUserId)) &&
      Boolean(normalize(sessionIdentity?.openidSubject)) &&
      normalize(sessionIdentity?.appUserId) === normalize(expectedIdentity?.appUserId) &&
      normalize(sessionIdentity?.openidSubject) === normalize(expectedIdentity?.openidSubject) &&
      normalize(sessionIdentity?.tenantId) === normalize(expectedIdentity?.tenantId) &&
      normalizeIssuer(sessionIdentity?.openidIssuer) ===
        normalizeIssuer(expectedIdentity?.openidIssuer)
    );
  }),
  buildOpenIDRefreshParams: jest.fn(() => {
    const params = {};
    if (process.env.OPENID_SCOPE) {
      params.scope = process.env.OPENID_SCOPE;
    }
    if (process.env.OPENID_REFRESH_AUDIENCE) {
      params.audience = process.env.OPENID_REFRESH_AUDIENCE;
    }
    return params;
  }),
}));

const { createHash } = require('node:crypto');
const openIdClient = require('openid-client');
const jwt = require('jsonwebtoken');
const { logger } = require('@librechat/data-schemas');
const { isEnabled, findOpenIDUser, buildOpenIDRefreshParams } = require('@librechat/api');
const {
  graphTokenController,
  refreshController,
  registrationController,
} = require('./AuthController');
const { getGraphApiToken } = require('~/server/services/GraphTokenService');
const {
  clearOpenIDAuthTokens,
  getOpenIDAppAuthToken,
  setOpenIDAuthTokens,
  storeOpenIDSession,
  setCloudFrontAuthCookies,
  setAuthTokens,
  registerUser,
} = require('~/server/services/AuthService');
const { getOpenIdConfig, getOpenIdEmail } = require('~/strategies');
const { deleteSession, getUserById, findSession, updateUser, deleteTokens } = require('~/models');
const {
  createRefreshTokenBridgeFlightKey,
  deleteRefreshTokenBridges,
  getRefreshTokenBridge,
  storeRefreshTokenBridge,
} = require('~/server/services/RefreshTokenBridge');
const {
  acquireOpenIDRefreshFlight,
  assertOpenIDRefreshFlightDeliveryAvailable,
  assertOpenIDRefreshFlightAvailable,
  assertOpenIDRefreshSessionGenerationAvailable,
  claimOpenIDRefreshFlightDelivery,
  completeOpenIDRefreshFlight,
  createOpenIDRefreshFlightKey,
  failOpenIDRefreshFlight,
  releaseOpenIDRefreshFlightDelivery,
  revokeOpenIDRefreshFlights,
  waitForOpenIDRefreshFlight,
  withOpenIDRefreshFlightLease,
} = require('~/server/services/OpenIDRefreshFlight');
const { refreshOpenIDSession } = require('~/server/services/OpenIDSessionRefresh');
const { revokeOpenIDRefreshTokenChain } = require('~/server/services/OpenIDRefreshRecovery');

const ORIGINAL_OPENID_SCOPE = process.env.OPENID_SCOPE;
const ORIGINAL_OPENID_REFRESH_AUDIENCE = process.env.OPENID_REFRESH_AUDIENCE;
const ORIGINAL_JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET;
const ORIGINAL_NODE_ENV = process.env.NODE_ENV;

const { createOpenIDRefreshOwnershipError } = jest.requireActual('@librechat/api');
const ownershipLost = (message) => createOpenIDRefreshOwnershipError(message);

describe('OpenID logout refresh chain', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    createOpenIDRefreshFlightKey.mockImplementation(
      ({ refreshToken }) => `session:${refreshToken}`,
    );
    createRefreshTokenBridgeFlightKey.mockImplementation(
      ({ oldRefreshToken }) => `bridge:${oldRefreshToken}`,
    );
  });

  afterEach(() => {
    createRefreshTokenBridgeFlightKey.mockImplementation(() => 'bridge-flight-key');
  });

  it('tombstones every discovered successor generation before logout completes', async () => {
    createOpenIDRefreshFlightKey.mockImplementation(
      ({ refreshToken, identityContext }) =>
        `session:${identityContext.openidSubject}:${refreshToken}`,
    );
    createRefreshTokenBridgeFlightKey.mockImplementation(
      ({ oldRefreshToken, userId, openidIssuer }) =>
        `bridge:${userId}:${openidIssuer}:${oldRefreshToken}`,
    );
    const acceptedIdentity = {
      appUserId: 'user-2',
      openidSubject: 'subject-2',
      tenantId: 'tenant-1',
      openidIssuer: 'https://issuer-2.example.com',
    };
    revokeOpenIDRefreshFlights
      .mockResolvedValueOnce([{ refresh_token: 'rt-successor-1', acceptedIdentity }, null])
      .mockResolvedValueOnce([{ tokenset: { refresh_token: 'rt-successor-2' } }, null, null, null])
      .mockResolvedValueOnce([null, null, null, null]);
    const req = { user: { _id: 'user-1', openidId: 'subject-1' } };
    const user = req.user;
    const identityContext = {
      appUserId: 'user-1',
      openidSubject: 'subject-1',
      tenantId: 'tenant-1',
      openidIssuer: 'https://issuer.example.com',
    };

    await expect(
      revokeOpenIDRefreshTokenChain({
        req,
        user,
        identityContext,
        refreshTokens: ['rt-predecessor'],
        publicationKeys: ['recorded-publication-key'],
        ttl: 60_000,
      }),
    ).resolves.toEqual(['rt-predecessor', 'rt-successor-1', 'rt-successor-2']);

    expect(revokeOpenIDRefreshFlights).toHaveBeenNthCalledWith(1, {
      keys: [
        'recorded-publication-key',
        'session:subject-1:rt-predecessor',
        'bridge:user-1:https://issuer.example.com:rt-predecessor',
      ],
      ttl: 60_000,
    });
    expect(revokeOpenIDRefreshFlights).toHaveBeenNthCalledWith(2, {
      keys: [
        'session:subject-1:rt-successor-1',
        'bridge:user-1:https://issuer.example.com:rt-successor-1',
        'session:subject-2:rt-successor-1',
        'bridge:user-2:https://issuer-2.example.com:rt-successor-1',
      ],
      ttl: 60_000,
    });
    expect(revokeOpenIDRefreshFlights).toHaveBeenNthCalledWith(3, {
      keys: [
        'session:subject-1:rt-successor-2',
        'bridge:user-1:https://issuer.example.com:rt-successor-2',
        'session:subject-2:rt-successor-2',
        'bridge:user-2:https://issuer-2.example.com:rt-successor-2',
      ],
      ttl: 60_000,
    });
  });
});

describe('graphTokenController', () => {
  let req, res;

  beforeEach(() => {
    jest.clearAllMocks();
    isEnabled.mockReturnValue(true);
    assertOpenIDRefreshSessionGenerationAvailable.mockResolvedValue(true);
    claimOpenIDRefreshFlightDelivery.mockResolvedValue({
      status: 'completed',
      ownerId: 'publication-owner',
      deliveryId: 'delivery-1',
    });
    assertOpenIDRefreshFlightDeliveryAvailable.mockResolvedValue(undefined);
    releaseOpenIDRefreshFlightDelivery.mockResolvedValue(undefined);

    req = {
      user: {
        openidId: 'oid-123',
        provider: 'openid',
        federatedTokens: {
          access_token: 'federated-access-token',
          id_token: 'federated-id-token',
        },
      },
      headers: { authorization: 'Bearer app-jwt-which-is-id-token' },
      query: { scopes: 'https://graph.microsoft.com/.default' },
    };

    res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    };

    getGraphApiToken.mockResolvedValue({
      access_token: 'graph-access-token',
      token_type: 'Bearer',
      expires_in: 3600,
    });
  });

  it('should pass federatedTokens.access_token as OBO assertion, not the auth header bearer token', async () => {
    await graphTokenController(req, res);

    expect(getGraphApiToken).toHaveBeenCalledWith(
      req.user,
      'federated-access-token',
      'https://graph.microsoft.com/.default',
    );
    expect(getGraphApiToken).not.toHaveBeenCalledWith(
      expect.anything(),
      'app-jwt-which-is-id-token',
      expect.anything(),
    );
  });

  it('should return the graph token response on success', async () => {
    await graphTokenController(req, res);

    expect(res.json).toHaveBeenCalledWith({
      access_token: 'graph-access-token',
      token_type: 'Bearer',
      expires_in: 3600,
    });
  });

  it('leases the session generation across a Graph OBO exchange and response delivery', async () => {
    req.user.federatedTokens.access_token = 'session-access-token';
    req.session = {
      openidTokens: {
        accessToken: 'session-access-token',
        appUserId: 'user-1',
        tenantId: 'tenant-1',
        publicationFlightKey: 'publication-key',
        publicationFlightOwnerId: 'publication-owner',
        publicationFlightCreatedAt: 1000,
      },
    };

    await graphTokenController(req, res);

    expect(claimOpenIDRefreshFlightDelivery).toHaveBeenCalledWith({
      key: 'publication-key',
      ownerId: 'publication-owner',
      createdAt: 1000,
    });
    expect(assertOpenIDRefreshFlightDeliveryAvailable).toHaveBeenCalledWith({
      key: 'publication-key',
      ownerId: 'publication-owner',
      deliveryId: 'delivery-1',
    });
    expect(getGraphApiToken).toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ access_token: 'graph-access-token' }),
    );
    expect(releaseOpenIDRefreshFlightDelivery).toHaveBeenCalledWith({
      key: 'publication-key',
      ownerId: 'publication-owner',
      deliveryId: 'delivery-1',
    });
  });

  it('does not exchange a session-backed Graph token after logout tombstones its generation', async () => {
    req.user.federatedTokens.access_token = 'session-access-token';
    req.session = {
      openidTokens: {
        accessToken: 'session-access-token',
        appUserId: 'user-1',
        tenantId: 'tenant-1',
        publicationFlightKey: 'publication-key',
        publicationFlightOwnerId: 'publication-owner',
      },
    };
    assertOpenIDRefreshSessionGenerationAvailable.mockRejectedValueOnce(
      ownershipLost('revoked by logout'),
    );

    await graphTokenController(req, res);

    expect(getGraphApiToken).not.toHaveBeenCalled();
    expect(clearOpenIDAuthTokens).toHaveBeenCalledWith(req, res, undefined, 'tenant-1');
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it('does not fall back to a stale Graph token snapshot after the Express session is cleared', async () => {
    req.session = {};

    await graphTokenController(req, res);

    expect(getGraphApiToken).not.toHaveBeenCalled();
    expect(clearOpenIDAuthTokens).toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it('withholds a minted Graph token when logout revokes its delivery lease', async () => {
    req.user.federatedTokens.access_token = 'session-access-token';
    req.session = {
      openidTokens: {
        accessToken: 'session-access-token',
        appUserId: 'user-1',
        tenantId: 'tenant-1',
        publicationFlightKey: 'publication-key',
        publicationFlightOwnerId: 'publication-owner',
      },
    };
    assertOpenIDRefreshFlightDeliveryAvailable.mockRejectedValueOnce(
      ownershipLost('logout requested revocation'),
    );

    await graphTokenController(req, res);

    expect(getGraphApiToken).toHaveBeenCalled();
    expect(res.json).not.toHaveBeenCalledWith(
      expect.objectContaining({ access_token: 'graph-access-token' }),
    );
    expect(releaseOpenIDRefreshFlightDelivery).toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it('should return 403 when user is not authenticated via Entra ID', async () => {
    req.user.provider = 'google';
    req.user.openidId = undefined;

    await graphTokenController(req, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(getGraphApiToken).not.toHaveBeenCalled();
  });

  it('should return 403 when OPENID_REUSE_TOKENS is not enabled', async () => {
    isEnabled.mockReturnValue(false);

    await graphTokenController(req, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(getGraphApiToken).not.toHaveBeenCalled();
  });

  it('should return 400 when scopes query param is missing', async () => {
    req.query.scopes = undefined;

    await graphTokenController(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(getGraphApiToken).not.toHaveBeenCalled();
  });

  it('should return 401 when federatedTokens.access_token is missing', async () => {
    req.user.federatedTokens = {};

    await graphTokenController(req, res);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(getGraphApiToken).not.toHaveBeenCalled();
  });

  it('should return 401 when federatedTokens is absent entirely', async () => {
    req.user.federatedTokens = undefined;

    await graphTokenController(req, res);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(getGraphApiToken).not.toHaveBeenCalled();
  });

  it('should return 500 when getGraphApiToken throws', async () => {
    getGraphApiToken.mockRejectedValue(new Error('OBO exchange failed'));

    await graphTokenController(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({
      message: 'Failed to obtain Microsoft Graph token',
    });
  });
});

describe('refreshController – OpenID path', () => {
  const mockTokenset = {
    claims: jest.fn(),
    access_token: 'new-access',
    id_token: 'new-id',
    refresh_token: 'new-refresh',
    expires_in: 3600,
  };

  const baseClaims = {
    iss: 'https://issuer.example.com',
    sub: 'oidc-sub-123',
    oid: 'oid-456',
    email: 'user@example.com',
    exp: 9999999999,
  };

  const defaultUser = {
    _id: 'user-db-id',
    email: baseClaims.email,
    openidId: baseClaims.sub,
    tenantId: 'tenant-1',
    openidIssuer: baseClaims.iss,
    password: '$2b$10$hashedpassword',
    __v: 0,
    totpSecret: 'encrypted-totp-secret',
    backupCodes: ['hashed-code-1', 'hashed-code-2'],
  };

  let req, res;
  const idpSigningSecret = 'idp-signing-secret';

  const makeSessionToken = (claims = {}) =>
    jwt.sign(
      {
        sub: baseClaims.sub,
        exp: Math.floor(Date.now() / 1000) + 3600,
        ...claims,
      },
      idpSigningSecret,
    );

  const makeSignedUserId = (
    id = 'user-db-id',
    options = { expiresIn: '1h' },
    refreshToken = 'stored-refresh',
  ) =>
    jwt.sign(
      {
        id,
        refreshTokenHash: createHash('sha256').update(refreshToken).digest('base64url'),
      },
      process.env.JWT_REFRESH_SECRET,
      options,
    );

  const setOpenIDReuseCookies = (signedUserId = makeSignedUserId()) => {
    req.headers.cookie = [
      'token_provider=openid',
      'refreshToken=stored-refresh',
      `openid_user_id=${signedUserId}`,
    ].join('; ');
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockActiveTenantId = undefined;
    delete process.env.OPENID_SCOPE;
    delete process.env.OPENID_REFRESH_AUDIENCE;
    process.env.JWT_REFRESH_SECRET = 'test-refresh-secret';

    isEnabled.mockReturnValue(true);
    getOpenIdConfig.mockReturnValue({ some: 'config' });
    openIdClient.refreshTokenGrant.mockResolvedValue(mockTokenset);
    mockTokenset.claims.mockReturnValue(baseClaims);
    getOpenIdEmail.mockReturnValue(baseClaims.email);
    setOpenIDAuthTokens.mockReturnValue('new-app-token');
    getOpenIDAppAuthToken.mockReturnValue('new-app-token');
    storeOpenIDSession.mockResolvedValue(true);
    setCloudFrontAuthCookies.mockReturnValue(true);
    findOpenIDUser.mockResolvedValue({ user: { ...defaultUser }, error: null, migration: false });
    getRefreshTokenBridge.mockResolvedValue(null);
    storeRefreshTokenBridge.mockResolvedValue('bridge-version-1');
    acquireOpenIDRefreshFlight.mockResolvedValue({ acquired: true, ownerId: 'bridge-owner' });
    assertOpenIDRefreshFlightAvailable.mockResolvedValue({
      status: 'completed',
      ownerId: 'bridge-owner',
    });
    assertOpenIDRefreshFlightDeliveryAvailable.mockResolvedValue(undefined);
    assertOpenIDRefreshSessionGenerationAvailable.mockResolvedValue(true);
    claimOpenIDRefreshFlightDelivery.mockResolvedValue({
      status: 'completed',
      ownerId: 'publication-owner',
      deliveryId: 'delivery-1',
    });
    completeOpenIDRefreshFlight.mockResolvedValue({ status: 'completed' });
    failOpenIDRefreshFlight.mockResolvedValue({ status: 'failed' });
    releaseOpenIDRefreshFlightDelivery.mockResolvedValue(undefined);
    waitForOpenIDRefreshFlight.mockResolvedValue(null);
    withOpenIDRefreshFlightLease.mockImplementation(({ operation }) =>
      operation({
        assertLeaseOwned: jest.fn().mockResolvedValue(true),
        markLeaseSettled: jest.fn(),
      }),
    );
    refreshOpenIDSession.mockImplementation(
      async (refreshReq, _res, _user, _preference, _identity, options = {}) => {
        const activeRefreshToken = refreshReq.session.openidTokens.refreshToken;
        const refreshParams = buildOpenIDRefreshParams();
        logger.debug('[refreshController] OpenID refresh params', {
          has_scope: Boolean(process.env.OPENID_SCOPE),
          has_refresh_audience: Boolean(process.env.OPENID_REFRESH_AUDIENCE),
        });
        const tokenset = await openIdClient.refreshTokenGrant(
          getOpenIdConfig(),
          activeRefreshToken,
          refreshParams,
        );
        if (options.assertLeaseOwned) {
          await options.assertLeaseOwned();
        }
        logger.debug('[refreshController] OpenID refresh succeeded', {
          has_access_token: Boolean(tokenset.access_token),
          has_id_token: Boolean(tokenset.id_token),
          has_refresh_token: Boolean(tokenset.refresh_token),
          expires_in: tokenset.expires_in,
        });
        const resolvedTokenset = tokenset.refresh_token
          ? tokenset
          : { ...tokenset, refresh_token: activeRefreshToken };
        if (!options.deferPublication) {
          refreshReq.session.openidTokens = {
            ...refreshReq.session.openidTokens,
            accessToken: tokenset.access_token,
            idToken: tokenset.id_token,
            refreshToken: resolvedTokenset.refresh_token,
          };
        }
        return resolvedTokenset;
      },
    );
    getUserById.mockResolvedValue({
      _id: 'user-db-id',
      email: baseClaims.email,
      openidId: baseClaims.sub,
      tenantId: 'tenant-1',
      openidIssuer: baseClaims.iss,
    });
    updateUser.mockResolvedValue({});

    req = {
      headers: {
        cookie: `token_provider=openid; refreshToken=stored-refresh; openid_user_id=${makeSignedUserId()}`,
      },
      session: {},
    };

    res = {
      status: jest.fn().mockReturnThis(),
      send: jest.fn().mockReturnThis(),
      redirect: jest.fn(),
    };
  });

  afterAll(() => {
    if (ORIGINAL_OPENID_SCOPE === undefined) {
      delete process.env.OPENID_SCOPE;
    } else {
      process.env.OPENID_SCOPE = ORIGINAL_OPENID_SCOPE;
    }

    if (ORIGINAL_OPENID_REFRESH_AUDIENCE === undefined) {
      delete process.env.OPENID_REFRESH_AUDIENCE;
    } else {
      process.env.OPENID_REFRESH_AUDIENCE = ORIGINAL_OPENID_REFRESH_AUDIENCE;
    }

    if (ORIGINAL_JWT_REFRESH_SECRET === undefined) {
      delete process.env.JWT_REFRESH_SECRET;
    } else {
      process.env.JWT_REFRESH_SECRET = ORIGINAL_JWT_REFRESH_SECRET;
    }
  });

  /** Asserts the full OpenID refresh grant was triggered using default mock state. */
  const expectOpenIDRefreshGrant = () => {
    expect(openIdClient.refreshTokenGrant).toHaveBeenCalledWith(
      { some: 'config' },
      'stored-refresh',
      {},
    );
    expect(setOpenIDAuthTokens).toHaveBeenCalledWith(mockTokenset, req, res, {
      userId: 'user-db-id',
      existingRefreshToken: 'stored-refresh',
      tenantId: 'tenant-1',
      openidSubject: baseClaims.sub,
      openidIssuer: baseClaims.iss,
    });
    expect(storeOpenIDSession).toHaveBeenCalledWith(
      'user-db-id',
      'new-refresh',
      'tenant-1',
      'stored-refresh',
    );
  };

  it('falls back to the browser token only after the advanced session token is rejected', async () => {
    req.headers.cookie = `token_provider=openid; refreshToken=rt-cookie-current; openid_user_id=${makeSignedUserId()}`;
    req.session = {
      openidTokens: {
        refreshToken: 'rt-session-stale',
        browserRefreshToken: 'rt-browser-stale',
        appUserId: 'user-db-id',
      },
      reload: jest.fn((callback) => {
        req.session.openidTokens = {
          accessToken: 'rejected-access',
          refreshToken: 'rt-session-stale',
        };
        callback();
      }),
    };
    openIdClient.refreshTokenGrant
      .mockRejectedValueOnce(new Error('invalid_grant'))
      .mockResolvedValueOnce(mockTokenset);

    await refreshController(req, res);

    expect(openIdClient.refreshTokenGrant).toHaveBeenNthCalledWith(
      1,
      { some: 'config' },
      'rt-session-stale',
      {},
    );
    expect(req.session.reload).toHaveBeenCalled();
    expect(refreshOpenIDSession).toHaveBeenNthCalledWith(
      1,
      req,
      res,
      expect.objectContaining({ _id: 'user-db-id' }),
      'id_token',
      expect.objectContaining({ appUserId: 'user-db-id' }),
      { deferPublication: true, forceRefresh: true },
    );
    expect(refreshOpenIDSession).toHaveBeenNthCalledWith(
      2,
      req,
      res,
      expect.objectContaining({ _id: 'user-db-id' }),
      'id_token',
      expect.objectContaining({ appUserId: 'user-db-id' }),
      { deferPublication: true, forceRefresh: true },
    );
    expect(openIdClient.refreshTokenGrant).toHaveBeenNthCalledWith(
      2,
      { some: 'config' },
      'rt-cookie-current',
      {},
    );
    expect(setOpenIDAuthTokens).toHaveBeenCalledWith(mockTokenset, req, res, {
      userId: 'user-db-id',
      existingRefreshToken: 'rt-cookie-current',
      tenantId: 'tenant-1',
      openidSubject: baseClaims.sub,
      openidIssuer: baseClaims.iss,
    });
  });

  it('keeps the advanced session token when an older browser cookie arrives on drift', async () => {
    const reusableIdToken = makeSessionToken();
    req.headers.cookie = [
      'token_provider=openid',
      'refreshToken=rt-cookie-current',
      `openid_user_id=${makeSignedUserId()}`,
    ].join('; ');
    req.session = {
      openidTokens: {
        accessToken: 'session-access-token',
        idToken: reusableIdToken,
        refreshToken: 'rt-session-stale',
        browserRefreshToken: 'rt-browser-stale',
        lastRefreshedAt: Date.now(),
        appUserId: 'user-db-id',
        openidSubject: baseClaims.sub,
        tenantId: 'tenant-1',
        openidIssuer: baseClaims.iss,
      },
    };

    await refreshController(req, res);

    expect(getUserById).toHaveBeenCalled();
    expect(setCloudFrontAuthCookies).not.toHaveBeenCalled();
    expect(openIdClient.refreshTokenGrant).toHaveBeenCalledWith(
      { some: 'config' },
      'rt-session-stale',
      {},
    );
    expect(setOpenIDAuthTokens).toHaveBeenCalledWith(mockTokenset, req, res, {
      userId: 'user-db-id',
      existingRefreshToken: 'rt-session-stale',
      tenantId: 'tenant-1',
      openidSubject: baseClaims.sub,
      openidIssuer: baseClaims.iss,
    });
  });

  it('prefers the session token when pre-marker session state differs', async () => {
    req.headers.cookie = `token_provider=openid; refreshToken=rt-cookie-current; openid_user_id=${makeSignedUserId()}`;
    req.session = {
      openidTokens: {
        refreshToken: 'rt-session-stale',
        appUserId: 'user-db-id',
      },
    };

    await refreshController(req, res);

    expect(openIdClient.refreshTokenGrant).toHaveBeenCalledWith(
      { some: 'config' },
      'rt-session-stale',
      {},
    );
    expect(setOpenIDAuthTokens).toHaveBeenCalledWith(mockTokenset, req, res, {
      userId: 'user-db-id',
      existingRefreshToken: 'rt-session-stale',
      tenantId: 'tenant-1',
      openidSubject: baseClaims.sub,
      openidIssuer: baseClaims.iss,
    });
  });

  it('keeps the session refresh token when the browser cookie matches the session marker', async () => {
    req.headers.cookie = `token_provider=openid; refreshToken=rt-browser-stale; openid_user_id=${makeSignedUserId()}`;
    req.session = {
      openidTokens: {
        refreshToken: 'rt-session-current',
        browserRefreshToken: 'rt-browser-stale',
        appUserId: 'user-db-id',
      },
    };

    await refreshController(req, res);

    expect(openIdClient.refreshTokenGrant).toHaveBeenCalledWith(
      { some: 'config' },
      'rt-session-current',
      {},
    );
    expect(setOpenIDAuthTokens).toHaveBeenCalledWith(mockTokenset, req, res, {
      userId: 'user-db-id',
      existingRefreshToken: 'rt-session-current',
      tenantId: 'tenant-1',
      openidSubject: baseClaims.sub,
      openidIssuer: baseClaims.iss,
    });
  });

  it('should call getOpenIdEmail with token claims and use result for findOpenIDUser', async () => {
    await refreshController(req, res);

    expect(buildOpenIDRefreshParams).toHaveBeenCalledTimes(1);
    expect(getOpenIdEmail).toHaveBeenCalledWith(baseClaims);
    expect(findOpenIDUser).toHaveBeenCalledWith(
      expect.objectContaining({
        email: baseClaims.email,
        openidIssuer: baseClaims.iss,
      }),
    );
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('stores a recovery bridge when durable rotation fails after the IdP grant', async () => {
    storeOpenIDSession.mockRejectedValueOnce(new Error('durable transition failed'));

    await refreshController(req, res);

    expect(storeRefreshTokenBridge).toHaveBeenCalledWith({
      oldRefreshToken: 'stored-refresh',
      newRefreshToken: 'new-refresh',
      userId: 'user-db-id',
      tenantId: 'tenant-1',
      openidIssuer: baseClaims.iss,
      ttl: 60 * 1000,
    });
    expect(setOpenIDAuthTokens).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it('refreshes with the cookie token when the persisted session expired', async () => {
    req.session.reload = jest.fn((callback) => callback(new Error('failed to load session')));

    await refreshController(req, res);

    expect(clearOpenIDAuthTokens).not.toHaveBeenCalled();
    expect(setOpenIDAuthTokens).toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.send).not.toHaveBeenCalledWith({ code: 'OPENID_SESSION_MISSING' });
  });

  it('does not classify a session store outage as a missing session', async () => {
    req.session.reload = jest.fn((callback) => callback(new Error('connection unavailable')));

    await refreshController(req, res);

    expect(clearOpenIDAuthTokens).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(setOpenIDAuthTokens).not.toHaveBeenCalled();
  });

  it('uses a reloaded advanced session instead of publishing a stale flight result', async () => {
    req.session.reload = jest.fn((callback) => {
      req.session.openidTokens = {
        accessToken: 'advanced-access',
        idToken: 'advanced-id',
        refreshToken: 'advanced-refresh',
        accessTokenExpiresAt: Math.floor(Date.now() / 1000) + 3600,
        appUserId: 'advanced-user-id',
        openidSubject: 'advanced-subject',
        tenantId: 'advanced-tenant',
        openidIssuer: 'https://advanced-issuer.example.com',
      };
      callback();
    });

    await refreshController(req, res);

    expect(storeOpenIDSession).toHaveBeenCalledWith(
      'advanced-user-id',
      'advanced-refresh',
      'advanced-tenant',
      'advanced-refresh',
    );
    expect(setOpenIDAuthTokens).toHaveBeenCalledWith(
      expect.objectContaining({
        access_token: 'advanced-access',
        id_token: 'advanced-id',
        refresh_token: 'advanced-refresh',
      }),
      req,
      res,
      {
        userId: 'advanced-user-id',
        existingRefreshToken: 'advanced-refresh',
        tenantId: 'advanced-tenant',
        openidSubject: 'advanced-subject',
        openidIssuer: 'https://advanced-issuer.example.com',
      },
    );
  });

  it('reuses valid OpenID session tokens and refreshes CloudFront cookies', async () => {
    const reusableIdToken = makeSessionToken();
    const signedUserId = makeSignedUserId();
    setOpenIDReuseCookies(signedUserId);
    req.session = {
      openidTokens: {
        accessToken: 'session-access-token',
        idToken: reusableIdToken,
        refreshToken: 'stored-refresh',
        lastRefreshedAt: Date.now(),
        appUserId: 'user-db-id',
        openidSubject: baseClaims.sub,
        tenantId: 'tenant-1',
        openidIssuer: baseClaims.iss,
      },
    };
    const user = {
      ...defaultUser,
      federatedTokens: { access_token: 'do-not-return' },
    };
    getUserById.mockResolvedValue(user);

    await refreshController(req, res);

    expect(openIdClient.refreshTokenGrant).not.toHaveBeenCalled();
    expect(setOpenIDAuthTokens).not.toHaveBeenCalled();
    expect(storeRefreshTokenBridge).not.toHaveBeenCalled();
    expect(getUserById).toHaveBeenCalledWith(
      'user-db-id',
      '-password -__v -totpSecret -backupCodes -federatedTokens',
    );
    expect(mockRunAsSystem).toHaveBeenCalledTimes(1);
    expect(setCloudFrontAuthCookies).toHaveBeenCalledWith(req, res, user);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.send).toHaveBeenCalledWith({
      token: reusableIdToken,
      user: expect.objectContaining({
        _id: 'user-db-id',
        email: baseClaims.email,
        openidId: baseClaims.sub,
      }),
    });

    const sentPayload = res.send.mock.calls[0][0];
    expect(sentPayload.user).not.toHaveProperty('password');
    expect(sentPayload.user).not.toHaveProperty('totpSecret');
    expect(sentPayload.user).not.toHaveProperty('backupCodes');
    expect(sentPayload.user).not.toHaveProperty('federatedTokens');
    expect(logger.debug).toHaveBeenCalledWith(
      '[refreshController] OpenID session token reused',
      expect.objectContaining({
        token_type: 'id_token',
        cloudfront_cookies_set: true,
      }),
    );
    const debugOutput = JSON.stringify(logger.debug.mock.calls);
    expect(debugOutput).not.toContain(reusableIdToken);
    expect(debugOutput).not.toContain(signedUserId);
    expect(debugOutput).not.toContain('session-access-token');
  });

  it('rejects a late-saved session whose publication generation was tombstoned', async () => {
    setOpenIDReuseCookies();
    req.session = {
      openidTokens: {
        accessToken: 'session-access-token',
        idToken: makeSessionToken(),
        refreshToken: 'stored-refresh',
        lastRefreshedAt: Date.now(),
        appUserId: 'user-db-id',
        openidSubject: baseClaims.sub,
        tenantId: 'tenant-1',
        openidIssuer: baseClaims.iss,
        publicationFlightKey: 'publication-key',
        publicationFlightOwnerId: 'publication-owner',
      },
    };
    assertOpenIDRefreshSessionGenerationAvailable.mockRejectedValueOnce(
      ownershipLost('revoked by logout'),
    );

    await refreshController(req, res);

    expect(assertOpenIDRefreshSessionGenerationAvailable).toHaveBeenCalledWith({
      key: 'publication-key',
      ownerId: 'publication-owner',
    });
    expect(clearOpenIDAuthTokens).toHaveBeenCalledWith(req, res, 'user-db-id', 'tenant-1');
    expect(getUserById).not.toHaveBeenCalled();
    expect(setCloudFrontAuthCookies).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it('withholds a reusable response when logout revokes its delivery lease', async () => {
    setOpenIDReuseCookies();
    req.session = {
      openidTokens: {
        accessToken: 'session-access-token',
        idToken: makeSessionToken(),
        refreshToken: 'stored-refresh',
        lastRefreshedAt: Date.now(),
        appUserId: 'user-db-id',
        openidSubject: baseClaims.sub,
        tenantId: 'tenant-1',
        openidIssuer: baseClaims.iss,
        publicationFlightKey: 'publication-key',
        publicationFlightOwnerId: 'publication-owner',
        publicationFlightCreatedAt: 1000,
      },
    };
    assertOpenIDRefreshFlightDeliveryAvailable.mockRejectedValueOnce(
      ownershipLost('logout won during user lookup'),
    );

    await refreshController(req, res);

    expect(claimOpenIDRefreshFlightDelivery).toHaveBeenCalledWith({
      key: 'publication-key',
      ownerId: 'publication-owner',
      createdAt: 1000,
    });
    expect(assertOpenIDRefreshFlightDeliveryAvailable).toHaveBeenCalledWith({
      key: 'publication-key',
      ownerId: 'publication-owner',
      deliveryId: 'delivery-1',
    });
    expect(releaseOpenIDRefreshFlightDelivery).toHaveBeenCalled();
    expect(clearOpenIDAuthTokens).toHaveBeenCalledWith(req, res, 'user-db-id', 'tenant-1');
    expect(setCloudFrontAuthCookies).not.toHaveBeenCalled();
    expect(res.send).not.toHaveBeenCalledWith(
      expect.objectContaining({ token: expect.any(String) }),
    );
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it('falls through to full OpenID refresh when reusable session token identity mismatches', async () => {
    setOpenIDReuseCookies();
    req.session = {
      openidTokens: {
        accessToken: 'session-access-token',
        idToken: makeSessionToken(),
        refreshToken: 'stored-refresh',
        lastRefreshedAt: Date.now(),
        appUserId: 'other-user-id',
        openidSubject: baseClaims.sub,
        tenantId: 'tenant-1',
        openidIssuer: baseClaims.iss,
      },
    };

    await refreshController(req, res);

    expect(getUserById).toHaveBeenCalledWith(
      'user-db-id',
      '-password -__v -totpSecret -backupCodes -federatedTokens',
    );
    expect(setCloudFrontAuthCookies).not.toHaveBeenCalled();
    expectOpenIDRefreshGrant();
    expect(logger.warn).toHaveBeenCalledWith(
      '[refreshController] OpenID session token identity mismatch; forcing refresh',
      expect.objectContaining({
        userId: 'user-db-id',
      }),
    );
  });

  it('falls through to full OpenID refresh when session tokens are expired', async () => {
    const expiredToken = makeSessionToken({ exp: Math.floor(Date.now() / 1000) - 60 });
    setOpenIDReuseCookies();
    req.session = {
      openidTokens: {
        accessToken: expiredToken,
        idToken: expiredToken,
        refreshToken: 'stored-refresh',
        lastRefreshedAt: Date.now(),
        appUserId: 'user-db-id',
        openidSubject: baseClaims.sub,
        tenantId: 'tenant-1',
        openidIssuer: baseClaims.iss,
      },
    };
    findOpenIDUser.mockImplementationOnce(async () => {
      expect(mockActiveTenantId).toBe('tenant-1');
      return { user: { ...defaultUser }, error: null, migration: false };
    });

    await refreshController(req, res);

    expect(getUserById).toHaveBeenCalled();
    expect(mockRunAsSystem).toHaveBeenCalledTimes(1);
    expect(setCloudFrontAuthCookies).not.toHaveBeenCalled();
    expectOpenIDRefreshGrant();
  });

  it('falls through to full OpenID refresh when session tokens are near expiry', async () => {
    const nearExpiryToken = makeSessionToken({ exp: Math.floor(Date.now() / 1000) + 5 });
    setOpenIDReuseCookies();
    req.session = {
      openidTokens: {
        accessToken: nearExpiryToken,
        idToken: nearExpiryToken,
        refreshToken: 'stored-refresh',
        lastRefreshedAt: Date.now(),
      },
    };

    await refreshController(req, res);

    expect(getUserById).toHaveBeenCalled();
    expectOpenIDRefreshGrant();
  });

  it('falls through to full OpenID refresh when session tokens have no exp claim', async () => {
    const tokenWithoutExp = jwt.sign({ sub: baseClaims.sub }, idpSigningSecret);
    setOpenIDReuseCookies();
    req.session = {
      openidTokens: {
        accessToken: tokenWithoutExp,
        idToken: tokenWithoutExp,
        refreshToken: 'stored-refresh',
        lastRefreshedAt: Date.now(),
      },
    };

    await refreshController(req, res);

    expect(getUserById).toHaveBeenCalled();
    expectOpenIDRefreshGrant();
  });

  it('rejects refresh when neither the session nor signed marker identifies the user', async () => {
    setOpenIDReuseCookies('tampered-cookie');
    req.session = {
      openidTokens: {
        accessToken: 'session-access-token',
        idToken: makeSessionToken(),
        refreshToken: 'stored-refresh',
        lastRefreshedAt: Date.now(),
      },
    };

    await refreshController(req, res);

    expect(getUserById).not.toHaveBeenCalled();
    expect(openIdClient.refreshTokenGrant).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it('falls through to full OpenID refresh when the reuse user no longer exists', async () => {
    setOpenIDReuseCookies();
    req.session = {
      openidTokens: {
        accessToken: 'session-access-token',
        idToken: makeSessionToken(),
        refreshToken: 'stored-refresh',
        lastRefreshedAt: Date.now(),
      },
    };
    getUserById.mockResolvedValueOnce(null);

    await refreshController(req, res);

    expect(getUserById).toHaveBeenCalledWith(
      'user-db-id',
      '-password -__v -totpSecret -backupCodes -federatedTokens',
    );
    expect(setCloudFrontAuthCookies).not.toHaveBeenCalled();
    expectOpenIDRefreshGrant();
  });

  it('falls through to full OpenID refresh when session tokens are stale', async () => {
    setOpenIDReuseCookies();
    req.session = {
      openidTokens: {
        accessToken: 'session-access-token',
        idToken: makeSessionToken(),
        refreshToken: 'stored-refresh',
        lastRefreshedAt: Date.now() - 16 * 60 * 1000,
      },
    };

    await refreshController(req, res);

    expect(getUserById).toHaveBeenCalled();
    expectOpenIDRefreshGrant();
  });

  it('falls through to full OpenID refresh when session refresh timestamp is in the future', async () => {
    setOpenIDReuseCookies();
    req.session = {
      openidTokens: {
        accessToken: 'session-access-token',
        idToken: makeSessionToken(),
        refreshToken: 'stored-refresh',
        lastRefreshedAt: Date.now() + 60 * 1000,
      },
    };

    await refreshController(req, res);

    expect(getUserById).toHaveBeenCalled();
    expectOpenIDRefreshGrant();
  });

  it('falls through to full OpenID refresh for pre-upgrade sessions without lastRefreshedAt', async () => {
    setOpenIDReuseCookies();
    req.session = {
      openidTokens: {
        accessToken: 'session-access-token',
        idToken: makeSessionToken(),
        refreshToken: 'stored-refresh',
      },
    };

    await refreshController(req, res);

    expect(getUserById).toHaveBeenCalled();
    expectOpenIDRefreshGrant();
  });

  it('sanitizes Mongoose-style user documents on the OpenID reuse path', async () => {
    const reusableIdToken = makeSessionToken();
    setOpenIDReuseCookies();
    req.session = {
      openidTokens: {
        accessToken: 'session-access-token',
        idToken: reusableIdToken,
        refreshToken: 'stored-refresh',
        lastRefreshedAt: Date.now(),
        appUserId: 'user-db-id',
        openidSubject: baseClaims.sub,
        tenantId: 'tenant-1',
        openidIssuer: baseClaims.iss,
      },
    };
    const userDocument = {
      toObject: () => ({
        ...defaultUser,
        federatedTokens: { access_token: 'do-not-return' },
      }),
    };
    getUserById.mockResolvedValue(userDocument);

    await refreshController(req, res);

    const sentPayload = res.send.mock.calls[0][0];
    expect(setCloudFrontAuthCookies).toHaveBeenCalledWith(req, res, userDocument);
    expect(sentPayload).toEqual({
      token: reusableIdToken,
      user: expect.objectContaining({
        _id: 'user-db-id',
        email: baseClaims.email,
      }),
    });
    expect(sentPayload.user).not.toHaveProperty('password');
    expect(sentPayload.user).not.toHaveProperty('federatedTokens');
  });

  it('should pass scope-only OpenID refresh params when OPENID_SCOPE is set', async () => {
    process.env.OPENID_SCOPE = 'openid profile email';

    await refreshController(req, res);

    expect(openIdClient.refreshTokenGrant).toHaveBeenCalledWith(
      { some: 'config' },
      'stored-refresh',
      { scope: 'openid profile email' },
    );
  });

  it('should pass scope and audience OpenID refresh params when both are set', async () => {
    process.env.OPENID_SCOPE = 'openid profile email';
    process.env.OPENID_REFRESH_AUDIENCE = 'https://api.example.com';

    await refreshController(req, res);

    expect(openIdClient.refreshTokenGrant).toHaveBeenCalledWith(
      { some: 'config' },
      'stored-refresh',
      {
        scope: 'openid profile email',
        audience: 'https://api.example.com',
      },
    );
  });

  it('should pass audience-only OpenID refresh params when scope is unset', async () => {
    process.env.OPENID_REFRESH_AUDIENCE = 'https://api.example.com';

    await refreshController(req, res);

    expect(openIdClient.refreshTokenGrant).toHaveBeenCalledWith(
      { some: 'config' },
      'stored-refresh',
      { audience: 'https://api.example.com' },
    );
  });

  it('should omit empty OpenID refresh audience', async () => {
    process.env.OPENID_SCOPE = 'openid profile email';
    process.env.OPENID_REFRESH_AUDIENCE = '';

    await refreshController(req, res);

    expect(openIdClient.refreshTokenGrant).toHaveBeenCalledWith(
      { some: 'config' },
      'stored-refresh',
      { scope: 'openid profile email' },
    );
  });

  it('should keep OpenID refresh diagnostics free of token and audience values', async () => {
    process.env.OPENID_SCOPE = 'openid profile email';
    process.env.OPENID_REFRESH_AUDIENCE = 'https://api.example.com';

    await refreshController(req, res);

    expect(logger.debug).toHaveBeenCalledWith('[refreshController] OpenID refresh params', {
      has_scope: true,
      has_refresh_audience: true,
    });
    expect(logger.debug).toHaveBeenCalledWith('[refreshController] OpenID refresh succeeded', {
      has_access_token: true,
      has_id_token: true,
      has_refresh_token: true,
      expires_in: 3600,
    });
    const debugOutput = JSON.stringify(logger.debug.mock.calls);
    expect(debugOutput).not.toContain('stored-refresh');
    expect(debugOutput).not.toContain('new-access');
    expect(debugOutput).not.toContain('new-id');
    expect(debugOutput).not.toContain('new-refresh');
    expect(debugOutput).not.toContain('https://api.example.com');
  });

  it('should use OPENID_EMAIL_CLAIM-resolved value when claim is present in token', async () => {
    const claimsWithUpn = { ...baseClaims, upn: 'user@corp.example.com' };
    mockTokenset.claims.mockReturnValue(claimsWithUpn);
    getOpenIdEmail.mockReturnValue('user@corp.example.com');

    const user = {
      _id: 'user-db-id',
      email: 'user@corp.example.com',
      openidId: baseClaims.sub,
    };
    findOpenIDUser.mockResolvedValue({ user, error: null, migration: false });

    await refreshController(req, res);

    expect(getOpenIdEmail).toHaveBeenCalledWith(claimsWithUpn);
    expect(findOpenIDUser).toHaveBeenCalledWith(
      expect.objectContaining({
        email: 'user@corp.example.com',
        openidIssuer: baseClaims.iss,
      }),
    );
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('should fall back to claims.email when configured claim is absent from token claims', async () => {
    getOpenIdEmail.mockReturnValue(baseClaims.email);

    await refreshController(req, res);

    expect(findOpenIDUser).toHaveBeenCalledWith(
      expect.objectContaining({
        email: baseClaims.email,
        openidIssuer: baseClaims.iss,
      }),
    );
  });

  it('should not expose sensitive fields or federatedTokens in refresh response', async () => {
    await refreshController(req, res);

    const sentPayload = res.send.mock.calls[0][0];
    expect(sentPayload).toEqual({
      token: 'new-app-token',
      user: expect.objectContaining({
        _id: 'user-db-id',
        email: baseClaims.email,
        openidId: baseClaims.sub,
      }),
    });
    expect(sentPayload.user).not.toHaveProperty('federatedTokens');
    expect(sentPayload.user).not.toHaveProperty('password');
    expect(sentPayload.user).not.toHaveProperty('totpSecret');
    expect(sentPayload.user).not.toHaveProperty('backupCodes');
    expect(sentPayload.user).not.toHaveProperty('__v');
  });

  it('should update openidId when migration is triggered on refresh', async () => {
    const user = { _id: 'user-db-id', email: baseClaims.email, openidId: null };
    findOpenIDUser.mockResolvedValue({ user, error: null, migration: true });

    await refreshController(req, res);

    expect(updateUser).toHaveBeenCalledWith(
      'user-db-id',
      expect.objectContaining({
        provider: 'openid',
        openidId: baseClaims.sub,
        openidIssuer: baseClaims.iss,
      }),
    );
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('should return 401 and redirect to /login when findOpenIDUser returns no user', async () => {
    findOpenIDUser.mockResolvedValue({ user: null, error: null, migration: false });

    await refreshController(req, res);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.redirect).toHaveBeenCalledWith('/login');
  });

  it('should return 401 and redirect when findOpenIDUser returns an error', async () => {
    findOpenIDUser.mockResolvedValue({ user: null, error: 'AUTH_FAILED', migration: false });

    await refreshController(req, res);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.redirect).toHaveBeenCalledWith('/login');
  });

  it('rejects a refreshed identity that resolves to a different user', async () => {
    findOpenIDUser.mockResolvedValue({
      user: { ...defaultUser, _id: 'different-user-id' },
      error: null,
      migration: false,
    });

    await refreshController(req, res);

    expect(setOpenIDAuthTokens).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      '[refreshController] Refreshed identity resolved a different user; refusing token issuance',
      {
        refreshUserId: 'user-db-id',
        resolvedUserId: 'different-user-id',
      },
    );
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.redirect).toHaveBeenCalledWith('/login');
  });

  it('should preserve invalid OpenID refresh token behavior', async () => {
    openIdClient.refreshTokenGrant.mockRejectedValue(new Error('invalid_grant'));

    await refreshController(req, res);

    expect(getRefreshTokenBridge).toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.send).toHaveBeenCalledWith('Invalid OpenID refresh token');
  });

  it('does not use the bridge when signed user-id cookie payload is invalid', async () => {
    setOpenIDReuseCookies(jwt.sign({ id: 123 }, process.env.JWT_REFRESH_SECRET));
    openIdClient.refreshTokenGrant.mockRejectedValue(new Error('invalid_grant'));

    await refreshController(req, res);

    expect(getUserById).not.toHaveBeenCalled();
    expect(getRefreshTokenBridge).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it('does not use the bridge when the signed marker belongs to another refresh token', async () => {
    setOpenIDReuseCookies(makeSignedUserId('user-db-id', { expiresIn: '1h' }, 'different-refresh'));
    openIdClient.refreshTokenGrant.mockRejectedValue(new Error('invalid_grant'));

    await refreshController(req, res);

    expect(getUserById).toHaveBeenCalled();
    expect(getRefreshTokenBridge).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it('does not use the bridge when the signed marker lacks a refresh-token binding', async () => {
    setOpenIDReuseCookies(
      jwt.sign({ id: 'user-db-id' }, process.env.JWT_REFRESH_SECRET, { expiresIn: '1h' }),
    );
    openIdClient.refreshTokenGrant.mockRejectedValue(new Error('invalid_grant'));

    await refreshController(req, res);

    expect(getUserById).toHaveBeenCalled();
    expect(getRefreshTokenBridge).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  /** The recovery grant need not rotate. When it does not, the browser must still be moved onto
   *  the bridged token rather than back onto the stale one the bridge exists to retire. */
  it('installs the bridged token when the recovery grant does not rotate', async () => {
    setOpenIDReuseCookies();
    req.session = {};
    getUserById.mockResolvedValue({
      _id: 'user-db-id',
      email: baseClaims.email,
      openidId: baseClaims.sub,
      tenantId: 'tenant-1',
      openidIssuer: 'https://issuer.example.com',
    });
    getRefreshTokenBridge.mockImplementationOnce(async () => {
      expect(mockActiveTenantId).toBe('tenant-1');
      return 'bridged-refresh';
    });
    const nonRotatingTokenset = { ...mockTokenset };
    delete nonRotatingTokenset.refresh_token;
    openIdClient.refreshTokenGrant
      .mockRejectedValueOnce(new Error('invalid_grant'))
      .mockResolvedValueOnce(nonRotatingTokenset);

    await refreshController(req, res);

    expect(storeOpenIDSession).toHaveBeenCalledWith(
      'user-db-id',
      'bridged-refresh',
      'tenant-1',
      'stored-refresh',
    );
    expect(setOpenIDAuthTokens).toHaveBeenCalledWith(
      expect.objectContaining({ refresh_token: 'bridged-refresh' }),
      req,
      res,
      expect.any(Object),
    );
    expect(res.status).toHaveBeenCalledWith(200);
  });

  /** A recovery grant that omits `id_token` leaves the rebuilt token set with no identity
   *  material of its own; the refresh carries the stripped token in a non-enumerable marker so
   *  claims still resolve without that expired token re-entering the auth response. */
  it('resolves identity from the marker when the refresh stripped an expired id_token', async () => {
    setOpenIDReuseCookies();
    req.session = {};
    getUserById.mockResolvedValue({
      _id: 'user-db-id',
      email: baseClaims.email,
      openidId: baseClaims.sub,
      tenantId: 'tenant-1',
      openidIssuer: 'https://issuer.example.com',
    });
    getRefreshTokenBridge.mockResolvedValue('bridged-refresh');
    let refreshCall = 0;
    refreshOpenIDSession.mockImplementation(async () => {
      refreshCall += 1;
      if (refreshCall === 1) {
        throw new Error('invalid_grant');
      }
      const stripped = {
        access_token: 'new-access',
        refresh_token: 'bridged-refresh',
        expires_at: Math.floor(Date.now() / 1000) + 3600,
      };
      Object.defineProperty(stripped, '__identityIdToken', {
        value: jwt.sign(baseClaims, 'idp-secret'),
        enumerable: false,
        configurable: true,
      });
      return stripped;
    });

    await refreshController(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(setOpenIDAuthTokens).toHaveBeenCalledWith(
      expect.objectContaining({ refresh_token: 'bridged-refresh' }),
      req,
      res,
      expect.any(Object),
    );
    expect(setOpenIDAuthTokens.mock.calls.at(-1)[0].id_token).toBeUndefined();
  });

  it('recovers stale refresh-token cookies and keeps a short grace bridge', async () => {
    setOpenIDReuseCookies();
    req.session = {};
    const bridgeUser = {
      _id: 'user-db-id',
      email: baseClaims.email,
      openidId: baseClaims.sub,
      tenantId: 'tenant-1',
      openidIssuer: 'https://issuer.example.com',
    };
    getUserById.mockResolvedValue(bridgeUser);
    getRefreshTokenBridge.mockResolvedValue('bridged-refresh');
    openIdClient.refreshTokenGrant
      .mockRejectedValueOnce(new Error('invalid_grant'))
      .mockResolvedValueOnce(mockTokenset);

    await refreshController(req, res);

    expect(getUserById).toHaveBeenCalledWith(
      'user-db-id',
      '-password -__v -totpSecret -backupCodes -federatedTokens',
    );
    expect(getRefreshTokenBridge).toHaveBeenCalledWith({
      oldRefreshToken: 'stored-refresh',
      userId: 'user-db-id',
      tenantId: 'tenant-1',
      openidIssuer: 'https://issuer.example.com',
    });
    expect(openIdClient.refreshTokenGrant).toHaveBeenNthCalledWith(
      1,
      { some: 'config' },
      'stored-refresh',
      {},
    );
    expect(openIdClient.refreshTokenGrant).toHaveBeenNthCalledWith(
      2,
      { some: 'config' },
      'bridged-refresh',
      {},
    );
    expect(findOpenIDUser).toHaveBeenCalledWith(
      expect.objectContaining({
        strategyName: 'refreshController (bridge recovery)',
      }),
    );
    expect(setOpenIDAuthTokens).toHaveBeenCalledTimes(1);
    expect(setOpenIDAuthTokens).toHaveBeenCalledWith(mockTokenset, req, res, {
      userId: 'user-db-id',
      existingRefreshToken: 'stored-refresh',
      tenantId: 'tenant-1',
      openidSubject: baseClaims.sub,
      openidIssuer: baseClaims.iss,
    });
    expect(completeOpenIDRefreshFlight).toHaveBeenCalledWith({
      key: 'bridge-flight-key',
      ownerId: 'bridge-owner',
      tokens: expect.objectContaining({
        appAuthToken: 'new-app-token',
        claims: baseClaims,
        tokenset: mockTokenset,
      }),
    });
    expect(completeOpenIDRefreshFlight.mock.invocationCallOrder[0]).toBeLessThan(
      setOpenIDAuthTokens.mock.invocationCallOrder[0],
    );
    expect(storeRefreshTokenBridge).toHaveBeenCalledWith({
      oldRefreshToken: 'stored-refresh',
      newRefreshToken: 'new-refresh',
      userId: 'user-db-id',
      tenantId: 'tenant-1',
      openidIssuer: 'https://issuer.example.com',
      ttl: 60000,
    });
    /** Recovery issues a fresh credential like any other refresh, so the durable session has to
     *  follow it — otherwise the record still names the token the bridge just replaced. */
    expect(storeOpenIDSession).toHaveBeenCalledWith(
      'user-db-id',
      'new-refresh',
      'tenant-1',
      'stored-refresh',
    );
    const lookupIdentity = getRefreshTokenBridge.mock.calls[0][0];
    const graceIdentity = storeRefreshTokenBridge.mock.calls[0][0];
    expect(graceIdentity).toEqual(
      expect.objectContaining({
        oldRefreshToken: lookupIdentity.oldRefreshToken,
        userId: lookupIdentity.userId,
        tenantId: lookupIdentity.tenantId,
        openidIssuer: lookupIdentity.openidIssuer,
      }),
    );
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('joins an existing stale-cookie recovery without rotating the bridged token again', async () => {
    setOpenIDReuseCookies();
    req.session = {};
    const bridgeUser = {
      _id: 'user-db-id',
      email: baseClaims.email,
      openidId: baseClaims.sub,
      tenantId: 'tenant-1',
      openidIssuer: 'https://issuer.example.com',
    };
    getUserById.mockResolvedValue(bridgeUser);
    getRefreshTokenBridge.mockResolvedValue('bridged-refresh');
    openIdClient.refreshTokenGrant.mockRejectedValueOnce(new Error('invalid_grant'));
    acquireOpenIDRefreshFlight.mockResolvedValue({ acquired: false, ownerId: 'other-owner' });
    waitForOpenIDRefreshFlight.mockResolvedValue({
      appAuthToken: 'shared-app-token',
      __flightOwnerId: 'shared-owner',
      tokenset: { ...mockTokenset },
      claims: baseClaims,
      openidIssuer: baseClaims.iss,
    });
    getOpenIDAppAuthToken.mockReturnValueOnce('shared-app-token');
    setOpenIDAuthTokens.mockReturnValueOnce('shared-app-token');

    await refreshController(req, res);

    expect(createRefreshTokenBridgeFlightKey).toHaveBeenCalledWith({
      oldRefreshToken: 'stored-refresh',
      userId: 'user-db-id',
      tenantId: 'tenant-1',
      openidIssuer: 'https://issuer.example.com',
    });
    expect(openIdClient.refreshTokenGrant).toHaveBeenCalledTimes(1);
    expect(withOpenIDRefreshFlightLease).not.toHaveBeenCalled();
    expect(setOpenIDAuthTokens).toHaveBeenCalledWith(
      expect.objectContaining({ refresh_token: 'new-refresh' }),
      req,
      res,
      expect.objectContaining({
        userId: 'user-db-id',
        existingRefreshToken: 'stored-refresh',
      }),
    );
    expect(storeOpenIDSession).not.toHaveBeenCalled();
    expect(res.send).toHaveBeenCalledWith(expect.objectContaining({ token: 'shared-app-token' }));
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('publishes an ordinary completed result to a cross-replica follower', async () => {
    setOpenIDReuseCookies();
    req.session = {};
    getUserById.mockResolvedValue({
      ...defaultUser,
      openidIssuer: 'https://predecessor.example.com',
    });
    acquireOpenIDRefreshFlight.mockResolvedValue({ acquired: false, ownerId: 'other-owner' });
    waitForOpenIDRefreshFlight.mockResolvedValue({
      appAuthToken: 'shared-app-token',
      __flightOwnerId: 'shared-owner',
      tokenset: { ...mockTokenset },
      claims: baseClaims,
      openidIssuer: baseClaims.iss,
    });
    getOpenIDAppAuthToken.mockReturnValueOnce('shared-app-token');
    setOpenIDAuthTokens.mockReturnValueOnce('shared-app-token');

    await refreshController(req, res);

    expect(createRefreshTokenBridgeFlightKey).toHaveBeenCalledWith({
      oldRefreshToken: 'stored-refresh',
      userId: 'user-db-id',
      tenantId: 'tenant-1',
      openidIssuer: 'https://predecessor.example.com',
    });
    expect(storeOpenIDSession).not.toHaveBeenCalled();
    expect(setOpenIDAuthTokens).toHaveBeenCalledWith(
      expect.objectContaining({ refresh_token: 'new-refresh' }),
      req,
      res,
      expect.objectContaining({
        userId: 'user-db-id',
        existingRefreshToken: 'stored-refresh',
        openidIssuer: baseClaims.iss,
      }),
    );
    expect(res.send).toHaveBeenCalledWith(expect.objectContaining({ token: 'shared-app-token' }));
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('claims the completed generation before delivering a newly refreshed app token', async () => {
    setOpenIDReuseCookies();
    req.session = {};
    setOpenIDAuthTokens.mockImplementationOnce(() => {
      req.session.openidTokens = {
        accessToken: 'new-access',
        refreshToken: 'new-refresh',
        appUserId: 'user-db-id',
        tenantId: 'tenant-1',
      };
      return 'new-app-token';
    });

    await refreshController(req, res);

    expect(claimOpenIDRefreshFlightDelivery).toHaveBeenCalledWith({
      key: 'bridge-flight-key',
      ownerId: 'bridge-owner',
      createdAt: expect.any(Number),
    });
    expect(assertOpenIDRefreshFlightDeliveryAvailable).toHaveBeenCalledWith({
      key: 'bridge-flight-key',
      ownerId: 'bridge-owner',
      deliveryId: 'delivery-1',
    });
    expect(res.send).toHaveBeenCalledWith(expect.objectContaining({ token: 'new-app-token' }));
    expect(releaseOpenIDRefreshFlightDelivery).toHaveBeenCalled();
  });

  it('does not deliver a newly refreshed app token after logout requests revocation', async () => {
    setOpenIDReuseCookies();
    req.session = {};
    setOpenIDAuthTokens.mockImplementationOnce(() => {
      req.session.openidTokens = {
        accessToken: 'new-access',
        refreshToken: 'new-refresh',
        appUserId: 'user-db-id',
        tenantId: 'tenant-1',
      };
      return 'new-app-token';
    });
    assertOpenIDRefreshFlightDeliveryAvailable.mockRejectedValueOnce(
      ownershipLost('logout requested revocation'),
    );

    await refreshController(req, res);

    expect(releaseOpenIDRefreshFlightDelivery).toHaveBeenCalled();
    expect(clearOpenIDAuthTokens).toHaveBeenCalled();
    expect(res.send).not.toHaveBeenCalledWith(expect.objectContaining({ token: 'new-app-token' }));
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it('clears a follower publication when logout revokes its generation after emission', async () => {
    setOpenIDReuseCookies();
    req.session = {};
    getUserById.mockResolvedValue(defaultUser);
    acquireOpenIDRefreshFlight.mockResolvedValue({ acquired: false, ownerId: 'other-owner' });
    waitForOpenIDRefreshFlight.mockResolvedValue({
      appAuthToken: 'shared-app-token',
      __flightOwnerId: 'shared-owner',
      tokenset: { ...mockTokenset },
      claims: baseClaims,
      openidIssuer: baseClaims.iss,
    });
    getOpenIDAppAuthToken.mockReturnValueOnce('shared-app-token');
    setOpenIDAuthTokens.mockImplementationOnce(() => {
      req.session.openidTokens = {
        accessToken: 'new-access',
        refreshToken: 'new-refresh',
      };
      return 'shared-app-token';
    });
    assertOpenIDRefreshFlightAvailable
      .mockResolvedValueOnce({ status: 'completed', ownerId: 'shared-owner' })
      .mockResolvedValueOnce({ status: 'completed', ownerId: 'shared-owner' })
      .mockResolvedValueOnce({ status: 'completed', ownerId: 'shared-owner' })
      .mockRejectedValueOnce(ownershipLost('revoked after emission'));

    await refreshController(req, res);

    expect(setOpenIDAuthTokens).toHaveBeenCalled();
    expect(req.session.openidTokens).toEqual(
      expect.objectContaining({
        publicationFlightKey: 'bridge-flight-key',
        publicationFlightOwnerId: 'shared-owner',
      }),
    );
    expect(clearOpenIDAuthTokens).toHaveBeenCalledWith(req, res, 'user-db-id', 'tenant-1');
    expect(deleteSession).toHaveBeenCalledWith({ refreshToken: 'new-refresh' });
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.send).not.toHaveBeenCalledWith(
      expect.objectContaining({ token: 'shared-app-token' }),
    );
  });

  it('returns a newer stable-refresh session instead of a stale publication result', async () => {
    setOpenIDReuseCookies();
    req.session = {
      reload: jest.fn((callback) => {
        req.session.openidTokens = {
          accessToken: 'advanced-access',
          idToken: 'advanced-id',
          refreshToken: 'stored-refresh',
          accessTokenExpiresAt: Math.floor(Date.now() / 1000) + 7200,
          appUserId: 'user-db-id',
          openidSubject: baseClaims.sub,
          tenantId: 'tenant-1',
          openidIssuer: baseClaims.iss,
          publicationFlightKey: 'advanced-publication-key',
          publicationFlightOwnerId: 'advanced-publication-owner',
        };
        callback();
      }),
    };
    getUserById.mockResolvedValue(defaultUser);
    acquireOpenIDRefreshFlight.mockResolvedValue({ acquired: false, ownerId: 'other-owner' });
    waitForOpenIDRefreshFlight.mockResolvedValue({
      appAuthToken: 'stale-app-token',
      __flightOwnerId: 'shared-owner',
      tokenset: {
        access_token: 'stale-access',
        id_token: 'stale-id',
        refresh_token: 'stored-refresh',
        expires_in: 3600,
      },
      claims: baseClaims,
      openidIssuer: baseClaims.iss,
      predecessorAccessToken: 'predecessor-access',
    });
    getOpenIDAppAuthToken.mockReturnValueOnce('advanced-app-token');
    setOpenIDAuthTokens.mockReturnValueOnce('advanced-app-token');

    await refreshController(req, res);

    expect(setOpenIDAuthTokens).toHaveBeenCalledWith(
      expect.objectContaining({
        access_token: 'advanced-access',
        refresh_token: 'stored-refresh',
      }),
      req,
      res,
      expect.any(Object),
    );
    expect(res.send).toHaveBeenCalledWith(expect.objectContaining({ token: 'advanced-app-token' }));
    expect(req.session.openidTokens).toEqual(
      expect.objectContaining({
        publicationFlightKey: 'advanced-publication-key',
        publicationFlightOwnerId: 'advanced-publication-owner',
      }),
    );
  });

  it('recovers with serialized identity claims when the refreshed ID token is omitted', async () => {
    setOpenIDReuseCookies();
    req.session = {};
    getRefreshTokenBridge.mockResolvedValue('bridged-refresh');
    refreshOpenIDSession
      .mockRejectedValueOnce(Object.assign(new Error('invalid_grant'), { error: 'invalid_grant' }))
      .mockResolvedValueOnce({
        access_token: 'new-access',
        refresh_token: 'new-refresh',
        expires_at: Math.floor(Date.now() / 1000) + 3600,
        __identityClaims: baseClaims,
      });

    await refreshController(req, res);

    expect(findOpenIDUser).toHaveBeenCalledWith(
      expect.objectContaining({
        email: baseClaims.email,
        openidId: baseClaims.sub,
        strategyName: 'refreshController (bridge recovery)',
      }),
    );
    expect(setOpenIDAuthTokens).toHaveBeenCalledWith(
      expect.objectContaining({
        access_token: 'new-access',
        __identityClaims: baseClaims,
      }),
      req,
      res,
      expect.objectContaining({ openidSubject: baseClaims.sub }),
    );
    expect(setOpenIDAuthTokens.mock.calls[0][0]).not.toHaveProperty('id_token');
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('rejects bridge recovery when retry resolves a different user than the signed cookie', async () => {
    setOpenIDReuseCookies(makeSignedUserId('cookie-user-id'));
    req.session = {};
    getUserById.mockResolvedValue({
      _id: 'cookie-user-id',
      tenantId: 'tenant-1',
      openidIssuer: 'https://issuer.example.com',
    });
    getRefreshTokenBridge.mockResolvedValue('bridged-refresh');
    findOpenIDUser.mockResolvedValueOnce({
      user: { ...defaultUser, _id: 'different-user-id' },
      error: null,
      migration: false,
    });
    openIdClient.refreshTokenGrant
      .mockRejectedValueOnce(new Error('invalid_grant'))
      .mockResolvedValueOnce(mockTokenset);

    await refreshController(req, res);

    expect(openIdClient.refreshTokenGrant).toHaveBeenCalledTimes(2);
    expect(setOpenIDAuthTokens).not.toHaveBeenCalled();
    expect(storeRefreshTokenBridge).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      '[refreshController] Bridge recovery resolved a different user; refusing token issuance',
      {
        cookieUserId: 'cookie-user-id',
        resolvedUserId: 'different-user-id',
      },
    );
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.send).toHaveBeenCalledWith('Invalid OpenID refresh token');
  });

  it('does not re-store the bridge when bridged refresh retry fails', async () => {
    setOpenIDReuseCookies();
    req.session = {};
    getUserById.mockResolvedValue({
      _id: 'user-db-id',
      tenantId: 'tenant-1',
      openidIssuer: 'https://issuer.example.com',
    });
    getRefreshTokenBridge.mockResolvedValue('bridged-refresh');
    openIdClient.refreshTokenGrant
      .mockRejectedValueOnce(new Error('invalid_grant'))
      .mockRejectedValueOnce(new Error('temporarily unavailable'));

    await refreshController(req, res);

    expect(getRefreshTokenBridge).toHaveBeenCalled();
    expect(storeRefreshTokenBridge).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it('returns success when bridge grace-period storage fails after bridged refresh succeeds', async () => {
    setOpenIDReuseCookies();
    req.session = {};
    getUserById.mockResolvedValue({
      _id: 'user-db-id',
      email: baseClaims.email,
      openidId: baseClaims.sub,
      tenantId: 'tenant-1',
      openidIssuer: 'https://issuer.example.com',
    });
    getRefreshTokenBridge.mockResolvedValue('bridged-refresh');
    storeRefreshTokenBridge.mockRejectedValueOnce(new Error('grace failed'));
    openIdClient.refreshTokenGrant
      .mockRejectedValueOnce(new Error('invalid_grant'))
      .mockResolvedValueOnce(mockTokenset);

    await refreshController(req, res);

    expect(setOpenIDAuthTokens).toHaveBeenCalledWith(mockTokenset, req, res, {
      userId: 'user-db-id',
      existingRefreshToken: 'stored-refresh',
      tenantId: 'tenant-1',
      openidSubject: baseClaims.sub,
      openidIssuer: baseClaims.iss,
    });
    expect(storeRefreshTokenBridge).toHaveBeenCalledWith({
      oldRefreshToken: 'stored-refresh',
      newRefreshToken: 'new-refresh',
      userId: 'user-db-id',
      tenantId: 'tenant-1',
      openidIssuer: 'https://issuer.example.com',
      ttl: 60000,
    });
    expect(logger.warn).toHaveBeenCalledWith(
      '[refreshController] Bridge grace-period storage failed after successful recovery',
      expect.any(Error),
    );
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('removes a grace bridge published concurrently with logout revocation', async () => {
    setOpenIDReuseCookies();
    req.session = {};
    getUserById.mockResolvedValue({
      _id: 'user-db-id',
      email: baseClaims.email,
      openidId: baseClaims.sub,
      tenantId: 'tenant-1',
      openidIssuer: 'https://issuer.example.com',
    });
    getRefreshTokenBridge.mockResolvedValue('bridged-refresh');
    openIdClient.refreshTokenGrant
      .mockRejectedValueOnce(new Error('invalid_grant'))
      .mockResolvedValueOnce(mockTokenset);
    const assertLeaseOwned = jest
      .fn()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockRejectedValueOnce(ownershipLost('revoked by logout'));
    withOpenIDRefreshFlightLease.mockImplementationOnce(({ operation }) =>
      operation({ assertLeaseOwned, markLeaseSettled: jest.fn() }),
    );

    await refreshController(req, res);

    expect(deleteRefreshTokenBridges).toHaveBeenCalledWith({
      refreshTokens: ['stored-refresh'],
      userId: 'user-db-id',
      tenantId: 'tenant-1',
      version: 'bridge-version-1',
    });
    expect(completeOpenIDRefreshFlight).not.toHaveBeenCalled();
    expect(setOpenIDAuthTokens).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it('keeps the grace bridge when the ownership check fails for an undetermined reason', async () => {
    setOpenIDReuseCookies();
    req.session = {};
    getUserById.mockResolvedValue({
      _id: 'user-db-id',
      email: baseClaims.email,
      openidId: baseClaims.sub,
      tenantId: 'tenant-1',
      openidIssuer: 'https://issuer.example.com',
    });
    getRefreshTokenBridge.mockResolvedValue('bridged-refresh');
    openIdClient.refreshTokenGrant
      .mockRejectedValueOnce(new Error('invalid_grant'))
      .mockResolvedValueOnce(mockTokenset);
    const assertLeaseOwned = jest
      .fn()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockRejectedValueOnce(new Error('connection timed out'));
    withOpenIDRefreshFlightLease.mockImplementationOnce(({ operation }) =>
      operation({ assertLeaseOwned, markLeaseSettled: jest.fn() }),
    );

    await refreshController(req, res);

    expect(deleteRefreshTokenBridges).not.toHaveBeenCalled();
    expect(completeOpenIDRefreshFlight).not.toHaveBeenCalled();
    expect(setOpenIDAuthTokens).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it('removes a prepared durable session when logout wins before publication commits', async () => {
    setOpenIDReuseCookies();
    req.session = {};
    getRefreshTokenBridge.mockResolvedValue('bridged-refresh');
    openIdClient.refreshTokenGrant
      .mockRejectedValueOnce(new Error('invalid_grant'))
      .mockResolvedValueOnce(mockTokenset);
    const assertLeaseOwned = jest
      .fn()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockRejectedValueOnce(ownershipLost('revoked by logout'));
    withOpenIDRefreshFlightLease.mockImplementationOnce(({ operation }) =>
      operation({ assertLeaseOwned, markLeaseSettled: jest.fn() }),
    );

    await refreshController(req, res);

    expect(storeOpenIDSession).toHaveBeenCalledWith(
      'user-db-id',
      'new-refresh',
      'tenant-1',
      'stored-refresh',
    );
    expect(deleteSession).toHaveBeenCalledWith({ refreshToken: 'new-refresh' });
    expect(clearOpenIDAuthTokens).toHaveBeenCalledWith(req, res, 'user-db-id', 'tenant-1');
    expect(completeOpenIDRefreshFlight).not.toHaveBeenCalled();
    expect(setOpenIDAuthTokens).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it('cleans the prepared successor before emission when logout wins the final commit', async () => {
    setOpenIDReuseCookies();
    req.session = {};
    getRefreshTokenBridge.mockResolvedValue('bridged-refresh');
    openIdClient.refreshTokenGrant
      .mockRejectedValueOnce(new Error('invalid_grant'))
      .mockResolvedValueOnce(mockTokenset);
    completeOpenIDRefreshFlight.mockResolvedValueOnce(null);

    await refreshController(req, res);

    expect(setOpenIDAuthTokens).not.toHaveBeenCalled();
    expect(deleteSession).toHaveBeenCalledWith({ refreshToken: 'new-refresh' });
    expect(clearOpenIDAuthTokens).toHaveBeenCalledWith(req, res, 'user-db-id', 'tenant-1');
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it('preserves the successor and bridge when publication completion is indeterminate', async () => {
    setOpenIDReuseCookies();
    req.session = {};
    getRefreshTokenBridge.mockResolvedValue('bridged-refresh');
    openIdClient.refreshTokenGrant
      .mockRejectedValueOnce(new Error('invalid_grant'))
      .mockResolvedValueOnce(mockTokenset);
    completeOpenIDRefreshFlight.mockRejectedValueOnce(new Error('mongo timeout'));
    assertOpenIDRefreshFlightAvailable.mockRejectedValueOnce(new Error('mongo read timeout'));

    await refreshController(req, res);

    expect(storeOpenIDSession).toHaveBeenCalledWith(
      'user-db-id',
      'new-refresh',
      'tenant-1',
      'stored-refresh',
    );
    expect(storeRefreshTokenBridge).toHaveBeenCalledWith(
      expect.objectContaining({
        oldRefreshToken: 'stored-refresh',
        newRefreshToken: 'new-refresh',
        ttl: 60000,
      }),
    );
    expect(deleteSession).not.toHaveBeenCalledWith({ refreshToken: 'new-refresh' });
    expect(clearOpenIDAuthTokens).not.toHaveBeenCalled();
    expect(setOpenIDAuthTokens).not.toHaveBeenCalled();
    expect(failOpenIDRefreshFlight).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it('does not publish a nested bridge refresh after the outer logout fence is revoked', async () => {
    setOpenIDReuseCookies();
    req.session = {};
    getUserById.mockResolvedValue({
      _id: 'user-db-id',
      email: baseClaims.email,
      openidId: baseClaims.sub,
      tenantId: 'tenant-1',
      openidIssuer: 'https://issuer.example.com',
    });
    getRefreshTokenBridge.mockResolvedValue('bridged-refresh');
    openIdClient.refreshTokenGrant
      .mockRejectedValueOnce(new Error('invalid_grant'))
      .mockResolvedValueOnce(mockTokenset);
    const assertLeaseOwned = jest.fn().mockRejectedValueOnce(ownershipLost('revoked by logout'));
    withOpenIDRefreshFlightLease.mockImplementationOnce(({ operation }) =>
      operation({ assertLeaseOwned, markLeaseSettled: jest.fn() }),
    );

    await refreshController(req, res);

    expect(refreshOpenIDSession).toHaveBeenCalledWith(
      expect.anything(),
      res,
      expect.objectContaining({ _id: 'user-db-id' }),
      'id_token',
      expect.anything(),
      expect.objectContaining({
        assertLeaseOwned,
        deferPublication: true,
        forceRefresh: true,
      }),
    );
    expect(storeRefreshTokenBridge).not.toHaveBeenCalled();
    expect(completeOpenIDRefreshFlight).not.toHaveBeenCalled();
    expect(setOpenIDAuthTokens).not.toHaveBeenCalled();
    expect(req.session.openidTokens?.accessToken).toBeUndefined();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it('does not use the bridge for generic HTTP 400 errors without invalid_grant', async () => {
    setOpenIDReuseCookies();
    openIdClient.refreshTokenGrant.mockRejectedValue(
      Object.assign(new Error('bad request'), { status: 400 }),
    );

    await refreshController(req, res);

    expect(getRefreshTokenBridge).not.toHaveBeenCalled();
    expect(storeRefreshTokenBridge).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it('should skip OpenID path when token_provider is not openid', async () => {
    req.headers.cookie = 'token_provider=local; refreshToken=some-token';

    await refreshController(req, res);

    expect(openIdClient.refreshTokenGrant).not.toHaveBeenCalled();
  });

  it('should skip OpenID path when OPENID_REUSE_TOKENS is disabled', async () => {
    isEnabled.mockReturnValue(false);

    await refreshController(req, res);

    expect(openIdClient.refreshTokenGrant).not.toHaveBeenCalled();
  });

  it('should return 200 with token not provided when refresh token is absent', async () => {
    req.headers.cookie = 'token_provider=openid';
    req.session = {};

    await refreshController(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.send).toHaveBeenCalledWith('Refresh token not provided');
  });
});

describe('refreshController – LibreChat path', () => {
  let req, res;
  const refreshSecret = 'test-refresh-secret';

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.JWT_REFRESH_SECRET = refreshSecret;
    process.env.NODE_ENV = 'test';
    setAuthTokens.mockResolvedValue('local-app-token');
    findSession.mockResolvedValue({ expiration: new Date(Date.now() + 60_000) });

    const refreshToken = jwt.sign({ id: 'local-user-id' }, refreshSecret, {
      expiresIn: '1h',
    });
    req = {
      headers: { cookie: `refreshToken=${refreshToken}` },
      query: {},
      session: {},
    };
    res = {
      status: jest.fn().mockReturnThis(),
      send: jest.fn().mockReturnThis(),
      redirect: jest.fn(),
    };
  });

  afterAll(() => {
    if (ORIGINAL_JWT_REFRESH_SECRET === undefined) {
      delete process.env.JWT_REFRESH_SECRET;
    } else {
      process.env.JWT_REFRESH_SECRET = ORIGINAL_JWT_REFRESH_SECRET;
    }

    if (ORIGINAL_NODE_ENV === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = ORIGINAL_NODE_ENV;
    }
  });

  it('sanitizes user documents before returning local refresh responses', async () => {
    getUserById.mockResolvedValue({
      toObject: () => ({
        _id: 'local-user-id',
        email: 'local@example.com',
        password: 'hashed-password',
        __v: 1,
        totpSecret: 'totp-secret',
        backupCodes: ['backup-code'],
        federatedTokens: { access_token: 'do-not-return' },
      }),
    });

    await refreshController(req, res);

    const sentPayload = res.send.mock.calls[0][0];
    expect(setAuthTokens).toHaveBeenCalledWith(
      'local-user-id',
      res,
      { expiration: expect.any(Date) },
      req,
    );
    expect(sentPayload).toEqual({
      token: 'local-app-token',
      user: {
        _id: 'local-user-id',
        email: 'local@example.com',
      },
    });
  });

  it('sanitizes user documents before returning CI refresh responses', async () => {
    process.env.NODE_ENV = 'CI';
    getUserById.mockResolvedValue({
      toObject: () => ({
        _id: 'local-user-id',
        email: 'local@example.com',
        password: 'hashed-password',
        __v: 1,
        totpSecret: 'totp-secret',
        backupCodes: ['backup-code'],
        federatedTokens: { access_token: 'do-not-return' },
      }),
    });

    await refreshController(req, res);

    const sentPayload = res.send.mock.calls[0][0];
    expect(findSession).not.toHaveBeenCalled();
    expect(setAuthTokens).toHaveBeenCalledWith('local-user-id', res, null, req);
    expect(sentPayload).toEqual({
      token: 'local-app-token',
      user: {
        _id: 'local-user-id',
        email: 'local@example.com',
      },
    });
  });
});

describe('registrationController - invite consumption', () => {
  const invite = { token: 'hashed-invite', email: 'invitee@example.com' };

  const buildRes = () => {
    const res = {};
    res.status = jest.fn(() => res);
    res.send = jest.fn(() => res);
    res.json = jest.fn(() => res);
    return res;
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('consumes the invite once the account exists', async () => {
    registerUser.mockResolvedValue({ status: 200, message: 'ok', userCreated: true });

    await registrationController({ body: {}, invite }, buildRes());

    expect(deleteTokens).toHaveBeenCalledWith({ token: 'hashed-invite' });
  });

  it('leaves the invite when registration is rejected', () => {
    /** A mistyped password confirmation is the common case; it has to stay retryable. */
    registerUser.mockResolvedValue({ status: 404, message: 'The passwords did not match' });

    return registrationController({ body: {}, invite }, buildRes()).then(() => {
      expect(deleteTokens).not.toHaveBeenCalled();
    });
  });

  it('leaves the invite when the email is already in use, despite the 200', async () => {
    /** `registerUser` returns the same status and message whether it created an account
     *  or found the email taken, so the status alone cannot drive this decision. */
    registerUser.mockResolvedValue({ status: 200, message: 'ok' });

    await registrationController({ body: {}, invite }, buildRes());

    expect(deleteTokens).not.toHaveBeenCalled();
  });

  it('does not attempt a deletion for an uninvited registration', async () => {
    registerUser.mockResolvedValue({ status: 200, message: 'ok', userCreated: true });

    await registrationController({ body: {} }, buildRes());

    expect(deleteTokens).not.toHaveBeenCalled();
  });

  it('still reports success when consuming the invite fails', async () => {
    /** The account exists by this point; reporting failure would be worse than
     *  leaving a usable invite behind. */
    registerUser.mockResolvedValue({ status: 200, message: 'ok', userCreated: true });
    deleteTokens.mockRejectedValue(new Error('mongo unavailable'));
    const res = buildRes();

    await registrationController({ body: {}, invite }, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.send).toHaveBeenCalledWith({ message: 'ok' });
    expect(logger.error).toHaveBeenCalled();
  });

  it('never forwards the creation signal to the client', async () => {
    registerUser.mockResolvedValue({ status: 200, message: 'ok', userCreated: true });
    const res = buildRes();

    await registrationController({ body: {}, invite }, res);

    expect(res.send).toHaveBeenCalledWith({ message: 'ok' });
  });
});
