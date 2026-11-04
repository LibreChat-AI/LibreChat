import type { Response } from 'express';
import type { OpenIDLogger } from './types';
import {
  isOpenIDSessionAuthorizationDeniedError,
  isOpenIDSessionAuthorizationUnavailableError,
} from './sessions/authorize';

export type OpenIDRefreshAuthorizationOutcome = 'unavailable' | 'denied' | 'unhandled';

export const OPENID_SESSION_AUTHORIZATION_UNAVAILABLE_STATUS = 503;
export const OPENID_SESSION_AUTHORIZATION_UNAVAILABLE_BODY = {
  code: 'OPENID_SESSION_AUTHORIZATION_UNAVAILABLE',
} as const;

/** Classifies an error caught around an OpenID session-authorization check: an infrastructure
 *  outage keeps cookies and asks the client to retry; a confirmed denial clears them. */
export function classifyOpenIDRefreshAuthorizationError(
  error: unknown,
): OpenIDRefreshAuthorizationOutcome {
  if (isOpenIDSessionAuthorizationUnavailableError(error)) {
    return 'unavailable';
  }
  if (isOpenIDSessionAuthorizationDeniedError(error)) {
    return 'denied';
  }
  return 'unhandled';
}

export interface HandleOpenIDRefreshAuthorizationErrorDeps {
  res: Pick<Response, 'status' | 'send'>;
  logger: Pick<OpenIDLogger, 'warn'>;
  logMessage: string;
}

/** The outage branch shared by every refresh-authorization catch site: logs, sends the 503,
 *  and tells the caller it already responded. Any other classification is the caller's own. */
export function handleOpenIDRefreshAuthorizationError(
  error: unknown,
  deps: HandleOpenIDRefreshAuthorizationErrorDeps,
): 'handled' | 'rethrow' {
  if (classifyOpenIDRefreshAuthorizationError(error) !== 'unavailable') {
    return 'rethrow';
  }
  deps.logger.warn(deps.logMessage, { error: error instanceof Error ? error.message : error });
  deps.res
    .status(OPENID_SESSION_AUTHORIZATION_UNAVAILABLE_STATUS)
    .send(OPENID_SESSION_AUTHORIZATION_UNAVAILABLE_BODY);
  return 'handled';
}
