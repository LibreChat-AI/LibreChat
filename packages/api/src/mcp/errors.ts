/**
 * MCP-specific error classes
 */
import { McpError } from '@modelcontextprotocol/sdk/types.js';
import { SseError } from '@modelcontextprotocol/sdk/client/sse.js';
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import { StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { OpenIDReauthRequiredError } from '~/utils/oidc';
import { OboTokenResolutionError } from './oauth/obo';
import { isOwnedAbortError } from '~/utils/errors';

/** These outcomes must reach the owning run instead of hiding a tool during discovery. */
export function isMCPInitializationError(error: unknown, signal?: AbortSignal): boolean {
  return (
    isOwnedAbortError(error, signal) ||
    error instanceof MCPAuthenticationRejectedError ||
    error instanceof MCPAuthenticationRefreshError ||
    error instanceof OboTokenResolutionError ||
    error instanceof OpenIDReauthRequiredError
  );
}

export const MCPErrorCodes = {
  DOMAIN_NOT_ALLOWED: 'MCP_DOMAIN_NOT_ALLOWED',
  INSPECTION_FAILED: 'MCP_INSPECTION_FAILED',
  OAUTH_SECRET_REENTRY_REQUIRED: 'MCP_OAUTH_SECRET_REENTRY_REQUIRED',
  API_KEY_REENTRY_REQUIRED: 'MCP_API_KEY_REENTRY_REQUIRED',
  AUTHENTICATION_REJECTED: 'MCP_AUTHENTICATION_REJECTED',
  AUTHENTICATION_REFRESH_FAILED: 'MCP_AUTHENTICATION_REFRESH_FAILED',
} as const;

export type MCPErrorCode = (typeof MCPErrorCodes)[keyof typeof MCPErrorCodes];

interface OAuthErrorLike {
  code?: number;
  status?: number;
  statusCode?: number;
  message?: string;
}

/** A JSON-RPC tool error is never evidence that the MCP transport rejected its bearer. */
export function isMCPTransportAuthenticationError(error: unknown): boolean {
  if (!error || typeof error !== 'object' || error instanceof McpError) {
    return false;
  }
  if (error instanceof UnauthorizedError) {
    return true;
  }
  const candidate = error as OAuthErrorLike;
  const status = candidate.status ?? candidate.statusCode;
  if (status === 401 || status === 403) {
    return true;
  }
  return (
    (error instanceof StreamableHTTPError || error instanceof SseError) &&
    (error.code === 401 || error.code === 403)
  );
}

/** Preserves the actual HTTP status before legacy SSE reduces a failed POST to plain text. */
export class MCPTransportAuthenticationError extends Error {
  constructor(public readonly status: 401 | 403) {
    super(`MCP transport rejected authentication (HTTP ${status})`);
    this.name = 'MCPTransportAuthenticationError';
  }
}

const OAUTH_HTTP_STATUS_PATTERN =
  /(?:\bhttp\s+(?:401|403)\b|\bnon-2\d\d\s+status\s+code\s*\((?:401|403)\)|^(?:error:\s*)?(?:401|403)\b|\bunauthorized\s*\(\s*401\s*\)|\bforbidden\s*\(\s*403\s*\))/i;
const MISSING_AUTHORIZATION_PATTERN = /\bno authorization (?:headers?|values?)\b/i;

/** Detects HTTP authentication failures and OAuth protocol errors without matching unrelated IDs. */
export function isOAuthAuthenticationError(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }

  const candidate = error as OAuthErrorLike;
  if (
    [candidate.status, candidate.statusCode, candidate.code].some(
      (status) => status === 401 || status === 403,
    )
  ) {
    return true;
  }

  if (typeof candidate.message !== 'string') {
    return false;
  }

  const message = candidate.message.toLowerCase();
  return (
    OAUTH_HTTP_STATUS_PATTERN.test(message) ||
    message.includes('invalid_token') ||
    message.includes('invalid_grant') ||
    message.includes('insufficient_scope') ||
    message.includes('authentication required') ||
    MISSING_AUTHORIZATION_PATTERN.test(message)
  );
}

/** The SDK's wording when the standalone `GET` SSE stream could not be opened. */
const SDK_SSE_OPEN_FAILED = 'Failed to open SSE stream';

/**
 * A `409` opening the standalone `GET` SSE stream means the server still has the previous
 * stream mapped to our session. The spec allows only one such stream per session, and the
 * server drops its mapping from the response stream's cancel callback — which never runs when
 * the connection dies at a proxy instead of at the client, leaving the server holding a stream
 * no one is reading.
 *
 * Retrying cannot clear it: every `GET` carrying that session id conflicts for the same reason.
 * Only a transport rebuild does, because the teardown `DELETE` drops the server's session along
 * with the stream it leaked.
 */
export function isStandaloneSseConflict(error: unknown): boolean {
  return (
    error instanceof StreamableHTTPError &&
    error.code === 409 &&
    error.message.includes(SDK_SSE_OPEN_FAILED)
  );
}

export interface SSEErrorDetails {
  message: string;
  code?: number;
  isProxyHint: boolean;
  isTransient: boolean;
}

/**
 * Extracts a meaningful error message from SSE transport errors.
 * The MCP SDK's SSEClientTransport can produce "SSE error: undefined" when the
 * underlying eventsource library encounters connection issues without a specific message.
 *
 * @returns Object containing:
 *   - message: Human-readable error description
 *   - code: HTTP status code if available
 *   - isProxyHint: Whether this error suggests proxy misconfiguration
 *   - isTransient: Whether this is likely a transient error that will auto-reconnect
 */
export function extractSSEErrorMessage(error: unknown): SSEErrorDetails {
  if (!error || typeof error !== 'object') {
    return {
      message: 'Unknown SSE transport error',
      isProxyHint: true,
      isTransient: true,
    };
  }

  const errorObj = error as { message?: string; code?: number; event?: unknown };
  const rawMessage = errorObj.message ?? '';
  const code = errorObj.code;

  /**
   * Handle the common "SSE error: undefined" case.
   * This typically occurs when:
   * 1. A reverse proxy buffers the SSE stream (proxy issue)
   * 2. The server closes an idle connection (normal SSE behavior)
   * 3. Network interruption without specific error details
   *
   * In all cases, the eventsource library will attempt to reconnect automatically.
   */
  if (rawMessage === 'SSE error: undefined' || rawMessage === 'undefined' || !rawMessage) {
    return {
      message:
        'SSE connection closed. This can occur due to: (1) idle connection timeout (normal), ' +
        '(2) reverse proxy buffering (check proxy_buffering config), or (3) network interruption.',
      code,
      isProxyHint: true,
      isTransient: true,
    };
  }

  /**
   * Check for timeout patterns. Use case-insensitive matching for common timeout error codes:
   * - ETIMEDOUT: TCP connection timeout
   * - ESOCKETTIMEDOUT: Socket timeout
   * - "timed out" / "timeout": Generic timeout messages
   */
  const lowerMessage = rawMessage.toLowerCase();
  if (
    rawMessage.includes('ETIMEDOUT') ||
    rawMessage.includes('ESOCKETTIMEDOUT') ||
    lowerMessage.includes('timed out') ||
    lowerMessage.includes('timeout after') ||
    lowerMessage.includes('request timeout')
  ) {
    return {
      message: `SSE connection timed out: ${rawMessage}. If behind a reverse proxy, increase proxy_read_timeout.`,
      code,
      isProxyHint: true,
      isTransient: true,
    };
  }

  // Connection reset is often transient (server restart, proxy reload)
  if (rawMessage.includes('ECONNRESET')) {
    return {
      message: `SSE connection reset: ${rawMessage}. The server or proxy may have restarted.`,
      code,
      isProxyHint: false,
      isTransient: true,
    };
  }

  // Connection refused is more serious - server may be down
  if (rawMessage.includes('ECONNREFUSED')) {
    return {
      message: `SSE connection refused: ${rawMessage}. Verify the MCP server is running and accessible.`,
      code,
      isProxyHint: false,
      isTransient: false,
    };
  }

  // DNS failure is usually a configuration issue, not transient
  if (rawMessage.includes('ENOTFOUND') || rawMessage.includes('getaddrinfo')) {
    return {
      message: `SSE DNS resolution failed: ${rawMessage}. Check the server URL is correct.`,
      code,
      isProxyHint: false,
      isTransient: false,
    };
  }

  /**
   * `StreamableHTTPError` and `SseError` carry the status on `code`, and their messages do not
   * always repeat it — "Failed to open SSE stream: Conflict" arrives here with no digits to
   * scan, so reading the message alone classified a 409 as an unrecognized fatal error. Prefer
   * the structured status; keep scanning the message for transports that only stringify it.
   */
  const statusMatch = rawMessage.match(/\b(4\d{2}|5\d{2})\b/);
  const scannedStatus = statusMatch ? parseInt(statusMatch[1], 10) : undefined;
  const carriesHttpStatus = code != null && code >= 400 && code < 600;
  const httpStatus = carriesHttpStatus ? code : scannedStatus;

  if (httpStatus != null) {
    /**
     * 5xx is transient by nature. 409 is transient by recovery: it reports a stale server-side
     * session that the rebuild clears on its own, with nothing for an operator to do. Every
     * other 4xx stays non-transient.
     */
    const isServerError = httpStatus >= 500 && httpStatus < 600;
    return {
      message: rawMessage,
      code: httpStatus,
      isProxyHint: httpStatus === 502 || httpStatus === 503 || httpStatus === 504,
      isTransient: isServerError || httpStatus === 409,
    };
  }

  /**
   * "fetch failed" is a generic undici TypeError that occurs when an in-flight HTTP request
   * is aborted (e.g. after an MCP protocol-level timeout fires). The transport itself is still
   * functional — only the individual request was lost — so treat this as transient.
   */
  if (rawMessage === 'fetch failed') {
    return {
      message:
        'fetch failed (request aborted, likely after a timeout — connection may still be usable)',
      code,
      isProxyHint: false,
      isTransient: true,
    };
  }

  return {
    message: rawMessage,
    code,
    isProxyHint: false,
    isTransient: false,
  };
}

/**
 * Custom error for MCP domain restriction violations.
 * Thrown when a user attempts to connect to an MCP server whose domain is not in the allowlist.
 */
export class MCPDomainNotAllowedError extends Error {
  public readonly code: 'MCP_DOMAIN_NOT_ALLOWED' = MCPErrorCodes.DOMAIN_NOT_ALLOWED;
  public readonly statusCode = 403;
  public readonly domain: string;

  constructor(domain: string) {
    super(`Domain "${domain}" is not allowed`);
    this.name = 'MCPDomainNotAllowedError';
    this.domain = domain;
    Object.setPrototypeOf(this, MCPDomainNotAllowedError.prototype);
  }
}

/**
 * Custom error for MCP server inspection failures.
 * Thrown when attempting to connect/inspect an MCP server fails.
 */
export class MCPInspectionFailedError extends Error {
  public readonly code: 'MCP_INSPECTION_FAILED' = MCPErrorCodes.INSPECTION_FAILED;
  public readonly statusCode = 400;
  public readonly serverName: string;

  constructor(serverName: string, cause?: Error) {
    super(`Failed to connect to MCP server "${serverName}"`);
    this.name = 'MCPInspectionFailedError';
    this.serverName = serverName;
    if (cause) {
      this.cause = cause;
    }
    Object.setPrototypeOf(this, MCPInspectionFailedError.prototype);
  }
}

/** Raised when an update would move a retained OAuth client secret across trust boundaries. */
export class MCPOAuthSecretReentryRequiredError extends Error {
  public readonly code: 'MCP_OAUTH_SECRET_REENTRY_REQUIRED' =
    MCPErrorCodes.OAUTH_SECRET_REENTRY_REQUIRED;

  public readonly statusCode = 400;
  public readonly changedFields: readonly string[];

  constructor(changedFields: readonly string[]) {
    super(
      `Re-enter oauth.client_secret when changing OAuth credential binding fields: ${changedFields.join(', ')}`,
    );
    this.name = 'MCPOAuthSecretReentryRequiredError';
    this.changedFields = changedFields;
    Object.setPrototypeOf(this, MCPOAuthSecretReentryRequiredError.prototype);
  }
}

/** Raised when an update would move a retained admin API key across request boundaries. */
export class MCPApiKeyReentryRequiredError extends Error {
  public readonly code: 'MCP_API_KEY_REENTRY_REQUIRED' = MCPErrorCodes.API_KEY_REENTRY_REQUIRED;

  public readonly statusCode = 400;
  public readonly changedFields: readonly string[];

  constructor(changedFields: readonly string[]) {
    super(
      `Re-enter apiKey.key when changing API key credential binding fields: ${changedFields.join(', ')}`,
    );
    this.name = 'MCPApiKeyReentryRequiredError';
    this.changedFields = changedFields;
    Object.setPrototypeOf(this, MCPApiKeyReentryRequiredError.prototype);
  }
}

/**
 * A tool invocation was rejected before LibreChat could know whether the MCP
 * server executed it. Recovery may prepare a later deliberate retry, but this
 * outcome never authorizes an automatic replay of the original call.
 */
export class MCPAuthenticationRejectedError extends Error {
  public readonly code: 'MCP_AUTHENTICATION_REJECTED' = MCPErrorCodes.AUTHENTICATION_REJECTED;
  public readonly statusCode = 403;
  public readonly retryable: boolean;

  constructor(
    public readonly serverName: string,
    public readonly connectionRefreshed: boolean,
    cause?: unknown,
  ) {
    super(
      connectionRefreshed
        ? `MCP server "${serverName}" rejected the bearer credential. The connection was refreshed; retry the tool deliberately.`
        : `MCP server "${serverName}" rejected the bearer credential. Please sign in again.`,
    );
    this.name = 'MCPAuthenticationRejectedError';
    this.retryable = connectionRefreshed;
    this.cause = cause;
    Object.setPrototypeOf(this, MCPAuthenticationRejectedError.prototype);
  }
}

/** A temporary upstream-session refresh failure, distinct from expired login state. */
export class MCPAuthenticationRefreshError extends Error {
  public readonly code: 'MCP_AUTHENTICATION_REFRESH_FAILED' =
    MCPErrorCodes.AUTHENTICATION_REFRESH_FAILED;

  public readonly statusCode = 503;
  public readonly retryable = true;

  constructor(cause?: unknown) {
    super('The OpenID session could not refresh the MCP bearer credential temporarily.');
    this.name = 'MCPAuthenticationRefreshError';
    this.cause = cause;
    Object.setPrototypeOf(this, MCPAuthenticationRefreshError.prototype);
  }
}

/**
 * Type guard to check if an error is an MCPDomainNotAllowedError
 */
export function isMCPDomainNotAllowedError(error: unknown): error is MCPDomainNotAllowedError {
  return error instanceof MCPDomainNotAllowedError;
}

/**
 * Type guard to check if an error is an MCPInspectionFailedError
 */
export function isMCPInspectionFailedError(error: unknown): error is MCPInspectionFailedError {
  return error instanceof MCPInspectionFailedError;
}

/** Type guard for OAuth client-secret binding violations. */
export function isMCPOAuthSecretReentryRequiredError(
  error: unknown,
): error is MCPOAuthSecretReentryRequiredError {
  return error instanceof MCPOAuthSecretReentryRequiredError;
}

/** Type guard for admin API-key binding violations. */
export function isMCPApiKeyReentryRequiredError(
  error: unknown,
): error is MCPApiKeyReentryRequiredError {
  return error instanceof MCPApiKeyReentryRequiredError;
}

export type MCPErrorResponse = {
  statusCode: number;
  body: {
    error: MCPErrorCode;
    message: string;
  };
};

/** Maps MCP errors to their public HTTP response without exposing attached causes or secrets. */
export function getMCPErrorResponse(error: unknown): MCPErrorResponse | null {
  if (
    isMCPDomainNotAllowedError(error) ||
    isMCPInspectionFailedError(error) ||
    isMCPOAuthSecretReentryRequiredError(error) ||
    isMCPApiKeyReentryRequiredError(error)
  ) {
    return {
      statusCode: error.statusCode,
      body: { error: error.code, message: error.message },
    };
  }

  const message =
    typeof error === 'object' &&
    error !== null &&
    'message' in error &&
    typeof error.message === 'string'
      ? error.message
      : undefined;
  if (!message) {
    return null;
  }

  if (message.startsWith(MCPErrorCodes.DOMAIN_NOT_ALLOWED)) {
    return {
      statusCode: 403,
      body: {
        error: MCPErrorCodes.DOMAIN_NOT_ALLOWED,
        message: message.replace(/^MCP_DOMAIN_NOT_ALLOWED\s*:\s*/i, ''),
      },
    };
  }

  if (message.startsWith(MCPErrorCodes.INSPECTION_FAILED)) {
    return {
      statusCode: 400,
      body: { error: MCPErrorCodes.INSPECTION_FAILED, message },
    };
  }

  if (message.startsWith(MCPErrorCodes.OAUTH_SECRET_REENTRY_REQUIRED)) {
    return {
      statusCode: 400,
      body: { error: MCPErrorCodes.OAUTH_SECRET_REENTRY_REQUIRED, message },
    };
  }

  return null;
}
