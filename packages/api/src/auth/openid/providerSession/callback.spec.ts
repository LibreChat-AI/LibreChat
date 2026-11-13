import type { Response } from 'express';
import type { ProviderSessionAuthorizer } from './authorize';
import {
  establishOpenIDCallbackProviderSession,
  establishOAuthProviderSession,
  persistOpenIDAdminProviderSessionBinding,
  markOpenIDLoginIssued,
  type OpenIDCallbackProviderSessionDeps,
} from './callback';
import { ProviderSessionUnavailableError } from './errors';

const logger = {
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
};

function createResponse(): Response {
  return { redirect: jest.fn() } as unknown as Response;
}

function createAuthorizer(
  overrides: Partial<ProviderSessionAuthorizer> = {},
): ProviderSessionAuthorizer {
  return {
    establish: jest.fn().mockResolvedValue({ ok: true }),
    authorize: jest.fn().mockResolvedValue({ ok: true }),
    preCheck: jest.fn().mockResolvedValue({ ok: true }),
    getMode: jest.fn().mockResolvedValue('enforce'),
    ...overrides,
  };
}

function createDeps(
  overrides: Partial<OpenIDCallbackProviderSessionDeps> = {},
): OpenIDCallbackProviderSessionDeps {
  return {
    authorizer: createAuthorizer(),
    getProviderSessionClient: jest
      .fn()
      .mockReturnValue({ issuer: 'https://issuer.example.com', clientId: 'client-1' }),
    logger,
    refreshTokenExpiryMs: 86400000,
    ...overrides,
  };
}

describe('establishOpenIDCallbackProviderSession', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('is a true no-op under mode off: never decodes claims, never establishes', async () => {
    const getClaims = jest.fn();
    const authorizer = createAuthorizer({ getMode: jest.fn().mockResolvedValue('off') });
    const deps = createDeps({ authorizer });
    const res = createResponse();

    const result = await establishOpenIDCallbackProviderSession(deps, {
      getClaims,
      res,
    });

    expect(result).toEqual({ ok: true, ref: null });
    expect(getClaims).not.toHaveBeenCalled();
    expect(authorizer.establish).not.toHaveBeenCalled();
  });

  it('extracts the ref from the configured client, not the caller-supplied issuer', async () => {
    const getClaims = jest.fn().mockReturnValue({ sub: 'sub-1', sid: 'sid-1' });
    const authorizer = createAuthorizer();
    const deps = createDeps({ authorizer });
    const res = createResponse();

    const result = await establishOpenIDCallbackProviderSession(deps, {
      getClaims,
      callbackIssuedAt: new Date('2024-01-01T00:00:00.000Z'),
      res,
    });

    expect(result).toEqual({
      ok: true,
      ref: { issuer: 'https://issuer.example.com', clientId: 'client-1', sid: 'sid-1' },
    });
    expect(authorizer.establish).toHaveBeenCalledWith({
      ref: { issuer: 'https://issuer.example.com', clientId: 'client-1', sid: 'sid-1' },
      subject: 'sub-1',
      expiresAt: expect.any(Date),
      callbackIssuedAt: new Date('2024-01-01T00:00:00.000Z'),
    });
  });

  it('stores the concrete tenant issuer, not the configured {tenantid} template, for a template-issuer login', async () => {
    const tenantIssuer =
      'https://login.microsoftonline.com/11111111-2222-3333-4444-555555555555/v2.0';
    const getClaims = jest.fn().mockReturnValue({ sub: 'sub-1', sid: 'sid-1', iss: tenantIssuer });
    const authorizer = createAuthorizer();
    const deps = createDeps({
      authorizer,
      getProviderSessionClient: jest.fn().mockReturnValue({
        issuer: 'https://login.microsoftonline.com/{tenantid}/v2.0',
        clientId: 'client-1',
      }),
    });
    const res = createResponse();

    const result = await establishOpenIDCallbackProviderSession(deps, { getClaims, res });

    expect(result).toEqual({
      ok: true,
      ref: { issuer: tenantIssuer, clientId: 'client-1', sid: 'sid-1' },
    });
    expect(authorizer.establish).toHaveBeenCalledWith(
      expect.objectContaining({
        ref: { issuer: tenantIssuer, clientId: 'client-1', sid: 'sid-1' },
      }),
    );
  });

  it('establishes with a null ref when the provider-session client is not configured', async () => {
    const getClaims = jest.fn().mockReturnValue({ sub: 'sub-1', sid: 'sid-1' });
    const deps = createDeps({ getProviderSessionClient: jest.fn().mockReturnValue(null) });
    const res = createResponse();

    const result = await establishOpenIDCallbackProviderSession(deps, { getClaims, res });

    expect(result).toEqual({ ok: true, ref: null });
    expect(deps.authorizer.establish).toHaveBeenCalledWith(expect.objectContaining({ ref: null }));
  });

  it('treats a missing callbackIssuedAt as indeterminately old rather than omitting it', async () => {
    const getClaims = jest.fn().mockReturnValue({ sub: 'sub-1', sid: 'sid-1' });
    const deps = createDeps();
    const res = createResponse();

    await establishOpenIDCallbackProviderSession(deps, { getClaims, res });

    expect(deps.authorizer.establish).toHaveBeenCalledWith(
      expect.objectContaining({ callbackIssuedAt: new Date(0) }),
    );
  });

  it('redirects to login and reports a denial without establishing a session', async () => {
    const getClaims = jest.fn().mockReturnValue({ sub: 'sub-1', sid: 'sid-1' });
    const authorizer = createAuthorizer({
      establish: jest.fn().mockResolvedValue({ ok: false, code: 'OPENID_SESSION_ENDED' }),
    });
    const deps = createDeps({ authorizer });
    const res = createResponse();

    const result = await establishOpenIDCallbackProviderSession(deps, {
      getClaims,
      res,
      clientDomain: 'http://client.test',
    });

    expect(result).toEqual({ ok: false });
    expect(res.redirect).toHaveBeenCalledWith(
      'http://client.test/login?redirect=false&error=OPENID_SESSION_ENDED',
    );
  });

  it('logs and redirects with the missing-sid error when enforce denies a missing sid', async () => {
    const getClaims = jest.fn().mockReturnValue({ sub: 'sub-1', sid: 'sid-1' });
    const authorizer = createAuthorizer({
      establish: jest.fn().mockResolvedValue({ ok: false, code: 'OPENID_SESSION_ID_MISSING' }),
    });
    const deps = createDeps({ authorizer });
    const res = createResponse();

    const result = await establishOpenIDCallbackProviderSession(deps, {
      getClaims,
      res,
      clientDomain: 'http://client.test',
    });

    expect(result).toEqual({ ok: false });
    expect(logger.warn).toHaveBeenCalled();
    expect(res.redirect).toHaveBeenCalledWith(
      'http://client.test/login?redirect=false&error=OPENID_SESSION_ID_MISSING',
    );
  });

  it('redirects with the temporary-unavailable error and reports a denial when the check cannot run', async () => {
    const getClaims = jest.fn().mockReturnValue({ sub: 'sub-1', sid: 'sid-1' });
    const authorizer = createAuthorizer({
      establish: jest.fn().mockRejectedValue(new ProviderSessionUnavailableError()),
    });
    const deps = createDeps({ authorizer });
    const res = createResponse();

    const result = await establishOpenIDCallbackProviderSession(deps, {
      getClaims,
      res,
      clientDomain: 'http://client.test',
    });

    expect(result).toEqual({ ok: false });
    expect(logger.error).toHaveBeenCalled();
    expect(res.redirect).toHaveBeenCalledWith(
      'http://client.test/login?redirect=false&error=AUTH_SESSION_CHECK_UNAVAILABLE',
    );
  });

  it('maps a getMode config-load failure to the unavailable redirect, not an uncaught throw', async () => {
    const getClaims = jest.fn();
    const authorizer = createAuthorizer({
      getMode: jest.fn().mockRejectedValue(new ProviderSessionUnavailableError()),
    });
    const deps = createDeps({ authorizer });
    const res = createResponse();

    const result = await establishOpenIDCallbackProviderSession(deps, {
      getClaims,
      res,
      clientDomain: 'http://client.test',
    });

    expect(result).toEqual({ ok: false });
    expect(getClaims).not.toHaveBeenCalled();
    expect(res.redirect).toHaveBeenCalledWith(
      'http://client.test/login?redirect=false&error=AUTH_SESSION_CHECK_UNAVAILABLE',
    );
  });

  it('rethrows an unrelated establish failure instead of redirecting', async () => {
    const getClaims = jest.fn().mockReturnValue({ sub: 'sub-1', sid: 'sid-1' });
    const unrelated = new Error('boom');
    const authorizer = createAuthorizer({ establish: jest.fn().mockRejectedValue(unrelated) });
    const deps = createDeps({ authorizer });
    const res = createResponse();

    await expect(establishOpenIDCallbackProviderSession(deps, { getClaims, res })).rejects.toThrow(
      unrelated,
    );
    expect(res.redirect).not.toHaveBeenCalled();
  });
});

describe('establishOAuthProviderSession', () => {
  it('returns null for a non-OpenID login without calling the authorizer', async () => {
    const deps = createDeps();
    const res = createResponse();

    const result = await establishOAuthProviderSession(deps, {
      req: { user: { provider: 'google' } },
      res,
    });

    expect(result).toBeNull();
    expect(deps.authorizer.getMode).not.toHaveBeenCalled();
  });

  it('establishes using claims from the user tokenset and the session login timestamp', async () => {
    const deps = createDeps();
    const res = createResponse();
    const claims = jest.fn().mockReturnValue({ sub: 'sub-1', sid: 'sid-1' });

    const result = await establishOAuthProviderSession(deps, {
      req: {
        user: { provider: 'openid', tokenset: { claims } },
        session: { openidLoginIssuedAt: new Date('2024-01-01T00:00:00.000Z').getTime() },
      },
      res,
    });

    expect(claims).toHaveBeenCalled();
    expect(result).toEqual({
      issuer: 'https://issuer.example.com',
      clientId: 'client-1',
      sid: 'sid-1',
    });
    expect(deps.authorizer.establish).toHaveBeenCalledWith(
      expect.objectContaining({ callbackIssuedAt: new Date('2024-01-01T00:00:00.000Z') }),
    );
  });

  it('returns undefined once a denial has redirected', async () => {
    const authorizer = createAuthorizer({
      establish: jest.fn().mockResolvedValue({ ok: false, code: 'OPENID_SESSION_ENDED' }),
    });
    const deps = createDeps({ authorizer });
    const res = createResponse();

    const result = await establishOAuthProviderSession(deps, {
      req: { user: { provider: 'openid', tokenset: { claims: () => ({ sub: 'sub-1' }) } } },
      res,
      clientDomain: 'http://client.test',
    });

    expect(result).toBeUndefined();
    expect(res.redirect).toHaveBeenCalled();
  });
});

describe('markOpenIDLoginIssued', () => {
  it('stamps the session with the given timestamp', () => {
    const session: { openidLoginIssuedAt?: number } = {};

    markOpenIDLoginIssued(session, 1704067200000);

    expect(session.openidLoginIssuedAt).toBe(1704067200000);
  });

  it('defaults to the current time when no timestamp is given', () => {
    const session: { openidLoginIssuedAt?: number } = {};
    const before = Date.now();

    markOpenIDLoginIssued(session);

    const after = Date.now();
    expect(session.openidLoginIssuedAt).toBeGreaterThanOrEqual(before);
    expect(session.openidLoginIssuedAt).toBeLessThanOrEqual(after);
  });

  it('is a no-op when there is no session', () => {
    expect(() => markOpenIDLoginIssued(undefined)).not.toThrow();
    expect(() => markOpenIDLoginIssued(null)).not.toThrow();
  });
});

describe('persistOpenIDAdminProviderSessionBinding', () => {
  function makeAuthorizer(mode: 'off' | 'record' | 'enforce' = 'enforce') {
    return { getMode: jest.fn().mockResolvedValue(mode) } as unknown as ProviderSessionAuthorizer;
  }

  it('does nothing when there is no refresh token to bind', async () => {
    const storeOpenIDSession = jest.fn();
    await persistOpenIDAdminProviderSessionBinding(
      { authorizer: makeAuthorizer(), storeOpenIDSession },
      { provider: 'openid', userId: 'user-1', tenantId: 'tenant-1', providerSession: null },
    );
    expect(storeOpenIDSession).not.toHaveBeenCalled();
  });

  it('does nothing for a non-OpenID login even with a refresh token', async () => {
    const storeOpenIDSession = jest.fn();
    await persistOpenIDAdminProviderSessionBinding(
      { authorizer: makeAuthorizer(), storeOpenIDSession },
      {
        provider: 'google',
        refreshToken: 'refresh-token',
        userId: 'user-1',
        tenantId: 'tenant-1',
        providerSession: null,
      },
    );
    expect(storeOpenIDSession).not.toHaveBeenCalled();
  });

  it('does nothing in mode off', async () => {
    const storeOpenIDSession = jest.fn();
    await persistOpenIDAdminProviderSessionBinding(
      { authorizer: makeAuthorizer('off'), storeOpenIDSession },
      {
        provider: 'openid',
        refreshToken: 'refresh-token',
        userId: 'user-1',
        tenantId: 'tenant-1',
        providerSession: null,
      },
    );
    expect(storeOpenIDSession).not.toHaveBeenCalled();
  });

  it('stores the binding outside mode off for an OpenID login with a refresh token', async () => {
    const storeOpenIDSession = jest.fn().mockResolvedValue(undefined);
    const ref = { issuer: 'https://issuer.example.com', clientId: 'client-1', sid: 'sid-1' };

    await persistOpenIDAdminProviderSessionBinding(
      { authorizer: makeAuthorizer('record'), storeOpenIDSession },
      {
        provider: 'openid',
        refreshToken: 'refresh-token',
        userId: 'user-1',
        tenantId: 'tenant-1',
        providerSession: ref,
      },
    );

    expect(storeOpenIDSession).toHaveBeenCalledWith(
      'user-1',
      'refresh-token',
      'tenant-1',
      undefined,
      {
        providerSession: ref,
        authMethod: 'openid',
      },
    );
  });
});
