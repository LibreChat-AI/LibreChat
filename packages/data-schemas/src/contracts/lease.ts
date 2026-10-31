/* eslint-disable jest/no-export -- Shared behavioral suite, invoked by each engine's spec. */
import type { ResourceLockMethods } from '~/methods/resourceLock';

export interface LeaseRecord {
  key: string;
  ownerId: string;
  expiresAt: Date;
}

export interface LeaseHarness {
  readonly name: string;
  /** Separate connections to the same database, not copies of one in-memory store. */
  setup(): Promise<readonly [ResourceLockMethods, ResourceLockMethods, ResourceLockMethods]>;
  teardown(): Promise<void>;
  reset(): Promise<void>;
  /** Control the adapter's clock without replacing networking or driver timers. */
  setTime(now: Date): void;
  seed(record: LeaseRecord): Promise<void>;
  read(key: string): Promise<LeaseRecord | null>;
  /** Fail the first client's next persistence operation before it commits. */
  failNext(operation: 'acquire' | 'renew' | 'release', error: Error): void;
}

export function describeLeaseConformance(harness: LeaseHarness): void {
  describe(`resource lease contract: ${harness.name}`, () => {
    let clients: Awaited<ReturnType<LeaseHarness['setup']>>;
    const now = new Date('2100-01-01T00:00:00Z');
    const key = 'acl:agent:one';
    const lock = { key, ownerId: 'a', ttlMs: 30_000 };

    beforeAll(async () => {
      clients = await harness.setup();
    });
    afterAll(() => harness.teardown());
    beforeEach(async () => {
      await harness.reset();
      harness.setTime(now);
    });

    it('acquires an unused key for exactly the requested lifetime', async () => {
      expect(await clients[0].acquireResourceLock(lock)).toBe(true);
      expect(await harness.read(key)).toEqual({
        key,
        ownerId: 'a',
        expiresAt: new Date(+now + lock.ttlMs),
      });
    });

    it('does not reacquire a live lease, even with the same owner token', async () => {
      await clients[0].acquireResourceLock(lock);
      const before = await harness.read(key);
      expect(await clients[1].acquireResourceLock({ ...lock, ownerId: 'b' })).toBe(false);
      expect(await clients[0].acquireResourceLock({ ...lock, ttlMs: 60_000 })).toBe(false);
      expect(await harness.read(key)).toEqual(before);
      expect(await clients[1].acquireResourceLock({ ...lock, key: 'acl:agent:two' })).toBe(true);
    });

    it.each([-1, 0])(
      'takes over an existing expired row at expiry offset %i ms',
      async (offset) => {
        await harness.seed({ key, ownerId: 'crashed', expiresAt: new Date(+now + offset) });
        expect(await clients[1].acquireResourceLock({ ...lock, ownerId: 'b' })).toBe(true);
        expect(await harness.read(key)).toEqual({
          key,
          ownerId: 'b',
          expiresAt: new Date(+now + lock.ttlMs),
        });
        expect(await clients[0].renewResourceLock({ ...lock, ownerId: 'crashed' })).toBe(false);
        expect(await clients[0].releaseResourceLock({ key, ownerId: 'crashed' })).toBe(false);
        expect(await clients[1].renewResourceLock({ ...lock, ownerId: 'b' })).toBe(true);
      },
    );

    it('refuses takeover one millisecond before expiry', async () => {
      const record = { key, ownerId: 'a', expiresAt: new Date(+now + 1) };
      await harness.seed(record);
      expect(await clients[1].acquireResourceLock({ ...lock, ownerId: 'b' })).toBe(false);
      expect(await harness.read(key)).toEqual(record);
    });

    it.each(['unused', 'expired'] as const)(
      'elects one owner across independent clients for an %s key',
      async (state) => {
        if (state === 'expired') await harness.seed({ key, ownerId: 'crashed', expiresAt: now });
        let start!: () => void;
        const gate = new Promise<void>((resolve) => {
          start = resolve;
        });
        const attempts = clients.map(async (client, index) => {
          await gate;
          return client.acquireResourceLock({ ...lock, ownerId: `owner-${index}` });
        });
        start();
        const results = await Promise.all(attempts);
        expect(results.filter(Boolean)).toHaveLength(1);
        const winner = results.indexOf(true);
        expect(await harness.read(key)).toEqual({
          key,
          ownerId: `owner-${winner}`,
          expiresAt: new Date(+now + lock.ttlMs),
        });
        for (let index = 0; index < clients.length; index++) {
          expect(
            await clients[index].renewResourceLock({ ...lock, ownerId: `owner-${index}` }),
          ).toBe(index === winner);
        }
      },
    );

    it('extends only a matching live key and owner', async () => {
      await clients[0].acquireResourceLock(lock);
      harness.setTime(new Date(+now + 10_000));
      expect(await clients[1].renewResourceLock({ ...lock, ownerId: 'b' })).toBe(false);
      expect(await clients[1].renewResourceLock({ ...lock, key: 'missing' })).toBe(false);
      expect(await clients[0].renewResourceLock(lock)).toBe(true);
      expect(await harness.read(key)).toEqual({
        key,
        ownerId: 'a',
        expiresAt: new Date(+now + 40_000),
      });
    });

    it.each([0, 1])('cannot renew at or after expiry (offset %i ms)', async (offset) => {
      await harness.seed({ key, ownerId: 'a', expiresAt: new Date(+now - offset) });
      expect(await clients[0].renewResourceLock(lock)).toBe(false);
      expect(await harness.read(key)).toEqual({
        key,
        ownerId: 'a',
        expiresAt: new Date(+now - offset),
      });
    });

    it('can renew one millisecond before expiry', async () => {
      await harness.seed({ key, ownerId: 'a', expiresAt: new Date(+now + 1) });
      expect(await clients[0].renewResourceLock(lock)).toBe(true);
      expect((await harness.read(key))?.expiresAt).toEqual(new Date(+now + lock.ttlMs));
    });

    it('does not shorten expiry when shorter renewals race with a longer renewal', async () => {
      await clients[0].acquireResourceLock(lock);
      const results = await Promise.all(
        clients.map((client, index) =>
          client.renewResourceLock({ ...lock, ttlMs: [60_000, 1_000, 2_000][index] }),
        ),
      );
      expect(results).toEqual([true, true, true]);
      expect((await harness.read(key))?.expiresAt).toEqual(new Date(+now + 60_000));
    });

    it('releases only the matching key and owner, and repeated release is a no-op', async () => {
      await clients[0].acquireResourceLock(lock);
      await clients[0].acquireResourceLock({ ...lock, key: 'other' });
      expect(await clients[1].releaseResourceLock({ key, ownerId: 'b' })).toBe(false);
      expect(await clients[0].releaseResourceLock({ key: 'missing', ownerId: 'a' })).toBe(false);
      expect(await clients[1].acquireResourceLock({ ...lock, ownerId: 'b' })).toBe(false);
      expect(await clients[0].releaseResourceLock(lock)).toBe(true);
      expect(await clients[0].releaseResourceLock(lock)).toBe(false);
      expect(await clients[1].acquireResourceLock({ ...lock, ownerId: 'b' })).toBe(true);
      expect((await harness.read('other'))?.ownerId).toBe('a');
    });

    it('treats keys and owner tokens as opaque case-sensitive strings', async () => {
      await clients[0].acquireResourceLock({ ...lock, key: 'Key', ownerId: 'Owner' });
      expect(await clients[1].acquireResourceLock({ ...lock, key: 'key' })).toBe(true);
      expect(await clients[1].renewResourceLock({ ...lock, key: 'Key', ownerId: 'owner' })).toBe(
        false,
      );
      expect(await clients[1].releaseResourceLock({ key: 'Key', ownerId: 'owner' })).toBe(false);
      expect(await clients[0].releaseResourceLock({ key: 'Key', ownerId: 'Owner' })).toBe(true);
    });

    it('does not let a former owner renew or release a reacquired key', async () => {
      await clients[0].acquireResourceLock(lock);
      await clients[0].releaseResourceLock(lock);
      await clients[1].acquireResourceLock({ ...lock, ownerId: 'b' });
      expect(await clients[0].renewResourceLock(lock)).toBe(false);
      expect(await clients[0].releaseResourceLock(lock)).toBe(false);
      expect(await clients[1].renewResourceLock({ ...lock, ownerId: 'b' })).toBe(true);
      expect(await clients[1].releaseResourceLock({ key, ownerId: 'b' })).toBe(true);
    });

    it.each(['acquire', 'renew', 'release'] as const)(
      'propagates a persistence failure during %s without changing state',
      async (operation) => {
        if (operation !== 'acquire') await clients[0].acquireResourceLock(lock);
        const before = await harness.read(key);
        const failure = new Error('lease persistence unavailable');
        harness.failNext(operation, failure);
        const action = {
          acquire: () => clients[0].acquireResourceLock(lock),
          renew: () => clients[0].renewResourceLock(lock),
          release: () => clients[0].releaseResourceLock(lock),
        }[operation];
        await expect(action()).rejects.toBe(failure);
        expect(await harness.read(key)).toEqual(before);
      },
    );
  });
}
