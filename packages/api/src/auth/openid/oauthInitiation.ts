import type { Request } from 'express';
import type { OpenIDLoginSession } from './sessions/login';
import { isOpenIDLoginRetry, rememberOpenIDInitiation } from './sessions/login';
import { stripQueryParam } from './query';

export interface OpenIDLoginInitiationRequest
  extends Pick<Request, 'query' | 'originalUrl' | 'url'> {
  session?: OpenIDLoginSession;
}

export interface OpenIDLoginInitiationAuthenticateOptions {
  prompt?: 'login';
}

/** Strips `prompt` on a genuine retry; passport would otherwise misclassify it as a callback. */
export function resolveOpenIDLoginInitiation(
  req: OpenIDLoginInitiationRequest,
  enforcement: boolean,
  tenantId: string | undefined,
): OpenIDLoginInitiationAuthenticateOptions {
  const isRetry = isOpenIDLoginRetry(req, enforcement);
  if (isRetry && req.session) {
    delete req.session.openidPendingInitiation;
  }
  if (enforcement) {
    rememberOpenIDInitiation(req.session, { tenantId });
  }
  if (!isRetry) {
    return {};
  }
  stripQueryParam(req, 'prompt');
  return { prompt: 'login' };
}
