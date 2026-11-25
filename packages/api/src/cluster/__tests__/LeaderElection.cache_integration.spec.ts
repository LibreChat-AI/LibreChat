import { expect } from '@playwright/test';

describe('LeaderElection with Redis', () => {
  let LeaderElection: typeof import('../LeaderElection').LeaderElection;
  let instances: InstanceType<typeof import('../LeaderElection').LeaderElection>[] = [];
  let keyvRedisClient: Awaited<typeof import('~/cache/redisClients')>['keyvRedisClient'];
  let ioredisClient: Awaited<typeof import('~/cache/redisClients')>['ioredisClient'];

  const clearLeaderKey = async () => {
    // LeaderElection uses ioredis (keyPrefix applied). Match that client for cleanup.
    if (ioredisClient) {
      await ioredisClient.del(LeaderElection.LEADER_KEY);
    }
  };

  beforeAll(async () => {
    // Set up environment variables for Redis
    process.env.USE_REDIS = 'true';
    process.env.REDIS_URI = process.env.REDIS_URI ?? 'redis://127.0.0.1:6379';
    process.env.REDIS_KEY_PREFIX = 'LeaderElection-IntegrationTest';

    // Import modules after setting env vars
    const leaderElectionModule = await import('../LeaderElection');
    const redisClients = await import('~/cache/redisClients');

    LeaderElection = leaderElectionModule.LeaderElection;
    keyvRedisClient = redisClients.keyvRedisClient;
    ioredisClient = redisClients.ioredisClient;

    // Ensure Redis is connected (both clients; LeaderElection uses ioredis)
    if (!ioredisClient) {
      throw new Error('ioredis client is not initialized');
    }
    if (!keyvRedisClient) {
      throw new Error('Redis client is not initialized');
    }

    // Wait for connection and topology discovery to complete
    await redisClients.keyvRedisClientReady;
    const redis = ioredisClient;
    if (redis.status !== 'ready') {
      await new Promise<void>((resolve, reject) => {
        const onReady = () => {
          cleanup();
          resolve();
        };
        const onError = (err: Error) => {
          cleanup();
          reject(err);
        };
        const cleanup = () => {
          redis.off('ready', onReady);
          redis.off('error', onError);
        };
        redis.once('ready', onReady);
        redis.once('error', onError);
      });
    }

    // Increase max listeners to handle many instances in tests
    process.setMaxListeners(200);
  });

  beforeEach(async () => {
    await clearLeaderKey();
    new LeaderElection().clearRefreshTimer();
  });

  afterEach(async () => {
    try {
      await Promise.all(instances.map((instance) => instance.resign()));
    } finally {
      instances = [];
      await clearLeaderKey();
    }
  });

  afterAll(async () => {
    // Close both Redis clients to prevent hanging
    if (keyvRedisClient?.isOpen) await keyvRedisClient.disconnect();
    if (ioredisClient?.status === 'ready') await ioredisClient.quit();
  });

  describe('Test Case 1: Simulate shutdown of the leader', () => {
    it('should allow an instance to re-elect itself after resignation', async () => {
      const instance = new LeaderElection();
      instances.push(instance);

      // Instance becomes leader
      expect(await instance.isLeader()).toBe(true);
      expect(await LeaderElection.getLeaderUUID()).toBe(instance.UUID);

      // Leader resigns
      await instance.resign();

      // Verify leadership key is cleared after resignation
      expect(await LeaderElection.getLeaderUUID()).toBeNull();

      // Instance can re-elect itself after resignation
      expect(await instance.isLeader()).toBe(true);
      expect(await LeaderElection.getLeaderUUID()).toBe(instance.UUID);
    }, 15000);
  });

  describe('Test Case 2: Simulate crash of the leader', () => {
    it('should allow re-election after leader crashes (lease expires)', async () => {
      // Mock config with short lease duration
      const clusterConfigModule = await import('../config');
      const originalConfig = { ...clusterConfigModule.clusterConfig };

      // Override config values for this test
      Object.assign(clusterConfigModule.clusterConfig, {
        LEADER_LEASE_DURATION: 2,
        LEADER_RENEW_INTERVAL: 4,
      });

      try {
        // Create 1 instance with mocked config
        const instance = new LeaderElection();
        instances.push(instance);

        // Become leader
        expect(await instance.isLeader()).toBe(true);

        // Verify leader UUID is set
        expect(await LeaderElection.getLeaderUUID()).toBe(instance.UUID);

        // Simulate crash by clearing refresh timer
        instance.clearRefreshTimer();

        // The instance no longer considers itself leader even though it still holds the key
        expect(await LeaderElection.getLeaderUUID()).toBe(instance.UUID);
        expect(await instance.isLeader()).toBe(false);

        // Wait for lease to expire (3 seconds > 2 second lease)
        await new Promise((resolve) => setTimeout(resolve, 3000));

        // Verify leader UUID is null after lease expiration
        expect(await LeaderElection.getLeaderUUID()).toBeNull();
      } finally {
        // Restore original config values
        Object.assign(clusterConfigModule.clusterConfig, originalConfig);
      }
    }, 15000); // 15 second timeout
  });

  describe('Test Case 3: Stress testing', () => {
    it('reports ownership to concurrent callers of the same singleton', async () => {
      // The constructor returns the singleton, not ten independent replicas.
      instances = Array.from({ length: 10 }, () => new LeaderElection());

      // Call electSelf on all instances in parallel
      const results = await Promise.all(instances.map((instance) => instance['electSelf']()));

      // All callers observe the same process owning the lease.
      const successCount = results.filter((success) => success).length;
      expect(successCount).toBe(10);

      // Find the winning instance
      const winnerInstance = instances.find((_, index) => results[index]);

      // Verify getLeaderUUID matches the winner's UUID
      expect(await LeaderElection.getLeaderUUID()).toBe(winnerInstance?.UUID);
    }, 15000); // 15 second timeout
  });
});

describe('LeaderElection without Redis', () => {
  let LeaderElection: typeof import('../LeaderElection').LeaderElection;
  let instances: InstanceType<typeof import('../LeaderElection').LeaderElection>[] = [];

  beforeAll(async () => {
    // Set up environment variables for non-Redis mode
    process.env.USE_REDIS = 'false';

    // Reset all modules to force re-evaluation with new env vars
    jest.resetModules();

    // Import modules after setting env vars and resetting modules
    const leaderElectionModule = await import('../LeaderElection');
    LeaderElection = leaderElectionModule.LeaderElection;
  });

  afterEach(async () => {
    await Promise.all(instances.map((instance) => instance.resign()));
    instances = [];
  });

  afterAll(() => {
    // Restore environment variables
    process.env.USE_REDIS = 'true';

    // Reset all modules to ensure next test runs get fresh imports
    jest.resetModules();
  });

  it('should allow all instances to be leaders when USE_REDIS is false', async () => {
    // Create 10 instances
    instances = Array.from({ length: 10 }, () => new LeaderElection());

    // Call isLeader on all instances
    const results = await Promise.all(instances.map((instance) => instance.isLeader()));

    // Verify all instances report themselves as leaders
    expect(results.every((isLeader) => isLeader)).toBe(true);
    expect(results.filter((isLeader) => isLeader).length).toBe(10);
  });

  it('should return null for getLeaderUUID when USE_REDIS is false', async () => {
    // Create a few instances
    instances = Array.from({ length: 3 }, () => new LeaderElection());

    // Call isLeader on all instances to make them "leaders"
    await Promise.all(instances.map((instance) => instance.isLeader()));

    // Verify getLeaderUUID returns null in non-Redis mode
    expect(await LeaderElection.getLeaderUUID()).toBeNull();
  });

  it('should allow resign() to be called without throwing errors', async () => {
    // Create multiple instances
    instances = Array.from({ length: 5 }, () => new LeaderElection());

    // Make them all leaders
    await Promise.all(instances.map((instance) => instance.isLeader()));

    // Call resign on all instances - should not throw
    await expect(
      Promise.all(instances.map((instance) => instance.resign())),
    ).resolves.not.toThrow();

    // Verify they're still leaders after resigning (since there's no shared state)
    const results = await Promise.all(instances.map((instance) => instance.isLeader()));
    expect(results.every((isLeader) => isLeader)).toBe(true);
  });
});
