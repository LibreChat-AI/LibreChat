import {
  AUTH_SESSION_CHECK_UNAVAILABLE,
  OPENID_SESSION_ENDED,
  OPENID_SESSION_ID_MISSING,
} from 'librechat-data-provider';
import type { ProviderSessionRef } from 'librechat-data-provider';
import type { Response } from 'express';
import type { ProviderSessionAuthorizer } from './authorize';
import type { OpenIDLogger } from '../types';
import {
  extractProviderSessionRef,
  providerSessionCredentialExpiry,
  type ProviderSessionClaims,
} from './ref';
import { isProviderSessionUnavailableError } from './errors';
import { redirectToAuthFailure } from '~/oauth/callback';

export interface OpenIDCallbackProviderSessionDeps {
  authorizer: ProviderSessionAuthorizer;
  getProviderSessionClient: () => { issuer: string; clientId: string } | null;
  logger: OpenIDLogger;
  refreshTokenExpiryMs: number;
}

export interface OpenIDCallbackProviderSessionInput {
  /** Lazy: only invoked once the mode is confirmed not `'off'`, so a disabled deployment never
   *  decodes claims or extracts a reference. */
  getClaims: () => ProviderSessionClaims & { sub?: string };
  /** When the login callback started; checked against `callbackGraceMs`. Missing is treated as
   *  indeterminately old, so absence cannot bypass a stale-callback check. */
  callbackIssuedAt?: Date;
  res: Response;
  clientDomain?: string;
}

export type OpenIDCallbackProviderSessionResult =
  | { ok: true; ref: ProviderSessionRef | null }
  | { ok: false };

/** Mode `'off'` returns before claims are decoded, so no reference is extracted or persisted. */
export async function establishOpenIDCallbackProviderSession(
  deps: OpenIDCallbackProviderSessionDeps,
  input: OpenIDCallbackProviderSessionInput,
): Promise<OpenIDCallbackProviderSessionResult> {
  try {
    const mode = await deps.authorizer.getMode();
    if (mode === 'off') {
      return { ok: true, ref: null };
    }

    const claims = input.getClaims();
    const client = deps.getProviderSessionClient();
    const ref = client
      ? extractProviderSessionRef(claims, { issuer: client.issuer, clientId: client.clientId })
      : null;
    const expiresAt = providerSessionCredentialExpiry(new Date(), deps.refreshTokenExpiryMs);
    const callbackIssuedAt = input.callbackIssuedAt ?? new Date(0);

    const outcome = await deps.authorizer.establish({
      ref,
      subject: claims.sub,
      expiresAt,
      callbackIssuedAt,
    });

    if (outcome.ok) {
      return { ok: true, ref };
    }
    if (outcome.code === OPENID_SESSION_ID_MISSING) {
      deps.logger.warn(
        '[OAuth] OpenID callback carried no provider session id (sid); denied by backchannel-logout enforcement',
      );
    }
    redirectToAuthFailure(input.res, {
      clientDomain: input.clientDomain,
      authFailedError:
        outcome.code === OPENID_SESSION_ID_MISSING
          ? OPENID_SESSION_ID_MISSING
          : OPENID_SESSION_ENDED,
    });
    return { ok: false };
  } catch (error) {
    if (!isProviderSessionUnavailableError(error)) {
      throw error;
    }
    deps.logger.error('[OAuth] Provider session check unavailable during OpenID callback', error);
    redirectToAuthFailure(input.res, {
      clientDomain: input.clientDomain,
      authFailedError: AUTH_SESSION_CHECK_UNAVAILABLE,
    });
    return { ok: false };
  }
}
