import Keyv from 'keyv';
import calculateSlot from 'cluster-key-slot';
import { CacheKeys } from 'librechat-data-provider';

const GLOBAL_PREFIX = 'deployment::';
const redisValues = new Map<string, string>();
const redisTtls = new Map<string, number>();
const setCalls: Array<readonly [string, string, string, number, string]> = [];
const evalCalls: Array<readonly [string, number, ...Array<string | number>]> = [];

const effectiveKey = (key: string): string => `${GLOBAL_PREFIX}${key}`;

const fakeRedisClient = {
  set: async (
    key: string,
    value: string,
    expiryMode: string,
    ttl: number,
    condition: string,
  ): Promise<'OK' | null> => {
    setCalls.push([key, value, expiryMode, ttl, condition]);
    const storedKey = effectiveKey(key);
    if (condition === 'NX' && redisValues.has(storedKey)) {
      return null;
    }
    redisValues.set(storedKey, value);
    redisTtls.set(storedKey, ttl);
    return 'OK';
  },
  eval: async (
    script: string,
    numberOfKeys: number,
    ...args: Array<string | number>
  ): Promise<number> => {
    evalCalls.push([script, numberOfKeys, ...args]);
    const keys = args.slice(0, numberOfKeys).map((key) => effectiveKey(String(key)));
    const argv = args.slice(numberOfKeys).map(String);
    if (redisValues.get(keys[0]) !== argv[0]) {
      return 0;
    }
    if (script.includes("redis.call('PEXPIRE'")) {
      redisTtls.set(keys[0], Number(argv[1]));
      return 1;
    }
    if (script.includes("redis.call('DEL'")) {
      redisValues.delete(keys[0]);
      redisTtls.delete(keys[0]);
      return 1;
    }
    if (script.includes("redis.call('SET'")) {
      redisValues.set(keys[1], argv[1]);
      redisTtls.set(keys[1], Number(argv[2]));
      return 1;
    }
    throw new Error('Unexpected Redis script');
  },
};

jest.mock('./redisClients', () => ({
  keyvRedisClient: {},
  ioredisClient: fakeRedisClient,
}));

jest.mock('./redisTelemetry', () => ({
  instrumentIORedisClient: () => fakeRedisClient,
}));

jest.mock('./cacheConfig', () => ({
  cacheConfig: {
    FORCED_IN_MEMORY_CACHE_NAMESPACES: [],
    REDIS_KEY_PREFIX: 'deployment',
    GLOBAL_PREFIX_SEPARATOR: '::',
  },
}));

import { attachRedisLock } from './lock';

describe('attachRedisLock', () => {
  const namespace = CacheKeys.IMPORT_JOBS;
  const lockTtl = 5000;
  const tag = '{user-1:job-1}';
  const claimKey = `${namespace}_LOCK:${tag}`;
  const dataKey = tag;

  beforeEach(() => {
    redisValues.clear();
    redisTtls.clear();
    setCalls.length = 0;
    evalCalls.length = 0;
  });

  afterEach(async () => {
    const { cacheConfig } = await import('./cacheConfig');
    cacheConfig.FORCED_IN_MEMORY_CACHE_NAMESPACES = [];
    jest.restoreAllMocks();
  });

  it('leaves a forced in-memory namespace exactly as it was', async () => {
    const { cacheConfig } = await import('./cacheConfig');
    cacheConfig.FORCED_IN_MEMORY_CACHE_NAMESPACES = [namespace];
    const cache = new Keyv();

    const lockable = attachRedisLock(cache, namespace, lockTtl);

    expect(lockable).toBe(cache);
    expect(lockable.acquireLock).toBeUndefined();
    expect(lockable.extendLock).toBeUndefined();
    expect(lockable.releaseLock).toBeUndefined();
    expect(lockable.setIfLockOwned).toBeUndefined();
    expect(lockable.lockTtl).toBeUndefined();
  });

  it('acquires with SET NX PX and returns null while the claim exists', async () => {
    const lockable = attachRedisLock(new Keyv(), namespace, lockTtl);

    const token = await lockable.acquireLock?.(claimKey);
    const refused = await lockable.acquireLock?.(claimKey);

    expect(token).toMatch(/^[0-9a-f-]{36}$/);
    expect(refused).toBeNull();
    expect(setCalls).toEqual([
      [claimKey, token, 'PX', lockTtl, 'NX'],
      [claimKey, expect.any(String), 'PX', lockTtl, 'NX'],
    ]);
    expect(redisValues.get(effectiveKey(claimKey))).toBe(token);
    expect(redisTtls.get(effectiveKey(claimKey))).toBe(lockTtl);
  });

  it('extends and releases only the matching token with compare-token Lua scripts', async () => {
    const lockable = attachRedisLock(new Keyv(), namespace, lockTtl);
    const token = await lockable.acquireLock?.(claimKey);

    expect(await lockable.extendLock?.(claimKey, 'wrong-token')).toBe(false);
    expect(await lockable.extendLock?.(claimKey, token!)).toBe(true);
    await lockable.releaseLock?.(claimKey, 'wrong-token');
    expect(redisValues.get(effectiveKey(claimKey))).toBe(token);
    await lockable.releaseLock?.(claimKey, token!);

    expect(redisValues.has(effectiveKey(claimKey))).toBe(false);
    expect(evalCalls[0][0]).toContain("if redis.call('GET', KEYS[1]) == ARGV[1] then");
    expect(evalCalls[0][0]).toContain("return redis.call('PEXPIRE', KEYS[1], ARGV[2])");
    expect(evalCalls[0].slice(1)).toEqual([1, claimKey, 'wrong-token', lockTtl]);
    expect(evalCalls[2][0]).toContain("return redis.call('DEL', KEYS[1])");
    expect(evalCalls[2].slice(1)).toEqual([1, claimKey, 'wrong-token']);
  });

  it('atomically serializes and writes the Keyv payload only for the claim owner', async () => {
    jest.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
    const cache = new Keyv();
    const lockable = attachRedisLock(cache, namespace, lockTtl);
    const token = await lockable.acquireLock?.(claimKey);
    const value = { phase: 'queued', progress: { done: 2 } };
    const ttl = 86_400_000;

    expect(await lockable.setIfLockOwned?.(claimKey, dataKey, 'wrong-token', value, ttl)).toBe(
      false,
    );
    expect(redisValues.has(effectiveKey(`${namespace}:${dataKey}`))).toBe(false);
    expect(await lockable.setIfLockOwned?.(claimKey, dataKey, token!, value, ttl)).toBe(true);

    const storedKey = effectiveKey(`${namespace}:${dataKey}`);
    expect(JSON.parse(redisValues.get(storedKey)!)).toEqual({
      value,
      expires: 1_700_086_400_000,
    });
    expect(redisTtls.get(storedKey)).toBe(ttl);
    expect(evalCalls[0][0]).toContain("if redis.call('GET', KEYS[1]) == ARGV[1] then");
    expect(evalCalls[0][0]).toContain("redis.call('SET', KEYS[2], ARGV[2], 'PX', ARGV[3])");
    expect(evalCalls[0].slice(1, 5)).toEqual([
      2,
      claimKey,
      `${namespace}:${dataKey}`,
      'wrong-token',
    ]);
    expect(evalCalls[1].slice(1, 5)).toEqual([2, claimKey, `${namespace}:${dataKey}`, token]);
  });

  it('constructs prefixed claim and data keys in the same Redis Cluster hash slot', async () => {
    const lockable = attachRedisLock(new Keyv(), namespace, lockTtl);
    const token = await lockable.acquireLock?.(claimKey);
    await lockable.setIfLockOwned?.(claimKey, dataKey, token!, { status: 'active' }, lockTtl);

    const effectiveClaimKey = effectiveKey(claimKey);
    const effectiveDataKey = effectiveKey(`${namespace}:${dataKey}`);
    expect([...redisValues.keys()]).toEqual(
      expect.arrayContaining([effectiveClaimKey, effectiveDataKey]),
    );
    expect(effectiveClaimKey).toBe(`deployment::${namespace}_LOCK:{user-1:job-1}`);
    expect(effectiveDataKey).toBe(`deployment::${namespace}:{user-1:job-1}`);
    expect(calculateSlot(effectiveClaimKey)).toBe(calculateSlot(effectiveDataKey));
  });
});
