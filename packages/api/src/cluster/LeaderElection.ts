import { logger } from '@librechat/data-schemas';
import { instrumentIORedisClient, RedisUseCases } from '~/cache/redisTelemetry';
import { cacheConfig as cache } from '~/cache/cacheConfig';
import { ioredisClient } from '~/cache/redisClients';
import { clusterConfig as cluster } from './config';

/**
 * Distributed leader election implementation using Redis for coordination across multiple server instances.
 *
 * Leadership election:
 * - During bootup, every server attempts to become the leader by calling isLeader()
 * - Uses atomic Redis SET NX (set if not exists) to ensure only ONE server can claim leadership
 * - The first server to successfully set the key becomes the leader; others become followers
 * - Works with any number of servers (1 to infinite) - single server always becomes leader
 *
 * Leadership maintenance:
 * - Leader holds a key in Redis with a 25-second lease duration
 * - Leader renews this lease every 10 seconds to maintain leadership
 * - If leader crashes, the lease eventually expires, and the key disappears
 * - On shutdown, leader deletes its key to allow immediate re-election
 * - Followers check for leadership and attempt to claim it when the key is empty
 *
 * Uses ioredis (not @keyv/redis) for all lock operations. ioredis applies REDIS_KEY_PREFIX via
 * keyPrefix and correctly retries MOVED/ASK redirects on Redis Cluster for SET NX and Lua EVAL.
 * @keyv/redis EVAL has been observed to surface unhandled MOVED errors on cluster, leaving the
 * leadership key stuck after resign().
 */
export class LeaderElection {
  /**
   * Logical leadership key. ioredis prepends REDIS_KEY_PREFIX via its keyPrefix option,
   * so the on-wire key is `{REDIS_KEY_PREFIX}::LeadingServerUUID`.
   */
  static readonly LEADER_KEY: string = 'LeadingServerUUID';
  private static _instance = new LeaderElection();

  readonly UUID: string = crypto.randomUUID();
  private refreshTimer: NodeJS.Timeout | undefined = undefined;

  // DO NOT create new instances of this class directly.
  // Use the exported isLeader() function which uses a singleton instance.
  constructor() {
    if (LeaderElection._instance) return LeaderElection._instance;

    process.on('SIGTERM', () => this.resign());
    process.on('SIGINT', () => this.resign());
    LeaderElection._instance = this;
  }

  private static redis() {
    if (!ioredisClient) {
      throw new Error('Redis client is not initialized');
    }
    return instrumentIORedisClient(ioredisClient, RedisUseCases.LEADER_ELECTION);
  }

  /**
   * Checks if this instance is the current leader.
   * If no leader exists, waits upto 2 seconds (randomized to avoid thundering herd) then attempts self-election.
   * Always returns true in non-Redis mode (single-instance deployment).
   */
  public async isLeader(): Promise<boolean> {
    if (!cache.USE_REDIS) return true;

    try {
      const currentLeader = await LeaderElection.getLeaderUUID();
      // If we own the leadership lock, return true.
      // However, in case the leadership refresh retries have been exhausted, something has gone wrong.
      // This server is not considered the leader anymore, similar to a crash, to avoid split-brain scenario.
      if (currentLeader === this.UUID) return this.refreshTimer != null;
      if (currentLeader != null) return false; // someone holds leadership lock

      const delay = Math.random() * 2000;
      await new Promise((resolve) => setTimeout(resolve, delay));
      return await this.electSelf();
    } catch (error) {
      logger.error('Failed to check leadership status:', error);
      return false;
    }
  }

  /**
   * Steps down from leadership by stopping the refresh timer and releasing the leader key.
   * Atomically deletes the leader key (only if we still own it) so another server can become leader immediately.
   */
  public async resign(): Promise<void> {
    if (!cache.USE_REDIS) return;

    try {
      this.clearRefreshTimer();

      // Lua script for atomic check-and-delete (only delete if we still own it)
      const script = `
        if redis.call("get", KEYS[1]) == ARGV[1] then
          redis.call("del", KEYS[1])
        end
      `;

      await LeaderElection.redis().eval(script, 1, LeaderElection.LEADER_KEY, this.UUID);
    } catch (error) {
      logger.error('Failed to release leadership lock:', error);
    }
  }

  /**
   * Gets the UUID of the current leader from Redis.
   * Returns null if no leader exists or in non-Redis mode.
   * Useful for testing and observability.
   */
  public static async getLeaderUUID(): Promise<string | null> {
    if (!cache.USE_REDIS) return null;
    return await LeaderElection.redis().get(LeaderElection.LEADER_KEY);
  }

  /**
   * Clears the refresh timer to stop leadership maintenance.
   * Called when resigning or failing to refresh leadership.
   * Calling this directly to simulate a crash in testing.
   */
  public clearRefreshTimer(): void {
    clearInterval(this.refreshTimer);
    this.refreshTimer = undefined;
  }

  /**
   * Attempts to claim leadership using atomic Redis SET NX (set if not exists).
   * If successful, starts a refresh timer to maintain leadership by extending the lease duration.
   * The NX flag ensures only one server can become leader even if multiple attempt simultaneously.
   */
  private async electSelf(): Promise<boolean> {
    try {
      const result = await LeaderElection.redis().set(
        LeaderElection.LEADER_KEY,
        this.UUID,
        'EX',
        cluster.LEADER_LEASE_DURATION,
        'NX',
      );

      if (result !== 'OK') {
        return (await LeaderElection.getLeaderUUID()) === this.UUID && this.refreshTimer != null;
      }

      this.clearRefreshTimer();
      this.refreshTimer = setInterval(async () => {
        await this.renewLeadership();
      }, cluster.LEADER_RENEW_INTERVAL * 1000);
      this.refreshTimer.unref();

      return true;
    } catch (error) {
      logger.error('Leader election failed:', error);
      return false;
    }
  }

  /**
   * Renews leadership by extending the lease duration on the leader key.
   * Uses Lua script to atomically verify we still own the key before renewing (prevents race conditions).
   * If we've lost leadership (key was taken by another server), stops the refresh timer.
   * This is called every 10 seconds by the refresh timer.
   */
  private async renewLeadership(attempts: number = 1): Promise<void> {
    try {
      // Lua script for atomic check-and-renew
      const script = `
        if redis.call("get", KEYS[1]) == ARGV[1] then
          return redis.call("expire", KEYS[1], ARGV[2])
        else
          return 0
        end
      `;

      const result = await LeaderElection.redis().eval(
        script,
        1,
        LeaderElection.LEADER_KEY,
        this.UUID,
        cluster.LEADER_LEASE_DURATION.toString(),
      );

      if (result === 0) {
        logger.warn('Lost leadership, clearing refresh timer');
        this.clearRefreshTimer();
      }
    } catch (error) {
      logger.error(`Failed to renew leadership (attempts No.${attempts}):`, error);
      if (attempts <= cluster.LEADER_RENEW_ATTEMPTS) {
        await new Promise((resolve) =>
          setTimeout(resolve, cluster.LEADER_RENEW_RETRY_DELAY * 1000),
        );
        await this.renewLeadership(attempts + 1);
      } else {
        logger.error('Exceeded maximum attempts to renew leadership.');
        this.clearRefreshTimer();
      }
    }
  }
}

const defaultElection = new LeaderElection();
export const isLeader = (): Promise<boolean> => defaultElection.isLeader();
