import type { PullRequestLookupStore } from '~/pulls/types';
import { closeRedisClients } from './redisClients.helper';

describe('pull request lookup store against Redis', () => {
  const testPrefix = 'PullRequestStore-Integration-Test';
  let redisClients: Awaited<typeof import('../redisClients')>;
  let store: PullRequestLookupStore;

  beforeAll(async () => {
    process.env.USE_REDIS = process.env.USE_REDIS ?? 'true';
    process.env.REDIS_URI = process.env.REDIS_URI ?? 'redis://127.0.0.1:6379';
    process.env.REDIS_KEY_PREFIX = process.env.REDIS_KEY_PREFIX ?? testPrefix;
    jest.resetModules();
    redisClients = await import('../redisClients');
    const { cacheConfig } = await import('../cacheConfig');
    const { createPullRequestLookupStore } = await import('../pullRequests');
    await redisClients.keyvRedisClientReady;
    const created = createPullRequestLookupStore({
      client: redisClients.keyvRedisClient,
      config: cacheConfig,
    });
    if (created == null) throw new Error('Redis store is not available');
    store = created;
  });

  afterEach(async () => {
    const client = redisClients.keyvRedisClient;
    if (client == null || !('scanIterator' in client)) return;
    const { cacheConfig } = await import('../cacheConfig');
    const match = `${cacheConfig.REDIS_KEY_PREFIX}${cacheConfig.GLOBAL_PREFIX_SEPARATOR}PULL_REQUESTS:*`;
    for await (const page of client.scanIterator({ MATCH: match })) {
      await Promise.all(page.map((key: string) => client.del(key)));
    }
  });

  afterAll(async () => {
    await closeRedisClients();
  });

  it('keeps the later value for one owner whatever order the writes arrive in', async () => {
    await store.put('slot', { key: 'owner', order: 3_600_000 }, 60_000, 1_000);
    await store.put('slot', { key: 'owner', order: 10_000 }, 60_000, 1_000);
    await expect(store.get('slot', 1_000)).resolves.toEqual({ key: 'owner', order: 3_600_000 });
    await store.put('slot', { key: 'owner', order: 7_200_000 }, 60_000, 1_000);
    await expect(store.get('slot', 1_000)).resolves.toEqual({ key: 'owner', order: 7_200_000 });
  });

  it('lets another owner take a slot, as a fixed slot count requires', async () => {
    await store.put('slot', { key: 'first', order: 3_600_000 }, 60_000, 1_000);
    await store.put('slot', { key: 'second', order: 10 }, 60_000, 1_000);
    await expect(store.get('slot', 1_000)).resolves.toEqual({ key: 'second', order: 10 });
  });

  it('replaces a value it cannot read', async () => {
    const client = redisClients.keyvRedisClient;
    if (client == null) throw new Error('Redis client is not initialized');
    const { cacheConfig } = await import('../cacheConfig');
    const key = `${cacheConfig.REDIS_KEY_PREFIX}${cacheConfig.GLOBAL_PREFIX_SEPARATOR}PULL_REQUESTS:slot`;
    await client.set(key, 'not json');
    await store.put('slot', { key: 'owner', order: 1 }, 60_000, 1_000);
    await expect(store.get('slot', 1_000)).resolves.toEqual({ key: 'owner', order: 1 });
  });

  it('expires a value with its lifetime', async () => {
    await store.put('expiring', { key: 'owner', order: 1 }, 50, 1_000);
    await new Promise((resolve) => setTimeout(resolve, 120));
    await expect(store.get('expiring', 1_000)).resolves.toBeUndefined();
  });
});
