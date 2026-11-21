import jwt from 'jsonwebtoken';
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
