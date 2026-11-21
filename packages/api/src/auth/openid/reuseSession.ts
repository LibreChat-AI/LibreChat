import { AUTH_SESSION_CHECK_UNAVAILABLE, OPENID_SESSION_ENDED } from 'librechat-data-provider';
import type { ProviderSessionRef } from 'librechat-data-provider';
import type {
  ProviderSessionAuthorizer,
  ProviderSessionBinding,
  ResolvedBackchannelLogoutConfig,
} from './providerSession';
import type { OpenIDReuseCredential } from './reuseCredential';
import type { OpenIDLogger } from './types';
import {
  ProviderSessionUnavailableError,
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
 *  or a denial; mode `'off'` carries whichever ref is already bound forward, without the conflict
 *  check, instead of discarding it. */
export function resolveBoundProviderSession(
  mode: ResolvedBackchannelLogoutConfig['mode'],
  markerRef: ProviderSessionRef | null,
  sessionRef: ProviderSessionRef | null,
  sessionDocRef: ProviderSessionRef | null = null,
): ProviderSessionRef | null {
  if (mode === 'off') {
    return markerRef ?? sessionRef ?? sessionDocRef;
  }
  const merged = mergeReuseProviderSession(markerRef, sessionRef, sessionDocRef);
  if (!merged.ok) {
    throw createOpenIDSessionEndedError();
  }
  return merged.ref;
}

export type FindProviderSessionBinding = (
  refreshToken: string,
) => Promise<ProviderSessionBinding | null>;

/** Reads the Session row's ref for `refreshToken` only when it can decide the result: mode is
 *  not `'off'` and neither the marker nor the Express session has a ref. A failed read throws
 *  `ProviderSessionUnavailableError` (`503`, cookies kept). */
async function findSessionDocProviderSession(
  mode: ResolvedBackchannelLogoutConfig['mode'],
  markerRef: ProviderSessionRef | null,
  sessionRef: ProviderSessionRef | null,
  refreshToken: string | undefined,
  findProviderSessionBinding: FindProviderSessionBinding,
): Promise<ProviderSessionRef | null> {
  if (mode === 'off' || markerRef || sessionRef || !refreshToken) {
    return null;
  }
  try {
    return (await findProviderSessionBinding(refreshToken))?.providerSession ?? null;
  } catch (error) {
    throw new ProviderSessionUnavailableError('Session provider-session lookup failed', {
      cause: error,
    });
  }
}

/** Resolves the provider session bound to a refresh token: the bound reuse-identity marker's ref,
 *  then the Express session's ref, then the Session row's ref for that token. Mode `'off'`
 *  carries the marker or Express session ref forward and reads no Session row. */
export async function resolveBoundProviderSessionForToken(
  mode: ResolvedBackchannelLogoutConfig['mode'],
  parsedCookies: { openid_user_id?: string },
  jwtRefreshSecret: string | undefined,
  refreshToken: string | undefined,
  sessionProviderSession: ProviderSessionRef | null,
  findProviderSessionBinding: FindProviderSessionBinding,
): Promise<ProviderSessionRef | null> {
  const markerRef =
    getValidOpenIDReuseCredential(parsedCookies, jwtRefreshSecret, refreshToken)?.providerSession ??
    null;
  const sessionDocRef = await findSessionDocProviderSession(
    mode,
    markerRef,
    sessionProviderSession,
    refreshToken,
    findProviderSessionBinding,
  );
  return resolveBoundProviderSession(mode, markerRef, sessionProviderSession, sessionDocRef);
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
  /** Reads the Session row's provider-session binding by refresh token hash. */
  findProviderSessionBinding: FindProviderSessionBinding;
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
  /** `resolveBoundProviderSessionForToken` for this request's mode and cookies. Reads the
   *  Session row at most once for each token. */
  resolveBoundProviderSession: (
    refreshToken: string | undefined,
    sessionProviderSession: ProviderSessionRef | null,
  ) => Promise<ProviderSessionRef | null>;
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

  const bindingLookups = new Map<string, Promise<ProviderSessionBinding | null>>();
  const findProviderSessionBinding: FindProviderSessionBinding = (token) => {
    let lookup = bindingLookups.get(token);
    if (!lookup) {
      lookup = deps.findProviderSessionBinding(token);
      bindingLookups.set(token, lookup);
    }
    return lookup;
  };

  const authorizeReuse = async (
    sessionProviderSession: ProviderSessionRef | null,
    session?: AuthorizeCachedReuseSessionInput['session'],
  ) => {
    const markerProviderSession = reuseCredential?.providerSession ?? null;
    await authorizeCachedReuseSession(
      {
        authorizer: deps.authorizer,
        deleteOpenIDSession: deps.deleteOpenIDSession,
        logger: deps.logger,
        providerSessionExpiryMs: deps.providerSessionExpiryMs,
      },
      {
        markerProviderSession,
        sessionProviderSession,
        sessionDocProviderSession: await findSessionDocProviderSession(
          mode,
          markerProviderSession,
          sessionProviderSession,
          refreshToken,
          findProviderSessionBinding,
        ),
        refreshToken,
        session,
      },
    );
  };

  const resolveBoundProviderSessionFor = (
    token: string | undefined,
    sessionProviderSession: ProviderSessionRef | null,
  ) =>
    resolveBoundProviderSessionForToken(
      mode,
      deps.parsedCookies,
      deps.jwtRefreshSecret,
      token,
      sessionProviderSession,
      findProviderSessionBinding,
    );

  return {
    mode,
    reuseCredential,
    authorizeReuse,
    resolveBoundProviderSession: resolveBoundProviderSessionFor,
  };
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
