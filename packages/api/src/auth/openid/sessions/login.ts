import { tenantStorage, getTenantId } from '@librechat/data-schemas';
import type { OpenIDAuthorizationMethods } from '@librechat/data-schemas';
import type { Request, Response, NextFunction } from 'express';
import type { OpenIDLogger } from '../types';
import {
  authorizeOpenIDSession,
  withAuthorizationTimeout,
  type OpenIDSessionAuthorizationDeps,
} from './authorize';
import { getSafeErrorMetadata } from '~/utils/errors';

export interface OpenIDLoginClaims {
  issuer: string;
  clientId: string;
  subject: string;
  /** Required when enforcement is on; a missing value records nothing and proceeds otherwise. */
  sid?: string;
  /** Epoch seconds; undefined when the token carried no `iat`. */
  loginIat?: number;
}

export interface OpenIDLoginContext {
  user: string;
  tenantId: string;
}

export interface OpenIDLoginRetryMarker {
  sid: string;
}

/** What a `prompt=login` retry needs back, since the redirect that starts it carries neither. */
export interface OpenIDPendingInitiation {
  tenantId?: string;
  codeChallenge?: string;
}

export interface OpenIDLoginSession {
  openidLoginRetry?: OpenIDLoginRetryMarker;
  openidPendingInitiation?: OpenIDPendingInitiation;
}

/** Remembers this initiation's tenant and (admin-only) PKCE challenge next to the retry marker. */
export function rememberOpenIDInitiation(
  session: OpenIDLoginSession | undefined,
  initiation: OpenIDPendingInitiation,
): void {
  if (session) {
    session.openidPendingInitiation = initiation;
  }
}

/** Falls back to what a prior initiation remembered, but only on the `prompt=login` retry a
 *  denied login requested; an ordinary request with nothing current gets nothing restored. */
export function resolveOpenIDInitiationValue<K extends keyof OpenIDPendingInitiation>(
  session: OpenIDLoginSession | undefined,
  key: K,
  current: OpenIDPendingInitiation[K],
  isRetry: boolean,
): OpenIDPendingInitiation[K] {
  if (current) {
    return current;
  }
  return isRetry ? session?.openidPendingInitiation?.[key] : undefined;
}

/** The only check for a real `prompt=login` retry: enforcement is on, the query asks for it, and
 *  the denial that requested it left its marker on this session. */
export function isOpenIDLoginRetry(
  req: Pick<Request, 'query'> & { session?: OpenIDLoginSession },
  enforcement: boolean,
): boolean {
  return (
    enforcement === true && req.query.prompt === 'login' && Boolean(req.session?.openidLoginRetry)
  );
}

/** Restores the ALS tenant context a `prompt=login` retry would otherwise start without, so
 *  `requirePreAuthTenantContext` sees the same tenant the original initiation resolved. */
export function restoreOpenIDRetryTenantContext(
  req: Request & { session?: OpenIDLoginSession },
  _res: Response,
  next: NextFunction,
  enforcement: boolean,
): void {
  const isRetry = isOpenIDLoginRetry(req, enforcement);
  const current = getTenantId();
  const tenantId = resolveOpenIDInitiationValue(req.session, 'tenantId', current, isRetry);
  if (tenantId && tenantId !== current) {
    tenantStorage.run({ tenantId }, next);
    return;
  }
  next();
}

export type OpenIDLoginOutcome =
  | { status: 'authorized'; sessionId?: string }
  | { status: 'retry' }
  | { status: 'denied'; code: 'missing_sid' | 'subject_mismatch' | 'login_denied' | 'unavailable' };

export interface OpenIDLoginDeps {
  authorization: Pick<OpenIDAuthorizationMethods, 'recordOpenIDLogin' | 'upsertOpenIDBinding'>;
  authorizationDeps: OpenIDSessionAuthorizationDeps;
  now: () => Date;
  logger?: Pick<OpenIDLogger, 'warn'>;
}

interface LoginRecordResult {
  ok: true;
  sessionId: string;
}

interface LoginRecordDenied {
  ok: false;
  code: 'subject_mismatch';
}

async function recordLoginAndBinding(
  claims: OpenIDLoginClaims & { sid: string },
  context: OpenIDLoginContext,
  deps: OpenIDLoginDeps,
): Promise<LoginRecordResult | LoginRecordDenied> {
  const loginResult = await deps.authorization.recordOpenIDLogin({
    issuer: claims.issuer,
    clientId: claims.clientId,
    subject: claims.subject,
    sid: claims.sid,
    loginIat: claims.loginIat,
    now: deps.now(),
  });
  if (!loginResult.ok) {
    return { ok: false, code: 'subject_mismatch' };
  }
  const sessionId = loginResult.session._id.toString();
  await deps.authorization.upsertOpenIDBinding({
    sessionId,
    user: context.user,
    tenantId: context.tenantId,
  });
  return { ok: true, sessionId };
}

function clearOpenIDLoginRetryState(session: OpenIDLoginSession | undefined): void {
  if (session) {
    delete session.openidLoginRetry;
    delete session.openidPendingInitiation;
  }
}

/** Upserts the session and binding, then authorizes before the caller may publish a credential.
 *  Every outcome but `retry` consumes the retry marker and the pending initiation with it. */
export async function completeOpenIDLogin(
  claims: OpenIDLoginClaims,
  context: OpenIDLoginContext,
  session: OpenIDLoginSession | undefined,
  deps: OpenIDLoginDeps,
): Promise<OpenIDLoginOutcome> {
  if (!claims.sid) {
    clearOpenIDLoginRetryState(session);
    if (deps.authorizationDeps.enforcement) {
      return { status: 'denied', code: 'missing_sid' };
    }
    return { status: 'authorized' };
  }

  let sessionId: string;
  try {
    const recorded = await withAuthorizationTimeout(
      recordLoginAndBinding(claims as OpenIDLoginClaims & { sid: string }, context, deps),
      deps.authorizationDeps.timeoutMs,
    );
    if (!recorded.ok) {
      clearOpenIDLoginRetryState(session);
      if (deps.authorizationDeps.enforcement) {
        return { status: 'denied', code: recorded.code };
      }
      deps.logger?.warn(
        '[openid:login] Subject mismatch while recording login; enforcement is off, proceeding',
      );
      return { status: 'authorized' };
    }
    sessionId = recorded.sessionId;
  } catch (error) {
    clearOpenIDLoginRetryState(session);
    if (deps.authorizationDeps.enforcement) {
      deps.logger?.warn(
        '[openid:login] Failed to record login; enforcement is on, denying',
        getSafeErrorMetadata(error),
      );
      return { status: 'denied', code: 'unavailable' };
    }
    deps.logger?.warn(
      '[openid:login] Failed to record login; enforcement is off, proceeding',
      getSafeErrorMetadata(error),
    );
    return { status: 'authorized' };
  }

  const authorization = await authorizeOpenIDSession(
    {
      issuer: claims.issuer,
      clientId: claims.clientId,
      subject: claims.subject,
      sessionId,
      user: context.user,
      tenantId: context.tenantId,
    },
    deps.authorizationDeps,
  );
  if (authorization.ok) {
    clearOpenIDLoginRetryState(session);
    return { status: 'authorized', sessionId: authorization.sessionId ?? sessionId };
  }
  if (authorization.code === 'unavailable') {
    clearOpenIDLoginRetryState(session);
    return { status: 'denied', code: 'unavailable' };
  }

  if (session?.openidLoginRetry?.sid === claims.sid) {
    clearOpenIDLoginRetryState(session);
    return { status: 'denied', code: 'login_denied' };
  }
  if (session) {
    session.openidLoginRetry = { sid: claims.sid };
  }
  return { status: 'retry' };
}
