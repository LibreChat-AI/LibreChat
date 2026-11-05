import { Types } from 'mongoose';
import { logger } from '@librechat/data-schemas';
import { DEFAULT_OPENID_AUTHORIZATION_TIMEOUT_MS } from 'librechat-data-provider';
import type { IUser } from '@librechat/data-schemas';
import type { FilterQuery } from 'mongoose';
import type { OpenIDSessionAuthorizationDeps } from '~/auth/openid/sessions';
import type { AdminExchangeResponse } from '~/auth/exchange';
import {
  authorizeOpenIDSession,
  authorizeOpenIDSessionReference,
  isOpenIDSessionAuthorizationUnavailableError,
  withAuthorizationTimeout,
} from '~/auth/openid/sessions';
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

  logger.debug(`[adminRefresh] Refreshed tokens for user: ${responseUser.id}`);

  return {
    token: minted.token,
    refreshToken: tokenset.refresh_token ?? options.previousRefreshToken,
    user: responseUser,
    expiresAt: minted.expiresAt,
  };
}

export interface AdminOpenIDRefreshAuthorizationInput {
  openidSessionId: string;
  expectedIssuer: string | undefined;
  user: IUser;
  tokenset: RefreshTokenset;
  clientId: string | undefined;
}

/** A denial maps to `AdminRefreshError` 403; the authorization layer being unreachable maps to 503. */
export async function authorizeAdminOpenIDRefresh(
  input: AdminOpenIDRefreshAuthorizationInput,
  authorizationDeps: OpenIDSessionAuthorizationDeps,
): Promise<void> {
  const claims = input.tokenset.claims();
  const result = await authorizeOpenIDSession(
    {
      issuer: input.expectedIssuer ?? claims.iss,
      clientId: input.clientId ?? '',
      subject: claims.sub ?? '',
      sessionId: input.openidSessionId,
      user: input.user.id ?? input.user._id?.toString(),
      tenantId: input.user.tenantId,
    },
    authorizationDeps,
  );
  if (result.ok) {
    return;
  }
  if (result.code === 'unavailable') {
    throw new AdminRefreshError(
      'OPENID_SESSION_UNAVAILABLE',
      503,
      'OpenID session authorization is unavailable',
    );
  }
  throw new AdminRefreshError('OPENID_SESSION_DENIED', 403, 'OpenID session denied');
}

export interface MintAdminOpenIDRefreshTokenInput {
  user: IUser;
  tokenset: RefreshTokenset;
  openidSessionId: string | undefined;
  expectedIssuer: string | undefined;
  clientId: string | undefined;
  sessionExpiry: number;
}

export interface MintAdminOpenIDRefreshTokenDeps {
  authorizationDeps: OpenIDSessionAuthorizationDeps;
  generateToken: (
    user: IUser,
    sessionExpiry: number,
    openidClaims?: { openidSessionId: string; tenantId?: string },
  ) => Promise<string>;
}

export interface MintedAdminToken {
  token: string;
  expiresAt: number;
}

/** Authorizes the bearer's OpenID session, if any, then mints the admin token with matching claims. */
export async function mintAdminOpenIDRefreshToken(
  input: MintAdminOpenIDRefreshTokenInput,
  deps: MintAdminOpenIDRefreshTokenDeps,
): Promise<MintedAdminToken> {
  let openidClaims: { openidSessionId: string; tenantId?: string } | undefined;
  if (input.openidSessionId) {
    await authorizeAdminOpenIDRefresh(
      {
        openidSessionId: input.openidSessionId,
        expectedIssuer: input.expectedIssuer,
        user: input.user,
        tokenset: input.tokenset,
        clientId: input.clientId,
      },
      deps.authorizationDeps,
    );
    openidClaims = { openidSessionId: input.openidSessionId, tenantId: input.user.tenantId };
  }
  return {
    token: await deps.generateToken(input.user, input.sessionExpiry, openidClaims),
    expiresAt: Date.now() + input.sessionExpiry,
  };
}

export interface AdminOpenIDRefreshSessionDeps {
  recallAdminOpenIDSessionRef: (refreshToken: string) => Promise<string | undefined>;
  authorizationDeps: Pick<
    OpenIDSessionAuthorizationDeps,
    'authorization' | 'enforcement' | 'timeoutMs'
  >;
}

/** Recalls and authorizes the refresh token's OpenID session before the IdP grant; with
 *  enforcement off the recall is time-bounded and advisory, never blocking the refresh. */
export async function resolveAdminOpenIDRefreshSession(
  refreshToken: string,
  deps: AdminOpenIDRefreshSessionDeps,
): Promise<string | undefined> {
  const { authorizationDeps } = deps;
  const enforcement = authorizationDeps.enforcement === true;

  let openidSessionId: string | undefined;
  if (enforcement) {
    try {
      openidSessionId = await deps.recallAdminOpenIDSessionRef(refreshToken);
    } catch (err) {
      if (isOpenIDSessionAuthorizationUnavailableError(err)) {
        throw new AdminRefreshError(
          'OPENID_SESSION_UNAVAILABLE',
          503,
          'OpenID session authorization is unavailable',
        );
      }
      throw err;
    }
  } else {
    try {
      openidSessionId = await withAuthorizationTimeout(
        deps.recallAdminOpenIDSessionRef(refreshToken),
        authorizationDeps.timeoutMs ?? DEFAULT_OPENID_AUTHORIZATION_TIMEOUT_MS,
      );
    } catch (err) {
      logger.warn(
        '[admin/oauth/refresh] Timed out recalling the OpenID session reference',
        err as Error,
      );
    }
  }

  if (enforcement && !openidSessionId) {
    throw new AdminRefreshError(
      'OPENID_SESSION_REQUIRED',
      401,
      'OpenID re-authentication is required',
    );
  }

  if (openidSessionId) {
    const reference = await authorizeOpenIDSessionReference(openidSessionId, authorizationDeps);
    if (!reference.ok) {
      if (reference.code === 'unavailable') {
        throw new AdminRefreshError(
          'OPENID_SESSION_UNAVAILABLE',
          503,
          'OpenID session authorization is unavailable',
        );
      }
      throw new AdminRefreshError('OPENID_SESSION_DENIED', 403, 'OpenID session denied');
    }
  }

  return openidSessionId;
}

export interface AdminOpenIDRefreshRotateDeps {
  rotateAdminOpenIDSessionRef: (
    oldRefreshToken: string,
    newRefreshToken: string | undefined,
    openidSessionId: string,
  ) => Promise<void>;
  authorizationDeps: Pick<OpenIDSessionAuthorizationDeps, 'enforcement' | 'timeoutMs'>;
}

/** Carries the session reference forward to the rotated refresh token; never throws, since the
 *  IdP has already rotated the token by the time this runs. */
export async function rotateAdminOpenIDRefreshSession(
  oldRefreshToken: string,
  newRefreshToken: string | undefined,
  openidSessionId: string | undefined,
  deps: AdminOpenIDRefreshRotateDeps,
): Promise<void> {
  if (!openidSessionId) {
    return;
  }

  const { authorizationDeps } = deps;
  const enforcement = authorizationDeps.enforcement === true;

  try {
    if (enforcement) {
      await deps.rotateAdminOpenIDSessionRef(oldRefreshToken, newRefreshToken, openidSessionId);
    } else {
      await withAuthorizationTimeout(
        deps.rotateAdminOpenIDSessionRef(oldRefreshToken, newRefreshToken, openidSessionId),
        authorizationDeps.timeoutMs ?? DEFAULT_OPENID_AUTHORIZATION_TIMEOUT_MS,
      );
    }
  } catch (err) {
    const message = (err as Error)?.message;
    if (enforcement) {
      logger.error('[admin/oauth/refresh] Failed to rotate the OpenID session reference', {
        message,
      });
    } else {
      logger.warn('[admin/oauth/refresh] Failed to rotate the OpenID session reference', {
        message,
      });
    }
  }
}
