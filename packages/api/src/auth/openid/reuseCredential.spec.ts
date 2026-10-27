import jwt from 'jsonwebtoken';
import type { Request, Response } from 'express';
import { createRetiredOpenIDSessionRefusal, isOpenIDSessionRetired } from './reuseCredential';

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

describe('createRetiredOpenIDSessionRefusal', () => {
  const createRes = () => {
    const res = { status: jest.fn(), send: jest.fn() };
    res.status.mockReturnValue(res);
    res.send.mockReturnValue(res);
    return res;
  };

  beforeEach(() => {
    process.env.JWT_REFRESH_SECRET = SECRET;
  });

  it('clears the session and refuses a retired refresh', () => {
    const clearOpenIDAuthTokens = jest.fn();
    const refuse = createRetiredOpenIDSessionRefusal({ clearOpenIDAuthTokens, warn: jest.fn() });
    const req = { session: {} } as Request;
    const res = createRes();

    const result = refuse(
      req,
      res as unknown as Response,
      identityCookie(resetAt.getTime() - 1),
      user,
    );

    expect(result).toBe(res);
    expect(clearOpenIDAuthTokens).toHaveBeenCalledWith(req, res, 'user-1', 'tenant-1');
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it('lets a session established after the cutoff through untouched', () => {
    const clearOpenIDAuthTokens = jest.fn();
    const refuse = createRetiredOpenIDSessionRefusal({ clearOpenIDAuthTokens, warn: jest.fn() });
    const res = createRes();

    const result = refuse(
      { session: {} } as Request,
      res as unknown as Response,
      identityCookie(resetAt.getTime() + 1),
      user,
    );

    expect(result).toBeUndefined();
    expect(clearOpenIDAuthTokens).not.toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });
});
