import { MCPTokenRefreshUnavailableError, MCPTokenStorageUnavailableError } from './oauth/tokens';
import { MCPAuthenticationRefreshError, MCPAuthenticationRejectedError } from './errors';
import { OpenIDReauthRequiredError } from '~/utils/oidc';

/** Preserve actionable credential failures instead of inferring an interactive OAuth flow. */
export function isMCPAuthenticationRecoveryError(error: unknown): boolean {
  return (
    error instanceof OpenIDReauthRequiredError ||
    error instanceof MCPAuthenticationRefreshError ||
    error instanceof MCPAuthenticationRejectedError ||
    error instanceof MCPTokenRefreshUnavailableError ||
    error instanceof MCPTokenStorageUnavailableError
  );
}
