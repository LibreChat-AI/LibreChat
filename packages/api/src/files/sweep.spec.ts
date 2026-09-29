import { EModelEndpoint, FileSources } from 'librechat-data-provider';
import type { AppConfig } from '@librechat/data-schemas';
import {
  sweepExpiredFiles,
  startExpiredFileSweep,
  createClusteredFileSweep,
  getExpiredFileRetryDelay,
  getFileRetentionMaxAttempts,
  getFileRetentionSweepInterval,
} from './sweep';

describe('expired file sweep helpers', () => {
  const logger = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  };

  let deferExpiredFile: jest.Mock;
  let incrementFileDeletionAttempts: jest.Mock;
  let attemptCount: number;

  beforeEach(() => {
    jest.clearAllMocks();
    attemptCount = 0;
    incrementFileDeletionAttempts = jest.fn().mockImplementation(() => ++attemptCount);
    deferExpiredFile = jest.fn().mockResolvedValue(undefined);
    delete process.env.FILE_RETENTION_SWEEP_INTERVAL_MS;
    delete process.env.FILE_RETENTION_SWEEP_MAX_ATTEMPTS;
  });

  afterEach(() => {
    jest.useRealTimers();
    delete process.env.FILE_RETENTION_SWEEP_INTERVAL_MS;
    delete process.env.FILE_RETENTION_SWEEP_MAX_ATTEMPTS;
  });

  it('loads endpoint config and deletes expired OpenAI storage files', async () => {
    const getExpiredFiles = jest.fn().mockResolvedValue([
      {
        file_id: 'expired-openai-file',
        source: FileSources.openai,
        user: { toString: () => 'user-123' },
        tenantId: 'tenant-a',
      },
    ]);
    const processDeleteRequest = jest.fn().mockResolvedValue({
      deletedFileIds: ['expired-openai-file'],
      failedFileIds: [],
    });
    const loadAppConfig = jest.fn().mockResolvedValue({
      endpoints: {
        [EModelEndpoint.assistants]: { version: 'v3' },
      },
    } as AppConfig);

    const result = await sweepExpiredFiles(
      { appConfig: {} as AppConfig, loadAppConfig, limit: 1 },
      {
        getExpiredFiles,
        processDeleteRequest,
        incrementFileDeletionAttempts,
        deferExpiredFile,
        logger,
      },
    );

    expect(getExpiredFiles).toHaveBeenCalledWith(1);
    expect(deferExpiredFile).not.toHaveBeenCalled();
    expect(loadAppConfig).toHaveBeenCalledTimes(1);
    expect(processDeleteRequest).toHaveBeenCalledWith({
      req: expect.objectContaining({
        baseUrl: '/api/assistants/v3',
        originalUrl: '/api/assistants/v3/files',
        body: { endpoint: EModelEndpoint.assistants, version: '3' },
        user: { id: 'user-123', tenantId: 'tenant-a' },
      }),
      files: [expect.objectContaining({ file_id: 'expired-openai-file' })],
    });
    expect(result).toEqual({ scanned: 1, deleted: 1, failed: 0 });
  });

  it('counts files without owners as failed without deleting them', async () => {
    const getExpiredFiles = jest.fn().mockResolvedValue([{ file_id: 'orphaned-file' }]);
    const processDeleteRequest = jest.fn();

    const result = await sweepExpiredFiles(
      { appConfig: {} as AppConfig, limit: 1 },
      {
        getExpiredFiles,
        processDeleteRequest,
        incrementFileDeletionAttempts,
        deferExpiredFile,
        logger,
      },
    );

    expect(processDeleteRequest).not.toHaveBeenCalled();
    expect(deferExpiredFile).toHaveBeenCalledWith('orphaned-file', expect.any(Date));
    expect(logger.warn).toHaveBeenCalledWith(
      '[sweepExpiredFiles] Skipping expired file without user: orphaned-file',
    );
    expect(result).toEqual({ scanned: 1, deleted: 0, failed: 1 });
  });

  it.each([
    ['a rejected delete', { failedFileIds: ['stuck-file'], deletedFileIds: [] }],
    ['a delete that resolves nothing', { failedFileIds: [], deletedFileIds: [] }],
  ])('defers the file after %s', async (_case, outcome) => {
    const getExpiredFiles = jest
      .fn()
      .mockResolvedValue([{ file_id: 'stuck-file', user: 'user-1' }]);
    const processDeleteRequest = jest.fn().mockResolvedValue(outcome);

    const result = await sweepExpiredFiles(
      { appConfig: {} as AppConfig, limit: 1 },
      {
        getExpiredFiles,
        processDeleteRequest,
        incrementFileDeletionAttempts,
        deferExpiredFile,
        logger,
      },
    );

    const [fileId, retryAt] = deferExpiredFile.mock.calls[0];
    expect(fileId).toBe('stuck-file');
    /* Backoff comes off the attempt the increment returned, not the count
     * the queried snapshot carried. */
    expect(incrementFileDeletionAttempts).toHaveBeenCalledWith('stuck-file');
    expect(retryAt.getTime() - Date.now()).toBeCloseTo(60 * 60 * 1000, -3);
    expect(result).toEqual({ scanned: 1, deleted: 0, failed: 1 });
  });

  it('defers the file when the delete throws', async () => {
    const getExpiredFiles = jest
      .fn()
      .mockResolvedValue([{ file_id: 'stuck-file', user: 'user-1' }]);
    const processDeleteRequest = jest.fn().mockRejectedValue(new Error('storage unreachable'));

    const result = await sweepExpiredFiles(
      { appConfig: {} as AppConfig, limit: 1 },
      {
        getExpiredFiles,
        processDeleteRequest,
        incrementFileDeletionAttempts,
        deferExpiredFile,
        logger,
      },
    );

    expect(deferExpiredFile).toHaveBeenCalledWith('stuck-file', expect.any(Date));
    expect(result).toEqual({ scanned: 1, deleted: 0, failed: 1 });
  });

  it('reports parking once the file reaches the attempt cap', async () => {
    process.env.FILE_RETENTION_SWEEP_MAX_ATTEMPTS = '3';
    attemptCount = 2;
    deferExpiredFile.mockRejectedValue(new Error('mongo unreachable'));
    const getExpiredFiles = jest
      .fn()
      .mockResolvedValue([{ file_id: 'stranded-file', user: 'user-1' }]);
    const processDeleteRequest = jest
      .fn()
      .mockResolvedValue({ deletedFileIds: [], failedFileIds: ['stranded-file'] });

    await sweepExpiredFiles(
      { appConfig: {} as AppConfig, limit: 1 },
      {
        getExpiredFiles,
        processDeleteRequest,
        incrementFileDeletionAttempts,
        deferExpiredFile,
        logger,
      },
    );

    /* The counter is durable once the increment lands, so a deferral that
     * fails afterwards must not swallow the notice. */
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('Parking expired file stranded-file after 3 failed deletions'),
    );
  });

  it('reports the cap once, on the attempt that reaches it', async () => {
    process.env.FILE_RETENTION_SWEEP_MAX_ATTEMPTS = '3';
    attemptCount = 2;
    const getExpiredFiles = jest.fn().mockResolvedValue([
      { file_id: 'stranded-file', user: 'user-1' },
      { file_id: 'stranded-file', user: 'user-1' },
    ]);
    const processDeleteRequest = jest
      .fn()
      .mockResolvedValue({ deletedFileIds: [], failedFileIds: ['stranded-file'] });

    await sweepExpiredFiles(
      { appConfig: {} as AppConfig, limit: 2 },
      {
        getExpiredFiles,
        processDeleteRequest,
        incrementFileDeletionAttempts,
        deferExpiredFile,
        logger,
      },
    );

    /* Increments returned 3 and 4. Only the one that landed on the cap
     * reports it — another node past the threshold would otherwise repeat
     * the notice once per replica, per file. */
    const parked = logger.error.mock.calls.filter(([message]) =>
      String(message).includes('Parking expired file'),
    );
    expect(parked).toHaveLength(1);
  });

  it('anchors retry deadlines to the start of the sweep', async () => {
    const getExpiredFiles = jest.fn().mockImplementation(async () => {
      /* Deletion I/O pushes wall-clock past the sweep's start. Measuring
       * the deadline from here would land it just after the next scheduled
       * pass, costing the file a whole extra interval. */
      jest.setSystemTime(Date.now() + 30_000);
      return [{ file_id: 'stuck-file', user: 'user-1' }];
    });
    const processDeleteRequest = jest
      .fn()
      .mockResolvedValue({ deletedFileIds: [], failedFileIds: ['stuck-file'] });

    jest.useFakeTimers();
    const sweepStartedAt = Date.now();
    await sweepExpiredFiles(
      { appConfig: {} as AppConfig, limit: 1 },
      {
        getExpiredFiles,
        processDeleteRequest,
        incrementFileDeletionAttempts,
        deferExpiredFile,
        logger,
      },
    );

    const [, retryAt] = deferExpiredFile.mock.calls[0];
    expect(retryAt.getTime()).toBe(sweepStartedAt + 60 * 60 * 1000);
  });

  it('keeps sweeping the batch when recording a failure fails', async () => {
    const getExpiredFiles = jest.fn().mockResolvedValue([
      { file_id: 'stuck-file', user: 'user-1' },
      { file_id: 'deletable-file', user: 'user-1' },
    ]);
    const processDeleteRequest = jest
      .fn()
      .mockResolvedValueOnce({ deletedFileIds: [], failedFileIds: ['stuck-file'] })
      .mockResolvedValueOnce({ deletedFileIds: ['deletable-file'], failedFileIds: [] });
    incrementFileDeletionAttempts.mockRejectedValue(new Error('mongo unreachable'));

    const result = await sweepExpiredFiles(
      { appConfig: {} as AppConfig, limit: 2 },
      {
        getExpiredFiles,
        processDeleteRequest,
        incrementFileDeletionAttempts,
        deferExpiredFile,
        logger,
      },
    );

    expect(logger.error).toHaveBeenCalledWith(
      '[sweepExpiredFiles] Error recording failed deletion of expired file stuck-file:',
      expect.any(Error),
    );
    expect(result).toEqual({ scanned: 2, deleted: 1, failed: 1 });
  });

  it('climbs to a daily ladder, then parks, and ignores unusable attempt limits', () => {
    expect(getExpiredFileRetryDelay(1, 10)).toBe(60 * 60 * 1000);
    expect(getExpiredFileRetryDelay(4, 10)).toBe(8 * 60 * 60 * 1000);
    expect(getExpiredFileRetryDelay(9, 10)).toBe(24 * 60 * 60 * 1000);

    /* At the cap the file is parked rather than excluded, so a record
     * reused for different content is delayed at worst, never stranded. */
    expect(getExpiredFileRetryDelay(10, 10)).toBe(30 * 24 * 60 * 60 * 1000);
    expect(getExpiredFileRetryDelay(64, 10)).toBe(30 * 24 * 60 * 60 * 1000);

    /* The base tracks the configured cadence rather than a fixed hour. */
    process.env.FILE_RETENTION_SWEEP_INTERVAL_MS = String(5 * 60 * 1000);
    expect(getExpiredFileRetryDelay(1, 10)).toBe(5 * 60 * 1000);
    expect(getExpiredFileRetryDelay(3, 10)).toBe(20 * 60 * 1000);

    /* ...but never drops below the floor that protects the budget. */
    process.env.FILE_RETENTION_SWEEP_INTERVAL_MS = '5';
    expect(getExpiredFileRetryDelay(1, 10)).toBe(60 * 1000);
    delete process.env.FILE_RETENTION_SWEEP_INTERVAL_MS;

    expect(getFileRetentionMaxAttempts('0')).toBe(10);
    expect(getFileRetentionMaxAttempts('2.5')).toBe(10);
    expect(getFileRetentionMaxAttempts('   ')).toBe(10);
    expect(getFileRetentionMaxAttempts('25')).toBe(25);
  });

  it('falls back to the default interval for sub-millisecond values', () => {
    expect(getFileRetentionSweepInterval('0.5')).toBe(60 * 60 * 1000);
  });

  it('does not start the interval when the sweep is disabled', () => {
    process.env.FILE_RETENTION_SWEEP_INTERVAL_MS = '0';

    const interval = startExpiredFileSweep(
      { appConfig: {} as AppConfig },
      {
        sweepExpiredFiles: jest.fn(),
        runAsSystem: jest.fn((fn) => fn()),
        isLeader: jest.fn().mockResolvedValue(true),
        logger,
      },
    );

    expect(interval).toBeNull();
    expect(logger.info).toHaveBeenCalledWith(
      '[sweepExpiredFiles] Disabled by FILE_RETENTION_SWEEP_INTERVAL_MS=0',
    );
  });

  it.each([true, false])('joins local assignment and config in either order: %s', (assignFirst) => {
    const start = jest.fn().mockReturnValue(null);
    const coordinator = createClusteredFileSweep(false, start);
    const options = { appConfig: {} as AppConfig };
    if (assignFirst) coordinator.assign();
    else coordinator.configure(options);
    expect(start).not.toHaveBeenCalled();
    if (assignFirst) coordinator.configure(options);
    else coordinator.assign();
    coordinator.assign();
    coordinator.configure(options);
    expect(start).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledWith(options);
  });

  it('registers distributed candidates without primary assignment', () => {
    const start = jest.fn().mockReturnValue(null);
    const coordinator = createClusteredFileSweep(true, start);
    expect(start).not.toHaveBeenCalled();
    coordinator.configure({ appConfig: {} as AppConfig });
    coordinator.assign();
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('does not overlap a slow sweep with the next interval', async () => {
    jest.useFakeTimers();
    process.env.FILE_RETENTION_SWEEP_INTERVAL_MS = '1000';
    let finish!: () => void;
    const sweep = jest.fn().mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const isLeader = jest.fn().mockResolvedValue(true);
    const interval = startExpiredFileSweep(
      {},
      {
        sweepExpiredFiles: sweep,
        isLeader,
        runAsSystem: (fn) => fn(),
        logger,
      },
    );
    await jest.advanceTimersByTimeAsync(3000);
    expect(sweep).toHaveBeenCalledTimes(1);
    expect(isLeader).toHaveBeenCalledTimes(1);
    finish();
    await jest.advanceTimersByTimeAsync(1000);
    expect(sweep).toHaveBeenCalledTimes(2);
    finish();
    clearInterval(interval ?? undefined);
  });

  it('fails closed on leadership errors and retries on the next interval', async () => {
    jest.useFakeTimers();
    process.env.FILE_RETENTION_SWEEP_INTERVAL_MS = '1000';
    const sweep = jest.fn().mockResolvedValue({ scanned: 0, deleted: 0, failed: 0 });
    const isLeader = jest
      .fn()
      .mockRejectedValueOnce(new Error('redis down'))
      .mockResolvedValue(true);
    const interval = startExpiredFileSweep(
      {},
      {
        sweepExpiredFiles: sweep,
        isLeader,
        runAsSystem: (fn) => fn(),
        logger,
      },
    );
    await jest.advanceTimersByTimeAsync(0);
    expect(sweep).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1000);
    expect(sweep).toHaveBeenCalledTimes(1);
    clearInterval(interval ?? undefined);
  });

  it('runs the sweep only on the elected leader and permits follower takeover', async () => {
    jest.useFakeTimers();
    process.env.FILE_RETENTION_SWEEP_INTERVAL_MS = '1000';
    const sweep = jest.fn().mockResolvedValue({ scanned: 0, deleted: 0, failed: 0 });
    const runAsSystem = jest.fn((fn) => fn());
    const isLeader = jest.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);

    const interval = startExpiredFileSweep(
      { appConfig: {} as AppConfig },
      { sweepExpiredFiles: sweep, runAsSystem, isLeader, logger },
    );
    await jest.advanceTimersByTimeAsync(0);

    expect(isLeader).toHaveBeenCalledTimes(1);
    expect(runAsSystem).not.toHaveBeenCalled();
    expect(sweep).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(1000);

    expect(isLeader).toHaveBeenCalledTimes(2);
    expect(runAsSystem).toHaveBeenCalledTimes(1);
    expect(sweep).toHaveBeenCalledTimes(1);
    clearInterval(interval ?? undefined);
  });
});
