import { logger } from '@librechat/data-schemas';
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

/** OAuth error codes that end the admin session: the provider refused the user's credentials or
 *  requires the user to sign in again. */
const SESSION_ENDING_OAUTH_ERRORS = new Set([
  'invalid_grant',
  'interaction_required',
  'login_required',
  'consent_required',
]);

/** OAuth error codes that report a fault in this server's client configuration. A retry cannot
 *  succeed and the user's credentials are not at fault. */
const CLIENT_MISCONFIGURED_OAUTH_ERRORS = new Set([
  'invalid_client',
  'unauthorized_client',
  'unsupported_grant_type',
  'invalid_scope',
  'invalid_request',
]);

export const OPENID_CLIENT_MISCONFIGURED = 'OPENID_CLIENT_MISCONFIGURED';

function readOAuthError(error: unknown): { code?: string; status?: unknown } {
  if (typeof error !== 'object' || error === null) {
    return {};
  }
  const record = error as { error?: unknown; code?: unknown; status?: unknown };
  if (typeof record.error === 'string') {
    return { code: record.error, status: record.status };
  }
  if (typeof record.code === 'string') {
    return { code: record.code, status: record.status };
  }
  return { status: record.status };
}

/**
 * Maps a failed refresh grant to its HTTP response. An OAuth error code counts only when the
 * provider answered with status 400, 401 or 403, or with no status:
 *  - a refused credential or a required sign-in answers `401 REFRESH_FAILED`;
 *  - a client configuration fault answers `500 OPENID_CLIENT_MISCONFIGURED` and is logged as an
 *    error;
 *  - anything else (`server_error`, `temporarily_unavailable`, 5xx, 429, a network error, an
 *    unknown code) answers a retryable `503 AUTH_SESSION_CHECK_UNAVAILABLE`.
 */
export function mapAdminRefreshError(error: unknown): AdminAuthErrorResponse {
  const mapped = mapAdminAuthError(error);
  if (mapped) {
    return mapped;
  }
  const { code, status } = readOAuthError(error);
  const confirmed = status === undefined || status === 400 || status === 401 || status === 403;
  if (code && confirmed && SESSION_ENDING_OAUTH_ERRORS.has(code)) {
    return { status: 401, body: { error: 'Refresh failed', error_code: 'REFRESH_FAILED' } };
  }
  if (code && confirmed && CLIENT_MISCONFIGURED_OAUTH_ERRORS.has(code)) {
    logger.error('[adminRefresh] The identity provider rejected the OAuth client configuration', {
      oauthError: code,
      status,
    });
    return {
      status: 500,
      body: {
        error: 'Identity provider client is misconfigured',
        error_code: OPENID_CLIENT_MISCONFIGURED,
      },
    };
  }
  return {
    status: 503,
    body: { error: 'Session renewal unavailable', error_code: 'AUTH_SESSION_CHECK_UNAVAILABLE' },
  };
}
