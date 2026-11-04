import type { Request } from 'express';
import type { OpenIDLoginSession } from './sessions';
import {
  isOpenIDLoginRetry,
  rememberOpenIDInitiation,
  resolveOpenIDInitiationValue,
} from './sessions';
import { setQueryParam, stripQueryParam } from './query';

export type AdminOpenIDLoginRequest = Request & { session?: OpenIDLoginSession };

export interface AdminOpenIDLoginInitiation {
  /** Pass as Passport's `prompt: 'login'` option; a retry needs it, a fresh login doesn't. */
  promptLogin: boolean;
}

/** Resolves a `prompt=login` retry, restores its PKCE challenge, and records this initiation
 *  so a denial can start one; strips `prompt` so Passport doesn't misread the callback. */
export function prepareAdminOpenIDLoginRequest(
  req: AdminOpenIDLoginRequest,
  enforcement: boolean,
  tenantId: string | undefined,
): AdminOpenIDLoginInitiation {
  const isRetry = isOpenIDLoginRetry(req, enforcement);
  const codeChallenge = resolveOpenIDInitiationValue(
    req.session,
    'codeChallenge',
    typeof req.query.code_challenge === 'string' ? req.query.code_challenge : undefined,
    isRetry,
  );
  if (isRetry && req.session) {
    delete req.session.openidPendingInitiation;
  }
  if (codeChallenge) {
    setQueryParam(req, 'code_challenge', codeChallenge);
  }
  if (enforcement) {
    rememberOpenIDInitiation(req.session, { tenantId, codeChallenge });
  }
  if (isRetry) {
    stripQueryParam(req, 'prompt');
  }
  return { promptLogin: isRetry };
}
