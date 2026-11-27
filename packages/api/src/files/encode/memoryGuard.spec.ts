import { InFlightBytesSemaphore, runGuardedEncode } from './memoryGuard';

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('memoryGuard', () => {
  describe('runGuardedEncode concurrency cap', () => {
    it('never runs more than 3 tasks at once and completes all', async () => {
      let active = 0;
      let peak = 0;
      const gates = [deferred(), deferred(), deferred(), deferred(), deferred()];

      const calls = gates.map((gate, i) =>
        runGuardedEncode(1, async () => {
          active++;
          peak = Math.max(peak, active);
          await gate.promise;
          active--;
          return i;
        }),
      );

      await tick();
      expect(active).toBe(3);

      for (const gate of gates) {
        gate.resolve();
        await tick();
      }

      await expect(Promise.all(calls)).resolves.toEqual([0, 1, 2, 3, 4]);
      expect(peak).toBe(3);
    });
  });

  describe('runGuardedEncode release on throw', () => {
    it('frees the slot when a task rejects', async () => {
      await expect(
        runGuardedEncode(1, async () => {
          throw new Error('boom');
        }),
      ).rejects.toThrow('boom');

      await expect(runGuardedEncode(1, async () => 'ok')).resolves.toBe('ok');
    });
  });

  describe('InFlightBytesSemaphore', () => {
    it('does not admit a later reservation ahead of an earlier queued one that still fits', async () => {
      const sem = new InFlightBytesSemaphore(100);
      const order: string[] = [];

      const releaseActive = await sem.acquire(60);

      void sem.acquire(60).then(() => order.push('first'));
      void sem.acquire(10).then(() => order.push('second'));

      await tick();
      expect(order).toEqual([]);

      releaseActive();
      await tick();
      expect(order).toEqual(['first', 'second']);
    });

    it('admits queued waiters in FIFO order as budget frees', async () => {
      const sem = new InFlightBytesSemaphore(100);
      const order: string[] = [];
      const releases: Record<string, () => void> = {};

      const releaseA = await sem.acquire(100);

      for (const label of ['B', 'C', 'D']) {
        void sem.acquire(60).then((release) => {
          order.push(label);
          releases[label] = release;
        });
      }

      await tick();
      expect(order).toEqual([]);

      releaseA();
      await tick();
      expect(order).toEqual(['B']);

      releases['B']();
      await tick();
      expect(order).toEqual(['B', 'C']);

      releases['C']();
      await tick();
      expect(order).toEqual(['B', 'C', 'D']);
    });

    it('runs an oversize reservation alone without deadlocking', async () => {
      const sem = new InFlightBytesSemaphore(100);

      const releaseOversize = await sem.acquire(500);

      let smallAdmitted = false;
      void sem.acquire(10).then(() => {
        smallAdmitted = true;
      });

      await tick();
      expect(smallAdmitted).toBe(false);

      releaseOversize();
      await tick();
      expect(smallAdmitted).toBe(true);
    });

    it('release is idempotent', async () => {
      const sem = new InFlightBytesSemaphore(100);

      const releaseFirst = await sem.acquire(100);
      releaseFirst();
      releaseFirst();

      const releaseSecond = await sem.acquire(100);

      let thirdAdmitted = false;
      void sem.acquire(100).then(() => {
        thirdAdmitted = true;
      });

      await tick();
      expect(thirdAdmitted).toBe(false);

      releaseSecond();
      await tick();
      expect(thirdAdmitted).toBe(true);
    });
  });
});
