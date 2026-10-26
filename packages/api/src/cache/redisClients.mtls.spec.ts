import { tmpdir } from 'os';
import { join } from 'path';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';

type CacheConfigModule = typeof import('./cacheConfig');
type RedisClientsModule = typeof import('./redisClients');

const certData =
  '-----BEGIN CERTIFICATE-----\nLIBRECHAT-TEST-CLIENT-CERT\n-----END CERTIFICATE-----\n';
const keyData =
  '-----BEGIN PRIVATE KEY-----\nLIBRECHAT-TEST-CLIENT-KEY\n-----END PRIVATE KEY-----\n';

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

/** Fresh-import redisClients under the current env for isolation. */
const loadRedisClients = (): RedisClientsModule => {
  let mod: RedisClientsModule | undefined;
  jest.isolateModules(() => {
    mod = jest.requireActual<RedisClientsModule>('./redisClients');
  });
  if (!mod) {
    throw new Error('redisClients module failed to load');
  }
  return mod;
};

describe('Redis mTLS client certificates (REDIS_TLS_CERT + REDIS_TLS_KEY)', () => {
  let tempDir: string;
  let certPath: string;
  let keyPath: string;

  beforeAll(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'lc-mtls-'));
    certPath = join(tempDir, 'tls.crt');
    keyPath = join(tempDir, 'tls.key');
    writeFileSync(certPath, certData, 'utf8');
    writeFileSync(keyPath, keyData, 'utf8');
  });

  afterAll(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  afterEach(() => {
    delete process.env.USE_REDIS;
    delete process.env.REDIS_URI;
    delete process.env.REDIS_TLS_CERT;
    delete process.env.REDIS_TLS_KEY;
  });

  describe('opt-in semantics', () => {
    it('leaves client certificates unset (null) when neither env var is set', () => {
      expect(loadCacheConfig().REDIS_TLS_CERT).toBeNull();
      expect(loadCacheConfig().REDIS_TLS_KEY).toBeNull();
    });

    it('reads both files when both env vars are set', () => {
      process.env.REDIS_TLS_CERT = certPath;
      process.env.REDIS_TLS_KEY = keyPath;
      const config = loadCacheConfig();
      expect(config.REDIS_TLS_CERT).toBe(certData);
      expect(config.REDIS_TLS_KEY).toBe(keyData);
    });

    it('fails fast when only REDIS_TLS_CERT is set', () => {
      process.env.REDIS_TLS_CERT = certPath;
      expect(() => loadCacheConfig()).toThrow(
        'REDIS_TLS_CERT and REDIS_TLS_KEY must both be set to readable files to enable TLS client authentication.',
      );
    });

    it('fails fast when only REDIS_TLS_KEY is set', () => {
      process.env.REDIS_TLS_KEY = keyPath;
      expect(() => loadCacheConfig()).toThrow(
        'REDIS_TLS_CERT and REDIS_TLS_KEY must both be set to readable files to enable TLS client authentication.',
      );
    });

    it('fails fast when the certificate file is missing', () => {
      process.env.REDIS_TLS_CERT = join(tempDir, 'missing.crt');
      process.env.REDIS_TLS_KEY = keyPath;
      expect(() => loadCacheConfig()).toThrow(
        'REDIS_TLS_CERT and REDIS_TLS_KEY must both be set to readable files to enable TLS client authentication.',
      );
    });

    it('fails fast when the key file is missing', () => {
      process.env.REDIS_TLS_CERT = certPath;
      process.env.REDIS_TLS_KEY = join(tempDir, 'missing.key');
      expect(() => loadCacheConfig()).toThrow(
        'REDIS_TLS_CERT and REDIS_TLS_KEY must both be set to readable files to enable TLS client authentication.',
      );
    });
  });

  describe('redisClients', () => {
    it('sends cert and key to ioredis and @keyv/redis when both are set', () => {
      process.env.USE_REDIS = 'true';
      process.env.REDIS_URI = 'rediss://localhost:6999';
      process.env.REDIS_TLS_CERT = certPath;
      process.env.REDIS_TLS_KEY = keyPath;
      const { ioredisClient, keyvRedisClient } = loadRedisClients();
      const ioredisTls = (
        ioredisClient as unknown as {
          options: { tls?: Record<string, unknown> };
        }
      ).options.tls;
      expect(ioredisTls).toMatchObject({ cert: certData, key: keyData });
      const keyvSocket = (
        keyvRedisClient as unknown as {
          options: { socket?: Record<string, unknown> };
        }
      ).options.socket;
      expect(keyvSocket).toMatchObject({ cert: certData, key: keyData });
      ioredisClient?.disconnect();
      keyvRedisClient?.disconnect();
    });

    it('keeps TLS options without cert and key when neither is set', () => {
      process.env.USE_REDIS = 'true';
      process.env.REDIS_URI = 'rediss://localhost:6999';
      const { ioredisClient, keyvRedisClient } = loadRedisClients();
      const ioredisTls = (
        ioredisClient as unknown as {
          options: { tls?: Record<string, unknown> };
        }
      ).options.tls;
      // Default: no client certificate material anywhere, only the (unset) CA key.
      expect(ioredisTls).not.toHaveProperty('cert');
      expect(ioredisTls).not.toHaveProperty('key');
      const keyvSocket = (
        keyvRedisClient as unknown as {
          options: { socket?: Record<string, unknown> };
        }
      ).options.socket;
      expect(keyvSocket?.cert).toBeUndefined();
      expect(keyvSocket?.key).toBeUndefined();
      ioredisClient?.disconnect();
      keyvRedisClient?.disconnect();
    });

    it('fails fast when client certificates are configured with a plaintext URI', () => {
      process.env.USE_REDIS = 'true';
      process.env.REDIS_URI = 'redis://localhost:6999';
      process.env.REDIS_TLS_CERT = certPath;
      process.env.REDIS_TLS_KEY = keyPath;
      expect(() => loadRedisClients()).toThrow(
        'REDIS_TLS_CERT and REDIS_TLS_KEY require REDIS_URI to use rediss://',
      );
    });
  });
});
