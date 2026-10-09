jest.mock('openid-client', () => ({
  refreshTokenGrant: jest.fn(),
}));
jest.mock('~/strategies/openidStrategy', () => ({
  getOpenIdConfig: jest.fn(),
}));
jest.mock('@librechat/data-schemas', () => ({
  logger: {
    error: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    info: jest.fn(),
  },
  DEFAULT_REFRESH_TOKEN_EXPIRY: 1000 * 60 * 60 * 24 * 7,
}));
jest.mock('@librechat/api', () => ({
  ...jest.requireActual('@librechat/api'),
  isEnabled: jest.fn(),
  math: jest.fn((_value, fallback) => fallback),
  createAuthIdentityContext: jest.fn(({ user, requestUser }) => ({
    appUserId:
      user?._id?.toString?.() ?? user?.id ?? requestUser?._id?.toString?.() ?? requestUser?.id,
    openidSubject: user?.openidId ?? requestUser?.openidId,
    tenantId: user?.tenantId ?? requestUser?.tenantId,
    openidIssuer: user?.openidIssuer ?? requestUser?.openidIssuer,
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
    const session = {
      appUserId: normalize(sessionIdentity?.appUserId),
      openidSubject: normalize(sessionIdentity?.openidSubject),
      tenantId: normalize(sessionIdentity?.tenantId),
      openidIssuer: normalizeIssuer(sessionIdentity?.openidIssuer),
    };
    const expected = {
      appUserId: normalize(expectedIdentity?.appUserId),
      openidSubject: normalize(expectedIdentity?.openidSubject),
      tenantId: normalize(expectedIdentity?.tenantId),
      openidIssuer: normalizeIssuer(expectedIdentity?.openidIssuer),
    };
    return (
      Boolean(session.appUserId) &&
      Boolean(session.openidSubject) &&
      session.appUserId === expected.appUserId &&
      session.openidSubject === expected.openidSubject &&
      session.tenantId === expected.tenantId &&
      session.openidIssuer === expected.openidIssuer
    );
  }),
  createOpenIDRefreshIdentityTuple: jest.fn(({ user, requestUser }) => {
    const subject =
      user?.openidId ??
      user?.id ??
      user?._id?.toString?.() ??
      requestUser?.openidId ??
      requestUser?.id ??
      requestUser?._id?.toString?.();
    if (!subject) {
      return null;
    }
    return {
      subject,
      tenantId: user?.tenantId ?? requestUser?.tenantId ?? 'no-tenant',
      openidIssuer: user?.openidIssuer ?? requestUser?.openidIssuer ?? 'no-issuer',
    };
  }),
  serializeAuthIdentityTuple: jest.fn(
    (tuple) => `${tuple.tenantId}\x1f${tuple.openidIssuer}\x1f${tuple.subject}`,
  ),
  createRefreshTokenBridgeIdentity: jest.fn(
    ({ user, requestUser, userId, tenantId, openidIssuer }) => {
      const normalize = (value) => {
        if (value == null) {
          return undefined;
        }
        const normalized = typeof value === 'string' ? value.trim() : value.toString().trim();
        return normalized || undefined;
      };
      const resolvedUserId =
        normalize(userId) ??
        normalize(user?._id) ??
        normalize(user?.id) ??
        normalize(requestUser?._id) ??
        normalize(requestUser?.id);
      if (!resolvedUserId) {
        return null;
      }
      return {
        userId: resolvedUserId,
        tenantId: tenantId ?? user?.tenantId ?? requestUser?.tenantId,
        openidIssuer: openidIssuer ?? user?.openidIssuer ?? requestUser?.openidIssuer,
      };
    },
  ),
  buildOpenIDRefreshParams: jest.fn(() => ({ scope: 'openid profile' })),
  setRefreshTokenCookie: jest.fn((res, refreshToken, expires) => {
    res.cookie('refreshToken', refreshToken, { expires });
  }),
  setOpenIDMarkerCookies: jest.fn((res, { userId, expires }) => {
    res.cookie('token_provider', 'openid', { expires });
    if (userId) {
      res.cookie('openid_user_id', `signed:${userId}`, { expires });
    }
  }),
  normalizeExpiresIn: (value) => {
    const normalized = typeof value === 'string' && value.trim() ? Number(value) : value;
    return typeof normalized === 'number' && Number.isFinite(normalized) ? normalized : undefined;
  },
  storeOpenIdSession: jest.fn(),
}));
jest.mock('~/models', () => ({
  upsertSession: jest.fn(),
  deleteSession: jest.fn(),
}));
jest.mock('./RefreshTokenBridge', () => ({
  OPENID_REFRESH_BRIDGE_GRACE_MS: 60 * 1000,
  storeRefreshTokenBridge: jest.fn(),
  deleteRefreshTokenBridges: jest.fn(),
  createRefreshTokenBridgeFlightKey: jest.fn(
    ({ userId, oldRefreshToken }) => `publication:${userId}:${oldRefreshToken}`,
  ),
}));
jest.mock('./OpenIDRefreshFlight', () => ({
  acquireOpenIDRefreshFlight: jest.fn(),
  assertOpenIDRefreshFlightAvailable: jest.fn(),
  assertOpenIDRefreshSessionGenerationAvailable: jest.fn(),
  completeOpenIDRefreshFlight: jest.fn(),
  createOpenIDRefreshFlightKey: jest.fn(),
  failOpenIDRefreshFlight: jest.fn(),
  waitForOpenIDRefreshFlight: jest.fn(),
  withOpenIDRefreshFlightLease: jest.fn(({ operation }) =>
    operation({
      assertLeaseOwned: jest.fn().mockResolvedValue(true),
      markLeaseSettled: jest.fn(),
    }),
  ),
}));

const jwt = require('jsonwebtoken');
const crypto = require('node:crypto');
const openIdClient = require('openid-client');
const {
  isEnabled,
  buildOpenIDRefreshParams,
  setRefreshTokenCookie,
  setOpenIDMarkerCookies,
  storeOpenIdSession,
} = require('@librechat/api');
const { upsertSession, deleteSession } = require('~/models');
const { getOpenIdConfig } = require('~/strategies/openidStrategy');
const { deleteRefreshTokenBridges, storeRefreshTokenBridge } = require('./RefreshTokenBridge');
const {
  acquireOpenIDRefreshFlight,
  assertOpenIDRefreshFlightAvailable,
  assertOpenIDRefreshSessionGenerationAvailable,
  completeOpenIDRefreshFlight,
  createOpenIDRefreshFlightKey,
  failOpenIDRefreshFlight,
  waitForOpenIDRefreshFlight,
  withOpenIDRefreshFlightLease,
} = require('./OpenIDRefreshFlight');
const {
  createOpenIDSessionTokenProvider,
  refreshOpenIDSession,
  __internals,
} = require('./OpenIDSessionRefresh');

const SECRET = 'test-secret';

const makeJwt = (exp) => jwt.sign({ sub: 'user-123', exp }, SECRET);

const DEFAULT_SESSION_IDENTITY = {
  appUserId: 'local-id-1',
  openidSubject: 'oidc-sub-123',
  tenantId: 'tenant-1',
  openidIssuer: 'https://issuer.example.com',
};

const withSessionIdentity = (sessionTokens) =>
  sessionTokens == null ? sessionTokens : { ...DEFAULT_SESSION_IDENTITY, ...sessionTokens };

const buildReq = (sessionTokens, sessionId = 'session-A', { bindIdentity = true } = {}) => ({
  sessionID: sessionId,
  session: Object.assign(
    {
      save: jest.fn((cb) => cb(null)),
    },
    sessionTokens === undefined
      ? {}
      : { openidTokens: bindIdentity ? withSessionIdentity(sessionTokens) : sessionTokens },
  ),
});

/** Minimal writable Express response stub for cookie-sync assertions. */
const buildRes = ({ headersSent = false } = {}) => ({
  headersSent,
  cookie: jest.fn(),
  clearCookie: jest.fn(),
});

const makeOpenIdUser = (overrides = {}) => ({
  id: 'local-id-1',
  openidId: 'oidc-sub-123',
  tenantId: 'tenant-1',
  openidIssuer: 'https://issuer.example.com',
  provider: 'openid',
  ...overrides,
});

const { createOpenIDRefreshOwnershipError } = jest.requireActual('@librechat/api');
const ownershipLost = (message) => createOpenIDRefreshOwnershipError(message);

describe('OpenIDSessionRefresh', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    __internals.inFlightRefreshes.clear();
    isEnabled.mockReturnValue(true);
    getOpenIdConfig.mockReturnValue({ issuer: 'https://issuer.example.com' });
    openIdClient.refreshTokenGrant.mockReset();
    createOpenIDRefreshFlightKey.mockImplementation(
      ({ req, refreshToken }) => refreshToken && `flight:${req?.sessionID}:${refreshToken}`,
    );
    acquireOpenIDRefreshFlight.mockResolvedValue({ acquired: true, ownerId: 'owner-1' });
    assertOpenIDRefreshFlightAvailable.mockResolvedValue({ status: 'completed' });
    assertOpenIDRefreshSessionGenerationAvailable.mockResolvedValue(true);
    completeOpenIDRefreshFlight.mockResolvedValue({});
    failOpenIDRefreshFlight.mockResolvedValue({});
    waitForOpenIDRefreshFlight.mockResolvedValue(null);
    storeRefreshTokenBridge.mockResolvedValue('bridge-version-1');
    withOpenIDRefreshFlightLease.mockImplementation(({ operation }) =>
      operation({
        assertLeaseOwned: jest.fn().mockResolvedValue(true),
        markLeaseSettled: jest.fn(),
      }),
    );
  });

  describe('createOpenIDSessionTokenProvider closure no-op cases', () => {
    it('throws when tokenPreference is missing', () => {
      expect(() =>
        createOpenIDSessionTokenProvider({
          req: buildReq({ accessToken: makeJwt(Date.now() / 1000 + 600) }),
          user: makeOpenIdUser(),
        }),
      ).toThrow(/tokenPreference/);
    });

    it('throws when tokenPreference is invalid', () => {
      expect(() =>
        createOpenIDSessionTokenProvider({
          req: buildReq({ accessToken: makeJwt(Date.now() / 1000 + 600) }),
          user: makeOpenIdUser(),
          tokenPreference: 'bogus',
        }),
      ).toThrow(/tokenPreference/);
    });

    it('returns null when OPENID_REUSE_TOKENS is disabled', async () => {
      isEnabled.mockReturnValue(false);
      const provider = createOpenIDSessionTokenProvider({
        req: buildReq({ accessToken: makeJwt(Date.now() / 1000 + 600) }),
        user: makeOpenIdUser(),
        tokenPreference: 'access_token',
      });
      await expect(provider()).resolves.toBeNull();
      expect(openIdClient.refreshTokenGrant).not.toHaveBeenCalled();
    });

    it('returns null when user is non-OpenID', async () => {
      const provider = createOpenIDSessionTokenProvider({
        req: buildReq({ accessToken: makeJwt(Date.now() / 1000 + 600) }),
        user: { id: 'local-1', provider: 'local' },
        tokenPreference: 'access_token',
      });
      await expect(provider()).resolves.toBeNull();
      expect(openIdClient.refreshTokenGrant).not.toHaveBeenCalled();
    });

    it('returns null when user is missing entirely', async () => {
      const provider = createOpenIDSessionTokenProvider({
        req: buildReq({ accessToken: makeJwt(Date.now() / 1000 + 600) }),
        user: undefined,
        tokenPreference: 'access_token',
      });
      await expect(provider()).resolves.toBeNull();
    });

    it('rejects a stale user token snapshot when an Express session lost its OpenID tokens', async () => {
      const provider = createOpenIDSessionTokenProvider({
        req: buildReq(undefined),
        user: makeOpenIdUser(),
        tokenPreference: 'access_token',
      });
      await expect(provider()).rejects.toMatchObject({
        code: 'OPENID_REFRESH_OWNERSHIP_LOST',
      });
      expect(openIdClient.refreshTokenGrant).not.toHaveBeenCalled();
    });

    it('allows remote OIDC bearer fallback when the request itself carries the upstream token', async () => {
      const req = buildReq(undefined);
      req.headers = { authorization: 'Bearer remote-access-token' };
      const provider = createOpenIDSessionTokenProvider({
        req,
        user: makeOpenIdUser({
          federatedTokens: { access_token: 'remote-access-token' },
        }),
        tokenPreference: 'access_token',
      });

      await expect(provider()).resolves.toBeNull();
      expect(openIdClient.refreshTokenGrant).not.toHaveBeenCalled();
    });

    it('returns null when req is missing entirely', async () => {
      const provider = createOpenIDSessionTokenProvider({
        req: undefined,
        user: makeOpenIdUser(),
        tokenPreference: 'access_token',
      });
      await expect(provider()).resolves.toBeNull();
    });
  });

  describe('refreshOpenIDSession live-token reuse', () => {
    it('returns live tokens without calling IdP when access_token still valid past skew', async () => {
      const farFutureExp = Math.floor(Date.now() / 1000) + 600;
      const sessionTokens = {
        accessToken: makeJwt(farFutureExp),
        idToken: makeJwt(farFutureExp),
        refreshToken: 'rt-1',
      };
      const req = buildReq(sessionTokens);

      const result = await refreshOpenIDSession(req, undefined, makeOpenIdUser(), 'access_token');

      expect(openIdClient.refreshTokenGrant).not.toHaveBeenCalled();
      expect(result).toEqual({
        access_token: sessionTokens.accessToken,
        id_token: sessionTokens.idToken,
        refresh_token: 'rt-1',
        expires_at: farFutureExp,
      });
    });

    it('rejects a live OBO token whose recorded publication generation was revoked', async () => {
      const farFutureExp = Math.floor(Date.now() / 1000) + 600;
      const sessionTokens = {
        accessToken: makeJwt(farFutureExp),
        idToken: makeJwt(farFutureExp),
        refreshToken: 'rt-revoked',
        publicationFlightKey: 'publication-key',
        publicationFlightOwnerId: 'publication-owner',
      };
      const req = buildReq(sessionTokens);
      assertOpenIDRefreshSessionGenerationAvailable.mockRejectedValueOnce(
        ownershipLost('revoked by logout'),
      );

      await expect(
        refreshOpenIDSession(req, undefined, makeOpenIdUser(), 'access_token'),
      ).rejects.toThrow('revoked by logout');

      expect(assertOpenIDRefreshSessionGenerationAvailable).toHaveBeenCalledWith({
        key: 'publication-key',
        ownerId: 'publication-owner',
      });
      expect(openIdClient.refreshTokenGrant).not.toHaveBeenCalled();
    });

    it('rejects legacy session tokens without a verifiable signed marker', async () => {
      const farFutureExp = Math.floor(Date.now() / 1000) + 600;
      const sessionTokens = {
        accessToken: makeJwt(farFutureExp),
        idToken: makeJwt(farFutureExp),
        refreshToken: 'rt-unbound',
      };
      const req = buildReq(sessionTokens, 'session-unbound', { bindIdentity: false });

      await expect(
        refreshOpenIDSession(req, undefined, makeOpenIdUser(), 'access_token'),
      ).rejects.toThrow('OpenID session token identity mismatch');
      expect(openIdClient.refreshTokenGrant).not.toHaveBeenCalled();
    });

    it('binds a verified legacy session during rolling upgrades before token reuse', async () => {
      const farFutureExp = Math.floor(Date.now() / 1000) + 600;
      const refreshToken = 'rt-legacy';
      const sessionTokens = {
        accessToken: makeJwt(farFutureExp),
        idToken: makeJwt(farFutureExp),
        refreshToken,
      };
      const req = buildReq(sessionTokens, 'session-legacy', { bindIdentity: false });
      const previousSecret = process.env.JWT_REFRESH_SECRET;
      process.env.JWT_REFRESH_SECRET = SECRET;
      const refreshTokenHash = crypto.createHash('sha256').update(refreshToken).digest('base64url');
      const marker = jwt.sign({ id: 'local-id-1', refreshTokenHash }, SECRET);
      req.headers = {
        cookie: `refreshToken=${refreshToken}; openid_user_id=${marker}`,
      };

      try {
        await expect(
          refreshOpenIDSession(req, undefined, makeOpenIdUser(), 'access_token'),
        ).resolves.toEqual(
          expect.objectContaining({
            access_token: sessionTokens.accessToken,
            refresh_token: refreshToken,
          }),
        );
      } finally {
        if (previousSecret == null) {
          delete process.env.JWT_REFRESH_SECRET;
        } else {
          process.env.JWT_REFRESH_SECRET = previousSecret;
        }
      }

      expect(req.session.openidTokens).toEqual(expect.objectContaining(DEFAULT_SESSION_IDENTITY));
      expect(req.session.save).toHaveBeenCalledTimes(1);
      expect(openIdClient.refreshTokenGrant).not.toHaveBeenCalled();
    });

    it('rejects session tokens bound to a different OpenID identity', async () => {
      const farFutureExp = Math.floor(Date.now() / 1000) + 600;
      const sessionTokens = {
        accessToken: makeJwt(farFutureExp),
        idToken: makeJwt(farFutureExp),
        refreshToken: 'rt-other-user',
        appUserId: 'other-user',
      };
      const req = buildReq(sessionTokens);

      await expect(
        refreshOpenIDSession(req, undefined, makeOpenIdUser(), 'access_token'),
      ).rejects.toThrow('OpenID session token identity mismatch');
      expect(openIdClient.refreshTokenGrant).not.toHaveBeenCalled();
    });

    /**
     * The bug fixed by Codex Finding 1a: id_token can outlive access_token.
     * Old behavior would declare "live" because id_token is fresh, sending an
     * expired access_token to the OBO IdP. New behavior must trigger a refresh.
     */
    it('refreshes when access_token is expired even if id_token is still fresh', async () => {
      const accessExp = Math.floor(Date.now() / 1000) - 30;
      const idExp = Math.floor(Date.now() / 1000) + 3600;
      const sessionTokens = {
        accessToken: makeJwt(accessExp),
        idToken: makeJwt(idExp),
        refreshToken: 'rt-asym',
      };
      const refreshedExp = Math.floor(Date.now() / 1000) + 3600;
      openIdClient.refreshTokenGrant.mockResolvedValueOnce({
        access_token: makeJwt(refreshedExp),
        id_token: makeJwt(refreshedExp),
        refresh_token: 'rt-asym-2',
        expires_in: 3600,
      });
      const req = buildReq(sessionTokens);

      const result = await refreshOpenIDSession(req, undefined, makeOpenIdUser(), 'access_token');

      expect(openIdClient.refreshTokenGrant).toHaveBeenCalledTimes(1);
      expect(result.access_token).not.toBe(sessionTokens.accessToken);
    });

    it('falls through to refresh when access_token expires within the skew buffer', async () => {
      const veryNearExp = Math.floor(Date.now() / 1000) + 10; // < 30s buffer
      const sessionTokens = {
        accessToken: makeJwt(veryNearExp),
        idToken: makeJwt(veryNearExp),
        refreshToken: 'rt-2',
      };
      const refreshedExp = Math.floor(Date.now() / 1000) + 3600;
      openIdClient.refreshTokenGrant.mockResolvedValueOnce({
        access_token: makeJwt(refreshedExp),
        id_token: makeJwt(refreshedExp),
        refresh_token: 'rt-3',
        expires_in: 3600,
      });
      const req = buildReq(sessionTokens);

      const result = await refreshOpenIDSession(req, undefined, makeOpenIdUser(), 'access_token');

      expect(openIdClient.refreshTokenGrant).toHaveBeenCalledTimes(1);
      expect(buildOpenIDRefreshParams).toHaveBeenCalled();
      expect(result.refresh_token).toBe('rt-3');
      expect(req.session.openidTokens.refreshToken).toBe('rt-3');
      expect(req.session.save).toHaveBeenCalled();
    });
  });

  describe('refreshOpenIDSession refresh path', () => {
    it('refreshes when access_token is expired and persists session', async () => {
      const expiredExp = Math.floor(Date.now() / 1000) - 60;
      const sessionTokens = {
        accessToken: makeJwt(expiredExp),
        idToken: makeJwt(expiredExp),
        refreshToken: 'rt-old',
      };
      const refreshedExp = Math.floor(Date.now() / 1000) + 3600;
      openIdClient.refreshTokenGrant.mockResolvedValueOnce({
        access_token: makeJwt(refreshedExp),
        id_token: makeJwt(refreshedExp),
        refresh_token: 'rt-new',
        expires_in: 3600,
      });
      const req = buildReq(sessionTokens);

      const result = await refreshOpenIDSession(req, undefined, makeOpenIdUser(), 'access_token');

      expect(openIdClient.refreshTokenGrant).toHaveBeenCalledTimes(1);
      expect(req.session.save).toHaveBeenCalledTimes(1);
      expect(typeof result.access_token).toBe('string');
      expect(req.session.openidTokens).toEqual(
        expect.objectContaining({
          refreshToken: 'rt-new',
          lastRefreshedAt: expect.any(Number),
        }),
      );
    });

    it('preserves an expired prior id_token only as session metadata when rotation omits it', async () => {
      const expiredExp = Math.floor(Date.now() / 1000) - 60;
      const priorIdToken = makeJwt(expiredExp);
      const sessionTokens = {
        accessToken: makeJwt(expiredExp),
        idToken: priorIdToken,
        refreshToken: 'rt-keep',
      };
      const refreshedExp = Math.floor(Date.now() / 1000) + 3600;
      openIdClient.refreshTokenGrant.mockResolvedValueOnce({
        access_token: makeJwt(refreshedExp),
        // id_token and refresh_token both omitted
        expires_in: 3600,
      });
      const req = buildReq(sessionTokens);

      const result = await refreshOpenIDSession(req, undefined, makeOpenIdUser(), 'access_token');

      expect(result.id_token).toBeUndefined();
      expect(result.__identityClaims).toEqual(expect.objectContaining({ sub: 'user-123' }));
      expect(result.refresh_token).toBe('rt-keep');
      expect(req.session.openidTokens.idToken).toBe(priorIdToken);
      expect(req.session.openidTokens.refreshToken).toBe('rt-keep');
    });

    it.each([0, -30])('rejects an elapsed IdP access-token lifetime (%s)', async (expiresIn) => {
      const expiredExp = Math.floor(Date.now() / 1000) - 60;
      const req = buildReq({
        accessToken: makeJwt(expiredExp),
        idToken: makeJwt(expiredExp),
        refreshToken: 'rt-elapsed',
      });
      const res = buildRes({ headersSent: false });
      openIdClient.refreshTokenGrant.mockResolvedValueOnce({
        access_token: 'elapsed-access-token',
        refresh_token: 'rt-rotated',
        expires_in: expiresIn,
      });

      await expect(
        refreshOpenIDSession(req, res, makeOpenIdUser(), 'access_token'),
      ).rejects.toThrow('expired access_token');

      expect(req.session.openidTokens.refreshToken).toBe('rt-elapsed');
      expect(req.session.save).not.toHaveBeenCalled();
      expect(setRefreshTokenCookie).not.toHaveBeenCalled();
      expect(storeRefreshTokenBridge).not.toHaveBeenCalled();
    });

    /**
     * The bug fixed by Codex Finding 1b: when IdP rotates only access_token,
     * derive expires_at from the IdP's tokenset.expires_in (authoritative for
     * the new access_token) rather than the prior id_token's exp claim. The
     * latter would cause `isOpenIDTokenValid` to reject a fresh credential.
     */
    it('uses tokenset.expires_in (not prior id_token exp) for expires_at after rotation-omits-id-token refresh', async () => {
      const expiredExp = Math.floor(Date.now() / 1000) - 60;
      const sessionTokens = {
        accessToken: makeJwt(expiredExp),
        idToken: makeJwt(expiredExp),
        refreshToken: 'rt-rot',
      };
      // IdP omits id_token; expires_in is the only authoritative expiry source
      openIdClient.refreshTokenGrant.mockResolvedValueOnce({
        access_token: makeJwt(Math.floor(Date.now() / 1000) + 3600),
        // id_token omitted
        expires_in: 3600,
      });
      const req = buildReq(sessionTokens);
      const beforeSec = Math.floor(Date.now() / 1000);

      const result = await refreshOpenIDSession(req, undefined, makeOpenIdUser(), 'access_token');

      // expires_at should be ~now + 3600, NOT the stale prior id_token exp
      expect(result.expires_at).toBeGreaterThanOrEqual(beforeSec + 3590);
      expect(result.expires_at).toBeLessThanOrEqual(beforeSec + 3610);
    });

    it('returns null when session lacks a refresh_token (cannot refresh)', async () => {
      const expiredExp = Math.floor(Date.now() / 1000) - 60;
      const sessionTokens = {
        accessToken: makeJwt(expiredExp),
        idToken: makeJwt(expiredExp),
        // no refreshToken
      };
      const req = buildReq(sessionTokens);

      const result = await refreshOpenIDSession(req, undefined, makeOpenIdUser(), 'access_token');

      expect(openIdClient.refreshTokenGrant).not.toHaveBeenCalled();
      expect(result).toBeNull();
    });

    it('rethrows when refreshTokenGrant rejects', async () => {
      const expiredExp = Math.floor(Date.now() / 1000) - 60;
      const sessionTokens = {
        accessToken: makeJwt(expiredExp),
        idToken: makeJwt(expiredExp),
        refreshToken: 'rt-bad',
      };
      openIdClient.refreshTokenGrant.mockRejectedValueOnce(new Error('invalid_grant'));
      const req = buildReq(sessionTokens);

      await expect(
        refreshOpenIDSession(req, undefined, makeOpenIdUser(), 'access_token'),
      ).rejects.toThrow('invalid_grant');
      expect(req.session.save).not.toHaveBeenCalled();
    });

    it('rethrows when refreshTokenGrant returns no access_token', async () => {
      const expiredExp = Math.floor(Date.now() / 1000) - 60;
      const sessionTokens = {
        accessToken: makeJwt(expiredExp),
        idToken: makeJwt(expiredExp),
        refreshToken: 'rt-incomplete',
      };
      openIdClient.refreshTokenGrant.mockResolvedValueOnce({
        // access_token absent
        expires_in: 3600,
      });
      const req = buildReq(sessionTokens);

      await expect(
        refreshOpenIDSession(req, undefined, makeOpenIdUser(), 'access_token'),
      ).rejects.toThrow(/no access_token/i);
    });
  });

  describe('rotated refresh-token cookie sync', () => {
    const buildExpiredSession = (refreshToken, browserRefreshToken) => {
      const expiredExp = Math.floor(Date.now() / 1000) - 60;
      const sessionTokens = {
        accessToken: makeJwt(expiredExp),
        idToken: makeJwt(expiredExp),
        refreshToken,
      };
      if (browserRefreshToken) {
        sessionTokens.browserRefreshToken = browserRefreshToken;
      }
      return sessionTokens;
    };

    it('writes the rotated refresh token to the cookie when res is writable', async () => {
      const refreshedExp = Math.floor(Date.now() / 1000) + 3600;
      openIdClient.refreshTokenGrant.mockResolvedValueOnce({
        access_token: makeJwt(refreshedExp),
        id_token: makeJwt(refreshedExp),
        refresh_token: 'rt-rotated',
        expires_in: 3600,
      });
      const req = buildReq(buildExpiredSession('rt-old'));
      const res = buildRes({ headersSent: false });

      await refreshOpenIDSession(req, res, makeOpenIdUser(), 'access_token');

      expect(setRefreshTokenCookie).toHaveBeenCalledTimes(1);
      expect(setRefreshTokenCookie).toHaveBeenCalledWith(res, 'rt-rotated', expect.any(Date));
      expect(setOpenIDMarkerCookies).toHaveBeenCalledTimes(1);
      expect(setOpenIDMarkerCookies).toHaveBeenCalledWith(res, {
        userId: 'local-id-1',
        expires: expect.any(Date),
        refreshExpiryMs: 1000 * 60 * 60 * 24 * 7,
        refreshToken: 'rt-rotated',
      });
      expect(storeRefreshTokenBridge).toHaveBeenCalledWith(
        expect.objectContaining({
          oldRefreshToken: 'rt-old',
          newRefreshToken: 'rt-rotated',
          ttl: 60 * 1000,
        }),
      );
      expect(req.session.openidTokens.browserRefreshToken).toBe('rt-rotated');
    });

    /** The durable Session record is what authorizes local image access for OpenID users, and it is
     *  looked up by the refresh token in the browser's cookie — so it has to move with the cookie. */
    it('moves the durable session record onto the rotated token alongside the cookie', async () => {
      const refreshedExp = Math.floor(Date.now() / 1000) + 3600;
      openIdClient.refreshTokenGrant.mockResolvedValueOnce({
        access_token: makeJwt(refreshedExp),
        id_token: makeJwt(refreshedExp),
        refresh_token: 'rt-rotated',
        expires_in: 3600,
      });
      const req = buildReq(buildExpiredSession('rt-old'));
      const res = buildRes({ headersSent: false });

      await refreshOpenIDSession(req, res, makeOpenIdUser(), 'access_token');

      expect(storeOpenIdSession).toHaveBeenCalledWith(
        {
          userId: 'local-id-1',
          refreshToken: 'rt-rotated',
          tenantId: 'tenant-1',
          previousRefreshToken: 'rt-old',
        },
        { upsertSession, deleteSession },
      );
      expect(storeOpenIdSession.mock.invocationCallOrder[0]).toBeLessThan(
        setRefreshTokenCookie.mock.invocationCallOrder[0],
      );
    });

    /** Headers are already sent, so the browser keeps the old cookie: revoking the record it still
     *  presents would lock the user out of images until the next `/refresh` recovers the bridge. */
    it('leaves the durable session alone when the rotation can only be bridged', async () => {
      const refreshedExp = Math.floor(Date.now() / 1000) + 3600;
      openIdClient.refreshTokenGrant.mockResolvedValueOnce({
        access_token: makeJwt(refreshedExp),
        id_token: makeJwt(refreshedExp),
        refresh_token: 'rt-rotated',
        expires_in: 3600,
      });
      const req = buildReq(buildExpiredSession('rt-old'));
      const res = buildRes({ headersSent: true });

      await refreshOpenIDSession(req, res, makeOpenIdUser(), 'access_token');

      expect(storeRefreshTokenBridge).toHaveBeenCalled();
      expect(storeOpenIdSession).not.toHaveBeenCalled();
    });

    it('removes a bridge published concurrently with logout revocation', async () => {
      const refreshedExp = Math.floor(Date.now() / 1000) + 3600;
      openIdClient.refreshTokenGrant.mockResolvedValueOnce({
        access_token: makeJwt(refreshedExp),
        id_token: makeJwt(refreshedExp),
        refresh_token: 'rt-rotated',
        expires_in: 3600,
      });
      const assertLeaseOwned = jest
        .fn()
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(true)
        .mockRejectedValueOnce(ownershipLost('revoked by logout'));
      withOpenIDRefreshFlightLease.mockImplementationOnce(({ operation }) =>
        operation({ assertLeaseOwned, markLeaseSettled: jest.fn() }),
      );
      const req = buildReq(buildExpiredSession('rt-old'));
      const res = buildRes({ headersSent: true });

      await expect(
        refreshOpenIDSession(req, res, makeOpenIdUser(), 'access_token'),
      ).rejects.toThrow('revoked by logout');

      expect(storeRefreshTokenBridge).toHaveBeenCalledWith({
        oldRefreshToken: 'rt-old',
        newRefreshToken: 'rt-rotated',
        userId: 'local-id-1',
        tenantId: 'tenant-1',
        openidIssuer: 'https://issuer.example.com',
        ttl: 60 * 1000,
      });
      expect(deleteRefreshTokenBridges).toHaveBeenCalledWith({
        refreshTokens: ['rt-old'],
        userId: 'local-id-1',
        tenantId: 'tenant-1',
        version: 'bridge-version-1',
      });
      expect(deleteSession).not.toHaveBeenCalled();
      expect(res.clearCookie).not.toHaveBeenCalled();
      expect(req.session.openidTokens.refreshToken).toBe('rt-old');
      expect(req.session.save).not.toHaveBeenCalled();
    });

    it('keeps the bridge when the ownership check fails for an undetermined reason', async () => {
      const refreshedExp = Math.floor(Date.now() / 1000) + 3600;
      openIdClient.refreshTokenGrant.mockResolvedValueOnce({
        access_token: makeJwt(refreshedExp),
        id_token: makeJwt(refreshedExp),
        refresh_token: 'rt-rotated',
        expires_in: 3600,
      });
      const assertLeaseOwned = jest
        .fn()
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(true)
        .mockRejectedValueOnce(new Error('connection timed out'));
      withOpenIDRefreshFlightLease.mockImplementationOnce(({ operation }) =>
        operation({ assertLeaseOwned, markLeaseSettled: jest.fn() }),
      );
      const req = buildReq(buildExpiredSession('rt-old'));
      const res = buildRes({ headersSent: true });

      await expect(
        refreshOpenIDSession(req, res, makeOpenIdUser(), 'access_token'),
      ).rejects.toThrow('connection timed out');

      expect(storeRefreshTokenBridge).toHaveBeenCalled();
      expect(deleteRefreshTokenBridges).not.toHaveBeenCalled();
    });

    it('surfaces the lease error when removing the orphaned bridge also fails', async () => {
      const refreshedExp = Math.floor(Date.now() / 1000) + 3600;
      openIdClient.refreshTokenGrant.mockResolvedValueOnce({
        access_token: makeJwt(refreshedExp),
        id_token: makeJwt(refreshedExp),
        refresh_token: 'rt-rotated',
        expires_in: 3600,
      });
      deleteRefreshTokenBridges.mockRejectedValueOnce(new Error('mongo unavailable'));
      const assertLeaseOwned = jest
        .fn()
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(true)
        .mockRejectedValueOnce(ownershipLost('revoked by logout'));
      withOpenIDRefreshFlightLease.mockImplementationOnce(({ operation }) =>
        operation({ assertLeaseOwned, markLeaseSettled: jest.fn() }),
      );
      const req = buildReq(buildExpiredSession('rt-old'));
      const res = buildRes({ headersSent: true });

      await expect(
        refreshOpenIDSession(req, res, makeOpenIdUser(), 'access_token'),
      ).rejects.toThrow('revoked by logout');

      expect(deleteRefreshTokenBridges).toHaveBeenCalled();
    });

    it('fails closed before publishing cookies when the durable session transition fails', async () => {
      const refreshedExp = Math.floor(Date.now() / 1000) + 3600;
      openIdClient.refreshTokenGrant.mockResolvedValueOnce({
        access_token: makeJwt(refreshedExp),
        id_token: makeJwt(refreshedExp),
        refresh_token: 'rt-rotated',
        expires_in: 3600,
      });
      storeOpenIdSession.mockRejectedValueOnce(new Error('mongo down'));
      const req = buildReq(buildExpiredSession('rt-old'));
      const res = buildRes({ headersSent: false });

      await expect(
        refreshOpenIDSession(req, res, makeOpenIdUser(), 'access_token'),
      ).rejects.toThrow('mongo down');
      expect(setRefreshTokenCookie).not.toHaveBeenCalled();
      expect(setOpenIDMarkerCookies).not.toHaveBeenCalled();
      expect(storeRefreshTokenBridge).toHaveBeenCalledWith({
        oldRefreshToken: 'rt-old',
        newRefreshToken: 'rt-rotated',
        userId: 'local-id-1',
        tenantId: 'tenant-1',
        openidIssuer: 'https://issuer.example.com',
        ttl: 60 * 1000,
      });
      expect(req.session.openidTokens.refreshToken).toBe('rt-old');
    });

    it('does not begin durable publication when ownership is lost at candidate settlement', async () => {
      const refreshedExp = Math.floor(Date.now() / 1000) + 3600;
      openIdClient.refreshTokenGrant.mockResolvedValueOnce({
        access_token: makeJwt(refreshedExp),
        id_token: makeJwt(refreshedExp),
        refresh_token: 'rt-rotated',
        expires_in: 3600,
      });
      const assertLeaseOwned = jest
        .fn()
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(true)
        .mockRejectedValueOnce(new Error('lease lost during durable transition'));
      withOpenIDRefreshFlightLease.mockImplementationOnce(({ operation }) =>
        operation({ assertLeaseOwned, markLeaseSettled: jest.fn() }),
      );
      const req = buildReq(buildExpiredSession('rt-old'));
      const res = buildRes({ headersSent: false });

      await expect(
        refreshOpenIDSession(req, res, makeOpenIdUser(), 'access_token'),
      ).rejects.toThrow('lease lost');

      expect(storeOpenIdSession).not.toHaveBeenCalled();
      expect(storeRefreshTokenBridge).toHaveBeenCalled();
      expect(setRefreshTokenCookie).not.toHaveBeenCalled();
      expect(setOpenIDMarkerCookies).not.toHaveBeenCalled();
      expect(req.session.openidTokens.refreshToken).toBe('rt-old');
    });

    it('does not write the cookie when the IdP does not rotate the refresh token', async () => {
      const refreshedExp = Math.floor(Date.now() / 1000) + 3600;
      openIdClient.refreshTokenGrant.mockResolvedValueOnce({
        access_token: makeJwt(refreshedExp),
        id_token: makeJwt(refreshedExp),
        // refresh_token omitted → preserved as 'rt-stable'
        expires_in: 3600,
      });
      const req = buildReq(buildExpiredSession('rt-stable'));
      const res = buildRes({ headersSent: false });

      await refreshOpenIDSession(req, res, makeOpenIdUser(), 'access_token');

      expect(setRefreshTokenCookie).not.toHaveBeenCalled();
      expect(setOpenIDMarkerCookies).not.toHaveBeenCalled();
    });

    it('rejects a grant whose declared access-token lifetime has already elapsed', async () => {
      openIdClient.refreshTokenGrant.mockResolvedValueOnce({
        access_token: 'opaque-and-already-spent',
        id_token: makeJwt(Math.floor(Date.now() / 1000) + 3600),
        refresh_token: 'rt-rotated',
        expires_in: 0,
      });
      const req = buildReq(buildExpiredSession('rt-old'));
      const res = buildRes({ headersSent: false });

      await expect(
        refreshOpenIDSession(req, res, makeOpenIdUser(), 'access_token'),
      ).rejects.toThrow('already-expired access_token');

      expect(setRefreshTokenCookie).not.toHaveBeenCalled();
      expect(storeRefreshTokenBridge).not.toHaveBeenCalled();
      expect(storeOpenIdSession).not.toHaveBeenCalled();
      expect(req.session.openidTokens.refreshToken).toBe('rt-old');
    });

    it('publishes a grant whose access-token lifetime is unknown', async () => {
      openIdClient.refreshTokenGrant.mockResolvedValueOnce({
        access_token: 'opaque-unknown-lifetime',
        id_token: makeJwt(Math.floor(Date.now() / 1000) + 3600),
        refresh_token: 'rt-rotated',
      });
      const req = buildReq(buildExpiredSession('rt-old'));
      const res = buildRes({ headersSent: false });

      await refreshOpenIDSession(req, res, makeOpenIdUser(), 'access_token');

      expect(req.session.openidTokens.refreshToken).toBe('rt-rotated');
      expect(req.session.openidTokens.accessTokenExpiresAt).toBeUndefined();
    });

    it('repairs a stale browser cookie when a stable refresh omits refresh_token', async () => {
      const refreshedExp = Math.floor(Date.now() / 1000) + 3600;
      openIdClient.refreshTokenGrant.mockResolvedValueOnce({
        access_token: makeJwt(refreshedExp),
        id_token: makeJwt(refreshedExp),
        expires_in: 3600,
      });
      const req = buildReq(buildExpiredSession('rt-session-current', 'rt-browser-stale'));
      const res = buildRes({ headersSent: false });

      await refreshOpenIDSession(req, res, makeOpenIdUser(), 'access_token');

      expect(setRefreshTokenCookie).toHaveBeenCalledWith(
        res,
        'rt-session-current',
        expect.any(Date),
      );
      expect(storeRefreshTokenBridge).toHaveBeenCalledWith(
        expect.objectContaining({
          oldRefreshToken: 'rt-browser-stale',
          newRefreshToken: 'rt-session-current',
          ttl: 60 * 1000,
        }),
      );
      expect(req.session.openidTokens.refreshToken).toBe('rt-session-current');
      expect(req.session.openidTokens.browserRefreshToken).toBe('rt-session-current');
    });

    it('revokes the advanced session token rather than the stale browser token on rotation', async () => {
      const refreshedExp = Math.floor(Date.now() / 1000) + 3600;
      openIdClient.refreshTokenGrant.mockResolvedValueOnce({
        access_token: makeJwt(refreshedExp),
        id_token: makeJwt(refreshedExp),
        refresh_token: 'rt-next',
        expires_in: 3600,
      });
      const req = buildReq(buildExpiredSession('rt-session-current', 'rt-browser-stale'));
      const res = buildRes({ headersSent: false });

      await refreshOpenIDSession(req, res, makeOpenIdUser(), 'access_token');

      expect(storeOpenIdSession).toHaveBeenCalledWith(
        expect.objectContaining({
          refreshToken: 'rt-next',
          previousRefreshToken: 'rt-session-current',
        }),
        { upsertSession, deleteSession },
      );
    });

    it('stores a bridge for stale browser cookies when a stable refresh cannot write cookies', async () => {
      const refreshedExp = Math.floor(Date.now() / 1000) + 3600;
      openIdClient.refreshTokenGrant.mockResolvedValueOnce({
        access_token: makeJwt(refreshedExp),
        id_token: makeJwt(refreshedExp),
        expires_in: 3600,
      });
      const req = buildReq(buildExpiredSession('rt-session-current', 'rt-browser-stale'));
      const res = buildRes({ headersSent: true });

      await refreshOpenIDSession(req, res, makeOpenIdUser(), 'access_token');

      expect(setRefreshTokenCookie).not.toHaveBeenCalled();
      expect(setOpenIDMarkerCookies).not.toHaveBeenCalled();
      expect(storeRefreshTokenBridge).toHaveBeenCalledWith({
        oldRefreshToken: 'rt-browser-stale',
        newRefreshToken: 'rt-session-current',
        userId: 'local-id-1',
        tenantId: 'tenant-1',
        openidIssuer: 'https://issuer.example.com',
      });
      expect(req.session.openidTokens.browserRefreshToken).toBe('rt-browser-stale');
    });

    it('resolves bridge identity through the shared helper when identity context is absent', async () => {
      const refreshedExp = Math.floor(Date.now() / 1000) + 3600;
      openIdClient.refreshTokenGrant.mockResolvedValueOnce({
        access_token: makeJwt(refreshedExp),
        id_token: makeJwt(refreshedExp),
        refresh_token: 'rt-rotated',
        expires_in: 3600,
      });
      const req = buildReq({
        ...buildExpiredSession('rt-old'),
        appUserId: 'mongo-id',
      });
      const res = buildRes({ headersSent: true });

      await refreshOpenIDSession(
        req,
        res,
        makeOpenIdUser({
          id: 'public-id',
          _id: { toString: () => 'mongo-id' },
          tenantId: 'tenant-1',
          openidIssuer: 'https://issuer.example.com',
        }),
        'access_token',
      );

      expect(storeRefreshTokenBridge).toHaveBeenCalledWith({
        oldRefreshToken: 'rt-old',
        newRefreshToken: 'rt-rotated',
        userId: 'mongo-id',
        tenantId: 'tenant-1',
        openidIssuer: 'https://issuer.example.com',
      });
    });

    it('syncs the rotated cookie and stores a short bridge before surfacing a session save failure', async () => {
      const refreshedExp = Math.floor(Date.now() / 1000) + 3600;
      openIdClient.refreshTokenGrant.mockResolvedValueOnce({
        access_token: makeJwt(refreshedExp),
        id_token: makeJwt(refreshedExp),
        refresh_token: 'rt-rotated',
        expires_in: 3600,
      });
      const req = buildReq(buildExpiredSession('rt-old'));
      const res = buildRes({ headersSent: false });
      req.session.save.mockImplementationOnce((cb) => cb(new Error('session store down')));

      await expect(
        refreshOpenIDSession(req, res, makeOpenIdUser(), 'access_token'),
      ).rejects.toThrow('session store down');

      expect(setRefreshTokenCookie).toHaveBeenCalledWith(res, 'rt-rotated', expect.any(Date));
      expect(setOpenIDMarkerCookies).toHaveBeenCalledTimes(1);
      expect(storeRefreshTokenBridge).toHaveBeenCalledWith({
        oldRefreshToken: 'rt-old',
        newRefreshToken: 'rt-rotated',
        userId: 'local-id-1',
        tenantId: 'tenant-1',
        openidIssuer: 'https://issuer.example.com',
        ttl: 60 * 1000,
      });
      expect(req.session.openidTokens.refreshToken).toBe('rt-rotated');
      expect(req.session.openidTokens.browserRefreshToken).toBe('rt-rotated');
    });

    it('stores a recovery bridge when response headers are already sent (streaming path)', async () => {
      const refreshedExp = Math.floor(Date.now() / 1000) + 3600;
      openIdClient.refreshTokenGrant.mockResolvedValueOnce({
        access_token: makeJwt(refreshedExp),
        id_token: makeJwt(refreshedExp),
        refresh_token: 'rt-rotated',
        expires_in: 3600,
      });
      const req = buildReq(buildExpiredSession('rt-old'));
      const res = buildRes({ headersSent: true });
      const user = makeOpenIdUser({
        tenantId: 'tenant-1',
        openidIssuer: 'https://issuer.example.com',
      });

      await refreshOpenIDSession(req, res, user, 'access_token');

      expect(setRefreshTokenCookie).not.toHaveBeenCalled();
      expect(setOpenIDMarkerCookies).not.toHaveBeenCalled();
      expect(storeRefreshTokenBridge).toHaveBeenCalledWith({
        oldRefreshToken: 'rt-old',
        newRefreshToken: 'rt-rotated',
        userId: 'local-id-1',
        tenantId: 'tenant-1',
        openidIssuer: 'https://issuer.example.com',
      });
      /** Session copy remains authoritative even when the cookie can't be set. */
      expect(req.session.openidTokens.refreshToken).toBe('rt-rotated');
      expect(req.session.openidTokens.browserRefreshToken).toBe('rt-old');
    });

    it('keeps bridging from the stale browser cookie across repeated rotations', async () => {
      const refreshedExp = Math.floor(Date.now() / 1000) + 3600;
      openIdClient.refreshTokenGrant.mockResolvedValueOnce({
        access_token: makeJwt(refreshedExp),
        id_token: makeJwt(refreshedExp),
        refresh_token: 'rt-second-rotation',
        expires_in: 3600,
      });
      const req = buildReq(buildExpiredSession('rt-first-rotation', 'rt-browser-cookie'));
      const res = buildRes({ headersSent: true });

      await refreshOpenIDSession(req, res, makeOpenIdUser(), 'access_token');

      expect(storeRefreshTokenBridge).toHaveBeenCalledWith({
        oldRefreshToken: 'rt-browser-cookie',
        newRefreshToken: 'rt-second-rotation',
        userId: 'local-id-1',
        tenantId: 'tenant-1',
        openidIssuer: 'https://issuer.example.com',
      });
      expect(req.session.openidTokens.refreshToken).toBe('rt-second-rotation');
      expect(req.session.openidTokens.browserRefreshToken).toBe('rt-browser-cookie');
    });

    it('stores a recovery bridge when no res is provided', async () => {
      const refreshedExp = Math.floor(Date.now() / 1000) + 3600;
      openIdClient.refreshTokenGrant.mockResolvedValueOnce({
        access_token: makeJwt(refreshedExp),
        id_token: makeJwt(refreshedExp),
        refresh_token: 'rt-rotated',
        expires_in: 3600,
      });
      const req = buildReq(buildExpiredSession('rt-old'));

      await expect(
        refreshOpenIDSession(req, undefined, makeOpenIdUser(), 'access_token'),
      ).resolves.toBeDefined();
      expect(setRefreshTokenCookie).not.toHaveBeenCalled();
      expect(setOpenIDMarkerCookies).not.toHaveBeenCalled();
      expect(storeRefreshTokenBridge).toHaveBeenCalledWith({
        oldRefreshToken: 'rt-old',
        newRefreshToken: 'rt-rotated',
        userId: 'local-id-1',
        tenantId: 'tenant-1',
        openidIssuer: 'https://issuer.example.com',
      });
    });

    it('stores a recovery bridge when res cannot write cookies', async () => {
      const refreshedExp = Math.floor(Date.now() / 1000) + 3600;
      openIdClient.refreshTokenGrant.mockResolvedValueOnce({
        access_token: makeJwt(refreshedExp),
        id_token: makeJwt(refreshedExp),
        refresh_token: 'rt-rotated',
        expires_in: 3600,
      });
      const req = buildReq(buildExpiredSession('rt-old'));

      await refreshOpenIDSession(req, { headersSent: false }, makeOpenIdUser(), 'access_token');

      expect(setRefreshTokenCookie).not.toHaveBeenCalled();
      expect(setOpenIDMarkerCookies).not.toHaveBeenCalled();
      expect(storeRefreshTokenBridge).toHaveBeenCalledWith({
        oldRefreshToken: 'rt-old',
        newRefreshToken: 'rt-rotated',
        userId: 'local-id-1',
        tenantId: 'tenant-1',
        openidIssuer: 'https://issuer.example.com',
      });
    });

    it('fails closed without mutating the session when bridge storage fails', async () => {
      const refreshedExp = Math.floor(Date.now() / 1000) + 3600;
      openIdClient.refreshTokenGrant.mockResolvedValueOnce({
        access_token: makeJwt(refreshedExp),
        id_token: makeJwt(refreshedExp),
        refresh_token: 'rt-rotated',
        expires_in: 3600,
      });
      storeRefreshTokenBridge.mockRejectedValueOnce(new Error('encrypt failed'));
      const req = buildReq(buildExpiredSession('rt-old'));
      const res = buildRes({ headersSent: true });

      await expect(
        refreshOpenIDSession(req, res, makeOpenIdUser(), 'access_token'),
      ).rejects.toThrow('encrypt failed');

      expect(req.session.openidTokens.refreshToken).toBe('rt-old');
    });
  });

  describe('single-flight coalescing', () => {
    it('scopes the local refresh key by explicit identity context', () => {
      const req = buildReq({ refreshToken: 'rt-shared' }, 'session-shared');
      const user = makeOpenIdUser({ tenantId: undefined, openidIssuer: undefined });

      const keyA = __internals.getSingleFlightKey(req, user, {
        openidSubject: 'oidc-sub-123',
        tenantId: 'tenant-a',
        openidIssuer: 'https://issuer-a.example.com',
      });
      const keyB = __internals.getSingleFlightKey(req, user, {
        openidSubject: 'oidc-sub-123',
        tenantId: 'tenant-b',
        openidIssuer: 'https://issuer-a.example.com',
      });
      const keyC = __internals.getSingleFlightKey(req, user, {
        openidSubject: 'oidc-sub-123',
        tenantId: 'tenant-a',
        openidIssuer: 'https://issuer-b.example.com',
      });

      expect(keyA).not.toBe(keyB);
      expect(keyA).not.toBe(keyC);
      expect(keyA).not.toContain('rt-shared');
    });

    it('shares one refreshTokenGrant across new Express sessions with the same token', async () => {
      const expiredExp = Math.floor(Date.now() / 1000) - 60;
      const sessionTokens = {
        accessToken: makeJwt(expiredExp),
        idToken: makeJwt(expiredExp),
        refreshToken: 'rt-shared',
      };
      let resolveGrant;
      const grantPromise = new Promise((resolve) => {
        resolveGrant = resolve;
      });
      openIdClient.refreshTokenGrant.mockReturnValueOnce(grantPromise);

      const reqA = buildReq(sessionTokens, 'session-A');
      const reqB = buildReq(sessionTokens, 'session-B');
      const user = makeOpenIdUser();

      const p1 = refreshOpenIDSession(reqA, undefined, user, 'access_token');
      const p2 = refreshOpenIDSession(reqB, undefined, user, 'access_token');
      await Promise.resolve();

      // Both calls land before the IdP responds
      expect(openIdClient.refreshTokenGrant).toHaveBeenCalledTimes(1);

      const refreshedExp = Math.floor(Date.now() / 1000) + 3600;
      resolveGrant({
        access_token: makeJwt(refreshedExp),
        id_token: makeJwt(refreshedExp),
        refresh_token: 'rt-rotated',
        expires_in: 3600,
      });

      const [r1, r2] = await Promise.all([p1, p2]);
      expect(r1).toStrictEqual(r2);
      expect(__internals.inFlightRefreshes.size).toBe(0);
    });

    it('does not share an in-flight refresh across distinct refresh tokens', async () => {
      const expiredExp = Math.floor(Date.now() / 1000) - 60;
      const reqA = buildReq(
        {
          accessToken: makeJwt(expiredExp),
          idToken: makeJwt(expiredExp),
          refreshToken: 'rt-A',
        },
        'session-A',
      );
      const reqB = buildReq(
        {
          accessToken: makeJwt(expiredExp),
          idToken: makeJwt(expiredExp),
          refreshToken: 'rt-B',
        },
        'session-B',
      );
      let resolveA;
      let resolveB;
      const promiseA = new Promise((resolve) => {
        resolveA = resolve;
      });
      const promiseB = new Promise((resolve) => {
        resolveB = resolve;
      });
      openIdClient.refreshTokenGrant.mockReturnValueOnce(promiseA).mockReturnValueOnce(promiseB);

      const user = makeOpenIdUser();
      const pA = refreshOpenIDSession(reqA, undefined, user, 'access_token');
      const pB = refreshOpenIDSession(reqB, undefined, user, 'access_token');
      await Promise.resolve();

      // Two refreshes started, one per session
      expect(openIdClient.refreshTokenGrant).toHaveBeenCalledTimes(2);

      const refreshedExp = Math.floor(Date.now() / 1000) + 3600;
      resolveA({
        access_token: makeJwt(refreshedExp),
        id_token: makeJwt(refreshedExp),
        refresh_token: 'rt-A-rotated',
        expires_in: 3600,
      });
      resolveB({
        access_token: makeJwt(refreshedExp),
        id_token: makeJwt(refreshedExp),
        refresh_token: 'rt-B-rotated',
        expires_in: 3600,
      });

      const [rA, rB] = await Promise.all([pA, pB]);
      expect(rA).not.toBe(rB);
      expect(reqA.session.openidTokens.refreshToken).toBe('rt-A-rotated');
      expect(reqB.session.openidTokens.refreshToken).toBe('rt-B-rotated');
    });

    it('does NOT share an in-flight refresh in the same session when refresh tokens differ', async () => {
      const expiredExp = Math.floor(Date.now() / 1000) - 60;
      const reqOld = buildReq(
        {
          accessToken: makeJwt(expiredExp),
          idToken: makeJwt(expiredExp),
          refreshToken: 'rt-old',
        },
        'session-rotated',
      );
      const reqCurrent = buildReq(
        {
          accessToken: makeJwt(expiredExp),
          idToken: makeJwt(expiredExp),
          refreshToken: 'rt-current',
        },
        'session-rotated',
      );
      let resolveOld;
      let resolveCurrent;
      const oldPromise = new Promise((resolve) => {
        resolveOld = resolve;
      });
      const currentPromise = new Promise((resolve) => {
        resolveCurrent = resolve;
      });
      openIdClient.refreshTokenGrant
        .mockReturnValueOnce(oldPromise)
        .mockReturnValueOnce(currentPromise);

      const user = makeOpenIdUser();
      const oldRefresh = refreshOpenIDSession(reqOld, undefined, user, 'access_token');
      const currentRefresh = refreshOpenIDSession(reqCurrent, undefined, user, 'access_token');
      await Promise.resolve();

      expect(openIdClient.refreshTokenGrant).toHaveBeenCalledTimes(2);

      const refreshedExp = Math.floor(Date.now() / 1000) + 3600;
      resolveOld({
        access_token: makeJwt(refreshedExp),
        id_token: makeJwt(refreshedExp),
        refresh_token: 'rt-old-rotated',
        expires_in: 3600,
      });
      resolveCurrent({
        access_token: makeJwt(refreshedExp),
        id_token: makeJwt(refreshedExp),
        refresh_token: 'rt-current-rotated',
        expires_in: 3600,
      });

      const [oldResult, currentResult] = await Promise.all([oldRefresh, currentRefresh]);
      expect(oldResult).not.toBe(currentResult);
      expect(reqOld.session.openidTokens.refreshToken).toBe('rt-old-rotated');
      expect(reqCurrent.session.openidTokens.refreshToken).toBe('rt-current-rotated');
    });

    it('clears in-flight slot on rejection so subsequent attempts can retry', async () => {
      const expiredExp = Math.floor(Date.now() / 1000) - 60;
      const sessionTokens = {
        accessToken: makeJwt(expiredExp),
        idToken: makeJwt(expiredExp),
        refreshToken: 'rt-flaky',
      };
      openIdClient.refreshTokenGrant.mockRejectedValueOnce(new Error('transient'));
      const req = buildReq(sessionTokens);
      const user = makeOpenIdUser();

      await expect(refreshOpenIDSession(req, undefined, user, 'access_token')).rejects.toThrow(
        'transient',
      );
      expect(__internals.inFlightRefreshes.size).toBe(0);

      // Second attempt: succeed
      const refreshedExp = Math.floor(Date.now() / 1000) + 3600;
      openIdClient.refreshTokenGrant.mockResolvedValueOnce({
        access_token: makeJwt(refreshedExp),
        id_token: makeJwt(refreshedExp),
        refresh_token: 'rt-recovered',
        expires_in: 3600,
      });
      const result = await refreshOpenIDSession(req, undefined, user, 'access_token');
      expect(result.refresh_token).toBe('rt-recovered');
    });

    it('hydrates a joining request that shares the session id but carries a distinct req', async () => {
      const expiredExp = Math.floor(Date.now() / 1000) - 60;
      const makeExpiredSession = (refreshToken) => ({
        accessToken: makeJwt(expiredExp),
        idToken: makeJwt(expiredExp),
        refreshToken,
      });
      /** Two concurrent HTTP requests from the same browser session. */
      const leaderReq = buildReq(makeExpiredSession('rt-stale'), 'session-joined');
      const joinerReq = buildReq(makeExpiredSession('rt-stale'), 'session-joined');
      const user = makeOpenIdUser();

      let resolveGrant;
      const grantPromise = new Promise((resolve) => {
        resolveGrant = resolve;
      });
      openIdClient.refreshTokenGrant.mockReturnValueOnce(grantPromise);

      const leaderPromise = refreshOpenIDSession(leaderReq, undefined, user, 'access_token');
      const joinerPromise = refreshOpenIDSession(joinerReq, undefined, user, 'access_token');
      await Promise.resolve();

      // Only the leader hit the IdP; the joiner coalesced onto it.
      expect(openIdClient.refreshTokenGrant).toHaveBeenCalledTimes(1);

      const refreshedExp = Math.floor(Date.now() / 1000) + 3600;
      resolveGrant({
        access_token: makeJwt(refreshedExp),
        id_token: makeJwt(refreshedExp),
        refresh_token: 'rt-rotated',
        expires_in: 3600,
      });

      const [leaderTokens, joinerTokens] = await Promise.all([leaderPromise, joinerPromise]);

      expect(leaderTokens.refresh_token).toBe('rt-rotated');
      expect(joinerTokens.refresh_token).toBe('rt-rotated');
      // The joiner's OWN session is hydrated so a later OBO call won't replay rt-stale.
      expect(joinerReq.session.openidTokens.refreshToken).toBe('rt-rotated');
      expect(joinerReq.session.openidTokens.browserRefreshToken).toBe('rt-stale');
      expect(joinerReq.session.save).toHaveBeenCalled();
    });

    it('checks revocation before an already-current local joiner returns', async () => {
      const expiredExp = Math.floor(Date.now() / 1000) - 60;
      const req = buildReq({
        accessToken: makeJwt(expiredExp),
        idToken: makeJwt(expiredExp),
        refreshToken: 'rt-shared-request',
      });
      let resolveGrant;
      openIdClient.refreshTokenGrant.mockReturnValueOnce(
        new Promise((resolve) => {
          resolveGrant = resolve;
        }),
      );
      const leaderPromise = refreshOpenIDSession(req, buildRes(), makeOpenIdUser(), 'access_token');
      const joinerPromise = refreshOpenIDSession(req, buildRes(), makeOpenIdUser(), 'access_token');
      await Promise.resolve();
      resolveGrant({
        access_token: makeJwt(Math.floor(Date.now() / 1000) + 3600),
        id_token: makeJwt(Math.floor(Date.now() / 1000) + 3600),
        refresh_token: 'rt-shared-successor',
        expires_in: 3600,
      });
      assertOpenIDRefreshFlightAvailable.mockRejectedValueOnce(ownershipLost('revoked by logout'));

      await expect(leaderPromise).resolves.toBeDefined();
      await expect(joinerPromise).rejects.toThrow('revoked by logout');
      expect(assertOpenIDRefreshFlightAvailable).toHaveBeenCalledWith({
        key: 'flight:session-A:rt-shared-request',
        ownerId: 'owner-1',
      });
    });

    it('keeps both local coalescing participants unpublished when publication is deferred', async () => {
      const expiredExp = Math.floor(Date.now() / 1000) - 60;
      const makeExpiredSession = () => ({
        accessToken: makeJwt(expiredExp),
        idToken: makeJwt(expiredExp),
        refreshToken: 'rt-deferred',
        browserRefreshToken: 'rt-deferred',
      });
      const leaderReq = buildReq(makeExpiredSession(), 'session-deferred-leader');
      const joinerReq = buildReq(makeExpiredSession(), 'session-deferred-joiner');
      const user = makeOpenIdUser();
      let resolveGrant;
      openIdClient.refreshTokenGrant.mockReturnValueOnce(
        new Promise((resolve) => {
          resolveGrant = resolve;
        }),
      );

      const options = { forceRefresh: true, deferPublication: true };
      const leaderPromise = refreshOpenIDSession(
        leaderReq,
        undefined,
        user,
        'access_token',
        undefined,
        options,
      );
      const joinerPromise = refreshOpenIDSession(
        joinerReq,
        undefined,
        user,
        'access_token',
        undefined,
        options,
      );
      await Promise.resolve();
      resolveGrant({
        access_token: makeJwt(Math.floor(Date.now() / 1000) + 3600),
        id_token: makeJwt(Math.floor(Date.now() / 1000) + 3600),
        refresh_token: 'rt-deferred-rotated',
        expires_in: 3600,
      });

      const [leaderTokens, joinerTokens] = await Promise.all([leaderPromise, joinerPromise]);

      expect(leaderTokens.refresh_token).toBe('rt-deferred-rotated');
      expect(joinerTokens.refresh_token).toBe('rt-deferred-rotated');
      expect(leaderReq.session.openidTokens.refreshToken).toBe('rt-deferred');
      expect(joinerReq.session.openidTokens.refreshToken).toBe('rt-deferred');
      expect(leaderReq.session.save).not.toHaveBeenCalled();
      expect(joinerReq.session.save).not.toHaveBeenCalled();
      expect(storeOpenIdSession).not.toHaveBeenCalled();
      expect(setRefreshTokenCookie).not.toHaveBeenCalled();
    });

    it('hydrates a joining request with the rotated browser marker when the leader wrote cookies', async () => {
      const expiredExp = Math.floor(Date.now() / 1000) - 60;
      const makeExpiredSession = () => ({
        accessToken: makeJwt(expiredExp),
        idToken: makeJwt(expiredExp),
        refreshToken: 'rt-stale',
        browserRefreshToken: 'rt-stale',
      });
      const leaderReq = buildReq(makeExpiredSession(), 'session-cookie-joined');
      const joinerReq = buildReq(makeExpiredSession(), 'session-cookie-joined');
      const leaderRes = buildRes({ headersSent: false });
      const joinerRes = buildRes({ headersSent: false });
      const user = makeOpenIdUser();

      let resolveGrant;
      const grantPromise = new Promise((resolve) => {
        resolveGrant = resolve;
      });
      openIdClient.refreshTokenGrant.mockReturnValueOnce(grantPromise);

      const leaderPromise = refreshOpenIDSession(leaderReq, leaderRes, user, 'access_token');
      const joinerPromise = refreshOpenIDSession(joinerReq, joinerRes, user, 'access_token');
      await Promise.resolve();

      expect(openIdClient.refreshTokenGrant).toHaveBeenCalledTimes(1);

      const refreshedExp = Math.floor(Date.now() / 1000) + 3600;
      resolveGrant({
        access_token: makeJwt(refreshedExp),
        id_token: makeJwt(refreshedExp),
        refresh_token: 'rt-rotated',
        expires_in: 3600,
      });

      const [leaderTokens, joinerTokens] = await Promise.all([leaderPromise, joinerPromise]);

      expect(leaderTokens.refresh_token).toBe('rt-rotated');
      expect(joinerTokens.refresh_token).toBe('rt-rotated');
      expect(setRefreshTokenCookie).toHaveBeenCalledWith(leaderRes, 'rt-rotated', expect.any(Date));
      expect(setRefreshTokenCookie).toHaveBeenCalledWith(joinerRes, 'rt-rotated', expect.any(Date));
      expect(leaderReq.session.openidTokens.browserRefreshToken).toBe('rt-rotated');
      expect(leaderReq.session.openidTokens).toEqual(
        expect.objectContaining({
          publicationFlightKey: 'flight:session-cookie-joined:rt-stale',
          publicationFlightOwnerId: 'owner-1',
        }),
      );
      expect(joinerReq.session.openidTokens.refreshToken).toBe('rt-rotated');
      expect(joinerReq.session.openidTokens.browserRefreshToken).toBe('rt-rotated');
      expect(Object.keys(joinerTokens)).not.toContain('__browserRefreshToken');
      expect(joinerReq.session.save).toHaveBeenCalled();
    });

    it('hydrates a joining request when the refresh token stays stable', async () => {
      const expiredExp = Math.floor(Date.now() / 1000) - 60;
      const makeExpiredSession = () => ({
        accessToken: makeJwt(expiredExp),
        idToken: makeJwt(expiredExp),
        refreshToken: 'rt-stable',
        accessTokenExpiresAt: expiredExp,
      });
      const leaderReq = buildReq(makeExpiredSession(), 'session-stable-joined');
      const joinerReq = buildReq(makeExpiredSession(), 'session-stable-joined');
      const user = makeOpenIdUser();

      let resolveGrant;
      const grantPromise = new Promise((resolve) => {
        resolveGrant = resolve;
      });
      openIdClient.refreshTokenGrant.mockReturnValueOnce(grantPromise);

      const leaderPromise = refreshOpenIDSession(leaderReq, undefined, user, 'access_token');
      const joinerPromise = refreshOpenIDSession(joinerReq, undefined, user, 'access_token');
      await Promise.resolve();

      expect(openIdClient.refreshTokenGrant).toHaveBeenCalledTimes(1);

      const refreshedExp = Math.floor(Date.now() / 1000) + 3600;
      const refreshedAccessToken = makeJwt(refreshedExp);
      const refreshedIdToken = makeJwt(refreshedExp);
      resolveGrant({
        access_token: refreshedAccessToken,
        id_token: refreshedIdToken,
        refresh_token: 'rt-stable',
        expires_in: 3600,
      });

      const [leaderTokens, joinerTokens] = await Promise.all([leaderPromise, joinerPromise]);

      expect(leaderTokens.refresh_token).toBe('rt-stable');
      expect(joinerTokens.refresh_token).toBe('rt-stable');
      expect(joinerReq.session.openidTokens.accessToken).toBe(refreshedAccessToken);
      expect(joinerReq.session.openidTokens.idToken).toBe(refreshedIdToken);
      expect(joinerReq.session.openidTokens.refreshToken).toBe('rt-stable');
      expect(joinerReq.session.openidTokens.accessTokenExpiresAt).toBe(joinerTokens.expires_at);
      expect(joinerReq.session.openidTokens.accessTokenExpiresAt).toBeGreaterThan(expiredExp);
      expect(joinerReq.session.save).toHaveBeenCalled();
    });

    it('joins a shared Mongo refresh flight when the local process has no in-flight entry', async () => {
      const expiredExp = Math.floor(Date.now() / 1000) - 60;
      const makeExpiredSession = () => ({
        accessToken: makeJwt(expiredExp),
        idToken: makeJwt(expiredExp),
        refreshToken: 'rt-cross-worker',
      });
      const leaderReq = buildReq(makeExpiredSession(), 'session-cross-worker');
      const joinerReq = buildReq(makeExpiredSession(), 'session-cross-worker');
      const user = makeOpenIdUser();

      let resolveGrant;
      const grantPromise = new Promise((resolve) => {
        resolveGrant = resolve;
      });
      openIdClient.refreshTokenGrant.mockReturnValueOnce(grantPromise);
      acquireOpenIDRefreshFlight
        .mockResolvedValueOnce({ acquired: true, ownerId: 'owner-leader' })
        .mockResolvedValueOnce({ acquired: false, ownerId: 'owner-joiner' });

      const refreshedExp = Math.floor(Date.now() / 1000) + 3600;
      const sharedTokens = {
        access_token: makeJwt(refreshedExp),
        id_token: makeJwt(refreshedExp),
        refresh_token: 'rt-cross-worker-rotated',
        expires_at: refreshedExp,
      };
      Object.defineProperty(sharedTokens, '__flightOwnerId', {
        value: 'owner-leader',
        enumerable: false,
      });
      waitForOpenIDRefreshFlight.mockResolvedValueOnce(sharedTokens);

      const leaderPromise = refreshOpenIDSession(leaderReq, undefined, user, 'access_token');
      await Promise.resolve();
      expect(openIdClient.refreshTokenGrant).toHaveBeenCalledTimes(1);

      /**
       * Simulate a second worker: it does not see this process-local Map, but
       * it does see the Mongo flight for the same browser session/token.
       */
      __internals.inFlightRefreshes.clear();
      const joinerTokens = await refreshOpenIDSession(joinerReq, undefined, user, 'access_token');

      expect(waitForOpenIDRefreshFlight).toHaveBeenCalledWith({
        key: 'flight:session-cross-worker:rt-cross-worker',
      });
      expect(openIdClient.refreshTokenGrant).toHaveBeenCalledTimes(1);
      expect(joinerTokens).toStrictEqual(sharedTokens);
      expect(joinerReq.session.openidTokens.refreshToken).toBe('rt-cross-worker-rotated');
      expect(joinerReq.session.openidTokens).toEqual(
        expect.objectContaining({
          publicationFlightKey: 'flight:session-cross-worker:rt-cross-worker',
          publicationFlightOwnerId: 'owner-leader',
        }),
      );
      expect(joinerReq.session.save).toHaveBeenCalled();

      resolveGrant({
        access_token: sharedTokens.access_token,
        id_token: sharedTokens.id_token,
        refresh_token: sharedTokens.refresh_token,
        expires_in: 3600,
      });

      await expect(leaderPromise).resolves.toEqual(
        expect.objectContaining({
          access_token: sharedTokens.access_token,
          id_token: sharedTokens.id_token,
          refresh_token: sharedTokens.refresh_token,
          expires_at: expect.any(Number),
        }),
      );
      expect(completeOpenIDRefreshFlight).toHaveBeenCalledWith({
        key: 'flight:session-cross-worker:rt-cross-worker',
        ownerId: 'owner-leader',
        tokens: expect.objectContaining({
          access_token: sharedTokens.access_token,
          id_token: sharedTokens.id_token,
          refresh_token: sharedTokens.refresh_token,
          expires_at: expect.any(Number),
        }),
      });
      expect(withOpenIDRefreshFlightLease).toHaveBeenCalledWith({
        key: 'flight:session-cross-worker:rt-cross-worker',
        ownerId: 'owner-leader',
        operation: expect.any(Function),
      });
    });

    it('rolls back a follower replay when logout revokes the completed flight', async () => {
      const expiredExp = Math.floor(Date.now() / 1000) - 60;
      const predecessorAccessToken = makeJwt(expiredExp);
      const req = buildReq({
        accessToken: predecessorAccessToken,
        idToken: makeJwt(expiredExp),
        refreshToken: 'rt-predecessor',
        browserRefreshToken: 'rt-predecessor',
      });
      const res = buildRes({ headersSent: false });
      req.session.destroy = jest.fn((callback) => {
        delete req.session.openidTokens;
        callback();
      });
      acquireOpenIDRefreshFlight.mockResolvedValueOnce({ acquired: false, ownerId: 'follower' });
      waitForOpenIDRefreshFlight.mockResolvedValueOnce({
        access_token: makeJwt(Math.floor(Date.now() / 1000) + 3600),
        id_token: makeJwt(Math.floor(Date.now() / 1000) + 3600),
        refresh_token: 'rt-successor',
        expires_at: Math.floor(Date.now() / 1000) + 3600,
        __predecessorRefreshToken: 'rt-predecessor',
        __predecessorAccessToken: predecessorAccessToken,
        __flightOwnerId: 'generation-owner',
      });
      assertOpenIDRefreshFlightAvailable
        .mockResolvedValueOnce({ status: 'completed' })
        .mockResolvedValueOnce({ status: 'completed' })
        .mockResolvedValueOnce({ status: 'completed' })
        .mockResolvedValueOnce({ status: 'completed' })
        .mockResolvedValueOnce({ status: 'completed' })
        .mockRejectedValueOnce(ownershipLost('revoked by logout'));

      await expect(
        refreshOpenIDSession(req, res, makeOpenIdUser(), 'access_token'),
      ).rejects.toThrow('revoked by logout');

      expect(storeOpenIdSession).toHaveBeenCalled();
      expect(setRefreshTokenCookie).toHaveBeenCalled();
      expect(req.session.save).toHaveBeenCalled();
      expect(deleteSession).toHaveBeenCalledWith({ refreshToken: 'rt-successor' });
      expect(req.session.destroy).toHaveBeenCalled();
      expect(res.clearCookie).toHaveBeenCalledWith('refreshToken');
      expect(assertOpenIDRefreshFlightAvailable).toHaveBeenCalledWith({
        key: 'flight:session-A:rt-predecessor',
        ownerId: 'generation-owner',
      });
    });

    it('does not replay a stable-token flight over a newer access token', async () => {
      const expiredExp = Math.floor(Date.now() / 1000) - 60;
      const predecessorAccessToken = makeJwt(expiredExp);
      const advancedAccessToken = makeJwt(Math.floor(Date.now() / 1000) + 7200);
      const req = buildReq({
        accessToken: predecessorAccessToken,
        idToken: makeJwt(expiredExp),
        refreshToken: 'rt-stable',
      });
      req.session.reload = jest.fn((callback) => {
        req.session.openidTokens = {
          ...req.session.openidTokens,
          accessToken: advancedAccessToken,
          refreshToken: 'rt-stable',
        };
        callback();
      });
      acquireOpenIDRefreshFlight.mockResolvedValueOnce({ acquired: false, ownerId: 'follower' });
      waitForOpenIDRefreshFlight.mockResolvedValueOnce({
        access_token: makeJwt(Math.floor(Date.now() / 1000) + 3600),
        id_token: makeJwt(Math.floor(Date.now() / 1000) + 3600),
        refresh_token: 'rt-stable',
        expires_at: Math.floor(Date.now() / 1000) + 3600,
        __predecessorRefreshToken: 'rt-stable',
        __predecessorAccessToken: predecessorAccessToken,
        __flightOwnerId: 'stable-generation-owner',
      });

      const result = await refreshOpenIDSession(req, buildRes(), makeOpenIdUser(), 'access_token');

      expect(req.session.openidTokens.accessToken).toBe(advancedAccessToken);
      expect(result.access_token).toBe(advancedAccessToken);
      expect(result.__predecessorAccessToken).toBe(predecessorAccessToken);
      expect(storeOpenIdSession).not.toHaveBeenCalled();
      expect(setRefreshTokenCookie).not.toHaveBeenCalled();
      expect(req.session.save).not.toHaveBeenCalled();
    });

    it('does not publish a deferred local leader result through an immediate joiner', async () => {
      const expiredExp = Math.floor(Date.now() / 1000) - 60;
      const makeExpiredSession = () => ({
        accessToken: makeJwt(expiredExp),
        idToken: makeJwt(expiredExp),
        refreshToken: 'rt-mixed-mode',
      });
      const leaderReq = buildReq(makeExpiredSession(), 'session-mixed-mode');
      const joinerReq = buildReq(makeExpiredSession(), 'session-mixed-mode');
      let resolveGrant;
      openIdClient.refreshTokenGrant.mockReturnValueOnce(
        new Promise((resolve) => {
          resolveGrant = resolve;
        }),
      );

      const leaderPromise = refreshOpenIDSession(
        leaderReq,
        undefined,
        makeOpenIdUser(),
        'access_token',
        undefined,
        { forceRefresh: true, deferPublication: true },
      );
      const joinerPromise = refreshOpenIDSession(
        joinerReq,
        buildRes(),
        makeOpenIdUser(),
        'access_token',
      );
      await Promise.resolve();
      resolveGrant({
        access_token: makeJwt(Math.floor(Date.now() / 1000) + 3600),
        id_token: makeJwt(Math.floor(Date.now() / 1000) + 3600),
        refresh_token: 'rt-mixed-successor',
        expires_in: 3600,
      });

      await expect(leaderPromise).resolves.toBeDefined();
      await expect(joinerPromise).rejects.toMatchObject({ status: 503, retryable: true });
      expect(joinerReq.session.save).not.toHaveBeenCalled();
      expect(storeOpenIdSession).not.toHaveBeenCalled();
      expect(setRefreshTokenCookie).not.toHaveBeenCalled();
    });

    it('does not publish a deferred cross-replica result through an immediate follower', async () => {
      const expiredExp = Math.floor(Date.now() / 1000) - 60;
      const req = buildReq({
        accessToken: makeJwt(expiredExp),
        idToken: makeJwt(expiredExp),
        refreshToken: 'rt-deferred-worker',
      });
      acquireOpenIDRefreshFlight.mockResolvedValueOnce({ acquired: false, ownerId: 'follower' });
      waitForOpenIDRefreshFlight.mockResolvedValueOnce({
        access_token: makeJwt(Math.floor(Date.now() / 1000) + 3600),
        id_token: makeJwt(Math.floor(Date.now() / 1000) + 3600),
        refresh_token: 'rt-deferred-successor',
        expires_at: Math.floor(Date.now() / 1000) + 3600,
        __deferredPublication: true,
      });

      await expect(
        refreshOpenIDSession(req, buildRes(), makeOpenIdUser(), 'access_token'),
      ).rejects.toMatchObject({ status: 503, retryable: true });

      expect(storeOpenIdSession).not.toHaveBeenCalled();
      expect(setRefreshTokenCookie).not.toHaveBeenCalled();
      expect(req.session.save).not.toHaveBeenCalled();
    });

    it('fails closed when a shared flight times out instead of issuing a duplicate grant', async () => {
      const expiredExp = Math.floor(Date.now() / 1000) - 60;
      const req = buildReq(
        {
          accessToken: makeJwt(expiredExp),
          idToken: makeJwt(expiredExp),
          refreshToken: 'rt-cross-worker',
        },
        'session-cross-worker',
      );
      acquireOpenIDRefreshFlight.mockResolvedValueOnce({
        acquired: false,
        ownerId: 'owner-joiner',
      });
      waitForOpenIDRefreshFlight.mockResolvedValueOnce(null);

      await expect(
        refreshOpenIDSession(req, undefined, makeOpenIdUser(), 'access_token'),
      ).rejects.toThrow('OpenID refresh coordination is temporarily unavailable');

      expect(openIdClient.refreshTokenGrant).not.toHaveBeenCalled();
      expect(withOpenIDRefreshFlightLease).not.toHaveBeenCalled();
    });

    it('does not mutate session state after refresh-flight ownership is lost', async () => {
      const expiredExp = Math.floor(Date.now() / 1000) - 60;
      const sessionTokens = {
        accessToken: makeJwt(expiredExp),
        idToken: makeJwt(expiredExp),
        refreshToken: 'rt-lost-owner',
      };
      const req = buildReq(sessionTokens, 'session-lost-owner');
      withOpenIDRefreshFlightLease.mockImplementationOnce(({ operation }) =>
        operation({
          assertLeaseOwned: jest
            .fn()
            .mockRejectedValue(new Error('OpenID refresh coordination ownership was lost')),
          markLeaseSettled: jest.fn(),
        }),
      );
      openIdClient.refreshTokenGrant.mockResolvedValueOnce({
        access_token: makeJwt(Math.floor(Date.now() / 1000) + 3600),
        refresh_token: 'rt-rotated-by-stale-owner',
        expires_in: 3600,
      });

      await expect(
        refreshOpenIDSession(req, undefined, makeOpenIdUser(), 'access_token'),
      ).rejects.toThrow('ownership was lost');

      expect(req.session.openidTokens).toEqual(
        expect.objectContaining({
          accessToken: sessionTokens.accessToken,
          idToken: sessionTokens.idToken,
          refreshToken: sessionTokens.refreshToken,
        }),
      );
      expect(req.session.save).not.toHaveBeenCalled();
      expect(completeOpenIDRefreshFlight).not.toHaveBeenCalled();
      expect(failOpenIDRefreshFlight).toHaveBeenCalled();
    });

    it('keeps an indeterminate completed generation recoverable instead of marking it failed', async () => {
      const expiredExp = Math.floor(Date.now() / 1000) - 60;
      const req = buildReq({
        accessToken: makeJwt(expiredExp),
        idToken: makeJwt(expiredExp),
        refreshToken: 'rt-predecessor',
      });
      openIdClient.refreshTokenGrant.mockResolvedValueOnce({
        access_token: makeJwt(Math.floor(Date.now() / 1000) + 3600),
        id_token: makeJwt(Math.floor(Date.now() / 1000) + 3600),
        refresh_token: 'rt-successor',
        expires_in: 3600,
      });
      completeOpenIDRefreshFlight.mockRejectedValueOnce(new Error('completion timed out'));
      assertOpenIDRefreshFlightAvailable.mockRejectedValueOnce(new Error('read timed out'));

      await expect(
        refreshOpenIDSession(req, undefined, makeOpenIdUser(), 'access_token'),
      ).rejects.toThrow('completion timed out');

      expect(req.session.openidTokens.refreshToken).toBe('rt-successor');
      expect(failOpenIDRefreshFlight).not.toHaveBeenCalled();
    });

    it('accepts an observed completed generation after the completion acknowledgement is lost', async () => {
      const expiredExp = Math.floor(Date.now() / 1000) - 60;
      const req = buildReq({
        accessToken: makeJwt(expiredExp),
        idToken: makeJwt(expiredExp),
        refreshToken: 'rt-predecessor',
      });
      openIdClient.refreshTokenGrant.mockResolvedValueOnce({
        access_token: makeJwt(Math.floor(Date.now() / 1000) + 3600),
        id_token: makeJwt(Math.floor(Date.now() / 1000) + 3600),
        refresh_token: 'rt-successor',
        expires_in: 3600,
      });
      completeOpenIDRefreshFlight.mockRejectedValueOnce(new Error('completion timed out'));
      assertOpenIDRefreshFlightAvailable.mockResolvedValueOnce({
        status: 'completed',
        ownerId: 'owner-1',
      });

      await expect(
        refreshOpenIDSession(req, undefined, makeOpenIdUser(), 'access_token'),
      ).resolves.toMatchObject({ refresh_token: 'rt-successor' });
      expect(failOpenIDRefreshFlight).not.toHaveBeenCalled();
    });

    it('rolls back session and cookie publication when logout revokes the pending flight', async () => {
      const expiredExp = Math.floor(Date.now() / 1000) - 60;
      const req = buildReq({
        accessToken: makeJwt(expiredExp),
        idToken: makeJwt(expiredExp),
        refreshToken: 'rt-predecessor',
        browserRefreshToken: 'rt-predecessor',
      });
      const res = buildRes({ headersSent: false });
      req.session.destroy = jest.fn((callback) => {
        delete req.session.openidTokens;
        callback();
      });
      openIdClient.refreshTokenGrant.mockResolvedValueOnce({
        access_token: makeJwt(Math.floor(Date.now() / 1000) + 3600),
        id_token: makeJwt(Math.floor(Date.now() / 1000) + 3600),
        refresh_token: 'rt-successor',
        expires_in: 3600,
      });
      completeOpenIDRefreshFlight.mockResolvedValueOnce(null);

      await expect(
        refreshOpenIDSession(req, res, makeOpenIdUser(), 'access_token'),
      ).rejects.toThrow('ownership was lost');

      expect(storeOpenIdSession).toHaveBeenCalled();
      expect(setRefreshTokenCookie).toHaveBeenCalledWith(res, 'rt-successor', expect.any(Date));
      expect(deleteSession).toHaveBeenCalledWith({ refreshToken: 'rt-successor' });
      expect(req.session.destroy).toHaveBeenCalled();
      expect(deleteRefreshTokenBridges).toHaveBeenCalledWith({
        refreshTokens: ['rt-predecessor'],
        userId: 'local-id-1',
        tenantId: 'tenant-1',
        version: 'bridge-version-1',
      });
      expect(req.session.openidTokens).toBeUndefined();
      expect(res.clearCookie).toHaveBeenCalledWith('refreshToken');
      expect(res.clearCookie).toHaveBeenCalledWith('openid_user_id');
      expect(res.clearCookie).toHaveBeenCalledWith('token_provider');
    });

    it('compare-deletes the final long-lived bridge when publication is revoked', async () => {
      const expiredExp = Math.floor(Date.now() / 1000) - 60;
      const req = buildReq({
        accessToken: makeJwt(expiredExp),
        idToken: makeJwt(expiredExp),
        refreshToken: 'rt-predecessor',
        browserRefreshToken: 'rt-predecessor',
      });
      req.session.destroy = jest.fn((callback) => {
        delete req.session.openidTokens;
        callback();
      });
      storeRefreshTokenBridge
        .mockResolvedValueOnce('grace-bridge-version')
        .mockResolvedValueOnce('final-bridge-version');
      openIdClient.refreshTokenGrant.mockResolvedValueOnce({
        access_token: makeJwt(Math.floor(Date.now() / 1000) + 3600),
        id_token: makeJwt(Math.floor(Date.now() / 1000) + 3600),
        refresh_token: 'rt-successor',
        expires_in: 3600,
      });
      completeOpenIDRefreshFlight.mockResolvedValueOnce(null);

      await expect(
        refreshOpenIDSession(req, undefined, makeOpenIdUser(), 'access_token'),
      ).rejects.toThrow('ownership was lost');

      expect(storeRefreshTokenBridge).toHaveBeenCalledTimes(2);
      expect(deleteRefreshTokenBridges).toHaveBeenCalledWith({
        refreshTokens: ['rt-predecessor'],
        userId: 'local-id-1',
        tenantId: 'tenant-1',
        version: 'final-bridge-version',
      });
    });

    it('does not destroy a newer Express session when another owner advanced it', async () => {
      const expiredExp = Math.floor(Date.now() / 1000) - 60;
      const advancedAccessToken = makeJwt(Math.floor(Date.now() / 1000) + 7200);
      const req = buildReq({
        accessToken: makeJwt(expiredExp),
        idToken: makeJwt(expiredExp),
        refreshToken: 'rt-predecessor',
        browserRefreshToken: 'rt-predecessor',
      });
      const res = buildRes({ headersSent: false });
      req.session.destroy = jest.fn((callback) => callback());
      req.session.reload = jest.fn();
      req.session.reload
        .mockImplementationOnce((callback) => callback())
        .mockImplementationOnce((callback) => {
          req.session.openidTokens = {
            ...req.session.openidTokens,
            accessToken: advancedAccessToken,
            refreshToken: 'rt-new-owner',
          };
          callback();
        });
      openIdClient.refreshTokenGrant.mockResolvedValueOnce({
        access_token: makeJwt(Math.floor(Date.now() / 1000) + 3600),
        id_token: makeJwt(Math.floor(Date.now() / 1000) + 3600),
        refresh_token: 'rt-stale-owner',
        expires_in: 3600,
      });
      completeOpenIDRefreshFlight.mockResolvedValueOnce(null);

      await expect(
        refreshOpenIDSession(req, res, makeOpenIdUser(), 'access_token'),
      ).rejects.toThrow('ownership was lost');

      expect(req.session.destroy).not.toHaveBeenCalled();
      expect(req.session.openidTokens.accessToken).toBe(advancedAccessToken);
      expect(req.session.openidTokens.refreshToken).toBe('rt-new-owner');
      expect(deleteSession).toHaveBeenCalledWith({ refreshToken: 'rt-stale-owner' });
      expect(res.clearCookie).toHaveBeenCalledWith('refreshToken');
    });

    it('fails closed when Mongo flight acquisition is unavailable', async () => {
      const expiredExp = Math.floor(Date.now() / 1000) - 60;
      const req = buildReq(
        {
          accessToken: makeJwt(expiredExp),
          idToken: makeJwt(expiredExp),
          refreshToken: 'rt-coordination-down',
        },
        'session-coordination-down',
      );
      acquireOpenIDRefreshFlight.mockRejectedValueOnce(new Error('mongo unavailable'));

      await expect(
        refreshOpenIDSession(req, undefined, makeOpenIdUser(), 'access_token'),
      ).rejects.toThrow('OpenID refresh coordination is temporarily unavailable');

      expect(openIdClient.refreshTokenGrant).not.toHaveBeenCalled();
    });
  });

  describe('createOpenIDSessionTokenProvider closure delegation', () => {
    it('returns the live OIDCTokens shape from a valid session', async () => {
      const farFutureExp = Math.floor(Date.now() / 1000) + 600;
      const sessionTokens = {
        accessToken: makeJwt(farFutureExp),
        idToken: makeJwt(farFutureExp),
        refreshToken: 'rt-1',
      };
      const provider = createOpenIDSessionTokenProvider({
        req: buildReq(sessionTokens),
        user: makeOpenIdUser(),
        tokenPreference: 'access_token',
      });

      const result = await provider();
      expect(result).toEqual({
        access_token: sessionTokens.accessToken,
        id_token: sessionTokens.idToken,
        refresh_token: 'rt-1',
        expires_at: farFutureExp,
      });
    });

    it('rejects with the IdP error when refresh fails through the closure', async () => {
      const expiredExp = Math.floor(Date.now() / 1000) - 60;
      const sessionTokens = {
        accessToken: makeJwt(expiredExp),
        idToken: makeJwt(expiredExp),
        refreshToken: 'rt-fail',
      };
      openIdClient.refreshTokenGrant.mockRejectedValueOnce(new Error('invalid_grant'));
      const provider = createOpenIDSessionTokenProvider({
        req: buildReq(sessionTokens),
        user: makeOpenIdUser(),
        tokenPreference: 'access_token',
      });

      await expect(provider()).rejects.toThrow('invalid_grant');
    });

    it('forces a refresh when the caller reports that a live access token was rejected', async () => {
      const farFutureExp = Math.floor(Date.now() / 1000) + 600;
      const sessionTokens = {
        accessToken: makeJwt(farFutureExp),
        idToken: makeJwt(farFutureExp),
        refreshToken: 'rt-force',
      };
      openIdClient.refreshTokenGrant.mockResolvedValueOnce({
        access_token: 'forced-access-token',
        expires_in: 3600,
      });
      const provider = createOpenIDSessionTokenProvider({
        req: buildReq(sessionTokens),
        user: makeOpenIdUser(),
        tokenPreference: 'access_token',
      });

      const result = await provider({ forceRefresh: true });

      expect(openIdClient.refreshTokenGrant).toHaveBeenCalledWith(
        expect.anything(),
        'rt-force',
        expect.anything(),
      );
      expect(result.access_token).toBe('forced-access-token');
    });

    it.each(['complete', 'abort-wait', 'abort-ownership', 'abort-reload'])(
      'handles %s when a forced MCP refresh joins deferred browser publication',
      async (phase) => {
        const farFutureExp = Math.floor(Date.now() / 1000) + 600;
        const tokens = {
          accessToken: makeJwt(farFutureExp),
          idToken: makeJwt(farFutureExp),
          refreshToken: 'rt-deferred-forced',
        };
        const browserReq = buildReq(tokens);
        const mcpReq = buildReq(tokens);
        const controller = new AbortController();
        const reason = new Error('MCP request stopped');
        let finishGrant;
        let publish;
        openIdClient.refreshTokenGrant.mockReturnValueOnce(
          new Promise((resolve) => {
            finishGrant = resolve;
          }),
        );
        waitForOpenIDRefreshFlight.mockReturnValueOnce(
          new Promise((resolve) => {
            publish = resolve;
          }),
        );
        const browser = refreshOpenIDSession(
          browserReq,
          undefined,
          makeOpenIdUser(),
          'access_token',
          undefined,
          { forceRefresh: true, deferPublication: true },
        );
        await Promise.resolve();
        const provider = createOpenIDSessionTokenProvider({
          req: mcpReq,
          user: makeOpenIdUser(),
          tokenPreference: 'access_token',
        });
        const mcp = provider({ forceRefresh: true, signal: controller.signal });
        const outcome = mcp.then(
          (value) => ({ value }),
          (error) => ({ error }),
        );
        await Promise.resolve();
        const refreshed = {
          access_token: makeJwt(farFutureExp + 3600),
          id_token: makeJwt(farFutureExp + 3600),
          refresh_token: 'rt-published',
          expires_in: 3600,
        };
        finishGrant(refreshed);
        await browser;
        for (
          let attempt = 0;
          attempt < 20 && !waitForOpenIDRefreshFlight.mock.calls.length;
          attempt++
        ) {
          await new Promise((resolve) => setImmediate(resolve));
        }
        expect(waitForOpenIDRefreshFlight).toHaveBeenCalledWith({
          key: 'publication:local-id-1:rt-deferred-forced',
          requirePublication: true,
          timeoutMs: 10000,
          intervalMs: 250,
          signal: controller.signal,
        });
        expect(mcpReq.session.save).not.toHaveBeenCalled();
        if (phase === 'abort-wait') controller.abort(reason);
        if (phase === 'abort-ownership') {
          assertOpenIDRefreshFlightAvailable.mockImplementationOnce(async () => {
            controller.abort(reason);
            return true;
          });
        }
        mcpReq.session.reload = jest.fn((callback) => {
          if (phase === 'abort-reload') controller.abort(reason);
          callback();
        });
        publish({ tokenset: refreshed, __flightOwnerId: 'owner-1' });
        if (phase !== 'complete') {
          await expect(outcome).resolves.toEqual({ error: reason });
          expect(mcpReq.session.save).not.toHaveBeenCalled();
          expect(mcpReq.session.openidTokens.refreshToken).toBe('rt-deferred-forced');
          expect(storeOpenIdSession).not.toHaveBeenCalled();
          expect(openIdClient.refreshTokenGrant).toHaveBeenCalledTimes(1);
          if (phase !== 'abort-reload') expect(mcpReq.session.reload).not.toHaveBeenCalled();
          return;
        }
        await expect(mcp).resolves.toMatchObject({
          access_token: refreshed.access_token,
          refresh_token: 'rt-published',
        });
        expect(openIdClient.refreshTokenGrant).toHaveBeenCalledTimes(1);
        expect(mcpReq.session.openidTokens.refreshToken).toBe('rt-published');
        expect(assertOpenIDRefreshFlightAvailable).toHaveBeenCalledWith({
          key: 'publication:local-id-1:rt-deferred-forced',
          ownerId: 'owner-1',
        });
      },
    );

    it('fails an acquired lease when cancelled during acquisition and lets an active joiner proceed', async () => {
      const expiry = Math.floor(Date.now() / 1000) + 3600;
      const tokens = {
        accessToken: makeJwt(expiry),
        idToken: makeJwt(expiry),
        refreshToken: 'rt-cancel-acquisition',
      };
      const leaderReq = buildReq(tokens);
      const joinerReq = buildReq(tokens);
      const controller = new AbortController();
      const reason = new Error('request cancelled during acquisition');
      let finishAcquisition;
      acquireOpenIDRefreshFlight.mockReturnValueOnce(
        new Promise((resolve) => {
          finishAcquisition = resolve;
        }),
      );
      const refreshed = {
        access_token: makeJwt(expiry + 3600),
        refresh_token: 'rt-acquisition-successor',
        expires_in: 3600,
      };
      openIdClient.refreshTokenGrant.mockResolvedValueOnce(refreshed);
      const providerFor = (req) =>
        createOpenIDSessionTokenProvider({
          req,
          user: makeOpenIdUser(),
          tokenPreference: 'access_token',
        });
      const leader = providerFor(leaderReq)({ forceRefresh: true, signal: controller.signal });
      const outcome = leader.then(
        (value) => ({ value }),
        (error) => ({ error }),
      );
      await Promise.resolve();
      const joiner = providerFor(joinerReq)({ forceRefresh: true });
      await Promise.resolve();
      controller.abort(reason);
      finishAcquisition({ acquired: true, ownerId: 'cancelled-owner' });
      await expect(outcome).resolves.toEqual({ error: reason });
      await expect(joiner).resolves.toMatchObject({
        access_token: refreshed.access_token,
        refresh_token: refreshed.refresh_token,
      });
      expect(failOpenIDRefreshFlight).toHaveBeenCalledWith({
        key: 'flight:session-A:rt-cancel-acquisition',
        ownerId: 'cancelled-owner',
        error: new Error('OPENID_REFRESH_CANCELLED_BEFORE_GRANT'),
      });
      expect(leaderReq.session.save).not.toHaveBeenCalled();
      expect(joinerReq.session.save).toHaveBeenCalledTimes(1);
      expect(openIdClient.refreshTokenGrant).toHaveBeenCalledTimes(1);
      expect(failOpenIDRefreshFlight.mock.invocationCallOrder[0]).toBeLessThan(
        openIdClient.refreshTokenGrant.mock.invocationCallOrder[0],
      );
    });

    it('settles a rotating grant that was already admitted before cancellation', async () => {
      const expiry = Math.floor(Date.now() / 1000) + 3600;
      const req = buildReq({
        accessToken: makeJwt(expiry),
        idToken: makeJwt(expiry),
        refreshToken: 'rt-admitted',
      });
      const controller = new AbortController();
      let finishGrant;
      openIdClient.refreshTokenGrant.mockReturnValueOnce(
        new Promise((resolve) => {
          finishGrant = resolve;
        }),
      );
      const provider = createOpenIDSessionTokenProvider({
        req,
        user: makeOpenIdUser(),
        tokenPreference: 'access_token',
      });
      const result = provider({ forceRefresh: true, signal: controller.signal });
      await Promise.resolve();
      expect(openIdClient.refreshTokenGrant).toHaveBeenCalledTimes(1);
      controller.abort(new Error('stopped after admission'));
      finishGrant({ access_token: 'new-access', refresh_token: 'rt-settled', expires_in: 3600 });
      await expect(result).resolves.toMatchObject({ access_token: 'new-access' });
      expect(req.session.openidTokens.refreshToken).toBe('rt-settled');
      expect(completeOpenIDRefreshFlight).toHaveBeenCalled();
      expect(failOpenIDRefreshFlight).not.toHaveBeenCalled();
    });

    it('keeps an active local joiner when a cross-worker publication follower is cancelled', async () => {
      const expiry = Math.floor(Date.now() / 1000) + 3600;
      const tokens = {
        accessToken: makeJwt(expiry),
        idToken: makeJwt(expiry),
        refreshToken: 'rt-publication-cancel',
      };
      const leaderReq = buildReq(tokens);
      const joinerReq = buildReq(tokens);
      const controller = new AbortController();
      const reason = new Error('leader stopped');
      const refreshed = { access_token: 'published-access', refresh_token: 'rt-successor' };
      let enteredPublication;
      const publicationStarted = new Promise((resolve) => {
        enteredPublication = resolve;
      });
      acquireOpenIDRefreshFlight.mockResolvedValue({ acquired: false });
      waitForOpenIDRefreshFlight.mockImplementation(async ({ requirePublication, signal }) => {
        if (!requirePublication) {
          return { ...refreshed, __deferredPublication: true, __flightOwnerId: 'browser-owner' };
        }
        if (signal === controller.signal) {
          enteredPublication();
          return new Promise((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(signal.reason), { once: true });
          });
        }
        return { tokenset: refreshed, __flightOwnerId: 'publication-owner' };
      });
      const providerFor = (req) =>
        createOpenIDSessionTokenProvider({
          req,
          user: makeOpenIdUser(),
          tokenPreference: 'access_token',
        });
      const leader = providerFor(leaderReq)({ forceRefresh: true, signal: controller.signal });
      const outcome = leader.then(
        (value) => ({ value }),
        (error) => ({ error }),
      );
      await publicationStarted;
      const joiner = providerFor(joinerReq)({ forceRefresh: true });
      await Promise.resolve();
      controller.abort(reason);
      await expect(outcome).resolves.toEqual({ error: reason });
      await expect(joiner).resolves.toMatchObject(refreshed);
      expect(leaderReq.session.save).not.toHaveBeenCalled();
      expect(joinerReq.session.openidTokens.refreshToken).toBe('rt-successor');
      expect(joinerReq.session.save).toHaveBeenCalledTimes(1);
      expect(openIdClient.refreshTokenGrant).not.toHaveBeenCalled();
    });

    it('waits for a token-reuse flight before starting a rejection-driven forced refresh', async () => {
      const farFutureExp = Math.floor(Date.now() / 1000) + 600;
      const sessionTokens = {
        accessToken: makeJwt(farFutureExp),
        idToken: makeJwt(farFutureExp),
        refreshToken: 'rt-force-after-reuse',
      };
      let releaseReuse;
      assertOpenIDRefreshSessionGenerationAvailable.mockReturnValueOnce(
        new Promise((resolve) => {
          releaseReuse = resolve;
        }),
      );
      openIdClient.refreshTokenGrant.mockResolvedValueOnce({
        access_token: 'forced-after-reuse',
        expires_in: 3600,
      });
      const provider = createOpenIDSessionTokenProvider({
        req: buildReq(sessionTokens),
        user: makeOpenIdUser(),
        tokenPreference: 'access_token',
      });

      const reuse = provider();
      await Promise.resolve();
      const forced = provider({ forceRefresh: true });
      await Promise.resolve();

      expect(openIdClient.refreshTokenGrant).not.toHaveBeenCalled();
      releaseReuse();
      await expect(reuse).resolves.toEqual(
        expect.objectContaining({ refresh_token: sessionTokens.refreshToken }),
      );
      await expect(forced).resolves.toEqual(
        expect.objectContaining({ access_token: 'forced-after-reuse' }),
      );
      expect(openIdClient.refreshTokenGrant).toHaveBeenCalledTimes(1);
    });
  });

  /**
   * Codex Finding 4: opaque (non-JWT) access tokens make `decodeJwtExp` return
   * null, which would force every OBO call to refresh even when the previous
   * refresh response advertised a still-valid `expires_in`. The fix persists
   * `accessTokenExpiresAt` (unix seconds) on each refresh and uses it as a
   * fallback for the freshness check + `expires_at` derivation.
   */
  describe('opaque access token support (accessTokenExpiresAt fallback)', () => {
    it('reuses live opaque access_token when accessTokenExpiresAt is in the future', async () => {
      const farFutureExp = Math.floor(Date.now() / 1000) + 600;
      const sessionTokens = {
        accessToken: 'opaque-blob-not-a-jwt',
        idToken: makeJwt(farFutureExp),
        refreshToken: 'rt-opaque',
        accessTokenExpiresAt: farFutureExp,
      };
      const req = buildReq(sessionTokens);

      const result = await refreshOpenIDSession(req, undefined, makeOpenIdUser(), 'access_token');

      expect(openIdClient.refreshTokenGrant).not.toHaveBeenCalled();
      expect(result).toEqual({
        access_token: 'opaque-blob-not-a-jwt',
        id_token: sessionTokens.idToken,
        refresh_token: 'rt-opaque',
        expires_at: farFutureExp,
      });
    });

    it('refreshes opaque access_token when accessTokenExpiresAt has passed', async () => {
      const expiredExp = Math.floor(Date.now() / 1000) - 60;
      const refreshedExp = Math.floor(Date.now() / 1000) + 3600;
      const sessionTokens = {
        accessToken: 'opaque-stale',
        idToken: makeJwt(refreshedExp), // id_token still valid
        refreshToken: 'rt-opaque-stale',
        accessTokenExpiresAt: expiredExp,
      };
      openIdClient.refreshTokenGrant.mockResolvedValueOnce({
        access_token: 'opaque-fresh',
        // IdP omits id_token (Auth0 rotation off / MS personal); we use expires_in
        expires_in: 3600,
      });
      const req = buildReq(sessionTokens);

      const result = await refreshOpenIDSession(req, undefined, makeOpenIdUser(), 'access_token');

      expect(openIdClient.refreshTokenGrant).toHaveBeenCalledTimes(1);
      expect(result.access_token).toBe('opaque-fresh');
    });

    it('refreshes opaque access_token when no JWT exp and no accessTokenExpiresAt are present', async () => {
      const refreshedExp = Math.floor(Date.now() / 1000) + 3600;
      const sessionTokens = {
        accessToken: 'opaque-no-expiry',
        idToken: makeJwt(refreshedExp),
        refreshToken: 'rt-no-exp',
        // accessTokenExpiresAt deliberately omitted
      };
      openIdClient.refreshTokenGrant.mockResolvedValueOnce({
        access_token: 'opaque-fresh',
        expires_in: 3600,
      });
      const req = buildReq(sessionTokens);

      await refreshOpenIDSession(req, undefined, makeOpenIdUser(), 'access_token');

      expect(openIdClient.refreshTokenGrant).toHaveBeenCalledTimes(1);
    });

    it('persists accessTokenExpiresAt to req.session.openidTokens after a refresh with expires_in', async () => {
      const expiredExp = Math.floor(Date.now() / 1000) - 60;
      const sessionTokens = {
        accessToken: 'opaque-stale',
        idToken: makeJwt(expiredExp),
        refreshToken: 'rt-persist',
      };
      openIdClient.refreshTokenGrant.mockResolvedValueOnce({
        access_token: 'opaque-fresh',
        expires_in: 3600,
      });
      const req = buildReq(sessionTokens);
      const beforeSec = Math.floor(Date.now() / 1000);

      await refreshOpenIDSession(req, undefined, makeOpenIdUser(), 'access_token');

      const persistedExp = req.session.openidTokens.accessTokenExpiresAt;
      expect(typeof persistedExp).toBe('number');
      expect(persistedExp).toBeGreaterThanOrEqual(beforeSec + 3590);
      expect(persistedExp).toBeLessThanOrEqual(beforeSec + 3610);
    });

    it('persists accessTokenExpiresAt when the refreshed expires_in is a numeric string', async () => {
      const expiredExp = Math.floor(Date.now() / 1000) - 60;
      const sessionTokens = {
        accessToken: 'opaque-stale',
        idToken: makeJwt(expiredExp),
        refreshToken: 'rt-string-expiry',
      };
      openIdClient.refreshTokenGrant.mockResolvedValueOnce({
        access_token: 'opaque-fresh',
        expires_in: '3600',
      });
      const req = buildReq(sessionTokens);
      const beforeSec = Math.floor(Date.now() / 1000);

      await refreshOpenIDSession(req, undefined, makeOpenIdUser(), 'access_token');

      expect(req.session.openidTokens.accessTokenExpiresAt).toBeGreaterThanOrEqual(
        beforeSec + 3590,
      );
    });

    it('does not roll an advanced session backward with a stale completed flight', async () => {
      const expiredExp = Math.floor(Date.now() / 1000) - 60;
      const advancedExp = Math.floor(Date.now() / 1000) + 3600;
      const req = buildReq(
        {
          accessToken: makeJwt(expiredExp),
          idToken: makeJwt(expiredExp),
          refreshToken: 'rt-predecessor',
        },
        'session-stale-follower',
      );
      req.session.reload = jest.fn((callback) => {
        req.session.openidTokens = withSessionIdentity({
          accessToken: makeJwt(advancedExp),
          idToken: makeJwt(advancedExp),
          refreshToken: 'rt-advanced',
          accessTokenExpiresAt: advancedExp,
          publicationFlightKey: 'advanced-publication-key',
          publicationFlightOwnerId: 'advanced-publication-owner',
        });
        callback();
      });
      acquireOpenIDRefreshFlight.mockResolvedValueOnce({ acquired: false, ownerId: 'other' });
      const staleResult = {
        access_token: makeJwt(advancedExp - 60),
        id_token: makeJwt(advancedExp - 60),
        refresh_token: 'rt-stale-result',
        expires_at: advancedExp - 60,
      };
      Object.defineProperty(staleResult, '__predecessorRefreshToken', {
        value: 'rt-predecessor',
        enumerable: false,
      });
      Object.defineProperty(staleResult, '__flightOwnerId', {
        value: 'stale-publication-owner',
        enumerable: false,
      });
      waitForOpenIDRefreshFlight.mockResolvedValueOnce(staleResult);

      await refreshOpenIDSession(req, undefined, makeOpenIdUser(), 'access_token');

      expect(req.session.reload).toHaveBeenCalled();
      expect(req.session.openidTokens.refreshToken).toBe('rt-advanced');
      expect(assertOpenIDRefreshSessionGenerationAvailable).toHaveBeenCalledWith({
        key: 'advanced-publication-key',
        ownerId: 'advanced-publication-owner',
      });
      expect(storeRefreshTokenBridge).not.toHaveBeenCalled();
      expect(storeOpenIdSession).not.toHaveBeenCalled();
      expect(setRefreshTokenCookie).not.toHaveBeenCalled();
      expect(req.session.save).not.toHaveBeenCalled();
    });

    it('keeps the newer generation when stale and current flights contain identical token strings', async () => {
      const expiredExp = Math.floor(Date.now() / 1000) - 60;
      const liveExp = Math.floor(Date.now() / 1000) + 3600;
      const req = buildReq(
        {
          accessToken: makeJwt(expiredExp),
          idToken: makeJwt(expiredExp),
          refreshToken: 'rt-stable',
        },
        'session-identical-generations',
      );
      req.session.reload = jest.fn((callback) => {
        req.session.openidTokens = withSessionIdentity({
          accessToken: 'identical-access',
          idToken: 'identical-id',
          refreshToken: 'rt-stable',
          accessTokenExpiresAt: liveExp,
          publicationFlightKey: 'newer-publication-key',
          publicationFlightOwnerId: 'newer-publication-owner',
          publicationFlightCreatedAt: 2000,
        });
        callback();
      });
      acquireOpenIDRefreshFlight.mockResolvedValueOnce({ acquired: false, ownerId: 'other' });
      const staleResult = {
        access_token: 'identical-access',
        id_token: 'identical-id',
        refresh_token: 'rt-stable',
        expires_at: liveExp,
      };
      Object.defineProperty(staleResult, '__predecessorRefreshToken', {
        value: 'rt-stable',
        enumerable: false,
      });
      Object.defineProperty(staleResult, '__flightOwnerId', {
        value: 'stale-publication-owner',
        enumerable: false,
      });
      Object.defineProperty(staleResult, '__flightCreatedAt', {
        value: 1000,
        enumerable: false,
      });
      waitForOpenIDRefreshFlight.mockResolvedValueOnce(staleResult);

      await refreshOpenIDSession(req, undefined, makeOpenIdUser(), 'access_token');

      expect(req.session.openidTokens).toEqual(
        expect.objectContaining({
          accessToken: 'identical-access',
          refreshToken: 'rt-stable',
          publicationFlightKey: 'newer-publication-key',
          publicationFlightOwnerId: 'newer-publication-owner',
          publicationFlightCreatedAt: 2000,
        }),
      );
      expect(req.session.save).not.toHaveBeenCalled();
    });

    it('drops a stale accessTokenExpiresAt when the new tokenset has neither expires_in nor a JWT access_token', async () => {
      const expiredExp = Math.floor(Date.now() / 1000) - 60;
      const sessionTokens = {
        accessToken: 'opaque-old',
        idToken: makeJwt(expiredExp),
        refreshToken: 'rt-drop',
        accessTokenExpiresAt: expiredExp, // stale carry-over
      };
      openIdClient.refreshTokenGrant.mockResolvedValueOnce({
        access_token: 'opaque-fresh-no-meta',
        // no expires_in, no JWT access_token, no id_token
      });
      const req = buildReq(sessionTokens);

      await refreshOpenIDSession(req, undefined, makeOpenIdUser(), 'access_token');

      expect(req.session.openidTokens).not.toHaveProperty('accessTokenExpiresAt');
    });

    it('getAccessTokenExp prefers JWT exp over the persisted accessTokenExpiresAt', () => {
      const jwtExp = Math.floor(Date.now() / 1000) + 600;
      const persistedExp = Math.floor(Date.now() / 1000) - 60; // stale
      const result = __internals.getAccessTokenExp({
        accessToken: makeJwt(jwtExp),
        accessTokenExpiresAt: persistedExp,
      });
      expect(result).toBe(jwtExp);
    });

    it('getAccessTokenExp returns null when neither a decodable JWT nor a persisted expiry is present', () => {
      const result = __internals.getAccessTokenExp({
        accessToken: 'opaque',
      });
      expect(result).toBeNull();
    });

    /**
     * Codex Finding 6: id_token TTL is governed by IdP session policy and is
     * often longer than access-token TTL. Trusting it as access-token expiry
     * would mark an opaque access token reusable past its real lifetime,
     * sending an expired credential to the OBO IdP. The fallback chain must
     * be expires_in → JWT access_token exp → unset (NOT id_token exp).
     */
    it('does NOT fall back to id_token exp for accessTokenExpiresAt when expires_in is missing', async () => {
      const longLivedIdTokenExp = Math.floor(Date.now() / 1000) + 86400; // 24h
      const sessionTokens = {
        accessToken: 'opaque-old',
        idToken: makeJwt(Math.floor(Date.now() / 1000) - 60),
        refreshToken: 'rt-no-fallback',
      };
      openIdClient.refreshTokenGrant.mockResolvedValueOnce({
        access_token: 'opaque-fresh', // opaque, NOT a JWT
        id_token: makeJwt(longLivedIdTokenExp), // long-lived id_token
        // no expires_in
      });
      const req = buildReq(sessionTokens);

      await refreshOpenIDSession(req, undefined, makeOpenIdUser(), 'access_token');

      // The long-lived id_token exp must NOT have been borrowed for the access token.
      expect(req.session.openidTokens).not.toHaveProperty('accessTokenExpiresAt');
    });

    it('falls back to JWT access_token exp for accessTokenExpiresAt when expires_in is missing', async () => {
      const accessExp = Math.floor(Date.now() / 1000) + 1800; // 30min
      const sessionTokens = {
        accessToken: 'opaque-old',
        idToken: makeJwt(Math.floor(Date.now() / 1000) - 60),
        refreshToken: 'rt-jwt-access',
      };
      openIdClient.refreshTokenGrant.mockResolvedValueOnce({
        access_token: makeJwt(accessExp), // JWT access token
        id_token: makeJwt(Math.floor(Date.now() / 1000) + 86400), // long-lived; should NOT win
        // no expires_in
      });
      const req = buildReq(sessionTokens);

      await refreshOpenIDSession(req, undefined, makeOpenIdUser(), 'access_token');

      // accessTokenExpiresAt comes from the access token's own JWT exp, not the id_token.
      expect(req.session.openidTokens.accessTokenExpiresAt).toBe(accessExp);
    });
  });
});
