import type { OpenIDAuthorizationMethods } from '@librechat/data-schemas';
import type { OpenIDLogger } from '../types';
import {
  authorizeOpenIDSession,
  createOpenIDSessionAuthorizationDeniedError,
  createOpenIDSessionAuthorizationUnavailableError,
  withAuthorizationTimeout,
  type AuthorizeOpenIDSessionResult,
  type OpenIDSessionAuthorizationDeps,
} from './authorize';

export interface OpenIDRefreshIdentity {
  issuer: string | undefined;
  clientId: string;
  subject: string;
  user: string;
  tenantId?: string;
}

export interface OpenIDRefreshIdentityUser {
  _id?: unknown;
  id?: string;
  openidIssuer?: string;
  openidId?: string;
  tenantId?: string;
}

/** Builds the refresh-authorization identity from a loaded user; a missing claim falls back to
 *  an empty string so a legacy or partial record still produces a comparable identity. */
export function resolveOpenIDRefreshIdentity(
  user: OpenIDRefreshIdentityUser,
  clientId: string,
): OpenIDRefreshIdentity {
  return {
    issuer: user.openidIssuer ?? '',
    clientId,
    subject: user.openidId ?? '',
    user: user._id != null ? String(user._id) : (user.id ?? ''),
    tenantId: user.tenantId,
  };
}

export interface OpenIDSessionReferenceSources {
  sessionTokens?: { openidSessionId?: string };
  reuseCredential?: { openidSessionId?: string };
}

/** The express session's reference wins; the signed cookie bound to the refresh token covers the
 *  case where the session store lost it. */
export function resolveOpenIDSessionReference(
  sources: OpenIDSessionReferenceSources,
): string | undefined {
  return sources.sessionTokens?.openidSessionId ?? sources.reuseCredential?.openidSessionId;
}

/** No session reference is a legacy case; with enforcement on this resolves to
 *  `unknown_session` rather than creating one. */
export async function authorizeOpenIDRefresh(
  identity: OpenIDRefreshIdentity,
  sessionId: string | undefined,
  deps: OpenIDSessionAuthorizationDeps,
): Promise<AuthorizeOpenIDSessionResult> {
  if (!sessionId) {
    if (!deps.enforcement) {
      return { ok: true, sessionId: undefined };
    }
    return { ok: false, code: 'unknown_session' };
  }
  return authorizeOpenIDSession({ ...identity, sessionId }, deps);
}

export async function assertOpenIDRefreshAuthorized(
  identity: OpenIDRefreshIdentity,
  sessionId: string | undefined,
  deps: OpenIDSessionAuthorizationDeps,
): Promise<string | undefined> {
  const result = await authorizeOpenIDRefresh(identity, sessionId, deps);
  if (result.ok) {
    return result.sessionId;
  }
  if (result.code === 'unavailable') {
    throw createOpenIDSessionAuthorizationUnavailableError();
  }
  throw createOpenIDSessionAuthorizationDeniedError(result.code);
}

export interface RevokeCurrentOpenIDSessionDeps {
  authorization: Pick<OpenIDAuthorizationMethods, 'revokeOpenIDSessionById'>;
  now: () => Date;
}

export async function revokeCurrentOpenIDSession(
  sessionId: string,
  deps: RevokeCurrentOpenIDSessionDeps,
): Promise<{ revoked: boolean }> {
  const session = await deps.authorization.revokeOpenIDSessionById(sessionId, deps.now());
  return { revoked: session != null };
}

const DEFAULT_LOGOUT_REVOKE_TIMEOUT_MS = 3_000;

export interface RevokeOpenIDSessionOnLogoutInput {
  userId?: string;
  sessionTokens?: { openidSessionId?: string; appUserId?: string };
  refreshToken?: string;
  bearerSessionId?: string;
}

export interface RevokeOpenIDSessionOnLogoutDeps {
  findSession: (
    params: { userId: string; refreshToken: string },
    options: { lean: true },
  ) => Promise<{ openidSessionId?: string } | null>;
  /** A missing connection is a legacy or unconfigured case, not a logout failure. */
  revoke: RevokeCurrentOpenIDSessionDeps | undefined;
  enforcement: boolean;
  timeoutMs?: number;
  logger: OpenIDLogger;
}

/** Reuse mode keeps this on the session; non-reuse mode has no session copy, so this falls
 *  back to the login-created Session document, then the bearer's own verified claim. */
async function resolveLogoutOpenIDSessionId(
  input: RevokeOpenIDSessionOnLogoutInput,
  deps: Pick<RevokeOpenIDSessionOnLogoutDeps, 'findSession' | 'logger'>,
): Promise<string | undefined> {
  const { userId, sessionTokens, refreshToken, bearerSessionId } = input;
  /** A stale session can carry another user's identity (e.g. after an account switch on a
   *  shared browser session); only trust it when the stored identity still names this user. */
  if (
    sessionTokens?.openidSessionId &&
    sessionTokens.appUserId &&
    sessionTokens.appUserId === userId
  ) {
    return sessionTokens.openidSessionId;
  }
  if (userId && refreshToken) {
    try {
      const session = await deps.findSession({ userId, refreshToken }, { lean: true });
      if (session?.openidSessionId) {
        return session.openidSessionId;
      }
    } catch (err) {
      deps.logger.warn(
        '[revokeOpenIDSessionOnLogout] Failed to look up session for OpenID session id',
        err as Error,
      );
    }
  }
  return bearerSessionId;
}

/** Revokes the current OpenID session at logout, time-boxed and never failing logout, awaited
 *  under enforcement and fire-and-forget otherwise. */
export async function revokeOpenIDSessionOnLogout(
  input: RevokeOpenIDSessionOnLogoutInput,
  deps: RevokeOpenIDSessionOnLogoutDeps,
): Promise<void> {
  if (!deps.revoke) {
    return;
  }
  const revokeConnection = deps.revoke;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_LOGOUT_REVOKE_TIMEOUT_MS;
  const revoke = async () => {
    await withAuthorizationTimeout(
      (async () => {
        const sessionId = await resolveLogoutOpenIDSessionId(input, deps);
        if (sessionId) {
          await revokeCurrentOpenIDSession(sessionId, revokeConnection);
        }
      })(),
      timeoutMs,
    );
  };
  if (deps.enforcement) {
    try {
      await revoke();
    } catch (err) {
      deps.logger.warn(
        '[revokeOpenIDSessionOnLogout] Failed to revoke current OpenID session',
        err as Error,
      );
    }
    return;
  }
  revoke().catch((err) => {
    deps.logger.warn(
      '[revokeOpenIDSessionOnLogout] Failed to revoke current OpenID session',
      err as Error,
    );
  });
}
