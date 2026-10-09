import IoRedis from 'ioredis';
import type { Redis, Cluster, RedisOptions } from 'ioredis';

export type RedisTestClient = Redis | Cluster;

/**
 * Build the same kind of ioredis client selected by the cache integration
 * workflow. In cluster mode REDIS_URI is a comma-separated seed list, which
 * must not be passed to the single-node Redis constructor as one URL.
 */
export function createRedisTestClient(keyPrefix: string): RedisTestClient {
  const urls = (process.env.REDIS_URI ?? 'redis://127.0.0.1:6379')
    .split(',')
    .map((uri) => new URL(uri));
  const [primary] = urls;
  const redisOptions: RedisOptions = {
    keyPrefix,
    maxRetriesPerRequest: 2,
    ...(primary.username !== '' && { username: primary.username }),
    ...(primary.password !== '' && { password: primary.password }),
    ...(primary.protocol === 'rediss:' && { tls: {} }),
  };

  if (process.env.USE_REDIS_CLUSTER === 'true' || urls.length > 1) {
    return new IoRedis.Cluster(
      urls.map((url) => ({
        host: url.hostname,
        port: Number.parseInt(url.port, 10) || 6379,
      })),
      { lazyConnect: true, redisOptions },
    );
  }

  return new IoRedis(primary.href, { ...redisOptions, lazyConnect: true });
}

/** Delete only this suite's keys, including keys spread across cluster masters. */
export async function clearRedisTestPrefix(
  redis: RedisTestClient,
  keyPrefix: string,
): Promise<void> {
  const nodes = (redis as Cluster).isCluster
    ? (redis as Cluster).nodes('master')
    : [redis as Redis];
  const physicalKeys = [
    ...new Set((await Promise.all(nodes.map((node) => node.keys('*')))).flat()),
  ];
  const logicalKeys = physicalKeys
    .filter((key) => key.startsWith(keyPrefix))
    .map((key) => key.slice(keyPrefix.length));

  await Promise.all(logicalKeys.map((key) => redis.del(key)));
}
