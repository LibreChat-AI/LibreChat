import { logger } from '@librechat/data-schemas';
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
  const ENDED = { status: 401, body: { error: 'Refresh failed', error_code: 'REFRESH_FAILED' } };
  const MISCONFIGURED = {
    status: 500,
    body: {
      error: 'Identity provider client is misconfigured',
      error_code: 'OPENID_CLIENT_MISCONFIGURED',
    },
  };
  const UNAVAILABLE = {
    status: 503,
    body: { error: 'Session renewal unavailable', error_code: 'AUTH_SESSION_CHECK_UNAVAILABLE' },
  };

  beforeEach(() => {
    jest.spyOn(logger, 'error').mockImplementation(() => logger);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  const endingCodes = ['invalid_grant', 'interaction_required', 'login_required', 'consent_required'];
  const misconfiguredCodes = [
    'invalid_client',
    'unauthorized_client',
    'unsupported_grant_type',
    'invalid_scope',
    'invalid_request',
  ];
  const confirmedStatuses = [400, 401, 403, undefined];
  const unconfirmedStatuses = [404, 429, 500, 502, 503];

  const rows: Array<[unknown, typeof ENDED]> = [
    ...endingCodes.flatMap((code) =>
      confirmedStatuses.flatMap((status): Array<[unknown, typeof ENDED]> => [
        [{ error: code, status }, ENDED],
        [{ code, status }, ENDED],
      ]),
    ),
    ...misconfiguredCodes.flatMap((code) =>
      confirmedStatuses.flatMap((status): Array<[unknown, typeof ENDED]> => [
        [{ error: code, status }, MISCONFIGURED],
        [{ code, status }, MISCONFIGURED],
      ]),
    ),
    ...[...endingCodes, ...misconfiguredCodes].flatMap((code) =>
      unconfirmedStatuses.map((status): [unknown, typeof ENDED] => [
        { error: code, status },
        UNAVAILABLE,
      ]),
    ),
    [{ error: 'server_error', status: 500 }, UNAVAILABLE],
    [{ error: 'server_error', status: 400 }, UNAVAILABLE],
    [{ error: 'temporarily_unavailable', status: 503 }, UNAVAILABLE],
    [{ error: 'temporarily_unavailable' }, UNAVAILABLE],
    [{ error: 'access_denied', status: 403 }, UNAVAILABLE],
    [{ error: 'unknown_code', status: 400 }, UNAVAILABLE],
    [{ status: 500 }, UNAVAILABLE],
    [{ status: 429 }, UNAVAILABLE],
    [new TypeError('fetch failed: secret'), UNAVAILABLE],
    [Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }), UNAVAILABLE],
    [new Error('invalid_grant is only an error message'), UNAVAILABLE],
    ['not an error', UNAVAILABLE],
    [undefined, UNAVAILABLE],
  ];

  it.each(rows)('maps %j', (error, expected) => {
    expect(mapAdminRefreshError(error)).toEqual(expected);
  });

  it('logs a client configuration fault at error level without the provider payload', () => {
    mapAdminRefreshError({ error: 'invalid_client', status: 401, error_description: 'secret' });

    expect(logger.error).toHaveBeenCalledWith(
      '[adminRefresh] The identity provider rejected the OAuth client configuration',
      { oauthError: 'invalid_client', status: 401 },
    );
  });

  it('does not log a session-ending or retryable failure at error level', () => {
    mapAdminRefreshError({ error: 'invalid_grant', status: 400 });
    mapAdminRefreshError({ error: 'server_error', status: 500 });

    expect(logger.error).not.toHaveBeenCalled();
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
