import type { NextFunction, Response } from 'express';
import type { OAuthFailureLog, OAuthFailureRequest } from './failure';
import type { AuthFailureRedirectOptions } from './callback';
import { buildOAuthFailureLog, getOAuthFailureMessage, hasOAuthErrorQuery } from './failure';
import { redirectToAuthFailure } from './callback';

export type OAuthErrorHandlerOptions = AuthFailureRedirectOptions & {
  logger: { warn: (message: string, details: OAuthFailureLog) => void };
};

/**
 * Handles `GET /oauth/error`, a path two flows share. The MCP, Action and pull request connect
 * callbacks redirect there with `?error=<code>` and expect the client's error page, so a request
 * that names an error falls through to the app shell. Passport's `failureRedirect` for social
 * login carries no query: it is logged and sent to the login screen.
 */
export function createOAuthErrorHandler({
  logger,
  clientDomain,
  authFailedError,
}: OAuthErrorHandlerOptions): (
  req: OAuthFailureRequest,
  res: Response,
  next: NextFunction,
) => void {
  return (req, res, next) => {
    if (hasOAuthErrorQuery(req)) {
      return next();
    }

    /** A single error message is pushed by passport when authentication fails. */
    const message = getOAuthFailureMessage(req);
    logger.warn(
      '[OAuth] Authentication failed',
      buildOAuthFailureLog({
        provider: 'unknown',
        req,
        info: { message },
        defaultMessage: message,
      }),
    );
    return redirectToAuthFailure(res, { clientDomain, authFailedError });
  };
}
