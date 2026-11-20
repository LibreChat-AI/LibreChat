import express from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import type { Response } from 'express';
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

describe('createLocalRefreshHandler required enrollment', () => {
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

  it.each(['getUserById', 'findSession', 'setAuthTokens'] as const)(
    'keeps a %s failure retryable without clearing credentials',
    async (method) => {
      const deps = buildDeps({
        getUserById: jest.fn().mockResolvedValue({ _id: USER_ID, provider: 'local' }),
        findSession: jest.fn().mockResolvedValue({
          _id: SESSION_ID,
          expiration: new Date(Date.now() + 60_000),
        }),
      });
      deps[method].mockRejectedValueOnce(new Error('storage unavailable'));
      const handler = createLocalRefreshHandler(deps);
      const res = buildRes();

      await handler({ query: {} } as never, res, signRefreshToken(USER_ID));

      expect(res.status).toHaveBeenCalledWith(503);
      expect(res.send).toHaveBeenCalledWith({ code: 'AUTH_SESSION_CHECK_UNAVAILABLE' });
      expect(res.clearCookie).not.toHaveBeenCalled();
      expect(deps.deleteSession).not.toHaveBeenCalled();
      expect(deps.deleteAllUserSessions).not.toHaveBeenCalled();

      const retry = buildRes();
      await handler({ query: {} } as never, retry, signRefreshToken(USER_ID));
      expect(retry.status).toHaveBeenCalledWith(200);
    },
  );

  it.each([
    ['malformed', (): string => 'not-a-token'],
    ['expired', (): string => jwt.sign({ id: USER_ID }, JWT_REFRESH_SECRET, { expiresIn: -1 })],
    ['not active', (): string => jwt.sign({ id: USER_ID }, JWT_REFRESH_SECRET, { notBefore: 60 })],
    ['invalid payload', (): string => jwt.sign({ invalid: true }, JWT_REFRESH_SECRET)],
  ] as const)('rejects a %s credential without querying storage', async (_label, token) => {
    const deps = buildDeps();
    const handler = createLocalRefreshHandler(deps);
    const res = buildRes();

    await handler({ query: {} } as never, res, token());

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.send).toHaveBeenCalledWith('Invalid refresh token');
    expect(deps.getUserById).not.toHaveBeenCalled();
  });

  it('keeps a missing server secret retryable without clearing credentials', async () => {
    delete process.env.JWT_REFRESH_SECRET;
    const deps = buildDeps();
    const handler = createLocalRefreshHandler(deps);
    const res = buildRes();

    await handler({ query: {} } as never, res, signRefreshToken(USER_ID));

    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.send).toHaveBeenCalledWith({ code: 'AUTH_SESSION_CHECK_UNAVAILABLE' });
    expect(res.clearCookie).not.toHaveBeenCalled();
    expect(deps.getUserById).not.toHaveBeenCalled();
  });

  it('returns an HTTP authentication failure for a deleted user instead of redirecting to HTML', async () => {
    const deps = buildDeps({ getUserById: jest.fn().mockResolvedValue(null) });
    const handler = createLocalRefreshHandler(deps);
    const app = express();
    app.post('/api/auth/refresh', async (req, res) => {
      await handler(req, res, signRefreshToken(USER_ID));
    });

    const response = await request(app).post('/api/auth/refresh');

    expect(response.status).toBe(401);
    expect(response.headers.location).toBeUndefined();
    expect(response.body).toEqual({ message: 'Refresh token expired or not found for this user' });
    expect(deps.findSession).not.toHaveBeenCalled();
  });

  it.each<['ldap' | 'passkey']>([['ldap'], ['passkey']])(
    "mints the required-enrollment setup token with the session's %s authMethod",
    async (authMethod) => {
      const refreshToken = signRefreshToken(USER_ID);
      const generateTwoFactorSetupToken = jest.fn().mockReturnValue('setup-token');
      const deps = buildDeps({
        getUserById: jest.fn().mockResolvedValue({ _id: USER_ID, provider: 'local' }),
        findSession: jest.fn().mockResolvedValue({
          _id: SESSION_ID,
          expiration: new Date(Date.now() + 60_000),
          authMethod,
        }),
        isTwoFactorEnrollmentRequired: jest.fn().mockReturnValue(true),
        generateTwoFactorSetupToken,
      });
      const handler = createLocalRefreshHandler(deps as never);
      const res = buildRes();

      await handler({ query: {} } as never, res, refreshToken);

      expect(generateTwoFactorSetupToken).toHaveBeenCalledWith(
        USER_ID,
        expect.any(String),
        authMethod,
      );
      expect(res.send).toHaveBeenCalledWith(
        expect.objectContaining({ twoFASetupRequired: true, tempToken: 'setup-token' }),
      );
    },
  );

  it('mints the required-enrollment setup token without an authMethod for a legacy session', async () => {
    const refreshToken = signRefreshToken(USER_ID);
    const generateTwoFactorSetupToken = jest.fn().mockReturnValue('setup-token');
    const deps = buildDeps({
      getUserById: jest.fn().mockResolvedValue({ _id: USER_ID, provider: 'local' }),
      findSession: jest.fn().mockResolvedValue({
        _id: SESSION_ID,
        expiration: new Date(Date.now() + 60_000),
      }),
      isTwoFactorEnrollmentRequired: jest.fn().mockReturnValue(true),
      generateTwoFactorSetupToken,
    });
    const handler = createLocalRefreshHandler(deps as never);
    const res = buildRes();

    await handler({ query: {} } as never, res, refreshToken);

    /** No third argument: the setup-token chain falls back to `'local'` on its own. */
    expect(generateTwoFactorSetupToken).toHaveBeenCalledWith(
      USER_ID,
      expect.any(String),
      undefined,
    );
  });
});
