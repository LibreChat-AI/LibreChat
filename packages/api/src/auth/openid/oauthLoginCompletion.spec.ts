import type { OpenIDLoginDeps } from './sessions/login';
import { resolveOpenIDLoginCompletion } from './oauthLoginCompletion';
import { createOpenIDSessionCache } from './sessions/authorize';

function buildLoginDeps(enforcement: boolean, overrides: Partial<OpenIDLoginDeps> = {}) {
  const recordOpenIDLogin = jest.fn().mockResolvedValue({
    ok: true,
    session: { _id: { toString: () => 'session-login-1' } },
  });
  const upsertOpenIDBinding = jest.fn().mockResolvedValue(undefined);
  const findOpenIDSessionById = jest.fn().mockResolvedValue({
    issuer: 'https://idp.example.com',
    clientId: 'client-id',
    subject: 'openid-subject-1',
    revokedAt: null,
    firstLoginIat: null,
  });
  const findOpenIDSubject = jest.fn().mockResolvedValue(undefined);
  const findOpenIDBinding = jest.fn().mockResolvedValue({ _id: 'binding-1' });
  const deps: OpenIDLoginDeps = {
    authorization: { recordOpenIDLogin, upsertOpenIDBinding },
    authorizationDeps: {
      authorization: {
        findOpenIDSession: jest.fn(),
        findOpenIDSessionById,
        findOpenIDSubject,
        findOpenIDBinding,
        findOpenIDBindingBySid: jest.fn(),
      },
      enforcement,
      timeoutMs: 200,
      cache: createOpenIDSessionCache(),
    },
    now: () => new Date('2024-01-01T00:00:00Z'),
    logger: { warn: jest.fn() },
    ...overrides,
  };
  return deps;
}

const user = {
  id: 'user-123',
  tenantId: 'tenant-1',
  openidIssuer: 'https://idp.example.com',
  openidId: 'openid-subject-1',
};

function buildDeps(overrides: Record<string, unknown> = {}) {
  return {
    loginDeps: buildLoginDeps(true),
    clientId: 'client-id',
    sessionAuthorizationEnforcement: true,
    sessionAuthorizationTimeoutMs: 3_000,
    rememberAdminSessionRef: jest.fn().mockResolvedValue(undefined),
    logger: { info: jest.fn(), warn: jest.fn() },
    ...overrides,
  };
}

describe('resolveOpenIDLoginCompletion', () => {
  it('continues with no session id for a non-openid provider', async () => {
    const deps = buildDeps();
    const result = await resolveOpenIDLoginCompletion(
      {
        provider: 'google',
        user,
        session: undefined,
        retryRoute: '/oauth/openid',
        loginFailureRedirectBase: 'http://localhost:3080',
        isAdminExchange: false,
      },
      deps as never,
    );
    expect(result).toEqual({ kind: 'continue' });
  });

  it('extracts sid and iat from a tokenset.claims() function', async () => {
    const loginDeps = buildLoginDeps(true);
    const deps = buildDeps({ loginDeps });
    await resolveOpenIDLoginCompletion(
      {
        provider: 'openid',
        user,
        tokenset: { claims: () => ({ sid: 'sid-1', iat: 1700000000 }) },
        session: {},
        retryRoute: '/oauth/openid',
        loginFailureRedirectBase: 'http://localhost:3080',
        isAdminExchange: false,
      },
      deps as never,
    );
    expect(loginDeps.authorization.recordOpenIDLogin).toHaveBeenCalledWith(
      expect.objectContaining({ sid: 'sid-1', loginIat: 1700000000 }),
    );
  });

  it('falls back to a plain sid/iat tokenset when claims() is absent', async () => {
    const loginDeps = buildLoginDeps(true);
    const deps = buildDeps({ loginDeps });
    await resolveOpenIDLoginCompletion(
      {
        provider: 'openid',
        user,
        tokenset: { sid: 'sid-2', iat: 1700000001 },
        session: {},
        retryRoute: '/oauth/openid',
        loginFailureRedirectBase: 'http://localhost:3080',
        isAdminExchange: false,
      },
      deps as never,
    );
    expect(loginDeps.authorization.recordOpenIDLogin).toHaveBeenCalledWith(
      expect.objectContaining({ sid: 'sid-2', loginIat: 1700000001 }),
    );
  });

  it('records sid with an undefined loginIat when the tokenset carries no iat', async () => {
    const loginDeps = buildLoginDeps(true);
    const deps = buildDeps({ loginDeps });
    await resolveOpenIDLoginCompletion(
      {
        provider: 'openid',
        user,
        tokenset: { sid: 'sid-3' },
        session: {},
        retryRoute: '/oauth/openid',
        loginFailureRedirectBase: 'http://localhost:3080',
        isAdminExchange: false,
      },
      deps as never,
    );
    expect(loginDeps.authorization.recordOpenIDLogin).toHaveBeenCalledWith(
      expect.objectContaining({ sid: 'sid-3', loginIat: undefined }),
    );
  });

  it('continues with the authorized session id', async () => {
    const deps = buildDeps();
    const result = await resolveOpenIDLoginCompletion(
      {
        provider: 'openid',
        user,
        tokenset: { sid: 'sid-1', iat: 1700000000 },
        session: {},
        retryRoute: '/oauth/openid',
        loginFailureRedirectBase: 'http://localhost:3080',
        isAdminExchange: false,
      },
      deps as never,
    );
    expect(result).toEqual({ kind: 'continue', openidSessionId: 'session-login-1' });
  });

  it('redirects to the retry route when completion asks for a retry', async () => {
    const loginDeps = buildLoginDeps(true);
    loginDeps.authorizationDeps.authorization.findOpenIDBinding = jest.fn().mockResolvedValue(null);
    const deps = buildDeps({ loginDeps });
    const session: Record<string, unknown> = {};
    const result = await resolveOpenIDLoginCompletion(
      {
        provider: 'openid',
        user,
        tokenset: { sid: 'sid-1', iat: 1700000000 },
        session,
        retryRoute: '/oauth/openid',
        loginFailureRedirectBase: 'http://localhost:3080',
        isAdminExchange: false,
      },
      deps as never,
    );
    expect(result).toEqual({ kind: 'redirect', url: '/oauth/openid?prompt=login' });
  });

  it('redirects to a custom retry route', async () => {
    const loginDeps = buildLoginDeps(true);
    loginDeps.authorizationDeps.authorization.findOpenIDBinding = jest.fn().mockResolvedValue(null);
    const deps = buildDeps({ loginDeps });
    const result = await resolveOpenIDLoginCompletion(
      {
        provider: 'openid',
        user,
        tokenset: { sid: 'sid-1', iat: 1700000000 },
        session: {},
        retryRoute: '/api/admin/oauth/openid',
        loginFailureRedirectBase: 'http://localhost:3080',
        isAdminExchange: false,
      },
      deps as never,
    );
    expect(result).toEqual({ kind: 'redirect', url: '/api/admin/oauth/openid?prompt=login' });
  });

  it('redirects with the denial code when completion is denied', async () => {
    const loginDeps = buildLoginDeps(true, {
      authorization: {
        recordOpenIDLogin: jest.fn().mockResolvedValue({ ok: false }),
        upsertOpenIDBinding: jest.fn(),
      },
    });
    const deps = buildDeps({ loginDeps });
    const result = await resolveOpenIDLoginCompletion(
      {
        provider: 'openid',
        user,
        tokenset: { sid: 'sid-1', iat: 1700000000 },
        session: {},
        retryRoute: '/oauth/openid',
        loginFailureRedirectBase: 'http://localhost:3080',
        isAdminExchange: false,
      },
      deps as never,
    );
    expect(result).toEqual({
      kind: 'redirect',
      url: 'http://localhost:3080/login?redirect=false&error=auth_failed&code=subject_mismatch',
    });
  });

  it('redirects with unavailable when enforcement is on and login deps are absent', async () => {
    const deps = buildDeps({ loginDeps: undefined, sessionAuthorizationEnforcement: true });
    const result = await resolveOpenIDLoginCompletion(
      {
        provider: 'openid',
        user,
        session: {},
        retryRoute: '/oauth/openid',
        loginFailureRedirectBase: 'http://localhost:3080',
        isAdminExchange: false,
      },
      deps as never,
    );
    expect(result).toEqual({
      kind: 'redirect',
      url: 'http://localhost:3080/login?redirect=false&error=auth_failed&code=unavailable',
    });
  });

  it('continues with no session id when enforcement is off and login deps are absent', async () => {
    const deps = buildDeps({ loginDeps: undefined, sessionAuthorizationEnforcement: false });
    const result = await resolveOpenIDLoginCompletion(
      {
        provider: 'openid',
        user,
        session: {},
        retryRoute: '/oauth/openid',
        loginFailureRedirectBase: 'http://localhost:3080',
        isAdminExchange: false,
      },
      deps as never,
    );
    expect(result).toEqual({ kind: 'continue' });
  });

  describe('admin session reference', () => {
    it('remembers the reference directly when enforcement is on', async () => {
      const rememberAdminSessionRef = jest.fn().mockResolvedValue(undefined);
      const deps = buildDeps({ sessionAuthorizationEnforcement: true, rememberAdminSessionRef });
      await resolveOpenIDLoginCompletion(
        {
          provider: 'openid',
          user,
          tokenset: { sid: 'sid-1', iat: 1700000000 },
          session: {},
          retryRoute: '/oauth/openid',
          loginFailureRedirectBase: 'http://localhost:3080',
          isAdminExchange: true,
          adminRefreshToken: 'refresh-token',
        },
        deps as never,
      );
      expect(rememberAdminSessionRef).toHaveBeenCalledWith('refresh-token', 'session-login-1');
    });

    it('skips remembering when there is no refresh token', async () => {
      const rememberAdminSessionRef = jest.fn();
      const deps = buildDeps({ rememberAdminSessionRef });
      await resolveOpenIDLoginCompletion(
        {
          provider: 'openid',
          user,
          tokenset: { sid: 'sid-1', iat: 1700000000 },
          session: {},
          retryRoute: '/oauth/openid',
          loginFailureRedirectBase: 'http://localhost:3080',
          isAdminExchange: true,
        },
        deps as never,
      );
      expect(rememberAdminSessionRef).not.toHaveBeenCalled();
    });

    it('wraps the remember call with the authorization timeout when enforcement is off', async () => {
      const rememberAdminSessionRef = jest.fn().mockResolvedValue(undefined);
      const deps = buildDeps({
        sessionAuthorizationEnforcement: false,
        sessionAuthorizationTimeoutMs: 1_234,
        rememberAdminSessionRef,
        loginDeps: buildLoginDeps(false),
      });
      await resolveOpenIDLoginCompletion(
        {
          provider: 'openid',
          user,
          tokenset: { sid: 'sid-1', iat: 1700000000 },
          session: {},
          retryRoute: '/oauth/openid',
          loginFailureRedirectBase: 'http://localhost:3080',
          isAdminExchange: true,
          adminRefreshToken: 'refresh-token',
        },
        deps as never,
      );
      expect(rememberAdminSessionRef).toHaveBeenCalledWith('refresh-token', 'session-login-1');
    });

    it('carries on when remembering times out and enforcement is off', async () => {
      const rememberAdminSessionRef = jest.fn().mockRejectedValue(new Error('timed out'));
      const deps = buildDeps({
        sessionAuthorizationEnforcement: false,
        rememberAdminSessionRef,
        loginDeps: buildLoginDeps(false),
      });
      const result = await resolveOpenIDLoginCompletion(
        {
          provider: 'openid',
          user,
          tokenset: { sid: 'sid-1', iat: 1700000000 },
          session: {},
          retryRoute: '/oauth/openid',
          loginFailureRedirectBase: 'http://localhost:3080',
          isAdminExchange: true,
          adminRefreshToken: 'refresh-token',
        },
        deps as never,
      );
      expect(result).toEqual({ kind: 'continue', openidSessionId: 'session-login-1' });
    });

    it('redirects with unavailable and issues no session id when remembering fails under enforcement', async () => {
      const rememberAdminSessionRef = jest.fn().mockRejectedValue(new Error('cache unreachable'));
      const deps = buildDeps({ sessionAuthorizationEnforcement: true, rememberAdminSessionRef });
      const result = await resolveOpenIDLoginCompletion(
        {
          provider: 'openid',
          user,
          tokenset: { sid: 'sid-1', iat: 1700000000 },
          session: {},
          retryRoute: '/oauth/openid',
          loginFailureRedirectBase: 'http://localhost:3080',
          isAdminExchange: true,
          adminRefreshToken: 'refresh-token',
        },
        deps as never,
      );
      expect(result).toEqual({
        kind: 'redirect',
        url: 'http://localhost:3080/login?redirect=false&error=auth_failed&code=unavailable',
      });
    });
  });
});
