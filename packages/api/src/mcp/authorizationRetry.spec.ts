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
  afterEach(() => jest.useRealTimers());

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

  it('uses the configured cadence and registers clean shutdown', async () => {
    jest.useFakeTimers();
    const { registerShutdown, service, storage } = createHarness();
    service.start(jest.fn().mockResolvedValue(undefined), { intervalMs: 2_500, batchSize: 3 });
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
