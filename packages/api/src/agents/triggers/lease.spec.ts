import type { ConversationMethods } from '@librechat/data-schemas';
import type { AbortResult } from '../../stream/interfaces/IJobStore';
import { createEventChildGenerationLeaseAcquirer } from './lease';

type LeaseMethods = Pick<
  ConversationMethods,
  'acquireSubagentThreadLease' | 'renewSubagentThreadLease' | 'releaseSubagentThreadLease'
>;

const stoppedResult = (failureReason?: AbortResult['failureReason']): AbortResult => ({
  success: failureReason == null,
  failureReason,
  jobData: null,
  content: [],
  finalEvent: null,
  text: '',
  collectedUsage: [],
});

describe('event child generation lease', () => {
  const acquireSubagentThreadLease = jest.fn<
    ReturnType<LeaseMethods['acquireSubagentThreadLease']>,
    Parameters<LeaseMethods['acquireSubagentThreadLease']>
  >();
  const renewSubagentThreadLease = jest.fn<
    ReturnType<LeaseMethods['renewSubagentThreadLease']>,
    Parameters<LeaseMethods['renewSubagentThreadLease']>
  >();
  const releaseSubagentThreadLease = jest.fn<
    ReturnType<LeaseMethods['releaseSubagentThreadLease']>,
    Parameters<LeaseMethods['releaseSubagentThreadLease']>
  >();
  const abortGeneration = jest.fn<
    Promise<AbortResult>,
    [string, { expectedCreatedAt: number; awaitProviderDrain: true }]
  >();
  const acquireEventChildGenerationLease = createEventChildGenerationLeaseAcquirer({
    methods: {
      acquireSubagentThreadLease,
      renewSubagentThreadLease,
      releaseSubagentThreadLease,
    },
    abortGeneration,
  });

  beforeEach(() => {
    jest.useFakeTimers({ now: new Date('2026-08-22T00:00:00.000Z') });
    jest.clearAllMocks();
    acquireSubagentThreadLease.mockResolvedValue(true);
    renewSubagentThreadLease.mockResolvedValue(true);
    releaseSubagentThreadLease.mockResolvedValue(true);
    abortGeneration.mockResolvedValue(stoppedResult());
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('rejects and releases an initial lease that resolves after its deadline', async () => {
    let resolveAcquisition: (acquired: boolean) => void = () => undefined;
    acquireSubagentThreadLease.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveAcquisition = resolve;
        }),
    );
    const acquisition = acquireEventChildGenerationLease({
      userId: 'user-1',
      tenantId: 'tenant-1',
      conversationId: 'child-1',
      streamId: 'child-1',
      jobCreatedAt: 123,
    });

    jest.setSystemTime(new Date('2026-08-22T00:00:30.001Z'));
    resolveAcquisition(true);

    await expect(acquisition).resolves.toBeNull();
    expect(releaseSubagentThreadLease).toHaveBeenCalledWith(
      expect.objectContaining({
        user: 'user-1',
        tenantId: 'tenant-1',
        conversationId: 'child-1',
      }),
    );
    expect(abortGeneration).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  });

  it('refreshes a near-expiry initial lease before accepting it', async () => {
    let resolveAcquisition: (acquired: boolean) => void = () => undefined;
    acquireSubagentThreadLease.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveAcquisition = resolve;
        }),
    );
    const acquisition = acquireEventChildGenerationLease({
      userId: 'user-1',
      conversationId: 'child-1',
      streamId: 'child-1',
      jobCreatedAt: 123,
    });

    jest.setSystemTime(new Date('2026-08-22T00:00:25.000Z'));
    resolveAcquisition(true);
    const release = await acquisition;

    expect(renewSubagentThreadLease).toHaveBeenCalledWith(
      expect.objectContaining({
        now: new Date('2026-08-22T00:00:25.000Z'),
        expiresAt: new Date('2026-08-22T00:00:55.000Z'),
      }),
    );
    expect(release).not.toBeNull();
    await release?.();
  });

  it('aborts when a renewal lands after continuous ownership expired', async () => {
    let resolveRenewal: (renewed: boolean) => void = () => undefined;
    renewSubagentThreadLease.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveRenewal = resolve;
        }),
    );
    const release = await acquireEventChildGenerationLease({
      userId: 'user-1',
      tenantId: 'tenant-1',
      conversationId: 'child-1',
      streamId: 'child-1',
      jobCreatedAt: 123,
    });

    jest.advanceTimersByTime(10_000);
    await Promise.resolve();
    jest.setSystemTime(new Date('2026-08-22T00:00:30.001Z'));
    resolveRenewal(true);
    await Promise.resolve();
    await Promise.resolve();

    expect(abortGeneration).toHaveBeenCalledWith('child-1', {
      expectedCreatedAt: 123,
      awaitProviderDrain: true,
    });
    await release?.();
  });

  it('aborts when renewal throws instead of silently running past expiry', async () => {
    renewSubagentThreadLease.mockRejectedValue(new Error('mongo unavailable'));
    const release = await acquireEventChildGenerationLease({
      userId: 'user-1',
      conversationId: 'child-1',
      streamId: 'child-1',
      jobCreatedAt: 123,
    });

    await jest.advanceTimersByTimeAsync(10_000);

    expect(abortGeneration).toHaveBeenCalledWith('child-1', {
      expectedCreatedAt: 123,
      awaitProviderDrain: true,
    });
    await release?.();
  });

  it('caps ownership and aborts the exact generation at the inherited retention deadline', async () => {
    const retentionExpiresAt = new Date('2026-08-22T00:00:05.000Z');
    const release = await acquireEventChildGenerationLease({
      userId: 'user-1',
      tenantId: 'tenant-1',
      conversationId: 'child-1',
      streamId: 'child-1',
      taskId: 'delivery-1',
      jobCreatedAt: 123,
      retentionExpiresAt,
    });

    expect(acquireSubagentThreadLease).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: 'delivery-1', expiresAt: retentionExpiresAt }),
    );
    await jest.advanceTimersByTimeAsync(4_999);
    expect(abortGeneration).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(1);
    expect(abortGeneration).toHaveBeenCalledWith('child-1', {
      expectedCreatedAt: 123,
      awaitProviderDrain: true,
    });
    await release?.();
  });

  it('retains the fence and retries an unconfirmed deadline abort', async () => {
    abortGeneration
      .mockResolvedValueOnce(stoppedResult('job_still_active'))
      .mockResolvedValueOnce(stoppedResult());
    const release = await acquireEventChildGenerationLease({
      userId: 'user-1',
      conversationId: 'child-1',
      streamId: 'child-1',
      jobCreatedAt: 123,
      retentionExpiresAt: new Date('2026-08-22T00:00:05.000Z'),
    });

    await jest.advanceTimersByTimeAsync(5_000);
    expect(abortGeneration).toHaveBeenCalledTimes(1);
    expect(releaseSubagentThreadLease).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(250);
    expect(abortGeneration).toHaveBeenCalledTimes(2);
    await release?.();
  });

  it('retains the fence and retries when the deadline abort throws', async () => {
    abortGeneration
      .mockRejectedValueOnce(new Error('abort store unavailable'))
      .mockResolvedValueOnce(stoppedResult());
    const release = await acquireEventChildGenerationLease({
      userId: 'user-1',
      conversationId: 'child-1',
      streamId: 'child-1',
      jobCreatedAt: 123,
      retentionExpiresAt: new Date('2026-08-22T00:00:05.000Z'),
    });

    await jest.advanceTimersByTimeAsync(5_250);
    expect(abortGeneration).toHaveBeenCalledTimes(2);
    expect(releaseSubagentThreadLease).not.toHaveBeenCalled();
    await release?.();
  });
});
