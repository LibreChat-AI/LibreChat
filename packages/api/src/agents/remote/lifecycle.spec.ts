import type { GenerationJobManagerClass } from '~/stream';
import {
  enrollAgentExecution,
  AgentExecutionAdmissionError,
  waitForAgentExecutionWrites,
} from './lifecycle';
import { InMemoryEventTransport } from '~/stream/implementations/InMemoryEventTransport';
import { InMemoryJobStore } from '~/stream/implementations/InMemoryJobStore';
import { GenerationJobManagerClass as JobManager } from '~/stream';

function createManager(): GenerationJobManagerClass {
  const manager = new JobManager();
  manager.configure({
    jobStore: new InMemoryJobStore({ ttlAfterComplete: 60_000 }),
    eventTransport: new InMemoryEventTransport(),
    cleanupOnComplete: false,
  });
  manager.initialize();
  return manager;
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function enrollmentParams(runId: string, conversationId = 'conversation-1') {
  return {
    runId,
    userId: 'user-1',
    conversationId,
    agentId: 'agent-1',
    protocol: 'chat.completions' as const,
    isPrincipalActive: jest.fn().mockResolvedValue(true),
  };
}

describe('Agent execution enrollment', () => {
  let manager: GenerationJobManagerClass;

  beforeEach(() => {
    manager = createManager();
  });

  afterEach(async () => {
    await manager.destroy();
  });

  it('registers a cleanup-blocking run before provider execution', async () => {
    const enrollment = await enrollAgentExecution(enrollmentParams('chatcmpl-1'), { manager });

    await expect(manager.getCleanupBlockingJobIdsForUser('user-1')).resolves.toEqual([
      'chatcmpl-1',
    ]);
    await expect(manager.getJobStore().getJob('chatcmpl-1')).resolves.toMatchObject({
      userId: 'user-1',
      conversationId: 'conversation-1',
      status: 'running',
      providerDrained: true,
      agent_id: 'agent-1',
      endpoint: 'chat.completions',
    });
    expect(enrollment.signal.aborted).toBe(false);
  });

  it('retires a run when account deletion wins the post-registration recheck', async () => {
    const beginProviderExecution = jest.spyOn(manager, 'beginProviderExecution');

    await expect(
      enrollAgentExecution(
        {
          ...enrollmentParams('chatcmpl-deleting'),
          isPrincipalActive: jest.fn().mockResolvedValue(false),
        },
        { manager },
      ),
    ).rejects.toMatchObject<Partial<AgentExecutionAdmissionError>>({
      code: 'ACCOUNT_DELETION_IN_PROGRESS',
      status: 409,
    });

    expect(beginProviderExecution).not.toHaveBeenCalled();
    await expect(manager.getCleanupBlockingJobIdsForUser('user-1')).resolves.toEqual([]);
    await expect(manager.getJobStore().getJob('chatcmpl-deleting')).resolves.toMatchObject({
      status: 'error',
      providerDrained: true,
    });
  });

  it('preserves principal-check infrastructure failures after retiring the run', async () => {
    const infrastructureError = new Error('principal store unavailable');

    await expect(
      enrollAgentExecution(
        {
          ...enrollmentParams('chatcmpl-principal-error'),
          isPrincipalActive: jest.fn().mockRejectedValue(infrastructureError),
        },
        { manager },
      ),
    ).rejects.toBe(infrastructureError);

    await expect(manager.getCleanupBlockingJobIdsForUser('user-1')).resolves.toEqual([]);
  });

  it('refuses provider admission when the request aborted during enrollment', async () => {
    const beginProviderExecution = jest.spyOn(manager, 'beginProviderExecution');
    const enrollment = await enrollAgentExecution(enrollmentParams('chatcmpl-disconnected'), {
      manager,
    });
    enrollment.abort();

    await expect(enrollment.beginProviderExecution()).rejects.toMatchObject({
      code: 'RUN_REPLACED',
    });
    expect(beginProviderExecution).not.toHaveBeenCalled();
  });

  it('retains drain ownership when provider-start commits but its acknowledgement is lost', async () => {
    const enrollment = await enrollAgentExecution(enrollmentParams('chatcmpl-start-ambiguous'), {
      manager,
    });
    const originalBeginProviderExecution = manager.beginProviderExecution.bind(manager);
    const beginProviderExecution = jest.spyOn(manager, 'beginProviderExecution');
    beginProviderExecution.mockImplementationOnce(async (...args) => {
      const started = await originalBeginProviderExecution(...args);
      expect(started).toBe(true);
      throw new Error('provider-start response lost');
    });

    await expect(enrollment.beginProviderExecution()).rejects.toThrow(
      'provider-start response lost',
    );
    await expect(enrollment.settle(new Error('provider did not start'))).resolves.toBeUndefined();

    await expect(manager.getJobStore().getJob('chatcmpl-start-ambiguous')).resolves.toMatchObject({
      status: 'error',
      providerDrained: true,
    });
    await expect(manager.getCleanupBlockingJobIdsForUser('user-1')).resolves.toEqual([]);
  });

  it('keeps terminal work cleanup-blocking until every tracked write settles', async () => {
    const enrollment = await enrollAgentExecution(enrollmentParams('chatcmpl-tail'), { manager });
    const tail = deferred<void>();
    enrollment.track(tail.promise);
    await enrollment.beginProviderExecution();

    const settlement = enrollment.settle();
    await new Promise<void>((resolve) => setImmediate(resolve));

    await expect(manager.getJobStore().getJob('chatcmpl-tail')).resolves.toMatchObject({
      status: 'complete',
      providerDrained: false,
    });
    await expect(manager.getCleanupBlockingJobIdsForUser('user-1')).resolves.toEqual([
      'chatcmpl-tail',
    ]);

    tail.resolve();
    await settlement;

    await expect(manager.getJobStore().getJob('chatcmpl-tail')).resolves.toMatchObject({
      status: 'complete',
      providerDrained: true,
    });
    await expect(manager.getCleanupBlockingJobIdsForUser('user-1')).resolves.toEqual([]);
  });

  it('retries terminalization after trailing writes when the first store attempt fails', async () => {
    const enrollment = await enrollAgentExecution(enrollmentParams('chatcmpl-terminal-retry'), {
      manager,
    });
    await enrollment.beginProviderExecution();
    const completeJob = jest
      .spyOn(manager, 'completeJob')
      .mockRejectedValueOnce(new Error('terminal store unavailable'));

    await expect(enrollment.settle()).resolves.toBeUndefined();

    expect(completeJob).toHaveBeenCalledTimes(2);
    await expect(manager.getJobStore().getJob('chatcmpl-terminal-retry')).resolves.toMatchObject({
      status: 'complete',
      providerDrained: true,
    });
    await expect(manager.getCleanupBlockingJobIdsForUser('user-1')).resolves.toEqual([]);
  });

  it('does not mark the provider drained while terminalization remains unavailable', async () => {
    const enrollment = await enrollAgentExecution(enrollmentParams('chatcmpl-terminal-outage'), {
      manager,
    });
    await enrollment.beginProviderExecution();
    jest
      .spyOn(manager, 'completeJob')
      .mockRejectedValueOnce(new Error('terminal store unavailable'))
      .mockRejectedValueOnce(new Error('terminal store still unavailable'));

    await expect(enrollment.settle()).rejects.toThrow('terminal store still unavailable');

    await expect(manager.getJobStore().getJob('chatcmpl-terminal-outage')).resolves.toMatchObject({
      status: 'running',
      providerDrained: false,
    });
    await expect(manager.getCleanupBlockingJobIdsForUser('user-1')).resolves.toEqual([
      'chatcmpl-terminal-outage',
    ]);
  });

  it('abandons the shutdown tracker when terminalization gives up, without recording a drain', async () => {
    const enrollment = await enrollAgentExecution(enrollmentParams('chatcmpl-terminal-abandon'), {
      manager,
    });
    await enrollment.beginProviderExecution();
    const abandon = jest.spyOn(manager, 'abandonProviderExecution');
    const drained = jest.spyOn(manager, 'markProviderExecutionDrained');
    jest
      .spyOn(manager, 'completeJob')
      .mockRejectedValueOnce(new Error('terminal store unavailable'))
      .mockRejectedValueOnce(new Error('terminal store still unavailable'));

    await expect(enrollment.settle()).rejects.toThrow('terminal store still unavailable');

    /** No marker on purpose — a successor must still see the truth — but the shutdown
     *  tracker has no other release path, so it is abandoned explicitly. */
    expect(drained).not.toHaveBeenCalled();
    expect(abandon).toHaveBeenCalledWith(
      'chatcmpl-terminal-abandon',
      expect.any(Number),
      expect.any(String),
    );
  });

  it('lets destructive cleanup abort the canonical signal and wait for trailing writes', async () => {
    const enrollment = await enrollAgentExecution(enrollmentParams('resp-delete'), { manager });
    const tail = deferred<void>();
    enrollment.track(tail.promise);
    await enrollment.beginProviderExecution();

    const abort = manager.abortJob('resp-delete', { awaitProviderDrain: true });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(enrollment.signal.aborted).toBe(true);

    let abortSettled = false;
    void abort.then(() => {
      abortSettled = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(abortSettled).toBe(false);

    const settlement = enrollment.settle(new Error('aborted'));
    tail.resolve();
    await settlement;
    await expect(abort).resolves.toMatchObject({ success: true });
  });

  it('keeps concurrent remote runs on one conversation independently enrolled', async () => {
    await Promise.all([
      enrollAgentExecution(enrollmentParams('chatcmpl-a', 'conversation-shared'), { manager }),
      enrollAgentExecution(enrollmentParams('chatcmpl-b', 'conversation-shared'), { manager }),
    ]);

    await expect(manager.getCleanupBlockingJobIdsForUser('user-1')).resolves.toEqual(
      expect.arrayContaining(['chatcmpl-a', 'chatcmpl-b']),
    );
    await expect(
      manager.getCleanupBlockingJobIdsForConversations('user-1', ['conversation-shared']),
    ).resolves.toEqual(expect.arrayContaining(['chatcmpl-a', 'chatcmpl-b']));
  });

  it('enumerates exact and legacy owner jobs for destructive account cleanup', async () => {
    const store = manager.getJobStore();
    const legacy = await store.createJob('legacy-owner-run', 'user-1', 'conversation-legacy');
    const exact = await store.createJob(
      'tenant-owner-run',
      'user-1',
      'conversation-tenant',
      'tenant-a',
    );
    await store.createJob('foreign-tenant-run', 'user-1', 'conversation-foreign', 'tenant-b');
    const cleanupBlocking = await manager.getCleanupBlockingJobIdsForUser('user-1', 'tenant-a');
    expect(cleanupBlocking).toEqual(
      expect.arrayContaining(['legacy-owner-run', 'tenant-owner-run']),
    );
    expect(cleanupBlocking).not.toContain('foreign-tenant-run');
    await store.transitionStatus('legacy-owner-run', {
      from: 'running',
      to: 'requires_action',
      expectCreatedAt: legacy.createdAt,
    });
    await store.transitionStatus('tenant-owner-run', {
      from: 'running',
      to: 'requires_action',
      expectCreatedAt: exact.createdAt,
    });

    await expect(manager.getCleanupBlockingJobIdsForUser('user-1', 'tenant-a')).resolves.toEqual(
      [],
    );
    await expect(manager.getAccountCleanupJobIdsForUser('user-1', 'tenant-a')).resolves.toEqual(
      expect.arrayContaining(['legacy-owner-run', 'tenant-owner-run']),
    );
    await expect(
      manager.getAccountCleanupJobIdsForUser('user-1', 'tenant-a'),
    ).resolves.not.toContain('foreign-tenant-run');
  });

  it('waits for every trailing write before reporting the first failure', async () => {
    const failure = new Error('artifact failed');
    const remaining = deferred<void>();
    let finished = false;
    const settlement = waitForAgentExecutionWrites([
      Promise.reject(failure),
      remaining.promise,
    ]).finally(() => {
      finished = true;
    });

    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(finished).toBe(false);

    remaining.resolve();
    await expect(settlement).rejects.toBe(failure);
  });
});
