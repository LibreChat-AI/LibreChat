import { logger } from '@librechat/data-schemas';
import type { TServerReadinessChecks } from 'librechat-data-provider';
import type { Request, Response, RequestHandler } from 'express';
import type { RedisClientType } from '@redis/client';
import type { Redis, Cluster } from 'ioredis';

type NodeRedisReadiness = Pick<RedisClientType, 'isReady'>;

/** The subset of a Node Redis cluster that reports per-master connectivity. */
type NodeRedisClusterReadiness = {
  isOpen: boolean;
  masters: ReadonlyArray<{ client?: NodeRedisReadiness }>;
};

export type RedisReadinessClients = {
  useRedis: boolean;
  ioredis: Pick<Redis | Cluster, 'status'> | null;
  keyv: NodeRedisReadiness | NodeRedisClusterReadiness | null;
};

export type ReadinessOptions = {
  checks?: Partial<TServerReadinessChecks>;
  isOpenIdReady?: () => boolean;
};

export type OpenIdReadinessState = {
  markPending: () => void;
  markReady: () => void;
  markNotConfigured: () => void;
  isReady: () => boolean;
};

/** Tracks this process's OpenID registration without relying on Passport's internal strategy map. */
export function createOpenIdReadiness(enabled: boolean): OpenIdReadinessState {
  let status: 'not-configured' | 'pending' | 'ready' = 'not-configured';

  return {
    markPending: () => {
      status = 'pending';
    },
    markReady: () => {
      status = 'ready';
    },
    markNotConfigured: () => {
      status = 'not-configured';
      if (enabled) {
        logger.warn(
          '[readiness] The OIDC readiness check is enabled, but OpenID login is not configured; skipping the check.',
        );
      }
    },
    isReady: () => !enabled || status !== 'pending',
  };
}

/**
 * A Node Redis cluster stays `isOpen` while an individual master reconnects, and every
 * key in that master's slots fails meanwhile. Masters connect eagerly (the client does
 * not set `minimizeConnections`), so each one must have a ready client.
 */
function isKeyvReady(keyv: NodeRedisReadiness | NodeRedisClusterReadiness): boolean {
  if ('isReady' in keyv) {
    return keyv.isReady;
  }
  return (
    keyv.isOpen &&
    keyv.masters.length > 0 &&
    keyv.masters.every((master) => master.client?.isReady === true)
  );
}

/**
 * Whether the shared Redis clients can serve commands. Always true when Redis is disabled.
 * A configured client that is missing, reconnecting, closed or ended counts as not ready,
 * because requests that touch the cache (sessions, OAuth state, rate limits) fail until it
 * recovers.
 */
export function isRedisReady({ useRedis, ioredis, keyv }: RedisReadinessClients): boolean {
  if (!useRedis) {
    return true;
  }
  if (ioredis?.status !== 'ready' || keyv == null) {
    return false;
  }
  return isKeyvReady(keyv);
}

function areReadinessChecksPassing(
  redis: RedisReadinessClients,
  { checks, isOpenIdReady }: ReadinessOptions,
): boolean {
  if (checks?.redis !== false && !isRedisReady(redis)) {
    return false;
  }
  if (checks?.oidc === true && !isOpenIdReady?.()) {
    return false;
  }
  return true;
}

/**
 * `/readyz` handler: 503 until startup completes, and again whenever Redis is configured
 * but disconnected, so readiness-gated orchestration stops routing to a pod that cannot
 * serve authenticated traffic. `/livez` stays unconditional so a Redis blip does not
 * trigger a liveness restart loop.
 */
export const createReadinessHandler =
  (isServerReady: () => boolean, redis: RedisReadinessClients, options: ReadinessOptions = {}) =>
  (_req: Request, res: Response): void => {
    if (!isServerReady() || !areReadinessChecksPassing(redis, options)) {
      res.status(503).send('NOT_READY');
      return;
    }
    res.status(200).send('OK');
  };

/** Per-worker readiness: a healthy sibling must not admit work to an initializing worker. */
export function createStartupReadiness(
  redis: RedisReadinessClients,
  options: ReadinessOptions = {},
): {
  handler: RequestHandler;
  gate: RequestHandler;
  markReady: () => void;
} {
  let initialized = false;
  const gate: RequestHandler = (_req, res, next) => {
    if (initialized && areReadinessChecksPassing(redis, options)) {
      next();
      return;
    }
    res.set('Retry-After', '1');
    res.status(503).json({
      code: 'SERVER_NOT_READY',
      error: 'Server is not ready. Please retry shortly.',
    });
  };
  return {
    handler: createReadinessHandler(() => initialized, redis, options),
    gate,
    markReady: () => {
      initialized = true;
    },
  };
}
