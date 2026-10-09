import { logger } from '@librechat/data-schemas';
import type { Redis, Cluster } from 'ioredis';
import type { IJobStoreV2, IEventTransport } from './interfaces/IJobStore';
import { InMemoryEventTransport } from './implementations/InMemoryEventTransport';
import { RedisEventTransport } from './implementations/RedisEventTransport';
import { InMemoryJobStore } from './implementations/InMemoryJobStore';
import { RedisJobStore } from './implementations/RedisJobStore';
import { createIoRedisSubscriber } from '~/cache/redisUtils';
import { ioredisClient } from '~/cache/redisClients';
import { cacheConfig } from '~/cache/cacheConfig';

/**
 * Configuration for stream services (optional overrides)
 */
export interface StreamServicesConfig {
  /**
   * Override Redis detection. If not provided, uses cacheConfig.USE_REDIS.
   */
  useRedis?: boolean;

  /**
   * Override Redis client. If not provided, uses ioredisClient from cache.
   */
  redisClient?: Redis | Cluster | null;

  /**
   * Dedicated Redis client for pub/sub subscribing.
   * If not provided, will duplicate the main client.
   */
  redisSubscriber?: Redis | Cluster | null;

  /**
   * Options for in-memory job store
   */
  inMemoryOptions?: {
    ttlAfterComplete?: number;
    maxJobs?: number;
    staleJobTimeout?: number;
  };
}

/**
 * Stream services result
 */
export interface StreamServices {
  jobStore: IJobStoreV2;
  eventTransport: IEventTransport;
  isRedis: boolean;
}

/**
 * Create stream services (job store + event transport).
 *
 * Automatically detects Redis from cacheConfig.USE_REDIS_STREAMS and uses
 * the existing ioredisClient. Falls back to in-memory if Redis
 * is not configured or not available.
 *
 * USE_REDIS_STREAMS defaults to USE_REDIS if not explicitly set,
 * allowing users to disable Redis for streams while keeping it for other caches.
 *
 * @example Auto-detect (uses cacheConfig)
 * ```ts
 * const services = createStreamServices();
 * // Uses Redis if USE_REDIS_STREAMS=true (defaults to USE_REDIS), otherwise in-memory
 * ```
 *
 * @example Force in-memory
 * ```ts
 * const services = createStreamServices({ useRedis: false });
 * ```
 */
export function createStreamServices(config: StreamServicesConfig = {}): StreamServices {
  // Use provided config or fall back to cache config (USE_REDIS_STREAMS for stream-specific override)
  const useRedis = config.useRedis ?? cacheConfig.USE_REDIS_STREAMS;
  const redisClient = config.redisClient ?? ioredisClient;
  const { redisSubscriber, inMemoryOptions } = config;

  // Check if we should and can use Redis
  if (useRedis && redisClient) {
    try {
      // For subscribing, we need a dedicated connection
      // If subscriber not provided, duplicate the main client
      let subscriber = redisSubscriber;

      if (!subscriber && 'duplicate' in redisClient) {
        subscriber = createIoRedisSubscriber(redisClient, '[StreamServices] subscriber');
        logger.info('[StreamServices] Duplicated Redis client for subscriber');
      }

      if (!subscriber) {
        logger.warn('[StreamServices] No subscriber client available, falling back to in-memory');
        return createInMemoryServices(inMemoryOptions);
      }

      const jobStore = new RedisJobStore(redisClient);
      const eventTransport = new RedisEventTransport(redisClient, subscriber);

      logger.info('[StreamServices] Created Redis-backed stream services');

      return {
        jobStore,
        eventTransport,
        isRedis: true,
      };
    } catch (err) {
      logger.error(
        '[StreamServices] Failed to create Redis services, falling back to in-memory:',
        err,
      );
      return createInMemoryServices(inMemoryOptions);
    }
  }

  return createInMemoryServices(inMemoryOptions);
}

/**
 * Create in-memory stream services
 */
function createInMemoryServices(options?: StreamServicesConfig['inMemoryOptions']): StreamServices {
  const jobStore = new InMemoryJobStore({
    ttlAfterComplete: options?.ttlAfterComplete ?? 300000, // 5 minutes
    maxJobs: options?.maxJobs ?? 1000,
    // Failsafe for crashed/hung generations (mirrors RedisJobStore's running-job TTL).
    staleJobTimeout: options?.staleJobTimeout ?? 1_200_000, // 20 minutes
  });

  const eventTransport = new InMemoryEventTransport();

  logger.info('[StreamServices] Created in-memory stream services');

  return {
    jobStore,
    eventTransport,
    isRedis: false,
  };
}
