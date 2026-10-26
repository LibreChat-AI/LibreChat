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
  const keys = new Set([
    globalKey,
    globalLock,
    legacyGlobalFence,
    namespacedGlobalFence,
    generationKey,
    userLock,
    legacyUserFence,
    namespacedUserFence,
  ]);
  let redis: RedisTestClient;

  beforeAll(async () => {
    redis = createRedisTestClient('');
    await redis.connect();
  });

  afterEach(async () => {
    await Promise.all([...keys].map((key) => redis.del(key)));
  });

  afterAll(() => redis.disconnect());

  function createStore(legacy: boolean, get?: CatalogCache['get'], deployment = prefix) {
    const cache: CatalogCache = {
      get:
        get ??
        (async (key: string) => {
          const raw = await redis.get(`${deployment}::${CacheKeys.TOOL_CACHE}:${key}`);
          return raw == null ? null : JSON.parse(raw).value;
        }),
      set: async () => {
        throw new Error('Expected an atomic Redis write');
      },
      delete: async () => {
        throw new Error('Expected an atomic Redis delete');
      },
    };
    const client: NonNullable<CatalogStoreDeps['keyvRedisClient']> = {
      eval: async (script, options) => {
        options.keys.forEach((key) => keys.add(key));
        const scriptKeys = [
          ...new Set(
            options.keys.map((key) => {
              if (!legacy) return key;
              if (key === namespacedGlobalFence) return legacyGlobalFence;
              if (key === namespacedUserFence) return legacyUserFence;
              return key;
            }),
          ),
        ];
        if (legacy && script.includes("local current = redis.call('GET', KEYS[1])")) {
          return redis.eval(
            CLAIM_SCRIPT,
            1,
            scriptKeys[scriptKeys.length - 1],
            ...options.arguments,
          );
        }
        if (legacy && script.includes('return released')) {
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
      cacheConfig: { REDIS_KEY_PREFIX: deployment },
      getCache: () => cache,
      ioredisClient: {
        set: (key, value, mode, ttl, condition) => {
          keys.add(`${deployment}::${key}`);
          return redis.set(`${deployment}::${key}`, value, mode, ttl, condition);
        },
        eval: (script, count, key, token) =>
          redis.eval(legacy ? RELEASE_SCRIPT : script, count, `${deployment}::${key}`, token),
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

  it('isolates deployments sharing user/server IDs and releases only its own barrier entry', async () => {
    const otherPrefix = `${prefix}-other`;
    const entered = [barrier(), barrier()];
    const resume = [barrier(), barrier()];
    const stores = [prefix, otherPrefix].map((deployment, index) => {
      let reads = 0;
      return createStore(
        false,
        async () => {
          if (++reads === 2) {
            entered[index].release();
            await resume[index].ready;
          }
          return null;
        },
        deployment,
      );
    });
    const first = stores[0].getMCPToolsCacheGeneration({ userId, serverName });
    await entered[0].ready;
    const second = stores[1].getMCPToolsCacheGeneration({ userId, serverName });
    const secondSettled = second.catch((error: Error) => error);
    const enteredOrRejected = Promise.race([
      entered[1].ready.then(() => 'entered'),
      secondSettled.then(() => 'settled'),
    ]);
    try {
      await expect(enteredOrRejected).resolves.toBe('entered');
      const barrierBefore = JSON.parse((await redis.get(legacyUserFence))!);
      expect(Object.keys(barrierBefore.owners)).toHaveLength(2);
      const firstToken = await redis.get(namespacedUserFence);
      const otherFence = `${otherPrefix}::${CacheKeys.TOOL_CACHE}:tools:mcp:write-fence:{${userId}:${serverName}}`;
      const secondToken = await redis.get(otherFence);
      expect(firstToken).not.toBe(secondToken);
      expect(await redis.pttl(legacyUserFence)).toBeGreaterThan(0);
      // Losing one deployment's lock must still reject its own competing writer.
      await redis.del(userLock);
      await expect(
        createStore(false).getMCPToolsCacheGeneration({ userId, serverName }),
      ).rejects.toThrow('superseded');
      resume[0].release();
      await expect(first).resolves.toEqual(expect.any(String));
      const barrierAfter = JSON.parse((await redis.get(legacyUserFence))!);
      expect(Object.keys(barrierAfter.owners)).toEqual([secondToken]);
      expect(await redis.get(otherFence)).toBe(secondToken);
      // The remaining deployment still excludes old writers after its peer exits.
      expect(
        Number(
          await redis.eval(
            CLAIM_SCRIPT,
            1,
            legacyUserFence,
            'old-replica',
            String(Date.now() + 30_000),
            '1000',
          ),
        ),
      ).toBe(0);
      resume[1].release();
      await expect(secondSettled).resolves.toEqual(expect.any(String));
      expect(await redis.get(legacyUserFence)).toBeNull();
      const otherGeneration = `${otherPrefix}::${CacheKeys.TOOL_CACHE}:${ToolCacheKeys.MCP_SERVER_GENERATION(userId, serverName)}`;
      expect(await redis.get(generationKey)).not.toBeNull();
      expect(await redis.get(otherGeneration)).not.toBeNull();
      expect(await redis.get(otherFence)).toBeNull();
    } finally {
      resume.forEach((pause) => pause.release());
      await Promise.allSettled([first, second]);
    }
  });

  it('preserves longer peer leases and prunes expired compatibility owners', async () => {
    const owner = 'peer';
    const expired = 'expired';
    const deadline = Date.now() + 60_000;
    const value = {
      protocol: 'librechat:mcp-catalog-fence:v1',
      owners: { [owner]: deadline, [expired]: 1 },
    };
    await redis.set(legacyUserFence, JSON.stringify(value), 'PX', 60_000);
    await expect(
      createStore(false).getMCPToolsCacheGeneration({ userId, serverName }),
    ).resolves.toEqual(expect.any(String));
    expect(JSON.parse((await redis.get(legacyUserFence))!).owners).toEqual({ [owner]: deadline });
    expect(await redis.pttl(legacyUserFence)).toBeGreaterThan(50_000);
  });

  it.each(['generation', 'migration'] as const)(
    'rejects a delayed user %s after its compatibility lease is replaced',
    async (operation) => {
      const entered = barrier();
      const resume = barrier();
      const rawKey = (key: string) => `${prefix}::${CacheKeys.TOOL_CACHE}:${key}`;
      let reads = 0;
      const store = createStore(false, async (key) => {
        if (++reads === 2) {
          entered.release();
          await resume.ready;
        }
        const raw = await redis.get(rawKey(key));
        return raw == null ? null : JSON.parse(raw).value;
      });
      const legacyTools = rawKey(ToolCacheKeys.MCP_SERVER(userId, serverName));
      const migratedTools = rawKey(ToolCacheKeys.MCP_SERVER(userId, serverName, 'config'));
      keys.add(legacyTools);
      keys.add(migratedTools);
      await redis.set(
        legacyTools,
        JSON.stringify({ value: tools('legacy'), expires: Date.now() + 60_000 }),
      );
      const write =
        operation === 'generation'
          ? store.getMCPToolsCacheGeneration({ userId, serverName })
          : store.getCachedTools({ userId, serverName, configGeneration: 'config' });
      const settled = write.catch((error: Error) => error);
      await entered.ready;
      try {
        await redis.set(legacyUserFence, 'old-replica', 'PX', 30_000);
      } finally {
        resume.release();
        await expect(settled).resolves.toMatchObject({
          message: expect.stringContaining('ownership was lost'),
        });
      }
      expect(await redis.get(generationKey)).toBeNull();
      expect(await redis.get(migratedTools)).toBeNull();
      expect(await redis.get(legacyUserFence)).toBe('old-replica');
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
