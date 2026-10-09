import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import type { Request, Response } from 'express';
import {
  shouldUseSecureCookie,
  setRefreshTokenCookie,
  setOpenIDMarkerCookies,
  REFRESH_TOKEN_COOKIE,
  TOKEN_PROVIDER_COOKIE,
  OPENID_USER_ID_COOKIE,
  setOAuthCsrfCookie,
  setOAuthSessionCookie,
  validateOAuthCsrf,
  generateOAuthCsrfToken,
} from './csrf';

describe('OAuth browser binding cookie paths', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      DOMAIN_CLIENT: 'https://client.example/ui',
      JWT_SECRET: 'cookie-path-test-secret',
      SESSION_COOKIE_SECURE: 'false',
    };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it.each([
    { domainServer: undefined, basePath: '' },
    { domainServer: '', basePath: '' },
    { domainServer: 'invalid', basePath: '' },
    { domainServer: 'https://server.example', basePath: '' },
    { domainServer: 'https://server.example/', basePath: '' },
    { domainServer: 'https://server.example/chat', basePath: '/chat' },
    { domainServer: 'https://server.example/chat/', basePath: '/chat' },
    { domainServer: 'https://server.example/chat///', basePath: '/chat' },
    { domainServer: 'https://server.example/apps/librechat', basePath: '/apps/librechat' },
  ])(
    'issues and clears cookies under $basePath for $domainServer',
    async ({ domainServer, basePath }) => {
      if (domainServer === undefined) {
        delete process.env.DOMAIN_SERVER;
      } else {
        process.env.DOMAIN_SERVER = domainServer;
      }

      const res = { cookie: jest.fn(), clearCookie: jest.fn() } as unknown as Response;
      setOAuthSessionCookie(res, 'user-123');
      expect(res.cookie).toHaveBeenCalledWith(
        'oauth_session',
        generateOAuthCsrfToken('user-123'),
        expect.objectContaining({ path: `${basePath}/api`, httpOnly: true, sameSite: 'lax' }),
      );
      for (const route of ['mcp', 'actions']) {
        const cookiePath = `/api/${route}`;
        const flowId = `user-123:${route}`;
        const token = generateOAuthCsrfToken(flowId);
        setOAuthCsrfCookie(res, flowId, cookiePath);
        expect(res.cookie).toHaveBeenCalledWith(
          'oauth_csrf',
          token,
          expect.objectContaining({
            path: `${basePath}${cookiePath}`,
            httpOnly: true,
            sameSite: 'lax',
          }),
        );
        const req = { cookies: { oauth_csrf: token } } as Request;
        expect(validateOAuthCsrf(req, res, flowId, cookiePath)).toBe(true);
        expect(res.clearCookie).toHaveBeenCalledWith('oauth_csrf', {
          path: `${basePath}${cookiePath}`,
        });
      }
    },
  );
});

describe('shouldUseSecureCookie', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.SESSION_COOKIE_SECURE;
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('should return true in production with a non-localhost domain', () => {
    process.env.NODE_ENV = 'production';
    process.env.DOMAIN_SERVER = 'https://myapp.example.com';
    expect(shouldUseSecureCookie()).toBe(true);
  });

  it('should return false in development regardless of domain', () => {
    process.env.NODE_ENV = 'development';
    process.env.DOMAIN_SERVER = 'https://myapp.example.com';
    expect(shouldUseSecureCookie()).toBe(false);
  });

  it('should return false when NODE_ENV is not set', () => {
    delete process.env.NODE_ENV;
    process.env.DOMAIN_SERVER = 'https://myapp.example.com';
    expect(shouldUseSecureCookie()).toBe(false);
  });

  it('should return true when SESSION_COOKIE_SECURE=true', () => {
    process.env.NODE_ENV = 'development';
    process.env.DOMAIN_SERVER = 'http://localhost:3080';
    process.env.SESSION_COOKIE_SECURE = 'true';
    expect(shouldUseSecureCookie()).toBe(true);
  });

  it('should return false when SESSION_COOKIE_SECURE=false', () => {
    process.env.NODE_ENV = 'production';
    process.env.DOMAIN_SERVER = 'http://10.0.0.5:3080';
    process.env.SESSION_COOKIE_SECURE = 'false';
    expect(shouldUseSecureCookie()).toBe(false);
  });

  it('should trim and normalize SESSION_COOKIE_SECURE values', () => {
    process.env.NODE_ENV = 'development';
    process.env.DOMAIN_SERVER = 'http://localhost:3080';
    process.env.SESSION_COOKIE_SECURE = ' TRUE ';
    expect(shouldUseSecureCookie()).toBe(true);
  });

  it('should ignore invalid SESSION_COOKIE_SECURE values', () => {
    process.env.NODE_ENV = 'production';
    process.env.DOMAIN_SERVER = 'https://myapp.example.com';
    process.env.SESSION_COOKIE_SECURE = 'yes';
    expect(shouldUseSecureCookie()).toBe(true);
  });

  describe('localhost detection in production', () => {
    beforeEach(() => {
      process.env.NODE_ENV = 'production';
    });

    it('should return false for http://localhost:3080', () => {
      process.env.DOMAIN_SERVER = 'http://localhost:3080';
      expect(shouldUseSecureCookie()).toBe(false);
    });

    it('should return false for https://localhost:3080', () => {
      process.env.DOMAIN_SERVER = 'https://localhost:3080';
      expect(shouldUseSecureCookie()).toBe(false);
    });

    it('should return false for http://localhost (no port)', () => {
      process.env.DOMAIN_SERVER = 'http://localhost';
      expect(shouldUseSecureCookie()).toBe(false);
    });

    it('should return false for http://127.0.0.1:3080', () => {
      process.env.DOMAIN_SERVER = 'http://127.0.0.1:3080';
      expect(shouldUseSecureCookie()).toBe(false);
    });

    it('should return true for http://[::1]:3080 (IPv6 loopback — not detected due to URL bracket parsing)', () => {
      // Known limitation: new URL('http://[::1]:3080').hostname returns '[::1]' (with brackets)
      // but the check compares against '::1' (without brackets). IPv6 localhost is rare in practice.
      process.env.DOMAIN_SERVER = 'http://[::1]:3080';
      expect(shouldUseSecureCookie()).toBe(true);
    });

    it('should return false for subdomain of localhost', () => {
      process.env.DOMAIN_SERVER = 'http://app.localhost:3080';
      expect(shouldUseSecureCookie()).toBe(false);
    });

    it('should return true for a domain containing "localhost" as a substring but not as hostname', () => {
      process.env.DOMAIN_SERVER = 'https://notlocalhost.example.com';
      expect(shouldUseSecureCookie()).toBe(true);
    });

    it('should return true for a regular production domain', () => {
      process.env.DOMAIN_SERVER = 'https://chat.example.com';
      expect(shouldUseSecureCookie()).toBe(true);
    });

    it('should return true when DOMAIN_SERVER is empty (conservative default)', () => {
      process.env.DOMAIN_SERVER = '';
      expect(shouldUseSecureCookie()).toBe(true);
    });

    it('should return true when DOMAIN_SERVER is not set (conservative default)', () => {
      delete process.env.DOMAIN_SERVER;
      expect(shouldUseSecureCookie()).toBe(true);
    });

    it('should handle DOMAIN_SERVER without protocol prefix', () => {
      process.env.DOMAIN_SERVER = 'localhost:3080';
      expect(shouldUseSecureCookie()).toBe(false);
    });

    it('should handle case-insensitive hostnames', () => {
      process.env.DOMAIN_SERVER = 'http://LOCALHOST:3080';
      expect(shouldUseSecureCookie()).toBe(false);
    });
  });
});

describe('setRefreshTokenCookie', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.SESSION_COOKIE_SECURE;
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('writes the refresh token cookie with httpOnly + strict sameSite and the given expiry', () => {
    process.env.NODE_ENV = 'production';
    process.env.DOMAIN_SERVER = 'https://myapp.example.com';
    const res = { cookie: jest.fn() } as unknown as import('express').Response;
    const expires = new Date(Date.now() + 1000);

    setRefreshTokenCookie(res, 'rt-value', expires);

    expect(res.cookie).toHaveBeenCalledWith(REFRESH_TOKEN_COOKIE, 'rt-value', {
      expires,
      httpOnly: true,
      secure: true,
      sameSite: 'strict',
    });
  });

  it('uses an insecure cookie on localhost', () => {
    process.env.NODE_ENV = 'production';
    process.env.DOMAIN_SERVER = 'http://localhost:3080';
    const res = { cookie: jest.fn() } as unknown as import('express').Response;

    setRefreshTokenCookie(res, 'rt-value', new Date());

    expect(res.cookie).toHaveBeenCalledWith(
      REFRESH_TOKEN_COOKIE,
      'rt-value',
      expect.objectContaining({ secure: false }),
    );
  });
});

describe('setOpenIDMarkerCookies', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      JWT_REFRESH_SECRET: 'marker-secret',
      OPENID_REUSE_TOKENS: 'true',
    };
    delete process.env.SESSION_COOKIE_SECURE;
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('writes OpenID provider and signed user-id marker cookies with the same expiry', () => {
    process.env.NODE_ENV = 'production';
    process.env.DOMAIN_SERVER = 'https://myapp.example.com';
    const res = { cookie: jest.fn() } as unknown as import('express').Response;
    const expires = new Date(Date.now() + 604800000);

    setOpenIDMarkerCookies(res, {
      userId: 'user-123',
      expires,
      refreshExpiryMs: 604800000,
    });

    expect(res.cookie).toHaveBeenCalledWith(TOKEN_PROVIDER_COOKIE, 'openid', {
      expires,
      httpOnly: true,
      secure: true,
      sameSite: 'strict',
    });
    expect(res.cookie).toHaveBeenCalledWith(
      OPENID_USER_ID_COOKIE,
      expect.any(String),
      expect.objectContaining({ expires, secure: true }),
    );

    const signedUserId = (res.cookie as jest.Mock).mock.calls.find(
      ([name]) => name === OPENID_USER_ID_COOKIE,
    )?.[1];
    expect(jwt.verify(signedUserId, 'marker-secret')).toMatchObject({
      id: 'user-123',
      issuedAtMs: expect.any(Number),
    });
  });

  /** Preserves the marker's binding to the durable refresh-token session: a marker signed for one
   *  session must not stand in for another once the refresh token has rotated. */
  it('binds the signed user marker to the refresh token it was issued with', () => {
    const res = { cookie: jest.fn() } as unknown as import('express').Response;
    const expires = new Date(Date.now() + 604800000);

    setOpenIDMarkerCookies(res, {
      userId: 'user-123',
      expires,
      refreshExpiryMs: 604800000,
      refreshToken: 'the-refresh-token',
    });

    const signedUserId = (res.cookie as jest.Mock).mock.calls.find(
      ([name]) => name === OPENID_USER_ID_COOKIE,
    )?.[1];
    expect(jwt.verify(signedUserId, 'marker-secret')).toMatchObject({
      id: 'user-123',
      refreshTokenHash: crypto.createHash('sha256').update('the-refresh-token').digest('base64url'),
      issuedAtMs: expect.any(Number),
    });
  });

  it('omits the binding when no refresh token is supplied', () => {
    const res = { cookie: jest.fn() } as unknown as import('express').Response;
    const expires = new Date(Date.now() + 604800000);

    setOpenIDMarkerCookies(res, { userId: 'user-123', expires, refreshExpiryMs: 604800000 });

    const signedUserId = (res.cookie as jest.Mock).mock.calls.find(
      ([name]) => name === OPENID_USER_ID_COOKIE,
    )?.[1];
    expect(jwt.verify(signedUserId, 'marker-secret')).not.toHaveProperty('refreshTokenHash');
  });

  it('updates token_provider even when the signed user marker is not applicable', () => {
    const res = { cookie: jest.fn() } as unknown as import('express').Response;
    const expires = new Date(Date.now() + 604800000);

    setOpenIDMarkerCookies(res, {
      expires,
      refreshExpiryMs: 604800000,
      reuseTokens: false,
    });

    expect(res.cookie).toHaveBeenCalledTimes(1);
    expect(res.cookie).toHaveBeenCalledWith(
      TOKEN_PROVIDER_COOKIE,
      'openid',
      expect.objectContaining({ expires }),
    );
  });

  it('uses integer seconds for fractional refresh expiry durations', () => {
    const res = { cookie: jest.fn() } as unknown as import('express').Response;
    const expires = new Date(Date.now() + 604800999);

    setOpenIDMarkerCookies(res, {
      userId: 'user-123',
      expires,
      refreshExpiryMs: 604800999,
    });

    const signedUserId = (res.cookie as jest.Mock).mock.calls.find(
      ([name]) => name === OPENID_USER_ID_COOKIE,
    )?.[1];
    const payload = jwt.verify(signedUserId, 'marker-secret') as jwt.JwtPayload;
    if (typeof payload.exp !== 'number' || typeof payload.iat !== 'number') {
      throw new Error('Expected signed marker JWT to include numeric exp and iat');
    }
    expect(payload.exp - payload.iat).toBe(604800);
  });

  it.each([0, -1000, 999, Number.NaN, Number.POSITIVE_INFINITY])(
    'throws when the refresh expiry duration is invalid: %p',
    (refreshExpiryMs) => {
      const res = { cookie: jest.fn() } as unknown as import('express').Response;
      const expires = new Date(Date.now() + 999);

      expect(() =>
        setOpenIDMarkerCookies(res, {
          userId: 'user-123',
          expires,
          refreshExpiryMs,
        }),
      ).toThrow('refreshExpiryMs must be a positive duration for OpenID marker cookies');
    },
  );
});
