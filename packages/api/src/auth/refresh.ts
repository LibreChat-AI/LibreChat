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
  isUserIssuerAllowed,
  normalizeOpenIdIssuer,
  getIssuerBoundConditions,
} from '~/auth/openid';
import { ProviderSessionUnavailableError } from '~/auth/openid/providerSession/errors';
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

/** The provider-session binding for a presented refresh token, read once per request and shared
 *  by the precheck and the bridge resolution. */
export interface AdminRefreshBindingLookup {
  userId?: string;
  tenantId?: string;
  providerSession?: ProviderSessionRef | null;
  /** Verified subject for the bound session, when the lookup source tracks one. Passed through
   *  to the precheck so it can be rejected against a conflicting subject, mirroring the main
   *  refresh path's `sessionTokens.openidSubject`. */
  subject?: string;
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
  findProviderSessionBinding?: (refreshToken: string) => Promise<AdminRefreshBindingLookup | null>;
  /** Resolves the not-yet-spent rotated refresh token bridged from a prior attempt, keyed by the
   *  old (already-spent) token. */
  getRefreshTokenBridge?: (args: {
    oldRefreshToken: string;
    userId: string;
    tenantId?: string;
    openidIssuer?: string;
  }) => Promise<{ refreshToken: string; providerSession?: ProviderSessionRef } | null>;
  /** Stores the rotated refresh token under the just-spent one immediately after the IdP grant,
   *  so a retry after any later failure can recover without repeating the spent grant. */
  storeRefreshTokenBridge?: (args: RefreshTokenBridgeInput) => Promise<string | null>;
  /** Removes a recovered bridge by version, only on a confirmed `OPENID_SESSION_ENDED` denial. */
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
   * Also the bridge's lookup key: the admin panel always retries with this
   * same token, never with whatever was actually sent to the IdP.
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
  /**
   * Identity the bridge lookup resolved (`binding?.userId ?? options.userId`,
   * `binding?.tenantId ?? options.tenantId` — see {@link resolveAdminRefreshToken}). Used to key
   * the post-grant bridge store so it lands on the same row a retry's lookup will find, even when
   * a later step (e.g. the user lookup itself) fails before a user is resolved.
   */
  bridgeIdentity?: { userId?: string; tenantId?: string };
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

/** Outcome of the single `findProviderSessionBinding` read shared by
 *  {@link precheckAdminRefreshBinding} and {@link resolveAdminRefreshToken}. A thrown lookup
 *  surfaces as `{ ok: false }` instead of being re-thrown here, because the two callers apply
 *  different failure policies for the same failure: the precheck can fail open in `record` mode,
 *  but the bridge resolution that decides what to send the IdP never can. */
export type AdminRefreshBindingLookupOutcome =
  | { ok: true; binding: AdminRefreshBindingLookup | null }
  | { ok: false };

/** The single provider-session binding read for a presented refresh token. */
export async function lookupAdminRefreshBinding(
  refreshToken: string,
  deps: Pick<AdminRefreshDeps, 'findProviderSessionBinding'>,
): Promise<AdminRefreshBindingLookupOutcome> {
  if (!deps.findProviderSessionBinding) {
    return { ok: true, binding: null };
  }
  try {
    return { ok: true, binding: await deps.findProviderSessionBinding(refreshToken) };
  } catch (error) {
    logger.warn('[adminRefresh] provider-session binding lookup failed', { error });
    return { ok: false };
  }
}

/** Rechecks the provider-session binding before the IdP grant is spent, so a denial never
 *  reaches the IdP. Takes the already-fetched {@link lookupAdminRefreshBinding} outcome rather
 *  than reading the binding itself, so a single DB read serves both the precheck and
 *  {@link resolveAdminRefreshToken}. */
export async function precheckAdminRefreshBinding(
  lookup: AdminRefreshBindingLookupOutcome,
  deps: Pick<AdminRefreshDeps, 'preCheckProviderSession' | 'getMode'>,
): Promise<AdminRefreshBinding> {
  if (!deps.preCheckProviderSession) {
    return { ref: null };
  }

  let binding: AdminRefreshBindingLookup | null;
  if (!lookup.ok) {
    const mode = await deps.getMode?.();
    if (mode === 'enforce') {
      logger.error('[precheckAdminRefreshBinding] provider-session binding lookup unavailable');
      throw new ProviderSessionUnavailableError('Provider session check unavailable');
    }
    logger.warn(
      '[precheckAdminRefreshBinding] provider-session binding lookup unavailable; continuing in record mode',
    );
    binding = null;
  } else {
    binding = lookup.binding;
  }

  const ref = binding?.providerSession ?? null;
  const expiresAt = providerSessionCredentialExpiry(
    new Date(),
    math(process.env.REFRESH_TOKEN_EXPIRY, DEFAULT_REFRESH_TOKEN_EXPIRY),
  );
  const outcome = await deps.preCheckProviderSession({ ref, subject: binding?.subject, expiresAt });
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
  /** Identity the bridge lookup resolved, present whenever a `userId` was resolvable (from the
   *  binding or from `options.userId`), independent of whether a bridge was actually found.
   *  Feeds the post-grant bridge store in {@link applyAdminRefresh} via
   *  `options.bridgeIdentity`. */
  identity?: { userId: string; tenantId?: string; openidIssuer?: string };
}

/**
 * Recovers from a prior attempt that spent the incoming refresh token at the IdP but failed
 * afterward. Looks up a bridge from the incoming token before the IdP grant is spent again, so a
 * retry reuses the still-unspent rotated token instead of repeating a doomed grant.
 *
 * A failed lookup (the merged binding read, or the bridge read itself) always throws
 * {@link ProviderSessionUnavailableError} rather than falling back to the presented token: the
 * presented token may already be spent, and sending it to the IdP again is a doomed grant the
 * caller must not attempt, in `record` mode as much as in `enforce` mode.
 */
export async function resolveAdminRefreshToken(
  refreshToken: string,
  lookup: AdminRefreshBindingLookupOutcome,
  deps: Pick<AdminRefreshDeps, 'getRefreshTokenBridge'>,
  options: { expectedIssuer?: string; userId?: string; tenantId?: string } = {},
): Promise<AdminRefreshTokenResolution> {
  if (!deps.getRefreshTokenBridge) {
    return { refreshToken, bridged: false };
  }

  if (!lookup.ok) {
    throw new ProviderSessionUnavailableError('Provider session check unavailable');
  }

  const userId = lookup.binding?.userId ?? options.userId;
  if (!userId) {
    return { refreshToken, bridged: false };
  }

  const tenantId = lookup.binding?.tenantId ?? options.tenantId;
  const openidIssuer = normalizeOpenIdIssuer(options.expectedIssuer);
  const identity = { userId, tenantId, openidIssuer };

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
    throw new ProviderSessionUnavailableError('Provider session check unavailable', {
      cause: error,
    });
  }

  if (!bridge?.refreshToken) {
    return { refreshToken, bridged: false, identity };
  }

  return { refreshToken: bridge.refreshToken, bridged: true, identity };
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
 *
 * When `deps.authorizeProviderSession` is wired (deployment mode is not `off`), the rotated
 * refresh token is bridged under the presented one immediately after the grant — before the user
 * lookup, the admin-access checks, the final authorization, or the session persistence can fail —
 * so a client retry with the same presented token always recovers the already-spent grant's
 * result instead of repeating a doomed grant. The bridge is kept on every outcome except a
 * confirmed `OPENID_SESSION_ENDED` denial, where it is deleted by version so a retry's lookup
 * finds nothing and is told, correctly, to sign in again.
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

  const rotatedRefreshToken = tokenset.refresh_token;
  const sessionRefreshToken =
    tokenset.refresh_token ?? options.grantRefreshToken ?? options.previousRefreshToken;
  const bridgeUserId = options.bridgeIdentity?.userId ?? options.userId;
  const bridgeTenantId = options.bridgeIdentity?.tenantId ?? options.tenantId;
  const openidIssuer = normalizeOpenIdIssuer(options.expectedIssuer);

  let mergedRef: ProviderSessionRef | null = null;
  let bridgeVersion: string | null = null;

  if (deps.authorizeProviderSession) {
    const client = deps.getProviderSessionClient?.() ?? null;
    const refreshedRef = client
      ? extractProviderSessionRef(claims, { issuer: client.issuer, clientId: client.clientId })
      : null;
    const merge = mergeProviderSessionRef(options.boundProviderSession ?? null, refreshedRef);
    if (!merge.ok) {
      throw new AdminRefreshError(
        OPENID_SESSION_ENDED,
        401,
        'Provider session id changed during refresh',
      );
    }
    mergedRef = merge.ref;

    if (
      deps.storeRefreshTokenBridge &&
      rotatedRefreshToken &&
      options.previousRefreshToken &&
      bridgeUserId
    ) {
      try {
        bridgeVersion = await deps.storeRefreshTokenBridge({
          oldRefreshToken: options.previousRefreshToken,
          newRefreshToken: rotatedRefreshToken,
          userId: bridgeUserId,
          tenantId: bridgeTenantId,
          openidIssuer,
          ttl: deps.bridgeGraceMs,
          providerSession: mergedRef ?? undefined,
        });
      } catch (bridgeError) {
        logger.warn('[adminRefresh] Failed to store the refresh-token bridge after the IdP grant', {
          error: bridgeError,
        });
      }
    }
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

  if (deps.authorizeProviderSession) {
    const providerSessionExpiresAt = providerSessionCredentialExpiry(
      new Date(),
      math(process.env.REFRESH_TOKEN_EXPIRY, DEFAULT_REFRESH_TOKEN_EXPIRY),
    );
    const outcome = await deps.authorizeProviderSession({
      ref: mergedRef,
      subject: openidId,
      expiresAt: providerSessionExpiresAt,
      legacy: mergedRef == null,
    });
    if (!outcome.ok) {
      if (bridgeVersion && deps.deleteRefreshTokenBridges && options.previousRefreshToken) {
        try {
          await deps.deleteRefreshTokenBridges({
            refreshTokens: [options.previousRefreshToken],
            userId: bridgeUserId as string,
            tenantId: bridgeTenantId,
            version: bridgeVersion,
          });
        } catch (deleteError) {
          logger.warn(
            '[adminRefresh] Failed to remove the refresh-token bridge after a provider-session denial',
            { error: deleteError },
          );
        }
      }
      throw new AdminRefreshError(OPENID_SESSION_ENDED, 401, 'Provider session has ended');
    }

    if (deps.upsertSession && deps.deleteSession && sessionRefreshToken) {
      try {
        await storeOpenIdSession(
          {
            userId: String(user._id),
            refreshToken: sessionRefreshToken,
            tenantId: user.tenantId ?? options.tenantId,
            previousRefreshToken: options.previousRefreshToken,
            providerSession: mergedRef,
            authMethod: 'openid',
          },
          { upsertSession: deps.upsertSession, deleteSession: deps.deleteSession },
        );
      } catch (error) {
        const mode = await deps.getMode?.();
        if (mode === 'record') {
          logger.warn(
            '[adminRefresh] Failed to persist the refreshed session; tolerating in record mode',
            { error },
          );
        } else {
          throw new ProviderSessionUnavailableError('Failed to persist the refreshed session', {
            cause: error,
          });
        }
      }
    }
  }

  const minted = await deps.mintToken(user, tokenset);

  if (deps.onRefreshSuccess) {
    await deps.onRefreshSuccess(user, tokenset);
  }

  const responseUser = serializeUserForExchange(user);

  logger.debug(`[adminRefresh] Refreshed tokens for user: ${responseUser.id}`);

  return {
    token: minted.token,
    refreshToken: sessionRefreshToken,
    user: responseUser,
    expiresAt: minted.expiresAt,
  };
}
