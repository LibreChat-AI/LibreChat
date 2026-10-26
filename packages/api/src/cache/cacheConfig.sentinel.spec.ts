// Mock the data-schemas logger before loading cacheConfig — the dist bundle
// pulls a jsonwebtoken chain that jest's transform chokes on in this env.
jest.mock('@librechat/data-schemas', () => ({
  logger: {
    warn: jest.fn(),
    error: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
  },
}));

type CacheConfigModule = typeof import('./cacheConfig');

/** Fresh-import cacheConfig under the current env for isolation. */
const loadCacheConfig = (): CacheConfigModule['cacheConfig'] => {
  let config: CacheConfigModule['cacheConfig'] | undefined;
  jest.isolateModules(() => {
    config = jest.requireActual<CacheConfigModule>('./cacheConfig').cacheConfig;
  });
  if (!config) {
    throw new Error('cacheConfig module failed to load');
  }
  return config;
};

describe('Redis Sentinel configuration (REDIS_SENTINEL_*)', () => {
  const WRITABLE_ENV = { ...process.env };
  const savedEnv = { ...process.env };
  const sentinelHosts = 'redis-s-0:26379,redis-s-1:26379,redis-s-2:26379';
  const redisUri = 'rediss://redis:6379';

  /** Reset the baseline env between tests. */
  const setEnv = (overrides: Record<string, string | undefined>) => {
    process.env = { ...WRITABLE_ENV, ...overrides };
  };

  afterEach(() => {
    // Restore to the pristine baseline saved at module load.
    process.env = { ...savedEnv };
  });

  describe('opt-in semantics', () => {
    it('leaves Sentinel disabled by default (no env vars set)', () => {
      setEnv({ REDIS_URI: redisUri });
      const config = loadCacheConfig();
      expect(config.REDIS_SENTINEL_ENABLED).toBe(false);
      expect(config.REDIS_SENTINEL_HOSTS).toBeUndefined();
      expect(config.REDIS_SENTINEL_MASTER_NAME).toBeUndefined();
    });

    it('does not require REDIS_URI when Sentinel is enabled', () => {
      setEnv({
        REDIS_SENTINEL_ENABLED: 'true',
        REDIS_SENTINEL_HOSTS: sentinelHosts,
        REDIS_SENTINEL_MASTER_NAME: 'mymaster',
      });
      expect(() => loadCacheConfig()).not.toThrow();
      const config = loadCacheConfig();
      expect(config.REDIS_SENTINEL_ENABLED).toBe(true);
      expect(config.REDIS_SENTINEL_HOSTS).toBe(sentinelHosts);
      expect(config.REDIS_SENTINEL_MASTER_NAME).toBe('mymaster');
    });

    it('enables Sentinel when REDIS_SENTINEL_ENABLED=true', () => {
      setEnv({
        REDIS_SENTINEL_ENABLED: 'true',
        REDIS_SENTINEL_HOSTS: sentinelHosts,
        REDIS_SENTINEL_MASTER_NAME: 'mymaster',
      });
      const config = loadCacheConfig();
      expect(config.REDIS_SENTINEL_ENABLED).toBe(true);
    });

    it('does not enable Sentinel when REDIS_SENTINEL_ENABLED=false', () => {
      setEnv({
        REDIS_SENTINEL_ENABLED: 'false',
        REDIS_SENTINEL_HOSTS: sentinelHosts,
        REDIS_SENTINEL_MASTER_NAME: 'mymaster',
      });
      const config = loadCacheConfig();
      expect(config.REDIS_SENTINEL_ENABLED).toBe(false);
    });
  });

  describe('fail-fast validation', () => {
    it('fails fast when enabled without REDIS_SENTINEL_HOSTS', () => {
      setEnv({ REDIS_SENTINEL_ENABLED: 'true', REDIS_SENTINEL_MASTER_NAME: 'mymaster' });
      expect(() => loadCacheConfig()).toThrow('REDIS_SENTINEL_HOSTS is not set');
    });

    it('fails fast when enabled with empty REDIS_SENTINEL_HOSTS', () => {
      setEnv({
        REDIS_SENTINEL_ENABLED: 'true',
        REDIS_SENTINEL_HOSTS: '   ',
        REDIS_SENTINEL_MASTER_NAME: 'mymaster',
      });
      expect(() => loadCacheConfig()).toThrow('REDIS_SENTINEL_HOSTS is not set');
    });

    it('fails fast when enabled without REDIS_SENTINEL_MASTER_NAME', () => {
      setEnv({ REDIS_SENTINEL_ENABLED: 'true', REDIS_SENTINEL_HOSTS: sentinelHosts });
      expect(() => loadCacheConfig()).toThrow('REDIS_SENTINEL_MASTER_NAME is not set');
    });

    it('fails fast when enabled with empty REDIS_SENTINEL_MASTER_NAME', () => {
      setEnv({
        REDIS_SENTINEL_ENABLED: 'true',
        REDIS_SENTINEL_HOSTS: sentinelHosts,
        REDIS_SENTINEL_MASTER_NAME: '',
      });
      expect(() => loadCacheConfig()).toThrow('REDIS_SENTINEL_MASTER_NAME is not set');
    });
  });

  describe('existing behavior preserved', () => {
    it('still requires REDIS_URI when Sentinel is disabled', () => {
      setEnv({ USE_REDIS: 'true', REDIS_SENTINEL_ENABLED: 'false' });
      expect(() => loadCacheConfig()).toThrow('USE_REDIS is enabled but REDIS_URI is not set');
    });
  });

  describe('TLS options', () => {
    it('defaults Sentinel TLS to disabled', () => {
      setEnv({
        REDIS_SENTINEL_ENABLED: 'true',
        REDIS_SENTINEL_HOSTS: sentinelHosts,
        REDIS_SENTINEL_MASTER_NAME: 'mymaster',
      });
      const config = loadCacheConfig();
      expect(config.REDIS_SENTINEL_TLS_ENABLED).toBe(false);
    });

    it('enables Sentinel TLS when REDIS_SENTINEL_TLS_ENABLED=true', () => {
      setEnv({
        REDIS_SENTINEL_ENABLED: 'true',
        REDIS_SENTINEL_HOSTS: sentinelHosts,
        REDIS_SENTINEL_MASTER_NAME: 'mymaster',
        REDIS_SENTINEL_TLS_ENABLED: 'true',
      });
      const config = loadCacheConfig();
      expect(config.REDIS_SENTINEL_TLS_ENABLED).toBe(true);
    });
  });

  it('reads REDIS_SENTINEL_PASSWORD when set', () => {
    setEnv({
      REDIS_SENTINEL_ENABLED: 'true',
      REDIS_SENTINEL_HOSTS: sentinelHosts,
      REDIS_SENTINEL_MASTER_NAME: 'mymaster',
      REDIS_SENTINEL_PASSWORD: 'cortiadmin',
    });
    const config = loadCacheConfig();
    expect(config.REDIS_SENTINEL_PASSWORD).toBe('cortiadmin');
  });

  it('leaves REDIS_SENTINEL_PASSWORD undefined when unset', () => {
    setEnv({
      REDIS_SENTINEL_ENABLED: 'true',
      REDIS_SENTINEL_HOSTS: sentinelHosts,
      REDIS_SENTINEL_MASTER_NAME: 'mymaster',
    });
    const config = loadCacheConfig();
    expect(config.REDIS_SENTINEL_PASSWORD).toBeUndefined();
  });
});
