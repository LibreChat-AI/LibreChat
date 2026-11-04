import type { OpenIDLoginInitiationRequest } from './oauthInitiation';
import { resolveOpenIDLoginInitiation } from './oauthInitiation';

function buildReq(
  overrides: Partial<OpenIDLoginInitiationRequest> = {},
): OpenIDLoginInitiationRequest {
  return {
    query: {},
    originalUrl: '/oauth/openid',
    url: '/oauth/openid',
    session: {},
    ...overrides,
  };
}

describe('resolveOpenIDLoginInitiation', () => {
  it('returns no prompt for a plain (non-retry) request', () => {
    const req = buildReq();
    const options = resolveOpenIDLoginInitiation(req, true, 'tenant-1');
    expect(options).toEqual({});
    expect(req.query.prompt).toBeUndefined();
  });

  it('remembers the tenant for a later retry when enforcement is on', () => {
    const session: Record<string, unknown> = {};
    const req = buildReq({ session });
    resolveOpenIDLoginInitiation(req, true, 'tenant-1');
    expect(session.openidPendingInitiation).toEqual({ tenantId: 'tenant-1' });
  });

  it('stores nothing when enforcement is off', () => {
    const session: Record<string, unknown> = {};
    const req = buildReq({ session });
    resolveOpenIDLoginInitiation(req, false, 'tenant-1');
    expect(session.openidPendingInitiation).toBeUndefined();
  });

  it('requests prompt=login and strips the query param on a genuine retry', () => {
    const session = { openidLoginRetry: { sid: 'sid-1' } };
    const req = buildReq({
      session,
      query: { prompt: 'login' },
      originalUrl: '/oauth/openid?prompt=login',
      url: '/oauth/openid?prompt=login',
    });
    const options = resolveOpenIDLoginInitiation(req, true, 'tenant-1');
    expect(options).toEqual({ prompt: 'login' });
    expect(req.query.prompt).toBeUndefined();
    expect(req.originalUrl).not.toContain('prompt');
    expect(req.url).not.toContain('prompt');
  });

  it('clears a consumed stale pending initiation before storing a fresh one', () => {
    const staleInitiation = { tenantId: 'stale-tenant' };
    const session = {
      openidLoginRetry: { sid: 'sid-1' },
      openidPendingInitiation: staleInitiation,
    };
    const req = buildReq({
      session,
      query: { prompt: 'login' },
      originalUrl: '/oauth/openid?prompt=login',
      url: '/oauth/openid?prompt=login',
    });
    resolveOpenIDLoginInitiation(req, true, 'tenant-1');
    expect(session.openidPendingInitiation).not.toBe(staleInitiation);
    expect(session.openidPendingInitiation).toEqual({ tenantId: 'tenant-1' });
  });

  it('does not treat prompt=login as a retry when enforcement is on but no marker was stored', () => {
    const req = buildReq({
      session: {},
      query: { prompt: 'login' },
      originalUrl: '/oauth/openid?prompt=login',
      url: '/oauth/openid?prompt=login',
    });
    const options = resolveOpenIDLoginInitiation(req, true, 'tenant-1');
    expect(options).toEqual({});
    expect(req.query.prompt).toBe('login');
  });

  it('leaves prompt=login untouched when enforcement is off', () => {
    const req = buildReq({
      session: {},
      query: { prompt: 'login' },
      originalUrl: '/oauth/openid?prompt=login',
      url: '/oauth/openid?prompt=login',
    });
    const options = resolveOpenIDLoginInitiation(req, false, 'tenant-1');
    expect(options).toEqual({});
    expect(req.query.prompt).toBe('login');
  });
});
