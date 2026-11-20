import type { RedisClientType } from '@redis/client';
import type { RespServer } from '../resp.helper';
import { closeRedisClients } from '../redisClients.helper';
import { startRespServer, waitFor } from '../resp.helper';

const events = ['error', 'connect', 'disconnect', 'reconnecting'] as const;

describe('standardCache Redis lifecycle', () => {
  let originalEnv: NodeJS.ProcessEnv;
  let server: RespServer;
  let clients: typeof import('~/cache/redisClients');
  let factory: typeof import('~/cache/cacheFactory');
  let telemetry: typeof import('~/cache/redisTelemetry');
  const client = (): RedisClientType => clients.keyvRedisClient as RedisClientType;
  const listenerCounts = (): number[] => events.map((event) => client().listenerCount(event));

  beforeAll(async () => {
    originalEnv = { ...process.env };
    server = await startRespServer();
    process.env.USE_REDIS = 'true';
    process.env.USE_REDIS_CLUSTER = 'false';
    process.env.REDIS_URI = server.url;
    process.env.REDIS_PING_INTERVAL = '0';
    process.env.REDIS_KEY_PREFIX = 'redis-memoization';
    process.env.REDIS_READONLY_RECOVERY_INTERVAL = '0';
    process.env.REDIS_RETRY_MAX_ATTEMPTS = '2';
    process.env.REDIS_RETRY_MAX_DELAY = '50';
    process.env.FORCED_IN_MEMORY_CACHE_NAMESPACES = 'CONFIG_STORE';
    jest.resetModules();
    clients = await import('~/cache/redisClients');
    telemetry = await import('~/cache/redisTelemetry');
    factory = await import('~/cache/cacheFactory');
    await clients.keyvRedisClientReady;
  });

  afterAll(async () => {
    await closeRedisClients(clients);
    await server.close();
    process.env = originalEnv;
    jest.resetModules();
  });

  it('reuses the real adapter without adding listeners or instrumenting it again', async () => {
    const instrument = jest.spyOn(telemetry, 'instrumentRedisCache');
    const before = listenerCounts();
    const cache = factory.standardCache('repeated', 500);
    expect(listenerCounts()).toEqual(before.map((count) => count + 1));
    const after = listenerCounts();
    const methods = { get: cache.get, set: cache.set, clear: cache.clear };

    const instances = Array.from({ length: 1000 }, () => factory.standardCache('repeated', 500));

    expect(listenerCounts()).toEqual(after);
    expect(instances.every((instance) => instance === cache)).toBe(true);
    expect(instrument).toHaveBeenCalledTimes(1);
    expect(cache.get).toBe(methods.get);
    expect(cache.set).toBe(methods.set);
    expect(cache.clear).toBe(methods.clear);
    await cache.set('key', 'value');
    expect(await factory.standardCache('repeated', 500).get('key')).toBe('value');
  });

  it('preserves distinct default TTLs and per-write overrides in one Redis namespace', async () => {
    const short = factory.standardCache('ttl', 500);
    const long = factory.standardCache('ttl', 99999);
    const forever = factory.standardCache('ttl');
    const zero = factory.standardCache('ttl', 0);
    expect(short).not.toBe(long);
    expect(short.ttl).toBe(500);
    expect(long.ttl).toBe(99999);
    expect(forever.ttl).toBeUndefined();
    expect(zero.ttl).toBeUndefined();
    expect(zero.opts.ttl).toBe(0);
    const before = listenerCounts();
    for (let i = 0; i < 100; i++) {
      expect(factory.standardCache('ttl', 500)).toBe(short);
      expect(factory.standardCache('ttl', 99999)).toBe(long);
      expect(factory.standardCache('ttl')).toBe(forever);
      expect(factory.standardCache('ttl', 0)).toBe(zero);
    }
    expect(listenerCounts()).toEqual(before);

    await short.set('short', 'value');
    await long.set('long', 'value');
    await forever.set('forever', 'value');
    await zero.set('zero', 'value');
    await short.set('override', 'value', 1234);
    await long.set('no-expiry', 'value', 0);
    const writes = server.commands.filter(
      ([command, key]) => command === 'SET' && key.includes('ttl:'),
    );
    expect(writes.map((args) => args.slice(3))).toEqual([
      ['PX', '500'],
      ['PX', '99999'],
      [],
      [],
      ['PX', '1234'],
      [],
    ]);
    expect(await long.get('short')).toBe('value');
    expect(await short.get('long')).toBe('value');

    const now = Date.now();
    const clock = jest.spyOn(Date, 'now').mockReturnValue(now + 1000);
    try {
      expect(await short.get('short')).toBeUndefined();
      expect(await long.get('long')).toBe('value');
      expect(await forever.get('forever')).toBe('value');
      expect(await zero.get('zero')).toBe('value');
    } finally {
      clock.mockRestore();
    }
  });

  it('keeps Redis keys compatible and clear scoped to the namespace across TTL variants', async () => {
    const first = factory.standardCache('clear-one', 5000);
    const variant = factory.standardCache('clear-one', 99999);
    const other = factory.standardCache('clear-two', 5000);
    await first.set('key', 'one');
    await variant.set('variant', 'variant');
    await other.set('key', 'two');
    expect(await client().get('redis-memoization::clear-one:key')).not.toBeNull();
    expect(await other.get('key')).toBe('two');
    expect(await other.get('variant')).toBeUndefined();

    const before = listenerCounts();
    await factory.standardCache('clear-one', 5000).clear();
    expect(await first.get('key')).toBeUndefined();
    expect(await variant.get('variant')).toBeUndefined();
    expect(await other.get('key')).toBe('two');
    expect(factory.standardCache('clear-one', 5000)).toBe(first);
    expect(listenerCounts()).toEqual(before);
    await first.set('key', 'reused');
    expect(await variant.get('key')).toBe('reused');
  });

  it('retains forced-memory and custom-fallback behavior without Redis listeners', async () => {
    const before = listenerCounts();
    const memory = factory.standardCache('CONFIG_STORE', 500);
    expect(factory.standardCache('CONFIG_STORE', 99999)).toBe(memory);
    const storeA = new Map<string, string>();
    const storeB = new Map<string, string>();
    const a = factory.standardCache('CONFIG_STORE', undefined, storeA);
    const b = factory.standardCache('CONFIG_STORE', undefined, storeB);
    expect(a).not.toBe(b);
    expect(a.store).toBe(storeA);
    expect(b.store).toBe(storeB);
    await a.set('key', 'value');
    expect(await b.get('key')).toBeUndefined();
    expect(listenerCounts()).toEqual(before);
  });

  it('ignores fallback stores while Redis is selected, as before', async () => {
    const first = factory.standardCache('fallback-redis', 5000, new Map());
    expect(factory.standardCache('fallback-redis', 5000, new Map())).toBe(first);
    await first.set('key', 'value');
    expect(await client().get('redis-memoization::fallback-redis:key')).not.toBeNull();
  });

  it('recovers a memoized cache after a READONLY reply without replacing its adapter', async () => {
    const cache = factory.standardCache('recovery');
    const recover = jest.spyOn(clients, 'handleKeyvRedisError');
    const before = listenerCounts();
    const connections = server.connections;
    server.readonly = true;
    try {
      await cache.set('key', 'rejected');
      await waitFor(() => server.connections > connections && client().isReady);
      expect(recover).toHaveBeenCalled();
    } finally {
      server.readonly = false;
    }
    expect(factory.standardCache('recovery')).toBe(cache);
    await expect(cache.set('key', 'recovered')).resolves.toBe(true);
    expect(await cache.get('key')).toBe('recovered');
    expect(listenerCounts()).toEqual(before);
  });
});
