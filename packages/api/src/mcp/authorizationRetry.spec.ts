import { logger } from '@librechat/data-schemas';
import type {
  MCPAuthorizationFenceRetryRecord,
  MCPAuthorizationFenceRetryStorage,
} from './authorizationRetry';
import { createMCPAuthorizationFenceRetryService } from './authorizationRetry';

const scope = { userId: 'user-1', serverName: 'server-1' };

function createHarness() {
  const records = new Map<string, MCPAuthorizationFenceRetryRecord>();
  const key = (
    tenantId: string | null | undefined,
    userId: string,
    serverName: string,
    version: string,
  ) => JSON.stringify([tenantId ?? '', userId, serverName, version]);
  const storage: MCPAuthorizationFenceRetryStorage = {
    upsert: jest.fn(async ({ scope: inputScope, tenantId, version, now }) => {
      records.set(key(tenantId, inputScope.userId, inputScope.serverName, version), {
        ...inputScope,
        tenantId,
        version,
        updatedAt: now,
      });
    }),
    deleteVersion: jest.fn(async ({ scope: inputScope, tenantId, version }) => {
      records.delete(key(tenantId, inputScope.userId, inputScope.serverName, version));
    }),
    deferVersion: jest.fn(async ({ scope: inputScope, tenantId, version, updatedAt }) => {
      const recordKey = key(tenantId, inputScope.userId, inputScope.serverName, version);
      const record = records.get(recordKey);
      if (record?.version === version) {
        record.updatedAt = updatedAt;
      }
    }),
    list: jest.fn(async (limit) =>
      [...records.values()]
        .sort((left, right) => left.updatedAt.getTime() - right.updatedAt.getTime())
        .slice(0, limit),
    ),
  };
  const runInRetryScope = jest.fn(async (_retry, operation) => operation());
  const registerShutdown = jest.fn();
  const service = createMCPAuthorizationFenceRetryService({
    storage,
    getTenantId: () => 'tenant-a',
    runInRetryScope,
    registerShutdown,
  });
  return { records, registerShutdown, runInRetryScope, service, storage };
}

describe('MCP authorization fence retry service', () => {
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('clears only the marker version created by that publisher', async () => {
    const { records, service, storage } = createHarness();
    const firstVersion = await service.persist(scope);
    const secondVersion = await service.persist(scope);

    await service.clear(scope, firstVersion);

    expect(storage.deleteVersion).toHaveBeenCalledWith({
      scope,
      tenantId: 'tenant-a',
      version: firstVersion,
    });
    expect([...records.values()]).toEqual([
      expect.objectContaining({ ...scope, version: secondVersion }),
    ]);
  });

  it('preserves every overlapping publication intent for the same scope', async () => {
    const { records, service } = createHarness();
    const firstVersion = await service.persist(scope);
    const secondVersion = await service.persist(scope);

    expect(records.size).toBe(2);
    expect([...records.values()].map(({ version }) => version)).toEqual([
      firstVersion,
      secondVersion,
    ]);
  });

  it('replays a bounded batch in tenant scope and deletes exact published versions', async () => {
    const { records, runInRetryScope, service, storage } = createHarness();
    const version = await service.persist(scope);
    const invalidate = jest.fn().mockResolvedValue(undefined);

    service.start(invalidate, { intervalMs: 5_000, batchSize: 7 });
    await service.drain();

    expect(storage.list).toHaveBeenCalledWith(7);
    expect(runInRetryScope).toHaveBeenCalledWith(
      expect.objectContaining({ ...scope, tenantId: 'tenant-a', version }),
      expect.any(Function),
    );
    expect(invalidate).toHaveBeenCalledWith(scope);
    expect(storage.deleteVersion).toHaveBeenCalledWith({
      scope,
      tenantId: 'tenant-a',
      version,
    });
    expect(records.size).toBe(0);
    await service.stop();
  });

  it('uses the configured cadence while a record is pending and registers clean shutdown', async () => {
    jest.useFakeTimers();
    jest.spyOn(logger, 'warn').mockImplementation(() => logger);
    const { registerShutdown, service, storage } = createHarness();
    await service.persist(scope);
    service.start(jest.fn().mockRejectedValue(new Error('cache unavailable')), {
      intervalMs: 2_500,
      batchSize: 3,
    });
    await service.drain();
    (storage.list as jest.Mock).mockClear();

    await jest.advanceTimersByTimeAsync(2_500);

    expect(storage.list).toHaveBeenCalledWith(3);
    expect(registerShutdown).toHaveBeenCalledWith(
      'MCP authorization fence retry worker',
      expect.any(Function),
    );
    await service.stop();
  });

  describe('idle back-off', () => {
    beforeEach(() => {
      jest.useFakeTimers();
      jest.spyOn(logger, 'warn').mockImplementation(() => logger);
    });
    afterEach(() => jest.restoreAllMocks());

    it('backs off while nothing is pending and returns to the base interval on work', async () => {
      const { records, service, storage } = createHarness();
      const invalidate = jest.fn().mockResolvedValue(undefined);
      service.start(invalidate, { intervalMs: 2_500 });
      await jest.advanceTimersByTimeAsync(0);
      expect(storage.list).toHaveBeenCalledTimes(1);

      /** Each empty pass doubles the wait, up to four times the base interval. */
      await jest.advanceTimersByTimeAsync(4_999);
      expect(storage.list).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(1);
      expect(storage.list).toHaveBeenCalledTimes(2);
      await jest.advanceTimersByTimeAsync(9_999);
      expect(storage.list).toHaveBeenCalledTimes(2);
      await jest.advanceTimersByTimeAsync(1);
      expect(storage.list).toHaveBeenCalledTimes(3);
      await jest.advanceTimersByTimeAsync(10_000);
      expect(storage.list).toHaveBeenCalledTimes(4);

      /** Another replica persists a marker: it is found at the next scheduled pass, replayed, and
       * the pass that follows is back on the base interval. */
      await storage.upsert({
        scope,
        tenantId: 'tenant-a',
        version: 'other-replica',
        now: new Date(),
      });
      await jest.advanceTimersByTimeAsync(10_000);
      expect(storage.list).toHaveBeenCalledTimes(5);
      expect(invalidate).toHaveBeenCalledWith(scope);
      expect(records.size).toBe(0);
      await jest.advanceTimersByTimeAsync(2_499);
      expect(storage.list).toHaveBeenCalledTimes(5);
      await jest.advanceTimersByTimeAsync(1);
      expect(storage.list).toHaveBeenCalledTimes(6);
      await service.stop();
    });

    it('stays on the base interval while a record keeps failing', async () => {
      const { service, storage } = createHarness();
      await service.persist(scope);
      service.start(jest.fn().mockRejectedValue(new Error('cache unavailable')), {
        intervalMs: 2_500,
      });
      await jest.advanceTimersByTimeAsync(0);
      for (let pass = 2; pass <= 5; pass += 1) {
        await jest.advanceTimersByTimeAsync(2_500);
        expect(storage.list).toHaveBeenCalledTimes(pass);
      }
      await service.stop();
    });

    it('honors an explicit idle ceiling', async () => {
      const { service, storage } = createHarness();
      service.start(jest.fn().mockResolvedValue(undefined), {
        intervalMs: 1_000,
        maxIdleIntervalMs: 1_500,
      });
      await jest.advanceTimersByTimeAsync(0);
      await jest.advanceTimersByTimeAsync(1_500);
      expect(storage.list).toHaveBeenCalledTimes(2);
      await jest.advanceTimersByTimeAsync(1_500);
      expect(storage.list).toHaveBeenCalledTimes(3);
      await service.stop();
    });

    it('logs an unreadable batch and retries at the base interval instead of backing off', async () => {
      const warn = jest.spyOn(logger, 'warn').mockImplementation(() => logger);
      const { service, storage } = createHarness();
      const failure = new Error('mongo unavailable');
      (storage.list as jest.Mock).mockRejectedValueOnce(failure);
      service.start(jest.fn().mockResolvedValue(undefined), { intervalMs: 2_500 });
      await jest.advanceTimersByTimeAsync(0);

      expect(warn).toHaveBeenCalledWith(
        '[MCP authorization] Could not read durable generation retries',
        failure,
      );
      await jest.advanceTimersByTimeAsync(2_500);
      expect(storage.list).toHaveBeenCalledTimes(2);
      await service.stop();
    });

    it('looks again one base interval after a marker is persisted, even while backed off', async () => {
      const { records, service, storage } = createHarness();
      const invalidate = jest.fn().mockResolvedValue(undefined);
      service.start(invalidate, { intervalMs: 2_500 });
      await jest.advanceTimersByTimeAsync(0);
      (storage.list as jest.Mock).mockClear();

      /** The loop is now waiting 5 s; a publisher that fails to clear its marker is due sooner. */
      await service.persist(scope);
      await jest.advanceTimersByTimeAsync(2_499);
      expect(storage.list).not.toHaveBeenCalled();
      await jest.advanceTimersByTimeAsync(1);
      expect(storage.list).toHaveBeenCalledTimes(1);
      expect(invalidate).toHaveBeenCalledWith(scope);
      expect(records.size).toBe(0);
      await service.stop();
    });

    it('costs one read per base interval however often markers are persisted and cleared', async () => {
      const { service, storage } = createHarness();
      const invalidate = jest.fn().mockResolvedValue(undefined);
      service.start(invalidate, { intervalMs: 30_000 });
      await jest.advanceTimersByTimeAsync(0);

      /** A publication every second for 90 s, each cleared at once: nothing is ever left to replay. */
      for (let second = 0; second < 90; second += 1) {
        await service.clear(scope, await service.persist(scope));
        await jest.advanceTimersByTimeAsync(1_000);
      }

      /** Reads at 0, 30, 60 and 90 s, as the fixed timer made them, not one per publication. */
      expect(storage.list).toHaveBeenCalledTimes(4);
      expect(invalidate).not.toHaveBeenCalled();
      await service.stop();
    });

    it('finds nothing to replay when the publisher cleared its marker in time', async () => {
      const { service, storage } = createHarness();
      const invalidate = jest.fn().mockResolvedValue(undefined);
      service.start(invalidate, { intervalMs: 2_500 });
      await jest.advanceTimersByTimeAsync(0);
      (storage.list as jest.Mock).mockClear();

      await service.clear(scope, await service.persist(scope));
      await jest.advanceTimersByTimeAsync(2_500);

      expect(storage.list).toHaveBeenCalledTimes(1);
      expect(invalidate).not.toHaveBeenCalled();
      await service.stop();
    });

    it('leaves no timer behind after stop, and ignores markers persisted afterwards', async () => {
      const { service, storage } = createHarness();
      service.start(jest.fn().mockResolvedValue(undefined), { intervalMs: 2_500 });
      await jest.advanceTimersByTimeAsync(0);
      await service.stop();
      (storage.list as jest.Mock).mockClear();

      await service.persist(scope);
      await jest.advanceTimersByTimeAsync(600_000);

      expect(storage.list).not.toHaveBeenCalled();
      expect(jest.getTimerCount()).toBe(0);
    });
  });

  it('times out and defers a failed oldest record so later retries are not starved', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    const { records, service, storage } = createHarness();
    await service.persist({ userId: 'user-1', serverName: 'first' });
    jest.setSystemTime(new Date('2026-01-01T00:00:00.001Z'));
    await service.persist({ userId: 'user-1', serverName: 'second' });
    let finishFirst: (() => void) | undefined;
    const firstAttempt = new Promise<void>((resolve) => {
      finishFirst = resolve;
    });
    const invalidate = jest.fn(({ serverName }: typeof scope) =>
      serverName === 'first' ? firstAttempt : Promise.resolve(),
    );

    service.start(invalidate, { intervalMs: 10_000, batchSize: 1, attemptTimeoutMs: 5 });
    const firstDrain = service.drain();
    await jest.advanceTimersByTimeAsync(5);
    await firstDrain;
    await service.drain();
    const thirdDrain = service.drain();
    await jest.advanceTimersByTimeAsync(5);
    await thirdDrain;

    expect(invalidate).toHaveBeenNthCalledWith(1, { userId: 'user-1', serverName: 'first' });
    expect(invalidate).toHaveBeenNthCalledWith(2, { userId: 'user-1', serverName: 'second' });
    expect(invalidate).toHaveBeenNthCalledWith(3, { userId: 'user-1', serverName: 'first' });
    expect(invalidate).toHaveBeenCalledTimes(3);
    expect(storage.deferVersion).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: { userId: 'user-1', serverName: 'first' },
        updatedAt: new Date('2026-01-01T00:00:00.006Z'),
      }),
    );
    expect([...records.values()].map(({ serverName }) => serverName)).toEqual(['first']);
    finishFirst?.();
    await firstAttempt;
    await service.drain();
    expect(records.size).toBe(0);
    await service.stop();
  });

  it('bounds a stalled deferral so the worker can drain again', async () => {
    jest.useFakeTimers();
    const { service, storage } = createHarness();
    await service.persist(scope);
    (storage.deferVersion as jest.Mock).mockImplementationOnce(() => new Promise(() => undefined));
    service.start(
      jest.fn(() => new Promise(() => undefined)),
      {
        intervalMs: 10_000,
        batchSize: 1,
        attemptTimeoutMs: 5,
      },
    );

    const firstDrain = service.drain();
    await jest.advanceTimersByTimeAsync(10);
    await firstDrain;
    const secondDrain = service.drain();
    await jest.advanceTimersByTimeAsync(10);
    await secondDrain;

    expect(storage.list).toHaveBeenCalledTimes(2);
    await service.stop();
  });
});
