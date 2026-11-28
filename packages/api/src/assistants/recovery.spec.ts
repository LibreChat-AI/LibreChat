import { Keyv } from 'keyv';
import { RunStatus } from 'librechat-data-provider';
import type { DistributedLock } from '~/cache/lock';
import type { AbortKeyCache } from './recovery';
import { claimRunRecovery, createRecoveryClaim, REQUEST_CLOSED } from './recovery';
import { createDistributedLock } from '~/cache/lock';

const key = 'user-1:convo-1';
const failed = { key, run_id: 'run_1', error: new Error('terminated') };
const closed = { key, run_id: 'run_1', error: new Error(REQUEST_CLOSED) };

describe('createRecoveryClaim', () => {
  let cache: Keyv;
  let lock: DistributedLock;
  /** The controller's completed run, as its `completedRun` variable holds it. */
  let completedRun: unknown;
  const createClaim = (store: AbortKeyCache = cache) =>
    createRecoveryClaim({ cache: store, lock, completedRun: () => completedRun });

  beforeEach(() => {
    cache = new Keyv();
    lock = createDistributedLock();
    completedRun = undefined;
  });

  it('claims a run nobody claimed and leaves its entry as it is', async () => {
    await cache.set(key, 'thread_1:run_1');

    expect(await createClaim()(failed)).toBe(true);
    expect(await cache.get(key)).toBe('thread_1:run_1');
  });

  it('leaves a run the stop route claimed to that stop', async () => {
    await cache.set(key, 'thread_1:run_1');
    expect(await claimRunRecovery(lock, 'run_1')).not.toBeNull();

    expect(await createClaim()(closed)).toBe(false);
  });

  it('claims a run the stop route gave back', async () => {
    await cache.set(key, 'thread_1:run_1');
    const stop = await claimRunRecovery(lock, 'run_1');
    await stop?.release();

    expect(await createClaim()(closed)).toBe(true);
  });

  it('keeps the stop route from claiming a run its request recovered', async () => {
    await cache.set(key, 'thread_1:run_1');
    expect(await createClaim()(failed)).toBe(true);

    expect(await claimRunRecovery(lock, 'run_1')).toBeNull();
  });

  it('leaves a run marked cancelled to the stop that marked it', async () => {
    await cache.set(key, RunStatus.CANCELLED);

    expect(await createClaim()(closed)).toBe(false);
  });

  it('recovers its own run after the next run took the entry, and leaves that entry', async () => {
    await cache.set(key, 'thread_1:run_2');

    expect(await createClaim()(failed)).toBe(true);
    expect(await cache.get(key)).toBe('thread_1:run_2');
    expect(await claimRunRecovery(lock, 'run_2')).not.toBeNull();
  });

  it('claims a run whose entry is gone', async () => {
    expect(await createClaim()(failed)).toBe(true);
  });

  it('claims a run on a close while the controller has not received its end', async () => {
    await cache.set(key, 'thread_1:run_1');

    expect(await createClaim()(closed)).toBe(true);
  });

  it('leaves a run the controller received to it when the response closed', async () => {
    await cache.set(key, 'thread_1:run_1');
    completedRun = { id: 'run_1', status: RunStatus.COMPLETED };

    expect(await createClaim()(closed)).toBe(false);
  });

  it('still recovers that run when the controller then fails to settle it', async () => {
    await cache.set(key, 'thread_1:run_1');
    completedRun = { id: 'run_1', status: RunStatus.COMPLETED };
    const claim = createClaim();

    expect(await claim(closed)).toBe(false);
    expect(await claim(failed)).toBe(true);
  });

  it('gives a request its run once, even to an ask made before the first one settles', async () => {
    await cache.set(key, 'thread_1:run_1');
    const claim = createClaim();

    expect(await Promise.all([claim(failed), claim(closed)])).toEqual([true, false]);
    expect(await claim(failed)).toBe(false);
  });

  it("counts an ask that could not read the entry as the request's only ask", async () => {
    const claim = createClaim({ get: () => Promise.reject(new Error('cache unavailable')) });

    await expect(claim(failed)).rejects.toThrow('cache unavailable');
    expect(await claim(closed)).toBe(false);
  });

  it('gives each request of the conversation its own run', async () => {
    await cache.set(key, 'thread_1:run_1');
    expect(await createClaim()(failed)).toBe(true);

    await cache.set(key, 'thread_1:run_2');
    expect(await createClaim()({ ...failed, run_id: 'run_2' })).toBe(true);
  });
});
