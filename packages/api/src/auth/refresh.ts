import { Types } from 'mongoose';
import { OPENID_SESSION_ENDED } from 'librechat-data-provider';
import { logger, DEFAULT_REFRESH_TOKEN_EXPIRY } from '@librechat/data-schemas';
import type { ProviderSessionRef } from 'librechat-data-provider';
import type { IUser } from '@librechat/data-schemas';
import type { FilterQuery } from 'mongoose';
import type {
  ProviderSessionAuthorizeInput,
  ProviderSessionAuthorizeOutcome,
} from '~/auth/openid/providerSession/authorize';
import type { RefreshTokenBridgeDeleteInput, RefreshTokenBridgeInput } from '~/auth/openid/types';
import type { ResolvedBackchannelLogoutConfig } from '~/auth/openid/providerSession/config';
import type { AdminExchangeResponse } from '~/auth/exchange';
import type { OpenIdSessionDeps } from '~/images/session';
import {
  extractProviderSessionRef,
  mergeProviderSessionRef,
  providerSessionCredentialExpiry,
} from '~/auth/openid/providerSession/ref';
import {
  ProviderSessionUnavailableError,
  isProviderSessionUnavailableError,
} from '~/auth/openid/providerSession/errors';
import {
  isUserIssuerAllowed,
  normalizeOpenIdIssuer,
  getIssuerBoundConditions,
} from '~/auth/openid';
import { serializeUserForExchange } from '~/auth/exchange';
import { storeOpenIdSession } from '~/images/session';
import { math } from '~/utils/math';

const SAFE_USER_PROJECTION = '-password -__v -totpSecret -backupCodes';

interface AdminRefreshClaims {
  sub?: string;
  iss?: string;
  sid?: unknown;
  [claim: string]: unknown;
}

/**
 * The minimal shape this module needs from an `openid-client` tokenset.
 * Avoids a hard import dependency on `openid-client` types in this package.
 */
export interface RefreshTokenset {
  access_token?: string;
  refresh_token?: string;
  claims: () => AdminRefreshClaims;
}

export interface OpenIDRefreshParams {
  scope?: string;
  audience?: string;
}

export interface MintedToken {
  /** Bearer the admin panel will send on subsequent requests. */
  token: string;
  /** Absolute expiry of `token` (ms epoch). Drives the admin panel's proactive refresh. */
  expiresAt: number;
}

export interface AdminRefreshDeps {
  findUsers: (
    filter: FilterQuery<IUser>,
    projection: string,
    options: { sort: Record<string, 1 | -1>; limit: number },
  ) => Promise<IUser[]>;
  getUserById: (id: string, projection: string) => Promise<IUser | null>;
  /**
   * Mints the bearer the admin panel will send on subsequent requests, and
   * reports its absolute expiry. The minter is authoritative for the bearer's
   * lifetime — the helper does not attempt to derive expiry from the IdP's
   * `exp` claim. Default OSS callers pass `generateToken(user, sessionExpiry)`
   * and `Date.now() + sessionExpiry`.
   */
  mintToken: (user: IUser, tokenset: RefreshTokenset) => Promise<MintedToken>;
  /**
   * Authorizes the resolved user against the same admin-access invariant
   * the initial OAuth callback enforces. The IdP refresh token can outlive
   * a capability/role change, so the bearer must not be reissued for a
   * user who no longer holds `ACCESS_ADMIN`. Optional only for backward
   * compatibility with existing callers; route handlers that mint admin
   * bearers should always inject this.
   */
  canAccessAdmin?: (user: IUser) => Promise<boolean>;
  /**
   * Re-runs the deployment's `registration.allowedDomains` check against the
   * resolved user's email. Returns true to allow refresh, false to reject.
   * Mirrors the domain check the initial OAuth callback enforces so a domain
   * removed from the allowlist after issuance can't refresh.
   */
  isEmailAllowed?: (user: IUser) => Promise<boolean>;
  /**
   * Optional post-success hook for forks that need to do additional work
   * with the refreshed tokenset and resolved user (e.g. update a server-side
   * token cache or reconcile downstream session state). Errors thrown here
   * propagate to the route handler.
   */
  onRefreshSuccess?: (user: IUser, tokenset: RefreshTokenset) => Promise<void>;
  /** Looks up the provider-session binding for a raw refresh token by its hash. Omitted skips
   *  the provider-session checks entirely. */
  findProviderSessionBinding?: (refreshToken: string) => Promise<{
    userId?: string;
    tenantId?: string;
    providerSession?: ProviderSessionRef | null;
  } | null>;
  /** Resolves the not-yet-spent rotated refresh token bridged from a prior attempt, keyed by the
   *  old (already-spent) token. */
  getRefreshTokenBridge?: (args: {
    oldRefreshToken: string;
    userId: string;
    tenantId?: string;
    openidIssuer?: string;
  }) => Promise<{ refreshToken: string; providerSession?: ProviderSessionRef } | null>;
  /** Stores the rotated refresh token under the just-spent one, so a retry after a
   *  {@link ProviderSessionUnavailableError} can recover without repeating the spent IdP grant. */
  storeRefreshTokenBridge?: (args: RefreshTokenBridgeInput) => Promise<string | null>;
  /** Removes a recovered bridge once it has served a successful refresh or a denial. */
  deleteRefreshTokenBridges?: (args: RefreshTokenBridgeDeleteInput) => Promise<object | null>;
  /** TTL for a bridge stored by this module; mirrors the main refresh path's grace window. */
  bridgeGraceMs?: number;
  /** Same checks as `authorizeProviderSession`, run before the IdP grant is spent. */
  preCheckProviderSession?: (
    input: Omit<ProviderSessionAuthorizeInput, 'legacy'>,
  ) => Promise<ProviderSessionAuthorizeOutcome>;
  /** Final authorization step before the response is returned. */
  authorizeProviderSession?: (
    input: ProviderSessionAuthorizeInput,
  ) => Promise<ProviderSessionAuthorizeOutcome>;
  /** Resolves the configured mode; decides fail-open (`record`) vs fail-closed (`enforce`)
   *  when a provider-session check itself fails. */
  getMode?: () => Promise<ResolvedBackchannelLogoutConfig['mode']>;
  /** `{ issuer, clientId }` for the configured OpenID provider; `null` ref extraction below
   *  skips entirely without a configured client. */
  getProviderSessionClient?: () => { issuer: string; clientId: string } | null;
  /** Persists the rotated refresh token's binding; mirrors `storeOpenIdSession`'s deps. */
  upsertSession?: OpenIdSessionDeps['upsertSession'];
  deleteSession?: OpenIdSessionDeps['deleteSession'];
}

export interface AdminRefreshOptions {
  /**
   * Optional user `_id` from the previous admin-panel session. When provided,
   * the resolved user must have a matching `openidId` — otherwise the refresh
   * is rejected as a possible identity-swap attempt.
   */
  userId?: string;
  /**
   * The refresh token the admin panel sent in. Preserved as the response
   * `refreshToken` when the IdP doesn't rotate (Auth0 with rotation off,
   * Microsoft personal accounts in some flows). Without this fallback, the
   * admin panel would receive `undefined` and lose its refresh capability.
   */
  previousRefreshToken?: string;
  /**
   * The refresh token actually sent to the IdP's refresh grant (a bridged
   * replacement when {@link resolveAdminRefreshToken} recovered one). Takes
   * priority over `previousRefreshToken` as the no-rotation fallback, so a
   * bridge is never retried against an IdP grant that already spent it.
   */
  grantRefreshToken?: string;
  /**
   * Issuer URL of the OpenID provider this server trusts. When provided
   * alongside an `iss` claim on the refreshed tokenset, the helper rejects
   * the refresh if the two don't match. Defends against tokensets emitted
   * by an unexpected issuer, even though `IUser` lookup is still keyed by
   * `openidId` alone.
   */
  expectedIssuer?: string;
  /**
   * Trusted tenant id resolved by the route layer (e.g. `getTenantId()` from
   * the pre-auth tenant ALS scope). When provided, the helper:
   *   - constrains the fallback `findUsers` lookup with `tenantId`, and
   *   - asserts a direct `getUserById` result has a matching `tenantId`,
   * so the same `(sub, iss)` existing in another tenant can never resolve
   * here. Multi-tenant deployments MUST pass this. Single-tenant deployments
   * may omit it.
   */
  tenantId?: string;
  /** The provider-session ref from {@link precheckAdminRefreshBinding}, reconciled against the
   *  refreshed id_token's `sid` claim before the response is returned. */
  boundProviderSession?: ProviderSessionRef | null;
}

export class AdminRefreshError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'AdminRefreshError';
  }
}

export function buildOpenIDRefreshParams(): OpenIDRefreshParams {
  const params: OpenIDRefreshParams = {};

  if (process.env.OPENID_SCOPE) {
    params.scope = process.env.OPENID_SCOPE;
  }

  if (process.env.OPENID_REFRESH_AUDIENCE) {
    params.audience = process.env.OPENID_REFRESH_AUDIENCE;
  }

  return params;
}

export interface AdminRefreshBinding {
  ref: ProviderSessionRef | null;
}

/** Rechecks the provider-session binding before the IdP grant is spent, so a denial never
 *  reaches the IdP. */
export async function precheckAdminRefreshBinding(
  refreshToken: string,
  deps: Pick<
    AdminRefreshDeps,
    'findProviderSessionBinding' | 'preCheckProviderSession' | 'getMode'
  >,
): Promise<AdminRefreshBinding> {
  if (!deps.findProviderSessionBinding || !deps.preCheckProviderSession) {
    return { ref: null };
  }

  let binding: { providerSession?: ProviderSessionRef | null } | null;
  try {
    binding = await deps.findProviderSessionBinding(refreshToken);
  } catch (error) {
    const mode = await deps.getMode?.();
    if (mode === 'enforce') {
      logger.error('[precheckAdminRefreshBinding] provider-session binding lookup unavailable', {
        error,
      });
      throw new ProviderSessionUnavailableError('Provider session check unavailable', {
        cause: error,
      });
    }
    logger.warn(
      '[precheckAdminRefreshBinding] provider-session binding lookup unavailable; continuing in record mode',
      { error },
    );
    return { ref: null };
  }

  const ref = binding?.providerSession ?? null;
  const expiresAt = providerSessionCredentialExpiry(
    new Date(),
    math(process.env.REFRESH_TOKEN_EXPIRY, DEFAULT_REFRESH_TOKEN_EXPIRY),
  );
  const outcome = await deps.preCheckProviderSession({ ref, expiresAt });
  if (!outcome.ok) {
    throw new AdminRefreshError(OPENID_SESSION_ENDED, 401, 'Provider session has ended');
  }
  return { ref };
}

export interface AdminRefreshTokenResolution {
  /** The token to send to the IdP's refresh grant: the incoming token, or a bridged
   *  replacement when the incoming token was already spent by a prior attempt. */
  refreshToken: string;
  bridged: boolean;
  /** Removes the recovered bridge; present only when `bridged` is true. The caller runs this
   *  after a successful refresh or a denial, never after an unavailable check. */
  releaseBridge?: () => Promise<void>;
}

/**
 * Recovers from a prior attempt that spent the incoming refresh token at the IdP but could not
 * persist the rotated one (an {@link ProviderSessionUnavailableError} between the grant and
 * storage). Looks up a bridge from the incoming token before the IdP grant is spent again, so a
 * retry reuses the still-unspent rotated token instead of repeating a doomed grant.
 */
export async function resolveAdminRefreshToken(
  refreshToken: string,
  deps: Pick<
    AdminRefreshDeps,
    'findProviderSessionBinding' | 'getRefreshTokenBridge' | 'deleteRefreshTokenBridges'
  >,
  options: { expectedIssuer?: string } = {},
): Promise<AdminRefreshTokenResolution> {
  if (!deps.findProviderSessionBinding || !deps.getRefreshTokenBridge) {
    return { refreshToken, bridged: false };
  }

  let binding: { userId?: string; tenantId?: string } | null;
  try {
    binding = await deps.findProviderSessionBinding(refreshToken);
  } catch (error) {
    logger.warn('[resolveAdminRefreshToken] Provider-session binding lookup failed', { error });
    return { refreshToken, bridged: false };
  }

  const userId = binding?.userId;
  if (!userId) {
    return { refreshToken, bridged: false };
  }

  const tenantId = binding?.tenantId;
  const openidIssuer = normalizeOpenIdIssuer(options.expectedIssuer);
  let bridge: { refreshToken: string } | null;
  try {
    bridge = await deps.getRefreshTokenBridge({
      oldRefreshToken: refreshToken,
      userId,
      tenantId,
      openidIssuer,
    });
  } catch (error) {
    logger.warn('[resolveAdminRefreshToken] Refresh-token bridge lookup failed', { error });
    return { refreshToken, bridged: false };
  }

  if (!bridge?.refreshToken) {
    return { refreshToken, bridged: false };
  }

  return {
    refreshToken: bridge.refreshToken,
    bridged: true,
    releaseBridge: async () => {
      if (!deps.deleteRefreshTokenBridges) return;
      try {
        await deps.deleteRefreshTokenBridges({ refreshTokens: [refreshToken], userId, tenantId });
      } catch (error) {
        logger.warn('[resolveAdminRefreshToken] Failed to remove the recovered bridge', { error });
      }
    },
  };
}

/**
 * Runs `run` — the admin-panel-shaped completion of an IdP refresh grant — then releases a
 * recovered refresh-token bridge on success or on a confirmed {@link OPENID_SESSION_ENDED}
 * denial. Never releases on an unavailable check, so a retry can still recover the bridge.
 */
export async function finalizeAdminOpenIdRefresh<T>(
  run: () => Promise<T>,
  releaseBridge?: () => Promise<void>,
): Promise<T> {
  try {
    const result = await run();
    await releaseBridge?.();
    return result;
  } catch (error) {
    if (error instanceof AdminRefreshError && error.code === OPENID_SESSION_ENDED) {
      await releaseBridge?.();
    }
    throw error;
  }
}

function applyTenantFilter(
  filter: FilterQuery<IUser>,
  tenantId: string | undefined,
): FilterQuery<IUser> {
  return tenantId ? ({ ...filter, tenantId } as FilterQuery<IUser>) : filter;
}

async function findLatestAdminUser(
  deps: AdminRefreshDeps,
  filters: FilterQuery<IUser>[],
  tenantId: string | undefined,
): Promise<IUser | undefined> {
  let latestUser: IUser | undefined;

  for (const baseFilter of filters) {
    const [user] = await deps.findUsers(
      applyTenantFilter(baseFilter, tenantId),
      SAFE_USER_PROJECTION,
      {
        sort: { updatedAt: -1 },
        limit: 1,
      },
    );
    if (!user) continue;
    if (!latestUser || (user.updatedAt?.getTime() ?? 0) > (latestUser.updatedAt?.getTime() ?? 0)) {
      latestUser = user;
    }
  }

  return latestUser;
}

async function resolveAdminUser(
  deps: AdminRefreshDeps,
  openidId: string,
  normalizedIssuer: string | undefined,
  options: AdminRefreshOptions,
): Promise<IUser | undefined> {
  const expectedTenantId = options.tenantId;

  if (options.userId && Types.ObjectId.isValid(options.userId)) {
    const direct = await deps.getUserById(options.userId as string, SAFE_USER_PROJECTION);
    if (direct) {
      if (direct.openidId !== openidId) {
        throw new AdminRefreshError(
          'USER_ID_MISMATCH',
          401,
          'Provided user_id does not match the refreshed identity',
        );
      }
      if (!isUserIssuerAllowed(direct, normalizedIssuer)) {
        throw new AdminRefreshError(
          'USER_ID_MISMATCH',
          401,
          'Provided user_id matches sub but issuer differs from the refreshed identity',
        );
      }
      if (expectedTenantId && direct.tenantId !== expectedTenantId) {
        throw new AdminRefreshError(
          'TENANT_MISMATCH',
          401,
          'Provided user_id resolves outside the request tenant',
        );
      }
      return direct;
    }
    logger.debug(
      `[adminRefresh] user_id ${options.userId} not found; falling through to openidId lookup`,
    );
  }

  const issuerBound = getIssuerBoundConditions('openidId', openidId, normalizedIssuer);
  const filters =
    issuerBound.length > 0 ? issuerBound : ([{ openidId }] as Array<FilterQuery<IUser>>);

  return findLatestAdminUser(deps, filters, expectedTenantId);
}

function readClaims(tokenset: RefreshTokenset): AdminRefreshClaims {
  try {
    return tokenset.claims();
  } catch (err) {
    const error = err as { name?: string; message?: string };
    logger.warn('[adminRefresh] tokenset.claims() threw', {
      name: error?.name,
      message: error?.message,
    });
    throw new AdminRefreshError(
      'CLAIMS_INCOMPLETE',
      502,
      'IdP returned a tokenset whose claims could not be read (no id_token?)',
    );
  }
}

/**
 * Looks up the active admin user for a freshly-refreshed OpenID tokenset,
 * mints the bearer the admin panel should send on subsequent requests, and
 * returns the response shape used by `/api/admin/oauth/exchange`.
 *
 * The route handler is responsible for the IdP `refreshTokenGrant` call;
 * this helper takes the resulting tokenset and turns it into an admin-panel
 * exchange response.
 */
export async function applyAdminRefresh(
  tokenset: RefreshTokenset,
  deps: AdminRefreshDeps,
  options: AdminRefreshOptions = {},
): Promise<AdminExchangeResponse> {
  if (!tokenset.access_token) {
    throw new AdminRefreshError(
      'IDP_INCOMPLETE',
      502,
      'IdP returned an incomplete tokenset (missing access_token)',
    );
  }

  const claims = readClaims(tokenset);
  const openidId = claims.sub;
  if (!openidId) {
    throw new AdminRefreshError(
      'CLAIMS_INCOMPLETE',
      502,
      'IdP returned a tokenset missing the required `sub` claim',
    );
  }

  const expected = normalizeOpenIdIssuer(options.expectedIssuer);
  const actual = normalizeOpenIdIssuer(claims.iss);
  if (expected && actual && expected !== actual) {
    throw new AdminRefreshError(
      'ISSUER_MISMATCH',
      401,
      'Refreshed tokenset was issued by an unexpected issuer',
    );
  }

  const user = await resolveAdminUser(deps, openidId, expected, options);
  if (!user) {
    throw new AdminRefreshError('USER_NOT_FOUND', 401, 'No user found for the refreshed identity');
  }

  if (deps.isEmailAllowed && !(await deps.isEmailAllowed(user))) {
    throw new AdminRefreshError(
      'FORBIDDEN',
      403,
      'User email domain is not on the deployment allowlist',
    );
  }

  if (deps.canAccessAdmin && !(await deps.canAccessAdmin(user))) {
    throw new AdminRefreshError('FORBIDDEN', 403, 'User does not have admin access');
  }

  const minted = await deps.mintToken(user, tokenset);

  if (deps.onRefreshSuccess) {
    await deps.onRefreshSuccess(user, tokenset);
  }

  if (deps.authorizeProviderSession) {
    const client = deps.getProviderSessionClient?.() ?? null;
    const refreshedRef = client
      ? extractProviderSessionRef(claims, { issuer: client.issuer, clientId: client.clientId })
      : null;
    const merged = mergeProviderSessionRef(options.boundProviderSession ?? null, refreshedRef);
    if (!merged.ok) {
      throw new AdminRefreshError(
        OPENID_SESSION_ENDED,
        401,
        'Provider session id changed during refresh',
      );
    }

    const providerSessionExpiresAt = providerSessionCredentialExpiry(
      new Date(),
      math(process.env.REFRESH_TOKEN_EXPIRY, DEFAULT_REFRESH_TOKEN_EXPIRY),
    );
    let outcome: ProviderSessionAuthorizeOutcome;
    try {
      outcome = await deps.authorizeProviderSession({
        ref: merged.ref,
        subject: openidId,
        expiresAt: providerSessionExpiresAt,
        legacy: merged.ref == null,
      });
    } catch (error) {
      if (isProviderSessionUnavailableError(error) && deps.storeRefreshTokenBridge) {
        const rotatedRefreshToken = tokenset.refresh_token;
        if (rotatedRefreshToken && options.previousRefreshToken) {
          try {
            await deps.storeRefreshTokenBridge({
              oldRefreshToken: options.previousRefreshToken,
              newRefreshToken: rotatedRefreshToken,
              userId: String(user._id),
              tenantId: options.tenantId,
              openidIssuer: normalizeOpenIdIssuer(options.expectedIssuer),
              ttl: deps.bridgeGraceMs,
              providerSession: merged.ref ?? undefined,
            });
          } catch (bridgeError) {
            logger.warn(
              '[adminRefresh] Failed to preserve the rotated refresh token after an unavailable provider-session check',
              { error: bridgeError },
            );
          }
        }
      }
      throw error;
    }
    if (!outcome.ok) {
      throw new AdminRefreshError(OPENID_SESSION_ENDED, 401, 'Provider session has ended');
    }

    if (deps.upsertSession && deps.deleteSession) {
      const rotatedRefreshToken =
        tokenset.refresh_token ?? options.grantRefreshToken ?? options.previousRefreshToken;
      if (rotatedRefreshToken) {
        const mode = await deps.getMode?.();
        await storeOpenIdSession(
          {
            userId: String(user._id),
            refreshToken: rotatedRefreshToken,
            tenantId: options.tenantId,
            previousRefreshToken: options.previousRefreshToken,
            providerSession: mode === 'off' ? undefined : merged.ref,
            authMethod: 'openid',
          },
          { upsertSession: deps.upsertSession, deleteSession: deps.deleteSession },
        );
      }
    }
  }

  const responseUser = serializeUserForExchange(user);

  logger.debug(`[adminRefresh] Refreshed tokens for user: ${responseUser.id}`);

  return {
    token: minted.token,
    refreshToken:
      tokenset.refresh_token ?? options.grantRefreshToken ?? options.previousRefreshToken,
    user: responseUser,
    expiresAt: minted.expiresAt,
  };
}
