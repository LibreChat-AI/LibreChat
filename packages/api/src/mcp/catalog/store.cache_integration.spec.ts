import { randomUUID } from 'node:crypto';
import { CacheKeys } from 'librechat-data-provider';
import type { RedisTestClient } from '../../stream/__tests__/helpers/redis';
import type { CatalogCache, CatalogStoreDeps } from './store';
import { createRedisTestClient } from '../../stream/__tests__/helpers/redis';
import { createMCPCatalogStore, ToolCacheKeys } from './store';

const describeRedis = process.env.USE_REDIS === 'true' ? describe : describe.skip;
const tools = (name: string) => ({ [name]: { type: 'function' as const, function: { name } } });
const RELEASE_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`;
const CLAIM_SCRIPT = `
local current = redis.call('GET', KEYS[1])
if current and current ~= ARGV[1] then return 0 end
local redisTime = redis.call('TIME')
local now = (tonumber(redisTime[1]) * 1000) + math.floor(tonumber(redisTime[2]) / 1000)
local ttl = tonumber(ARGV[2]) - now - tonumber(ARGV[3])
if ttl <= 0 then return 0 end
redis.call('PSETEX', KEYS[1], ttl, ARGV[1])
return 1
`;

function barrier() {
  let release!: () => void;
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { ready, release };
}

/** Frozen claim/release scripts model the replicas that predate the prefix fix. */
describeRedis('MCP catalog fence compatibility (real Redis)', () => {
  const prefix = `CatalogFence-${randomUUID()}`;
  const globalKey = `${prefix}::${CacheKeys.TOOL_CACHE}:tools:global`;
  const globalLock = `${prefix}::${CacheKeys.TOOL_CACHE}:tools:global:write-lock`;
  const legacyGlobalFence = `tools:global:write-fence:{${globalKey}}`;
  const namespacedGlobalFence = `${prefix}::${CacheKeys.TOOL_CACHE}:tools:global:write-fence:{${globalKey}}`;
  const userId = `user-${randomUUID()}`;
  const serverName = 'server';
  const generationKey = `${prefix}::${CacheKeys.TOOL_CACHE}:${ToolCacheKeys.MCP_SERVER_GENERATION(userId, serverName)}`;
  const userLock = `${prefix}::${CacheKeys.TOOL_CACHE}:tools:mcp-write-lock:${userId}:${serverName}`;
  const legacyUserFence = `tools:mcp:write-fence:{${userId}:${serverName}}`;
  const namespacedUserFence = `${prefix}::${CacheKeys.TOOL_CACHE}:tools:mcp:write-fence:{${userId}:${serverName}}`;
  const keys = [
    globalKey,
    globalLock,
    legacyGlobalFence,
    namespacedGlobalFence,
    generationKey,
    userLock,
    legacyUserFence,
    namespacedUserFence,
  ];
  let redis: RedisTestClient;

  beforeAll(async () => {
    redis = createRedisTestClient('');
    await redis.connect();
  });

  afterEach(async () => {
    await Promise.all(keys.map((key) => redis.del(key)));
  });

  afterAll(() => redis.disconnect());

  function createStore(
    legacy: boolean,
    get = async (key: string) => {
      const raw = await redis.get(`${prefix}::${CacheKeys.TOOL_CACHE}:${key}`);
      return raw == null ? null : JSON.parse(raw).value;
    },
  ) {
    const cache: CatalogCache = {
      get,
      set: async () => {
        throw new Error('Expected an atomic Redis write');
      },
      delete: async () => {
        throw new Error('Expected an atomic Redis delete');
      },
    };
    const client: NonNullable<CatalogStoreDeps['keyvRedisClient']> = {
      eval: async (script, options) => {
        const scriptKeys = options.keys.map((key) => {
          if (!legacy) return key;
          if (key === namespacedGlobalFence) return legacyGlobalFence;
          if (key === namespacedUserFence) return legacyUserFence;
          return key;
        });
        if (legacy && script.includes("redis.call('TIME')")) {
          return redis.eval(
            CLAIM_SCRIPT,
            1,
            scriptKeys[scriptKeys.length - 1],
            ...options.arguments,
          );
        }
        if (legacy && script.includes("redis.call('DEL'")) {
          return redis.eval(
            RELEASE_SCRIPT,
            1,
            scriptKeys[scriptKeys.length - 1],
            ...options.arguments,
          );
        }
        return redis.eval(script, scriptKeys.length, ...scriptKeys, ...options.arguments);
      },
    };
    const store = createMCPCatalogStore({
      cacheConfig: { REDIS_KEY_PREFIX: prefix },
      getCache: () => cache,
      ioredisClient: {
        set: (key, value, mode, ttl, condition) =>
          redis.set(`${prefix}::${key}`, value, mode, ttl, condition),
        eval: (script, count, key, token) =>
          redis.eval(legacy ? RELEASE_SCRIPT : script, count, `${prefix}::${key}`, token),
      },
      keyvRedisClient: client,
    });
    return store;
  }

  it.each([false, true])(
    'keeps a surviving global fence when the lock is lost (old owner: %s)',
    async (oldOwner) => {
      const store = createStore(oldOwner);
      const contender = createStore(!oldOwner);
      const entered = barrier();
      const resume = barrier();
      const write = store.runWithGlobalCacheLock(async () => {
        entered.release();
        await resume.ready;
        return store.setCachedToolsWithinGlobalLock(tools('owner'));
      });
      await entered.ready;
      try {
        await redis.del(globalLock);
        await expect(contender.setCachedTools(tools('stale'))).rejects.toThrow('superseded');
        expect(await redis.get(globalKey)).toBeNull();
      } finally {
        resume.release();
        await expect(write).resolves.toBe(true);
      }
      await expect(store.getCachedTools()).resolves.toEqual(tools('owner'));
      expect(await redis.get(legacyGlobalFence)).toBeNull();
      expect(await redis.get(namespacedGlobalFence)).toBeNull();
    },
  );

  it.each([false, true])(
    'keeps a surviving user fence when the lock is lost (old owner: %s)',
    async (oldOwner) => {
      const entered = barrier();
      const resume = barrier();
      let reads = 0;
      const store = createStore(oldOwner, async () => {
        if (++reads === 2) {
          entered.release();
          await resume.ready;
        }
        return null;
      });
      const contender = createStore(!oldOwner);
      const generation = store.getMCPToolsCacheGeneration({ userId, serverName });
      await entered.ready;
      try {
        await redis.del(userLock);
        await expect(contender.getMCPToolsCacheGeneration({ userId, serverName })).rejects.toThrow(
          'superseded',
        );
        expect(await redis.get(generationKey)).toBeNull();
      } finally {
        resume.release();
        await expect(generation).resolves.toEqual(expect.any(String));
      }
      expect(await redis.get(legacyUserFence)).toBeNull();
      expect(await redis.get(namespacedUserFence)).toBeNull();
    },
  );

  it.each(['', '{tenant}', '{', '}'])(
    'works with a prefix-only ACL and prefix suffix %j',
    async (suffix) => {
      const aclPrefix = `${prefix}-${randomUUID()}${suffix}`;
      const username = `catalog-${randomUUID()}`;
      const password = randomUUID();
      const nodes = 'nodes' in redis ? redis.nodes('master') : [redis];
      const touched = new Set<string>();
      const rawKey = (key: string) => `${aclPrefix}::${CacheKeys.TOOL_CACHE}:${key}`;
      await Promise.all(
        nodes.map((node) =>
          node.acl('SETUSER', username, 'on', `>${password}`, `~${aclPrefix}*`, '+@all'),
        ),
      );
      const restricted =
        'nodes' in redis
          ? redis.duplicate([], {
              lazyConnect: true,
              redisOptions: { ...redis.options.redisOptions, username, password, keyPrefix: '' },
            })
          : redis.duplicate({ lazyConnect: true, username, password, keyPrefix: '' });
      try {
        await restricted.connect();
        await expect(restricted.get(legacyGlobalFence)).rejects.toThrow('NOPERM');
        const createStoreForClient = (client: RedisTestClient) =>
          createMCPCatalogStore({
            cacheConfig: { REDIS_KEY_PREFIX: aclPrefix },
            getCache: () => ({
              get: async (key) => {
                const value = await client.get(rawKey(key));
                return value == null ? null : JSON.parse(value).value;
              },
              set: async () => {
                throw new Error('Expected an atomic Redis write');
              },
              delete: async () => {
                throw new Error('Expected an atomic Redis delete');
              },
            }),
            ioredisClient: {
              set: (key, value, mode, ttl, condition) => {
                const physical = `${aclPrefix}::${key}`;
                touched.add(physical);
                return client.set(physical, value, mode, ttl, condition);
              },
              eval: (script, count, key, token) =>
                client.eval(script, count, `${aclPrefix}::${key}`, token),
            },
            keyvRedisClient: {
              eval: (script, options) => {
                options.keys.forEach((key) => touched.add(key));
                return client.eval(
                  script,
                  options.keys.length,
                  ...options.keys,
                  ...options.arguments,
                );
              },
            },
          });
        for (const client of [restricted, redis]) {
          const store = createStoreForClient(client);
          await expect(store.setCachedTools(tools('current'))).resolves.toBe(true);
          await expect(store.getCachedTools()).resolves.toEqual(tools('current'));
          await expect(store.getMCPToolsCacheGeneration({ userId, serverName })).resolves.toEqual(
            expect.any(String),
          );
          await expect(
            store.invalidateCachedTools({ invalidateGlobal: true }),
          ).resolves.toBeUndefined();
          expect(await client.get(rawKey(ToolCacheKeys.GLOBAL))).toBeNull();
          await redis.del(rawKey(ToolCacheKeys.MCP_SERVER_GENERATION(userId, serverName)));
        }
      } finally {
        restricted.disconnect();
        await Promise.all([...touched].map((key) => redis.del(key)));
        await Promise.all(nodes.map((node) => node.acl('DELUSER', username)));
      }
    },
  );

  it('rejects a delayed new write after an old replica replaces its legacy fence', async () => {
    const store = createStore(false);
    const entered = barrier();
    const resume = barrier();
    const write = store.runWithGlobalCacheLock(async () => {
      entered.release();
      await resume.ready;
      return store.setCachedToolsWithinGlobalLock(tools('stale'));
    });
    const settled = write.catch((error: Error) => error);
    await entered.ready;
    try {
      await redis.del(globalLock);
      await redis.del(legacyGlobalFence);
      expect(
        Number(
          await redis.eval(
            CLAIM_SCRIPT,
            1,
            legacyGlobalFence,
            'old-replica',
            String(Date.now() + 30_000),
            '1000',
          ),
        ),
      ).toBe(1);
      await redis.set(
        globalKey,
        JSON.stringify({ value: tools('replacement'), expires: Date.now() + 60_000 }),
      );
    } finally {
      resume.release();
      await expect(settled).resolves.toMatchObject({
        message: expect.stringContaining('ownership was lost'),
      });
    }
    await expect(store.getCachedTools()).resolves.toEqual(tools('replacement'));
    expect(await redis.get(legacyGlobalFence)).toBe('old-replica');
  });
});
