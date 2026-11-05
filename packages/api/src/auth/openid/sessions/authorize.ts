import { isOpenIDSessionDenied } from '@librechat/data-schemas';
import type { OpenIDAuthorizationMethods } from '@librechat/data-schemas';
import type { Response } from 'express';
import { normalizeOpenIdIssuer } from '~/auth/openid';

export const OPENID_SESSION_AUTHORIZATION_DENIED = 'OPENID_SESSION_AUTHORIZATION_DENIED';
export const OPENID_SESSION_AUTHORIZATION_UNAVAILABLE = 'OPENID_SESSION_AUTHORIZATION_UNAVAILABLE';

export type OpenIDSessionDenialCode =
  | 'unknown_session'
  | 'identity_mismatch'
  | 'no_binding'
  | 'denied';

export type OpenIDSessionAuthorizationCode = OpenIDSessionDenialCode | 'unavailable';

interface OpenIDSessionAuthorizationIdentity {
  /** Absent means the caller never resolved a confirmed issuer; normalization rejects it the
   *  same as an empty one. */
  issuer: string | undefined;
  clientId: string;
  subject: string;
  user: string;
  /** Absent, null and empty both mean "no tenant"; the binding methods normalize all three. */
  tenantId?: string;
}

interface AuthorizeOpenIDSessionBySid extends OpenIDSessionAuthorizationIdentity {
  sid: string;
  sessionId?: undefined;
}

interface AuthorizeOpenIDSessionBySessionId extends OpenIDSessionAuthorizationIdentity {
  sessionId: string;
  sid?: undefined;
  /** Reads already started by the caller for this `sessionId`, used instead of starting new
   *  ones; lets a caller overlap these reads with its own user load. */
  prefetchedSession?: Promise<
    Awaited<ReturnType<OpenIDSessionReadMethods['findOpenIDSessionById']>>
  >;
  prefetchedBinding?: Promise<Awaited<ReturnType<OpenIDSessionReadMethods['findOpenIDBinding']>>>;
}

// A plain union (not `Identity & (A | B)`) so checking one property narrows both branches;
// intersecting a union defeats discriminated narrowing.
export type AuthorizeOpenIDSessionInput =
  | AuthorizeOpenIDSessionBySid
  | AuthorizeOpenIDSessionBySessionId;

export type AuthorizeOpenIDSessionResult =
  | { ok: true; sessionId?: string }
  | { ok: false; code: OpenIDSessionAuthorizationCode };

export interface OpenIDSessionCacheKey {
  issuer: string;
  clientId: string;
  sid: string;
}

export interface OpenIDSessionCacheEntry {
  sessionId: string;
  subject: string;
}

/** Resolves a `sid` to its session location; never holds an authorization decision. */
export interface OpenIDSessionCache {
  get: (key: OpenIDSessionCacheKey) => OpenIDSessionCacheEntry | undefined;
  set: (key: OpenIDSessionCacheKey, value: OpenIDSessionCacheEntry) => void;
}

function cacheKey({ issuer, clientId, sid }: OpenIDSessionCacheKey): string {
  return `${issuer}\x1f${clientId}\x1f${sid}`;
}

export function createOpenIDSessionCache(maxEntries = 10_000): OpenIDSessionCache {
  const store = new Map<string, OpenIDSessionCacheEntry>();
  return {
    get(key) {
      return store.get(cacheKey(key));
    },
    set(key, value) {
      const serialized = cacheKey(key);
      if (!store.has(serialized) && store.size >= maxEntries) {
        const oldest = store.keys().next().value;
        if (oldest !== undefined) {
          store.delete(oldest);
        }
      }
      store.set(serialized, value);
    },
  };
}

type OpenIDSessionReadMethods = Pick<
  OpenIDAuthorizationMethods,
  | 'findOpenIDSession'
  | 'findOpenIDSessionById'
  | 'findOpenIDSubject'
  | 'findOpenIDBinding'
  | 'findOpenIDBindingBySid'
>;

export interface OpenIDSessionAuthorizationDeps {
  authorization: OpenIDSessionReadMethods;
  enforcement: boolean;
  timeoutMs: number;
  cache: OpenIDSessionCache;
}

const AUTHORIZATION_TIMEOUT_MESSAGE = 'OpenID session authorization timed out';

export function withAuthorizationTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(AUTHORIZATION_TIMEOUT_MESSAGE)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export function isAuthorizationTimeoutError(error: unknown): boolean {
  return error instanceof Error && error.message === AUTHORIZATION_TIMEOUT_MESSAGE;
}

interface AuthorizationReads {
  sessionId: string;
  sessionIssuer: string;
  sessionClientId: string;
  sessionSubject: string | null;
  sessionRevokedAt: Date | null | undefined;
  sessionFirstLoginIat: number | null | undefined;
  subjectBoundaryIat: number | null | undefined;
  binding: unknown;
}

/** Distributes over a union so each branch keeps its own-only fields (e.g. `prefetchedSession`)
 *  instead of collapsing to their common keys, which plain `Omit` would do. */
type NarrowIssuer<Branch> = Branch extends unknown
  ? Omit<Branch, 'issuer'> & { issuer: string }
  : never;

/** `authorizeOpenIDSession` only calls this once its own issuer normalization has rejected an
 *  absent one, so the issuer here is always a confirmed string. */
type ResolvedAuthorizationInput = NarrowIssuer<AuthorizeOpenIDSessionInput>;

async function resolveAuthorizationReads(
  input: ResolvedAuthorizationInput,
  deps: OpenIDSessionAuthorizationDeps,
): Promise<AuthorizationReads | null> {
  const { authorization, cache } = deps;
  const subjectQuery = { issuer: input.issuer, clientId: input.clientId, subject: input.subject };

  if (input.sessionId !== undefined) {
    const sessionId = input.sessionId;
    const [session, subject, binding] = await Promise.all([
      input.prefetchedSession ?? authorization.findOpenIDSessionById(sessionId),
      authorization.findOpenIDSubject(subjectQuery),
      input.prefetchedBinding ??
        authorization.findOpenIDBinding({ sessionId, user: input.user, tenantId: input.tenantId }),
    ]);
    if (!session) {
      return null;
    }
    return {
      sessionId,
      sessionIssuer: session.issuer,
      sessionClientId: session.clientId,
      sessionSubject: session.subject,
      sessionRevokedAt: session.revokedAt,
      sessionFirstLoginIat: session.firstLoginIat,
      subjectBoundaryIat: subject?.boundaryIat,
      binding,
    };
  }

  const sid = input.sid;
  const cached = cache.get({ issuer: input.issuer, clientId: input.clientId, sid });
  if (cached) {
    const [session, subject, binding] = await Promise.all([
      authorization.findOpenIDSessionById(cached.sessionId),
      authorization.findOpenIDSubject(subjectQuery),
      authorization.findOpenIDBinding({
        sessionId: cached.sessionId,
        user: input.user,
        tenantId: input.tenantId,
      }),
    ]);
    if (!session) {
      return null;
    }
    return {
      sessionId: cached.sessionId,
      sessionIssuer: session.issuer,
      sessionClientId: session.clientId,
      sessionSubject: session.subject,
      sessionRevokedAt: session.revokedAt,
      sessionFirstLoginIat: session.firstLoginIat,
      subjectBoundaryIat: subject?.boundaryIat,
      binding,
    };
  }

  const [session, subject, binding] = await Promise.all([
    authorization.findOpenIDSession({ issuer: input.issuer, clientId: input.clientId, sid }),
    authorization.findOpenIDSubject(subjectQuery),
    authorization.findOpenIDBindingBySid({
      issuer: input.issuer,
      clientId: input.clientId,
      sid,
      user: input.user,
      tenantId: input.tenantId,
    }),
  ]);
  if (!session) {
    return null;
  }
  const sessionId = session._id.toString();
  cache.set(
    { issuer: input.issuer, clientId: input.clientId, sid },
    { sessionId, subject: session.subject },
  );
  return {
    sessionId,
    sessionIssuer: session.issuer,
    sessionClientId: session.clientId,
    sessionSubject: session.subject,
    sessionRevokedAt: session.revokedAt,
    sessionFirstLoginIat: session.firstLoginIat,
    subjectBoundaryIat: subject?.boundaryIat,
    binding,
  };
}

/** Re-reads the session, subject boundary and binding on every call; the cache only resolves a
 *  `sid` to its session location, never an authorization decision. */
export async function authorizeOpenIDSession(
  input: AuthorizeOpenIDSessionInput,
  deps: OpenIDSessionAuthorizationDeps,
): Promise<AuthorizeOpenIDSessionResult> {
  if (!deps.enforcement) {
    return { ok: true, sessionId: input.sessionId };
  }

  const issuer = normalizeOpenIdIssuer(input.issuer);
  if (!issuer) {
    return { ok: false, code: 'identity_mismatch' };
  }
  const normalizedInput = { ...input, issuer };

  let reads: AuthorizationReads | null;
  try {
    reads = await withAuthorizationTimeout(
      resolveAuthorizationReads(normalizedInput, deps),
      deps.timeoutMs,
    );
  } catch {
    return { ok: false, code: 'unavailable' };
  }

  if (!reads) {
    return { ok: false, code: 'unknown_session' };
  }
  if (
    reads.sessionSubject !== normalizedInput.subject ||
    reads.sessionIssuer !== issuer ||
    reads.sessionClientId !== normalizedInput.clientId
  ) {
    return { ok: false, code: 'identity_mismatch' };
  }
  if (
    isOpenIDSessionDenied({
      sessionRevokedAt: reads.sessionRevokedAt,
      sessionFirstLoginIat: reads.sessionFirstLoginIat,
      subjectBoundaryIat: reads.subjectBoundaryIat,
    })
  ) {
    return { ok: false, code: 'denied' };
  }
  if (!reads.binding) {
    return { ok: false, code: 'no_binding' };
  }
  return { ok: true, sessionId: reads.sessionId };
}

export type OpenIDSessionReferenceAuthorizationCode = 'unknown_session' | 'denied' | 'unavailable';

export type AuthorizeOpenIDSessionReferenceResult =
  | { ok: true }
  | { ok: false; code: OpenIDSessionReferenceAuthorizationCode };

/** Authorizes a bare session reference with no subject, user, or tenant to compare it against,
 *  for callers that only learn the subject afterward. Skips the binding check done elsewhere. */
export async function authorizeOpenIDSessionReference(
  sessionId: string,
  deps: Pick<OpenIDSessionAuthorizationDeps, 'authorization' | 'enforcement' | 'timeoutMs'>,
): Promise<AuthorizeOpenIDSessionReferenceResult> {
  if (!deps.enforcement) {
    return { ok: true };
  }
  try {
    const session = await withAuthorizationTimeout(
      deps.authorization.findOpenIDSessionById(sessionId),
      deps.timeoutMs,
    );
    if (!session) {
      return { ok: false, code: 'unknown_session' };
    }
    const subject = await withAuthorizationTimeout(
      deps.authorization.findOpenIDSubject({
        issuer: session.issuer,
        clientId: session.clientId,
        subject: session.subject,
      }),
      deps.timeoutMs,
    );
    if (
      isOpenIDSessionDenied({
        sessionRevokedAt: session.revokedAt,
        sessionFirstLoginIat: session.firstLoginIat,
        subjectBoundaryIat: subject?.boundaryIat,
      })
    ) {
      return { ok: false, code: 'denied' };
    }
    return { ok: true };
  } catch {
    return { ok: false, code: 'unavailable' };
  }
}

export function createOpenIDSessionAuthorizationDeniedError(
  code: OpenIDSessionDenialCode,
): Error & { code: string; denialCode: OpenIDSessionDenialCode } {
  return Object.assign(new Error(`OpenID session authorization denied: ${code}`), {
    code: OPENID_SESSION_AUTHORIZATION_DENIED,
    denialCode: code,
  });
}

export function isOpenIDSessionAuthorizationDeniedError(
  error: unknown,
): error is Error & { denialCode: OpenIDSessionDenialCode } {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code: unknown }).code === OPENID_SESSION_AUTHORIZATION_DENIED
  );
}

export function createOpenIDSessionAuthorizationUnavailableError(): Error & { code: string } {
  return Object.assign(new Error('OpenID session authorization is temporarily unavailable'), {
    code: OPENID_SESSION_AUTHORIZATION_UNAVAILABLE,
  });
}

export function isOpenIDSessionAuthorizationUnavailableError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code: unknown }).code === OPENID_SESSION_AUTHORIZATION_UNAVAILABLE
  );
}

/** Sends the shared 503 for an unavailable session store; false leaves the error for the
 *  caller's own handling. */
export function respondOpenIDSessionAuthorizationUnavailable(
  error: unknown,
  res: Pick<Response, 'status' | 'json'>,
): boolean {
  if (!isOpenIDSessionAuthorizationUnavailableError(error)) {
    return false;
  }
  res.status(503).json({ message: 'OpenID session authorization unavailable' });
  return true;
}

/** Throws on denial or unavailability instead of returning a code; callers that already have a
 *  try/catch around publication use this to fold authorization into existing rollback paths. */
export async function assertOpenIDSessionAuthorized(
  input: AuthorizeOpenIDSessionInput,
  deps: OpenIDSessionAuthorizationDeps,
): Promise<string | undefined> {
  const result = await authorizeOpenIDSession(input, deps);
  if (result.ok) {
    return result.sessionId;
  }
  if (result.code === 'unavailable') {
    throw createOpenIDSessionAuthorizationUnavailableError();
  }
  throw createOpenIDSessionAuthorizationDeniedError(result.code);
}

export type OpenIDSessionAuthorizationHttpKind = 'bearer' | 'refresh';

export interface OpenIDSessionAuthorizationHttpDecision {
  status: 401 | 403 | 503;
  clearCookies: boolean;
}

/** Maps a denial code to its HTTP treatment: unavailable keeps cookies, a confirmed denial clears
 *  them only on the refresh path, where a stale cookie would otherwise be retried. */
export function mapOpenIDSessionAuthorizationToHttp(
  code: OpenIDSessionAuthorizationCode,
  kind: OpenIDSessionAuthorizationHttpKind,
): OpenIDSessionAuthorizationHttpDecision {
  if (code === 'unavailable') {
    return { status: 503, clearCookies: false };
  }
  return kind === 'refresh'
    ? { status: 403, clearCookies: true }
    : { status: 401, clearCookies: false };
}
