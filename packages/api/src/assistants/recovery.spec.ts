import { Keyv } from 'keyv';
import { RunStatus } from 'librechat-data-provider';
import type { AbortKeyCache } from './recovery';
import { createRecoveryClaim, REQUEST_CLOSED } from './recovery';

const key = 'user-1:convo-1';
const ids = { key, thread_id: 'thread_1', run_id: 'run_1' };
const failed = { ...ids, error: new Error('terminated') };
const closed = { ...ids, error: new Error(REQUEST_CLOSED) };

describe('createRecoveryClaim', () => {
  let cache: Keyv;
  /** The controller's completed run, as its `completedRun` variable holds it. */
  let completedRun: unknown;
  const createClaim = (store: AbortKeyCache = cache) =>
    createRecoveryClaim({ cache: store, completedRun: () => completedRun });

  beforeEach(() => {
    cache = new Keyv();
    completedRun = undefined;
  });

  it('claims a run its conversation still names and removes its entry', async () => {
    await cache.set(key, 'thread_1:run_1');

    expect(await createClaim()(failed)).toBe(true);
    expect(await cache.get(key)).toBeUndefined();
  });

  it('leaves a run the stop route already marked to that stop', async () => {
    await cache.set(key, RunStatus.CANCELLED);

    expect(await createClaim()(closed)).toBe(false);
    expect(await cache.get(key)).toBe(RunStatus.CANCELLED);
  });

  it('leaves the entry of the next run of the conversation as it is', async () => {
    await cache.set(key, 'thread_1:run_2');

    expect(await createClaim()(closed)).toBe(false);
    expect(await cache.get(key)).toBe('thread_1:run_2');
  });

  it('claims a run whose entry is gone', async () => {
    expect(await createClaim()(failed)).toBe(true);
    expect(await cache.get(key)).toBeUndefined();
  });

  it('claims a run on a close while the controller has not received its end', async () => {
    await cache.set(key, 'thread_1:run_1');

    expect(await createClaim()(closed)).toBe(true);
  });

  it('leaves a run the controller received to it when the response closed', async () => {
    await cache.set(key, 'thread_1:run_1');
    completedRun = { id: 'run_1', status: RunStatus.COMPLETED };

    expect(await createClaim()(closed)).toBe(false);
    expect(await cache.get(key)).toBe('thread_1:run_1');
  });

  it('still recovers that run when the controller then fails to settle it', async () => {
    await cache.set(key, 'thread_1:run_1');
    completedRun = { id: 'run_1', status: RunStatus.COMPLETED };
    const claim = createClaim();

    expect(await claim(closed)).toBe(false);
    expect(await claim(failed)).toBe(true);
    expect(await cache.get(key)).toBeUndefined();
  });

  it('gives a request its run once, even to an ask made before the first one settles', async () => {
    await cache.set(key, 'thread_1:run_1');
    const claim = createClaim();

    expect(await Promise.all([claim(failed), claim(closed)])).toEqual([true, false]);
    expect(await claim(failed)).toBe(false);
  });

  it("counts an ask that could not read the entry as the request's only ask", async () => {
    const claim = createClaim({
      get: () => Promise.reject(new Error('cache unavailable')),
      delete: (name) => cache.delete(name),
    });

    await expect(claim(failed)).rejects.toThrow('cache unavailable');
    expect(await claim(closed)).toBe(false);
  });

  it('lets the request of the next run claim it after an earlier request claimed its own', async () => {
    await cache.set(key, 'thread_1:run_1');
    expect(await createClaim()(failed)).toBe(true);

    await cache.set(key, 'thread_1:run_2');
    expect(await createClaim()({ ...failed, run_id: 'run_2' })).toBe(true);
    expect(await cache.get(key)).toBeUndefined();
  });
});
