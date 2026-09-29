import { readFileSync, existsSync } from 'fs';
import { logger } from '@librechat/data-schemas';
import { Time, CacheKeys } from 'librechat-data-provider';
import { math, isEnabled } from '~/utils';

// To ensure that different deployments do not interfere with each other's cache, we use a prefix for the Redis keys.
// This prefix is usually the deployment ID, which is often passed to the container or pod as an env var.
// Set REDIS_KEY_PREFIX_VAR to the env var that contains the deployment ID.
const REDIS_KEY_PREFIX_VAR = process.env.REDIS_KEY_PREFIX_VAR;
const REDIS_KEY_PREFIX = process.env.REDIS_KEY_PREFIX;
if (REDIS_KEY_PREFIX_VAR && REDIS_KEY_PREFIX) {
  throw new Error('Only either REDIS_KEY_PREFIX_VAR or REDIS_KEY_PREFIX can be set.');
}

const USE_REDIS = isEnabled(process.env.USE_REDIS);
if (USE_REDIS && !process.env.REDIS_URI) {
  throw new Error('USE_REDIS is enabled but REDIS_URI is not set.');
}

// USE_REDIS_STREAMS controls whether Redis is used for resumable stream job storage.
// Defaults to true if USE_REDIS is enabled but USE_REDIS_STREAMS is not explicitly set.
// Set to 'false' to use in-memory storage for streams while keeping Redis for other caches.
const USE_REDIS_STREAMS =
  process.env.USE_REDIS_STREAMS !== undefined
    ? isEnabled(process.env.USE_REDIS_STREAMS)
    : USE_REDIS;

// Comma-separated list of cache namespaces that should be forced to use in-memory storage
// even when Redis is enabled. This allows selective performance optimization for specific caches.
// Defaults to CONFIG_STORE,APP_CONFIG so YAML-derived config stays per-container.
// Set to empty string to force all namespaces through Redis.
const FORCED_IN_MEMORY_CACHE_NAMESPACES =
  process.env.FORCED_IN_MEMORY_CACHE_NAMESPACES !== undefined
    ? process.env.FORCED_IN_MEMORY_CACHE_NAMESPACES.split(',')
        .map((key) => key.trim())
        .filter(Boolean)
    : [CacheKeys.CONFIG_STORE, CacheKeys.APP_CONFIG];

// Validate against CacheKeys enum
if (FORCED_IN_MEMORY_CACHE_NAMESPACES.length > 0) {
  const validKeys = Object.values(CacheKeys) as string[];
  const invalidKeys = FORCED_IN_MEMORY_CACHE_NAMESPACES.filter((key) => !validKeys.includes(key));

  if (invalidKeys.length > 0) {
    throw new Error(
      `Invalid cache keys in FORCED_IN_MEMORY_CACHE_NAMESPACES: ${invalidKeys.join(', ')}. Valid keys: ${validKeys.join(', ')}`,
    );
  }
}

// Violation scores expire after this long without new violations; every violation write
// restarts the countdown. Non-positive values disable expiry, restoring the legacy
// accumulate-forever behavior.
const VIOLATION_SCORE_TTL_MS = math(process.env.VIOLATION_SCORE_TTL, Time.ONE_HOUR);
const VIOLATION_SCORE_TTL = VIOLATION_SCORE_TTL_MS > 0 ? VIOLATION_SCORE_TTL_MS : undefined;

/** Helper function to safely read Redis CA certificate from file
 * @returns {string|null} The contents of the CA certificate file, or null if not set or on error
 */
const getRedisCA = (): string | null => {
  const caPath = process.env.REDIS_CA;
  if (!caPath) {
    return null;
  }

  try {
    if (existsSync(caPath)) {
      return readFileSync(caPath, 'utf8');
    } else {
      logger.warn(`Redis CA certificate file not found: ${caPath}`);
      return null;
    }
  } catch (error) {
    logger.error(`Failed to read Redis CA certificate file '${caPath}':`, error);
    return null;
  }
};

const cacheConfig: {
  FORCED_IN_MEMORY_CACHE_NAMESPACES: string[];
  USE_REDIS: boolean;
  USE_REDIS_STREAMS: boolean;
  REDIS_URI: string | undefined;
  REDIS_USERNAME: string | undefined;
  REDIS_PASSWORD: string | undefined;
  REDIS_CA: string | null;
  REDIS_KEY_PREFIX: string;
  GLOBAL_PREFIX_SEPARATOR: string;
  REDIS_MAX_LISTENERS: number;
  REDIS_PING_INTERVAL: number;
  /** Milliseconds a heartbeat PING may go unanswered before the socket is presumed dead */
  REDIS_PING_TIMEOUT: number;
  /** Heartbeat interval in seconds for dedicated pub/sub subscriber connections (0 = disabled) */
  REDIS_SUBSCRIBER_PING_INTERVAL: number;
  /** TCP keepalive idle delay in ms for ioredis sockets (0 = kernel default idle time) */
  REDIS_KEEP_ALIVE: number;
  /** Max delay between reconnection attempts in ms */
  REDIS_RETRY_MAX_DELAY: number;
  /** Max number of reconnection attempts (0 = infinite) */
  REDIS_RETRY_MAX_ATTEMPTS: number;
  /** Connection timeout in ms */
  REDIS_CONNECT_TIMEOUT: number;
  /** Min spacing in ms between reconnects forced by READONLY replies after a failover */
  REDIS_READONLY_RECOVERY_INTERVAL: number;
  /** Queue commands when disconnected */
  REDIS_ENABLE_OFFLINE_QUEUE: boolean;
  /** flag to modify redis connection by adding dnsLookup this is required when connecting to elasticache for ioredis
   * see "Special Note: Aws Elasticache Clusters with TLS" on this webpage:  https://www.npmjs.com/package/ioredis **/
  REDIS_USE_ALTERNATIVE_DNS_LOOKUP: boolean;
  /** Enable redis cluster without the need of multiple URIs */
  USE_REDIS_CLUSTER: boolean;
  /**
   * Force cluster-safe (key-by-key) deletion even when connecting as a single-node Redis instance.
   * Needed for managed services like ElastiCache Serverless that present a single endpoint
   * but shard keys internally, causing CROSSSLOT errors on multi-key DEL commands.
   * Has no effect when USE_REDIS_CLUSTER is already true.
   */
  REDIS_CLUSTER_SAFE_DELETE: boolean;
  CI: boolean;
  DEBUG_MEMORY_CACHE: boolean;
  BAN_DURATION: number; // 2 hours
  /**
   * TTL in ms for violation scores: a score expires after this long without new violations
   * (each violation write restarts the countdown). `undefined` — from a non-positive
   * setting — disables expiry so scores accumulate forever.
   * @default 3600000 (1 hour)
   */
  VIOLATION_SCORE_TTL: number | undefined;
  /**
   * Number of keys to delete in each batch during Redis DEL operations.
   * In cluster mode, keys are deleted individually in parallel chunks to avoid CROSSSLOT errors.
   * In single-node mode, keys are deleted in batches using DEL with arrays.
   * Lower values reduce memory usage but increase number of Redis calls.
   * @default 1000
   */
  REDIS_DELETE_CHUNK_SIZE: number;
  /**
   * Number of keys to update in each batch during Redis SET operations.
   * In cluster mode, keys are updated individually in parallel chunks to avoid CROSSSLOT errors.
   * In single-node mode, keys are updated in batches using transactions (multi/exec).
   * Lower values reduce memory usage but increase number of Redis calls.
   * @default 1000
   */
  REDIS_UPDATE_CHUNK_SIZE: number;
  /**
   * COUNT hint for Redis SCAN operations when scanning keys by pattern.
   * This is a hint to Redis about how many keys to scan in each iteration.
   * Higher values can reduce round trips but increase memory usage and latency per call.
   * Note: Redis may return more or fewer keys than this count depending on internal heuristics.
   * @default 1000
   */
  REDIS_SCAN_COUNT: number;
  /**
   * TTL in milliseconds for MCP registry caches. Used by both:
   * - `MCPServersRegistry` read-through caches (`readThroughCache`/`readThroughCacheAll`)
   * - `ServerConfigsCacheRedisAggregateKey` local snapshot (avoids redundant Redis GETs)
   *
   * Both layers use this value, so the effective max cross-instance staleness is up
   * to 2× this value in multi-instance deployments. Set to 0 to disable the local
   * snapshot entirely (every `getAll()` hits Redis directly).
   * @default 5000 (5 seconds)
   */
  MCP_REGISTRY_CACHE_TTL: number;
} = {
  FORCED_IN_MEMORY_CACHE_NAMESPACES,
  USE_REDIS,
  USE_REDIS_STREAMS,
  REDIS_URI: process.env.REDIS_URI,
  REDIS_USERNAME: process.env.REDIS_USERNAME,
  REDIS_PASSWORD: process.env.REDIS_PASSWORD,
  REDIS_CA: getRedisCA(),
  REDIS_KEY_PREFIX: process.env[REDIS_KEY_PREFIX_VAR ?? ''] || REDIS_KEY_PREFIX || '',
  GLOBAL_PREFIX_SEPARATOR: '::',
  REDIS_MAX_LISTENERS: math(process.env.REDIS_MAX_LISTENERS, 40),
  REDIS_PING_INTERVAL: math(process.env.REDIS_PING_INTERVAL, 0),
  /** Milliseconds a heartbeat PING may go unanswered before the socket is presumed dead */
  REDIS_PING_TIMEOUT: math(process.env.REDIS_PING_TIMEOUT, 5000),
  /** Heartbeat interval in seconds for dedicated pub/sub subscriber connections (0 = disabled) */
  REDIS_SUBSCRIBER_PING_INTERVAL: math(process.env.REDIS_SUBSCRIBER_PING_INTERVAL, 15),
  /** TCP keepalive idle delay in ms for ioredis sockets (0 = kernel default idle time) */
  REDIS_KEEP_ALIVE: math(process.env.REDIS_KEEP_ALIVE, 10000),
  /** Max delay between reconnection attempts in ms */
  REDIS_RETRY_MAX_DELAY: math(process.env.REDIS_RETRY_MAX_DELAY, 3000),
  /** Max number of reconnection attempts (0 = infinite) */
  REDIS_RETRY_MAX_ATTEMPTS: math(process.env.REDIS_RETRY_MAX_ATTEMPTS, 10),
  /** Connection timeout in ms */
  REDIS_CONNECT_TIMEOUT: math(process.env.REDIS_CONNECT_TIMEOUT, 10000),
  /** Min spacing in ms between reconnects forced by READONLY replies after a failover */
  REDIS_READONLY_RECOVERY_INTERVAL: math(process.env.REDIS_READONLY_RECOVERY_INTERVAL, 5000),
  /** Queue commands when disconnected */
  REDIS_ENABLE_OFFLINE_QUEUE: isEnabled(process.env.REDIS_ENABLE_OFFLINE_QUEUE ?? 'true'),
  /** flag to modify redis connection by adding dnsLookup this is required when connecting to elasticache for ioredis
   * see "Special Note: Aws Elasticache Clusters with TLS" on this webpage:  https://www.npmjs.com/package/ioredis **/
  REDIS_USE_ALTERNATIVE_DNS_LOOKUP: isEnabled(process.env.REDIS_USE_ALTERNATIVE_DNS_LOOKUP),
  /** Enable redis cluster without the need of multiple URIs */
  USE_REDIS_CLUSTER: isEnabled(process.env.USE_REDIS_CLUSTER ?? 'false'),
  /**
   * Force cluster-safe (key-by-key) deletion even when connecting as a single-node Redis instance.
   * Needed for managed services like ElastiCache Serverless that present a single endpoint
   * but shard keys internally, causing CROSSSLOT errors on multi-key DEL commands.
   * Has no effect when USE_REDIS_CLUSTER is already true.
   */
  REDIS_CLUSTER_SAFE_DELETE: isEnabled(process.env.REDIS_CLUSTER_SAFE_DELETE ?? 'false'),
  CI: isEnabled(process.env.CI),
  DEBUG_MEMORY_CACHE: isEnabled(process.env.DEBUG_MEMORY_CACHE),

  BAN_DURATION: math(process.env.BAN_DURATION, 7200000), // 2 hours
  VIOLATION_SCORE_TTL,

  /**
   * Number of keys to delete in each batch during Redis DEL operations.
   * In cluster mode, keys are deleted individually in parallel chunks to avoid CROSSSLOT errors.
   * In single-node mode, keys are deleted in batches using DEL with arrays.
   * Lower values reduce memory usage but increase number of Redis calls.
   * @default 1000
   */
  REDIS_DELETE_CHUNK_SIZE: math(process.env.REDIS_DELETE_CHUNK_SIZE, 1000),

  /**
   * Number of keys to update in each batch during Redis SET operations.
   * In cluster mode, keys are updated individually in parallel chunks to avoid CROSSSLOT errors.
   * In single-node mode, keys are updated in batches using transactions (multi/exec).
   * Lower values reduce memory usage but increase number of Redis calls.
   * @default 1000
   */
  REDIS_UPDATE_CHUNK_SIZE: math(process.env.REDIS_UPDATE_CHUNK_SIZE, 1000),

  /**
   * COUNT hint for Redis SCAN operations when scanning keys by pattern.
   * This is a hint to Redis about how many keys to scan in each iteration.
   * Higher values can reduce round trips but increase memory usage and latency per call.
   * Note: Redis may return more or fewer keys than this count depending on internal heuristics.
   * @default 1000
   */
  REDIS_SCAN_COUNT: math(process.env.REDIS_SCAN_COUNT, 1000),

  /**
   * TTL in milliseconds for MCP registry caches. Used by both:
   * - `MCPServersRegistry` read-through caches (`readThroughCache`/`readThroughCacheAll`)
   * - `ServerConfigsCacheRedisAggregateKey` local snapshot (avoids redundant Redis GETs)
   *
   * Both layers use this value, so the effective max cross-instance staleness is up
   * to 2× this value in multi-instance deployments. Set to 0 to disable the local
   * snapshot entirely (every `getAll()` hits Redis directly).
   * @default 5000 (5 seconds)
   */
  MCP_REGISTRY_CACHE_TTL: math(process.env.MCP_REGISTRY_CACHE_TTL, 5000),
};

export { cacheConfig };
