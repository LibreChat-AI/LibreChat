import type {
  AuthIdentityContext,
  AuthIdentitySource,
  AuthIdentityTuple,
  LeaseAssertion,
  LeaseContext,
  OIDCTokens,
  OpenIDClaims,
  OpenIDLogger,
  OpenIDRequest,
  OpenIDResponse,
  OpenIDPublicationGeneration,
  OpenIDSessionIdentitySource,
  OpenIDTokenSet,
  OpenIDUser,
  RefreshFlightAcquireResult,
  RefreshFlightRecord,
  RefreshKeyInput,
  RefreshTokenBridgeDeleteInput,
  RefreshTokenBridgeIdentity,
  RefreshTokenBridgeInput,
  SessionOpenIDTokens,
  TokenPreference,
} from './types';
import type { OpenIdSessionDeps, OpenIdSessionParams } from '~/images/session';
import type { TokenResult } from './flight';
import {
  OPENID_REFRESH_CANCELLED_BEFORE_GRANT,
  createOpenIDRefreshOwnershipError,
  isOpenIDRefreshOwnershipError,
  reloadOpenIDSessionIfPersisted,
  toOpenIDLogArgument,
} from './errors';

const PUBLICATION_WAIT_TIMEOUT_MS = 10_000;
const PUBLICATION_WAIT_INTERVAL_MS = 250;

interface OpenIDSessionRefreshDeps {
  jwt: {
    decode: (token: string) => (Partial<OpenIDClaims> & { exp?: number }) | string | null;
    verify: (token: string, secret: string) => { id?: string; refreshTokenHash?: string } | string;
  };
  cookies: { parse: (header: string) => Record<string, string> };
  crypto: {
    createHash: (algorithm: string) => {
      update: (value: string) => { digest: (encoding: 'hex' | 'base64url') => string };
    };
  };
  openIdClient: {
    refreshTokenGrant: (
      config: object,
      refreshToken: string,
      params: Record<string, string>,
    ) => Promise<OpenIDTokenSet>;
  };
  logger: OpenIDLogger;
  defaultRefreshTokenExpiry: number;
  isEnabled: (value?: string) => boolean;
  math: (value: string | undefined, fallback: number) => number;
  createAuthIdentityContext: (args: {
    user?: AuthIdentitySource | null;
    requestUser?: AuthIdentitySource | null;
    tenantId?: string;
    openidIssuer?: string;
  }) => AuthIdentityContext;
  isOpenIDSessionIdentityMatch: (
    session: OpenIDSessionIdentitySource,
    expected: OpenIDSessionIdentitySource,
  ) => boolean;
  createOpenIDRefreshIdentityTuple: (args: {
    user?: AuthIdentitySource | null;
    requestUser?: AuthIdentitySource | null;
  }) => AuthIdentityTuple | null;
  createRefreshTokenBridgeIdentity: (args: {
    user?: AuthIdentitySource | null;
    requestUser?: AuthIdentitySource | null;
    userId?: string;
    tenantId?: string;
    openidIssuer?: string;
  }) => RefreshTokenBridgeIdentity | null;
  serializeAuthIdentityTuple: (tuple: AuthIdentityTuple) => string;
  buildOpenIDRefreshParams: () => Record<string, string>;
  setRefreshTokenCookie: (res: OpenIDResponse, token: string, expires: Date) => void;
  setOpenIDMarkerCookies: (
    res: OpenIDResponse,
    args: {
      userId?: string;
      expires: Date;
      refreshExpiryMs: number;
      refreshToken: string;
    },
  ) => void;
  storeOpenIdSession: (data: OpenIdSessionParams, methods: OpenIdSessionDeps) => Promise<boolean>;
  normalizeExpiresIn: (value?: number | string) => number | undefined;
  upsertSession: OpenIdSessionDeps['upsertSession'];
  deleteSession: OpenIdSessionDeps['deleteSession'];
  getOpenIdConfig: () => object;
  OPENID_REFRESH_BRIDGE_GRACE_MS: number;
  storeRefreshTokenBridge: (input: RefreshTokenBridgeInput) => Promise<string | null>;
  deleteRefreshTokenBridges: (input: RefreshTokenBridgeDeleteInput) => Promise<object | null>;
  acquireOpenIDRefreshFlight: (args: {
    key?: string | null;
  }) => Promise<RefreshFlightAcquireResult>;
  completeOpenIDRefreshFlight: (args: {
    key?: string | null;
    ownerId?: string;
    tokens?: TokenResult | null;
  }) => Promise<RefreshFlightRecord | null>;
  createOpenIDRefreshFlightKey: (input: RefreshKeyInput) => string | null;
  createRefreshTokenBridgeFlightKey?: (
    input: RefreshTokenBridgeIdentity & { oldRefreshToken: string },
  ) => string | null;
  failOpenIDRefreshFlight: (args: {
    key?: string | null;
    ownerId?: string;
    error?: Error | null;
  }) => Promise<RefreshFlightRecord | null>;
  waitForOpenIDRefreshFlight: (args: {
    key?: string | null;
    requirePublication?: boolean;
    signal?: AbortSignal;
    timeoutMs?: number;
    intervalMs?: number;
  }) => Promise<TokenResult | null>;
  assertOpenIDRefreshFlightAvailable: (args: {
    key?: string | null;
    ownerId?: string;
  }) => Promise<RefreshFlightRecord | boolean>;
  assertOpenIDRefreshSessionGenerationAvailable: (args: {
    key?: string | null;
    ownerId?: string;
  }) => Promise<RefreshFlightRecord | boolean>;
  withOpenIDRefreshFlightLease: <T>(args: {
    key?: string | null;
    ownerId?: string;
    operation: (context: LeaseContext) => Promise<T>;
  }) => Promise<T>;
}

interface MarkedOIDCTokens extends OIDCTokens {
  __browserRefreshToken?: string;
  __identityClaims?: OpenIDClaims;
  __predecessorRefreshToken?: string;
  __predecessorAccessToken?: string;
  __deferredPublication?: boolean;
  __flightOwnerId?: string;
  __flightCreatedAt?: number;
  __identityIdToken?: string;
}

interface RefreshSessionOptions {
  forceRefresh?: boolean;
  signal?: AbortSignal;
  assertLeaseOwned?: LeaseAssertion;
  deferPublication?: boolean;
}

interface SessionPublicationEffects {
  durableSession: boolean;
  browserCookies: boolean;
  expressSession: boolean;
  bridge?: {
    version: string;
    predecessorRefreshToken: string;
    identity: RefreshTokenBridgeIdentity;
  };
}

interface CreateOpenIDSessionTokenProviderInput {
  req?: OpenIDRequest;
  res?: OpenIDResponse;
  user?: OpenIDUser;
  tokenPreference: TokenPreference;
  identityContext?: AuthIdentityContext;
}

export interface OpenIDSessionRefreshService {
  createOpenIDSessionTokenProvider: (
    input: CreateOpenIDSessionTokenProviderInput,
  ) => (options?: { forceRefresh?: boolean; signal?: AbortSignal }) => Promise<OIDCTokens | null>;
  refreshOpenIDSession: (
    req: OpenIDRequest,
    res: OpenIDResponse | undefined,
    user: OpenIDUser,
    tokenPreference: TokenPreference,
    identityContext?: AuthIdentityContext,
    options?: RefreshSessionOptions,
  ) => Promise<MarkedOIDCTokens | null>;
  __internals: {
    UPSTREAM_TOKEN_EXPIRY_BUFFER_SECONDS: number;
    inFlightRefreshes: Map<string, Promise<MarkedOIDCTokens | null>>;
    getSingleFlightKey: (
      req: OpenIDRequest,
      user: OpenIDUser,
      identityContext?: AuthIdentityContext,
    ) => string | null;
    isLiveSessionTokenStillValid: (
      sessionTokens: SessionOpenIDTokens,
      tokenPreference: TokenPreference,
    ) => boolean;
    getAccessTokenExp: (sessionTokens: SessionOpenIDTokens) => number | null;
  };
}

/**
 * OpenID session refresh implementation. Runtime-only Express, model, and strategy dependencies
 * are supplied by the thin /api wrapper; the authentication and coordination logic lives here.
 */
export function createOpenIDSessionRefreshService(
  deps: OpenIDSessionRefreshDeps,
): OpenIDSessionRefreshService {
  const {
    jwt,
    cookies,
    crypto,
    openIdClient,
    logger,
    defaultRefreshTokenExpiry: DEFAULT_REFRESH_TOKEN_EXPIRY,
    isEnabled,
    math,
    createAuthIdentityContext,
    isOpenIDSessionIdentityMatch,
    createOpenIDRefreshIdentityTuple,
    createRefreshTokenBridgeIdentity,
    createRefreshTokenBridgeFlightKey,
    serializeAuthIdentityTuple,
    buildOpenIDRefreshParams,
    setRefreshTokenCookie,
    setOpenIDMarkerCookies,
    storeOpenIdSession,
    normalizeExpiresIn,
    upsertSession,
    deleteSession,
    getOpenIdConfig,
    OPENID_REFRESH_BRIDGE_GRACE_MS,
    storeRefreshTokenBridge,
    deleteRefreshTokenBridges,
    acquireOpenIDRefreshFlight,
    completeOpenIDRefreshFlight,
    createOpenIDRefreshFlightKey,
    failOpenIDRefreshFlight,
    waitForOpenIDRefreshFlight,
    assertOpenIDRefreshFlightAvailable,
    assertOpenIDRefreshSessionGenerationAvailable,
    withOpenIDRefreshFlightLease,
  } = deps;

  /**
   * Shape of `req.session.openidTokens`. Established by `setOpenIDAuthTokens`
   * (`api/server/services/AuthService.js`) on login/refresh, mutated in place by
   * this module on inline refresh, and consumed by `refreshController` and
   * `LogoutController`. Distinct from the snake_case `OIDCTokens` type in
   * `@librechat/data-schemas` (which describes `IUser.federatedTokens` /
   * `IUser.openidTokens` — model fields, not the express-session field).
   *
   * Express-session's SessionData is open by design, so this contract lives in
   * comments rather than a TS interface; keep this and AuthService.js in sync
   * when the shape changes.
   *
   * @typedef {Object} SessionOpenIDTokens
   * @property {string} [accessToken]            — IdP access token (may be opaque).
   * @property {string} [idToken]                — IdP ID token (always JWT).
   * @property {string} [refreshToken]           — IdP refresh token.
   * @property {string} [browserRefreshToken]    — refresh token last known to be written to
   *                                               the browser cookie.
   * @property {number} [expiresAt]              — SESSION cookie expiry (ms).
   * @property {number} [lastRefreshedAt]        — wall-clock ms of the last server-side rotation.
   * @property {string} [appUserId]              — LibreChat user id bound to these session tokens.
   * @property {string} [openidSubject]          — OpenID `sub` bound to these session tokens.
   * @property {string} [tenantId]               — tenant bound to these session tokens.
   * @property {string} [openidIssuer]           — normalized issuer bound to these session tokens.
   * @property {number} [accessTokenExpiresAt]   — access token expiry (unix seconds), captured
   *                                               from the IdP `tokenset.expires_in` so opaque
   *                                               access tokens can still be reused without
   *                                               redundant refreshes.
   * @property {string} [publicationFlightKey]  — durable publication key authorizing this state.
   * @property {string} [publicationFlightOwnerId] — exact completed generation for that key.
   */

  /**
   * Skew buffer for the upstream access-token expiry check. Mirrors
   * `OPENID_REUSE_EXPIRY_BUFFER_SECONDS` in `AuthController.js` so that a token
   * which the controller is about to rotate also triggers an inline refresh here.
   */
  const UPSTREAM_TOKEN_EXPIRY_BUFFER_SECONDS = 30;
  const INTERNAL_BROWSER_REFRESH_TOKEN_FIELD = '__browserRefreshToken';
  const INTERNAL_PREDECESSOR_REFRESH_TOKEN_FIELD = '__predecessorRefreshToken';
  const INTERNAL_PREDECESSOR_ACCESS_TOKEN_FIELD = '__predecessorAccessToken';
  const INTERNAL_DEFERRED_PUBLICATION_FIELD = '__deferredPublication';
  const INTERNAL_IDENTITY_ID_TOKEN_FIELD = '__identityIdToken';
  const IDENTITY_PART_SEPARATOR = '\x1f';

  /**
   * In-flight upstream refreshes keyed by `getSingleFlightKey(req, user, identityContext)` —
   * a composite of `tenantId:openidIssuer:subject:refreshTokenHash`.
   * See that helper for the rationale on why each component is needed; in short,
   * tenant+issuer keying prevents cross-tenant token crossover when distinct users
   * share an IdP `sub`, and refresh-token keying makes every request holding the same
   * rotating credential join the same logical grant across sessions and replicas.
   *
   * A fan-out of tool calls carrying the same expired credential coalesces into
   * one IdP refresh-token grant. Mirrors the
   * single-flight pattern in `OboTokenService.js`.
   *
   * Process-local coalescing is backed by a renewable Mongo lease in
   * `performIdpRefresh`, so distinct workers do not admit parallel rotating-token
   * grants for the same key.
   */
  const inFlightRefreshes = new Map<string, Promise<MarkedOIDCTokens | null>>();
  const flightSignals = new WeakMap<Promise<MarkedOIDCTokens | null>, AbortSignal>();

  /**
   * Returns the single-flight key for a refresh attempt, composed from the user's
   * tenant (if any), the IdP issuer + sub, and the current refresh token.
   * Tightening past `openidId` alone serves two purposes:
   *
   *  1. Same credential, multiple Express sessions: every holder joins one grant,
   *     so token rotation cannot admit duplicate IdP refreshes merely because an
   *     Express session expired or a request landed on another replica.
   *  2. Multi-tenant deployments where two distinct users share an IdP `sub`
   *     (different issuers, same sub): tenant + issuer disambiguates them so
   *     tokens never cross tenant boundaries via shared in-flight Promises.
   *
   * Concurrent tool calls inside the SAME session with the SAME refresh token
   * still coalesce — the common case the single-flight is designed for (a fan-out
   * of MCP tool calls in one agent run) is unaffected.
   *
   * Returns null when there's no usable identity at all; callers fall through
   * to a non-coalesced refresh, which is safe but missing the optimization.
   */
  function getSingleFlightKey(
    req: OpenIDRequest,
    user: OpenIDUser,
    identityContext?: AuthIdentityContext,
  ): string | null {
    const identitySource = identityContext
      ? {
          id: identityContext.appUserId,
          openidId: identityContext.openidSubject,
          tenantId: identityContext.tenantId,
          openidIssuer: identityContext.openidIssuer,
        }
      : user;
    const tuple = createOpenIDRefreshIdentityTuple({
      user: identitySource,
      requestUser: req?.user,
    });
    const refreshToken = req?.session?.openidTokens?.refreshToken;
    if (!tuple || !refreshToken) {
      return null;
    }
    const refreshTokenHash = crypto.createHash('sha256').update(refreshToken).digest('hex');
    return [serializeAuthIdentityTuple(tuple), refreshTokenHash].join(IDENTITY_PART_SEPARATOR);
  }

  /**
   * Returns a short SHA-256 prefix of the single-flight key for use in logs.
   * Preserves correlation across "started" / "joined" / "completed" log events
   * for the same refresh attempt without leaking the underlying values:
   *
   *   - refresh-token hashes are still credential-derived and remain private.
   *   - openidId (the IdP `sub`) and openidIssuer are tenant/user fingerprints.
   *
   * 12 hex chars = 48 bits of entropy: ~7×10^14 distinct keys before a 50%
   * collision chance — more than enough for correlating concurrent refreshes.
   */
  function hashKeyForLogs(key: string): string {
    return crypto.createHash('sha256').update(key).digest('hex').slice(0, 12);
  }

  function resolveExpectedOpenIDSessionIdentity(
    req: OpenIDRequest,
    user: OpenIDUser,
    identityContext?: AuthIdentityContext,
  ): AuthIdentityContext {
    if (!identityContext) {
      return createAuthIdentityContext({
        user,
        requestUser: req?.user,
      });
    }

    return createAuthIdentityContext({
      user: {
        id: identityContext.appUserId,
        openidId: identityContext.openidSubject,
        tenantId: identityContext.tenantId,
        openidIssuer: identityContext.openidIssuer,
      },
      requestUser: user ?? req?.user,
      tenantId: identityContext.tenantId,
      openidIssuer: identityContext.openidIssuer,
    });
  }

  function hasAnyOpenIDSessionIdentity(sessionTokens: SessionOpenIDTokens): boolean {
    const identityFields: Array<keyof OpenIDSessionIdentitySource> = [
      'appUserId',
      'openidSubject',
      'tenantId',
      'openidIssuer',
    ];
    return identityFields.some((field) => sessionTokens?.[field] != null);
  }

  function canBindLegacyOpenIDSession(
    req: OpenIDRequest,
    sessionTokens: SessionOpenIDTokens,
    expectedIdentity: AuthIdentityContext,
  ): boolean {
    if (
      hasAnyOpenIDSessionIdentity(sessionTokens) ||
      !expectedIdentity.appUserId ||
      !expectedIdentity.openidSubject ||
      !process.env.JWT_REFRESH_SECRET
    ) {
      return false;
    }

    const parsedCookies = req?.headers?.cookie ? cookies.parse(req.headers.cookie) : {};
    const browserRefreshToken = parsedCookies.refreshToken;
    const expectedBrowserRefreshToken =
      sessionTokens.browserRefreshToken || sessionTokens.refreshToken;
    if (
      !browserRefreshToken ||
      !expectedBrowserRefreshToken ||
      browserRefreshToken !== expectedBrowserRefreshToken ||
      !parsedCookies.openid_user_id
    ) {
      return false;
    }

    try {
      const marker = jwt.verify(parsedCookies.openid_user_id, process.env.JWT_REFRESH_SECRET);
      if (
        typeof marker !== 'object' ||
        marker == null ||
        marker.id !== expectedIdentity.appUserId ||
        typeof marker.refreshTokenHash !== 'string'
      ) {
        return false;
      }
      const refreshTokenHash = crypto
        .createHash('sha256')
        .update(browserRefreshToken)
        .digest('base64url');
      return marker.refreshTokenHash === refreshTokenHash;
    } catch {
      return false;
    }
  }

  function assertOpenIDSessionIdentityMatch(
    req: OpenIDRequest,
    user: OpenIDUser,
    identityContext?: AuthIdentityContext,
  ): Promise<void> | undefined {
    const sessionTokens = req?.session?.openidTokens;
    if (!sessionTokens) {
      return;
    }

    const expectedIdentity = resolveExpectedOpenIDSessionIdentity(req, user, identityContext);
    if (isOpenIDSessionIdentityMatch(sessionTokens, expectedIdentity)) {
      return;
    }

    /**
     * Sessions minted before identity stamping was deployed have none of these
     * fields. During a rolling upgrade, bind that legacy record only when the
     * signed browser marker proves the current app user and refresh-token cookie
     * are the ones that created it. Partial or unverifiable metadata still fails
     * closed, preventing cross-user token adoption.
     */
    if (canBindLegacyOpenIDSession(req, sessionTokens, expectedIdentity)) {
      Object.assign(sessionTokens, expectedIdentity);
      return persistSession(req).then(() => {
        logger.info('[OpenIDSessionRefresh] Bound verified legacy OpenID session identity', {
          userId: expectedIdentity.appUserId,
        });
      });
    }

    logger.warn('[OpenIDSessionRefresh] OpenID session token identity mismatch; refusing reuse', {
      userId: expectedIdentity.appUserId,
      has_session_user_id: Boolean(sessionTokens.appUserId),
      has_session_subject: Boolean(sessionTokens.openidSubject),
      has_session_issuer: Boolean(sessionTokens.openidIssuer),
    });
    throw new Error('OpenID session token identity mismatch');
  }

  function decodeJwtExp(token?: string): number | null {
    if (typeof token !== 'string' || token.length === 0) {
      return null;
    }
    try {
      const decoded = jwt.decode(token);
      if (!decoded || typeof decoded !== 'object') {
        return null;
      }
      return typeof decoded.exp === 'number' ? decoded.exp : null;
    } catch (error) {
      logger.debug(
        '[OpenIDSessionRefresh] JWT decode failed (non-fatal)',
        (error as Error)?.message,
      );
      return null;
    }
  }

  /**
   * Returns the access token's expiry in unix seconds, preferring the JWT `exp`
   * claim and falling back to the persisted `accessTokenExpiresAt` written from
   * the IdP's `tokenset.expires_in` on the previous refresh.
   *
   * The fallback exists because some IdPs (Microsoft Entra for Graph audiences,
   * Auth0 without a custom audience) issue OPAQUE access tokens whose expiry
   * cannot be decoded locally. Without this lookup, every OBO call would treat
   * the session as expired and burn an IdP refresh, risking refresh-token
   * rotation thrash under concurrent tool calls.
   *
   * @param {{ accessToken?: string, accessTokenExpiresAt?: number }} sessionTokens
   * @returns {number | null} unix seconds, or null when no source proves an expiry
   */
  function getAccessTokenExp(sessionTokens: SessionOpenIDTokens): number | null {
    const fromJwt = decodeJwtExp(sessionTokens?.accessToken);
    if (fromJwt != null) {
      return fromJwt;
    }
    const persisted = sessionTokens?.accessTokenExpiresAt;
    return typeof persisted === 'number' ? persisted : null;
  }

  function canWriteRefreshTokenCookie(res?: OpenIDResponse): res is OpenIDResponse & {
    cookie: NonNullable<OpenIDResponse['cookie']>;
  } {
    return !!res && typeof res.cookie === 'function' && !res.headersSent;
  }

  /**
   * Returns true when the session token nominated by `tokenPreference` is still
   * valid for at least the skew buffer. Required argument (no default) so every
   * caller is explicit about which token's freshness gates this check.
   *
   * Use 'access_token' for OBO and any flow whose downstream sends the access
   * token to the IdP as an assertion (jwt-bearer / on-behalf-of) — those flows
   * fail when the access token is expired even if the id_token is still fresh.
   * Access-token expiry is read via `getAccessTokenExp`, which handles opaque
   * (non-JWT) tokens by falling back to the persisted `accessTokenExpiresAt`.
   *
   * Use 'id_token' for flows whose downstream is the LibreChat backend itself
   * (e.g. session-token reuse in `refreshController`); the id_token is the
   * standard JWT signed for the client_id audience and is the bearer the SPA
   * sends back to LibreChat.
   *
   * @param {{ accessToken?: string, idToken?: string, accessTokenExpiresAt?: number }} sessionTokens
   * @param {'access_token' | 'id_token'} tokenPreference
   */
  function isLiveSessionTokenStillValid(
    sessionTokens: SessionOpenIDTokens,
    tokenPreference: TokenPreference,
  ): boolean {
    if (tokenPreference !== 'access_token' && tokenPreference !== 'id_token') {
      throw new Error(
        `[OpenIDSessionRefresh] tokenPreference must be 'access_token' or 'id_token', got: ${tokenPreference}`,
      );
    }
    const now = Math.floor(Date.now() / 1000);
    const exp =
      tokenPreference === 'access_token'
        ? getAccessTokenExp(sessionTokens)
        : decodeJwtExp(sessionTokens?.idToken);
    return exp != null && exp > now + UPSTREAM_TOKEN_EXPIRY_BUFFER_SECONDS;
  }

  /**
   * Builds the OIDCTokens shape consumed by `resolveOboToken`. Required
   * `tokenPreference` selects which token's expiry becomes `expires_at` —
   * caller intent must match what the downstream consumer actually validates.
   * `expiresAtOverride` (unix seconds) wins when the caller has an authoritative
   * value such as the IdP's `tokenset.expires_in` from a fresh refresh response;
   * use it after refresh so we never attribute a prior token's `exp` to a freshly
   * rotated counterpart. For 'access_token', the fallback uses `getAccessTokenExp`
   * so opaque tokens are handled correctly via the persisted `accessTokenExpiresAt`.
   *
   * @param {{ accessToken?: string, idToken?: string, refreshToken?: string, accessTokenExpiresAt?: number }} sessionTokens
   * @param {'access_token' | 'id_token'} tokenPreference
   * @param {number} [expiresAtOverride] — unix seconds (preferred when present)
   */
  function buildOIDCTokensFromSession(
    sessionTokens: SessionOpenIDTokens,
    tokenPreference: TokenPreference,
    expiresAtOverride?: number,
  ): MarkedOIDCTokens {
    if (tokenPreference !== 'access_token' && tokenPreference !== 'id_token') {
      throw new Error(
        `[OpenIDSessionRefresh] tokenPreference must be 'access_token' or 'id_token', got: ${tokenPreference}`,
      );
    }
    let expiresAt = expiresAtOverride;
    if (expiresAt == null) {
      expiresAt =
        tokenPreference === 'access_token'
          ? (getAccessTokenExp(sessionTokens) ?? undefined)
          : (decodeJwtExp(sessionTokens?.idToken) ?? undefined);
    }
    return {
      access_token: sessionTokens?.accessToken,
      id_token: sessionTokens?.idToken,
      refresh_token: sessionTokens?.refreshToken,
      expires_at: expiresAt ?? undefined,
    };
  }

  function resolveRefreshIdentityClaims(
    tokenset: OpenIDTokenSet,
    fallbackIdToken?: string,
  ): OpenIDClaims | null {
    if (typeof tokenset.claims === 'function') {
      const claims = tokenset.claims();
      if (claims?.sub) {
        return claims;
      }
    }
    const idToken = tokenset.id_token || fallbackIdToken;
    const decoded = idToken ? jwt.decode(idToken) : null;
    if (!decoded || typeof decoded !== 'object' || typeof decoded.sub !== 'string') {
      return null;
    }
    return decoded as OpenIDClaims;
  }

  function attachBrowserRefreshTokenMarker<T extends MarkedOIDCTokens | null>(
    tokens: T,
    browserRefreshToken?: string,
  ): T {
    if (!tokens || !browserRefreshToken) {
      return tokens;
    }
    Object.defineProperty(tokens, INTERNAL_BROWSER_REFRESH_TOKEN_FIELD, {
      value: browserRefreshToken,
      enumerable: false,
      configurable: true,
    });
    return tokens;
  }

  function getBrowserRefreshTokenMarker(tokens: MarkedOIDCTokens): string | null {
    const browserRefreshToken = tokens?.[INTERNAL_BROWSER_REFRESH_TOKEN_FIELD];
    return typeof browserRefreshToken === 'string' && browserRefreshToken
      ? browserRefreshToken
      : null;
  }

  function attachIdentityIdTokenMarker<T extends MarkedOIDCTokens | null>(
    tokens: T,
    idToken?: string,
  ): T {
    if (!tokens || !idToken) return tokens;
    Object.defineProperty(tokens, INTERNAL_IDENTITY_ID_TOKEN_FIELD, {
      value: idToken,
      enumerable: false,
      configurable: true,
    });
    return tokens;
  }

  function attachPredecessorRefreshTokenMarker<T extends MarkedOIDCTokens | null>(
    tokens: T,
    predecessorRefreshToken?: string,
  ): T {
    if (!tokens || !predecessorRefreshToken) return tokens;
    Object.defineProperty(tokens, INTERNAL_PREDECESSOR_REFRESH_TOKEN_FIELD, {
      value: predecessorRefreshToken,
      enumerable: false,
      configurable: true,
    });
    return tokens;
  }

  function attachPredecessorAccessTokenMarker<T extends MarkedOIDCTokens | null>(
    tokens: T,
    predecessorAccessToken?: string,
  ): T {
    if (!tokens || !predecessorAccessToken) return tokens;
    Object.defineProperty(tokens, INTERNAL_PREDECESSOR_ACCESS_TOKEN_FIELD, {
      value: predecessorAccessToken,
      enumerable: false,
      configurable: true,
    });
    return tokens;
  }

  function attachDeferredPublicationMarker<T extends MarkedOIDCTokens | null>(
    tokens: T,
    deferred: boolean,
  ): T {
    if (!tokens || !deferred) return tokens;
    Object.defineProperty(tokens, INTERNAL_DEFERRED_PUBLICATION_FIELD, {
      value: true,
      enumerable: false,
      configurable: true,
    });
    return tokens;
  }

  function attachFlightOwnerMarker<T extends MarkedOIDCTokens | null>(
    tokens: T,
    ownerId?: string,
    createdAt?: number,
  ): T {
    if (!tokens || !ownerId) return tokens;
    Object.defineProperty(tokens, '__flightOwnerId', {
      value: ownerId,
      enumerable: false,
      configurable: true,
    });
    if (Number.isFinite(createdAt)) {
      Object.defineProperty(tokens, '__flightCreatedAt', {
        value: createdAt,
        enumerable: false,
        configurable: true,
      });
    }
    return tokens;
  }

  function getPredecessorRefreshTokenMarker(tokens: MarkedOIDCTokens): string | null {
    const predecessor = tokens?.[INTERNAL_PREDECESSOR_REFRESH_TOKEN_FIELD];
    return typeof predecessor === 'string' && predecessor ? predecessor : null;
  }

  function cloneResolvedTokens(tokens: MarkedOIDCTokens): MarkedOIDCTokens {
    const clone = { ...tokens };
    attachBrowserRefreshTokenMarker(clone, getBrowserRefreshTokenMarker(tokens) ?? undefined);
    attachPredecessorRefreshTokenMarker(
      clone,
      getPredecessorRefreshTokenMarker(tokens) ?? undefined,
    );
    attachPredecessorAccessTokenMarker(clone, tokens.__predecessorAccessToken);
    attachDeferredPublicationMarker(clone, tokens.__deferredPublication === true);
    attachFlightOwnerMarker(clone, tokens.__flightOwnerId, tokens.__flightCreatedAt);
    attachIdentityIdTokenMarker(clone, tokens.__identityIdToken);
    return clone;
  }

  function hasSessionAdvancedPastResult(
    existing: SessionOpenIDTokens,
    resolvedTokens: MarkedOIDCTokens,
    predecessorOverride?: string,
  ): boolean {
    const predecessorRefreshToken =
      getPredecessorRefreshTokenMarker(resolvedTokens) ?? predecessorOverride;
    const refreshTokenAdvanced = Boolean(
      predecessorRefreshToken &&
        existing.refreshToken &&
        existing.refreshToken !== predecessorRefreshToken &&
        existing.refreshToken !== resolvedTokens.refresh_token,
    );
    const predecessorAccessToken = resolvedTokens.__predecessorAccessToken;
    const accessTokenAdvanced = Boolean(
      predecessorAccessToken &&
        existing.accessToken &&
        existing.accessToken !== predecessorAccessToken &&
        existing.accessToken !== resolvedTokens.access_token,
    );
    return refreshTokenAdvanced || accessTokenAdvanced;
  }

  async function persistSession(req: OpenIDRequest): Promise<void> {
    if (typeof req?.session?.save !== 'function') {
      return;
    }
    const save = req.session.save.bind(req.session);
    await new Promise<void>((resolve, reject) => {
      save((err?: Error | null) => {
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      });
    });
  }

  /**
   * Writes the rotated refresh token and OpenID marker cookies to the browser so
   * they stay in sync with the session copy. These cookies outlive the shorter
   * express-session cookie and are the fallback `refreshController` reads when
   * the session is gone; without this sync an OBO-triggered rotation would leave
   * stale or mismatched cookies and sign the user out on the next refresh.
   *
   * When no cookie-capable response is available, or `res.headersSent` is true
   * (streaming SSE path), the cookie cannot be set. In this case, store a
   * server-side recovery bridge so that if the session is later lost,
   * `refreshController` can look up the rotated token by hash of the stale cookie
   * token.
   *
   * @param {object} args
   * @param {import('express').Response} [args.res]
   * @param {string} args.newRefreshToken — the rotated token to sync
   * @param {string} [args.oldRefreshToken] — the browser-cookie token to bridge from
   * @param {string} [args.previousSessionRefreshToken] — durable session token to revoke
   * @param {string} [args.userId] — user._id (required for bridge verification)
   * @param {string} [args.tenantId] — user.tenantId (optional, verified on bridge lookup)
   * @param {string} [args.openidIssuer] — user.openidIssuer (optional, verified on bridge lookup)
   */
  async function syncRefreshTokenCookie({
    res,
    newRefreshToken,
    oldRefreshToken,
    previousSessionRefreshToken,
    userId,
    tenantId,
    openidIssuer,
    assertLeaseOwned,
  }: {
    res?: OpenIDResponse;
    newRefreshToken: string;
    oldRefreshToken?: string;
    previousSessionRefreshToken?: string;
    userId?: string;
    tenantId?: string;
    openidIssuer?: string;
    assertLeaseOwned?: LeaseAssertion;
  }): Promise<string | null> {
    if (assertLeaseOwned) {
      await assertLeaseOwned();
    }

    if (canWriteRefreshTokenCookie(res)) {
      const expiryInMilliseconds = math(
        process.env.REFRESH_TOKEN_EXPIRY,
        DEFAULT_REFRESH_TOKEN_EXPIRY,
      );
      const expirationDate = new Date(Date.now() + expiryInMilliseconds);
      /**
       * The durable Session record is what authorizes local image access for OpenID users
       * (`authenticateRequest` in `packages/api/src/images/authorization.ts` looks it up by the
       * browser's refresh-token cookie). The cookie just moved to the rotated token, so the record
       * has to move with it — otherwise every image request 401s until the next `/refresh`.
       * The bridge branch below deliberately leaves the record alone: there the browser keeps the
       * old cookie, and `refreshController` rewrites both once it recovers through the bridge.
       */
      if (userId) {
        try {
          await storeOpenIdSession(
            {
              userId,
              refreshToken: newRefreshToken,
              tenantId,
              previousRefreshToken: previousSessionRefreshToken ?? oldRefreshToken,
            },
            { upsertSession, deleteSession },
          );
        } catch (error) {
          /**
           * The durable transition is an upsert followed by deletion. If deletion fails after
           * the upsert succeeds, the IdP has already spent the old token while the browser still
           * carries it. Persist a short predecessor bridge before surfacing the failure so the
           * next request can recover the only viable credential.
           */
          await storeSessionSaveFailureBridge({
            oldRefreshToken,
            newRefreshToken,
            bridgeIdentity: { userId, tenantId, openidIssuer },
            assertLeaseOwned,
          });
          throw error;
        }
      }
      if (assertLeaseOwned) {
        try {
          await assertLeaseOwned();
        } catch (error) {
          if (!isOpenIDRefreshOwnershipError(error)) {
            await storeSessionSaveFailureBridge({
              oldRefreshToken,
              newRefreshToken,
              bridgeIdentity: userId ? { userId, tenantId, openidIssuer } : null,
            });
            throw error;
          }
          if (userId) {
            try {
              await deleteSession({ refreshToken: newRefreshToken });
            } catch (cleanupError) {
              logger.warn(
                '[OpenIDSessionRefresh] Failed to remove the successor after ownership loss',
                toOpenIDLogArgument(cleanupError),
              );
            }
          }
          throw error;
        }
      }
      setRefreshTokenCookie(res, newRefreshToken, expirationDate);
      setOpenIDMarkerCookies(res, {
        userId,
        expires: expirationDate,
        refreshExpiryMs: expiryInMilliseconds,
        refreshToken: newRefreshToken,
      });
      return null;
    }

    if (oldRefreshToken && userId) {
      const bridgeVersion = await storeRefreshTokenBridgeWithLease({
        oldRefreshToken,
        newRefreshToken,
        userId,
        tenantId,
        openidIssuer,
        assertLeaseOwned,
      });
      logger.debug('[OpenIDSessionRefresh] Stored refresh-token recovery bridge', {
        userId,
        responseAvailable: !!res,
        headersSent: !!res?.headersSent,
        hasCookieWriter: typeof res?.cookie === 'function',
      });
      return bridgeVersion;
    } else {
      logger.warn(
        '[OpenIDSessionRefresh] Cannot set refresh-token cookie and insufficient context to store bridge',
        {
          responseAvailable: !!res,
          headersSent: !!res?.headersSent,
          hasCookieWriter: typeof res?.cookie === 'function',
          hasOldToken: !!oldRefreshToken,
          hasUserId: !!userId,
        },
      );
    }
    return null;
  }

  async function storeRefreshTokenBridgeWithLease({
    assertLeaseOwned,
    ...bridge
  }: RefreshTokenBridgeInput & { assertLeaseOwned?: LeaseAssertion }): Promise<string | null> {
    if (assertLeaseOwned) {
      await assertLeaseOwned();
    }
    const bridgeVersion = await storeRefreshTokenBridge(bridge);
    if (!assertLeaseOwned) {
      return bridgeVersion;
    }
    try {
      await assertLeaseOwned();
    } catch (error) {
      /**
       * Only a proven ownership loss justifies removing what we just published. A coordination
       * read that merely failed leaves ownership unknown, and on the headers-already-sent path
       * this bridge is the only mapping from the token the browser still holds to the one the
       * IdP has already rotated to — deleting it on a transient error signs the user out.
       */
      if (!isOpenIDRefreshOwnershipError(error)) {
        logger.warn(
          '[OpenIDSessionRefresh] Keeping the recovery bridge; lease ownership is undetermined',
          { userId: bridge.userId, error: (error as Error)?.message },
        );
        throw error;
      }
      try {
        await deleteRefreshTokenBridges({
          refreshTokens: [bridge.oldRefreshToken],
          userId: bridge.userId,
          tenantId: bridge.tenantId,
          ...(bridgeVersion ? { version: bridgeVersion } : {}),
        });
      } catch (cleanupError) {
        logger.error(
          '[OpenIDSessionRefresh] Failed to remove bridge after refresh ownership loss',
          toOpenIDLogArgument(cleanupError),
        );
      }
      throw error;
    }
    return bridgeVersion;
  }

  async function storeSessionSaveFailureBridge({
    oldRefreshToken,
    newRefreshToken,
    bridgeIdentity,
    assertLeaseOwned,
  }: {
    oldRefreshToken?: string;
    newRefreshToken?: string;
    bridgeIdentity?: RefreshTokenBridgeIdentity | null;
    assertLeaseOwned?: LeaseAssertion;
  }): Promise<void> {
    if (!oldRefreshToken || !newRefreshToken || !bridgeIdentity?.userId) {
      return;
    }

    try {
      await storeRefreshTokenBridgeWithLease({
        oldRefreshToken,
        newRefreshToken,
        userId: bridgeIdentity.userId,
        tenantId: bridgeIdentity.tenantId,
        openidIssuer: bridgeIdentity.openidIssuer,
        ttl: OPENID_REFRESH_BRIDGE_GRACE_MS,
        assertLeaseOwned,
      });
      logger.warn(
        '[OpenIDSessionRefresh] Stored short refresh-token bridge after session save failure',
        {
          userId: bridgeIdentity.userId,
          ttl: OPENID_REFRESH_BRIDGE_GRACE_MS,
        },
      );
    } catch (bridgeError) {
      logger.warn(
        '[OpenIDSessionRefresh] Failed to store refresh-token bridge after session save failure',
        toOpenIDLogArgument(bridgeError),
      );
    }
  }

  async function performIdpRefreshGrant(
    req: OpenIDRequest,
    res: OpenIDResponse | undefined,
    user: OpenIDUser,
    tokenPreference: TokenPreference,
    identityContext: AuthIdentityContext | undefined,
    assertLeaseOwned?: LeaseAssertion,
    deferPublication = false,
  ): Promise<MarkedOIDCTokens | null> {
    const sessionTokens = req?.session?.openidTokens;
    const refreshToken = sessionTokens?.refreshToken;
    if (!refreshToken) {
      logger.debug(
        '[OpenIDSessionRefresh] Session lacks refresh_token; cannot refresh upstream token',
      );
      return null;
    }

    const config = getOpenIdConfig();
    const refreshParams = buildOpenIDRefreshParams();
    logger.debug('[OpenIDSessionRefresh] Performing inline IdP refresh-token grant');
    const tokenset = await openIdClient.refreshTokenGrant(config, refreshToken, refreshParams);

    /**
     * A rotating grant can finish after this worker's Mongo lease was reclaimed. Re-prove
     * ownership before mutating the Express session, cookies, bridge, or durable session so a
     * stale owner cannot publish credentials after another worker has taken over.
     */
    if (assertLeaseOwned) {
      await assertLeaseOwned();
    }

    if (!tokenset?.access_token) {
      throw new Error('IdP refresh returned no access_token');
    }

    /**
     * Preserve previous values when the IdP omits `id_token` / `refresh_token`
     * on rotation (Auth0 with rotation off, MS personal accounts in some flows).
     * Same fallback behavior as setOpenIDAuthTokens.
     */
    const nextIdToken = tokenset.id_token || sessionTokens.idToken;
    const nextRefreshToken = tokenset.refresh_token || refreshToken;
    const browserRefreshToken = sessionTokens.browserRefreshToken || refreshToken;
    const needsRefreshTokenSync = nextRefreshToken !== browserRefreshToken;
    const willWriteRefreshTokenCookie =
      !deferPublication && needsRefreshTokenSync && canWriteRefreshTokenCookie(res);

    /**
     * Capture the freshly-issued access-token's expiry (unix seconds) so the
     * next OBO call can reuse it without a redundant refresh — critical for
     * opaque (non-JWT) access tokens whose expiry isn't readable from the
     * token itself. Source order:
     *   1. tokenset.expires_in — IdP's authoritative value for the new access
     *      token. Always preferred when present.
     *   2. decodeJwtExp(tokenset.access_token) — only when access_token is
     *      itself a JWT. Decoding is a fact about THIS token, not a guess.
     *
     * Deliberately do NOT fall back to id_token's exp: id_token TTL is governed
     * by IdP session policy and is often longer than access-token TTL. Trusting
     * it would mark an opaque access token reusable past its real lifetime, so
     * a stale token would be sent to the OBO IdP and rejected. When neither
     * source proves an expiry, leave `accessTokenExpiresAt` unset; the next
     * freshness check will correctly fall through to refresh.
     */
    let nextAccessTokenExp = null;
    const accessTokenExpiresIn = normalizeExpiresIn(tokenset.expires_in);
    if (accessTokenExpiresIn != null) {
      nextAccessTokenExp = Math.floor(Date.now() / 1000) + accessTokenExpiresIn;
    } else {
      nextAccessTokenExp = decodeJwtExp(tokenset.access_token);
    }
    /**
     * `normalizeExpiresIn` preserves a zero or negative lifetime rather than discarding it, so a
     * grant can succeed while declaring a credential that is already spent. Publishing it rotates
     * the refresh token and hands the caller a token every freshness check rejects, which turns
     * each OBO call into another rotation. An unknown expiry is not an elapsed one and still
     * publishes.
     */
    if (nextAccessTokenExp != null && nextAccessTokenExp <= Math.floor(Date.now() / 1000)) {
      throw new Error('IdP refresh returned an already-expired access_token');
    }

    const updatedSessionTokens = {
      ...sessionTokens,
      accessToken: tokenset.access_token,
      idToken: nextIdToken,
      refreshToken: nextRefreshToken,
      browserRefreshToken: willWriteRefreshTokenCookie ? nextRefreshToken : browserRefreshToken,
      lastRefreshedAt: Date.now(),
    };
    if (nextAccessTokenExp != null) {
      updatedSessionTokens.accessTokenExpiresAt = nextAccessTokenExp;
    } else {
      /** Drop a stale value rather than carry it across an unknown-expiry rotation. */
      delete updatedSessionTokens.accessTokenExpiresAt;
    }

    const resolvedTokens = buildOIDCTokensFromSession(
      updatedSessionTokens,
      tokenPreference,
      nextAccessTokenExp ?? undefined,
    );
    attachPredecessorAccessTokenMarker(resolvedTokens, sessionTokens.accessToken);
    const identityClaims = resolveRefreshIdentityClaims(tokenset, sessionTokens.idToken);
    if (identityClaims) {
      resolvedTokens.__identityClaims = identityClaims;
    }
    const fallbackIdTokenExp = decodeJwtExp(sessionTokens.idToken);
    if (
      !tokenset.id_token &&
      (fallbackIdTokenExp == null ||
        fallbackIdTokenExp <= Math.floor(Date.now() / 1000) + UPSTREAM_TOKEN_EXPIRY_BUFFER_SECONDS)
    ) {
      delete resolvedTokens.id_token;
      /**
       * The stripped token is still the only identity material this rotation left behind, and a
       * rebuilt token set carries no provider `claims()`, so `getTokenClaims` would have nothing
       * left to read. Keep it reachable for identity resolution without letting it back into the
       * authentication response.
       */
      attachIdentityIdTokenMarker(resolvedTokens, sessionTokens.idToken);
    }

    if (deferPublication) {
      return attachBrowserRefreshTokenMarker(
        resolvedTokens,
        updatedSessionTokens.browserRefreshToken,
      );
    }

    /**
     * Keep the browser refresh-token cookie in sync with the session token. If headers are
     * already sent (SSE streaming), store a recovery bridge instead. Do this before the
     * session save so a transient session-store failure cannot lose an IdP-rotated token.
     */
    let bridgeIdentity = null;
    if (needsRefreshTokenSync) {
      bridgeIdentity = createRefreshTokenBridgeIdentity({
        user,
        requestUser: req?.user,
        userId: identityContext?.appUserId,
        tenantId: identityContext?.tenantId,
        openidIssuer: identityContext?.openidIssuer,
      });

      await syncRefreshTokenCookie({
        res,
        newRefreshToken: nextRefreshToken,
        oldRefreshToken: browserRefreshToken,
        previousSessionRefreshToken: refreshToken,
        userId: bridgeIdentity?.userId,
        tenantId: bridgeIdentity?.tenantId,
        openidIssuer: bridgeIdentity?.openidIssuer,
        assertLeaseOwned,
      });
    }

    /** Cookie/bridge synchronization may involve I/O; do not persist after losing the lease. */
    if (assertLeaseOwned) {
      await assertLeaseOwned();
    }

    if (!req.session) {
      throw new Error('OpenID refresh requires an Express session');
    }
    req.session.openidTokens = updatedSessionTokens;

    try {
      await persistSession(req);
    } catch (error) {
      if (needsRefreshTokenSync && willWriteRefreshTokenCookie) {
        await storeSessionSaveFailureBridge({
          oldRefreshToken: browserRefreshToken,
          newRefreshToken: nextRefreshToken,
          bridgeIdentity,
          assertLeaseOwned,
        });
      }
      throw error;
    }

    logger.info('[OpenIDSessionRefresh] Inline refresh succeeded');
    /**
     * Pass the same expiry as the explicit `expiresAtOverride` so the returned
     * OIDCTokens carries it directly, regardless of token preference. After
     * refresh the IdP's value is authoritative and supersedes any decode.
     */
    return attachBrowserRefreshTokenMarker(
      resolvedTokens,
      updatedSessionTokens.browserRefreshToken,
    );
  }

  async function publishResolvedSessionTokens({
    req,
    res,
    user,
    identityContext,
    resolvedTokens,
    predecessorRefreshToken,
    tokenPreference,
    assertLeaseOwned,
    publicationGeneration,
    effects,
  }: {
    req: OpenIDRequest;
    res?: OpenIDResponse;
    user: OpenIDUser;
    identityContext?: AuthIdentityContext;
    resolvedTokens: MarkedOIDCTokens | null;
    predecessorRefreshToken?: string;
    tokenPreference: TokenPreference;
    assertLeaseOwned?: LeaseAssertion;
    publicationGeneration?: OpenIDPublicationGeneration;
    effects?: SessionPublicationEffects;
  }): Promise<MarkedOIDCTokens | null> {
    if (!resolvedTokens?.access_token) return null;
    if (assertLeaseOwned) await assertLeaseOwned();
    await reloadOpenIDSessionIfPersisted(req.session);
    if (assertLeaseOwned) await assertLeaseOwned();
    const requestTokens = cloneResolvedTokens(resolvedTokens);
    if (
      req.session?.openidTokens &&
      hasSessionAdvancedPastResult(req.session.openidTokens, requestTokens, predecessorRefreshToken)
    ) {
      logger.info(
        '[OpenIDSessionRefresh] Skipping stale flight publication because the session advanced',
      );
      await assertOpenIDRefreshSessionGenerationAvailable({
        key: req.session.openidTokens.publicationFlightKey,
        ownerId: req.session.openidTokens.publicationFlightOwnerId,
      });
      const effectiveTokens = buildOIDCTokensFromSession(req.session.openidTokens, tokenPreference);
      attachPredecessorRefreshTokenMarker(
        effectiveTokens,
        getPredecessorRefreshTokenMarker(requestTokens) ?? predecessorRefreshToken,
      );
      attachPredecessorAccessTokenMarker(effectiveTokens, requestTokens.__predecessorAccessToken);
      return effectiveTokens;
    }
    const nextRefreshToken = requestTokens.refresh_token ?? predecessorRefreshToken;
    const browserRefreshToken =
      getBrowserRefreshTokenMarker(requestTokens) ?? predecessorRefreshToken;
    if (nextRefreshToken && nextRefreshToken !== browserRefreshToken) {
      const writesBrowserCookie = canWriteRefreshTokenCookie(res);
      const bridgeIdentity = createRefreshTokenBridgeIdentity({
        user,
        requestUser: req.user,
        userId: identityContext?.appUserId,
        tenantId: identityContext?.tenantId,
        openidIssuer: identityContext?.openidIssuer,
      });
      const bridgeVersion = await syncRefreshTokenCookie({
        res,
        newRefreshToken: nextRefreshToken,
        oldRefreshToken: browserRefreshToken,
        previousSessionRefreshToken: predecessorRefreshToken,
        userId: bridgeIdentity?.userId,
        tenantId: bridgeIdentity?.tenantId,
        openidIssuer: bridgeIdentity?.openidIssuer,
        assertLeaseOwned,
      });
      if (effects && bridgeVersion && browserRefreshToken && bridgeIdentity) {
        effects.bridge = {
          version: bridgeVersion,
          predecessorRefreshToken: browserRefreshToken,
          identity: bridgeIdentity,
        };
      }
      if (writesBrowserCookie) {
        if (effects) {
          effects.durableSession = Boolean(bridgeIdentity?.userId);
          effects.browserCookies = true;
        }
        attachBrowserRefreshTokenMarker(requestTokens, nextRefreshToken);
      }
    }
    if (assertLeaseOwned) await assertLeaseOwned();
    const hydrated = await hydrateSessionFromResolvedTokens(
      req,
      requestTokens,
      predecessorRefreshToken,
      false,
      publicationGeneration,
    );
    if (effects && hydrated) {
      effects.expressSession = true;
    }
    if (assertLeaseOwned) await assertLeaseOwned();
    return requestTokens;
  }

  async function rollbackSessionPublication(
    req: OpenIDRequest,
    res: OpenIDResponse | undefined,
    resolvedTokens: MarkedOIDCTokens | null,
    effects: SessionPublicationEffects,
    successorRefreshToken?: string,
  ): Promise<void> {
    if (effects.durableSession && successorRefreshToken) {
      try {
        await deleteSession({ refreshToken: successorRefreshToken });
      } catch (error) {
        logger.warn(
          '[OpenIDSessionRefresh] Failed to remove successor during publication rollback',
          toOpenIDLogArgument(error),
        );
      }
    }
    let shouldClearExpressSession = effects.expressSession;
    if (shouldClearExpressSession && typeof req.session?.reload === 'function') {
      try {
        const reload = req.session.reload.bind(req.session);
        await new Promise<void>((resolve, reject) => {
          reload((error?: Error | null) => (error ? reject(error) : resolve()));
        });
        const current = req.session.openidTokens;
        shouldClearExpressSession = Boolean(
          current &&
            current.accessToken === resolvedTokens?.access_token &&
            current.refreshToken === successorRefreshToken,
        );
      } catch {
        shouldClearExpressSession = true;
      }
    }
    if (shouldClearExpressSession && typeof req.session?.destroy === 'function') {
      try {
        const destroy = req.session.destroy.bind(req.session);
        await new Promise<void>((resolve, reject) => {
          destroy((error?: Error | null) => (error ? reject(error) : resolve()));
        });
      } catch (error) {
        logger.warn(
          '[OpenIDSessionRefresh] Failed to destroy Express session during publication rollback',
          toOpenIDLogArgument(error),
        );
      }
    } else if (shouldClearExpressSession && req.session?.openidTokens) {
      delete req.session.openidTokens;
      try {
        await persistSession(req);
      } catch (error) {
        logger.warn(
          '[OpenIDSessionRefresh] Failed to clear Express session during publication rollback',
          toOpenIDLogArgument(error),
        );
      }
    }
    if (effects.browserCookies) {
      for (const name of [
        'refreshToken',
        'openid_access_token',
        'openid_id_token',
        'openid_user_id',
        'token_provider',
      ]) {
        res?.clearCookie?.(name);
      }
    }
    if (effects.bridge) {
      try {
        await deleteRefreshTokenBridges({
          refreshTokens: [effects.bridge.predecessorRefreshToken],
          userId: effects.bridge.identity.userId,
          tenantId: effects.bridge.identity.tenantId,
          version: effects.bridge.version,
        });
      } catch (error) {
        logger.warn(
          '[OpenIDSessionRefresh] Failed to remove publication bridge during rollback',
          toOpenIDLogArgument(error),
        );
      }
    }
  }

  function hasPublicationEffects(effects: SessionPublicationEffects): boolean {
    return Boolean(
      effects.durableSession || effects.browserCookies || effects.expressSession || effects.bridge,
    );
  }

  function createSessionPublicationEffects(): SessionPublicationEffects {
    return {
      durableSession: false,
      browserCookies: false,
      expressSession: false,
    };
  }

  async function publishCompletedFlightTokens({
    key,
    req,
    res,
    user,
    identityContext,
    resolvedTokens,
    predecessorRefreshToken,
    tokenPreference,
    signal,
  }: {
    key: string;
    req: OpenIDRequest;
    res?: OpenIDResponse;
    user: OpenIDUser;
    identityContext?: AuthIdentityContext;
    resolvedTokens: MarkedOIDCTokens;
    predecessorRefreshToken?: string;
    tokenPreference: TokenPreference;
    signal?: AbortSignal;
  }): Promise<MarkedOIDCTokens> {
    signal?.throwIfAborted();
    if (resolvedTokens.__deferredPublication) {
      const predecessor =
        getPredecessorRefreshTokenMarker(resolvedTokens) ?? predecessorRefreshToken;
      const identity = createRefreshTokenBridgeIdentity({
        user,
        requestUser: req.user,
        userId: identityContext?.appUserId,
        tenantId: identityContext?.tenantId,
        openidIssuer: identityContext?.openidIssuer,
      });
      const publicationKey =
        predecessor && identity
          ? createRefreshTokenBridgeFlightKey?.({ ...identity, oldRefreshToken: predecessor })
          : null;
      const published = publicationKey
        ? await waitForOpenIDRefreshFlight({
            key: publicationKey,
            requirePublication: true,
            timeoutMs: PUBLICATION_WAIT_TIMEOUT_MS,
            intervalMs: PUBLICATION_WAIT_INTERVAL_MS,
            ...(signal ? { signal } : {}),
          })
        : null;
      signal?.throwIfAborted();
      if (!publicationKey || !published || published.__deferredPublication) {
        throw Object.assign(new Error('OpenID refresh publication is temporarily unavailable'), {
          status: 503,
          retryable: true,
        });
      }
      resolvedTokens = cloneResolvedTokens(published);
      key = publicationKey;
      if (published.tokenset) {
        Object.assign(resolvedTokens, published.tokenset);
      }
    }
    if (!resolvedTokens.__flightOwnerId) {
      throw new Error('OpenID refresh result is missing its publication generation');
    }
    const publicationGeneration = {
      key,
      ownerId: resolvedTokens.__flightOwnerId,
      createdAt: resolvedTokens.__flightCreatedAt,
    };
    const effects = createSessionPublicationEffects();
    try {
      const effectiveTokens = await publishResolvedSessionTokens({
        req,
        res,
        user,
        identityContext,
        resolvedTokens,
        predecessorRefreshToken,
        tokenPreference,
        assertLeaseOwned: async () => {
          signal?.throwIfAborted();
          const available = await assertOpenIDRefreshFlightAvailable(publicationGeneration);
          signal?.throwIfAborted();
          return available;
        },
        publicationGeneration,
        effects,
      });
      if (!effectiveTokens) {
        throw new Error('OpenID refresh result is unavailable for publication');
      }
      return effectiveTokens;
    } catch (error) {
      if (isOpenIDRefreshOwnershipError(error) && hasPublicationEffects(effects)) {
        await rollbackSessionPublication(
          req,
          res,
          resolvedTokens,
          effects,
          resolvedTokens.refresh_token ?? predecessorRefreshToken,
        );
      }
      throw error;
    }
  }

  async function performIdpRefresh(
    req: OpenIDRequest,
    res: OpenIDResponse | undefined,
    user: OpenIDUser,
    tokenPreference: TokenPreference,
    identityContext?: AuthIdentityContext,
    deferPublication = false,
    signal?: AbortSignal,
  ): Promise<MarkedOIDCTokens | null> {
    const refreshToken = req?.session?.openidTokens?.refreshToken;
    const predecessorAccessToken = req?.session?.openidTokens?.accessToken;
    const key = createOpenIDRefreshFlightKey({ req, user, refreshToken, identityContext });
    if (!key) {
      return performIdpRefreshGrant(
        req,
        res,
        user,
        tokenPreference,
        identityContext,
        undefined,
        deferPublication,
      );
    }

    let flight;
    try {
      flight = await acquireOpenIDRefreshFlight({ key });
    } catch (error) {
      logger.warn(
        '[OpenIDSessionRefresh] Failed to acquire shared refresh flight',
        toOpenIDLogArgument(error),
      );
      throw new Error('OpenID refresh coordination is temporarily unavailable', { cause: error });
    }

    if (!flight.acquired) {
      logger.debug('[OpenIDSessionRefresh] Joining shared refresh flight', {
        key: hashKeyForLogs(key),
      });
      const resolvedTokens = await waitForOpenIDRefreshFlight({
        key,
        ...(signal ? { signal } : {}),
      });
      signal?.throwIfAborted();
      if (resolvedTokens) {
        if (!deferPublication) {
          return publishCompletedFlightTokens({
            key,
            req,
            res,
            user,
            identityContext,
            resolvedTokens,
            predecessorRefreshToken: refreshToken,
            tokenPreference,
            signal,
          });
        }
        return resolvedTokens;
      }

      logger.warn('[OpenIDSessionRefresh] Shared refresh flight remained unresolved', {
        key: hashKeyForLogs(key),
      });
      throw new Error('OpenID refresh coordination is temporarily unavailable');
    }

    return withOpenIDRefreshFlightLease({
      key,
      ownerId: flight.ownerId,
      operation: async ({ assertLeaseOwned, markLeaseSettled }: LeaseContext) => {
        let recoveryBridgeVersion: string | null = null;
        let recoveryBridgeIdentity: RefreshTokenBridgeIdentity | null = null;
        let recoveryBridgePredecessor: string | undefined;
        let resolvedTokens: MarkedOIDCTokens | null = null;
        let successorRefreshToken: string | undefined;
        let completionIndeterminate = false;
        let grantStarted = false;
        const publicationEffects = createSessionPublicationEffects();
        try {
          /** Cancellation before admission must fail the acquired lease. Once a grant
           * starts, settle its rotating credentials durably even if its caller stops. */
          signal?.throwIfAborted();
          grantStarted = true;
          resolvedTokens = await performIdpRefreshGrant(
            req,
            res,
            user,
            tokenPreference,
            identityContext,
            assertLeaseOwned,
            true,
          );
          attachPredecessorRefreshTokenMarker(resolvedTokens, refreshToken);
          attachPredecessorAccessTokenMarker(resolvedTokens, predecessorAccessToken);
          attachDeferredPublicationMarker(resolvedTokens, deferPublication);
          const flightCreatedAt = flight.flight?.createdAt
            ? new Date(flight.flight.createdAt).getTime()
            : Date.now();
          attachFlightOwnerMarker(resolvedTokens, flight.ownerId, flightCreatedAt);
          successorRefreshToken = resolvedTokens?.refresh_token ?? refreshToken;
          const browserRefreshToken = resolvedTokens
            ? (getBrowserRefreshTokenMarker(resolvedTokens) ?? refreshToken)
            : refreshToken;
          if (
            !deferPublication &&
            successorRefreshToken &&
            browserRefreshToken &&
            successorRefreshToken !== browserRefreshToken
          ) {
            recoveryBridgeIdentity = createRefreshTokenBridgeIdentity({
              user,
              requestUser: req.user,
              userId: identityContext?.appUserId,
              tenantId: identityContext?.tenantId,
              openidIssuer: identityContext?.openidIssuer,
            });
            recoveryBridgePredecessor = browserRefreshToken;
            if (recoveryBridgeIdentity) {
              recoveryBridgeVersion = await storeRefreshTokenBridgeWithLease({
                oldRefreshToken: browserRefreshToken,
                newRefreshToken: successorRefreshToken,
                userId: recoveryBridgeIdentity.userId,
                tenantId: recoveryBridgeIdentity.tenantId,
                openidIssuer: recoveryBridgeIdentity.openidIssuer,
                ttl: OPENID_REFRESH_BRIDGE_GRACE_MS,
                assertLeaseOwned,
              });
            }
          }
          if (!deferPublication) {
            await publishResolvedSessionTokens({
              req,
              res,
              user,
              identityContext,
              resolvedTokens,
              predecessorRefreshToken: refreshToken,
              tokenPreference,
              assertLeaseOwned,
              publicationGeneration: { key, ownerId: flight.ownerId, createdAt: flightCreatedAt },
              effects: publicationEffects,
            });
          }
          let completedFlight: RefreshFlightRecord | null = null;
          try {
            completedFlight = await completeOpenIDRefreshFlight({
              key,
              ownerId: flight.ownerId,
              tokens: resolvedTokens,
            });
          } catch (completionError) {
            completionIndeterminate = true;
            try {
              const observed = await assertOpenIDRefreshFlightAvailable({
                key,
                ownerId: flight.ownerId,
              });
              if (typeof observed === 'object') {
                completedFlight = observed;
                completionIndeterminate = false;
              }
            } catch {
              /** Keep the pending generation recoverable when completion cannot be observed. */
            }
            if (!completedFlight) {
              throw completionError;
            }
          }
          if (!completedFlight) {
            throw createOpenIDRefreshOwnershipError(
              'OpenID refresh coordination ownership was lost before completion',
            );
          }
          attachFlightOwnerMarker(resolvedTokens, completedFlight.ownerId ?? flight.ownerId);
          markLeaseSettled();
          return resolvedTokens;
        } catch (error) {
          if (isOpenIDRefreshOwnershipError(error) && hasPublicationEffects(publicationEffects)) {
            await rollbackSessionPublication(
              req,
              res,
              resolvedTokens,
              publicationEffects,
              successorRefreshToken,
            );
          }
          if (
            isOpenIDRefreshOwnershipError(error) &&
            recoveryBridgeVersion &&
            recoveryBridgeIdentity &&
            recoveryBridgePredecessor &&
            !publicationEffects.bridge
          ) {
            try {
              await deleteRefreshTokenBridges({
                refreshTokens: [recoveryBridgePredecessor],
                userId: recoveryBridgeIdentity.userId,
                tenantId: recoveryBridgeIdentity.tenantId,
                version: recoveryBridgeVersion,
              });
            } catch (cleanupError) {
              logger.warn(
                '[OpenIDSessionRefresh] Failed to remove the owned bridge after refresh revocation',
                toOpenIDLogArgument(cleanupError),
              );
            }
          }
          if (!completionIndeterminate) {
            try {
              let failure =
                error instanceof Error ? error : new Error('OpenID session refresh failed');
              if (!grantStarted && signal?.aborted) {
                failure = new Error(OPENID_REFRESH_CANCELLED_BEFORE_GRANT);
              }
              await failOpenIDRefreshFlight({
                key,
                ownerId: flight.ownerId,
                error: failure,
              });
            } catch (flightError) {
              logger.warn('[OpenIDSessionRefresh] Failed to mark shared refresh flight failed', {
                key: hashKeyForLogs(key),
                error: (flightError as Error)?.message,
              });
            }
          } else {
            logger.warn(
              '[OpenIDSessionRefresh] Keeping an indeterminate publication generation recoverable',
              { key: hashKeyForLogs(key) },
            );
          }
          throw error;
        }
      },
    });
  }

  /**
   * Hydrates `req.session.openidTokens` from a resolved OIDCTokens result and
   * persists it. Used by joining requests in the single-flight path: the leader
   * mutates only its own `req.session`, so a joiner carrying a distinct `req`
   * (including a renewed Express session) would otherwise re-read
   * stale tokens on its next OBO call. This includes stable-refresh-token IdPs,
   * where the refresh token remains unchanged but the access token and expiry
   * were refreshed by the leader.
   * Idempotent when the joiner shares the leader's `req` object.
   */
  async function hydrateSessionFromResolvedTokens(
    req: OpenIDRequest,
    resolvedTokens: MarkedOIDCTokens | null,
    predecessorOverride?: string,
    reloadSession = true,
    publicationGeneration?: OpenIDPublicationGeneration,
  ): Promise<boolean> {
    if (!req?.session || !resolvedTokens?.access_token) {
      return false;
    }
    if (reloadSession) {
      await reloadOpenIDSessionIfPersisted(req.session);
    }
    const existing = req.session.openidTokens ?? {};
    const generationDiffers = Boolean(
      publicationGeneration &&
        existing.publicationFlightKey &&
        (existing.publicationFlightKey !== publicationGeneration.key ||
          existing.publicationFlightOwnerId !== publicationGeneration.ownerId),
    );
    const existingGenerationIsNewer = Boolean(
      generationDiffers &&
        existing.publicationFlightCreatedAt != null &&
        (publicationGeneration?.createdAt == null ||
          existing.publicationFlightCreatedAt >= publicationGeneration.createdAt),
    );
    if (existingGenerationIsNewer) {
      logger.info(
        '[OpenIDSessionRefresh] Skipping stale flight hydration because its generation is older',
      );
      return false;
    }
    if (hasSessionAdvancedPastResult(existing, resolvedTokens, predecessorOverride)) {
      logger.info(
        '[OpenIDSessionRefresh] Skipping stale flight hydration because the session advanced',
      );
      return false;
    }
    const accessTokenChanged = existing.accessToken !== resolvedTokens.access_token;
    const idTokenChanged =
      resolvedTokens.id_token != null && existing.idToken !== resolvedTokens.id_token;
    const refreshTokenChanged =
      resolvedTokens.refresh_token != null &&
      existing.refreshToken !== resolvedTokens.refresh_token;
    const resolvedBrowserRefreshToken = getBrowserRefreshTokenMarker(resolvedTokens);
    const browserRefreshTokenChanged =
      resolvedBrowserRefreshToken != null &&
      existing.browserRefreshToken !== resolvedBrowserRefreshToken;
    const hasResolvedExpiry = typeof resolvedTokens.expires_at === 'number';
    const expiresAtChanged = hasResolvedExpiry
      ? existing.accessTokenExpiresAt !== resolvedTokens.expires_at
      : accessTokenChanged && existing.accessTokenExpiresAt !== undefined;
    const publicationGenerationChanged = publicationGeneration
      ? existing.publicationFlightKey !== publicationGeneration.key ||
        existing.publicationFlightOwnerId !== publicationGeneration.ownerId
      : false;

    if (
      !accessTokenChanged &&
      !idTokenChanged &&
      !refreshTokenChanged &&
      !browserRefreshTokenChanged &&
      !expiresAtChanged &&
      !publicationGenerationChanged
    ) {
      return false;
    }

    const nextSessionTokens = {
      ...existing,
      accessToken: resolvedTokens.access_token,
      idToken: resolvedTokens.id_token ?? existing.idToken,
      refreshToken: resolvedTokens.refresh_token ?? existing.refreshToken,
      browserRefreshToken: resolvedBrowserRefreshToken ?? existing.browserRefreshToken,
      lastRefreshedAt: Date.now(),
      ...(publicationGeneration
        ? {
            publicationFlightKey: publicationGeneration.key,
            publicationFlightOwnerId: publicationGeneration.ownerId,
            publicationFlightCreatedAt: publicationGeneration.createdAt,
          }
        : {}),
    };
    if (hasResolvedExpiry) {
      nextSessionTokens.accessTokenExpiresAt = resolvedTokens.expires_at;
    } else if (accessTokenChanged) {
      delete nextSessionTokens.accessTokenExpiresAt;
    }
    req.session.openidTokens = nextSessionTokens;
    await persistSession(req);
    return true;
  }

  async function refreshOrReuseSession(
    req: OpenIDRequest,
    res: OpenIDResponse | undefined,
    user: OpenIDUser,
    tokenPreference: TokenPreference,
    identityContext?: AuthIdentityContext,
    forceRefresh = false,
    deferPublication = false,
    signal?: AbortSignal,
  ): Promise<MarkedOIDCTokens | null> {
    const sessionTokens = req?.session?.openidTokens;
    if (!sessionTokens) {
      logger.debug('[OpenIDSessionRefresh] No session tokens to refresh from');
      return null;
    }

    if (!forceRefresh && isLiveSessionTokenStillValid(sessionTokens, tokenPreference)) {
      await assertOpenIDRefreshSessionGenerationAvailable({
        key: sessionTokens.publicationFlightKey,
        ownerId: sessionTokens.publicationFlightOwnerId,
      });
      logger.debug('[OpenIDSessionRefresh] Live session token reused');
      return buildOIDCTokensFromSession(sessionTokens, tokenPreference);
    }

    signal?.throwIfAborted();
    return performIdpRefresh(
      req,
      res,
      user,
      tokenPreference,
      identityContext,
      deferPublication,
      signal,
    );
  }

  /**
   * Single-flighted entry point. Concurrent callers for the same user share one
   * in-flight refresh. The map is cleared in finally so a failed refresh does
   * not pin subsequent retries.
   *
   * @param {import('express').Request} req
   * @param {import('express').Response} [res] — when present and writable, the
   *   rotated refresh token is mirrored to the `refreshToken` cookie.
   * @param {import('@librechat/data-schemas').IUser} user
   * @param {'access_token' | 'id_token'} tokenPreference — required; selects
   *   which token's `exp` gates the live-vs-refresh decision and populates the
   *   returned `expires_at`. OBO callers pass 'access_token'.
   */
  async function refreshOpenIDSession(
    req: OpenIDRequest,
    res: OpenIDResponse | undefined,
    user: OpenIDUser,
    tokenPreference: TokenPreference,
    identityContext?: AuthIdentityContext,
    options: RefreshSessionOptions = {},
  ): Promise<MarkedOIDCTokens | null> {
    options.signal?.throwIfAborted();
    const identityBinding = assertOpenIDSessionIdentityMatch(req, user, identityContext);
    if (identityBinding) {
      await identityBinding;
    }
    options.signal?.throwIfAborted();
    if (options.assertLeaseOwned) {
      return performIdpRefreshGrant(
        req,
        res,
        user,
        tokenPreference,
        identityContext,
        options.assertLeaseOwned,
        options.deferPublication,
      );
    }
    const key = getSingleFlightKey(req, user, identityContext);
    if (!key) {
      return refreshOrReuseSession(
        req,
        res,
        user,
        tokenPreference,
        identityContext,
        options.forceRefresh,
        options.deferPublication,
        options.signal,
      );
    }

    const forcedKey = `${key}:forced`;
    /** A rejection-driven refresh must not join a normal flight that may merely reuse
     * the rejected-but-unexpired token. Join and publish that flight first, then force
     * a distinct refresh so rotating refresh-token state remains serialized. */
    const normalFlight = inFlightRefreshes.get(key);
    if (options.forceRefresh && normalFlight) {
      await refreshOpenIDSession(req, res, user, tokenPreference, identityContext, {
        ...options,
        forceRefresh: false,
      });
      /** The normal flight is resolved at this point. Remove it defensively before
       * the forced pass so promise-cleanup scheduling cannot make us rejoin it. */
      if (inFlightRefreshes.get(key) === normalFlight) {
        inFlightRefreshes.delete(key);
      }
      return refreshOpenIDSession(req, res, user, tokenPreference, identityContext, options);
    }

    /** Normal callers may safely join a forced flight and receive its fresher result. */
    const inFlightKey = !options.forceRefresh && inFlightRefreshes.has(forcedKey) ? forcedKey : key;
    const ownedFlightKey = options.forceRefresh ? forcedKey : inFlightKey;
    const inFlight = inFlightRefreshes.get(ownedFlightKey);
    if (inFlight) {
      const predecessorRefreshToken = req?.session?.openidTokens?.refreshToken;
      const sharedFlightKey = createOpenIDRefreshFlightKey({
        req,
        user,
        refreshToken: predecessorRefreshToken,
        identityContext,
      });
      logger.debug(
        `[OpenIDSessionRefresh] Joining in-flight refresh (key=${hashKeyForLogs(ownedFlightKey)})`,
      );
      let resolvedTokens: MarkedOIDCTokens | null;
      try {
        resolvedTokens = await inFlight;
      } catch (error) {
        options.signal?.throwIfAborted();
        const leaderSignal = flightSignals.get(inFlight);
        if (!leaderSignal?.aborted || error !== leaderSignal.reason) {
          throw error;
        }
        /** A cancelled follower publication must not strand active local joiners.
         * Rejoin durable coordination; never replay an already-settled IdP grant. */
        if (inFlightRefreshes.get(ownedFlightKey) === inFlight) {
          inFlightRefreshes.delete(ownedFlightKey);
        }
        return refreshOpenIDSession(req, res, user, tokenPreference, identityContext, options);
      }
      options.signal?.throwIfAborted();
      /**
       * The leader mutated only its own request's session. Copy the resolved
       * tokens into THIS request's session so a later OBO call on the joiner
       * reads the rotated refresh token instead of replaying the stale one.
       */
      if (!options.deferPublication) {
        if (resolvedTokens?.__deferredPublication) {
          if (!sharedFlightKey) {
            throw new Error('OpenID refresh coordination key is unavailable for publication');
          }
          return publishCompletedFlightTokens({
            key: sharedFlightKey,
            req,
            res,
            user,
            identityContext,
            resolvedTokens,
            predecessorRefreshToken,
            tokenPreference,
            signal: options.signal,
          });
        }
        const currentSessionTokens = req.session?.openidTokens;
        const alreadyCurrent = Boolean(
          currentSessionTokens?.accessToken === resolvedTokens?.access_token &&
            currentSessionTokens?.refreshToken ===
              (resolvedTokens?.refresh_token ?? predecessorRefreshToken),
        );
        if (alreadyCurrent) {
          if (resolvedTokens?.__flightOwnerId) {
            if (!sharedFlightKey) {
              throw new Error('OpenID refresh coordination key is unavailable for publication');
            }
            await assertOpenIDRefreshFlightAvailable({
              key: sharedFlightKey,
              ownerId: resolvedTokens.__flightOwnerId,
            });
          }
          return resolvedTokens;
        }
        if (!sharedFlightKey || !resolvedTokens) {
          throw new Error('OpenID refresh coordination key is unavailable for publication');
        }
        return publishCompletedFlightTokens({
          key: sharedFlightKey,
          req,
          res,
          user,
          identityContext,
          resolvedTokens,
          predecessorRefreshToken,
          tokenPreference,
          signal: options.signal,
        });
      }
      return resolvedTokens;
    }

    const promise = refreshOrReuseSession(
      req,
      res,
      user,
      tokenPreference,
      identityContext,
      options.forceRefresh,
      options.deferPublication,
      options.signal,
    ).finally(() => {
      if (inFlightRefreshes.get(ownedFlightKey) === promise) {
        inFlightRefreshes.delete(ownedFlightKey);
      }
    });
    inFlightRefreshes.set(ownedFlightKey, promise);
    if (options.signal) {
      flightSignals.set(promise, options.signal);
    }
    /** Swallow rejection on the cleanup chain; the original is delivered to the awaiter. */
    promise.catch(() => {});
    return promise;
  }

  /**
   * Returns true when this user is in scope for OIDC session refresh. Non-OIDC
   * users and deployments without `OPENID_REUSE_TOKENS` never had a populated
   * `req.session.openidTokens` to begin with. Bearer-authenticated remote-agent requests may use
   * their current verified bearer; browser requests whose session capability disappeared reject.
   */
  function isOIDCRefreshApplicable(user?: OpenIDUser): user is OpenIDUser {
    if (!isEnabled(process.env.OPENID_REUSE_TOKENS)) {
      return false;
    }
    if (!user) {
      return false;
    }
    return user.provider === 'openid' || Boolean(user.openidId);
  }

  /**
   * Builds the UpstreamTokenProvider closure forwarded into the MCP layer.
   * The closure closes over `req` so it reads `req.session.openidTokens` at OBO
   * call time (not at request validation), which is what makes the walk-away
   * failure mode recover without a user-visible re-authentication.
   *
   * `tokenPreference` is required and identifies which upstream token's freshness
   * gates the closure. OBO needs 'access_token' because the OBO exchange uses
   * the access token as the jwt-bearer assertion; using id_token preference here
   * would let an expired access token reach the IdP under a still-fresh id_token.
   *
   * Closure contract (matches `UpstreamTokenProvider` in obo.ts):
   *   - resolves to non-null OIDCTokens when fresh tokens are available.
   *   - resolves to null when refresh is not applicable or the request itself carries the
   *     verified upstream bearer (the remote-agent flow).
   *   - rejects when an Express session existed but its OpenID capability was cleared, so a
   *     strategy-time `user.federatedTokens` snapshot cannot bypass logout.
   *   - rejects when session identity metadata does not match the current user.
   *   - rejects when refresh was attempted and rejected by the IdP. The MCP
   *     layer wraps the rejection as `session_refresh_failed`.
   *
   * @param {object} args
   * @param {import('express').Request} [args.req]
   * @param {import('express').Response} [args.res] — forwarded so a rotated
   *   refresh token can be mirrored to the `refreshToken` cookie when the
   *   response is still writable (no-op on the streaming tool-call path).
   * @param {import('@librechat/data-schemas').IUser} [args.user]
   * @param {import('@librechat/api').AuthIdentityContext} [args.identityContext]
   * @param {'access_token' | 'id_token'} args.tokenPreference
   * @returns {(options?: { forceRefresh?: boolean, signal?: AbortSignal }) => Promise<import('@librechat/data-schemas').OIDCTokens | null>}
   */
  function createOpenIDSessionTokenProvider({
    req,
    res,
    user,
    tokenPreference,
    identityContext,
  }: CreateOpenIDSessionTokenProviderInput): (options?: {
    forceRefresh?: boolean;
    signal?: AbortSignal;
  }) => Promise<OIDCTokens | null> {
    if (tokenPreference !== 'access_token' && tokenPreference !== 'id_token') {
      throw new Error(
        `[OpenIDSessionRefresh] createOpenIDSessionTokenProvider requires tokenPreference 'access_token' or 'id_token', got: ${tokenPreference}`,
      );
    }
    return async function upstreamTokenProvider(options = {}) {
      options.signal?.throwIfAborted();
      if (!isOIDCRefreshApplicable(user)) {
        return null;
      }
      if (!req?.session?.openidTokens) {
        const authorization = req?.headers?.authorization;
        const bearerToken = authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
        const carriesCurrentUpstreamBearer = Boolean(
          bearerToken && bearerToken === user?.federatedTokens?.access_token,
        );
        if (req?.session && !carriesCurrentUpstreamBearer) {
          throw createOpenIDRefreshOwnershipError('OpenID session tokens are no longer available');
        }
        logger.debug(
          '[OpenIDSessionRefresh] No session.openidTokens available on req; closure returning null',
        );
        return null;
      }
      const resolvedIdentityContext =
        identityContext ??
        createAuthIdentityContext({
          user,
          requestUser: req?.user,
        });
      return refreshOpenIDSession(req, res, user, tokenPreference, resolvedIdentityContext, {
        forceRefresh: options.forceRefresh,
        signal: options.signal,
      });
    };
  }

  return {
    createOpenIDSessionTokenProvider,
    refreshOpenIDSession,
    /** Exposed for tests; not a public API. */
    __internals: {
      UPSTREAM_TOKEN_EXPIRY_BUFFER_SECONDS,
      inFlightRefreshes,
      getSingleFlightKey,
      isLiveSessionTokenStillValid,
      getAccessTokenExp,
    },
  };
}
