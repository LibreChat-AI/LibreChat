import type { RedisClientType } from '@redis/client';
import type { Request, Response } from 'express';
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

/**
 * `/readyz` handler: 503 until startup completes, and again whenever Redis is configured
 * but disconnected, so readiness-gated orchestration stops routing to a pod that cannot
 * serve authenticated traffic. `/livez` stays unconditional so a Redis blip does not
 * trigger a liveness restart loop.
 */
export const createReadinessHandler =
  (isServerReady: () => boolean, redis: RedisReadinessClients) =>
  (_req: Request, res: Response): void => {
    if (!isServerReady() || !isRedisReady(redis)) {
      res.status(503).send('NOT_READY');
      return;
    }
    res.status(200).send('OK');
  };
