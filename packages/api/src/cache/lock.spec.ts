import type { DistributedLockRedisClient } from './lock';
import { createDistributedLock } from './lock';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function createMockRedisClient(): jest.Mocked<DistributedLockRedisClient> {
  return {
    set: jest.fn(),
    eval: jest.fn(),
    evalsha: jest.fn(),
  } as jest.Mocked<DistributedLockRedisClient>;
}

describe('createDistributedLock (Redis-backed)', () => {
  test('acquire sets the key with an owner token and NX/PX, returns the token on OK', async () => {
    const client = createMockRedisClient();
    client.set.mockResolvedValueOnce('OK');
    const lock = createDistributedLock({ redisClient: client });

    const token = await lock.acquire('my-key', 5000);

    expect(token).toMatch(UUID_PATTERN);
    expect(client.set).toHaveBeenCalledWith('my-key', token, 'PX', 5000, 'NX');
  });

  test('acquire returns null when the key is already held', async () => {
    const client = createMockRedisClient();
    client.set.mockResolvedValueOnce(null);
    const lock = createDistributedLock({ redisClient: client });

    const token = await lock.acquire('my-key', 5000);

    expect(token).toBeNull();
  });

  test('extend evaluates the extend script with (1, key, token, ttl) and returns true on 1', async () => {
    const client = createMockRedisClient();
    client.evalsha.mockResolvedValueOnce(1);
    const lock = createDistributedLock({ redisClient: client });

    const extended = await lock.extend('my-key', 'owner-token', 3000);

    expect(extended).toBe(true);
    expect(client.eval).not.toHaveBeenCalled();
    expect(client.evalsha).toHaveBeenCalledTimes(1);
    expect(client.evalsha.mock.calls[0].slice(1)).toEqual([1, 'my-key', 'owner-token', 3000]);
  });

  test('extend returns false on 0', async () => {
    const client = createMockRedisClient();
    client.evalsha.mockResolvedValueOnce(0);
    const lock = createDistributedLock({ redisClient: client });

    const extended = await lock.extend('my-key', 'owner-token', 3000);

    expect(extended).toBe(false);
  });

  test('release evaluates the release script with (1, key, token) and resolves true on 1', async () => {
    const client = createMockRedisClient();
    client.evalsha.mockResolvedValueOnce(1);
    const lock = createDistributedLock({ redisClient: client });

    const released = await lock.release('my-key', 'owner-token');

    expect(released).toBe(true);
    expect(client.eval).not.toHaveBeenCalled();
    expect(client.evalsha).toHaveBeenCalledTimes(1);
    expect(client.evalsha.mock.calls[0].slice(1)).toEqual([1, 'my-key', 'owner-token']);
  });

  test('release returns false on 0', async () => {
    const client = createMockRedisClient();
    client.evalsha.mockResolvedValueOnce(0);
    const lock = createDistributedLock({ redisClient: client });

    const released = await lock.release('my-key', 'owner-token');

    expect(released).toBe(false);
  });

  test('a NOSCRIPT error on evalsha still resolves extend via the EVAL fallback with the extend script', async () => {
    const client = createMockRedisClient();
    client.evalsha.mockRejectedValueOnce(new Error('NOSCRIPT No matching script'));
    client.eval.mockResolvedValueOnce(1);
    const lock = createDistributedLock({ redisClient: client });

    const extended = await lock.extend('my-key', 'owner-token', 3000);

    expect(extended).toBe(true);
    expect(client.eval).toHaveBeenCalledTimes(1);
    const script = client.eval.mock.calls[0][0] as string;
    expect(script).toContain('PEXPIRE');
    expect(script).not.toContain('DEL');
  });

  test('a NOSCRIPT error on evalsha still resolves release via the EVAL fallback with the release script', async () => {
    const client = createMockRedisClient();
    client.evalsha.mockRejectedValueOnce(new Error('NOSCRIPT No matching script'));
    client.eval.mockResolvedValueOnce(1);
    const lock = createDistributedLock({ redisClient: client });

    const released = await lock.release('my-key', 'owner-token');

    expect(released).toBe(true);
    expect(client.eval).toHaveBeenCalledTimes(1);
    const script = client.eval.mock.calls[0][0] as string;
    expect(script).toContain('DEL');
    expect(script).not.toContain('PEXPIRE');
  });

  test.each([0, -1, 1.5, NaN])('acquire throws RangeError for ttlMs %p', async (ttlMs) => {
    const client = createMockRedisClient();
    const lock = createDistributedLock({ redisClient: client });

    await expect(lock.acquire('my-key', ttlMs)).rejects.toThrow(RangeError);
    expect(client.set).not.toHaveBeenCalled();
  });

  test.each([0, -1, 1.5, NaN])('extend throws RangeError for ttlMs %p', async (ttlMs) => {
    const client = createMockRedisClient();
    const lock = createDistributedLock({ redisClient: client });

    await expect(lock.extend('my-key', 'owner-token', ttlMs)).rejects.toThrow(RangeError);
    expect(client.eval).not.toHaveBeenCalled();
    expect(client.evalsha).not.toHaveBeenCalled();
  });
});

describe('createDistributedLock (in-process)', () => {
  test('a second acquire on a live key returns null', async () => {
    const currentTime = 0;
    const lock = createDistributedLock({ now: () => currentTime });

    const first = await lock.acquire('key-1', 1000);
    const second = await lock.acquire('key-1', 1000);

    expect(first).toMatch(UUID_PATTERN);
    expect(second).toBeNull();
  });

  test('acquire succeeds with a new token once the previous ttl has elapsed', async () => {
    let currentTime = 0;
    const lock = createDistributedLock({ now: () => currentTime });

    const first = await lock.acquire('key-1', 1000);
    currentTime = 1001;
    const second = await lock.acquire('key-1', 1000);

    expect(second).toMatch(UUID_PATTERN);
    expect(second).not.toBe(first);
  });

  test('an expired token can no longer extend or release the new lock', async () => {
    let currentTime = 0;
    const lock = createDistributedLock({ now: () => currentTime });

    const first = await lock.acquire('key-1', 1000);
    currentTime = 1001;
    await lock.acquire('key-1', 1000);

    expect(await lock.extend('key-1', first as string, 1000)).toBe(false);
    await lock.release('key-1', first as string);
    expect(await lock.extend('key-1', first as string, 1000)).toBe(false);
  });

  test('extend by the owner pushes the expiry so a later acquire within the extended window still fails', async () => {
    let currentTime = 0;
    const lock = createDistributedLock({ now: () => currentTime });

    const token = await lock.acquire('key-1', 1000);
    currentTime = 900;
    const extended = await lock.extend('key-1', token as string, 1000);
    currentTime = 1500;
    const reacquired = await lock.acquire('key-1', 1000);

    expect(extended).toBe(true);
    expect(reacquired).toBeNull();
  });

  test('extend by a non-owner returns false', async () => {
    const currentTime = 0;
    const lock = createDistributedLock({ now: () => currentTime });

    await lock.acquire('key-1', 1000);
    const extended = await lock.extend('key-1', 'not-the-owner', 1000);

    expect(extended).toBe(false);
  });

  test('release by the owner frees the key immediately', async () => {
    const currentTime = 0;
    const lock = createDistributedLock({ now: () => currentTime });

    const token = await lock.acquire('key-1', 1000);
    await lock.release('key-1', token as string);
    const reacquired = await lock.acquire('key-1', 1000);

    expect(reacquired).toMatch(UUID_PATTERN);
  });

  test('release by a non-owner is a no-op; the owner keeps the lock', async () => {
    const currentTime = 0;
    const lock = createDistributedLock({ now: () => currentTime });

    const token = await lock.acquire('key-1', 1000);
    const released = await lock.release('key-1', 'not-the-owner');
    const stillHeld = await lock.acquire('key-1', 1000);

    expect(released).toBe(false);
    expect(stillHeld).toBeNull();
    expect(await lock.extend('key-1', token as string, 1000)).toBe(true);
  });

  test('release returns true for the owner', async () => {
    const lock = createDistributedLock({ now: () => 0 });

    const token = await lock.acquire('key-1', 1000);

    expect(await lock.release('key-1', token as string)).toBe(true);
  });

  test('release returns false for an unknown key', async () => {
    const lock = createDistributedLock({ now: () => 0 });

    expect(await lock.release('no-such-key', 'some-token')).toBe(false);
  });

  test.each([0, -1, 1.5, NaN])('acquire throws RangeError for ttlMs %p', async (ttlMs) => {
    const lock = createDistributedLock({ now: () => 0 });

    await expect(lock.acquire('key-1', ttlMs)).rejects.toThrow(RangeError);
  });

  test.each([0, -1, 1.5, NaN])('extend throws RangeError for ttlMs %p', async (ttlMs) => {
    const lock = createDistributedLock({ now: () => 0 });

    await lock.acquire('key-1', 1000);
    await expect(lock.extend('key-1', 'owner-token', ttlMs)).rejects.toThrow(RangeError);
  });

  test('an expired lock can neither be extended nor blocks a new acquire after other keys were used', async () => {
    let currentTime = 0;
    const lock = createDistributedLock({ now: () => currentTime });

    const tokenA = await lock.acquire('key-a', 10);
    currentTime = 20;
    await lock.acquire('key-b', 10);

    expect(await lock.extend('key-a', tokenA as string, 10)).toBe(false);
    expect(await lock.acquire('key-a', 10)).toMatch(UUID_PATTERN);
  });

  test('exactly one of five concurrent acquire calls on one key succeeds', async () => {
    const lock = createDistributedLock({ now: () => 0 });

    const results = await Promise.all(Array.from({ length: 5 }, () => lock.acquire('key-1', 1000)));

    const nonNull = results.filter((result) => result !== null);
    expect(nonNull).toHaveLength(1);
  });

  test('different keys are independent', async () => {
    const lock = createDistributedLock({ now: () => 0 });

    const first = await lock.acquire('key-1', 1000);
    const second = await lock.acquire('key-2', 1000);

    expect(first).toMatch(UUID_PATTERN);
    expect(second).toMatch(UUID_PATTERN);
  });

  test('crossing the sweep threshold reclaims keys that expired but were never touched again', async () => {
    let currentTime = 0;
    const lock = createDistributedLock({ now: () => currentTime });

    for (let i = 0; i < 200; i += 1) {
      await lock.acquire(`key-${i}`, 10);
    }
    const renewedToken = await lock.acquire('renewed', 10);
    currentTime = 5;
    expect(await lock.extend('renewed', renewedToken as string, 100)).toBe(true);
    currentTime = 20;
    const replacementToken = await lock.acquire('key-0', 100);

    // The live-entry sweeps at sizes 64 and 128 moved the next threshold to 256.
    for (let i = 200; i < 255; i += 1) {
      await lock.acquire(`key-${i}`, 100);
    }

    // Cleanup is otherwise invisible through the public API: acquire can replace
    // an expired entry even if the sweep never removes it.
    const deleted = jest.spyOn(Map.prototype, 'delete');
    try {
      await lock.acquire('key-255', 100);
      expect(deleted.mock.calls).toEqual(Array.from({ length: 199 }, (_, i) => [`key-${i + 1}`]));
    } finally {
      deleted.mockRestore();
    }

    expect(await lock.acquire('renewed', 100)).toBeNull();
    expect(await lock.release('renewed', renewedToken as string)).toBe(true);
    expect(await lock.acquire('key-0', 100)).toBeNull();
    expect(await lock.release('key-0', replacementToken as string)).toBe(true);
    expect(await lock.acquire('key-200', 100)).toBeNull();
  });
});
