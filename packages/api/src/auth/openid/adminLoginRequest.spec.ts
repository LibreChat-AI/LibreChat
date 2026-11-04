import type { AdminOpenIDLoginRequest } from './adminLoginRequest';
import type { OpenIDLoginSession } from './sessions';
import { prepareAdminOpenIDLoginRequest } from './adminLoginRequest';

function makeRequest(
  overrides: Partial<Pick<AdminOpenIDLoginRequest, 'query' | 'originalUrl' | 'url'>> & {
    session?: OpenIDLoginSession;
  } = {},
): AdminOpenIDLoginRequest {
  return {
    query: {},
    originalUrl: '/oauth/openid',
    url: '/oauth/openid',
    session: {},
    ...overrides,
  } as unknown as AdminOpenIDLoginRequest;
}

describe('prepareAdminOpenIDLoginRequest', () => {
  it('starts a fresh login with no retry when enforcement is off', () => {
    const req = makeRequest();

    const result = prepareAdminOpenIDLoginRequest(req, false, 'tenant-1');

    expect(result).toEqual({ promptLogin: false });
    expect(req.session?.openidPendingInitiation).toBeUndefined();
  });

  it('records this initiation when enforcement is on, for a later retry to restore', () => {
    const req = makeRequest({
      query: { code_challenge: 'challenge-abc' },
      originalUrl: '/oauth/openid?code_challenge=challenge-abc',
      url: '/oauth/openid?code_challenge=challenge-abc',
    });

    const result = prepareAdminOpenIDLoginRequest(req, true, 'tenant-1');

    expect(result).toEqual({ promptLogin: false });
    expect(req.session?.openidPendingInitiation).toEqual({
      tenantId: 'tenant-1',
      codeChallenge: 'challenge-abc',
    });
  });

  it('detects a prompt=login retry only when enforcement is on and a denial left its marker', () => {
    const req = makeRequest({
      query: { prompt: 'login' },
      originalUrl: '/oauth/openid?prompt=login',
      url: '/oauth/openid?prompt=login',
      session: { openidLoginRetry: { sid: 'sid-1' } },
    });

    const result = prepareAdminOpenIDLoginRequest(req, true, 'tenant-1');

    expect(result).toEqual({ promptLogin: true });
  });

  it('restores the PKCE challenge from the prior initiation on a retry that cannot resend it', () => {
    const req = makeRequest({
      query: { prompt: 'login' },
      originalUrl: '/oauth/openid?prompt=login',
      url: '/oauth/openid?prompt=login',
      session: {
        openidLoginRetry: { sid: 'sid-1' },
        openidPendingInitiation: { tenantId: 'tenant-1', codeChallenge: 'remembered-challenge' },
      },
    });

    prepareAdminOpenIDLoginRequest(req, true, 'tenant-1');

    expect(req.originalUrl).toContain('code_challenge=remembered-challenge');
    expect(req.url).toContain('code_challenge=remembered-challenge');
  });

  it('strips prompt from the request URLs on a retry so the callback is not misclassified', () => {
    const req = makeRequest({
      query: { prompt: 'login' },
      originalUrl: '/oauth/openid?prompt=login',
      url: '/oauth/openid?prompt=login',
      session: { openidLoginRetry: { sid: 'sid-1' } },
    });

    prepareAdminOpenIDLoginRequest(req, true, 'tenant-1');

    expect(req.query.prompt).toBeUndefined();
    expect(req.originalUrl).not.toContain('prompt=login');
    expect(req.url).not.toContain('prompt=login');
  });

  it('re-records the initiation after a retry restores it, in case this attempt is denied too', () => {
    const req = makeRequest({
      query: { prompt: 'login' },
      originalUrl: '/oauth/openid?prompt=login',
      url: '/oauth/openid?prompt=login',
      session: {
        openidLoginRetry: { sid: 'sid-1' },
        openidPendingInitiation: { tenantId: 'tenant-1', codeChallenge: 'remembered-challenge' },
      },
    });

    prepareAdminOpenIDLoginRequest(req, true, 'tenant-1');

    expect(req.session?.openidPendingInitiation).toEqual({
      tenantId: 'tenant-1',
      codeChallenge: 'remembered-challenge',
    });
  });

  it('never reaches a retry classification when enforcement is off, even with a stored marker', () => {
    const req = makeRequest({
      query: { prompt: 'login' },
      originalUrl: '/oauth/openid?prompt=login',
      url: '/oauth/openid?prompt=login',
      session: { openidLoginRetry: { sid: 'sid-1' } },
    });

    const result = prepareAdminOpenIDLoginRequest(req, false, 'tenant-1');

    expect(result).toEqual({ promptLogin: false });
    expect(req.query.prompt).toBe('login');
  });
});
