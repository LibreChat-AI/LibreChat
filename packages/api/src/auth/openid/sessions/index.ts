export * from './authorize';
export * from './login';
export * from './refresh';

import type { OpenIDAuthorizationMethods } from '@librechat/data-schemas';
import { createOpenIDSessionCache, type OpenIDSessionCache } from './authorize';
import type { OpenIDSessionAuthorizationDeps } from './authorize';
import type { OpenIDLoginDeps } from './login';
import type { RevokeCurrentOpenIDSessionDeps } from './refresh';
import type { OpenIDLogger } from '../types';

export interface CreateOpenIDSessionAuthorizationOptions {
  authorization: OpenIDAuthorizationMethods;
  enforcement: boolean;
  timeoutMs: number;
  now?: () => Date;
  cache?: OpenIDSessionCache;
  logger?: Pick<OpenIDLogger, 'warn'>;
}

export interface OpenIDSessionAuthorization {
  authorizationDeps: OpenIDSessionAuthorizationDeps;
  loginDeps: OpenIDLoginDeps;
  revokeDeps: RevokeCurrentOpenIDSessionDeps;
}

/** Single assembly point for the session-authorization layer; callers inject the already-opened
 *  authorization methods and resolved config instead of this module reaching for either. */
export function createOpenIDSessionAuthorization(
  options: CreateOpenIDSessionAuthorizationOptions,
): OpenIDSessionAuthorization {
  const now = options.now ?? (() => new Date());
  const authorizationDeps: OpenIDSessionAuthorizationDeps = {
    authorization: options.authorization,
    enforcement: options.enforcement,
    timeoutMs: options.timeoutMs,
    cache: options.cache ?? createOpenIDSessionCache(),
  };
  return {
    authorizationDeps,
    loginDeps: {
      authorization: options.authorization,
      authorizationDeps,
      now,
      logger: options.logger,
    },
    revokeDeps: { authorization: options.authorization, now },
  };
}
