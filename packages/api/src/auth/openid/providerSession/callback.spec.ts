import type { Response } from 'express';
import type { ProviderSessionAuthorizer } from './authorize';
import {
  establishOpenIDCallbackProviderSession,
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
