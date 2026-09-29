describe('cacheConfig', () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };

    // Clear all related env vars first
    delete process.env.REDIS_URI;
    delete process.env.REDIS_CA;
    delete process.env.REDIS_KEY_PREFIX_VAR;
    delete process.env.REDIS_KEY_PREFIX;
    delete process.env.USE_REDIS;
    delete process.env.USE_REDIS_STREAMS;
    delete process.env.USE_REDIS_CLUSTER;
    delete process.env.REDIS_CLUSTER_SAFE_DELETE;
    delete process.env.REDIS_PING_INTERVAL;
    delete process.env.REDIS_PING_TIMEOUT;
    delete process.env.REDIS_SUBSCRIBER_PING_INTERVAL;
    delete process.env.REDIS_KEEP_ALIVE;
    delete process.env.FORCED_IN_MEMORY_CACHE_NAMESPACES;
    delete process.env.VIOLATION_SCORE_TTL;

    // Clear module cache
    jest.resetModules();
  });

  afterEach(() => {
    process.env = originalEnv;
    jest.resetModules();
  });

  describe('REDIS_KEY_PREFIX validation and resolution', () => {
    test('should throw error when both REDIS_KEY_PREFIX_VAR and REDIS_KEY_PREFIX are set', async () => {
      process.env.REDIS_KEY_PREFIX_VAR = 'DEPLOYMENT_ID';
      process.env.REDIS_KEY_PREFIX = 'manual-prefix';

      await expect(async () => {
        await import('../cacheConfig');
      }).rejects.toThrow('Only either REDIS_KEY_PREFIX_VAR or REDIS_KEY_PREFIX can be set.');
    });

    test('should resolve REDIS_KEY_PREFIX from variable reference', async () => {
      process.env.REDIS_KEY_PREFIX_VAR = 'DEPLOYMENT_ID';
      process.env.DEPLOYMENT_ID = 'test-deployment-123';

      const { cacheConfig } = await import('../cacheConfig');
      expect(cacheConfig.REDIS_KEY_PREFIX).toBe('test-deployment-123');
    });

    test('should use direct REDIS_KEY_PREFIX value', async () => {
      process.env.REDIS_KEY_PREFIX = 'direct-prefix';

      const { cacheConfig } = await import('../cacheConfig');
      expect(cacheConfig.REDIS_KEY_PREFIX).toBe('direct-prefix');
    });

    test('should default to empty string when no prefix is configured', async () => {
      const { cacheConfig } = await import('../cacheConfig');
      expect(cacheConfig.REDIS_KEY_PREFIX).toBe('');
    });

    test('should handle empty variable reference', async () => {
      process.env.REDIS_KEY_PREFIX_VAR = 'EMPTY_VAR';
      process.env.EMPTY_VAR = '';

      const { cacheConfig } = await import('../cacheConfig');
      expect(cacheConfig.REDIS_KEY_PREFIX).toBe('');
    });

    test('should handle undefined variable reference', async () => {
      process.env.REDIS_KEY_PREFIX_VAR = 'UNDEFINED_VAR';

      const { cacheConfig } = await import('../cacheConfig');
      expect(cacheConfig.REDIS_KEY_PREFIX).toBe('');
    });
  });

  describe('USE_REDIS and REDIS_URI validation', () => {
    test('should throw error when USE_REDIS is enabled but REDIS_URI is not set', async () => {
      process.env.USE_REDIS = 'true';

      await expect(async () => {
        await import('../cacheConfig');
      }).rejects.toThrow('USE_REDIS is enabled but REDIS_URI is not set.');
    });

    test('should not throw error when USE_REDIS is enabled and REDIS_URI is set', async () => {
      process.env.USE_REDIS = 'true';
      process.env.REDIS_URI = 'redis://localhost:6379';

      const importModule = async () => {
        await import('../cacheConfig');
      };
      await expect(importModule()).resolves.not.toThrow();
    });

    test('should handle empty REDIS_URI when USE_REDIS is enabled', async () => {
      process.env.USE_REDIS = 'true';
      process.env.REDIS_URI = '';

      await expect(async () => {
        await import('../cacheConfig');
      }).rejects.toThrow('USE_REDIS is enabled but REDIS_URI is not set.');
    });
  });

  describe('USE_REDIS_CLUSTER configuration', () => {
    test('should default to false when USE_REDIS_CLUSTER is not set', async () => {
      const { cacheConfig } = await import('../cacheConfig');
      expect(cacheConfig.USE_REDIS_CLUSTER).toBe(false);
    });

    test('should be false when USE_REDIS_CLUSTER is set to false', async () => {
      process.env.USE_REDIS_CLUSTER = 'false';

      const { cacheConfig } = await import('../cacheConfig');
      expect(cacheConfig.USE_REDIS_CLUSTER).toBe(false);
    });

    test('should be true when USE_REDIS_CLUSTER is set to true', async () => {
      process.env.USE_REDIS_CLUSTER = 'true';

      const { cacheConfig } = await import('../cacheConfig');
      expect(cacheConfig.USE_REDIS_CLUSTER).toBe(true);
    });

    test('should work with USE_REDIS enabled and REDIS_URI set', async () => {
      process.env.USE_REDIS_CLUSTER = 'true';
      process.env.USE_REDIS = 'true';
      process.env.REDIS_URI = 'redis://localhost:6379';

      const { cacheConfig } = await import('../cacheConfig');
      expect(cacheConfig.USE_REDIS_CLUSTER).toBe(true);
      expect(cacheConfig.USE_REDIS).toBe(true);
      expect(cacheConfig.REDIS_URI).toBe('redis://localhost:6379');
    });
  });

  describe('REDIS_CLUSTER_SAFE_DELETE configuration', () => {
    test('should default to false when REDIS_CLUSTER_SAFE_DELETE is not set', async () => {
      const { cacheConfig } = await import('../cacheConfig');
      expect(cacheConfig.REDIS_CLUSTER_SAFE_DELETE).toBe(false);
    });

    test('should be false when REDIS_CLUSTER_SAFE_DELETE is set to false', async () => {
      process.env.REDIS_CLUSTER_SAFE_DELETE = 'false';

      const { cacheConfig } = await import('../cacheConfig');
      expect(cacheConfig.REDIS_CLUSTER_SAFE_DELETE).toBe(false);
    });

    test('should be true when REDIS_CLUSTER_SAFE_DELETE is set to true', async () => {
      process.env.REDIS_CLUSTER_SAFE_DELETE = 'true';

      const { cacheConfig } = await import('../cacheConfig');
      expect(cacheConfig.REDIS_CLUSTER_SAFE_DELETE).toBe(true);
    });
  });

  describe('USE_REDIS_STREAMS configuration', () => {
    test('should default to USE_REDIS value when USE_REDIS_STREAMS is not set', async () => {
      process.env.USE_REDIS = 'true';
      process.env.REDIS_URI = 'redis://localhost:6379';

      const { cacheConfig } = await import('../cacheConfig');
      expect(cacheConfig.USE_REDIS).toBe(true);
      expect(cacheConfig.USE_REDIS_STREAMS).toBe(true);
    });

    test('should default to false when both USE_REDIS and USE_REDIS_STREAMS are not set', async () => {
      const { cacheConfig } = await import('../cacheConfig');
      expect(cacheConfig.USE_REDIS).toBe(false);
      expect(cacheConfig.USE_REDIS_STREAMS).toBe(false);
    });

    test('should be false when explicitly set to false even if USE_REDIS is true', async () => {
      process.env.USE_REDIS = 'true';
      process.env.USE_REDIS_STREAMS = 'false';
      process.env.REDIS_URI = 'redis://localhost:6379';

      const { cacheConfig } = await import('../cacheConfig');
      expect(cacheConfig.USE_REDIS).toBe(true);
      expect(cacheConfig.USE_REDIS_STREAMS).toBe(false);
    });

    test('should be true when explicitly set to true', async () => {
      process.env.USE_REDIS = 'true';
      process.env.USE_REDIS_STREAMS = 'true';
      process.env.REDIS_URI = 'redis://localhost:6379';

      const { cacheConfig } = await import('../cacheConfig');
      expect(cacheConfig.USE_REDIS_STREAMS).toBe(true);
    });

    test('should allow streams without general Redis (explicit override)', async () => {
      // Edge case: someone might want streams with Redis but not general caching
      // This would require REDIS_URI but not USE_REDIS
      process.env.USE_REDIS_STREAMS = 'true';
      process.env.REDIS_URI = 'redis://localhost:6379';

      const { cacheConfig } = await import('../cacheConfig');
      expect(cacheConfig.USE_REDIS).toBe(false);
      expect(cacheConfig.USE_REDIS_STREAMS).toBe(true);
    });
  });

  describe('REDIS_CA file reading', () => {
    test('should be null when REDIS_CA is not set', async () => {
      const { cacheConfig } = await import('../cacheConfig');
      expect(cacheConfig.REDIS_CA).toBeNull();
    });
  });

  describe('REDIS_PING_INTERVAL configuration', () => {
    test('should default to 0 when REDIS_PING_INTERVAL is not set', async () => {
      const { cacheConfig } = await import('../cacheConfig');
      expect(cacheConfig.REDIS_PING_INTERVAL).toBe(0);
    });

    test('should use provided REDIS_PING_INTERVAL value', async () => {
      process.env.REDIS_PING_INTERVAL = '300';

      const { cacheConfig } = await import('../cacheConfig');
      expect(cacheConfig.REDIS_PING_INTERVAL).toBe(300);
    });
  });

  describe('Redis dead-socket detection configuration', () => {
    test('defaults the heartbeat deadline, subscriber interval, and keepalive', async () => {
      const { cacheConfig } = await import('../cacheConfig');
      expect(cacheConfig.REDIS_PING_TIMEOUT).toBe(5000);
      expect(cacheConfig.REDIS_SUBSCRIBER_PING_INTERVAL).toBe(15);
      expect(cacheConfig.REDIS_KEEP_ALIVE).toBe(10000);
    });

    test('reads the provided values, including zero to disable', async () => {
      process.env.REDIS_PING_TIMEOUT = '2500';
      process.env.REDIS_SUBSCRIBER_PING_INTERVAL = '0';
      process.env.REDIS_KEEP_ALIVE = '0';

      const { cacheConfig } = await import('../cacheConfig');
      expect(cacheConfig.REDIS_PING_TIMEOUT).toBe(2500);
      expect(cacheConfig.REDIS_SUBSCRIBER_PING_INTERVAL).toBe(0);
      expect(cacheConfig.REDIS_KEEP_ALIVE).toBe(0);
    });
  });

  describe('FORCED_IN_MEMORY_CACHE_NAMESPACES validation', () => {
    test('should parse comma-separated cache keys correctly', async () => {
      process.env.FORCED_IN_MEMORY_CACHE_NAMESPACES = ' ROLES, MESSAGES ';

      const { cacheConfig } = await import('../cacheConfig');
      expect(cacheConfig.FORCED_IN_MEMORY_CACHE_NAMESPACES).toEqual(['ROLES', 'MESSAGES']);
    });

    test('should throw error for invalid cache keys', async () => {
      process.env.FORCED_IN_MEMORY_CACHE_NAMESPACES = 'INVALID_KEY,ROLES';

      await expect(async () => {
        await import('../cacheConfig');
      }).rejects.toThrow('Invalid cache keys in FORCED_IN_MEMORY_CACHE_NAMESPACES: INVALID_KEY');
    });

    test('should produce empty array when set to empty string (opt out of defaults)', async () => {
      process.env.FORCED_IN_MEMORY_CACHE_NAMESPACES = '';

      const { cacheConfig } = await import('../cacheConfig');
      expect(cacheConfig.FORCED_IN_MEMORY_CACHE_NAMESPACES).toEqual([]);
    });

    test('should default to CONFIG_STORE and APP_CONFIG when env var is not set', async () => {
      const { cacheConfig } = await import('../cacheConfig');
      expect(cacheConfig.FORCED_IN_MEMORY_CACHE_NAMESPACES).toEqual(['CONFIG_STORE', 'APP_CONFIG']);
    });

    test('should accept TOOL_CACHE as a valid namespace', async () => {
      process.env.FORCED_IN_MEMORY_CACHE_NAMESPACES = 'TOOL_CACHE';

      const { cacheConfig } = await import('../cacheConfig');
      expect(cacheConfig.FORCED_IN_MEMORY_CACHE_NAMESPACES).toEqual(['TOOL_CACHE']);
    });

    test('should accept CONFIG_STORE and APP_CONFIG together for blue/green deployments', async () => {
      process.env.FORCED_IN_MEMORY_CACHE_NAMESPACES = 'CONFIG_STORE,APP_CONFIG';

      const { cacheConfig } = await import('../cacheConfig');
      expect(cacheConfig.FORCED_IN_MEMORY_CACHE_NAMESPACES).toEqual(['CONFIG_STORE', 'APP_CONFIG']);
    });
  });

  describe('VIOLATION_SCORE_TTL configuration', () => {
    test('should default to one hour when not set', async () => {
      const { cacheConfig } = await import('../cacheConfig');
      expect(cacheConfig.VIOLATION_SCORE_TTL).toBe(3600000);
    });

    test('should evaluate math expressions from the environment', async () => {
      process.env.VIOLATION_SCORE_TTL = '1000 * 60 * 60 * 24';

      const { cacheConfig } = await import('../cacheConfig');
      expect(cacheConfig.VIOLATION_SCORE_TTL).toBe(86400000);
    });

    test('should disable expiry when set to 0', async () => {
      process.env.VIOLATION_SCORE_TTL = '0';

      const { cacheConfig } = await import('../cacheConfig');
      expect(cacheConfig.VIOLATION_SCORE_TTL).toBeUndefined();
    });

    test('should disable expiry for negative values', async () => {
      process.env.VIOLATION_SCORE_TTL = '-1000';

      const { cacheConfig } = await import('../cacheConfig');
      expect(cacheConfig.VIOLATION_SCORE_TTL).toBeUndefined();
    });

    test('should fall back to the default on invalid input', async () => {
      process.env.VIOLATION_SCORE_TTL = 'not-a-duration';

      const { cacheConfig } = await import('../cacheConfig');
      expect(cacheConfig.VIOLATION_SCORE_TTL).toBe(3600000);
    });
  });
});
