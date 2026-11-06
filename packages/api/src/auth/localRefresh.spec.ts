import jwt from 'jsonwebtoken';
import type { Response } from 'express';
import type { ProviderSessionAuthorizeOutcome } from './openid/providerSession';
import { ProviderSessionUnavailableError } from './openid/providerSession';
import { createLocalRefreshHandler } from './localRefresh';

const JWT_REFRESH_SECRET = 'refresh-secret';

function signRefreshToken(userId: string, issuedAtMs = Date.now()): string {
  return jwt.sign({ id: userId, issuedAtMs }, JWT_REFRESH_SECRET);
}

function buildRes(): Response {
  const res = {} as Response;
  res.status = jest.fn().mockReturnValue(res);
  res.send = jest.fn().mockReturnValue(res);
  res.redirect = jest.fn().mockReturnValue(res);
  res.clearCookie = jest.fn().mockReturnValue(res);
  return res;
}

function buildDeps(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    userProjection: 'projection',
    getUserById: jest.fn(),
    findSession: jest.fn(),
    setAuthTokens: jest.fn().mockResolvedValue('new-token'),
    authorizeProviderSession: jest.fn(),
    deleteSession: jest.fn().mockResolvedValue({ deletedCount: 1 }),
    deleteAllUserSessions: jest.fn(),
    clearCloudFrontCookies: jest.fn(),
    isTwoFactorEnrollmentRequired: jest.fn().mockReturnValue(false),
    warn: jest.fn(),
    error: jest.fn(),
    ...overrides,
  };
}

const USER_ID = 'user-123';
const SESSION_ID = 'session-123';

describe('createLocalRefreshHandler provider-session recheck', () => {
  const originalSecret = process.env.JWT_REFRESH_SECRET;
  const originalNodeEnv = process.env.NODE_ENV;

  beforeEach(() => {
    process.env.JWT_REFRESH_SECRET = JWT_REFRESH_SECRET;
    process.env.NODE_ENV = 'test';
  });

  afterAll(() => {
    process.env.JWT_REFRESH_SECRET = originalSecret;
    process.env.NODE_ENV = originalNodeEnv;
  });

  it('rotates the credential once the provider session authorizes it', async () => {
    const refreshToken = signRefreshToken(USER_ID);
    const deps = buildDeps({
      getUserById: jest.fn().mockResolvedValue({ _id: USER_ID, provider: 'openid' }),
      findSession: jest.fn().mockResolvedValue({
        _id: SESSION_ID,
        expiration: new Date(Date.now() + 60_000),
        providerSession: {
          issuer: 'https://issuer.example.com',
          clientId: 'client-1',
          sid: 'sid-1',
        },
      }),
      authorizeProviderSession: jest
        .fn()
        .mockResolvedValue({ ok: true } satisfies ProviderSessionAuthorizeOutcome),
    });
    const handler = createLocalRefreshHandler(deps as never);
    const res = buildRes();

    await handler({ query: {} } as never, res, refreshToken);

    expect(deps.authorizeProviderSession).toHaveBeenCalledWith({
      ref: { issuer: 'https://issuer.example.com', clientId: 'client-1', sid: 'sid-1' },
      expiresAt: expect.any(Date),
      legacy: false,
    });
    expect(deps.setAuthTokens).toHaveBeenCalledWith(
      USER_ID,
      res,
      expect.objectContaining({ _id: SESSION_ID }),
      expect.anything(),
    );
    expect(deps.deleteSession).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.send).toHaveBeenCalledWith(expect.objectContaining({ token: 'new-token' }));
  });

  it('denies the refresh, deletes only the session, and leaves auth cookies untouched', async () => {
    const refreshToken = signRefreshToken(USER_ID);
    const deps = buildDeps({
      getUserById: jest.fn().mockResolvedValue({ _id: USER_ID, provider: 'openid' }),
      findSession: jest.fn().mockResolvedValue({
        _id: SESSION_ID,
        expiration: new Date(Date.now() + 60_000),
        providerSession: {
          issuer: 'https://issuer.example.com',
          clientId: 'client-1',
          sid: 'sid-1',
        },
      }),
      authorizeProviderSession: jest.fn().mockResolvedValue({
        ok: false,
        code: 'OPENID_SESSION_ENDED',
      } satisfies ProviderSessionAuthorizeOutcome),
    });
    const handler = createLocalRefreshHandler(deps as never);
    const res = buildRes();

    await handler({ query: {} } as never, res, refreshToken);

    expect(deps.deleteSession).toHaveBeenCalledWith({ sessionId: SESSION_ID });
    expect(deps.setAuthTokens).not.toHaveBeenCalled();
    expect(deps.clearCloudFrontCookies).not.toHaveBeenCalled();
    /** A denial must not clear any auth cookie, including the session hint: the same
     *  cross-account race that keeps `setAuthTokens` from running on this path. */
    expect(res.clearCookie).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.send).toHaveBeenCalledWith({ code: 'OPENID_SESSION_ENDED' });
  });

  it('denies an ended provider session before 2FA enrollment can mint a setup token', async () => {
    const refreshToken = signRefreshToken(USER_ID);
    const deps = buildDeps({
      getUserById: jest.fn().mockResolvedValue({ _id: USER_ID, provider: 'openid' }),
      findSession: jest.fn().mockResolvedValue({
        _id: SESSION_ID,
        expiration: new Date(Date.now() + 60_000),
        providerSession: {
          issuer: 'https://issuer.example.com',
          clientId: 'client-1',
          sid: 'sid-1',
        },
      }),
      isTwoFactorEnrollmentRequired: jest.fn().mockReturnValue(true),
      authorizeProviderSession: jest.fn().mockResolvedValue({
        ok: false,
        code: 'OPENID_SESSION_ENDED',
      } satisfies ProviderSessionAuthorizeOutcome),
    });
    const handler = createLocalRefreshHandler(deps as never);
    const res = buildRes();

    await handler({ query: {} } as never, res, refreshToken);

    expect(deps.deleteSession).toHaveBeenCalledWith({ sessionId: SESSION_ID });
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.send).toHaveBeenCalledWith({ code: 'OPENID_SESSION_ENDED' });
    expect(res.send).not.toHaveBeenCalledWith(
      expect.objectContaining({ twoFASetupRequired: true }),
    );
    expect(deps.clearCloudFrontCookies).not.toHaveBeenCalled();
  });

  it('answers 503 and clears nothing when the provider-session check is unavailable', async () => {
    const refreshToken = signRefreshToken(USER_ID);
    const deps = buildDeps({
      getUserById: jest.fn().mockResolvedValue({ _id: USER_ID, provider: 'openid' }),
      findSession: jest.fn().mockResolvedValue({
        _id: SESSION_ID,
        expiration: new Date(Date.now() + 60_000),
        providerSession: {
          issuer: 'https://issuer.example.com',
          clientId: 'client-1',
          sid: 'sid-1',
        },
      }),
      authorizeProviderSession: jest
        .fn()
        .mockRejectedValue(new ProviderSessionUnavailableError('unavailable')),
    });
    const handler = createLocalRefreshHandler(deps as never);
    const res = buildRes();

    await handler({ query: {} } as never, res, refreshToken);

    expect(deps.deleteSession).not.toHaveBeenCalled();
    expect(deps.setAuthTokens).not.toHaveBeenCalled();
    expect(res.clearCookie).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.send).toHaveBeenCalledWith({ code: 'AUTH_SESSION_CHECK_UNAVAILABLE' });
  });

  it('re-throws an error the authorizer did not mark as an unavailable check', async () => {
    const refreshToken = signRefreshToken(USER_ID);
    const deps = buildDeps({
      getUserById: jest.fn().mockResolvedValue({ _id: USER_ID, provider: 'openid' }),
      findSession: jest.fn().mockResolvedValue({
        _id: SESSION_ID,
        expiration: new Date(Date.now() + 60_000),
        providerSession: {
          issuer: 'https://issuer.example.com',
          clientId: 'client-1',
          sid: 'sid-1',
        },
      }),
      authorizeProviderSession: jest.fn().mockRejectedValue(new Error('boom')),
    });
    const handler = createLocalRefreshHandler(deps as never);
    const res = buildRes();

    await handler({ query: {} } as never, res, refreshToken);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.send).toHaveBeenCalledWith('Invalid refresh token');
    expect(deps.error).toHaveBeenCalledWith(
      '[refreshController] Invalid refresh token:',
      expect.any(Error),
    );
  });

  it.each<[string, { authMethod?: 'openid'; provider?: string }]>([
    ['authMethod on the session', { authMethod: 'openid' }],
    ['the user provider when authMethod predates tracking', { provider: 'openid' }],
  ])('treats an unassociated legacy credential as openid via %s', async (_label, shape) => {
    const refreshToken = signRefreshToken(USER_ID);
    const deps = buildDeps({
      getUserById: jest
        .fn()
        .mockResolvedValue({ _id: USER_ID, provider: shape.provider ?? 'local' }),
      findSession: jest.fn().mockResolvedValue({
        _id: SESSION_ID,
        expiration: new Date(Date.now() + 60_000),
        authMethod: shape.authMethod,
      }),
      authorizeProviderSession: jest
        .fn()
        .mockResolvedValue({ ok: true } satisfies ProviderSessionAuthorizeOutcome),
    });
    const handler = createLocalRefreshHandler(deps as never);
    const res = buildRes();

    await handler({ query: {} } as never, res, refreshToken);

    expect(deps.authorizeProviderSession).toHaveBeenCalledWith({
      ref: null,
      expiresAt: expect.any(Date),
      legacy: true,
    });
  });

  it('skips the provider-session check for a session that was never an OpenID login', async () => {
    const refreshToken = signRefreshToken(USER_ID);
    const deps = buildDeps({
      getUserById: jest.fn().mockResolvedValue({ _id: USER_ID, provider: 'local' }),
      findSession: jest.fn().mockResolvedValue({
        _id: SESSION_ID,
        expiration: new Date(Date.now() + 60_000),
      }),
    });
    const handler = createLocalRefreshHandler(deps as never);
    const res = buildRes();

    await handler({ query: {} } as never, res, refreshToken);

    expect(deps.authorizeProviderSession).not.toHaveBeenCalled();
    expect(deps.setAuthTokens).toHaveBeenCalled();
  });

  it('passes the untouched session forward, so a rotation keeps the ref the authorizer checked', async () => {
    const refreshToken = signRefreshToken(USER_ID);
    const providerSession = {
      issuer: 'https://issuer.example.com',
      clientId: 'client-1',
      sid: 'sid-1',
    };
    const session = {
      _id: SESSION_ID,
      expiration: new Date(Date.now() + 60_000),
      providerSession,
    };
    const deps = buildDeps({
      getUserById: jest.fn().mockResolvedValue({ _id: USER_ID, provider: 'openid' }),
      findSession: jest.fn().mockResolvedValue(session),
      authorizeProviderSession: jest
        .fn()
        .mockResolvedValue({ ok: true } satisfies ProviderSessionAuthorizeOutcome),
    });
    const handler = createLocalRefreshHandler(deps as never);
    const res = buildRes();

    await handler({ query: {} } as never, res, refreshToken);

    expect(deps.setAuthTokens).toHaveBeenCalledWith(USER_ID, res, session, expect.anything());
  });
});
