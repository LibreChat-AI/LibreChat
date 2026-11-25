import { AUTH_SESSION_CHECK_UNAVAILABLE } from 'librechat-data-provider';
import type {
  ProviderSessionOperationData,
  ProviderSessionRevokeResult,
} from '@librechat/data-schemas';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { Agent } from 'http';
import type { ResolvedBackchannelLogoutConfig } from '../providerSession/config';
import type { BackchannelLogoutClient } from './receiver';
import type { LogoutTokenKeyResolver } from './token';
import type { OpenIDLogger } from '../types';
import { isBackchannelLogoutEnabled, receiveBackchannelLogout } from './receiver';
import { createLogoutBodyParser } from './bodyParser';
import { getSafeErrorMetadata } from '~/utils/errors';
import { createLogoutJwksKeyResolver } from './jwks';

/** `OPENID_JWKS_URL_CACHE_TIME`'s own default; reproduced here only as this factory's fallback
 *  when a caller omits `getCacheMaxAgeMs` (reads the env var itself, if any). */
const DEFAULT_JWKS_CACHE_MAX_AGE_MS = 60000;

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
  /** Cache TTL for the JWKS resolver built from `getJwksUri`; defaults to 60 seconds. Ignored
   *  when `resolveKey` is given. */
  getCacheMaxAgeMs?: () => number;
  /** Proxy agent for the JWKS resolver built from `getJwksUri`. Ignored when `resolveKey` is given. */
  getRequestAgent?: (uri: string) => Agent | undefined;
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
      getCacheMaxAgeMs: deps.getCacheMaxAgeMs ?? (() => DEFAULT_JWKS_CACHE_MAX_AGE_MS),
      getRequestAgent: deps.getRequestAgent,
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
      /** Mode off, or no OpenID client configured for this provider: the endpoint does not exist. */
      res.status(404).end();
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
