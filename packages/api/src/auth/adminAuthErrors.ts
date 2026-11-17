import { isProviderSessionUnavailableError } from '~/auth/openid/providerSession/errors';
import { AdminExchangeError } from '~/auth/exchange';
import { AdminRefreshError } from '~/auth/refresh';

export interface AdminAuthErrorResponse {
  status: number;
  body: { error: string; error_code: string };
}

/**
 * Maps a coded admin-auth failure to its HTTP response. Shared by the `/oauth/exchange` and
 * `/oauth/refresh` admin routes so a provider-session denial or unavailable check gets the same
 * wire shape from either one. Returns `null` for an error the caller must still handle itself.
 */
export function mapAdminAuthError(error: unknown): AdminAuthErrorResponse | null {
  // The thrown message may carry the underlying cause (e.g. a database error); never forward it.
  if (isProviderSessionUnavailableError(error)) {
    return {
      status: error.status,
      body: { error: 'Provider session check unavailable', error_code: error.code },
    };
  }
  if (error instanceof AdminRefreshError || error instanceof AdminExchangeError) {
    return { status: error.status, body: { error: error.message, error_code: error.code } };
  }
  return null;
}

/** Only an explicit invalid grant confirms that the user's renewal credentials were rejected. */
export function mapAdminRefreshError(error: unknown): AdminAuthErrorResponse {
  const mapped = mapAdminAuthError(error);
  if (mapped) {
    return mapped;
  }
  const status =
    typeof error === 'object' && error !== null && 'status' in error ? error.status : undefined;
  const rejected =
    typeof error === 'object' &&
    error !== null &&
    (('error' in error && error.error === 'invalid_grant') ||
      ('code' in error && error.code === 'invalid_grant'));
  if (rejected && (status === undefined || status === 400 || status === 401)) {
    return { status: 401, body: { error: 'Refresh failed', error_code: 'REFRESH_FAILED' } };
  }
  return {
    status: 503,
    body: { error: 'Session renewal unavailable', error_code: 'AUTH_SESSION_CHECK_UNAVAILABLE' },
  };
}
