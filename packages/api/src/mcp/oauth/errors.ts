import { OAuthError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { getSafeErrorMetadata } from '~/utils/errors';
import { isInvalidClientMessage } from '~/mcp/utils';

const OAUTH_ERROR_CODES = [
  'invalid_client',
  'unauthorized_client',
  'invalid_grant',
  'invalid_request',
  'invalid_scope',
  'invalid_target',
  'access_denied',
  'unsupported_grant_type',
  'server_error',
  'temporarily_unavailable',
] as const;

/** Keep recovery codes without propagating provider text, payloads, or causes. */
export function getSafeOAuthError(error: unknown, message: string): Error {
  const text = error instanceof Error ? error.message.toLowerCase() : '';
  const sdkCode =
    error instanceof OAuthError
      ? OAUTH_ERROR_CODES.find((code) => code === error.errorCode)
      : undefined;
  const code = isInvalidClientMessage(text)
    ? 'invalid_client'
    : (sdkCode ?? OAUTH_ERROR_CODES.find((code) => text.includes(code)));

  return Object.assign(
    new Error(code ? `${message} (${code})` : message),
    getSafeErrorMetadata(error),
  );
}
