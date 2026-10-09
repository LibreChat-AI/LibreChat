import { Types } from 'mongoose';
import { logger } from '@librechat/data-schemas';

import type { IUser } from '@librechat/data-schemas';
import type { FilterQuery } from 'mongoose';
import type { AdminExchangeResponse } from '~/auth/exchange';

import {
  isUserIssuerAllowed,
  normalizeOpenIdIssuer,
  getIssuerBoundConditions,
} from '~/auth/openid';
import { serializeUserForExchange } from '~/auth/exchange';

const SAFE_USER_PROJECTION = '-password -__v -totpSecret -backupCodes';

interface AdminRefreshClaims {
  sub?: string;
  iss?: string;
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

  const responseUser = serializeUserForExchange(user);

  logger.debug(`[adminRefresh] Refreshed tokens for user: ${responseUser.email}`);

  return {
    token: minted.token,
    refreshToken: tokenset.refresh_token ?? options.previousRefreshToken,
    user: responseUser,
    expiresAt: minted.expiresAt,
  };
}
