import crypto from 'crypto';
import { Keyv } from 'keyv';
import { logger } from '@librechat/data-schemas';
import type { IUser } from '@librechat/data-schemas';
import { consumeCacheEntry } from '../cache/consume';

/** Default admin panel URL for local development */
const DEFAULT_ADMIN_PANEL_URL = 'http://localhost:3000';

/**
 * Gets the admin panel URL from environment or falls back to default.
 * @returns The admin panel URL
 */
export function getAdminPanelUrl(): string {
  return process.env.ADMIN_PANEL_URL || DEFAULT_ADMIN_PANEL_URL;
}

/**
 * User data stored in the exchange cache
 */
export interface AdminExchangeUser {
  _id: string;
  id: string;
  email: string;
  name: string;
  username: string;
  role: string;
  avatar?: string;
  provider?: string;
  openidId?: string;
}

/**
 * Data stored in cache for admin OAuth exchange.
 *
 * `expiresAt` is the absolute expiry of `token` (ms epoch). Used by admin
 * panel clients to drive proactive refresh before the bearer expires.
 */
export interface AdminExchangeData {
  userId: string;
  user: AdminExchangeUser;
  token: string;
  refreshToken?: string;
  origin?: string;
  codeChallenge?: string;
  expiresAt?: number;
}

/**
 * Response from the exchange endpoint
 */
export interface AdminExchangeResponse {
  token: string;
  /**
   * When Google rotates the refresh token on use, this will differ from the
   * token the client originally sent. Clients MUST persist this value; failing
   * to do so causes future refresh calls to fail once Google's original grant
   * expires or is revoked.
   */
  refreshToken?: string;
  user: AdminExchangeUser;
  expiresAt?: number;
}

/**
 * Serializes user data for the exchange cache.
 * @param user - The authenticated user object
 * @returns Serialized user data for admin panel
 */
export function serializeUserForExchange(user: IUser): AdminExchangeUser {
  const userId = String(user._id);
  return {
    _id: userId,
    id: userId,
    email: user.email,
    name: user.name ?? '',
    username: user.username ?? '',
    role: user.role ?? 'USER',
    avatar: user.avatar,
    provider: user.provider,
    openidId: user.openidId,
  };
}

/**
 * Verifies a PKCE code_verifier against a stored code_challenge.
 * Uses hex-encoded SHA-256 comparison (not RFC 7636 S256 which uses base64url).
 * @param verifier - The code_verifier provided during exchange
 * @param challenge - The hex-encoded SHA-256 code_challenge stored during code generation
 * @returns True if the verifier matches the challenge
 */
export function verifyCodeChallenge(verifier: string, challenge: string): boolean {
  const computed = crypto.createHash('sha256').update(verifier).digest();
  const storedBuf = Buffer.from(challenge, 'hex');
  if (computed.length !== storedBuf.length) {
    return false;
  }
  return crypto.timingSafeEqual(computed, storedBuf);
}

/**
 * Generates an exchange code and stores user data for admin panel OAuth flow.
 * @param cache - The Keyv cache instance for storing exchange data
 * @param user - The authenticated user object
 * @param token - The JWT access token
 * @param refreshToken - Optional refresh token for OpenID users
 * @param origin - The admin panel origin (scheme://host:port) for origin binding
 * @param codeChallenge - PKCE code_challenge (hex-encoded SHA-256 of code_verifier)
 * @param expiresAt - Optional absolute expiry of `token` (ms epoch); admin panel uses for proactive refresh
 * @returns The generated exchange code
 */
export async function generateAdminExchangeCode(
  cache: Keyv,
  user: IUser,
  token: string,
  refreshToken?: string,
  origin?: string,
  codeChallenge?: string,
  expiresAt?: number,
): Promise<string> {
  const exchangeCode = crypto.randomBytes(32).toString('hex');

  const data: AdminExchangeData = {
    userId: String(user._id),
    user: serializeUserForExchange(user),
    token,
    refreshToken,
    origin,
    codeChallenge,
    expiresAt,
  };

  await cache.set(exchangeCode, data);

  logger.info(`[adminExchange] Generated exchange code for user: ${user.email}`);

  return exchangeCode;
}

/**
 * Exchanges an authorization code for tokens and user data.
 * The code is atomically removed before validation (one-time use).
 * @param cache - The Keyv cache instance for retrieving exchange data
 * @param code - The authorization code to exchange
 * @param requestOrigin - The origin of the requesting client for origin binding
 * @param codeVerifier - PKCE code_verifier to verify against the stored code_challenge
 * @returns The exchange response with token, refreshToken, and user data, or null if invalid/expired
 */
export async function exchangeAdminCode(
  cache: Keyv,
  code: string,
  requestOrigin?: string,
  codeVerifier?: string,
): Promise<AdminExchangeResponse | null> {
  const data = await consumeCacheEntry<AdminExchangeData>(cache, code);

  if (!data) {
    logger.warn('[adminExchange] Invalid or expired authorization code');
    return null;
  }

  if (data.origin && data.origin !== requestOrigin) {
    logger.warn('[adminExchange] Authorization code origin mismatch');
    return null;
  }

  if (data.codeChallenge) {
    if (!codeVerifier || !verifyCodeChallenge(codeVerifier, data.codeChallenge)) {
      logger.warn('[adminExchange] PKCE code_verifier mismatch or missing');
      return null;
    }
  }

  logger.info(`[adminExchange] Exchanged code for user: ${data.user?.email}`);

  return {
    token: data.token,
    refreshToken: data.refreshToken,
    user: data.user,
    expiresAt: data.expiresAt,
  };
}

/** PKCE challenge cache TTL: 5 minutes (enough for user to authenticate with IdP) */
export const PKCE_CHALLENGE_TTL: number = 5 * 60 * 1000;
/** Regex pattern for valid PKCE challenges: 64 hex characters (SHA-256 hex digest) */
export const PKCE_CHALLENGE_PATTERN: RegExp = /^[a-f0-9]{64}$/;

const ADMIN_OAUTH_STRIPPED_QUERY_PARAMS = new Set(['code_challenge', 'redirect_uri', 'redirectTo']);

const getQueryParamName = (param: string): string => {
  const separatorIndex = param.indexOf('=');
  return separatorIndex === -1 ? param : param.slice(0, separatorIndex);
};

/** Removes admin-panel-only query params from a single URL string. */
const stripAdminOAuthParamsFromUrl = (url: string): string => {
  const hashIndex = url.indexOf('#');
  const urlWithoutHash = hashIndex === -1 ? url : url.slice(0, hashIndex);
  const hash = hashIndex === -1 ? '' : url.slice(hashIndex);
  const queryIndex = urlWithoutHash.indexOf('?');

  if (queryIndex === -1) {
    return url;
  }

  const path = urlWithoutHash.slice(0, queryIndex);
  const query = urlWithoutHash.slice(queryIndex + 1);
  const params = query.split('&').filter((param) => {
    if (!param) {
      return false;
    }

    return !ADMIN_OAUTH_STRIPPED_QUERY_PARAMS.has(getQueryParamName(param));
  });

  return params.length > 0 ? `${path}?${params.join('&')}${hash}` : `${path}${hash}`;
};

/** Minimal request shape needed by {@link stripCodeChallenge}. */
export interface PkceStrippableRequest {
  query: Record<string, unknown>;
  originalUrl: string;
  url: string;
}

/**
 * Strips admin-panel-only params from the request query and URL strings.
 *
 * openid-client v6's Passport Strategy uses `currentUrl.searchParams.size === 0`
 * to distinguish an initial authorization request from an OAuth callback.
 * Admin-panel-specific query params would cause the strategy to misclassify the
 * request as a callback and return 401.
 *
 * Applied defensively to all providers to ensure the admin-panel-private
 * parameters never reach any Passport strategy.
 */
export function stripCodeChallenge(req: PkceStrippableRequest): void {
  delete req.query.code_challenge;
  delete req.query.redirect_uri;
  delete req.query.redirectTo;
  req.originalUrl = stripAdminOAuthParamsFromUrl(req.originalUrl);
  req.url = stripAdminOAuthParamsFromUrl(req.url);
}

/**
 * Stores the admin-panel PKCE challenge in cache, then strips admin-panel-only
 * params from the request so they don't interfere with the Passport strategy.
 *
 * Must be called before `passport.authenticate()` — the two operations are
 * logically atomic: read the challenge from the query, persist it, then remove
 * those parameters from the request URL.
 * @param cache - The Keyv cache instance for storing PKCE challenges.
 * @param req - The Express request to read and mutate.
 * @param state - The OAuth state value (cache key).
 * @param provider - Provider name for logging.
 * @returns True if stored (or no challenge provided); false on cache failure.
 */
export async function storeAndStripChallenge(
  cache: Keyv,
  req: PkceStrippableRequest,
  state: string,
  provider: string,
): Promise<boolean> {
  const { code_challenge: codeChallenge } = req.query;
  if (typeof codeChallenge !== 'string' || !PKCE_CHALLENGE_PATTERN.test(codeChallenge)) {
    stripCodeChallenge(req);
    return true;
  }
  try {
    await cache.set(`pkce:${state}`, codeChallenge, PKCE_CHALLENGE_TTL);
    stripCodeChallenge(req);
    return true;
  } catch (err) {
    logger.error(`[admin/oauth/${provider}] Failed to store PKCE challenge:`, err);
    return false;
  }
}

/**
 * Normalizes a URL path by removing any trailing slash, except for the root path.
 * @returns The normalized path.
 */
const normalizePath = (path: string): string => {
  if (!path || path === '/') {
    return '/';
  }

  return path.endsWith('/') ? path.slice(0, -1) : path;
};

/**
 * Checks if the redirect URI targets the admin panel.
 *
 * Supported cases:
 * - Cross-origin admin panel: redirect origin must match admin origin.
 * - Same-origin admin panel under a subpath: redirect path must be within
 *   the configured admin subpath.
 *
 * @param redirectUri - The redirect URI to check.
 * @param adminPanelUrl - The admin panel URL (defaults to ADMIN_PANEL_URL env var)
 * @param domainClient - The main client domain
 * @returns True if redirecting to admin panel.
 */
export function isAdminPanelRedirect(
  redirectUri: string,
  adminPanelUrl: string,
  domainClient: string,
): boolean {
  try {
    const redirectURL = new URL(redirectUri);
    const adminURL = new URL(adminPanelUrl);
    const clientURL = new URL(domainClient);

    const redirectOrigin = redirectURL.origin;
    const adminOrigin = adminURL.origin;
    const clientOrigin = clientURL.origin;

    if (redirectOrigin !== adminOrigin) {
      return false;
    }

    if (adminOrigin !== clientOrigin) {
      return true;
    }

    const adminPath = normalizePath(adminURL.pathname);
    const redirectPath = normalizePath(redirectURL.pathname);

    if (adminPath === '/') {
      return false;
    }

    return redirectPath === adminPath || redirectPath.startsWith(`${adminPath}/`);
  } catch {
    /** If URL parsing fails, fall back to simple string comparison */
    return redirectUri.startsWith(adminPanelUrl) && !redirectUri.startsWith(domainClient);
  }
}
