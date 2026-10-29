import type { GenerationJobManagerClass } from '~/stream';
import {
  enrollAgentExecution,
  AgentExecutionEnrollment,
  AgentExecutionAdmissionError,
  waitForAgentExecutionWrites,
} from './lifecycle';
import { InMemoryEventTransport } from '~/stream/implementations/InMemoryEventTransport';
import { InMemoryJobStore } from '~/stream/implementations/InMemoryJobStore';
import { GenerationJobManagerClass as JobManager } from '~/stream';
import { buildPendingAction } from '../hitl/policy';

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

  function action(runId: string) {
    return buildPendingAction(
      { type: 'ask_user_question', question: { question: 'Which environment?' } },
      {
        streamId: runId,
        responseMessageId: runId,
        conversationId: 'conversation-1',
        runId,
        ttlMs: 60_000,
      },
    );
  }

  it('retains a drained paused Stop when its required journal write fails with default cleanup', async () => {
    manager.configure({
      jobStore: new InMemoryJobStore({ ttlAfterComplete: 60_000 }),
      eventTransport: new InMemoryEventTransport(),
    });
    const execution = await enrollAgentExecution(
      { ...enrollmentParams('resp-stop-failure'), retainTerminalPersistence: true },
      { manager },
    );
    await execution.beginProviderExecution();
    await execution.pauseForReview(action(execution.runId), async () => {});
    await execution.settle();
    const before = (await manager.getJob(execution.runId))!;
    const stopped = await manager.abortJob(execution.runId, {
      expectedCreatedAt: execution.createdAt,
      awaitProviderDrain: true,
      retainTerminalPersistence: true,
      beforePublish: async () => {
        throw new Error('Injected cancellation journal failure');
      },
    });
    expect(stopped.persistenceFailed).toBe(true);
    expect(await manager.getJob(execution.runId)).toMatchObject({
      status: 'aborted',
      createdAt: execution.createdAt,
      metadata: { providerDrained: true, terminalPersistencePending: true },
    });
    expect(
      await manager.finishProviderTerminalPersistence(
        execution.runId,
        execution.createdAt,
        before.metadata.providerExecutionId!,
      ),
    ).toBe(true);
    expect(await manager.getJob(execution.runId)).toBeUndefined();
  });

  it('rejects retained terminal publication before provider work on an unsupported store', async () => {
    const store = manager.getJobStore();
    Object.defineProperty(store, 'providerTerminalPersistence', { value: undefined });
    await expect(
      enrollAgentExecution(
        { ...enrollmentParams('resp-unsupported'), retainTerminalPersistence: true },
        { manager },
      ),
    ).rejects.toThrow('Agent terminal persistence barrier is unavailable');
    expect(await manager.getJob('resp-unsupported')).toBeUndefined();
  });

  it('keeps a review pause nonterminal and blocks resume until writes and provider drain settle', async () => {
    const enrollment = await enrollAgentExecution(enrollmentParams('resp-paused'), { manager });
    await enrollment.beginProviderExecution();
    const tail = deferred<void>();
    enrollment.track(tail.promise);
    const pending = action(enrollment.runId);
    const complete = jest.spyOn(manager, 'completeJob');
    const persist = jest.fn(async () => {});
    expect(await enrollment.pauseForReview(pending, persist)).toBe(true);
    expect(persist).toHaveBeenCalledTimes(1);
    const settling = enrollment.settle();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(enrollment.isPaused).toBe(false);
    expect(await manager.getJobStore().getJob(enrollment.runId)).toMatchObject({
      status: 'requires_action',
      providerDrained: false,
      terminalPersistencePending: true,
    });
    let resolved = false;
    const resume = manager.approvals
      .resolve(
        enrollment.runId,
        pending.actionId,
        {
          providerExecutionId: 'resumed-provider',
          providerDrained: true,
        },
        enrollment.createdAt,
      )
      .then((won) => {
        resolved = won;
        return won;
      });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(resolved).toBe(false);
    tail.resolve();
    await settling;
    expect(enrollment.isPaused).toBe(true);
    expect(complete).not.toHaveBeenCalled();
    await expect(resume).resolves.toBe(true);
    expect(await manager.getJobStore().getJob(enrollment.runId)).toMatchObject({
      status: 'running',
      providerExecutionId: 'resumed-provider',
    });
  });

  it('fails the exact pause without exposing it for resume when required persistence fails', async () => {
    const enrollment = await enrollAgentExecution(enrollmentParams('resp-pause-write-failed'), {
      manager,
    });
    await enrollment.beginProviderExecution();
    const pending = action(enrollment.runId);
    const failure = new Error('private-storage-details');
    await expect(
      enrollment.pauseForReview(pending, async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
    await enrollment.settle(failure);
    expect(enrollment.isPaused).toBe(false);
    const job = await manager.getJobStore().getJob(enrollment.runId);
    expect(job).toMatchObject({ status: 'error', providerDrained: true });
    expect(JSON.stringify(job)).not.toContain('private-storage-details');
    await expect(manager.approvals.resolve(enrollment.runId, pending.actionId)).resolves.toBe(
      false,
    );
  });

  it('does not publish review readiness when a trailing artifact write fails', async () => {
    const enrollment = await enrollAgentExecution(enrollmentParams('resp-pause-artifact-failed'), {
      manager,
    });
    await enrollment.beginProviderExecution();
    const failure = new Error('private-artifact-details');
    enrollment.track(Promise.reject(failure));
    await enrollment.pauseForReview(action(enrollment.runId), async () => {});
    await expect(enrollment.settle()).rejects.toBe(failure);
    expect(enrollment.isPaused).toBe(false);
    expect(await manager.getJobStore().getJob(enrollment.runId)).toMatchObject({
      status: 'error',
      providerDrained: true,
    });
  });

  it('rejects a foreign approval identity before writing an unfinished response', async () => {
    const enrollment = await enrollAgentExecution(enrollmentParams('resp-pause-identity'), {
      manager,
    });
    await enrollment.beginProviderExecution();
    const persist = jest.fn(async () => {});
    await expect(
      enrollment.pauseForReview(
        { ...action(enrollment.runId), conversationId: 'foreign' },
        persist,
      ),
    ).rejects.toThrow('identity');
    expect(persist).not.toHaveBeenCalled();
    expect(await manager.getJobStore().getJob(enrollment.runId)).toMatchObject({
      status: 'running',
    });
    await enrollment.settle();
  });

  it('reconciles a lost pause acknowledgement without publishing a second action', async () => {
    const enrollment = await enrollAgentExecution(enrollmentParams('resp-pause-ack'), { manager });
    await enrollment.beginProviderExecution();
    const pause = manager.approvals.pause.bind(manager.approvals);
    const paused = jest
      .spyOn(manager.approvals, 'pause')
      .mockImplementationOnce(async (...args) => {
        await pause(...args);
        throw new Error('lost acknowledgement');
      });
    const persist = jest.fn(async () => {});
    expect(await enrollment.pauseForReview(action(enrollment.runId), persist)).toBe(true);
    await enrollment.settle();
    expect(paused).toHaveBeenCalledTimes(1);
    expect(persist).toHaveBeenCalledTimes(1);
    expect(enrollment.isPaused).toBe(true);
  });

  it('cannot pause or terminalize a resumed provider segment from an old callback', async () => {
    const enrollment = await enrollAgentExecution(enrollmentParams('resp-pause-stale-provider'), {
      manager,
    });
    await enrollment.beginProviderExecution();
    const pause = manager.approvals.pause.bind(manager.approvals);
    jest.spyOn(manager.approvals, 'pause').mockImplementationOnce(async (...args) => {
      await manager
        .getJobStore()
        .updateJob(
          enrollment.runId,
          { providerExecutionId: 'successor-provider' },
          enrollment.createdAt,
        );
      return pause(...args);
    });
    const persist = jest.fn(async () => {});
    expect(await enrollment.pauseForReview(action(enrollment.runId), persist)).toBe(false);
    expect(persist).not.toHaveBeenCalled();
    await expect(enrollment.settle()).rejects.toThrow('drain');
    expect(await manager.getJobStore().getJob(enrollment.runId)).toMatchObject({
      status: 'running',
      providerExecutionId: 'successor-provider',
    });
  });

  it('requires custom stores to explicitly support atomic provider guards', async () => {
    const enrollment = await enrollAgentExecution(enrollmentParams('resp-pause-custom-store'), {
      manager,
    });
    await enrollment.beginProviderExecution();
    Object.defineProperty(manager.getJobStore(), 'providerGuardedStatusTransitions', {
      value: undefined,
    });
    await expect(
      enrollment.pauseForReview(action(enrollment.runId), async () => {}),
    ).rejects.toThrow('provider-guarded');
    await enrollment.settle();
  });

  it('does not terminalize a successor that appears between terminal read and CAS', async () => {
    const enrollment = await enrollAgentExecution(enrollmentParams('resp-terminal-provider-race'), {
      manager,
    });
    await enrollment.beginProviderExecution();
    const store = manager.getJobStore();
    const transition = store.transitionStatusAndDrainSteers.bind(store);
    jest.spyOn(store, 'transitionStatusAndDrainSteers').mockImplementationOnce(async (...args) => {
      await store.updateJob(
        enrollment.runId,
        { providerExecutionId: 'successor-provider' },
        enrollment.createdAt,
      );
      return transition(...args);
    });
    await expect(enrollment.settle()).rejects.toThrow('drain');
    expect(await store.getJob(enrollment.runId)).toMatchObject({
      status: 'running',
      providerExecutionId: 'successor-provider',
    });
    expect((await manager.getJob(enrollment.runId))?.abortController.signal.aborted).toBe(false);
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
    await expect(manager.getJobStore().getJob('chatcmpl-deleting')).resolves.toBeNull();
  });

  it('reports principal-check infrastructure failures with a sanitized error after retiring the run', async () => {
    const infrastructureError = new Error('principal store unavailable');

    await expect(
      enrollAgentExecution(
        {
          ...enrollmentParams('chatcmpl-principal-error'),
          isPrincipalActive: jest.fn().mockRejectedValue(infrastructureError),
        },
        { manager },
      ),
    ).rejects.toMatchObject({ code: 'GENERATION_ADMISSION_UNAVAILABLE' });

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

  it('does not let a duplicate start loser terminalize or drain the winning execution', async () => {
    const winner = await enrollAgentExecution(enrollmentParams('duplicate-start'), { manager });
    const duplicate = new AgentExecutionEnrollment(manager, (await manager.getJob(winner.runId))!);
    await winner.beginProviderExecution();
    const complete = jest.spyOn(manager, 'completeJob');
    const drain = jest.spyOn(manager, 'markProviderExecutionDrained');
    await expect(duplicate.beginProviderExecution()).rejects.toMatchObject({
      code: 'RUN_REPLACED',
    });
    expect(duplicate.isStartRejected).toBe(true);
    await duplicate.settle(new Error('Duplicate has no execution ownership'));
    expect(complete).not.toHaveBeenCalled();
    expect(drain).not.toHaveBeenCalled();
    expect(await manager.getJob(winner.runId)).toMatchObject({
      status: 'running',
      metadata: { providerDrained: false },
    });
    await winner.settle();
  });

  it('keeps shutdown waiting for the winner after a duplicate start was refused', async () => {
    const winner = await enrollAgentExecution(enrollmentParams('duplicate-shutdown'), { manager });
    await winner.beginProviderExecution();
    const job = (await manager.getJob(winner.runId))!;
    expect(
      await manager.beginProviderExecution(
        winner.runId,
        winner.createdAt,
        job.metadata.providerExecutionId!,
      ),
    ).toBe(false);
    const destroyStore = jest.spyOn(manager.getJobStore(), 'destroy');
    const shutdown = manager.destroy({ settlementBudgetMs: 1000 });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(destroyStore).not.toHaveBeenCalled();
    await winner.settle();
    await shutdown;
    expect(destroyStore).toHaveBeenCalledTimes(1);
  });

  it('refuses a duplicate locally while the first provider-start CAS is still pending', async () => {
    const enrollment = await enrollAgentExecution(enrollmentParams('pending-provider-start'), {
      manager,
    });
    const job = (await manager.getJob(enrollment.runId))!;
    const store = manager.getJobStore();
    const originalStart = store.beginProviderExecution!.bind(store);
    const gate = deferred<void>();
    const start = jest
      .spyOn(store, 'beginProviderExecution')
      .mockImplementationOnce(async (...args) => {
        await gate.promise;
        return originalStart(...args);
      });
    const winningStart = enrollment.beginProviderExecution();
    expect(
      await manager.beginProviderExecution(
        enrollment.runId,
        enrollment.createdAt,
        job.metadata.providerExecutionId!,
      ),
    ).toBe(false);
    expect(start).toHaveBeenCalledTimes(1);
    gate.resolve();
    await winningStart;
    expect((await manager.getJob(enrollment.runId))?.metadata.providerDrained).toBe(false);
    await enrollment.settle();
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
