import { Types } from 'mongoose';
import { logger } from '@librechat/data-schemas';

import type { IUser } from '@librechat/data-schemas';
import type { FilterQuery } from 'mongoose';
import type { AdminExchangeResponse } from '~/auth/exchange';

import { serializeUserForExchange } from '~/auth/exchange';
import { AdminRefreshError } from '~/auth/refresh';

const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const GOOGLE_USERINFO_ENDPOINT = 'https://openidconnect.googleapis.com/v1/userinfo';
const SAFE_USER_PROJECTION = '-password -__v -totpSecret -backupCodes';

interface GoogleTokenset {
  access_token?: string;
  id_token?: string;
  refresh_token?: string;
}

interface IdTokenClaims {
  sub?: string;
  aud?: string | string[];
}

export interface MintedGoogleAdminToken {
  token: string;
  expiresAt: number;
}

export interface GoogleAdminRefreshDeps {
  findUsers: (
    filter: FilterQuery<IUser>,
    projection: string,
    options: { sort: Record<string, 1 | -1>; limit: number },
  ) => Promise<IUser[]>;
  getUserById: (id: string, projection: string) => Promise<IUser | null>;
  canAccessAdmin: (user: IUser) => Promise<boolean>;
  /**
   * Re-runs the deployment's `registration.allowedDomains` check against the
   * resolved user's email. Returns true to allow refresh, false to reject.
   * Mirrors the `isEmailDomainAllowed` call the initial OAuth login enforces
   * so a domain removed from the allowlist after issuance can't refresh.
   */
  isEmailAllowed?: (user: IUser) => Promise<boolean>;
  mintToken: (user: IUser) => Promise<MintedGoogleAdminToken>;
}

export interface GoogleAdminRefreshOptions {
  refreshToken: string;
  userId?: string;
  tenantId?: string;
  clientId?: string;
  clientSecret?: string;
}

function decodeJwtPayload(token: string): IdTokenClaims | undefined {
  const segments = token.split('.');
  if (segments.length !== 3) return undefined;
  try {
    const payload = Buffer.from(segments[1], 'base64url').toString('utf8');
    return JSON.parse(payload) as IdTokenClaims;
  } catch {
    return undefined;
  }
}

async function resolveSubFromUserinfo(accessToken: string): Promise<string | undefined> {
  try {
    const response = await fetch(GOOGLE_USERINFO_ENDPOINT, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!response.ok) {
      logger.warn('[admin/oauth/refresh] userinfo fallback returned non-OK', {
        status: response.status,
      });
      return undefined;
    }
    const body = (await response.json().catch(() => undefined)) as IdTokenClaims | undefined;
    return typeof body?.sub === 'string' ? body.sub : undefined;
  } catch (err) {
    const error = err as { name?: string; message?: string };
    logger.warn('[admin/oauth/refresh] userinfo fallback failed', {
      name: error?.name,
      message: error?.message,
    });
    return undefined;
  }
}

interface GoogleAdminRefreshConfiguredOptions extends GoogleAdminRefreshOptions {
  clientId: string;
  clientSecret: string;
}

async function fetchGoogleTokenset(
  options: GoogleAdminRefreshConfiguredOptions,
): Promise<GoogleTokenset> {
  let response: Response;
  try {
    response = await fetch(GOOGLE_TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: options.clientId,
        client_secret: options.clientSecret,
        refresh_token: options.refreshToken,
        grant_type: 'refresh_token',
      }),
    });
  } catch (err) {
    const error = err as { name?: string; message?: string };
    logger.warn('[admin/oauth/refresh] token endpoint request failed', {
      name: error?.name,
      message: error?.message,
    });
    throw new AdminRefreshError('REFRESH_FAILED', 401, 'Refresh failed');
  }

  if (!response.ok) {
    logger.warn('[admin/oauth/refresh] Google rejected refresh grant', {
      status: response.status,
    });
    throw new AdminRefreshError('REFRESH_FAILED', 401, 'Refresh failed');
  }

  try {
    return (await response.json()) as GoogleTokenset;
  } catch (err) {
    const error = err as { name?: string; message?: string };
    logger.warn('[admin/oauth/refresh] Google returned non-JSON body', {
      name: error?.name,
      message: error?.message,
    });
    throw new AdminRefreshError('IDP_INCOMPLETE', 502, 'Google returned a non-JSON token response');
  }
}

async function resolveGoogleSub(tokenset: GoogleTokenset, clientId?: string): Promise<string> {
  if (typeof tokenset.access_token !== 'string') {
    throw new AdminRefreshError(
      'IDP_INCOMPLETE',
      502,
      'Google returned a tokenset missing access_token',
    );
  }

  let sub: string | undefined;
  if (typeof tokenset.id_token === 'string') {
    const claims = decodeJwtPayload(tokenset.id_token);
    if (clientId && claims?.aud !== undefined) {
      const aud = claims.aud;
      const audOk = Array.isArray(aud) ? aud.includes(clientId) : aud === clientId;
      if (!audOk) {
        throw new AdminRefreshError(
          'ISSUER_MISMATCH',
          401,
          'id_token aud does not match configured client',
        );
      }
    }
    if (typeof claims?.sub === 'string') {
      sub = claims.sub;
    }
  }
  if (!sub) {
    sub = await resolveSubFromUserinfo(tokenset.access_token);
  }
  if (!sub) {
    throw new AdminRefreshError(
      'CLAIMS_INCOMPLETE',
      502,
      'Could not resolve google sub from refresh response',
    );
  }
  return sub;
}

async function resolveAdminUser(
  googleId: string,
  deps: GoogleAdminRefreshDeps,
  options: GoogleAdminRefreshOptions,
): Promise<IUser> {
  if (options.userId && Types.ObjectId.isValid(options.userId)) {
    const direct = await deps.getUserById(options.userId, SAFE_USER_PROJECTION);
    if (direct) {
      if (direct.googleId !== googleId) {
        throw new AdminRefreshError(
          'USER_ID_MISMATCH',
          401,
          'Provided user_id does not match the refreshed identity',
        );
      }
      if (options.tenantId && direct.tenantId !== options.tenantId) {
        throw new AdminRefreshError(
          'TENANT_MISMATCH',
          401,
          'Provided user_id resolves outside the request tenant',
        );
      }
      if (direct.provider !== 'google') {
        throw new AdminRefreshError(
          'PROVIDER_MISMATCH',
          401,
          'User account is not bound to the Google provider',
        );
      }
      return direct;
    }
  }

  const filter = (
    options.tenantId ? { googleId, tenantId: options.tenantId } : { googleId }
  ) as FilterQuery<IUser>;
  const matches = await deps.findUsers(filter, SAFE_USER_PROJECTION, {
    sort: { updatedAt: -1 },
    limit: 2,
  });
  if (matches.length > 1) {
    logger.error('[admin/oauth/refresh] ambiguous googleId match', {
      googleId,
      tenantId: options.tenantId,
    });
    throw new AdminRefreshError('USER_ID_MISMATCH', 401, 'Ambiguous identity');
  }
  const [found] = matches;
  if (!found) {
    throw new AdminRefreshError('USER_NOT_FOUND', 401, 'No user found for the refreshed identity');
  }
  if (found.provider !== 'google') {
    throw new AdminRefreshError(
      'PROVIDER_MISMATCH',
      401,
      'User account is not bound to the Google provider',
    );
  }
  return found;
}

/**
 * Refresh a Google admin OAuth session.
 *
 * Mirrors the OpenID admin refresh contract from `applyAdminRefresh` but
 * speaks Google's OAuth 2.0 refresh-token grant. Calls Google's token
 * endpoint, resolves the user's `sub` (preferring an `id_token` claim, with
 * a userinfo-endpoint fallback per Google's documented behavior of returning
 * id_token only conditionally on refresh), looks up the admin by `googleId`,
 * enforces tenant + `ACCESS_ADMIN`, and mints a fresh LibreChat JWT in the
 * same response shape as `/api/admin/oauth/exchange`.
 */
export async function applyGoogleAdminRefresh(
  deps: GoogleAdminRefreshDeps,
  options: GoogleAdminRefreshOptions,
): Promise<AdminExchangeResponse> {
  if (!options.clientId || !options.clientSecret) {
    throw new AdminRefreshError(
      'GOOGLE_NOT_CONFIGURED',
      503,
      'Google admin OAuth is not configured',
    );
  }

  const configured: GoogleAdminRefreshConfiguredOptions = {
    ...options,
    clientId: options.clientId,
    clientSecret: options.clientSecret,
  };

  const tokenset = await fetchGoogleTokenset(configured);
  const googleId = await resolveGoogleSub(tokenset, configured.clientId);
  const user = await resolveAdminUser(googleId, deps, options);

  if (deps.isEmailAllowed && !(await deps.isEmailAllowed(user))) {
    throw new AdminRefreshError(
      'FORBIDDEN',
      403,
      'User email domain is not on the deployment allowlist',
    );
  }

  if (!(await deps.canAccessAdmin(user))) {
    throw new AdminRefreshError('FORBIDDEN', 403, 'User does not have admin access');
  }

  const minted = await deps.mintToken(user);

  if (tokenset.refresh_token && tokenset.refresh_token !== options.refreshToken) {
    logger.info(
      '[admin/oauth/refresh] Google rotated the refresh token; client must persist the new value',
    );
  }

  return {
    token: minted.token,
    refreshToken: tokenset.refresh_token ?? options.refreshToken,
    user: serializeUserForExchange(user),
    expiresAt: minted.expiresAt,
  };
}
