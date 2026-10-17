import { TERMS_NOT_ACCEPTED_CODE } from 'librechat-data-provider';
import type { NextFunction, Request, Response } from 'express';
import type { AppConfig } from '@librechat/data-schemas';
import type { AppConfigUserLike, GetAppConfigOptions } from '~/app/service';
import { resolveStrictAppConfig } from '~/app/service';

type TermsUser = AppConfigUserLike & { termsAccepted?: boolean };

export interface TermsAcceptanceGateDependencies {
  getAppConfig: (options: GetAppConfigOptions) => Promise<AppConfig | undefined>;
}

export interface TermsAcceptanceGateOptions {
  /** `nested` answers in the `{ error: { ... } }` envelope the remote agent boundaries expose. */
  envelope?: 'flat' | 'nested';
}

const TERMS_NOT_ACCEPTED_MESSAGE = 'Terms of service must be accepted before using this feature';

/** Reads never start new processing, so the app can load behind the acceptance modal. */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Session upkeep, accepting, leaving, and stopping a run; credential management under /api/auth is not exempt. */
const EXEMPT_POSTS = new Set([
  '/api/auth/logout',
  '/api/auth/cloudfront/refresh',
  '/api/user/terms/accept',
  '/api/agents/chat/abort',
]);

function isExempt(method: string, pathname: string): boolean {
  if (method === 'POST') {
    return EXEMPT_POSTS.has(pathname);
  }
  return method === 'DELETE' && pathname === '/api/user/delete';
}

/** The mount point plus the route path, as the two-factor gate reads it; neither carries a query. */
function getPathname(req: Request): string {
  const pathname = `${req.baseUrl ?? ''}${req.path ?? ''}`.toLowerCase().replace(/\/+$/, '');
  return pathname || '/';
}

/**
 * Whether the user must accept the terms before anything is processed on their behalf. The
 * config is read only for a user who has not accepted, and fails closed: an override lookup
 * failure throws rather than falling back to a base config that may leave the gate off.
 */
export function createTermsBlockCheck(deps: TermsAcceptanceGateDependencies) {
  return async (user: TermsUser | undefined): Promise<boolean> => {
    if (user == null || user.termsAccepted === true) {
      return false;
    }
    const appConfig = await resolveStrictAppConfig(deps.getAppConfig, user);
    return appConfig?.interfaceConfig?.termsOfService?.modalAcceptance === true;
  };
}

/**
 * Enforces `interface.termsOfService.modalAcceptance` on the server: an authenticated user who has
 * not accepted the terms may read but not write, so a client that skips the modal cannot start
 * chats, uploads or any other processing. Runs after authentication and reads `termsAccepted` from
 * the user document already on the request; the config is resolved only for a user who has not
 * accepted and is attempting a write.
 */
export function createTermsAcceptanceGate(
  deps: TermsAcceptanceGateDependencies,
  options: TermsAcceptanceGateOptions = {},
) {
  const isBlocked = createTermsBlockCheck(deps);
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const user = req.user as TermsUser | undefined;
    if (SAFE_METHODS.has(req.method) || isExempt(req.method, getPathname(req))) {
      next();
      return;
    }

    try {
      if (!(await isBlocked(user))) {
        next();
        return;
      }
    } catch (error) {
      next(error);
      return;
    }

    res.status(403).json(
      options.envelope === 'nested'
        ? {
            error: {
              type: 'invalid_request_error',
              code: TERMS_NOT_ACCEPTED_CODE,
              message: TERMS_NOT_ACCEPTED_MESSAGE,
              param: null,
            },
          }
        : { code: TERMS_NOT_ACCEPTED_CODE, message: TERMS_NOT_ACCEPTED_MESSAGE },
    );
  };
}

/**
 * Wraps a request-scoped job that a read route starts, so a user who must still accept the terms
 * does not trigger processing; the route itself stays readable behind the modal.
 */
export function skipUntilTermsAccepted<T>(
  isBlocked: (user: TermsUser | undefined) => Promise<boolean>,
  job: (req: { user?: TermsUser }) => Promise<T>,
  fallback: T,
) {
  return async (req: { user?: TermsUser }): Promise<T> =>
    (await isBlocked(req.user)) ? fallback : job(req);
}

type RequestHandler = (req: Request, res: Response, next: NextFunction) => unknown;

/** Runs `handler` only once the gate has passed the request; a gate error goes straight to `next`. */
export function afterTermsGate(gate: RequestHandler, handler: RequestHandler): RequestHandler {
  return (req, res, next) =>
    gate(req, res, (error?: unknown) => (error ? next(error) : handler(req, res, next)));
}
