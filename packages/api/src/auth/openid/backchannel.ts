import {
  DEFAULT_OPENID_BACKCHANNEL_LOGOUT_DEADLINE_MS,
  DEFAULT_OPENID_BACKCHANNEL_LOGOUT_MAX_AGE_MS,
} from 'librechat-data-provider';
import type { OpenIDAuthorizationMethods } from '@librechat/data-schemas';
import type { Request, RequestHandler } from 'express';
import type { BackchannelLogoutRateLimitConfig } from './logout/receiver';
import type { BackchannelLogoutWorker } from './logout/worker';
import type { OpenIDSessionsAppConfig } from './runtime';
import type { LeaseDeps } from '~/admin/lease';
import type { OpenIDLogger } from './types';
import {
  createBackchannelLogoutBodyParser,
  createBackchannelLogoutRateLimiter,
  createBackchannelLogoutReceiver,
} from './logout/receiver';
import { createBackchannelLogoutVerifier } from './logout/token';
import { createBackchannelLogoutWorker } from './logout/worker';
import { limiterCache } from '~/cache/cacheFactory';
import { createIssuerJwksGetKey } from './jwks';
import { removePorts } from '~/utils/ports';

export interface OpenIDBackchannelLogoutConfig {
  clientMetadata?: () => { id_token_signed_response_alg?: string };
  serverMetadata: () => {
    issuer: string;
    jwks_uri: string;
    id_token_signing_alg_values_supported?: string[];
  };
}

export interface OpenIDBackchannelLogoutAppConfig {
  registration?: OpenIDSessionsAppConfig['registration'] & {
    openidBackchannelLogout?: boolean;
    openidBackchannelLogoutMaxAgeMs?: number;
    openidBackchannelLogoutDeadlineMs?: number;
  };
  rateLimits?: { openidBackchannelLogout?: BackchannelLogoutRateLimitConfig };
}

export interface OpenIDBackchannelLogoutRuntimeDeps {
  getOpenIdConfig: () => OpenIDBackchannelLogoutConfig | undefined;
  connectOpenIDAuthorization: (appConfig?: OpenIDSessionsAppConfig) => Promise<unknown>;
  getAuthorizationMethods: () => OpenIDAuthorizationMethods | undefined;
  getLeaseMethods: () => LeaseDeps | undefined;
  logger: OpenIDLogger;
}

export interface OpenIDBackchannelLogoutRuntime {
  initOpenIDBackchannelLogout: (appConfig?: OpenIDBackchannelLogoutAppConfig) => Promise<void>;
  startOpenIDBackchannelLogoutWorker: () => void;
  getBodyParser: () => RequestHandler | undefined;
  getRateLimiter: () => RequestHandler | undefined;
  getReceiver: () => RequestHandler | undefined;
  createRouteMiddleware: () => RequestHandler[];
}

/** Prefers the client's registered `id_token_signed_response_alg`; falls back to the issuer's
 *  advertised set, then `RS256`. */
function resolveAlgorithms(openIdConfig: OpenIDBackchannelLogoutConfig): string[] {
  const clientAlg = openIdConfig.clientMetadata?.()?.id_token_signed_response_alg;
  if (typeof clientAlg === 'string' && clientAlg) {
    return [clientAlg];
  }
  const supported = openIdConfig.serverMetadata?.()?.id_token_signing_alg_values_supported;
  if (Array.isArray(supported) && supported.length > 0) {
    return supported.filter((alg) => typeof alg === 'string');
  }
  return ['RS256'];
}

function buildDisabledReceiver(logger: OpenIDLogger): RequestHandler {
  return createBackchannelLogoutReceiver({
    methods: undefined as unknown as OpenIDAuthorizationMethods,
    verifier: async () => ({ ok: false, code: 'malformed' }),
    config: { enabled: false },
    logger,
  });
}

/** Re-reads the authorization connection's methods on every call instead of binding them once at
 *  startup, so the receiver and worker pick up a connection that finishes after `init` runs. */
function createLazyMethods<T extends object>(resolve: () => T | undefined): T {
  return new Proxy(
    {},
    {
      get: (_target, prop) => {
        /** Not a thenable; `await`-ing this proxy must resolve to itself, not hang or throw. */
        if (prop === 'then' || typeof prop === 'symbol') {
          return undefined;
        }
        return (...args: unknown[]) => {
          const methods = resolve();
          if (!methods) {
            return Promise.reject(new Error('OpenID authorization connection is not ready'));
          }
          return (methods as unknown as Record<string, (...a: unknown[]) => unknown>)[
            prop as string
          ](...args);
        };
      },
    },
  ) as unknown as T;
}

export function createOpenIDBackchannelLogoutRuntime(
  deps: OpenIDBackchannelLogoutRuntimeDeps,
): OpenIDBackchannelLogoutRuntime {
  const {
    getOpenIdConfig,
    connectOpenIDAuthorization,
    getAuthorizationMethods,
    getLeaseMethods,
    logger,
  } = deps;

  let bodyParser: RequestHandler | undefined;
  let rateLimiter: RequestHandler | undefined;
  let receiver: RequestHandler | undefined;
  let worker: BackchannelLogoutWorker | undefined;

  /** Resolves OpenID discovery and builds the jose verifier on first use, caching it once it
   *  succeeds. */
  function createLazyVerifier({
    registration,
    deadlineMs,
  }: {
    registration: { openidBackchannelLogoutMaxAgeMs?: number };
    deadlineMs: number;
  }) {
    let verifier: ReturnType<typeof createBackchannelLogoutVerifier> | undefined;
    return async function lazyVerifier(logoutToken: string) {
      if (!verifier) {
        let openIdConfig: OpenIDBackchannelLogoutConfig | undefined;
        try {
          openIdConfig = getOpenIdConfig();
        } catch (err) {
          logger.error(
            '[OpenIDBackchannelLogout] OpenID discovery not ready; rejecting a logout token',
            { error: (err as Error).message },
          );
          throw new Error('OpenID discovery not ready');
        }
        if (!openIdConfig) {
          logger.error(
            '[OpenIDBackchannelLogout] OpenID discovery not ready; rejecting a logout token',
          );
          throw new Error('OpenID discovery not ready');
        }
        const algorithms = resolveAlgorithms(openIdConfig);
        logger.info(
          `[OpenIDBackchannelLogout] Verifying logout tokens with algorithms: ${algorithms.join(', ')}`,
        );
        verifier = createBackchannelLogoutVerifier({
          getKey: createIssuerJwksGetKey(
            openIdConfig.serverMetadata().jwks_uri,
            Math.max(500, deadlineMs - 1000),
          ),
          issuer: openIdConfig.serverMetadata().issuer,
          clientId: process.env.OPENID_CLIENT_ID as string,
          algorithms,
          maxAgeSeconds: Math.floor(
            (registration.openidBackchannelLogoutMaxAgeMs ??
              DEFAULT_OPENID_BACKCHANNEL_LOGOUT_MAX_AGE_MS) / 1000,
          ),
        });
      }
      return verifier(logoutToken);
    };
  }

  /** Builds the route's middleware; the receiver degrades to a 404 stub only when the flag is
   *  off. */
  async function initOpenIDBackchannelLogout(
    appConfig?: OpenIDBackchannelLogoutAppConfig,
  ): Promise<void> {
    const registration = appConfig?.registration ?? {};
    const rateLimits = appConfig?.rateLimits?.openidBackchannelLogout ?? {};

    bodyParser = createBackchannelLogoutBodyParser();
    rateLimiter = createBackchannelLogoutRateLimiter(
      {
        removePorts: removePorts as (req: Request) => string | undefined,
        store: limiterCache('openid_backchannel_logout'),
      },
      { ipMax: rateLimits.ipMax, ipWindowInMinutes: rateLimits.ipWindowInMinutes },
    );

    if (registration.openidBackchannelLogout !== true) {
      receiver = buildDisabledReceiver(logger);
      worker = undefined;
      return;
    }

    const authorization = await connectOpenIDAuthorization(appConfig);
    if (!authorization) {
      logger.warn(
        '[OpenIDBackchannelLogout] Authorization connection unavailable at startup; receiver returns 500 until it connects',
      );
    }

    const deadlineMs =
      registration.openidBackchannelLogoutDeadlineMs ??
      DEFAULT_OPENID_BACKCHANNEL_LOGOUT_DEADLINE_MS;
    const maxAgeMs =
      registration.openidBackchannelLogoutMaxAgeMs ?? DEFAULT_OPENID_BACKCHANNEL_LOGOUT_MAX_AGE_MS;
    /** Margin over the token's own max age so a late-running recovery pass still finds the
     *  event before it expires. */
    const logoutEventRetentionMs = maxAgeMs * 2;
    const methods = createLazyMethods<OpenIDAuthorizationMethods>(getAuthorizationMethods);

    receiver = createBackchannelLogoutReceiver({
      methods,
      verifier: createLazyVerifier({ registration, deadlineMs }),
      config: { enabled: true, deadlineMs, logoutEventRetentionMs },
      logger,
    });

    worker = createBackchannelLogoutWorker({
      methods,
      /** Bound to the authorization connection (the primary), not the app's main connection,
       *  which can be a read-only secondary. */
      lease: createLazyMethods<LeaseDeps>(getLeaseMethods),
      logger,
      logoutEventRetentionMs,
    });
  }

  function startOpenIDBackchannelLogoutWorker(): void {
    worker?.start();
  }

  function getBodyParser(): RequestHandler | undefined {
    return bodyParser;
  }

  function getRateLimiter(): RequestHandler | undefined {
    return rateLimiter;
  }

  function getReceiver(): RequestHandler | undefined {
    return receiver;
  }

  /** Rate limiter, body parser, then the receiver (404 if disabled); reads each stage through
   *  the runtime instance so a rerun or test override of its getters takes effect. */
  function createRouteMiddleware(): RequestHandler[] {
    return [
      (req, res, next) => {
        const limiter = runtime.getRateLimiter();
        return limiter ? limiter(req, res, next) : next();
      },
      (req, res, next) => {
        const parser = runtime.getBodyParser();
        return parser ? parser(req, res, next) : next();
      },
      (req, res, next) => {
        const handler = runtime.getReceiver();
        if (!handler) {
          res.status(404).end();
          return;
        }
        handler(req, res, next);
      },
    ];
  }

  const runtime: OpenIDBackchannelLogoutRuntime = {
    initOpenIDBackchannelLogout,
    startOpenIDBackchannelLogoutWorker,
    getBodyParser,
    getRateLimiter,
    getReceiver,
    createRouteMiddleware,
  };
  return runtime;
}
