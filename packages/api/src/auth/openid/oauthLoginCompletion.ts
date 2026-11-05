import { ErrorTypes } from 'librechat-data-provider';
import type { OpenIDLoginClaims, OpenIDLoginDeps, OpenIDLoginSession } from './sessions/login';
import type { OpenIDLogger } from './types';
import { withAuthorizationTimeout } from './sessions/authorize';
import { completeOpenIDLogin } from './sessions/login';

interface OpenIDLoginClaimsSource {
  claims?: () => { sid?: string; iat?: number };
  sid?: string;
  iat?: number;
}

function extractOpenIDLoginClaims(tokenset: OpenIDLoginClaimsSource | undefined): {
  sid?: string;
  iat?: number;
} {
  if (typeof tokenset?.claims === 'function') {
    return tokenset.claims();
  }
  return tokenset ?? {};
}

export interface OpenIDLoginCompletionUser {
  id: string;
  tenantId?: string;
  openidIssuer?: string;
  openidId?: string;
}

export interface OpenIDLoginCompletionDeps {
  loginDeps: OpenIDLoginDeps | undefined;
  clientId: string;
  sessionAuthorizationEnforcement: boolean;
  sessionAuthorizationTimeoutMs: number;
  rememberAdminSessionRef: (refreshToken: string, openidSessionId: string) => Promise<void>;
  logger: Pick<OpenIDLogger, 'info' | 'warn'>;
}

export interface OpenIDLoginCompletionInput {
  provider?: string;
  user: OpenIDLoginCompletionUser;
  tokenset?: OpenIDLoginClaimsSource;
  session: OpenIDLoginSession | undefined;
  retryRoute: string;
  loginFailureRedirectBase: string;
  /** Whether this login is being exchanged for the admin panel, which keeps no Session document. */
  isAdminExchange: boolean;
  adminRefreshToken?: string;
}

export type OpenIDLoginCompletionResult =
  | { kind: 'redirect'; url: string }
  | { kind: 'continue'; openidSessionId?: string };

function loginFailureRedirect(base: string, code: string): OpenIDLoginCompletionResult {
  return {
    kind: 'redirect',
    url: `${base}/login?redirect=false&error=${ErrorTypes.AUTH_FAILED}&code=${code}`,
  };
}

/** Authorizes an OpenID login's `sid` before any credential is published; other providers
 *  continue unchanged. */
export async function resolveOpenIDLoginCompletion(
  input: OpenIDLoginCompletionInput,
  deps: OpenIDLoginCompletionDeps,
): Promise<OpenIDLoginCompletionResult> {
  if (input.provider !== 'openid') {
    return { kind: 'continue' };
  }

  let openidSessionId: string | undefined;
  if (deps.loginDeps) {
    const claims = extractOpenIDLoginClaims(input.tokenset);
    const loginClaims: OpenIDLoginClaims = {
      issuer: input.user.openidIssuer ?? '',
      clientId: deps.clientId,
      subject: input.user.openidId ?? '',
      sid: claims.sid,
      loginIat: claims.iat,
    };
    const outcome = await completeOpenIDLogin(
      loginClaims,
      { user: input.user.id, tenantId: input.user.tenantId ?? '' },
      input.session,
      deps.loginDeps,
    );
    if (outcome.status === 'retry') {
      deps.logger.info(
        `[OAuth] OpenID login retrying with prompt=login for user: ${input.user.id}`,
      );
      return { kind: 'redirect', url: `${input.retryRoute}?prompt=login` };
    }
    if (outcome.status === 'denied') {
      deps.logger.warn(`[OAuth] OpenID login denied for user: ${input.user.id} (${outcome.code})`);
      return loginFailureRedirect(input.loginFailureRedirectBase, outcome.code);
    }
    openidSessionId = outcome.sessionId;
  } else if (deps.sessionAuthorizationEnforcement) {
    deps.logger.warn(
      `[OAuth] OpenID login authorization is unavailable for user: ${input.user.id}`,
    );
    return loginFailureRedirect(input.loginFailureRedirectBase, 'unavailable');
  }

  if (input.isAdminExchange && input.adminRefreshToken && openidSessionId) {
    try {
      if (deps.sessionAuthorizationEnforcement) {
        await deps.rememberAdminSessionRef(input.adminRefreshToken, openidSessionId);
      } else {
        await withAuthorizationTimeout(
          deps.rememberAdminSessionRef(input.adminRefreshToken, openidSessionId),
          deps.sessionAuthorizationTimeoutMs,
        );
      }
    } catch (err) {
      if (deps.sessionAuthorizationEnforcement) {
        deps.logger.warn(
          `[OAuth] Failed to remember the admin OpenID session reference for user: ${input.user.id}`,
        );
        return loginFailureRedirect(input.loginFailureRedirectBase, 'unavailable');
      }
      deps.logger.warn('[OAuth] Failed to remember the admin OpenID session reference', {
        message: err instanceof Error ? err.message : err,
      });
    }
  }

  return { kind: 'continue', openidSessionId };
}
