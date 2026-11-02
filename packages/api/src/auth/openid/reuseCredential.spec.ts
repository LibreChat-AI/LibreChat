import jwt from 'jsonwebtoken';
import { isOpenIDSessionRetired } from './reuseCredential';

const SECRET = 'refresh-secret';
const resetAt = new Date('2026-01-01T00:00:00.000Z');
const user = { _id: 'user-1', tenantId: 'tenant-1', credentialsChangedAt: resetAt };

const identityCookie = (issuedAtMs: number, id = 'user-1') => ({
  openid_user_id: jwt.sign({ id, issuedAtMs }, SECRET),
});

const retired = (input: Partial<Parameters<typeof isOpenIDSessionRetired>[0]>) =>
  isOpenIDSessionRetired({ parsedCookies: {}, user, jwtRefreshSecret: SECRET, ...input });

describe('isOpenIDSessionRetired', () => {
  it('dates the session by its identity cookie', () => {
    expect(retired({ parsedCookies: identityCookie(resetAt.getTime() - 1) })).toBe(true);
    expect(retired({ parsedCookies: identityCookie(resetAt.getTime() + 1) })).toBe(false);
  });

  it('prefers the identity cookie over the server-side rotation stamp', () => {
    expect(
      retired({
        parsedCookies: identityCookie(resetAt.getTime() - 1),
        sessionTokens: { appUserId: 'user-1', lastRefreshedAt: resetAt.getTime() + 1 },
      }),
    ).toBe(true);
  });

  it('falls back to the last rotation when no identity cookie names the user', () => {
    const sessionTokens = { appUserId: 'user-1', lastRefreshedAt: resetAt.getTime() - 1 };
    expect(retired({ sessionTokens })).toBe(true);
    expect(retired({ parsedCookies: identityCookie(Date.now(), 'user-2'), sessionTokens })).toBe(
      true,
    );
    expect(
      retired({ sessionTokens: { appUserId: 'user-1', lastRefreshedAt: resetAt.getTime() + 1 } }),
    ).toBe(false);
  });

  it('retires an undatable session only once a cutoff exists', () => {
    expect(retired({ sessionTokens: { appUserId: 'user-1' } })).toBe(true);
    expect(retired({ user: { _id: 'user-1' } })).toBe(false);
  });

  it('ignores an identity cookie bound to another refresh token', () => {
    const parsedCookies = {
      openid_user_id: jwt.sign(
        { id: 'user-1', issuedAtMs: resetAt.getTime() + 1, refreshTokenHash: 'other' },
        SECRET,
      ),
    };
    expect(retired({ parsedCookies, refreshToken: 'spent-refresh' })).toBe(true);
  });
});
