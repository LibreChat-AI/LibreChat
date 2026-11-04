const { SystemRoles } = require('librechat-data-provider');

let capturedVerifyCallback;
let capturedStrategyOptions;
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

const mockGetTenantId = jest.fn(() => undefined);
jest.mock('@librechat/data-schemas', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() },
  runAsSystem: mockRunAsSystem,
  getTenantId: mockGetTenantId,
  isOpenIDSessionDenied: jest.requireActual('@librechat/data-schemas').isOpenIDSessionDenied,
}));

jest.mock('@librechat/api', () => ({
  AGENT_TRIGGER_SCOPE: 'agent_trigger',
  loadJwtUser: jest.requireActual('@librechat/api').loadJwtUser,
  getAuthUserDocCacheMode: () => 'off',
  isTokenRetired: jest.requireActual('@librechat/api').isTokenRetired,
  continueAfterBearerRetirement: jest.requireActual('@librechat/api').continueAfterBearerRetirement,
  applyOpenIDSessionIdClaim: jest.requireActual('@librechat/api').applyOpenIDSessionIdClaim,
  prefetchOpenIDBearerContext: jest.requireActual('@librechat/api').prefetchOpenIDBearerContext,
  resolveOpenIDLibreChatBearerVerdict:
    jest.requireActual('@librechat/api').resolveOpenIDLibreChatBearerVerdict,
  toOpenIDBearerPassportResult: jest.requireActual('@librechat/api').toOpenIDBearerPassportResult,
  createOpenIDSessionsRuntime: jest.requireActual('@librechat/api').createOpenIDSessionsRuntime,
}));

jest.mock('~/models', () => ({
  getUserById: jest.fn(),
  updateUser: jest.fn(),
}));

jest.mock('~/cache/getLogStores', () => jest.fn());

const jwtLogin = require('./jwtStrategy');
const { getUserById, updateUser } = require('~/models');
const openIdSessions = require('~/server/services/OpenIDSessions');

/** `sessionAuthorizationRef` is the live object the strategy reads per request; tests that turn
 *  enforcement on must not leak it into the rest of the suite, which otherwise assumes it off. */
afterEach(() => {
  for (const key of Object.keys(openIdSessions.sessionAuthorizationRef)) {
    delete openIdSessions.sessionAuthorizationRef[key];
  }
});

function request(overrides = {}) {
  return {
    method: 'GET',
    originalUrl: '/api/user',
    headers: {},
    ...overrides,
  };
}

function invokeVerify(payload, req = request()) {
  return new Promise((resolve, reject) => {
    capturedVerifyCallback(req, payload, (err, user, info) => {
      if (err) {
        return reject(err);
      }
      resolve({ user, info });
    });
  });
}

describe('jwtStrategy', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    updateUser.mockResolvedValue({});
    jwtLogin();
  });

  it('coerces missing idOnTheSource to null for local users', async () => {
    getUserById.mockResolvedValue({
      _id: { toString: () => 'user-1' },
      role: SystemRoles.USER,
    });

    const { user } = await invokeVerify({ id: 'user-1' });

    expect(user.id).toBe('user-1');
    expect(user.idOnTheSource).toBeNull();
    expect(capturedStrategyOptions.passReqToCallback).toBe(true);
  });

  it('runs globally scoped authentication reads and writes in system context', async () => {
    getUserById.mockResolvedValue({
      _id: { toString: () => 'user-system' },
    });

    const { user } = await invokeVerify({ id: 'user-system' });

    expect(user).toMatchObject({ id: 'user-system', role: SystemRoles.USER });
    expect(mockRunAsSystem).toHaveBeenCalledTimes(2);
    expect(getUserById).toHaveBeenCalledWith(
      'user-system',
      '-password -__v -totpSecret -backupCodes +agentTriggerDeletionStartedAt',
    );
    expect(updateUser).toHaveBeenCalledWith('user-system', { role: SystemRoles.USER });
  });

  it('preserves a stored idOnTheSource for federated users', async () => {
    getUserById.mockResolvedValue({
      _id: { toString: () => 'user-2' },
      role: SystemRoles.USER,
      idOnTheSource: 'entra-oid-123',
    });

    const { user } = await invokeVerify({ id: 'user-2' });

    expect(user.idOnTheSource).toBe('entra-oid-123');
  });

  it('returns false when no user is found', async () => {
    getUserById.mockResolvedValue(null);

    const { user } = await invokeVerify({ id: 'missing' });

    expect(user).toBe(false);
  });

  it('accepts a scoped trigger token only on an exact marked admission route', async () => {
    getUserById.mockResolvedValue({
      _id: { toString: () => 'user-3' },
      role: SystemRoles.USER,
    });

    const { user } = await invokeVerify(
      { id: 'user-3', scope: 'agent_trigger' },
      request({
        method: 'POST',
        originalUrl: '/trusted/base/api/agents/chat/agents?source=delivery',
        headers: { 'x-lc-agent-trigger': '1' },
      }),
    );

    expect(user.id).toBe('user-3');
  });

  it.each([
    ['an unrelated route', request({ method: 'POST', originalUrl: '/api/user' })],
    [
      'a missing transport marker',
      request({ method: 'POST', originalUrl: '/api/agents/chat/agents' }),
    ],
    [
      'a non-POST request',
      request({
        method: 'GET',
        originalUrl: '/api/agents/chat/steer/deliver',
        headers: { 'x-lc-agent-trigger': '1' },
      }),
    ],
  ])('rejects a scoped trigger token on %s', async (_label, req) => {
    const { user, info } = await invokeVerify({ id: 'user-3', scope: 'agent_trigger' }, req);

    expect(user).toBe(false);
    expect(info).toEqual({ message: 'Agent trigger token is not valid for this endpoint' });
    expect(getUserById).not.toHaveBeenCalled();
  });

  it('rejects ordinary and trigger-scoped tokens while account deletion is fenced', async () => {
    getUserById.mockResolvedValue({
      _id: { toString: () => 'user-3' },
      role: SystemRoles.USER,
      agentTriggerDeletionStartedAt: new Date('2026-08-17T12:00:00.000Z'),
    });

    const ordinary = await invokeVerify({ id: 'user-3' });
    const trigger = await invokeVerify(
      { id: 'user-3', scope: 'agent_trigger' },
      request({
        method: 'POST',
        originalUrl: '/api/agents/chat/steer/deliver',
        headers: { 'x-lc-agent-trigger': '1' },
      }),
    );

    expect(ordinary).toEqual({
      user: false,
      info: {
        message: 'Account deletion is in progress',
        code: 'ACCOUNT_DELETION_IN_PROGRESS',
      },
    });
    expect(trigger).toEqual({
      user: false,
      info: {
        message: 'Account deletion is in progress',
        code: 'ACCOUNT_DELETION_IN_PROGRESS',
      },
    });
    expect(getUserById).toHaveBeenCalledWith(
      'user-3',
      '-password -__v -totpSecret -backupCodes +agentTriggerDeletionStartedAt',
    );
  });

  describe('credentialsChangedAt revocation', () => {
    /** Reset landed 500ms into second 1700000010 */
    const credentialsChangedAt = new Date(1700000010500);

    const mockUserWithStamp = (stamp) => {
      getUserById.mockResolvedValue({
        _id: { toString: () => 'user-reset' },
        role: SystemRoles.USER,
        credentialsChangedAt: stamp,
      });
    };

    it('rejects an access token issued before the password reset', async () => {
      mockUserWithStamp(credentialsChangedAt);

      const { user } = await invokeVerify({ id: 'user-reset', iat: 1700000009 });

      expect(user).toBe(false);
    });

    it('accepts an access token issued after the password reset', async () => {
      mockUserWithStamp(credentialsChangedAt);

      const { user } = await invokeVerify({ id: 'user-reset', iat: 1700000011 });

      expect(user.id).toBe('user-reset');
    });

    it('rejects a token whose issuing second started before the reset instant', async () => {
      mockUserWithStamp(credentialsChangedAt);

      const { user } = await invokeVerify({ id: 'user-reset', iat: 1700000010 });

      expect(user).toBe(false);
    });

    it('rejects a token issued in the same second as a reset stamped on the second boundary', async () => {
      mockUserWithStamp(new Date(1700000010000));

      const { user } = await invokeVerify({ id: 'user-reset', iat: 1700000010 });

      expect(user).toBe(false);
    });

    it('accepts a token dated after a boundary reset to the millisecond', async () => {
      mockUserWithStamp(new Date(1700000010000));

      const { user } = await invokeVerify({
        id: 'user-reset',
        iat: 1700000010,
        issuedAtMs: 1700000010001,
      });

      expect(user.id).toBe('user-reset');
    });

    it('accepts a stale token when the user never changed credentials', async () => {
      getUserById.mockResolvedValue({
        _id: { toString: () => 'user-1' },
        role: SystemRoles.USER,
      });

      const { user } = await invokeVerify({ id: 'user-1', iat: 1 });

      expect(user.id).toBe('user-1');
    });

    it('rejects a token without iat once credentials have changed', async () => {
      mockUserWithStamp(credentialsChangedAt);

      const { user } = await invokeVerify({ id: 'user-reset' });

      expect(user).toBe(false);
    });

    it('honors a stamp deserialized as a string', async () => {
      mockUserWithStamp(credentialsChangedAt.toISOString());

      const { user } = await invokeVerify({ id: 'user-reset', iat: 1700000009 });

      expect(user).toBe(false);
    });
  });

  describe('two-factor enrollment cutoff', () => {
    const enrolledAt = new Date('2026-01-01T00:00:10.500Z');
    const enrolledSecond = Math.floor(enrolledAt.getTime() / 1000);

    const mockEnrolledUser = () =>
      getUserById.mockResolvedValue({
        _id: { toString: () => 'user-3' },
        role: SystemRoles.USER,
        twoFactorEnabled: true,
        twoFactorEnrolledAt: enrolledAt,
      });

    it('refuses an access token minted before enrollment', async () => {
      mockEnrolledUser();

      const { user } = await invokeVerify({ id: 'user-3', iat: enrolledSecond - 1 });

      expect(user).toBe(false);
    });

    it('refuses an access token minted before a password reset', async () => {
      getUserById.mockResolvedValue({
        _id: { toString: () => 'user-3' },
        role: SystemRoles.USER,
        twoFactorEnrolledAt: null,
        credentialsChangedAt: enrolledAt,
      });

      const { user } = await invokeVerify({ id: 'user-3', iat: enrolledSecond - 1 });

      expect(user).toBe(false);
    });

    it('accepts an access token minted after a password reset', async () => {
      getUserById.mockResolvedValue({
        _id: { toString: () => 'user-3' },
        role: SystemRoles.USER,
        twoFactorEnrolledAt: null,
        credentialsChangedAt: enrolledAt,
      });

      const { user } = await invokeVerify({ id: 'user-3', iat: enrolledSecond + 60 });

      expect(user.id).toBe('user-3');
    });

    it('accepts the session minted within the enrolling second', async () => {
      mockEnrolledUser();

      const { user } = await invokeVerify({ id: 'user-3', iat: enrolledSecond });

      expect(user.id).toBe('user-3');
    });

    it('accepts an access token minted after enrollment', async () => {
      mockEnrolledUser();

      const { user } = await invokeVerify({ id: 'user-3', iat: enrolledSecond + 60 });

      expect(user.id).toBe('user-3');
    });

    it('refuses an undatable token once the account is enrolled', async () => {
      mockEnrolledUser();

      const { user } = await invokeVerify({ id: 'user-3' });

      expect(user).toBe(false);
    });

    it('leaves accounts that never enrolled untouched', async () => {
      getUserById.mockResolvedValue({
        _id: { toString: () => 'user-4' },
        role: SystemRoles.USER,
        twoFactorEnrolledAt: null,
      });

      const { user } = await invokeVerify({ id: 'user-4', iat: 0 });

      expect(user.id).toBe('user-4');
    });
  });

  describe('OpenID session authorization for LibreChat-signed bearers', () => {
    const openidUser = {
      _id: { toString: () => 'user-openid' },
      role: SystemRoles.USER,
      provider: 'openid',
      openidId: 'oidc-123',
      openidIssuer: 'https://issuer.example.com',
      tenantId: 'tenant-1',
    };
    const liveSession = {
      subject: 'oidc-123',
      issuer: openidUser.openidIssuer,
      clientId: 'test-client',
      revokedAt: null,
      firstLoginIat: null,
    };
    const originalClientId = process.env.OPENID_CLIENT_ID;

    beforeEach(() => {
      process.env.OPENID_CLIENT_ID = 'test-client';
    });

    afterAll(() => {
      process.env.OPENID_CLIENT_ID = originalClientId;
    });

    /** Turns on the live enforcement switch the strategy reads per request; the outer
     *  `afterEach` clears it after every test so the rest of the suite stays unenforced. */
    function enforceWith(authorization) {
      Object.assign(openIdSessions.sessionAuthorizationRef, {
        enforcement: true,
        timeoutMs: 50,
        cache: { get: () => undefined, set: () => {} },
        authorization,
      });
    }

    it('skips the check entirely for a bearer with no openidSessionId claim (local user)', async () => {
      getUserById.mockResolvedValue({
        _id: { toString: () => 'user-local' },
        role: SystemRoles.USER,
      });
      enforceWith({
        findOpenIDSessionById: jest.fn(),
        findOpenIDSubject: jest.fn(),
        findOpenIDBinding: jest.fn(),
      });

      const { user } = await invokeVerify({ id: 'user-local' });

      expect(user.id).toBe('user-local');
    });

    it('denies an OpenID-backed bearer with no openidSessionId claim once enforcement is on', async () => {
      getUserById.mockResolvedValue(openidUser);
      enforceWith({
        findOpenIDSessionById: jest.fn(),
        findOpenIDSubject: jest.fn(),
        findOpenIDBinding: jest.fn(),
      });

      const { user, info } = await invokeVerify({ id: 'user-openid' });

      expect(user).toBe(false);
      expect(info).toEqual(
        expect.objectContaining({
          message: 'OpenID session authorization denied',
          code: 'unknown_session',
        }),
      );
    });

    it('authorizes a bearer whose openidSessionId resolves to a live, bound session', async () => {
      getUserById.mockResolvedValue(openidUser);
      enforceWith({
        findOpenIDSessionById: jest.fn().mockResolvedValue(liveSession),
        findOpenIDSubject: jest.fn().mockResolvedValue(null),
        findOpenIDBinding: jest.fn().mockResolvedValue({ _id: 'binding-1' }),
      });

      const { user } = await invokeVerify({ id: 'user-openid', openidSessionId: 'session-1' });

      expect(user.id).toBe('user-openid');
      expect(user.openidSessionId).toBe('session-1');
    });

    it('does not set openidSessionId on the user object when the bearer carries none', async () => {
      getUserById.mockResolvedValue({
        _id: { toString: () => 'user-local' },
        role: SystemRoles.USER,
      });
      enforceWith({
        findOpenIDSessionById: jest.fn(),
        findOpenIDSubject: jest.fn(),
        findOpenIDBinding: jest.fn(),
      });

      const { user } = await invokeVerify({ id: 'user-local' });

      expect(user.openidSessionId).toBeUndefined();
    });

    it('denies a bearer whose openidSessionId was revoked', async () => {
      getUserById.mockResolvedValue(openidUser);
      enforceWith({
        findOpenIDSessionById: jest
          .fn()
          .mockResolvedValue({ ...liveSession, revokedAt: new Date() }),
        findOpenIDSubject: jest.fn().mockResolvedValue(null),
        findOpenIDBinding: jest.fn().mockResolvedValue({ _id: 'binding-1' }),
      });

      const { user, info } = await invokeVerify({
        id: 'user-openid',
        openidSessionId: 'session-1',
      });

      expect(user).toBe(false);
      expect(info).toEqual(
        expect.objectContaining({ message: 'OpenID session authorization denied', code: 'denied' }),
      );
    });

    it('denies a bearer with no live binding for this user and tenant', async () => {
      getUserById.mockResolvedValue(openidUser);
      enforceWith({
        findOpenIDSessionById: jest.fn().mockResolvedValue(liveSession),
        findOpenIDSubject: jest.fn().mockResolvedValue(null),
        findOpenIDBinding: jest.fn().mockResolvedValue(null),
      });

      const { info } = await invokeVerify({ id: 'user-openid', openidSessionId: 'session-1' });

      expect(info.code).toBe('no_binding');
    });

    it('denies on an issuer mismatch between the stored session and the user record', async () => {
      getUserById.mockResolvedValue(openidUser);
      enforceWith({
        findOpenIDSessionById: jest
          .fn()
          .mockResolvedValue({ ...liveSession, issuer: 'https://attacker.example/' }),
        findOpenIDSubject: jest.fn().mockResolvedValue(null),
        findOpenIDBinding: jest.fn().mockResolvedValue({ _id: 'binding-1' }),
      });

      const { info } = await invokeVerify({ id: 'user-openid', openidSessionId: 'session-1' });

      expect(info.code).toBe('identity_mismatch');
    });

    it('surfaces an unavailable error when the authorization store cannot be read', async () => {
      getUserById.mockResolvedValue(openidUser);
      enforceWith({
        findOpenIDSessionById: jest.fn().mockRejectedValue(new Error('timeout')),
        findOpenIDSubject: jest.fn().mockResolvedValue(null),
        findOpenIDBinding: jest.fn(),
      });

      await expect(
        invokeVerify({ id: 'user-openid', openidSessionId: 'session-1' }),
      ).rejects.toEqual(
        expect.objectContaining({ code: 'OPENID_SESSION_AUTHORIZATION_UNAVAILABLE' }),
      );
    });

    it('uses the user record tenantId, not a global tenant context, to authorize the binding', async () => {
      getUserById.mockResolvedValue({ ...openidUser, tenantId: 'tenant-from-user' });
      let seenTenantId;
      enforceWith({
        findOpenIDSessionById: jest.fn().mockResolvedValue(liveSession),
        findOpenIDSubject: jest.fn().mockResolvedValue(null),
        findOpenIDBinding: jest.fn().mockImplementation(({ tenantId }) => {
          seenTenantId = tenantId;
          return Promise.resolve({ _id: 'binding-1' });
        }),
      });

      const { user } = await invokeVerify({ id: 'user-openid', openidSessionId: 'session-1' });

      expect(user.id).toBe('user-openid');
      expect(seenTenantId).toBe('tenant-from-user');
    });

    it('denies when a signed tenantId claim does not match the loaded user', async () => {
      getUserById.mockResolvedValue(openidUser);
      enforceWith({
        findOpenIDSessionById: jest.fn(),
        findOpenIDSubject: jest.fn(),
        findOpenIDBinding: jest.fn(),
      });

      const { user, info } = await invokeVerify({
        id: 'user-openid',
        openidSessionId: 'session-1',
        tenantId: 'tenant-other',
      });

      expect(user).toBe(false);
      expect(info).toEqual(
        expect.objectContaining({
          message: 'OpenID session authorization denied',
          code: 'identity_mismatch',
        }),
      );
    });

    it('does not reject a mismatched tenantId claim while enforcement is off', async () => {
      getUserById.mockResolvedValue(openidUser);

      const { user } = await invokeVerify({
        id: 'user-openid',
        openidSessionId: 'session-1',
        tenantId: 'tenant-other',
      });

      expect(user.id).toBe('user-openid');
    });

    it('accepts a signed tenantId claim that matches the loaded user, and prefetches the session read', async () => {
      getUserById.mockResolvedValue(openidUser);
      const findOpenIDSessionById = jest.fn().mockResolvedValue(liveSession);
      enforceWith({
        findOpenIDSessionById,
        findOpenIDSubject: jest.fn().mockResolvedValue(null),
        findOpenIDBinding: jest.fn().mockResolvedValue({ _id: 'binding-1' }),
      });

      const { user } = await invokeVerify({
        id: 'user-openid',
        openidSessionId: 'session-1',
        tenantId: 'tenant-1',
      });

      expect(user.id).toBe('user-openid');
      // Prefetched once alongside the user load, then reused by authorizeOpenIDSession.
      expect(findOpenIDSessionById).toHaveBeenCalledTimes(1);
    });
  });
});
