import { ProviderSessionUnavailableError } from '~/auth/openid/providerSession/errors';
import { mapAdminAuthError } from './adminAuthErrors';
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
