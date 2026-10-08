import crypto from 'crypto';
import { logger } from '@librechat/data-schemas';
import { DEFAULT_OAUTH_STATE_TTL_MS } from 'librechat-data-provider';
import type { CookieOptions, Request } from 'express';

export const OAUTH_STATE_COOKIE_PREFIX = 'oauth_state_';

/** Browsers refuse a `__Host-` cookie that names a Domain, so a sibling subdomain cannot plant one. */
const HOST_ONLY_COOKIE_PREFIX = '__Host-';
/** Separates this HMAC from other values signed with the same secret. */
const SIGNATURE_CONTEXT = 'librechat:oauth-login-state';
const BINDING_PATTERN = /^[A-Za-z0-9_-]{43}$/;
/** Each binding cookie is `<prefix>.<id>`, so bindings created by concurrent first starts coexist. */
const BINDING_ID_BYTES = 6;
/** `<issued-at, base 36>.<nonce>.<signature>` */
const STATE_PATTERN = /^([0-9a-z]{1,11})\.([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{43})$/;
const MISSING_BINDING_MESSAGE = 'Unable to verify authorization request state.';
const INVALID_STATE_MESSAGE = 'Invalid authorization request state.';
const EXPIRED_STATE_MESSAGE = 'Authorization request state expired.';

export interface OAuthStateStoreOptions {
  /** Strategy name; names the cookie, scopes the signature and labels rejections in logs. */
  provider: string;
  /** Signs each state; every replica must share it. */
  secret: string;
  /** Whether the deployment serves `Secure` cookies; secure deployments get a `__Host-` cookie. */
  secureCookie: boolean;
  /** How long a started login may take to reach its callback. */
  maxAgeMs?: number;
  /**
   * The provider returns with a cross-site form POST (Apple's `form_post`), which a
   * `SameSite=Lax` cookie does not accompany.
   */
  crossSiteCallback?: boolean;
}

type StoreCallback = (err: Error | null, state?: string) => void;
type VerifyCallback = (err: Error | null, ok: boolean, info?: { message: string }) => void;

/**
 * State store for `passport-oauth2`, which dispatches on each method's arity:
 * `store(req, callback)` and `verify(req, providedState, callback)`.
 */
export interface OAuthStateStore {
  store(req: Request, callback: StoreCallback): void;
  verify(req: Request, providedState: unknown, callback: VerifyCallback): void;
}

/** A passport strategy whose `authorizationParams` may fill in a `state` of its own. */
export interface PresetStateStrategy {
  authorizationParams(options: object): { state?: string };
}

const randomToken = (bytes: number): string => crypto.randomBytes(bytes).toString('base64url');

function signaturesMatch(expected: string, provided: string): boolean {
  const expectedBuffer = Buffer.from(expected);
  const providedBuffer = Buffer.from(provided);
  if (expectedBuffer.length !== providedBuffer.length) {
    return false;
  }
  return crypto.timingSafeEqual(expectedBuffer, providedBuffer);
}

/**
 * Binds an OAuth login to the browser that started it. The browser holds a random binding in an
 * HttpOnly cookie, reused by every flow it starts, and each `state` is an HMAC over that binding
 * and the time the flow started. The callback proceeds only when the returned `state` was signed
 * for one of this browser's bindings and is younger than `maxAgeMs`, so a callback reaching a
 * browser that did not start the flow ends before its code is exchanged. Nothing is stored per
 * flow, so logins started in separate tabs complete independently. A browser without a binding
 * gets one under a fresh cookie name, so first starts racing in two tabs each keep their own.
 */
export function createOAuthStateStore({
  provider,
  secret,
  secureCookie,
  maxAgeMs = DEFAULT_OAUTH_STATE_TTL_MS,
  crossSiteCallback = false,
}: OAuthStateStoreOptions): OAuthStateStore {
  if (!secret) {
    throw new Error(`A secret is required to sign ${provider} OAuth state`);
  }

  const secure = crossSiteCallback || secureCookie;
  const cookiePrefix = `${secure ? HOST_ONLY_COOKIE_PREFIX : ''}${OAUTH_STATE_COOKIE_PREFIX}${provider}.`;
  const cookieOptions: CookieOptions = {
    httpOnly: true,
    path: '/',
    sameSite: crossSiteCallback ? 'none' : 'lax',
    secure,
    maxAge: maxAgeMs,
  };

  const readBindings = (req: Request): Array<[name: string, binding: string]> =>
    Object.entries((req.cookies as Record<string, string> | undefined) ?? {}).filter(
      ([name, value]) => name.startsWith(cookiePrefix) && BINDING_PATTERN.test(value),
    );

  const sign = (binding: string, issuedAt: string, nonce: string): string =>
    crypto
      .createHmac('sha256', secret)
      .update(`${SIGNATURE_CONTEXT}:${provider}:${binding}:${issuedAt}:${nonce}`)
      .digest('base64url');

  const reject = (callback: VerifyCallback, message: string, hasState: boolean): void => {
    logger.warn(`[OAuth] Rejected ${provider} callback: ${message}`, {
      provider,
      has_state: hasState,
    });
    callback(null, false, { message });
  };

  return {
    store(req, callback) {
      if (!req.res) {
        callback(new Error('OAuth state store requires an Express response'));
        return;
      }
      const [name, binding] = readBindings(req)[0] ?? [
        `${cookiePrefix}${randomToken(BINDING_ID_BYTES)}`,
        randomToken(32),
      ];
      /** Re-issuing the same binding keeps it alive past the newest state it signs. */
      req.res.cookie(name, binding, cookieOptions);
      const issuedAt = Date.now().toString(36);
      const nonce = randomToken(16);
      callback(null, `${issuedAt}.${nonce}.${sign(binding, issuedAt, nonce)}`);
    },

    verify(req, providedState, callback) {
      const hasState = typeof providedState === 'string' && providedState.length > 0;
      const bindings = readBindings(req);
      if (bindings.length === 0) {
        reject(callback, MISSING_BINDING_MESSAGE, hasState);
        return;
      }

      const parsed = hasState ? STATE_PATTERN.exec(providedState) : null;
      if (!parsed) {
        reject(callback, INVALID_STATE_MESSAGE, hasState);
        return;
      }

      const [, issuedAt, nonce, signature] = parsed;
      const signed = bindings.some(([, binding]) =>
        signaturesMatch(sign(binding, issuedAt, nonce), signature),
      );
      if (!signed) {
        reject(callback, INVALID_STATE_MESSAGE, hasState);
        return;
      }
      if (Date.now() - parseInt(issuedAt, 36) >= maxAgeMs) {
        reject(callback, EXPIRED_STATE_MESSAGE, hasState);
        return;
      }
      callback(null, true);
    },
  };
}

/**
 * Leaves `state` to the configured store for strategies that fill in their own. passport-apple
 * assigns one inside `authorizationParams` (on the route's shared options, so it never changes
 * after the first request), and a preset `state` bypasses the store entirely.
 */
export function deferStateToStore(strategy: PresetStateStrategy): void {
  const authorizationParams = strategy.authorizationParams.bind(strategy);
  strategy.authorizationParams = (options) => {
    const { state: _state, ...params } = authorizationParams({ ...options });
    return params;
  };
}
