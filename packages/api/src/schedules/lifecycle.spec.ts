import type { SchedulesServiceDeps } from './service';
import { InMemoryEventTransport } from '~/stream/implementations/InMemoryEventTransport';
import { createSchedulesService, recordScheduledMCPToolAuthFailure } from './service';
import { buildPendingAction, buildToolApprovalPayload } from '~/agents/hitl/policy';
import { InMemoryJobStore } from '~/stream/implementations/InMemoryJobStore';
import { GenerationJobManager } from '~/stream/GenerationJobManager';
import { ScheduledMCPBearerError } from './bearer';

const scheduledFor = '2026-10-01T00:00:00.000Z';
const identity = {
  scheduleId: 'schedule',
  ownerId: 'owner',
  tenantId: null,
  agentId: 'root',
  invocationMode: 'delegated' as const,
};

describe('scheduled denial lifecycle with the real generation manager', () => {
  let store: InMemoryJobStore;
  let service: ReturnType<typeof createSchedulesService>;
  let record: jest.Mock;
  let mongoAvailable: boolean;
  let dependencies: SchedulesServiceDeps;

  beforeEach(() => {
    store = new InMemoryJobStore({ ttlAfterComplete: 0 });
    GenerationJobManager.configure({
      jobStore: store,
      eventTransport: new InMemoryEventTransport(),
      isRedis: false,
      cleanupOnComplete: true,
    });
    GenerationJobManager.initialize();
    mongoAvailable = true;
    record = jest.fn(async () => {
      if (!mongoAvailable) throw new Error('Mongo unavailable');
    });
    dependencies = {
      methods: {
        recordRunOutcome: record,
        getScheduleById: async () => null,
        getScheduleRunAbortState: async () => ({ status: 'started', mcp: [] }),
        recordMCPToolAuthFailure: async () => {
          if (!mongoAvailable) throw new Error('Mongo unavailable');
          return true;
        },
        eraseScheduleIfDrained: async () => false,
      },
      getAppConfig: async () => ({}),
      findUserById: async () => null,
      findBalance: async () => null,
      upsertBalance: async () => null,
      initializeNullBalance: async () => null,
      preflightMCP: async () => [],
      resolveAgentFireAccess: async () => 'ok',
      getChatProject: async () => ({ _id: 'project' }),
      enqueueAgentTrigger: async () => undefined,
      isUserDeleting: async () => false,
      getTriggerDelivery: async () => null,
    } as unknown as SchedulesServiceDeps;
    service = createSchedulesService(dependencies);
  });

  afterEach(async () => {
    await GenerationJobManager.destroy({ settlementBudgetMs: 0 });
    jest.restoreAllMocks();
  });

  async function create() {
    const job = await GenerationJobManager.createJob('conversation', 'owner', 'conversation', {
      initialMetadata: {
        scheduleId: identity.scheduleId,
        scheduledFor,
        agent_id: identity.agentId,
      },
    });
    await service.recordMCPToolAuthFailure({
      error: new ScheduledMCPBearerError('consent_revoked', 'Files', 'child'),
      identity,
      streamId: job.streamId,
      jobCreatedAt: job.createdAt,
      userId: 'owner',
      serverName: 'Files',
    });
    return job;
  }

  it('holds a fresh pause persistence fence and provider drain, then parks accepted steers before settlement', async () => {
    const job = await create();
    const provider = job.metadata.providerExecutionId!;
    expect(
      await GenerationJobManager.beginProviderExecution(job.streamId, job.createdAt, provider),
    ).toBe(true);
    await store.enqueueSteer(
      job.streamId,
      { steerId: 'queued', userId: 'owner', text: 'next question', createdAt: Date.now() },
      job.createdAt,
    );
    const action = buildPendingAction(
      buildToolApprovalPayload([{ name: 'read', arguments: {}, tool_call_id: 'tool' }]),
      {
        streamId: job.streamId,
        conversationId: 'conversation',
        runId: 'run',
        responseMessageId: 'response',
      },
    );
    await GenerationJobManager.approvals.pause(job.streamId, action, { persistencePending: true });
    let finished = false;
    const abort = service.engineDeps
      .abortScheduledJob(
        job.streamId,
        { scheduleId: identity.scheduleId, scheduledFor, createdAt: job.createdAt },
        { preserve: true },
      )
      .then((value) => {
        finished = true;
        return value;
      });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(finished).toBe(false);
    expect(record).not.toHaveBeenCalled();
    expect((await store.getJob(job.streamId))?.status).toBe('requires_action');
    await GenerationJobManager.approvals.finishPausePersistence(
      job.streamId,
      action.actionId,
      job.createdAt,
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(finished).toBe(false);
    expect(record).not.toHaveBeenCalled();
    await GenerationJobManager.markProviderExecutionDrained(job.streamId, job.createdAt, provider);
    expect(await abort).toBe(true);
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'error',
        mcp: expect.arrayContaining([
          expect.objectContaining({ reason: 'consent_revoked', agentId: 'child' }),
        ]),
      }),
    );
    expect(JSON.parse((await store.claimParkedSteers(job.streamId, 'owner'))!).steers).toEqual(
      expect.arrayContaining([expect.objectContaining({ steerId: 'queued' })]),
    );
    expect(await store.getJob(job.streamId)).toBeNull();
  });

  it.each([true, false])(
    'never erases sole receipt on preserve=%s until Mongo settlement acknowledges it',
    async (preserve) => {
      const job = await create();
      mongoAvailable = false;
      const target = { scheduleId: identity.scheduleId, scheduledFor, createdAt: job.createdAt };
      expect(await service.engineDeps.abortScheduledJob(job.streamId, target, { preserve })).toBe(
        false,
      );
      expect((await store.getJob(job.streamId))?.preserveForScheduleReconcile).toBe(true);
      mongoAvailable = true;
      expect(await service.engineDeps.abortScheduledJob(job.streamId, target, { preserve })).toBe(
        true,
      );
      expect(record).toHaveBeenLastCalledWith(
        expect.objectContaining({
          status: 'error',
          mcp: expect.arrayContaining([expect.objectContaining({ reason: 'consent_revoked' })]),
        }),
      );
      expect(await store.getJob(job.streamId)).toBeNull();
    },
  );

  it('recovers an abandoned terminal persistence fence but never bypasses a fresh owner', async () => {
    const job = await create();
    await GenerationJobManager.claimTerminalJob(
      job.streamId,
      'complete',
      undefined,
      job.createdAt,
      { persistencePending: true },
    );
    await service.reconcileRetainedJobs();
    expect(record).not.toHaveBeenCalled();
    expect((await store.getJob(job.streamId))?.terminalPersistencePending).toBe(true);
    jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 60 * 60_000);
    await service.reconcileRetainedJobs();
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ status: 'error' }));
    expect(await store.getJob(job.streamId)).toBeNull();
  });

  it.each([false, true])(
    'assembles Mongo-only denial and parks a denied pause across restart=%s',
    async (restarted) => {
      const job = await GenerationJobManager.createJob('conversation', 'owner', 'conversation', {
        initialMetadata: {
          scheduleId: identity.scheduleId,
          scheduledFor,
          agent_id: identity.agentId,
        },
      });
      const provider = job.metadata.providerExecutionId!;
      await GenerationJobManager.beginProviderExecution(job.streamId, job.createdAt, provider);
      await store.enqueueSteer(
        job.streamId,
        { steerId: 'queued', userId: 'owner', text: 'next', createdAt: Date.now() },
        job.createdAt,
      );
      const action = buildPendingAction(
        buildToolApprovalPayload([{ name: 'read', arguments: {}, tool_call_id: 'tool' }]),
        {
          streamId: job.streamId,
          conversationId: 'conversation',
          runId: 'run',
          responseMessageId: 'response',
        },
      );
      await GenerationJobManager.approvals.pause(job.streamId, action);
      const error = new ScheduledMCPBearerError('consent_revoked', 'Files');
      dependencies.methods.recordMCPToolAuthFailure = async () => true;
      dependencies.methods.getScheduleRunAbortState = async () => ({
        status: 'started',
        mcp: error.outcomes,
      });
      let writes = 0;
      const update = store.updateJob.bind(store);
      jest.spyOn(store, 'updateJob').mockImplementation(async (...args) => {
        if (args[1].scheduleOutcomeError != null && ++writes <= 1)
          throw new Error('job evidence unavailable');
        return update(...args);
      });
      await service.recordMCPToolAuthFailure({
        error,
        identity,
        streamId: job.streamId,
        jobCreatedAt: job.createdAt,
        userId: 'owner',
        serverName: 'Files',
      });
      expect((await store.getJob(job.streamId))?.scheduleOutcomeError).toBeUndefined();
      if (restarted) service = createSchedulesService(dependencies);
      const outcome = {
        scheduleId: identity.scheduleId,
        scheduledFor,
        streamId: job.streamId,
        jobCreatedAt: job.createdAt,
        status: 'requires_action' as const,
      };
      expect(await service.recordScheduleOutcome(outcome)).toBe(false);
      expect(record).not.toHaveBeenCalled();
      expect(await store.getJob(job.streamId)).toMatchObject({
        status: 'requires_action',
        providerDrained: false,
        preserveForScheduleReconcile: true,
      });
      await GenerationJobManager.markProviderExecutionDrained(
        job.streamId,
        job.createdAt,
        provider,
      );
      expect(await service.recordScheduleOutcome(outcome)).toBe(true);
      expect(record).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'error', mcp: error.outcomes }),
      );
      expect(await store.getJob(job.streamId)).toBeNull();
      expect(JSON.parse((await store.claimParkedSteers(job.streamId, 'owner'))!).steers).toEqual(
        expect.arrayContaining([expect.objectContaining({ steerId: 'queued' })]),
      );
    },
  );

  it.each(['manager', 'store'] as const)(
    'cancels a retained stale local owner through %s cleanup but waits for its actual drain',
    async (cleanup) => {
      const job = await create();
      const provider = job.metadata.providerExecutionId!;
      await GenerationJobManager.beginProviderExecution(job.streamId, job.createdAt, provider);
      await store.enqueueSteer(
        job.streamId,
        { steerId: 'queued', userId: 'owner', text: 'next', createdAt: Date.now() },
        job.createdAt,
      );
      const subscription = await GenerationJobManager.subscribe(job.streamId, () => undefined);
      const clock = jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 60 * 60_000);
      if (cleanup === 'manager') await GenerationJobManager['cleanup']();
      else await store.cleanup();
      expect(job.abortController.signal.aborted).toBe(true);
      expect((await store.getJob(job.streamId))?.providerDrained).toBe(false);
      clock.mockReturnValue(Date.now() + 60_000);
      await service.reconcileRetainedJobs();
      expect(record).not.toHaveBeenCalled();
      expect((await store.getScheduleReconcileJobs(100))[0]).toMatchObject({
        preserveForScheduleReconcile: true,
        providerDrained: false,
      });
      expect((await store.getJob(job.streamId))?.scheduleOutcomeError).toContain('consent_revoked');
      await GenerationJobManager.markProviderExecutionDrained(
        job.streamId,
        job.createdAt,
        provider,
      );
      await service.reconcileRetainedJobs();
      expect(record).toHaveBeenCalledWith(expect.objectContaining({ status: 'error' }));
      expect(await store.getJob(job.streamId)).toBeNull();
      expect(JSON.parse((await store.claimParkedSteers(job.streamId, 'owner'))!).steers).toEqual(
        expect.arrayContaining([expect.objectContaining({ steerId: 'queued' })]),
      );
      subscription?.unsubscribe();
    },
  );

  it('detaches stale-owner cancellation from a replaced store and never aborts the successor epoch', async () => {
    const prior = await create();
    const originalStore = store;
    const retiredCallback = Reflect.get(originalStore, 'staleGenerationHandler') as (
      stream: string,
      epoch: number,
    ) => void;
    store = new InMemoryJobStore({ ttlAfterComplete: 0 });
    GenerationJobManager.configure({
      jobStore: store,
      eventTransport: new InMemoryEventTransport(),
      isRedis: false,
      cleanupOnComplete: true,
    });
    GenerationJobManager.initialize();
    const successor = await GenerationJobManager.createJob(prior.streamId, 'owner', prior.streamId);
    retiredCallback(prior.streamId, prior.createdAt);
    expect(successor.abortController.signal.aborted).toBe(false);
    expect(Reflect.get(originalStore, 'staleGenerationHandler')).toBeUndefined();
    await originalStore.destroy();
  });

  it('recovers a crashed owner without dropping its denial or accepted steers', async () => {
    const job = await create();
    await store.enqueueSteer(
      job.streamId,
      { steerId: 'queued', userId: 'owner', text: 'next', createdAt: Date.now() },
      job.createdAt,
    );
    jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 60 * 60_000);
    expect(await store.cleanup()).toBe(1);
    expect((await store.getJob(job.streamId))?.status).toBe('error');
    expect((await store.getJob(job.streamId))?.scheduleOutcomeError).toContain('consent_revoked');
    // No original service instance or active/unbookkept run query is required.
    await createSchedulesService(dependencies).reconcileRetainedJobs();
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'error',
        mcp: expect.arrayContaining([expect.objectContaining({ reason: 'consent_revoked' })]),
      }),
    );
    expect(await store.getJob(job.streamId)).toBeNull();
    expect(JSON.parse((await store.claimParkedSteers(job.streamId, 'owner'))!).steers).toEqual(
      expect.arrayContaining([expect.objectContaining({ steerId: 'queued' })]),
    );
  });

  it('retries a failed retention acknowledgement after Mongo has already settled and bookkept', async () => {
    const job = await create();
    await store.updateJob(
      job.streamId,
      { status: 'complete', completedAt: Date.now() },
      job.createdAt,
    );
    const update = store.updateJob.bind(store);
    const failure = jest.spyOn(store, 'updateJob').mockImplementation(async (...args) => {
      if (args[1].preserveForScheduleReconcile === false) throw new Error('release unavailable');
      return update(...args);
    });
    await service.recordScheduleOutcome({
      scheduleId: identity.scheduleId,
      scheduledFor,
      streamId: job.streamId,
      jobCreatedAt: job.createdAt,
      status: 'success',
    });
    expect(record).toHaveBeenCalled();
    expect((await store.getJob(job.streamId))?.preserveForScheduleReconcile).toBe(true);
    failure.mockRestore();
    await createSchedulesService(dependencies).reconcileRetainedJobs();
    expect(await store.getJob(job.streamId)).toBeNull();
    await expect(store.createJob(job.streamId, 'owner')).resolves.toMatchObject({
      status: 'running',
    });
  });

  it('does not acknowledge volatile job evidence while Mongo cannot persist the denial', async () => {
    const job = await GenerationJobManager.createJob('conversation', 'owner', 'conversation', {
      initialMetadata: {
        scheduleId: identity.scheduleId,
        scheduledFor,
        agent_id: identity.agentId,
      },
    });
    let durable = false;
    dependencies.methods.recordMCPToolAuthFailure = async () => durable;
    let returned = false;
    const pending = recordScheduledMCPToolAuthFailure(
      {
        error: new ScheduledMCPBearerError('consent_revoked', 'Files'),
        identity,
        streamId: job.streamId,
        jobCreatedAt: job.createdAt,
        userId: 'owner',
        serverName: 'Files',
      },
      () => service.recordMCPToolAuthFailure,
    ).then(() => {
      returned = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect((await store.getJob(job.streamId))?.scheduleOutcomeError).toContain('consent_revoked');
    expect(returned).toBe(false);
    durable = true;
    await pending;
    expect(returned).toBe(true);
  });

  it('blocks tool continuation during both-store failure and records the denial after recovery', async () => {
    const job = await GenerationJobManager.createJob('conversation', 'owner', 'conversation', {
      initialMetadata: {
        scheduleId: identity.scheduleId,
        scheduledFor,
        agent_id: identity.agentId,
      },
    });
    const input = {
      error: new ScheduledMCPBearerError('tool_policy_denied', 'Files'),
      identity,
      streamId: job.streamId,
      jobCreatedAt: job.createdAt,
      userId: 'owner',
      serverName: 'Files',
    };
    let unavailable = true;
    dependencies.methods.recordMCPToolAuthFailure = async () => {
      if (unavailable) throw new Error('Mongo unavailable');
      return true;
    };
    let returned = false;
    const update = store.updateJob.bind(store);
    jest.spyOn(store, 'updateJob').mockImplementation(async (...args) => {
      if (unavailable) throw new Error('Redis unavailable');
      return update(...args);
    });
    const pending = recordScheduledMCPToolAuthFailure(
      input,
      () => service.recordMCPToolAuthFailure,
    ).then(() => {
      returned = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(returned).toBe(false);
    expect(record).not.toHaveBeenCalled();
    unavailable = false;
    await pending;
    expect((await store.getJob(job.streamId))?.scheduleOutcome).toBe('error');
  });
});
