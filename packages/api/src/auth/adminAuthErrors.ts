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
