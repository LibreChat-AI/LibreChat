import { logger } from '@librechat/data-schemas';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { AuthMethod } from '@librechat/data-schemas';

/** LDAP libraries can throw outside Express when asynchronous binds receive non-string credentials. */
export const validateLdapCredentials: RequestHandler = (req, res, next) => {
  const { email, password } = req.body ?? {};
  if (
    typeof email !== 'string' ||
    email.length === 0 ||
    typeof password !== 'string' ||
    password.length === 0
  ) {
    res.status(400).json({ message: 'Invalid credentials' });
    return;
  }
  next();
};

/** A request mid-LDAP-login: no user or auth method until the bind succeeds. */
export type LdapAuthRequest = Request & {
  user?: unknown;
  authMethod?: AuthMethod;
};

export interface CreateRequireLdapAuthDeps {
  /** Passport's `authenticate`, bound by the caller so this module never imports passport. */
  authenticate: (
    strategy: string,
    callback: (err: unknown, user?: unknown, info?: unknown) => void,
  ) => RequestHandler;
}

/** LDAP login: validates credentials, then delegates the bind to Passport's `ldapauth`
 *  strategy. On a successful bind, sets `req.user` and `req.authMethod`; on a rejected
 *  bind, responds 404 with the strategy's `info`; on an operational error, forwards it. */
export function createRequireLdapAuth({ authenticate }: CreateRequireLdapAuthDeps): RequestHandler {
  return (req: LdapAuthRequest, res: Response, next: NextFunction) =>
    validateLdapCredentials(req, res, () => {
      authenticate('ldapauth', (err, user, info) => {
        if (err) {
          logger.error('(requireLdapAuth) Error at passport.authenticate', err);
          next(err);
          return;
        }
        if (!user) {
          logger.warn('(requireLdapAuth) Error: No user');
          res.status(404).send(info);
          return;
        }
        req.user = user;
        req.authMethod = 'ldap';
        next();
      })(req, res, next);
    });
}
