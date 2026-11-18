import { ProviderSessionUnavailableError } from '~/auth/openid/providerSession/errors';
import { mapAdminAuthError, mapAdminRefreshError } from './adminAuthErrors';
import { AdminExchangeError } from '~/auth/exchange';
import { AdminRefreshError } from '~/auth/refresh';

describe('mapAdminAuthError', () => {
  it('maps a ProviderSessionUnavailableError to a generic message, never the underlying cause', () => {
    const error = new ProviderSessionUnavailableError('db down');

    expect(mapAdminAuthError(error)).toEqual({
      status: 503,
      body: {
        error: 'Provider session check unavailable',
        error_code: 'AUTH_SESSION_CHECK_UNAVAILABLE',
      },
    });
  });

  it('maps an AdminRefreshError to its status and code', () => {
    const error = new AdminRefreshError('OPENID_SESSION_ENDED', 401, 'Provider session has ended');

    expect(mapAdminAuthError(error)).toEqual({
      status: 401,
      body: { error: 'Provider session has ended', error_code: 'OPENID_SESSION_ENDED' },
    });
  });

  it('maps an AdminExchangeError to its status and code', () => {
    const error = new AdminExchangeError('OPENID_SESSION_ENDED', 401, 'Provider session has ended');

    expect(mapAdminAuthError(error)).toEqual({
      status: 401,
      body: { error: 'Provider session has ended', error_code: 'OPENID_SESSION_ENDED' },
    });
  });

  it('returns null for an error it does not recognize', () => {
    expect(mapAdminAuthError(new Error('boom'))).toBeNull();
    expect(mapAdminAuthError('not an error')).toBeNull();
    expect(mapAdminAuthError(undefined)).toBeNull();
  });
});

describe('mapAdminRefreshError', () => {
  it.each([
    new TypeError('fetch failed: secret'),
    new Error('invalid_grant is only an error message'),
    { error: 'invalid_grant', status: 429 },
    { error: 'invalid_grant', status: 503 },
    { error: 'invalid_client', status: 401 },
    { error: 'access_denied', status: 403 },
    { error: 'server_error', status: 500 },
  ])('preserves credentials after an unconfirmed rejection: %j', (error) => {
    expect(mapAdminRefreshError(error)).toEqual({
      status: 503,
      body: { error: 'Session renewal unavailable', error_code: 'AUTH_SESSION_CHECK_UNAVAILABLE' },
    });
  });

  it.each([
    { error: 'invalid_grant', status: 400 },
    { code: 'invalid_grant', status: 401 },
    { error: 'invalid_grant', status: 403 },
    { code: 'invalid_grant', status: 403 },
  ])('ends the session after a confirmed invalid grant: %j', (error) => {
    expect(mapAdminRefreshError(error)).toEqual({
      status: 401,
      body: { error: 'Refresh failed', error_code: 'REFRESH_FAILED' },
    });
  });

  it('preserves existing session denials and unavailable checks', () => {
    for (const error of [
      new AdminRefreshError('OPENID_SESSION_ENDED', 401, 'Provider session has ended'),
      new ProviderSessionUnavailableError('private cause'),
    ]) {
      expect(mapAdminRefreshError(error)).toEqual(mapAdminAuthError(error));
    }
  });
});
