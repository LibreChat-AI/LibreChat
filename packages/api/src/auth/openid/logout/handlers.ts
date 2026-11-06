import { AUTH_SESSION_CHECK_UNAVAILABLE } from 'librechat-data-provider';
import type {
  ProviderSessionOperationData,
  ProviderSessionRevokeResult,
} from '@librechat/data-schemas';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { ResolvedBackchannelLogoutConfig } from '../providerSession/config';
import type { BackchannelLogoutClient } from './receiver';
import type { LogoutTokenKeyResolver } from './token';
import type { OpenIDLogger } from '../types';
import { isBackchannelLogoutEnabled, receiveBackchannelLogout } from './receiver';
import { createLogoutBodyParser } from './bodyParser';
import { getSafeErrorMetadata } from '~/utils/errors';
import { createLogoutJwksKeyResolver } from './jwks';

export interface BackchannelLogoutRequestState {
  config: ResolvedBackchannelLogoutConfig;
  client: BackchannelLogoutClient;
}

export interface BackchannelLogoutRequest extends Request {
  backchannelLogout?: BackchannelLogoutRequestState;
}

export interface CreateBackchannelLogoutHandlersOptions {
  getConfig: () => Promise<ResolvedBackchannelLogoutConfig>;
  getClient: () => BackchannelLogoutClient | null;
  /** Builds the JWKS-backed resolver once, at factory construction; ignored when `resolveKey` is given. */
  getJwksUri?: () => string;
  resolveKey?: LogoutTokenKeyResolver;
  revokeProviderSession: (
    data: ProviderSessionOperationData,
  ) => Promise<ProviderSessionRevokeResult>;
  logger: OpenIDLogger;
}

export interface BackchannelLogoutHandlers {
  requireBackchannelLogoutEnabled: (
    req: BackchannelLogoutRequest,
    res: Response,
    next: NextFunction,
  ) => Promise<void>;
  parseBackchannelLogoutBody: RequestHandler;
  handleBackchannelLogout: (req: BackchannelLogoutRequest, res: Response) => Promise<void>;
}

/** Wires the three Express handlers behind the back-channel logout route from injected deps;
 *  a `resolveKey` dep is used as-is, otherwise a JWKS resolver is built once here from `getJwksUri`. */
export function createBackchannelLogoutHandlers(
  deps: CreateBackchannelLogoutHandlersOptions,
): BackchannelLogoutHandlers {
  const resolveKey =
    deps.resolveKey ??
    createLogoutJwksKeyResolver({
      getJwksUri: () => {
        if (!deps.getJwksUri) {
          throw new Error('createBackchannelLogoutHandlers requires getJwksUri or resolveKey');
        }
        return deps.getJwksUri();
      },
    });

  async function requireBackchannelLogoutEnabled(
    req: BackchannelLogoutRequest,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    let config: ResolvedBackchannelLogoutConfig;
    try {
      config = await deps.getConfig();
    } catch (error) {
      deps.logger.error(
        '[OpenIDBackchannelLogout] Config load failed',
        getSafeErrorMetadata(error),
      );
      res.status(503).json({ code: AUTH_SESSION_CHECK_UNAVAILABLE });
      return;
    }
    const client = deps.getClient();
    if (!isBackchannelLogoutEnabled(config, client) || !client) {
      /** Skips the rest of this route, not just this middleware, so the request falls through to
       *  the app's ordinary 404 instead of continuing into the next handler in this route's chain. */
      next('route');
      return;
    }
    res.set('Cache-Control', 'no-store');
    req.backchannelLogout = { config, client };
    next();
  }

  const parseBackchannelLogoutBody = createLogoutBodyParser(
    (req) => (req as BackchannelLogoutRequest).backchannelLogout?.config.maxBodyBytes ?? 0,
  );

  async function handleBackchannelLogout(
    req: BackchannelLogoutRequest,
    res: Response,
  ): Promise<void> {
    const state = req.backchannelLogout as BackchannelLogoutRequestState;
    const response = await receiveBackchannelLogout(req.body?.logout_token, {
      config: state.config,
      client: state.client,
      resolveKey,
      revokeProviderSession: deps.revokeProviderSession,
      logger: deps.logger,
    });

    if (response.status === 200) {
      res.status(200).end();
      return;
    }
    res.status(response.status).json(response.body);
  }

  return { requireBackchannelLogoutEnabled, parseBackchannelLogoutBody, handleBackchannelLogout };
}
