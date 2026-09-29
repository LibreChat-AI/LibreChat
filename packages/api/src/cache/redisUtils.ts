import { logger } from '@librechat/data-schemas';
import type { ClusterOptions, RedisOptions, Cluster, Redis } from 'ioredis';
import type { RedisClientType, RedisClusterType } from '@redis/client';
import { startRedisHeartbeat } from './heartbeat';
import { cacheConfig } from './cacheConfig';

/**
 * Duplicates an ioredis connection with option overrides. `Cluster.duplicate` reads its
 * first argument as an optional startup-node list and its second as the overrides,
 * unlike `Redis.duplicate`, so options passed positionally to a cluster are silently
 * dropped and the duplicate quietly inherits the original's behaviour.
 */
export function duplicateIoRedisClient(
  client: Redis | Cluster,
  options: RedisOptions & ClusterOptions = {},
): Redis | Cluster {
  if (client.isCluster) {
    const duplicate = (client as Cluster).duplicate([], options);
    if (options.enableOfflineQueue !== false) {
      return duplicate;
    }
    let clusterHasBeenReady = duplicate.status === 'ready';
    duplicate.once('ready', () => {
      clusterHasBeenReady = true;
    });
    /** ioredis deliberately forces `enableOfflineQueue: true` on every Cluster node
     * after applying `redisOptions`. It needs that queue while a new node discovers
     * topology, so changing it at `+node` prevents the cluster from ever becoming
     * ready. Initial nodes switch once connected; nodes discovered after the cluster
     * was usable fail fast immediately, including during a slot-owner replacement. */
    const disableNodeOfflineQueue = (node: Redis): void => {
      const disable = (): void => {
        node.options.enableOfflineQueue = false;
      };
      if (node.status === 'ready' || clusterHasBeenReady) {
        disable();
      } else {
        node.once('ready', disable);
      }
    };
    duplicate.on('+node', disableNodeOfflineQueue);
    duplicate.nodes('all').forEach(disableNodeOfflineQueue);
    return duplicate;
  }
  return (client as Redis).duplicate(options);
}

/**
 * Duplicates a client for a dedicated pub/sub subscriber. `duplicate()` copies options but
 * not listeners, so a bare duplicate reports socket errors only through ioredis's
 * "Unhandled error event" and, between generations, carries no traffic at all: a peer
 * that vanishes without closing the socket stays undetected until the kernel gives up.
 * The heartbeat is the traffic the shared client gets for free.
 */
export function createIoRedisSubscriber(client: Redis | Cluster, label: string): Redis | Cluster {
  const subscriber = duplicateIoRedisClient(client);
  subscriber.on('error', (error: Error) => {
    logger.error(`${label} error:`, error);
  });
  subscriber.on('ready', () => {
    logger.info(`${label} ready`);
  });
  startRedisHeartbeat({
    client: subscriber,
    intervalMs: cacheConfig.REDIS_SUBSCRIBER_PING_INTERVAL * 1000,
    timeoutMs: cacheConfig.REDIS_PING_TIMEOUT,
    label,
  });
  return subscriber;
}

/**
 * Efficiently deletes multiple Redis keys with support for both cluster and single-node modes.
 *
 * - Cluster mode: Deletes keys in parallel chunks to avoid CROSSSLOT errors
 * - Single-node mode: Uses batch DEL commands for efficiency
 *
 * @param client - Redis client (node or cluster)
 * @param keys - Array of keys to delete
 * @param chunkSize - Optional chunk size (defaults to REDIS_DELETE_CHUNK_SIZE config)
 * @returns Number of keys deleted
 *
 * @example
 * ```typescript
 * const deletedCount = await batchDeleteKeys(keyvRedisClient, ['key1', 'key2', 'key3']);
 * console.log(`Deleted ${deletedCount} keys`);
 * ```
 */
export async function batchDeleteKeys(
  client: RedisClientType | RedisClusterType,
  keys: string[],
  chunkSize?: number,
): Promise<number> {
  const startTime = Date.now();

  if (keys.length === 0) {
    return 0;
  }

  const size = chunkSize ?? cacheConfig.REDIS_DELETE_CHUNK_SIZE;
  const clusterSafe = cacheConfig.USE_REDIS_CLUSTER || cacheConfig.REDIS_CLUSTER_SAFE_DELETE;
  let mode = 'single-node';

  if (cacheConfig.USE_REDIS_CLUSTER) {
    mode = 'cluster';
  } else if (cacheConfig.REDIS_CLUSTER_SAFE_DELETE) {
    mode = 'cluster-safe';
  }

  const deletePromises = [];

  if (clusterSafe) {
    // Cluster / cluster-safe mode: Delete each key individually in parallel chunks to avoid CROSSSLOT errors.
    // Also used when REDIS_CLUSTER_SAFE_DELETE=true for managed services like ElastiCache Serverless that
    // shard keys internally while presenting a single-node connection endpoint.
    for (let i = 0; i < keys.length; i += size) {
      const chunk = keys.slice(i, i + size);
      deletePromises.push(Promise.all(chunk.map((key) => client.del(key))));
    }
  } else {
    // Single-node mode: Batch delete chunks using DEL with array
    for (let i = 0; i < keys.length; i += size) {
      const chunk = keys.slice(i, i + size);
      deletePromises.push(client.del(chunk));
    }
  }

  const results = await Promise.all(deletePromises);

  // Sum up deleted counts (cluster returns array of individual counts, single-node returns total)
  const deletedCount = results.reduce((sum: number, count: number | number[]): number => {
    if (Array.isArray(count)) {
      return sum + count.reduce((a, b) => a + b, 0);
    }
    return sum + count;
  }, 0);

  // Performance monitoring
  const duration = Date.now() - startTime;
  const batchCount = deletePromises.length;

  if (duration > 1000) {
    logger.warn(
      `[Redis][batchDeleteKeys] Slow operation - Duration: ${duration}ms, Mode: ${mode}, Keys: ${keys.length}, Deleted: ${deletedCount}, Batches: ${batchCount}, Chunk size: ${size}`,
    );
  } else {
    logger.debug(
      `[Redis][batchDeleteKeys] Duration: ${duration}ms, Mode: ${mode}, Keys: ${keys.length}, Deleted: ${deletedCount}, Batches: ${batchCount}`,
    );
  }

  return deletedCount;
}

/**
 * Scans Redis for keys matching a pattern and collects them into an array.
 * Uses Redis SCAN to avoid blocking the server.
 *
 * @param client - Redis client (node or cluster) with scanIterator support
 * @param pattern - Pattern to match keys (e.g., 'user:*', 'session:*:active')
 * @param count - Optional SCAN COUNT hint (defaults to REDIS_SCAN_COUNT config)
 * @returns Array of matching keys
 *
 * @example
 * ```typescript
 * const userKeys = await scanKeys(keyvRedisClient, 'user:*');
 * const sessionKeys = await scanKeys(keyvRedisClient, 'session:*:active', 500);
 * ```
 */
export async function scanKeys(
  client: RedisClientType | RedisClusterType,
  pattern: string,
  count?: number,
): Promise<string[]> {
  const startTime = Date.now();
  const keys: string[] = [];

  // Type guard to check if client has scanIterator
  if (!('scanIterator' in client)) {
    throw new Error('Redis client does not support scanIterator');
  }

  const scanCount = count ?? cacheConfig.REDIS_SCAN_COUNT;

  for await (const page of client.scanIterator({
    MATCH: pattern,
    COUNT: scanCount,
  })) {
    keys.push(...page);
  }

  // Performance monitoring
  const duration = Date.now() - startTime;

  if (duration > 1000) {
    logger.warn(
      `[Redis][scanKeys] Slow operation - Duration: ${duration}ms, Pattern: "${pattern}", Keys found: ${keys.length}, Scan count: ${scanCount}`,
    );
  } else {
    logger.debug(
      `[Redis][scanKeys] Duration: ${duration}ms, Pattern: "${pattern}", Keys found: ${keys.length}`,
    );
  }

  return keys;
}
