import { Keyv } from 'keyv';
import { RunStatus } from 'librechat-data-provider';
import type { AbortKeyCache } from './recovery';
import { createRecoveryClaim } from './recovery';

const key = 'user-1:convo-1';
const target = { key, thread_id: 'thread_1', run_id: 'run_1' };

describe('createRecoveryClaim', () => {
  let cache: Keyv;

  beforeEach(() => {
    cache = new Keyv();
  });

  it('claims a run its conversation still names and removes its entry', async () => {
    await cache.set(key, 'thread_1:run_1');

    expect(await createRecoveryClaim(cache)(target)).toBe(true);
    expect(await cache.get(key)).toBeUndefined();
  });

  it('leaves a run the stop route already marked to that stop', async () => {
    await cache.set(key, RunStatus.CANCELLED);

    expect(await createRecoveryClaim(cache)(target)).toBe(false);
    expect(await cache.get(key)).toBe(RunStatus.CANCELLED);
  });

  it('leaves the entry of the next run of the conversation as it is', async () => {
    await cache.set(key, 'thread_1:run_2');

    expect(await createRecoveryClaim(cache)(target)).toBe(false);
    expect(await cache.get(key)).toBe('thread_1:run_2');
  });

  it('claims a run whose entry is gone', async () => {
    expect(await createRecoveryClaim(cache)(target)).toBe(true);
    expect(await cache.get(key)).toBeUndefined();
  });

  it('leaves a run that ended on its own to the controller that saw it end', async () => {
    await cache.set(key, 'thread_1:run_1');
    const claim = createRecoveryClaim(cache);

    expect(await claim({ ...target, settled: true })).toBe(false);
    expect(await cache.get(key)).toBe('thread_1:run_1');
    expect(await claim(target)).toBe(false);
  });

  it('gives a request its run once, even to an ask made before the first one settles', async () => {
    await cache.set(key, 'thread_1:run_1');
    const claim = createRecoveryClaim(cache);

    expect(await Promise.all([claim(target), claim(target)])).toEqual([true, false]);
    expect(await claim(target)).toBe(false);
  });

  it("counts an ask that could not read the entry as the request's only ask", async () => {
    const failing: AbortKeyCache = {
      get: () => Promise.reject(new Error('cache unavailable')),
      delete: (name) => cache.delete(name),
    };
    const claim = createRecoveryClaim(failing);

    await expect(claim(target)).rejects.toThrow('cache unavailable');
    expect(await claim(target)).toBe(false);
  });

  it('lets the request of the next run claim it after an earlier request claimed its own', async () => {
    await cache.set(key, 'thread_1:run_1');
    expect(await createRecoveryClaim(cache)(target)).toBe(true);

    await cache.set(key, 'thread_1:run_2');
    expect(await createRecoveryClaim(cache)({ ...target, run_id: 'run_2' })).toBe(true);
    expect(await cache.get(key)).toBeUndefined();
  });
});
