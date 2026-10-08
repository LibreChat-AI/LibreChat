import { logger } from '@librechat/data-schemas';
import type { IUser, OIDCTokens } from '@librechat/data-schemas';
import { OPENID_EXPIRY_BUFFER_SECONDS } from '~/oauth/expiry';

export interface OpenIDTokenInfo {
  accessToken?: string;
  idToken?: string;
  expiresAt?: number;
  idTokenExpiresAt?: number;
  userId?: string;
  userEmail?: string;
  userName?: string;
  claims?: Record<string, unknown>;
}

function isFederatedTokens(obj: unknown): obj is OIDCTokens {
  if (!obj || typeof obj !== 'object') {
    return false;
  }
  return 'access_token' in obj || 'id_token' in obj || 'expires_at' in obj;
}

export const OPENID_TOKEN_FIELDS = [
  'ACCESS_TOKEN',
  'ID_TOKEN',
  'USER_ID',
  'USER_EMAIL',
  'USER_NAME',
  'EXPIRES_AT',
] as const;

export type OpenIDTokenField = (typeof OPENID_TOKEN_FIELDS)[number];

/**
 * Placeholder for Microsoft Graph API access token.
 * This placeholder is resolved asynchronously via OBO (On-Behalf-Of) flow
 * and requires special handling outside the synchronous processMCPEnv pipeline.
 */
export const GRAPH_TOKEN_PLACEHOLDER = '{{LIBRECHAT_GRAPH_ACCESS_TOKEN}}';

/**
 * Default Microsoft Graph API scopes for OBO token exchange.
 * Can be overridden via GRAPH_API_SCOPES environment variable.
 */
export const DEFAULT_GRAPH_SCOPES = 'https://graph.microsoft.com/.default';

/** Claims consulted when deciding whether a verified JWT is an access token rather than an ID token. */
export interface JwtTypeClaims {
  aud?: string | string[];
  scp?: unknown;
  scope?: unknown;
  at_hash?: unknown;
  c_hash?: unknown;
}

/** The configured audiences a verified JWT is weighed against. */
export interface AccessTokenAudiences {
  /** Audiences that name a protected resource rather than the OIDC client. */
  resources?: ReadonlySet<string>;
  /** The OIDC client id, so an `aud` that still names it is not read as resource-bound. */
  clientId?: string;
}

/** RFC 9068 media type for a JWT access token, as it appears in the `typ` header (compared case-insensitively). */
const ACCESS_TOKEN_JWT_TYPES = new Set(['at+jwt', 'application/at+jwt']);

function decodeJwtHeaderType(token: string): string | undefined {
  try {
    const header = JSON.parse(Buffer.from(token.split('.')[0], 'base64').toString());
    return typeof header?.typ === 'string' ? header.typ.toLowerCase() : undefined;
  } catch {
    return undefined;
  }
}

function audienceList(aud: string | string[] | undefined): string[] {
  if (typeof aud === 'string') {
    return [aud];
  }
  return Array.isArray(aud) ? aud : [];
}

/**
 * Decides whether a verified bearer JWT is an OAuth 2.0 access token, so it may stand in for a
 * stored access token. Passing this strategy's audience check does not settle the question: an
 * OIDC ID token is minted for the client id and satisfies the same check, and using one as the
 * On-Behalf-Of assertion is rejected by the IdP (Entra answers `AADSTS240002`).
 *
 * Only two signals distinguish the two by specification rather than by provider convention:
 * - an RFC 9068 `at+jwt` header type, which is defined for access tokens alone;
 * - an `aud` that omits the OIDC client id, which OIDC Core §2 requires every ID token to carry,
 *   so a token without it cannot be an ID token for this deployment.
 *
 * Claim presence is deliberately not proof on its own. Providers add claims freely in both
 * directions — Keycloak has emitted `nonce` and `auth_time` in access tokens, and maps `scope`
 * into ID tokens — so `scp`/`scope` only qualifies a token whose audience has already ruled out
 * an ID token. While the client id is in `aud` the token may be either, and it fails closed.
 *
 * `at_hash` and `c_hash` veto regardless, since they exist only to bind an ID token to its
 * companion access token or code.
 */
export function isAccessTokenJwt(
  token: string | undefined,
  claims: JwtTypeClaims | undefined,
  audiences?: AccessTokenAudiences,
): boolean {
  if (!token || !claims) {
    return false;
  }

  if (claims.at_hash != null || claims.c_hash != null) {
    return false;
  }

  const headerType = decodeJwtHeaderType(token);
  if (headerType != null && ACCESS_TOKEN_JWT_TYPES.has(headerType)) {
    return true;
  }

  /** Without a configured client id the audience can rule nothing out, so nothing but `at+jwt` qualifies */
  if (audiences?.clientId == null) {
    return false;
  }

  const tokenAudiences = audienceList(claims.aud);
  if (tokenAudiences.includes(audiences.clientId)) {
    return false;
  }

  if (audiences.resources?.size) {
    if (tokenAudiences.some((audience) => audiences.resources!.has(audience))) {
      return true;
    }
  }

  return claims.scp != null || claims.scope != null;
}

/**
 * Signals that the stored OpenID credentials cannot satisfy a placeholder, so the user must
 * re-authenticate. `ErrorController` maps this to a 401, and `statusCode` additionally lets
 * status-reading callers (the agent generation path's `getInitializationFailure`) answer 401
 * instead of a bare 500. Deliberately carries no `body`, so the structural `isCustomError`
 * guard cannot capture it ahead of the explicit mapping.
 */
export class OpenIDReauthRequiredError extends Error {
  readonly statusCode = 401;

  constructor(message: string) {
    super(message);
    this.name = 'OpenIDReauthRequiredError';
  }
}

export function extractOpenIDTokenInfo(
  user: Partial<IUser> | null | undefined,
): OpenIDTokenInfo | null {
  if (!user) {
    return null;
  }

  try {
    if (user.provider !== 'openid' && !user.openidId) {
      return null;
    }

    const tokenInfo: OpenIDTokenInfo = {};

    const federated = user.federatedTokens;
    const openid = user.openidTokens;

    if (federated && isFederatedTokens(federated)) {
      logger.debug('[extractOpenIDTokenInfo] Found federatedTokens:', {
        has_access_token: !!federated.access_token,
        has_id_token: !!federated.id_token,
        has_refresh_token: !!federated.refresh_token,
        expires_at: federated.expires_at,
      });
      tokenInfo.accessToken = federated.access_token;
      tokenInfo.idToken = federated.id_token;
      tokenInfo.expiresAt = federated.expires_at;
    } else if (openid && isFederatedTokens(openid)) {
      logger.debug('[extractOpenIDTokenInfo] Found openidTokens');
      tokenInfo.accessToken = openid.access_token;
      tokenInfo.idToken = openid.id_token;
      tokenInfo.expiresAt = openid.expires_at;
    }

    tokenInfo.userId = user.openidId || user.id;
    tokenInfo.userEmail = user.email;
    tokenInfo.userName = user.name || user.username;

    if (tokenInfo.idToken) {
      try {
        const payload = JSON.parse(
          Buffer.from(tokenInfo.idToken.split('.')[1], 'base64').toString(),
        );
        tokenInfo.claims = payload;

        /** Cached profile claims, not an authentication assertion: stale claims stay usable for identity fields even when the ID token itself is expired */
        if (payload.sub) tokenInfo.userId = payload.sub;
        if (payload.email) tokenInfo.userEmail = payload.email;
        if (payload.name) tokenInfo.userName = payload.name;
        if (typeof payload.exp === 'number') {
          tokenInfo.idTokenExpiresAt = payload.exp;
        }
      } catch (jwtError) {
        logger.warn('Could not parse ID token claims:', jwtError);
      }
    }

    return tokenInfo;
  } catch (error) {
    logger.error('Error extracting OpenID token info:', error);
    return null;
  }
}

/** Advisory freshness check, not a security boundary: the ID token signature is not verified here. `exp` is REQUIRED in an ID token, so a missing value means the token is malformed or unparseable and fails closed. */
function isIdTokenCurrent(tokenInfo: OpenIDTokenInfo): boolean {
  if (tokenInfo.idTokenExpiresAt == null) {
    return false;
  }
  return Math.floor(Date.now() / 1000) < tokenInfo.idTokenExpiresAt - OPENID_EXPIRY_BUFFER_SECONDS;
}

export function isOpenIDTokenValid(tokenInfo: OpenIDTokenInfo | null): boolean {
  if (!tokenInfo || !tokenInfo.accessToken) {
    return false;
  }

  if (tokenInfo.expiresAt != null) {
    const now = Math.floor(Date.now() / 1000);
    if (now >= tokenInfo.expiresAt - OPENID_EXPIRY_BUFFER_SECONDS) {
      logger.warn('OpenID token has expired');
      return false;
    }
  }

  return true;
}

/**
 * @param fields Restricts which placeholders may resolve. Callers holding a token set whose
 * access token is unusable pass `['ID_TOKEN']`, so the ID token resolves on its own expiry while
 * every other placeholder keeps its literal-then-strip behaviour.
 */
export function processOpenIDPlaceholders(
  value: string,
  tokenInfo: OpenIDTokenInfo | null,
  fields: readonly OpenIDTokenField[] = OPENID_TOKEN_FIELDS,
): string {
  if (!tokenInfo || typeof value !== 'string') {
    return value;
  }

  let processedValue = value;

  for (const field of fields) {
    const placeholder = `{{LIBRECHAT_OPENID_${field}}}`;
    if (!processedValue.includes(placeholder)) {
      continue;
    }

    let replacementValue = '';

    switch (field) {
      case 'ACCESS_TOKEN':
        replacementValue = tokenInfo.accessToken || '';
        break;
      case 'ID_TOKEN':
        if (!tokenInfo.idToken || !isIdTokenCurrent(tokenInfo)) {
          logger.warn('OpenID ID token is expired or unavailable; re-authentication is required');
          throw new OpenIDReauthRequiredError(
            'OpenID ID token is expired or unavailable; re-authentication is required to resolve {{LIBRECHAT_OPENID_ID_TOKEN}}',
          );
        }
        replacementValue = tokenInfo.idToken;
        break;
      case 'USER_ID':
        replacementValue = tokenInfo.userId || '';
        break;
      case 'USER_EMAIL':
        replacementValue = tokenInfo.userEmail || '';
        break;
      case 'USER_NAME':
        replacementValue = tokenInfo.userName || '';
        break;
      case 'EXPIRES_AT':
        /** The stored token-set expires_at only: the ID token exp never stands in for it */
        replacementValue = tokenInfo.expiresAt != null ? String(tokenInfo.expiresAt) : '';
        break;
    }

    processedValue = processedValue.replace(new RegExp(placeholder, 'g'), replacementValue);
  }

  const genericPlaceholder = '{{LIBRECHAT_OPENID_TOKEN}}';
  if (fields.includes('ACCESS_TOKEN') && processedValue.includes(genericPlaceholder)) {
    const replacementValue = tokenInfo.accessToken || '';
    processedValue = processedValue.replace(new RegExp(genericPlaceholder, 'g'), replacementValue);
  }

  return processedValue;
}

export function createBearerAuthHeader(tokenInfo: OpenIDTokenInfo | null): string {
  if (!tokenInfo || !tokenInfo.accessToken) {
    return '';
  }

  return `Bearer ${tokenInfo.accessToken}`;
}

export function isOpenIDAvailable(): boolean {
  const openidClientId = process.env.OPENID_CLIENT_ID;
  const openidClientSecret = process.env.OPENID_CLIENT_SECRET;
  const openidIssuer = process.env.OPENID_ISSUER;

  return !!(openidClientId && openidClientSecret && openidIssuer);
}
