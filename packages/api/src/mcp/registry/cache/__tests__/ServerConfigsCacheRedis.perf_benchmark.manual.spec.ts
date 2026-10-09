/**
 * Performance benchmark for ServerConfigsCacheRedis.getAll()
 *
 * Requires a live Redis instance. Run manually (excluded from CI):
 *   npx jest --config packages/api/jest.config.mjs --testPathPatterns="perf_benchmark" --coverage=false
 *
 * Set env vars as needed:
 *   USE_REDIS=true REDIS_URI=redis://localhost:6379 npx jest ...
 *
 * This benchmark isolates the two phases of getAll() — SCAN (key discovery) and
 * batched GET (value retrieval) — to identify the actual bottleneck under load.
 * It also benchmarks alternative approaches (single aggregate key, MGET) against
 * the current SCAN+GET implementation.
 */
import { expect } from '@playwright/test';
import type { RedisClientType } from '@redis/client';
import type { ParsedServerConfig } from '~/mcp/types';

describe('ServerConfigsCacheRedis Performance Benchmark', () => {
  let ServerConfigsCacheRedis: typeof import('../ServerConfigsCacheRedis').ServerConfigsCacheRedis;
  let keyvRedisClient: Awaited<typeof import('~/cache/redisClients')>['keyvRedisClient'];
  let standardCache: Awaited<typeof import('~/cache')>['standardCache'];

  const PREFIX = 'perf-bench';

  const makeConfig = (i: number): ParsedServerConfig =>
    ({
      type: 'stdio',
      command: `cmd-${i}`,
      args: [`arg-${i}`, `--flag-${i}`],
      env: { KEY: `value-${i}`, EXTRA: `extra-${i}` },
      requiresOAuth: false,
      tools: `tool_a_${i}, tool_b_${i}`,
      capabilities: `{"tools":{"listChanged":true}}`,
      serverInstructions: `Instructions for server ${i}`,
    }) as ParsedServerConfig;

  beforeAll(async () => {
    process.env.USE_REDIS = process.env.USE_REDIS ?? 'true';
    process.env.USE_REDIS_CLUSTER = process.env.USE_REDIS_CLUSTER ?? 'true';
    process.env.REDIS_URI =
      process.env.REDIS_URI ??
      'redis://127.0.0.1:7001,redis://127.0.0.1:7002,redis://127.0.0.1:7003';
    process.env.REDIS_KEY_PREFIX = process.env.REDIS_KEY_PREFIX ?? 'perf-bench-test';

    const cacheModule = await import('../ServerConfigsCacheRedis');
    const redisClients = await import('~/cache/redisClients');
    const cacheFactory = await import('~/cache');

    ServerConfigsCacheRedis = cacheModule.ServerConfigsCacheRedis;
    keyvRedisClient = redisClients.keyvRedisClient;
    standardCache = cacheFactory.standardCache;

    if (!keyvRedisClient) throw new Error('Redis client is not initialized');
    await redisClients.keyvRedisClientReady;
  });

  afterAll(async () => {
    if (keyvRedisClient?.isOpen) await keyvRedisClient.disconnect();
  });

  /** Clean up all keys matching our test prefix */
  async function cleanupKeys(pattern: string): Promise<void> {
    if (!keyvRedisClient || !('scanIterator' in keyvRedisClient)) return;
    const keys: string[] = [];
    for await (const page of keyvRedisClient.scanIterator({ MATCH: pattern })) {
      keys.push(...page);
    }
    if (keys.length > 0) {
      await Promise.all(keys.map((key) => keyvRedisClient!.del(key)));
    }
  }

  /** Populate a cache with N configs and return the cache instance */
  async function populateCache(
    namespace: string,
    count: number,
  ): Promise<InstanceType<typeof ServerConfigsCacheRedis>> {
    const cache = new ServerConfigsCacheRedis(namespace, false);
    for (let i = 0; i < count; i++) {
      await cache.add(`server-${i}`, makeConfig(i));
    }
    return cache;
  }

  /**
   * Benchmark 1: Isolate SCAN vs GET phases in current getAll()
   *
   * Measures time spent in each phase separately to identify the bottleneck.
   */
  describe('Phase isolation: SCAN vs batched GET', () => {
    const CONFIG_COUNTS = [5, 20, 50];

    for (const count of CONFIG_COUNTS) {
      it(`should measure SCAN and GET phases separately for ${count} configs`, async () => {
        const ns = `${PREFIX}-phase-${count}`;
        const cache = await populateCache(ns, count);

        try {
          // Get the Keyv cache instance namespace for pattern matching
          const keyvCache = standardCache(`MCP::ServersRegistry::Servers::${ns}`);
          const pattern = `*MCP::ServersRegistry::Servers::${ns}:*`;

          // Phase 1: SCAN only (key discovery)
          const scanStart = Date.now();
          const keys: string[] = [];
          for await (const page of (keyvRedisClient as RedisClientType).scanIterator({
            MATCH: pattern,
          })) {
            keys.push(...page);
          }
          const scanMs = Date.now() - scanStart;

          // Phase 2: Batched GET only (value retrieval via Keyv)
          const keyNames = keys.map((key) => key.substring(key.lastIndexOf(':') + 1));
          const BATCH_SIZE = 100;
          const getStart = Date.now();
          for (let i = 0; i < keyNames.length; i += BATCH_SIZE) {
            const batch = keyNames.slice(i, i + BATCH_SIZE);
            await Promise.all(batch.map((k) => keyvCache.get(k)));
          }
          const getMs = Date.now() - getStart;

          // Phase 3: Full getAll() (both phases combined)
          const fullStart = Date.now();
          const result = await cache.getAll();
          const fullMs = Date.now() - fullStart;

          console.log(
            `[${count} configs] SCAN: ${scanMs}ms | GET: ${getMs}ms | Full getAll: ${fullMs}ms | Keys found: ${keys.length}`,
          );

          expect(Object.keys(result).length).toBe(count);

          // Clean up the Keyv instance
          await keyvCache.clear();
        } finally {
          await cleanupKeys(`*${ns}*`);
        }
      });
    }
  });

  /**
   * Benchmark 2: SCAN cost scales with total Redis keyspace, not just matching keys
   *
   * Redis SCAN iterates the entire hash table and filters by pattern. With a large
   * keyspace (many non-matching keys), SCAN takes longer even if few keys match.
   * This test measures SCAN time with background noise keys.
   */
  describe('SCAN cost vs keyspace size', () => {
    it('should measure SCAN latency with background noise keys', async () => {
      const ns = `${PREFIX}-noise`;
      const targetCount = 10;

      // Add target configs
      const cache = await populateCache(ns, targetCount);

      // Add noise keys in a different namespace to inflate the keyspace
      const noiseCount = 500;
      const noiseCache = standardCache(`noise-namespace-${Date.now()}`);
      for (let i = 0; i < noiseCount; i++) {
        await noiseCache.set(`noise-${i}`, { data: `value-${i}` });
      }

      try {
        const pattern = `*MCP::ServersRegistry::Servers::${ns}:*`;

        // Measure SCAN with noise
        const scanStart = Date.now();
        const keys: string[] = [];
        for await (const page of (keyvRedisClient as RedisClientType).scanIterator({
          MATCH: pattern,
        })) {
          keys.push(...page);
        }
        const scanMs = Date.now() - scanStart;

        // Measure full getAll
        const fullStart = Date.now();
        const result = await cache.getAll();
        const fullMs = Date.now() - fullStart;

        console.log(
          `[${targetCount} configs + ${noiseCount} noise keys] SCAN: ${scanMs}ms | Full getAll: ${fullMs}ms`,
        );

        expect(Object.keys(result).length).toBe(targetCount);
      } finally {
        await noiseCache.clear();
        await cleanupKeys(`*${ns}*`);
      }
    });
  });

  /**
   * Benchmark 3: Concurrent getAll() calls (simulates the actual production bottleneck)
   *
   * Multiple users hitting /api/mcp/* simultaneously, all triggering getAll()
   * after the 5s TTL read-through cache expires.
   */
  describe('Concurrent getAll() under load', () => {
    const CONCURRENCY_LEVELS = [1, 10, 50, 100];
    const CONFIG_COUNT = 30;

    for (const concurrency of CONCURRENCY_LEVELS) {
      it(`should measure ${concurrency} concurrent getAll() calls with ${CONFIG_COUNT} configs`, async () => {
        const ns = `${PREFIX}-concurrent-${concurrency}`;
        const cache = await populateCache(ns, CONFIG_COUNT);

        try {
          const startTime = Date.now();
          const promises = Array.from({ length: concurrency }, () => cache.getAll());
          const results = await Promise.all(promises);
          const elapsed = Date.now() - startTime;

          console.log(
            `[${CONFIG_COUNT} configs x ${concurrency} concurrent] Total: ${elapsed}ms | Per-call avg: ${(elapsed / concurrency).toFixed(1)}ms`,
          );

          for (const result of results) {
            expect(Object.keys(result).length).toBe(CONFIG_COUNT);
          }
        } finally {
          await cleanupKeys(`*${ns}*`);
        }
      });
    }
  });

  /**
   * Benchmark 4: Alternative — Single aggregate key
   *
   * Instead of SCAN+GET, store all configs under one Redis key.
   * getAll() becomes a single GET + JSON parse.
   */
  describe('Alternative: Single aggregate key', () => {
    it('should compare aggregate key vs SCAN+GET for getAll()', async () => {
      const ns = `${PREFIX}-aggregate`;
      const configCount = 30;
      const cache = await populateCache(ns, configCount);

      // Build the aggregate object
      const aggregate: Record<string, ParsedServerConfig> = {};
      for (let i = 0; i < configCount; i++) {
        aggregate[`server-${i}`] = makeConfig(i);
      }

      // Store as single key
      const aggregateCache = standardCache(`aggregate-test-${Date.now()}`);
      await aggregateCache.set('all', aggregate);

      try {
        // Measure SCAN+GET approach
        const scanStart = Date.now();
        const scanResult = await cache.getAll();
        const scanMs = Date.now() - scanStart;

        // Measure single-key approach
        const aggStart = Date.now();
        const aggResult = (await aggregateCache.get('all')) as Record<string, ParsedServerConfig>;
        const aggMs = Date.now() - aggStart;

        console.log(
          `[${configCount} configs] SCAN+GET: ${scanMs}ms | Single key: ${aggMs}ms | Speedup: ${(scanMs / Math.max(aggMs, 1)).toFixed(1)}x`,
        );

        expect(Object.keys(scanResult).length).toBe(configCount);
        expect(Object.keys(aggResult).length).toBe(configCount);

        // Concurrent comparison
        const concurrency = 100;
        const scanConcStart = Date.now();
        await Promise.all(Array.from({ length: concurrency }, () => cache.getAll()));
        const scanConcMs = Date.now() - scanConcStart;

        const aggConcStart = Date.now();
        await Promise.all(Array.from({ length: concurrency }, () => aggregateCache.get('all')));
        const aggConcMs = Date.now() - aggConcStart;

        console.log(
          `[${configCount} configs x ${concurrency} concurrent] SCAN+GET: ${scanConcMs}ms | Single key: ${aggConcMs}ms | Speedup: ${(scanConcMs / Math.max(aggConcMs, 1)).toFixed(1)}x`,
        );
      } finally {
        await aggregateCache.clear();
        await cleanupKeys(`*${ns}*`);
      }
    });
  });

  /**
   * Benchmark 5: Alternative — Raw MGET (bypassing Keyv serialization overhead)
   *
   * Keyv wraps each value in { value, expires } JSON. Using raw MGET on the
   * Redis client skips the Keyv layer entirely.
   */
  describe('Alternative: Raw MGET vs Keyv batch GET', () => {
    it('should compare raw MGET vs Keyv GET for value retrieval', async () => {
      const ns = `${PREFIX}-mget`;
      const configCount = 30;
      await populateCache(ns, configCount);

      try {
        // First, discover keys via SCAN (same for both approaches)
        const pattern = `*MCP::ServersRegistry::Servers::${ns}:*`;
        const keys: string[] = [];
        for await (const page of (keyvRedisClient as RedisClientType).scanIterator({
          MATCH: pattern,
        })) {
          keys.push(...page);
        }
        expect(keys.length).toBeGreaterThan(0);

        // Approach 1: Keyv batch GET (current implementation)
        const keyvCache = standardCache(`MCP::ServersRegistry::Servers::${ns}`);
        const keyNames = keys.map((key) => key.substring(key.lastIndexOf(':') + 1));

        const keyvStart = Date.now();
        await Promise.all(keyNames.map((k) => keyvCache.get(k)));
        const keyvMs = Date.now() - keyvStart;

        // Approach 2: Raw MGET (no Keyv overhead)
        const mgetStart = Date.now();
        if ('mGet' in keyvRedisClient!) {
          const rawValues = await (
            keyvRedisClient as { mGet: (keys: string[]) => Promise<(string | null)[]> }
          ).mGet(keys);
          // Parse the Keyv-wrapped JSON values
          rawValues.filter(Boolean).map((v) => JSON.parse(v!));
        }
        const mgetMs = Date.now() - mgetStart;

        console.log(
          `[${configCount} configs] Keyv batch GET: ${keyvMs}ms | Raw MGET: ${mgetMs}ms | Speedup: ${(keyvMs / Math.max(mgetMs, 1)).toFixed(1)}x`,
        );

        // Clean up
        await keyvCache.clear();
      } finally {
        await cleanupKeys(`*${ns}*`);
      }
    });
  });
});
