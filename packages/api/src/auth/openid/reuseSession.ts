import { AUTH_SESSION_CHECK_UNAVAILABLE, OPENID_SESSION_ENDED } from 'librechat-data-provider';
import type { ProviderSessionRef } from 'librechat-data-provider';
import type { ResolvedBackchannelLogoutConfig } from './providerSession';
import type { ProviderSessionAuthorizer } from './providerSession';
import type { OpenIDReuseCredential } from './reuseCredential';
import type { OpenIDLogger } from './types';
import {
  isProviderSessionUnavailableError,
  isSameProviderSessionRef,
  providerSessionCredentialExpiry,
} from './providerSession';
import { getReuseCredentialForMode, getValidOpenIDReuseCredential } from './reuseCredential';
import { createOpenIDSessionEndedError, isOpenIDSessionEndedError } from './errors';
import { getSafeErrorMetadata } from '~/utils/errors';

export type MergeReuseProviderSessionResult =
  | { ok: true; ref: ProviderSessionRef | null }
  | { ok: false; code: 'CONFLICT' };

/** The marker's ref must agree with `sessionRef` when both are present (conflict otherwise);
 *  falls back to `sessionRef`, then `sessionDocRef`. */
export function mergeReuseProviderSession(
  markerRef: ProviderSessionRef | null,
  sessionRef: ProviderSessionRef | null,
  sessionDocRef: ProviderSessionRef | null = null,
): MergeReuseProviderSessionResult {
  if (markerRef && sessionRef && !isSameProviderSessionRef(markerRef, sessionRef)) {
    return { ok: false, code: 'CONFLICT' };
  }
  return { ok: true, ref: markerRef ?? sessionRef ?? sessionDocRef };
}

/** Same precedence as `mergeReuseProviderSession`, for a caller that just needs the resolved ref
 *  or a denial; mode `'off'` short-circuits to `null` before any conflict check. */
export function resolveBoundProviderSession(
  mode: ResolvedBackchannelLogoutConfig['mode'],
  markerRef: ProviderSessionRef | null,
  sessionRef: ProviderSessionRef | null,
  sessionDocRef: ProviderSessionRef | null = null,
): ProviderSessionRef | null {
  if (mode === 'off') {
    return null;
  }
  const merged = mergeReuseProviderSession(markerRef, sessionRef, sessionDocRef);
  if (!merged.ok) {
    throw createOpenIDSessionEndedError();
  }
  return merged.ref;
}

/** Resolves the provider session bound to a refresh token's reuse-identity marker, honoring the
 *  session's existing association; mode `'off'` short-circuits to `null` before either is read. */
export function resolveBoundProviderSessionForToken(
  mode: ResolvedBackchannelLogoutConfig['mode'],
  parsedCookies: { openid_user_id?: string },
  jwtRefreshSecret: string | undefined,
  refreshToken: string | undefined,
  sessionProviderSession: ProviderSessionRef | null,
): ProviderSessionRef | null {
  const markerRef =
    getValidOpenIDReuseCredential(parsedCookies, jwtRefreshSecret, refreshToken)?.providerSession ??
    null;
  return resolveBoundProviderSession(mode, markerRef, sessionProviderSession);
}

export interface AuthorizeCachedReuseSessionDeps {
  authorizer: ProviderSessionAuthorizer;
  /** Removes the reuse-mode Session doc keyed by this refresh token's hash. */
  deleteOpenIDSession: (refreshToken: string) => Promise<unknown>;
  logger: Pick<OpenIDLogger, 'warn'>;
  providerSessionExpiryMs: number;
}

export interface AuthorizeCachedReuseSessionInput {
  markerProviderSession: ProviderSessionRef | null;
  sessionProviderSession: ProviderSessionRef | null;
  sessionDocProviderSession?: ProviderSessionRef | null;
  openidSubject?: string;
  /** The refresh token this cached response is bound to; also the reuse-mode Session doc key. */
  refreshToken: string;
  session?: { openidTokens?: { providerSession?: ProviderSessionRef } } | null;
}

/** Final authorization for a cached (session-token-reuse) response, run right before it is sent.
 *  Mode `'off'` returns before the conflict check. Throws `OPENID_SESSION_ENDED` on denial. */
export async function authorizeCachedReuseSession(
  deps: AuthorizeCachedReuseSessionDeps,
  input: AuthorizeCachedReuseSessionInput,
): Promise<void> {
  if ((await deps.authorizer.getMode()) === 'off') {
    return;
  }

  const merged = mergeReuseProviderSession(
    input.markerProviderSession,
    input.sessionProviderSession,
    input.sessionDocProviderSession ?? null,
  );
  if (!merged.ok) {
    await cleanupDeniedCachedReuseSession(deps, input, null);
    throw createOpenIDSessionEndedError();
  }

  const ref = merged.ref;
  const outcome = await deps.authorizer.authorize({
    ref,
    subject: input.openidSubject,
    expiresAt: providerSessionCredentialExpiry(new Date(), deps.providerSessionExpiryMs),
    legacy: ref == null,
  });
  if (!outcome.ok) {
    await cleanupDeniedCachedReuseSession(deps, input, ref);
    throw createOpenIDSessionEndedError();
  }
}

async function cleanupDeniedCachedReuseSession(
  deps: Pick<AuthorizeCachedReuseSessionDeps, 'deleteOpenIDSession' | 'logger'>,
  input: AuthorizeCachedReuseSessionInput,
  deniedRef: ProviderSessionRef | null,
): Promise<void> {
  try {
    await deps.deleteOpenIDSession(input.refreshToken);
  } catch (error) {
    deps.logger.warn('[refreshController] Failed to remove the denied cached session', {
      error: error instanceof Error ? error.message : error,
    });
  }
  const sessionRef = input.session?.openidTokens?.providerSession ?? null;
  if (
    input.session?.openidTokens &&
    deniedRef &&
    sessionRef &&
    isSameProviderSessionRef(sessionRef, deniedRef)
  ) {
    delete input.session.openidTokens;
  }
}

export interface OpenIDRefreshProviderSessionDeps {
  authorizer: ProviderSessionAuthorizer;
  parsedCookies: { openid_user_id?: string };
  jwtRefreshSecret: string | undefined;
  /** Removes the reuse-mode Session doc keyed by a denied refresh token's hash. */
  deleteOpenIDSession: (refreshToken: string) => Promise<unknown>;
  logger: Pick<OpenIDLogger, 'warn'>;
  providerSessionExpiryMs: number;
}

export interface OpenIDRefreshProviderSessionContext {
  mode: ResolvedBackchannelLogoutConfig['mode'];
  /** Null when `hasReusableSessionToken` was false, or when the cookie does not verify. */
  reuseCredential: OpenIDReuseCredential | null;
  /** Final authorization for a cached (session-token-reuse) response, pre-bound to
   *  `reuseCredential`'s provider session; run once the cached user and identity checks pass,
   *  right before the response is sent. Throws `OPENID_SESSION_ENDED` on denial. */
  authorizeReuse: (
    sessionProviderSession: ProviderSessionRef | null,
    session?: AuthorizeCachedReuseSessionInput['session'],
  ) => Promise<void>;
}

/** Resolves the OpenID refresh path's provider-session mode and reuse-credential binding for a
 *  refresh request, and returns the final authorization step for a cached reuse response. The
 *  caller still performs the user/identity lookups the reuse path needs before calling
 *  `authorizeReuse`, and still translates a thrown failure with `respondToProviderSessionError`. */
export async function resolveOpenIDRefreshProviderSession(
  deps: OpenIDRefreshProviderSessionDeps,
  refreshToken: string,
  hasReusableSessionToken: boolean,
): Promise<OpenIDRefreshProviderSessionContext> {
  const mode = await deps.authorizer.getMode();
  const reuseCredential = hasReusableSessionToken
    ? getReuseCredentialForMode(mode, deps.parsedCookies, deps.jwtRefreshSecret, refreshToken)
    : null;

  const authorizeReuse = (
    sessionProviderSession: ProviderSessionRef | null,
    session?: AuthorizeCachedReuseSessionInput['session'],
  ) =>
    authorizeCachedReuseSession(
      {
        authorizer: deps.authorizer,
        deleteOpenIDSession: deps.deleteOpenIDSession,
        logger: deps.logger,
        providerSessionExpiryMs: deps.providerSessionExpiryMs,
      },
      {
        markerProviderSession: reuseCredential?.providerSession ?? null,
        sessionProviderSession,
        refreshToken,
        session,
      },
    );

  return { mode, reuseCredential, authorizeReuse };
}

/** No cookie clearing here: the denial path already cleaned up; an unavailable check has nothing
 *  to clear. Returns `undefined` when `error` is neither, so the caller's own handling continues. */
export function respondToProviderSessionError(
  res: { status: (code: number) => { send: (body: unknown) => unknown } },
  error: unknown,
  logger: Pick<OpenIDLogger, 'warn' | 'error'>,
  context: string,
): unknown {
  if (isOpenIDSessionEndedError(error)) {
    logger.warn(`[${context}] OpenID provider session denied; sign-in required`);
    return res.status(401).send({ code: OPENID_SESSION_ENDED });
  }
  if (isProviderSessionUnavailableError(error)) {
    logger.error(`[${context}] Provider session check unavailable`, getSafeErrorMetadata(error));
    return res.status(503).send({ code: AUTH_SESSION_CHECK_UNAVAILABLE });
  }
  return undefined;
}
