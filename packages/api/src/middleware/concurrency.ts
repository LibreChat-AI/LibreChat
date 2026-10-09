import { logger } from '@librechat/data-schemas';
import { CacheKeys, Time, ViolationTypes } from 'librechat-data-provider';
import { standardCache, cacheConfig, instrumentIORedisClient, ioredisClient } from '~/cache';
import { isEnabled, math } from '~/utils';

const { USE_REDIS } = cacheConfig;

const LIMIT_CONCURRENT_MESSAGES = process.env.LIMIT_CONCURRENT_MESSAGES;
const CONCURRENT_MESSAGE_MAX = math(process.env.CONCURRENT_MESSAGE_MAX, 2);
const CONCURRENT_VIOLATION_SCORE = math(process.env.CONCURRENT_VIOLATION_SCORE, 1);

/**
 * Lua script for atomic check-and-increment.
 * Increments the key, sets TTL, and if over limit decrements back.
 * Returns positive count if allowed, negative count if rejected.
 * Single round-trip, fully atomic — eliminates the INCR/check/DECR race window.
 */
const CHECK_AND_INCREMENT_SCRIPT = `
local key = KEYS[1]
local limit = tonumber(ARGV[1])
local ttl = tonumber(ARGV[2])
local current = redis.call('INCR', key)
redis.call('EXPIRE', key, ttl)
if current > limit then
  redis.call('DECR', key)
  return -current
end
return current
`;

/**
 * Lua script for atomic decrement-and-cleanup.
 * Decrements the key and deletes it if the count reaches zero or below.
 * Eliminates the DECR-then-DEL race window.
 */
const DECREMENT_SCRIPT = `
local key = KEYS[1]
local current = redis.call('DECR', key)
if current <= 0 then
  redis.call('DEL', key)
  return 0
end
return current
`;

/** Lazily initialized cache for pending requests (used only for in-memory fallback) */
let pendingReqCache: ReturnType<typeof standardCache> | null = null;

/**
 * Get or create the pending requests cache for in-memory fallback.
 * Uses lazy initialization to avoid creating cache before app is ready.
 */
function getPendingReqCache(): ReturnType<typeof standardCache> | null {
  if (!isEnabled(LIMIT_CONCURRENT_MESSAGES)) {
    return null;
  }
  if (!pendingReqCache) {
    pendingReqCache = standardCache(CacheKeys.PENDING_REQ);
  }
  return pendingReqCache;
}

/**
 * Build the cache key for a user's pending requests.
 * Note: ioredisClient already has keyPrefix applied, so we only add namespace:userId
 */
function buildKey(userId: string): string {
  const namespace = CacheKeys.PENDING_REQ;
  return `${namespace}:${userId}`;
}

/**
 * Build the cache key for in-memory fallback (Keyv).
 */
function buildMemoryKey(userId: string): string {
  return `:${userId}`;
}

export interface PendingRequestResult {
  allowed: boolean;
  pendingRequests: number;
  limit: number;
}

export interface ViolationInfo {
  type: string;
  limit: number;
  pendingRequests: number;
  score: number;
}

/**
 * Check if a user can make a new concurrent request and increment the counter if allowed.
 * This is designed for resumable streams where the HTTP response lifecycle doesn't match
 * the actual request processing lifecycle.
 *
 * When Redis is available, uses atomic INCR to prevent race conditions.
 * Falls back to non-atomic get/set for in-memory cache.
 *
 * @param userId - The user's ID
 * @returns Object with `allowed` (boolean), `pendingRequests` (current count), and `limit`
 */
export async function checkAndIncrementPendingRequest(
  userId: string,
): Promise<PendingRequestResult> {
  const limit = Math.max(CONCURRENT_MESSAGE_MAX, 1);

  if (!isEnabled(LIMIT_CONCURRENT_MESSAGES)) {
    return { allowed: true, pendingRequests: 0, limit };
  }

  if (!userId) {
    logger.warn('[concurrency] checkAndIncrementPendingRequest called without userId');
    return { allowed: true, pendingRequests: 0, limit };
  }

  // Use atomic Lua script when Redis is available to prevent race conditions.
  // A single EVAL round-trip atomically increments, checks, and decrements if over-limit.
  if (USE_REDIS && ioredisClient) {
    const key = buildKey(userId);
    const redisClient = instrumentIORedisClient(ioredisClient, CacheKeys.PENDING_REQ);
    try {
      const result = (await redisClient.eval(
        CHECK_AND_INCREMENT_SCRIPT,
        1,
        key,
        limit,
        60,
      )) as number;

      if (result < 0) {
        // Negative return means over-limit (absolute value is the count before decrement)
        const count = -result;
        logger.debug(`[concurrency] User ${userId} exceeded concurrent limit: ${count}/${limit}`);
        return { allowed: false, pendingRequests: count, limit };
      }

      logger.debug(`[concurrency] User ${userId} incremented pending requests: ${result}/${limit}`);
      return { allowed: true, pendingRequests: result, limit };
    } catch (error) {
      logger.error('[concurrency] Redis atomic increment failed:', error);
      // On Redis error, allow the request to proceed (fail-open)
      return { allowed: true, pendingRequests: 0, limit };
    }
  }

  // Fallback: non-atomic in-memory cache (race condition possible but acceptable for in-memory)
  const cache = getPendingReqCache();
  if (!cache) {
    return { allowed: true, pendingRequests: 0, limit };
  }

  const key = buildMemoryKey(userId);
  const pendingRequests = +((await cache.get(key)) ?? 0);

  if (pendingRequests >= limit) {
    logger.debug(
      `[concurrency] User ${userId} exceeded concurrent limit: ${pendingRequests}/${limit}`,
    );
    return { allowed: false, pendingRequests, limit };
  }

  await cache.set(key, pendingRequests + 1, Time.ONE_MINUTE);
  logger.debug(
    `[concurrency] User ${userId} incremented pending requests: ${pendingRequests + 1}/${limit}`,
  );

  return { allowed: true, pendingRequests: pendingRequests + 1, limit };
}

/**
 * Decrement the pending request counter for a user.
 * Should be called when a generation job completes, errors, or is aborted.
 *
 * This function handles errors internally and will never throw - it's a cleanup
 * operation that should not interrupt the main flow if cache operations fail.
 *
 * When Redis is available, uses atomic DECR to prevent race conditions.
 * Falls back to non-atomic get/set for in-memory cache.
 *
 * @param userId - The user's ID
 */
export async function decrementPendingRequest(userId: string): Promise<void> {
  try {
    if (!isEnabled(LIMIT_CONCURRENT_MESSAGES)) {
      return;
    }

    if (!userId) {
      logger.warn('[concurrency] decrementPendingRequest called without userId');
      return;
    }

    // Use atomic Lua script to decrement and clean up zero/negative keys in one round-trip
    if (USE_REDIS && ioredisClient) {
      const key = buildKey(userId);
      const redisClient = instrumentIORedisClient(ioredisClient, CacheKeys.PENDING_REQ);
      try {
        const newCount = (await redisClient.eval(DECREMENT_SCRIPT, 1, key)) as number;
        if (newCount === 0) {
          logger.debug(`[concurrency] User ${userId} pending requests cleared`);
        } else {
          logger.debug(`[concurrency] User ${userId} decremented pending requests: ${newCount}`);
        }
      } catch (error) {
        logger.error('[concurrency] Redis atomic decrement failed:', error);
      }
      return;
    }

    // Fallback: non-atomic in-memory cache
    const cache = getPendingReqCache();
    if (!cache) {
      return;
    }

    const key = buildMemoryKey(userId);
    const currentReq = +((await cache.get(key)) ?? 0);

    if (currentReq >= 1) {
      await cache.set(key, currentReq - 1, Time.ONE_MINUTE);
      logger.debug(`[concurrency] User ${userId} decremented pending requests: ${currentReq - 1}`);
    } else {
      await cache.delete(key);
      logger.debug(`[concurrency] User ${userId} pending requests cleared (was ${currentReq})`);
    }
  } catch (error) {
    logger.error('[concurrency] Error decrementing pending request:', error);
  }
}

/**
 * Get violation info for logging purposes when a user exceeds the concurrent request limit.
 */
export function getViolationInfo(pendingRequests: number, limit: number): ViolationInfo {
  return {
    type: ViolationTypes.CONCURRENT,
    limit,
    pendingRequests,
    score: CONCURRENT_VIOLATION_SCORE,
  };
}

/**
 * Check if concurrent message limiting is enabled.
 */
export function isConcurrentLimitEnabled(): boolean {
  return isEnabled(LIMIT_CONCURRENT_MESSAGES);
}
