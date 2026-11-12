import { Keyv } from 'keyv';
import type { RoleChangeCursor, RoleChangeToken } from '@librechat/data-schemas';
import { createRegionalRoleCache, startRoleCacheInvalidation } from './roles';

const config = { enabled: true, ttlMs: 60_000, retryDelayMs: 100, maxAwaitTimeMs: 100 };

async function until(check: () => Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await check()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error('Condition did not settle');
}

function fixture() {
  let time = 0;
  const base = new Keyv();
  const onError = jest.fn();
  const cache = createRegionalRoleCache({ cache: base, onError, now: () => time });
  return { base, cache, onError, advance: (ms: number) => (time += ms) };
}

describe('regional role cache generations', () => {
  it('preserves legacy behavior until explicitly enabled', async () => {
    const { cache, base } = fixture();
    await cache.set('USER:tenant', { allowed: true });
    expect(await cache.get('USER:tenant')).toEqual({ allowed: true });
    expect(await cache.snapshot!()).toBe(base);
  });

  it('preserves legacy cache-miss and failed-write results when disabled', async () => {
    const { cache, base, onError } = fixture();
    jest.spyOn(base, 'set').mockResolvedValue(false);
    expect(await cache.get('USER:tenant')).toBeUndefined();
    expect(await cache.set('USER:tenant', {})).toBe(false);
    expect(onError).not.toHaveBeenCalled();
  });

  it('ignores persistent pre-rollout keys and caches only primary-read snapshots', async () => {
    const { cache, base } = fixture();
    await base.set('USER:tenant', { allowed: false });
    cache.configure(60_000);
    const snapshot = await cache.snapshot!();
    expect(snapshot.primaryReads).toBe(true);
    expect(await snapshot.get('USER:tenant')).toBeUndefined();
    await snapshot.set('USER:tenant', { allowed: true });
    expect(await cache.get('USER:tenant')).toEqual({ allowed: true });
    expect(await base.get('USER:tenant')).toEqual({ allowed: false });
  });

  it('cannot repopulate the active generation from a delayed pre-invalidation read', async () => {
    const { cache } = fixture();
    cache.configure(60_000);
    const before = await cache.snapshot!();
    await cache.invalidate();
    const after = await cache.snapshot!();
    await after.set('USER:tenant', { allowed: false });
    await before.set('USER:tenant', { allowed: true });
    expect(await cache.get('USER:tenant')).toEqual({ allowed: false });
  });

  it('never publishes a potentially out-of-order mutation result into the active generation', async () => {
    const { cache } = fixture();
    cache.configure(60_000);
    await (await cache.snapshot!()).set('USER:tenant', { allowed: true });
    await cache.set('USER:tenant', { allowed: false });
    expect(await cache.get('USER:tenant')).toBeUndefined();
    await cache.set('USER:tenant', { allowed: true });
    expect(await cache.get('USER:tenant')).toBeUndefined();
  });

  it('subtracts database-read time from TTL and never caches an already-expired fill', async () => {
    const { cache, base, advance } = fixture();
    cache.configure(60_000);
    const write = jest.spyOn(base, 'set');
    const snapshot = await cache.snapshot!();
    advance(59_000);
    await snapshot.set('USER:tenant', { allowed: true });
    expect(write).toHaveBeenLastCalledWith(
      expect.stringContaining('USER:tenant'),
      { allowed: true },
      1000,
    );
    advance(1000);
    write.mockClear();
    await snapshot.set('USER:tenant', { allowed: true });
    expect(write).not.toHaveBeenCalled();
  });

  it('keeps generation metadata persistent while role values expire in real Keyv', async () => {
    const { cache, base } = fixture();
    cache.configure(10);
    await (await cache.snapshot!()).set('USER:tenant', { allowed: true });
    const generation = await base.get('__regional_role_generation');
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(await cache.get('USER:tenant')).toBeUndefined();
    expect(await base.get('__regional_role_generation')).toBe(generation);
  });

  it('falls back to a primary database miss when generation metadata is unavailable', async () => {
    const { cache, base, onError } = fixture();
    cache.configure(60_000);
    jest.spyOn(base, 'get').mockRejectedValue(new Error('Redis unavailable'));
    const snapshot = await cache.snapshot!();
    expect(snapshot.primaryReads).toBe(true);
    expect(await snapshot.get('USER:tenant')).toBeUndefined();
    expect(await snapshot.set('USER:tenant', {})).toBe(true);
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it.each(['set', 'delete', 'clear'] as const)(
    'does not certify %s when generation publication returns false or rejects',
    async (operation) => {
      const { cache, base, onError } = fixture();
      cache.configure(60_000);
      const publish = jest.spyOn(base, 'set').mockResolvedValueOnce(false);
      const mutate = () => {
        if (operation === 'set') {
          return cache.set('USER:tenant', {});
        }
        if (operation === 'delete') {
          return cache.delete!('USER:tenant');
        }
        return cache.clear!();
      };
      await expect(mutate()).rejects.toThrow('Role cache generation update failed');
      publish.mockRejectedValueOnce(new Error('Redis unavailable'));
      await expect(mutate()).rejects.toThrow('Redis unavailable');
      // The owning mutation boundary decides how to report failure; this is not a read miss.
      expect(onError).not.toHaveBeenCalled();
    },
  );
});

class Cursor implements RoleChangeCursor {
  calls = 0;
  resolve?: (event: { token: RoleChangeToken } | null) => void;
  reject?: (error: Error) => void;

  tryNext(): Promise<{ token: RoleChangeToken } | null> {
    this.calls++;
    return new Promise((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
    });
  }

  async close(): Promise<void> {
    this.resolve?.(null);
  }
}

describe('role change consumer recovery', () => {
  it('rotates on cursor establishment and events, and closes a blocked cursor on shutdown', async () => {
    const { cache } = fixture();
    const cursor = new Cursor();
    const invalidate = jest.spyOn(cache, 'invalidate');
    const stop = await startRoleCacheInvalidation({
      config,
      cache,
      open: () => cursor,
      onError: jest.fn(),
    });
    expect(invalidate).toHaveBeenCalledTimes(1);
    cursor.resolve?.(null);
    await until(async () => cursor.calls === 2);
    expect(invalidate).toHaveBeenCalledTimes(2);
    cursor.resolve?.({ token: { _data: 'one' } });
    await until(async () => cursor.calls === 3);
    expect(invalidate).toHaveBeenCalledTimes(3);
    await stop();
  });

  it('recovers from an expired token and discards cache warmed while disconnected', async () => {
    const { cache } = fixture();
    const first = new Cursor();
    const second = new Cursor();
    const open = jest.fn().mockReturnValueOnce(first).mockReturnValue(second);
    const onError = jest.fn();
    const stop = await startRoleCacheInvalidation({ config, cache, open, onError });
    first.resolve?.({ token: { _data: 'one' } });
    await until(async () => first.calls === 2);
    await (await cache.snapshot!()).set('USER:tenant', { allowed: true });
    first.reject?.(new Error('ChangeStreamHistoryLost'));
    await until(async () => second.calls === 1);
    expect(open.mock.calls[1][0].resumeAfter).toBeUndefined();
    second.resolve?.(null);
    await until(async () => second.calls === 2);
    expect(await cache.get('USER:tenant')).toBeUndefined();
    expect(onError).toHaveBeenCalledTimes(1);
    await stop();
  });

  it('stops while waiting to retry a failed stream without leaving a timer', async () => {
    const { cache } = fixture();
    const onError = jest.fn();
    const open = jest.fn(() => {
      throw new Error('Streams disabled');
    });
    const stop = await startRoleCacheInvalidation({
      config: { ...config, retryDelayMs: 60_000 },
      cache,
      open,
      onError,
    });
    await until(async () => onError.mock.calls.length === 1);
    await stop();
    expect(open).toHaveBeenCalledTimes(1);
  });

  it('does not open a stream when disabled', async () => {
    const { cache } = fixture();
    const open = jest.fn();
    const stop = await startRoleCacheInvalidation({ cache, open, onError: jest.fn() });
    expect(open).not.toHaveBeenCalled();
    await stop();
  });

  it('supports TTL-only fallback without returning to persistent legacy keys', async () => {
    const { cache, base } = fixture();
    await base.set('USER:tenant', { allowed: true });
    const open = jest.fn();
    const stop = await startRoleCacheInvalidation({
      config: { ...config, changeStreamsEnabled: false },
      cache,
      open,
      onError: jest.fn(),
    });
    expect(open).not.toHaveBeenCalled();
    expect((await cache.snapshot!()).primaryReads).toBe(true);
    expect(await cache.get('USER:tenant')).toBeUndefined();
    await stop();
  });
});
