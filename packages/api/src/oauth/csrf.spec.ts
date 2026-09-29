import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import {
  shouldUseSecureCookie,
  setRefreshTokenCookie,
  setOpenIDMarkerCookies,
  REFRESH_TOKEN_COOKIE,
  TOKEN_PROVIDER_COOKIE,
  OPENID_USER_ID_COOKIE,
} from './csrf';

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
    expect(jwt.verify(signedUserId, 'marker-secret')).toMatchObject({ id: 'user-123' });
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
/**
 * Property 16: The callback exemption is key-separated and path-scoped.
 *
 * These suites cover the `oauth_session` cookie's signed form: its key separation
 * from `JWT_SECRET` and `JWT_REFRESH_SECRET`, its lifetime derivation from the flow
 * window, and the mint/validate round trip.
 *
 * `mcpConfig` freezes its TTLs at module load from the MCP_OAUTH_* environment, so
 * the lifetime cases set the environment, `jest.resetModules()`, and re-import
 * `./csrf` to pick up a freshly evaluated `getOAuthSessionMaxAge`. Because those
 * cases re-import the module, they also re-derive the signing key from the
 * per-test `JWT_REFRESH_SECRET`, so each case stands on its own.
 */
describe('oauth_session cookie: key separation (Property 16)', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = {
      ...originalEnv,
      JWT_SECRET: 'jwt-secret',
      JWT_REFRESH_SECRET: 'refresh-secret',
    };
    delete process.env.SESSION_COOKIE_SECURE;
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  /** Extracts the value written to the `oauth_session` cookie from a spied `res`. */
  const capturedSessionCookie = (res: import('express').Response, name: string): string =>
    (res.cookie as jest.Mock).mock.calls.find(([cookieName]) => cookieName === name)?.[1];

  it('verifies against the derived key and against neither JWT_SECRET nor JWT_REFRESH_SECRET', async () => {
    const { setOAuthSessionCookie, deriveOAuthSessionKey, OAUTH_SESSION_COOKIE } = await import(
      './csrf'
    );
    const res = { cookie: jest.fn() } as unknown as import('express').Response;

    setOAuthSessionCookie(res, 'user-123');
    const token = capturedSessionCookie(res, OAUTH_SESSION_COOKIE);

    // Verifies against the derived Session_Cookie_Key.
    expect(jwt.verify(token, deriveOAuthSessionKey(), { algorithms: ['HS256'] })).toMatchObject({
      id: 'user-123',
    });
    // Does NOT verify against JWT_SECRET or JWT_REFRESH_SECRET — the derivation is
    // one-way, so the raw application secrets cannot validate the cookie.
    expect(() => jwt.verify(token, process.env.JWT_SECRET as string)).toThrow();
    expect(() => jwt.verify(token, process.env.JWT_REFRESH_SECRET as string)).toThrow();
  });

  it('rejects a refreshToken-style value presented as an oauth_session cookie', async () => {
    const { validateOAuthSession, OAUTH_SESSION_COOKIE } = await import('./csrf');
    // A token signed with JWT_REFRESH_SECRET (the refresh-token / marker key), of the
    // same `{ id, exp }` shape, must not be admissible as an oauth_session cookie.
    const refreshShaped = jwt.sign({ id: 'user-123' }, process.env.JWT_REFRESH_SECRET as string, {
      algorithm: 'HS256',
      expiresIn: 900,
    });
    const req = {
      cookies: { [OAUTH_SESSION_COOKIE]: refreshShaped },
    } as unknown as import('express').Request;

    expect(validateOAuthSession(req, 'user-123')).toBe(false);
  });

  it('rejects an oauth_session value presented as a refresh token', async () => {
    const { setOAuthSessionCookie, OAUTH_SESSION_COOKIE } = await import('./csrf');
    const res = { cookie: jest.fn() } as unknown as import('express').Response;

    setOAuthSessionCookie(res, 'user-123');
    const sessionToken = capturedSessionCookie(res, OAUTH_SESSION_COOKIE);

    // The refresh-token verification key is JWT_REFRESH_SECRET; an oauth_session
    // token (signed with the derived key) does not verify against it. Key
    // separation is what makes the substitution unrepresentable — no `typ` claim.
    expect(() => jwt.verify(sessionToken, process.env.JWT_REFRESH_SECRET as string)).toThrow();
  });
});

describe('oauth_session cookie: lifetime derived from the flow window (Property 16)', () => {
  const originalEnv = process.env;
  const FLOWS_NAMESPACE_TTL = 10 * 60 * 1000; // Time.ONE_MINUTE * 10

  beforeEach(() => {
    jest.resetModules();
    process.env = {
      ...originalEnv,
      JWT_SECRET: 'jwt-secret',
      JWT_REFRESH_SECRET: 'jwt-refresh-secret',
    };
    delete process.env.SESSION_COOKIE_SECURE;
    delete process.env.MCP_OAUTH_HANDLING_TIMEOUT;
    delete process.env.MCP_OAUTH_FLOW_TTL;
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  /** Mints the cookie and returns { maxAge from res.cookie options, exp*1000 - iat*1000 from the token }. */
  const mintAndMeasure = async (): Promise<{ maxAge: number; expMs: number }> => {
    const { setOAuthSessionCookie, deriveOAuthSessionKey, OAUTH_SESSION_COOKIE } = await import(
      './csrf'
    );
    const res = { cookie: jest.fn() } as unknown as import('express').Response;
    setOAuthSessionCookie(res, 'user-123');

    const call = (res.cookie as jest.Mock).mock.calls.find(
      ([name]) => name === OAUTH_SESSION_COOKIE,
    );
    const token = call?.[1] as string;
    const maxAge = (call?.[2] as { maxAge: number }).maxAge;
    const payload = jwt.verify(token, deriveOAuthSessionKey(), {
      algorithms: ['HS256'],
    }) as jwt.JwtPayload;
    if (typeof payload.exp !== 'number' || typeof payload.iat !== 'number') {
      throw new Error('Expected oauth_session token to carry numeric exp and iat');
    }
    return { maxAge, expMs: (payload.exp - payload.iat) * 1000 };
  };

  it('sets exp and maxAge equal, both to max(OAUTH_FLOW_TTL, FLOWS_TTL) at default config', async () => {
    // Default: OAUTH_FLOW_TTL = 15min, FLOWS_TTL = 10min => window = 15min.
    const { maxAge, expMs } = await mintAndMeasure();
    expect(maxAge).toBe(15 * 60 * 1000);
    expect(expMs).toBe(maxAge);
  });

  it('follows OAUTH_FLOW_TTL when MCP_OAUTH_HANDLING_TIMEOUT is raised above the flow TTL', async () => {
    // Raising the handling timeout raises OAUTH_FLOW_TTL (timeout + 60s grace) above
    // both the default flow TTL and the FLOWS namespace TTL, so it drives the window.
    process.env.MCP_OAUTH_HANDLING_TIMEOUT = String(30 * 60 * 1000);
    const { maxAge, expMs } = await mintAndMeasure();
    expect(maxAge).toBe(30 * 60 * 1000 + 60 * 1000);
    expect(expMs).toBe(maxAge);
  });

  it('falls back to the FLOWS namespace TTL when MCP_OAUTH_HANDLING_TIMEOUT is lowered below it', async () => {
    // Lowering the handling timeout drops OAUTH_FLOW_TTL below the FLOWS namespace
    // TTL, so FLOWS_TTL (10min) becomes the load-bearing lower bound of the window.
    process.env.MCP_OAUTH_HANDLING_TIMEOUT = String(60 * 1000);
    process.env.MCP_OAUTH_FLOW_TTL = String(60 * 1000);
    const { maxAge, expMs } = await mintAndMeasure();
    expect(maxAge).toBe(FLOWS_NAMESPACE_TTL);
    expect(expMs).toBe(maxAge);
  });

  it('follows OAUTH_FLOW_TTL when MCP_OAUTH_FLOW_TTL is raised', async () => {
    // Raising the flow TTL directly raises OAUTH_FLOW_TTL above the FLOWS namespace
    // TTL, so it drives the window.
    process.env.MCP_OAUTH_FLOW_TTL = String(45 * 60 * 1000);
    const { maxAge, expMs } = await mintAndMeasure();
    expect(maxAge).toBe(45 * 60 * 1000);
    expect(expMs).toBe(maxAge);
  });
});

describe('oauth_session cookie: mint, overwrite, and validate (Property 16)', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = {
      ...originalEnv,
      JWT_SECRET: 'jwt-secret',
      JWT_REFRESH_SECRET: 'jwt-refresh-secret',
    };
    delete process.env.SESSION_COOKIE_SECURE;
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('setOAuthSession overwrites a cookie already present, including one carrying a different user id', async () => {
    const { setOAuthSession, deriveOAuthSessionKey, OAUTH_SESSION_COOKIE } = await import('./csrf');

    // A cookie for a different user is already present on the request; the middleware
    // must overwrite it rather than skip, so the cookie always describes the current user.
    const priorToken = jwt.sign({ id: 'other-user' }, deriveOAuthSessionKey(), {
      algorithm: 'HS256',
      expiresIn: 900,
    });
    const req = {
      user: { id: 'current-user' },
      cookies: { [OAUTH_SESSION_COOKIE]: priorToken },
    } as unknown as import('express').Request;
    const res = { cookie: jest.fn() } as unknown as import('express').Response;
    const next = jest.fn();

    setOAuthSession(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    const written = (res.cookie as jest.Mock).mock.calls.find(
      ([name]) => name === OAUTH_SESSION_COOKIE,
    )?.[1];
    const payload = jwt.verify(written, deriveOAuthSessionKey(), {
      algorithms: ['HS256'],
    }) as jwt.JwtPayload;
    expect(payload.id).toBe('current-user');
  });

  it('setOAuthSession writes no cookie when no authenticated user id is present', async () => {
    const { setOAuthSession, OAUTH_SESSION_COOKIE } = await import('./csrf');
    const req = { cookies: {} } as unknown as import('express').Request;
    const res = { cookie: jest.fn() } as unknown as import('express').Response;
    const next = jest.fn();

    setOAuthSession(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    const written = (res.cookie as jest.Mock).mock.calls.find(
      ([name]) => name === OAUTH_SESSION_COOKIE,
    );
    expect(written).toBeUndefined();
  });

  it('validateOAuthSession accepts a valid cookie for the matching user id', async () => {
    const { setOAuthSessionCookie, validateOAuthSession, OAUTH_SESSION_COOKIE } = await import(
      './csrf'
    );
    const res = { cookie: jest.fn() } as unknown as import('express').Response;
    setOAuthSessionCookie(res, 'user-123');
    const token = (res.cookie as jest.Mock).mock.calls.find(
      ([name]) => name === OAUTH_SESSION_COOKIE,
    )?.[1];

    const req = {
      cookies: { [OAUTH_SESSION_COOKIE]: token },
    } as unknown as import('express').Request;
    expect(validateOAuthSession(req, 'user-123')).toBe(true);
    // Bound to the specific user: a mismatched user id is rejected.
    expect(validateOAuthSession(req, 'user-999')).toBe(false);
  });

  it('validateOAuthSession rejects an expired cookie', async () => {
    const { validateOAuthSession, deriveOAuthSessionKey, OAUTH_SESSION_COOKIE } = await import(
      './csrf'
    );
    // Sign a token that expired one second ago against the derived key.
    const expired = jwt.sign(
      { id: 'user-123', exp: Math.floor(Date.now() / 1000) - 1 },
      deriveOAuthSessionKey(),
      { algorithm: 'HS256' },
    );
    const req = {
      cookies: { [OAUTH_SESSION_COOKIE]: expired },
    } as unknown as import('express').Request;

    expect(validateOAuthSession(req, 'user-123')).toBe(false);
  });

  it('validateOAuthSession rejects an absent cookie', async () => {
    const { validateOAuthSession } = await import('./csrf');
    const req = { cookies: {} } as unknown as import('express').Request;
    expect(validateOAuthSession(req, 'user-123')).toBe(false);
  });
});
