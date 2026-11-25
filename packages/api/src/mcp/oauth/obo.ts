import { logger } from '@librechat/data-schemas';
import { Permissions, PermissionTypes } from 'librechat-data-provider';
import type { IUser, OIDCTokens } from '@librechat/data-schemas';
import type { TRole } from 'librechat-data-provider';
import type { AuthIdentityContext } from '~/utils/identity';
import type { OpenIDTokenInfo } from '~/utils/oidc';
import type { MCPOAuthTokens } from './types';
import { getSkewedTokenExpiresAtMs, getTokenExpiresAtMs } from '~/oauth/expiry';
import { extractOpenIDTokenInfo, isOpenIDTokenValid } from '~/utils/oidc';
import { detachOnAbort } from '~/utils/promises';
import { isAbortError } from '~/utils/errors';

export interface OboConfig {
  scopes: string;
}

/**
 * Function type for performing OBO token exchange.
 * Injected from the main API layer since it requires OpenID configuration and caching.
 */
export type OboTokenResolver = (
  user: IUser,
  accessToken: string,
  scopes: string,
  fromCache?: boolean,
  identityContext?: AuthIdentityContext,
) => Promise<{ access_token: string; expires_in?: number; expires_at?: number }>;

/**
 * Provides the LIVE upstream OpenID tokens at OBO call time, refreshing the
 * server-side session via the IdP refresh-token grant when the access token
 * has expired. Closes over the active Express request so it can read/write
 * `req.session.openidTokens` in place.
 *
 * Contract:
 *   - non-null result: `access_token` MUST be populated; the closure enforces
 *     this internally so callers do not defend against missing access_token.
 *   - null: not applicable, or a bearer-authenticated remote-agent request whose
 *     current upstream token can be read from `user.federatedTokens`.
 *   - throws: refresh was attempted and the IdP rejected it. Caller wraps as
 *     `session_refresh_failed`.
 */
export type UpstreamTokenProvider = (options?: {
  forceRefresh?: boolean;
  signal?: AbortSignal;
}) => Promise<OIDCTokens | null>;

/** Target resolved from server configuration after the OBO trust check. Scopes are not an audience. */
export interface UpstreamTokenTarget {
  readonly mcpServer: string;
  readonly scopes: string;
}

/** Lazily supplies a renewable upstream-token provider when an OBO server actually needs one. */
export type UpstreamTokenProviderResolver = (options?: {
  signal?: AbortSignal;
  target?: UpstreamTokenTarget;
}) => UpstreamTokenProvider | undefined | Promise<UpstreamTokenProvider | undefined>;

/** Scheduled OBO credentials must not replace the browser's direct-bearer source. */
export function selectMCPUpstreamTokenProvider({
  upstreamTokenProvider,
  upstreamTokenProviderResolver,
  createSessionProvider,
}: {
  upstreamTokenProvider?: UpstreamTokenProvider | null;
  upstreamTokenProviderResolver?: UpstreamTokenProviderResolver | null;
  createSessionProvider: () => UpstreamTokenProvider;
}): UpstreamTokenProvider | null | undefined {
  return upstreamTokenProviderResolver
    ? upstreamTokenProvider
    : (upstreamTokenProvider ?? createSessionProvider());
}

function normalizeOboCancellation(error: unknown, signal?: AbortSignal): unknown {
  if (signal?.aborted && error === signal.reason && !isAbortError(error)) {
    return Object.assign(new Error('The operation was aborted.', { cause: error }), {
      name: 'AbortError',
    });
  }
  return error;
}

/** Detach cancelled callers and preserve cancellation for arbitrary AbortController reasons. */
export async function awaitOboOperation<T>(
  operation: Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  try {
    return await detachOnAbort(operation, signal);
  } catch (error) {
    throw normalizeOboCancellation(error, signal);
  }
}

/** Keep lookup failures inside resolveOboToken's typed failure boundary. */
export function createLazyOboUpstreamTokenProvider(
  resolver: UpstreamTokenProviderResolver,
  signal?: AbortSignal,
  target?: UpstreamTokenTarget,
): UpstreamTokenProvider {
  let pending: Promise<UpstreamTokenProvider | undefined> | undefined;
  return async (options) => {
    const effectiveSignal = options?.signal ?? signal;
    try {
      effectiveSignal?.throwIfAborted();
      pending ??= Promise.resolve()
        .then(() => {
          effectiveSignal?.throwIfAborted();
          return resolver({ signal: effectiveSignal, ...(target ? { target } : {}) });
        })
        .catch((error) => {
          pending = undefined;
          throw error;
        });
      const provider = await detachOnAbort(pending, effectiveSignal);
      effectiveSignal?.throwIfAborted();
      if (!provider) {
        pending = undefined;
        throw new OboTokenResolutionError(
          'missing_upstream_provider',
          'No renewable upstream credential provider is available for this MCP server.',
        );
      }
      return await detachOnAbort(
        provider({ ...options, signal: effectiveSignal }),
        effectiveSignal,
      );
    } catch (error) {
      throw normalizeOboCancellation(error, effectiveSignal);
    }
  };
}

export type OboTokenResolutionReason =
  | 'missing_upstream_provider'
  | 'missing_upstream_token'
  | 'missing_upstream_access_token'
  | 'empty_exchange_response'
  | 'exchange_failed'
  | 'session_refresh_failed';

const RETRYABLE_OBO_STATUS_CODES = new Set([429, 500, 502, 503, 504]);
const RETRYABLE_OBO_ERROR_CODES = new Set(['ETIMEDOUT', 'ECONNRESET', 'EAI_AGAIN', 'ENOTFOUND']);

function getErrorStatus(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') {
    return undefined;
  }

  const candidate = error as {
    status?: number;
    statusCode?: number;
    response?: { status?: number };
  };

  return candidate.status ?? candidate.statusCode ?? candidate.response?.status;
}

function getErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object' || !('code' in error)) {
    return undefined;
  }

  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code.toUpperCase() : undefined;
}

function getErrorRetryableFlag(error: unknown): boolean | undefined {
  if (!error || typeof error !== 'object' || !('retryable' in error)) {
    return undefined;
  }

  const retryable = (error as { retryable?: unknown }).retryable;
  return typeof retryable === 'boolean' ? retryable : undefined;
}

function getOboFailureReason(error: unknown): OboTokenResolutionReason | undefined {
  if (!error || typeof error !== 'object' || !('oboFailureReason' in error)) {
    return undefined;
  }

  const reason = (error as { oboFailureReason?: unknown }).oboFailureReason;
  if (reason === 'empty_exchange_response') {
    return reason;
  }

  return undefined;
}

export class OboTokenResolutionError extends Error {
  public readonly reason: OboTokenResolutionReason;
  public readonly retryable: boolean;
  public readonly userMessage: string;
  public override readonly cause?: unknown;

  constructor(
    reason: OboTokenResolutionReason,
    userMessage: string,
    retryable = false,
    cause?: unknown,
  ) {
    super(userMessage);
    this.name = 'OboTokenResolutionError';
    this.reason = reason;
    this.retryable = retryable;
    this.userMessage = userMessage;
    this.cause = cause;
  }
}

export function isRetryableOboExchangeError(error: unknown): boolean {
  const taggedRetryable = getErrorRetryableFlag(error);
  if (taggedRetryable != null) {
    return taggedRetryable;
  }

  const status = getErrorStatus(error);
  if (status != null && RETRYABLE_OBO_STATUS_CODES.has(status)) {
    return true;
  }

  const code = getErrorCode(error);
  if (code != null && RETRYABLE_OBO_ERROR_CODES.has(code)) {
    return true;
  }

  if (!error || typeof error !== 'object' || !('message' in error)) {
    return false;
  }

  const message = String((error as { message?: unknown }).message ?? '').toLowerCase();
  return (
    message.includes('timed out') ||
    message.includes('timeout') ||
    message.includes('econnreset') ||
    message.includes('socket hang up') ||
    message.includes('temporarily unavailable') ||
    message.includes('too many requests') ||
    message.includes('service unavailable')
  );
}

/**
 * Resolves the upstream OpenID token info used for the OBO exchange. The live
 * session (via `upstreamTokenProvider`) is the preferred source because it can
 * inline-refresh an expired access token. When no live session exists — the
 * OIDC remote-agent flow verifies a bearer token and attaches it to
 * `user.federatedTokens` without an Express session — fall back to the token
 * snapshot on the user via `extractOpenIDTokenInfo`. Returns null when neither
 * source yields a token; the caller maps that to `missing_upstream_token`.
 */
function buildUpstreamTokenInfo(
  user: IUser,
  liveTokens: OIDCTokens | null,
): OpenIDTokenInfo | null {
  if (liveTokens) {
    return {
      accessToken: liveTokens.access_token,
      idToken: liveTokens.id_token,
      expiresAt: liveTokens.expires_at,
      userId: user.openidId || user.id,
      userEmail: user.email,
      userName: user.name || user.username,
    };
  }
  return extractOpenIDTokenInfo(user);
}

/**
 * Performs an OBO token exchange for the given user and MCP server OBO config.
 * Returns MCPOAuthTokens suitable for injection into the MCP connection.
 *
 * The `upstreamTokenProvider` closure is the authoritative source of the user's
 * upstream OpenID access token at call time — it reads from the live session and
 * may inline-refresh via the IdP refresh-token grant when the token has expired.
 * This avoids relying on a stale snapshot frozen onto `user.federatedTokens` at
 * request validation, which is what previously caused the walk-away failure mode
 * ("No valid OpenID access token is available for OBO exchange") on long-running
 * tool calls. Required (not optional) so wiring bugs surface at compile time.
 *
 * When the provider yields no live session (it resolves to null), this falls
 * back to `user.federatedTokens` so the OIDC remote-agent flow — whose request
 * itself carries that verified upstream bearer — still works. Browser requests
 * whose Express session was cleared reject in the provider instead of reaching
 * this fallback with a stale strategy-time snapshot.
 *
 * @param forceRefresh Bypasses the resolver's token cache. Set it when the downstream
 * server has rejected the current credential: a revoked or scope-invalidated token is
 * still inside its cached lifetime, so a cached read would hand back the same rejected
 * bearer instead of minting a replacement.
 */
export async function resolveOboToken(
  user: IUser,
  oboConfig: OboConfig,
  oboTokenResolver: OboTokenResolver,
  upstreamTokenProvider: UpstreamTokenProvider,
  identityContext?: AuthIdentityContext,
  forceRefresh = false,
): Promise<MCPOAuthTokens> {
  let liveTokens: OIDCTokens | null;
  try {
    liveTokens = await upstreamTokenProvider();
  } catch (error) {
    if (isAbortError(error)) throw error;
    if (error instanceof OboTokenResolutionError && error.reason === 'missing_upstream_provider') {
      throw error;
    }
    logger.error('[OBO] Upstream session refresh failed:', error);
    const retryable = isRetryableOboExchangeError(error);
    throw new OboTokenResolutionError(
      'session_refresh_failed',
      retryable
        ? 'Temporary sign-in session refresh failure.'
        : 'Your sign-in session expired and could not be refreshed. Please sign in again.',
      retryable,
      error,
    );
  }

  const tokenInfo = buildUpstreamTokenInfo(user, liveTokens);

  if (!tokenInfo || !isOpenIDTokenValid(tokenInfo)) {
    logger.warn(
      `[OBO] No valid OpenID token available for OBO exchange (provider: ${user.provider}, hasOpenidId: ${!!user.openidId}, hasFederatedTokens: ${!!user.federatedTokens}, hadLiveSession: ${!!liveTokens})`,
    );
    throw new OboTokenResolutionError(
      'missing_upstream_token',
      'No valid OpenID access token is available for OBO exchange.',
    );
  }

  if (!tokenInfo.accessToken) {
    logger.warn('[OBO] OpenID token info present but access_token is missing');
    throw new OboTokenResolutionError(
      'missing_upstream_access_token',
      'The upstream OpenID access token is missing for OBO exchange.',
    );
  }

  try {
    const response = await oboTokenResolver(
      user,
      tokenInfo.accessToken,
      oboConfig.scopes,
      !forceRefresh,
      identityContext,
    );

    if (!response?.access_token) {
      logger.warn('[OBO] Token exchange did not return an access token');
      throw new OboTokenResolutionError(
        'empty_exchange_response',
        'The identity provider returned no access token for the OBO exchange.',
      );
    }

    const now = Date.now();
    const expiresAt = getTokenExpiresAtMs({
      expiresAt: response.expires_at,
      expiresIn: response.expires_in,
      now,
    });

    /**
     * Preserving an elapsed expiry only helps if someone acts on it. `MCPManager.callTool` checks
     * the access token and nothing else before setting the Authorization header, so a credential
     * the IdP already declared spent would be sent downstream to fail there. Rejected here, where
     * the reason is still known, and retryably: the exchange itself worked, so another attempt
     * with a fresh grant can succeed.
     */
    const skewedExpiresAt = getSkewedTokenExpiresAtMs(expiresAt, now);
    if (skewedExpiresAt <= now) {
      logger.warn('[OBO] Token exchange returned a credential that is already expired');
      throw new OboTokenResolutionError(
        'exchange_failed',
        'The identity provider returned an already-expired token for the OBO exchange.',
        true,
      );
    }

    return {
      access_token: response.access_token,
      token_type: 'Bearer',
      obtained_at: now,
      expires_at: skewedExpiresAt,
    };
  } catch (error) {
    if (isAbortError(error)) throw error;
    if (error instanceof OboTokenResolutionError) {
      throw error;
    }

    const failureReason = getOboFailureReason(error);
    if (failureReason === 'empty_exchange_response') {
      logger.warn('[OBO] Token exchange did not return an access token');
      throw new OboTokenResolutionError(
        failureReason,
        'The identity provider returned no access token for the OBO exchange.',
        false,
        error,
      );
    }

    logger.error('[OBO] Failed to exchange token:', error);
    const retryable = isRetryableOboExchangeError(error);
    throw new OboTokenResolutionError(
      'exchange_failed',
      retryable
        ? 'Temporary OBO token exchange failure.'
        : 'The identity provider rejected the OBO token exchange.',
      retryable,
      error,
    );
  }
}

/**
 * Re-evaluates whether the original author of a DB-stored OBO config still has
 * permission to configure OBO. The connection layer calls this before performing
 * an OBO token exchange so that retained configs fail closed if the author's role
 * is downgraded after the server was created.
 *
 * Returns true when the author's role grants `MCP_SERVERS.CONFIGURE_OBO`. Any of
 * the following degraded states return false (fail closed):
 *   - missing author id
 *   - user lookup miss / no role
 *   - role lookup miss
 *   - role missing the CONFIGURE_OBO bit
 */
export type GetUserRoleByAuthorId = (authorId: string) => Promise<string | null | undefined>;
type RolePermissions = Partial<{
  [K in keyof TRole['permissions']]: Partial<TRole['permissions'][K]>;
}>;

export type GetRolePermissions = (roleName: string) => Promise<RolePermissions | null | undefined>;

export async function isOboConfigStillTrusted({
  authorId,
  getUserRoleByAuthorId,
  getRolePermissions,
}: {
  authorId: string | undefined;
  getUserRoleByAuthorId: GetUserRoleByAuthorId;
  getRolePermissions: GetRolePermissions;
}): Promise<boolean> {
  if (!authorId) {
    return false;
  }
  let roleName: string | null | undefined;
  try {
    roleName = await getUserRoleByAuthorId(authorId);
  } catch (err) {
    logger.warn('[OBO] Failed to resolve author role for OBO trust check', err);
    return false;
  }
  if (!roleName) {
    return false;
  }
  let permissions: RolePermissions | null | undefined;
  try {
    permissions = await getRolePermissions(roleName);
  } catch (err) {
    logger.warn('[OBO] Failed to load role permissions for OBO trust check', err);
    return false;
  }
  return permissions?.[PermissionTypes.MCP_SERVERS]?.[Permissions.CONFIGURE_OBO] === true;
}

/**
 * Async predicate injected into MCP runtime to gate OBO exchanges per server.
 * Returns true when OBO is allowed for the given config, false to fail closed.
 *
 * The runtime passes `source`, `author`, and `dbId` so the implementation can
 * use the same `isUserSourced` semantics as the rest of the MCP layer (a
 * missing `source` field on a legacy cached config still falls back to
 * `dbId`-presence heuristics).
 */
export type OboTrustChecker = (config: {
  source?: string;
  author?: string;
  dbId?: string;
}) => Promise<boolean>;
