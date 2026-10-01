import { logger } from '@librechat/data-schemas';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import type { SchedulesServiceDeps } from './service';
import { createSchedulesService, recordScheduledMCPToolAuthFailure } from './service';
import { OboTokenResolutionError } from '../mcp/oauth/obo';
import { isShutdownInProgress } from '../app/shutdown';

/** Swappable per test: null keeps the no-job-store harness the drain tests rely on. */
let mockJobStore: { getJob: jest.Mock; deleteJob?: jest.Mock } | null = null;

jest.mock('../agents/checkpointer', () => ({
  checkpointStorageConfigs: jest.fn(async (_user, _tenant, cfg) => [cfg]),
  deleteAgentCheckpoint: jest.fn(async () => undefined),
  // Non-empty by default so the scoped prune has something to delete in tests.
  captureAgentCheckpointGeneration: jest.fn(async (threadId: string) => ({
    threadId,
    checkpointIds: ['ck-1'],
  })),
}));
const checkpointerModule = jest.requireMock('../agents/checkpointer') as {
  checkpointStorageConfigs: jest.Mock;
  deleteAgentCheckpoint: jest.Mock;
  captureAgentCheckpointGeneration: jest.Mock;
};

jest.mock('../stream/GenerationJobManager', () => ({
  GenerationJobManager: {
    // No configured job store by default: abortScheduledJob returns false, so the drain
    // loop is driven purely by getActiveRunsForUser (the run rows).
    getJobStore: () => mockJobStore,
    abortJob: jest.fn(),
    updateMetadata: jest.fn(async () => undefined),
    isRedis: false,
  },
}));

type ActiveRun = {
  scheduleId: string;
  scheduledFor: Date;
  conversationId?: string;
  checkpointNamespace?: string;
  status?: string;
};

let recordRunOutcome: jest.Mock;

function makeService(
  getActiveRunsForUser: jest.Mock<Promise<ActiveRun[]>, [string]>,
  getAppConfig?: SchedulesServiceDeps['getAppConfig'],
  enqueueAgentTrigger: SchedulesServiceDeps['enqueueAgentTrigger'] = jest.fn(async () => undefined),
): ReturnType<typeof createSchedulesService> {
  recordRunOutcome = jest.fn(async () => undefined);
  const methods = {
    suspendUserSchedulesForDeletion: jest.fn(async () => undefined),
    restoreUserSchedulesFromDeletion: jest.fn(async () => undefined),
    getActiveRunsForUser,
    countActiveRuns: jest.fn(async () => 0),
    requestRunAbort: jest.fn(async () => true),
    getScheduleRunAbortState: jest.fn(async () => null),
    recordMCPToolAuthFailure: jest.fn(async () => true),
    markRunAbortPersisted: jest.fn(async () => undefined),
    recordRunOutcome,
  };
  const deps = {
    methods,
    getAppConfig: getAppConfig ?? jest.fn(async () => ({})),
    findUserById: jest.fn(async () => null),
    findBalance: jest.fn(async () => null),
    upsertBalance: jest.fn(async () => null),
    initializeNullBalance: jest.fn(async () => null),
    preflightMCP: jest.fn().mockResolvedValue([]),
    resolveAgentFireAccess: jest.fn(async () => 'ok' as const),
    getChatProject: jest.fn(async () => ({ _id: 'proj-1' })),
    isUserDeleting: jest.fn(async () => false),
    enqueueAgentTrigger,
    getTriggerDelivery: jest.fn(async () => null),
  } as unknown as SchedulesServiceDeps;
  // Short bounded waits so fail-closed drain paths resolve in test time.
  return createSchedulesService(deps, {
    drainTimeoutMs: 400,
    drainPollMs: 25,
    stopBarrierTimeoutMs: 400,
    stopBarrierPollMs: 25,
  });
}

const run = (): ActiveRun => ({
  scheduleId: 's1',
  scheduledFor: new Date('2026-01-01T00:00:00.000Z'),
  conversationId: 'c1',
});

describe('shutdown wiring', () => {
  it('carries the coordinator signal on the BASE deps so Run Now is gated too', async () => {
    const service = makeService(jest.fn(async (_userId: string) => []));
    // fireScheduleNow dispatches with engineDeps directly (not the engine's
    // per-pass wrapper), so the shutdown gate must live on the base deps or a
    // manual Run Now POSTs into a closing listener.
    expect(service.engineDeps.isShuttingDown).toBe(isShutdownInProgress);
  });
});

describe('manual Run Now lease cleanup', () => {
  it('releases the old holder when an owner edit fences cleanup after a preflight throw', async () => {
    const service = makeService(jest.fn(async (_userId: string) => []));
    const leased = {
      id: 's1',
      user: 'user-1',
      tenantId: 't1',
      name: 'Digest',
      prompt: 'Summarize',
      agent_id: 'agent-1',
      cadence: { frequency: 'daily', hour: 8, minute: 0 },
      timezone: 'America/New_York',
      target: 'new',
      enabled: true,
      claimToken: 'manual-token',
      leaseBy: 'manual-holder',
      runCount: 0,
      failureCount: 0,
      balanceSkipCount: 0,
    } as never;
    const methods = service.engineDeps.methods as unknown as {
      acquireManualRunLease: jest.Mock;
      releaseLease: jest.Mock;
      releaseLeaseByHolder: jest.Mock;
    };
    methods.acquireManualRunLease = jest.fn(async () => leased);
    // Simulates an edit rotating claimToken while deliberately preserving leaseBy.
    methods.releaseLease = jest.fn(async () => false);
    methods.releaseLeaseByHolder = jest.fn(async () => undefined);
    service.engineDeps.getUserContext = jest.fn(async () => {
      throw new Error('user lookup failed');
    });

    await expect(
      service.fireScheduleNow(leased, {
        enabled: true,
        maxPerUser: 10,
        minIntervalMinutes: 60,
        autoDisableAfterFailures: 5,
        admissionConcurrency: 20,
        fireConcurrency: 5,
        mcpPreflightConcurrency: 3,
        mcpPreflightTimeoutMs: 300_000,
        requireProject: false,
      }),
    ).rejects.toThrow('user lookup failed');

    expect(methods.releaseLease).toHaveBeenCalledWith('s1', 'manual-token');
    expect(methods.releaseLeaseByHolder).toHaveBeenCalledWith('s1', 'manual-holder');
  });
});

describe('balance initialization', () => {
  const balanceConfig = {
    interfaceConfig: {},
    balance: { enabled: true, startBalance: 20000 },
  } as unknown as Awaited<ReturnType<SchedulesServiceDeps['getAppConfig']>>;

  function serviceWithBalance(
    existing: Record<string, unknown> | null,
    overrides: {
      initializeNullBalance?: jest.Mock;
      findBalance?: jest.Mock;
    } = {},
  ) {
    const upsertBalance = jest.fn(async () => ({ tokenCredits: 20000 }));
    const initializeNullBalance =
      overrides.initializeNullBalance ?? jest.fn(async () => ({ tokenCredits: 20000 }));
    const findBalance = overrides.findBalance ?? jest.fn(async () => existing);
    const service = createSchedulesService({
      methods: {} as unknown as SchedulesServiceDeps['methods'],
      getAppConfig: (async () => balanceConfig) as SchedulesServiceDeps['getAppConfig'],
      findUserById: jest.fn(async () => null),
      findBalance,
      upsertBalance,
      initializeNullBalance,
      preflightMCP: jest.fn().mockResolvedValue([]),
      resolveAgentFireAccess: jest.fn(async () => 'ok' as const),
      getChatProject: jest.fn(async () => ({ _id: 'proj-1' })),
      isUserDeleting: jest.fn(async () => false),
      enqueueAgentTrigger: jest.fn(async () => undefined),
      getTriggerDelivery: jest.fn(async () => null),
    } as unknown as SchedulesServiceDeps);
    return { service, upsertBalance, initializeNullBalance, findBalance };
  }

  const updateFrom = (spy: jest.Mock) =>
    (
      spy.mock.calls[0] as unknown as [
        string,
        { set: Record<string, unknown>; setOnInsert: Record<string, unknown> },
      ]
    )[1];

  const casUpdateFrom = (spy: jest.Mock) =>
    (
      spy.mock.calls[0] as unknown as [
        string,
        { tokenCredits: number; sync: Record<string, unknown> },
      ]
    )[1];

  /**
   * The balance READ and this write are separate statements. A concurrent charge that
   * creates the record in between would be overwritten by a blind `$set`, handing back
   * credits the user had already spent.
   */
  it('initializes the starting credit via setOnInsert, never $set', async () => {
    const { service, upsertBalance } = serviceWithBalance(null);

    await service.engineDeps.isOutOfBalance({ id: 'user-1' } as never);

    expect(upsertBalance).toHaveBeenCalledTimes(1);
    const update = updateFrom(upsertBalance);
    expect(update.setOnInsert).toMatchObject({ tokenCredits: 20000 });
    expect(update.set).not.toHaveProperty('tokenCredits');
  });

  /**
   * The record was observed with a null credit, but the read and the write are separate
   * statements: a concurrent initializer/charge could have set and spent it in between.
   * The credit must go through a `{ tokenCredits: null }` CAS, never a blind `$set` that
   * would restore spent credits.
   */
  it('initializes an EXISTING null credit through the CAS, never a blind $set', async () => {
    const { service, upsertBalance, initializeNullBalance } = serviceWithBalance({
      autoRefillEnabled: false,
    });

    await service.engineDeps.isOutOfBalance({ id: 'user-1' } as never);

    expect(initializeNullBalance).toHaveBeenCalledTimes(1);
    const cas = casUpdateFrom(initializeNullBalance);
    expect(cas.tokenCredits).toBe(20000);
    // The credit write goes ONLY through the CAS, never the unconditional upsert path.
    expect(upsertBalance).not.toHaveBeenCalled();
  });

  /**
   * When the CAS misses — a concurrent initializer/charge won — the preflight must re-read
   * the winner's balance rather than restore the starting credit.
   */
  it('re-reads the winner on a CAS miss and never restores spent credits', async () => {
    const initializeNullBalance = jest.fn(async () => null);
    // First read observes a null credit; the winner's re-read returns the spent balance.
    const findBalance = jest
      .fn()
      .mockResolvedValueOnce({ autoRefillEnabled: false, tokenCredits: null })
      .mockResolvedValueOnce({ tokenCredits: 5 });
    const { service } = serviceWithBalance(null, { initializeNullBalance, findBalance });

    const outOfBalance = await service.engineDeps.isOutOfBalance({ id: 'user-1' } as never);

    expect(initializeNullBalance).toHaveBeenCalledTimes(1);
    // Re-read after the miss (the two isOutOfBalance reads), and the small winner balance
    // wins: > 0 credits means the user is not pre-skipped for balance.
    expect(findBalance).toHaveBeenCalledTimes(2);
    expect(outOfBalance).toBe(false);
  });

  it.each([
    ['all of its credits are held by in-flight requests', 100, true],
    ['part of its credits are free', 50, false],
  ])('pre-skips a record only when %s', async (_case, reservedCredits, outOfBalance) => {
    const { service } = serviceWithBalance({
      tokenCredits: 100,
      reservedCredits,
      autoRefillEnabled: false,
    });

    await expect(service.engineDeps.isOutOfBalance({ id: 'user-1' } as never)).resolves.toBe(
      outOfBalance,
    );
  });

  /**
   * A stale record whose credit is already set but whose refill config drifted still syncs
   * that config, and the sync must not widen into a credit write.
   */
  it('syncs refill config on a credited record without writing tokenCredits', async () => {
    const refillConfig = {
      interfaceConfig: {},
      balance: {
        enabled: true,
        startBalance: 20000,
        autoRefillEnabled: true,
        refillIntervalValue: 30,
        refillIntervalUnit: 'days',
        refillAmount: 10000,
      },
    } as unknown as Awaited<ReturnType<SchedulesServiceDeps['getAppConfig']>>;
    const upsertBalance = jest.fn(async () => ({ tokenCredits: 100 }));
    const initializeNullBalance = jest.fn(async () => null);
    const service = createSchedulesService({
      methods: {} as unknown as SchedulesServiceDeps['methods'],
      getAppConfig: (async () => refillConfig) as SchedulesServiceDeps['getAppConfig'],
      findUserById: jest.fn(async () => null),
      findBalance: jest.fn(async () => ({
        tokenCredits: 100,
        autoRefillEnabled: false,
        lastRefill: new Date('2026-01-01T00:00:00.000Z'),
      })),
      upsertBalance,
      initializeNullBalance,
      preflightMCP: jest.fn().mockResolvedValue([]),
      resolveAgentFireAccess: jest.fn(async () => 'ok' as const),
      getChatProject: jest.fn(async () => ({ _id: 'proj-1' })),
      isUserDeleting: jest.fn(async () => false),
      enqueueAgentTrigger: jest.fn(async () => undefined),
      getTriggerDelivery: jest.fn(async () => null),
    } as unknown as SchedulesServiceDeps);

    await service.engineDeps.isOutOfBalance({ id: 'user-1' } as never);

    // Credit is already set, so the CAS path is never taken.
    expect(initializeNullBalance).not.toHaveBeenCalled();
    expect(upsertBalance).toHaveBeenCalledTimes(1);
    const update = updateFrom(upsertBalance);
    expect(update.set).toMatchObject({ autoRefillEnabled: true });
    expect(update.set).not.toHaveProperty('tokenCredits');
    expect(update.setOnInsert).toEqual({});
  });
});

describe('deleteScheduleForOwner', () => {
  beforeEach(() => {
    // Module-level mock: without this it accumulates calls across tests and the
    // prune assertions below read a previous test's invocation.
    checkpointerModule.deleteAgentCheckpoint.mockClear();
  });

  /**
   * markScheduleDeleting runs FIRST and is one-shot: it matches only a not-yet-deleting
   * row, so a retry answers 404. Anything between it and the aborts that can throw
   * therefore strands the schedule — hidden and fenced, but with its paused job still
   * resumable and its checkpoint unpruned, until the 25-hour abandonment sweep.
   */
  it('still aborts a paused run when the checkpointer config cannot be resolved', async () => {
    const pausedRun = {
      scheduleId: 's1',
      scheduledFor: new Date('2026-01-01T00:00:00.000Z'),
      conversationId: 'c1',
      status: 'requires_action',
    };
    const service = makeService(
      jest.fn<Promise<ActiveRun[]>, [string]>().mockResolvedValue([]),
      // The checkpointer lookup resolves the owner's config; a transient failure here
      // must not cost the abort.
      jest.fn(async () => {
        throw new Error('config plane down');
      }) as unknown as SchedulesServiceDeps['getAppConfig'],
    );
    const methods = service.engineDeps.methods as unknown as {
      markScheduleDeleting: jest.Mock;
      getActiveRunsForSchedule: jest.Mock;
      eraseScheduleIfDrained: jest.Mock;
    };
    methods.markScheduleDeleting = jest.fn(async () => ({ id: 's1', user: 'user-1' }));
    methods.getActiveRunsForSchedule = jest.fn(async () => [pausedRun]);
    methods.eraseScheduleIfDrained = jest.fn(async () => true);
    // The owner must RESOLVE, or the checkpointer lookup short-circuits before it ever
    // reads the config and the throw under test never happens.
    (service.engineDeps as unknown as { getUserContext: jest.Mock }).getUserContext = jest.fn(
      async () => ({ id: 'user-1', tenantId: 't1', role: 'USER' }),
    );

    const abortJob = jest.fn(async () => ({ success: true }));
    mockJobStore = {
      getJob: jest.fn(async () => ({
        status: 'requires_action',
        createdAt: 1,
        scheduleId: 's1',
        scheduledFor: '2026-01-01T00:00:00.000Z',
      })),
    } as unknown as typeof mockJobStore;
    const manager = jest.requireMock('../stream/GenerationJobManager').GenerationJobManager;
    manager.abortJob = abortJob;

    // A paused (not running) job is positive evidence: settled synchronously, erased.
    await expect(service.deleteScheduleForOwner('s1', 'user-1')).resolves.toBe('deleted');
    expect(abortJob).toHaveBeenCalled();
  });

  /** Shared double set for the drain-discipline tests below. */
  function makeDeleteHarness(run: Partial<ActiveRun> & { scheduleId: string }) {
    const service = makeService(jest.fn<Promise<ActiveRun[]>, [string]>().mockResolvedValue([]));
    const methods = service.engineDeps.methods as unknown as {
      markScheduleDeleting: jest.Mock;
      getActiveRunsForSchedule: jest.Mock;
      eraseScheduleIfDrained: jest.Mock;
      recordRunOutcome: jest.Mock;
      getScheduleById: jest.Mock;
    };
    methods.markScheduleDeleting = jest.fn(async () => ({ id: run.scheduleId, user: 'user-1' }));
    methods.getActiveRunsForSchedule = jest.fn(async () => [run]);
    methods.eraseScheduleIfDrained = jest.fn(async () => true);
    methods.recordRunOutcome = jest.fn(async () => undefined);
    methods.getScheduleById = jest.fn(async () => ({ user: 'user-1' }));
    return { service, methods };
  }

  it.each([undefined, 'lcg:v2:owner:generation'])(
    'passes the matching paused job namespace (%s) through the raw projection to capture',
    async (checkpointNamespace) => {
      const scheduledFor = '2026-01-01T00:00:00.000Z';
      const { service } = makeDeleteHarness({
        scheduleId: 's1',
        scheduledFor: new Date(scheduledFor),
        conversationId: 'c1',
        status: 'requires_action',
      });
      mockJobStore = {
        getJob: jest.fn(async () => ({
          status: 'requires_action',
          createdAt: 1,
          scheduleId: 's1',
          scheduledFor,
          checkpointNamespace,
        })),
      } as unknown as typeof mockJobStore;
      const manager = jest.requireMock('../stream/GenerationJobManager').GenerationJobManager;
      manager.abortJob = jest.fn(async () => ({ success: true }));
      checkpointerModule.captureAgentCheckpointGeneration.mockClear();
      await expect(service.deleteScheduleForOwner('s1', 'user-1')).resolves.toBe('deleted');
      expect(checkpointerModule.captureAgentCheckpointGeneration).toHaveBeenCalledWith(
        'c1',
        undefined,
        checkpointNamespace == null ? {} : { checkpointNamespace },
      );
    },
  );

  it('uses the durable paused namespace after job-store loss', async () => {
    const namespace = 'retained-owned-namespace';
    const { service } = makeDeleteHarness({
      scheduleId: 's1',
      scheduledFor: new Date('2026-01-01T00:00:00.000Z'),
      conversationId: 'c1',
      checkpointNamespace: namespace,
      status: 'requires_action',
    });
    mockJobStore = { getJob: jest.fn(async () => null) } as unknown as typeof mockJobStore;
    checkpointerModule.captureAgentCheckpointGeneration.mockClear();
    await expect(service.deleteScheduleForOwner('s1', 'user-1')).resolves.toBe('deleted');
    expect(checkpointerModule.captureAgentCheckpointGeneration).toHaveBeenCalledWith(
      'c1',
      undefined,
      { checkpointNamespace: namespace },
    );
  });

  it('captures the retained namespace in every recorded store after job loss and a config change', async () => {
    const namespace = 'retained-owned-namespace';
    const stores = [
      { type: 'mongo', checkpointCollectionName: 'old-checkpoints' },
      { type: 'mongo', checkpointCollectionName: 'current-checkpoints' },
    ];
    checkpointerModule.checkpointStorageConfigs.mockResolvedValueOnce(stores);
    const { service } = makeDeleteHarness({
      scheduleId: 's1',
      scheduledFor: new Date('2026-01-01T00:00:00.000Z'),
      conversationId: 'c1',
      checkpointNamespace: namespace,
      status: 'requires_action',
    });
    mockJobStore = { getJob: jest.fn(async () => null) } as unknown as typeof mockJobStore;
    checkpointerModule.captureAgentCheckpointGeneration.mockClear();
    await expect(service.deleteScheduleForOwner('s1', 'user-1')).resolves.toBe('deleted');
    for (const storage of stores) {
      expect(checkpointerModule.captureAgentCheckpointGeneration).toHaveBeenCalledWith(
        'c1',
        storage,
        { checkpointNamespace: namespace },
      );
      expect(checkpointerModule.deleteAgentCheckpoint).toHaveBeenCalledWith(
        'c1',
        storage,
        expect.objectContaining({ checkpointIds: ['ck-1'] }),
      );
    }
  });

  it('settles a pause hand-off after the exact provider drain is confirmed', async () => {
    const { service, methods } = makeDeleteHarness({
      scheduleId: 's1',
      scheduledFor: new Date('2026-01-01T00:00:00.000Z'),
      conversationId: 'c1',
      status: 'started',
    });
    // The job can report requires_action before the run row records the pause. The
    // delete path must abort through #14925's provider-drain barrier before settling,
    // so no trailing controller write can race the outcome.
    mockJobStore = {
      getJob: jest.fn(async () => ({
        status: 'requires_action',
        createdAt: 1,
        scheduleId: 's1',
        scheduledFor: '2026-01-01T00:00:00.000Z',
      })),
    } as unknown as typeof mockJobStore;
    const manager = jest.requireMock('../stream/GenerationJobManager').GenerationJobManager;
    manager.abortJob = jest.fn(async () => ({
      success: true,
      signalDelivered: true,
      jobData: { status: 'requires_action' },
    }));

    await service.deleteScheduleForOwner('s1', 'user-1');

    expect(methods.recordRunOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'interrupted', conversationId: 'c1' }),
    );
  });

  it('does not report success when the abort of a live run is not delivered', async () => {
    const { service, methods } = makeDeleteHarness({
      scheduleId: 's1',
      scheduledFor: new Date('2026-01-01T00:00:00.000Z'),
      conversationId: 'c1',
      status: 'started',
    });
    // A RUNNING identity-matched job: not settleable, must be aborted...
    mockJobStore = {
      getJob: jest.fn(async () => ({
        status: 'running',
        createdAt: 1,
        scheduleId: 's1',
        scheduledFor: '2026-01-01T00:00:00.000Z',
      })),
      deleteJob: jest.fn(async () => true),
    } as unknown as typeof mockJobStore;
    // ...and the abort delivery FAILS (job store write rejected).
    const manager = jest.requireMock('../stream/GenerationJobManager').GenerationJobManager;
    manager.abortJob = jest.fn(async () => {
      throw new Error('store unreachable');
    });

    // The generation may still be producing and billing; claiming success would say
    // it was stopped. The schedule stays hidden and fenced; the delete is idempotent.
    await expect(service.deleteScheduleForOwner('s1', 'user-1')).resolves.toBe('unconfirmed');
    expect(methods.eraseScheduleIfDrained).not.toHaveBeenCalled();
  });

  it('treats an unreadable job store as unknown, not absent', async () => {
    const { service, methods } = makeDeleteHarness({
      scheduleId: 's1',
      scheduledFor: new Date('2026-01-01T00:00:00.000Z'),
      conversationId: 'c1',
      status: 'started',
    });
    mockJobStore = {
      getJob: jest.fn(async () => {
        throw new Error('redis gone');
      }),
    } as unknown as typeof mockJobStore;
    const manager = jest.requireMock('../stream/GenerationJobManager').GenerationJobManager;
    manager.abortJob = jest.fn(async () => {
      throw new Error('redis gone');
    });

    // With the store unreadable NOTHING is proven: the row must not be settled as
    // an orphan (its generation may be live) and the delete must not read as done.
    await expect(service.deleteScheduleForOwner('s1', 'user-1')).resolves.toBe('unconfirmed');
    expect(methods.recordRunOutcome).not.toHaveBeenCalled();
  });

  it('settles a provably job-less run synchronously and erases without a reconciler', async () => {
    const { service, methods } = makeDeleteHarness({
      scheduleId: 's1',
      scheduledFor: new Date('2026-01-01T00:00:00.000Z'),
      conversationId: 'c1',
      status: 'started',
    });
    // Confirmed absence: the lookup SUCCEEDS and returns null (a crashed fire, or a
    // stale row from a previous topology). The clustered entrypoint has no reconciler,
    // so deferring this row to one retained the deleted schedule indefinitely there.
    mockJobStore = { getJob: jest.fn(async () => null) } as unknown as typeof mockJobStore;

    await expect(service.deleteScheduleForOwner('s1', 'user-1')).resolves.toBe('deleted');
    expect(methods.recordRunOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ scheduleId: 's1', status: 'interrupted' }),
    );
    expect(methods.eraseScheduleIfDrained).toHaveBeenCalledWith('s1');
  });

  /**
   * The durable checkpoint is keyed by conversationId ALONE, so pruning it when a
   * REPLACEMENT turn owns the conversation strips the resume state of a live generation
   * that has nothing to do with this schedule — the same hazard the interactive abort
   * route refuses with a 409.
   */
  it('does not prune the checkpoint when a replacement owns the conversation', async () => {
    const { service } = makeDeleteHarness({
      scheduleId: 's1',
      scheduledFor: new Date('2026-01-01T00:00:00.000Z'),
      conversationId: 'c1',
      status: 'requires_action',
    });
    // A job IS present, but it carries a DIFFERENT occurrence's identity: this
    // conversation now belongs to someone else's turn.
    mockJobStore = {
      getJob: jest.fn(async () => ({
        status: 'running',
        createdAt: 99,
        scheduleId: 'a-different-schedule',
        scheduledFor: new Date('2030-01-01T00:00:00.000Z').toISOString(),
      })),
    } as unknown as typeof mockJobStore;
    const manager = jest.requireMock('../stream/GenerationJobManager').GenerationJobManager;
    manager.abortJob = jest.fn(async () => ({ success: true }));

    await service.deleteScheduleForOwner('s1', 'user-1');

    expect(checkpointerModule.deleteAgentCheckpoint).not.toHaveBeenCalled();
  });

  it('prunes the checkpoint of a paused run it does own', async () => {
    const { service } = makeDeleteHarness({
      scheduleId: 's1',
      scheduledFor: new Date('2026-01-01T00:00:00.000Z'),
      conversationId: 'c1',
      status: 'requires_action',
    });
    mockJobStore = {
      getJob: jest.fn(async () => ({
        status: 'requires_action',
        createdAt: 1,
        scheduleId: 's1',
        scheduledFor: new Date('2026-01-01T00:00:00.000Z').toISOString(),
      })),
    } as unknown as typeof mockJobStore;
    const manager = jest.requireMock('../stream/GenerationJobManager').GenerationJobManager;
    manager.abortJob = jest.fn(async () => ({ success: true }));

    await service.deleteScheduleForOwner('s1', 'user-1');

    // SCOPED to the checkpoint ids captured before the terminal transition, so a
    // replacement's later checkpoints can never be swept up by this prune.
    expect(checkpointerModule.deleteAgentCheckpoint).toHaveBeenCalledWith('c1', undefined, {
      threadId: 'c1',
      checkpointIds: ['ck-1'],
    });
  });

  it('reports draining when a live run was aborted but has not yet settled', async () => {
    const { service, methods } = makeDeleteHarness({
      scheduleId: 's1',
      scheduledFor: new Date('2026-01-01T00:00:00.000Z'),
      conversationId: 'c1',
      status: 'started',
    });
    mockJobStore = {
      getJob: jest.fn(async () => ({
        status: 'running',
        createdAt: 1,
        scheduleId: 's1',
        scheduledFor: '2026-01-01T00:00:00.000Z',
      })),
      deleteJob: jest.fn(async () => true),
    } as unknown as typeof mockJobStore;
    const manager = jest.requireMock('../stream/GenerationJobManager').GenerationJobManager;
    manager.abortJob = jest.fn(async () => ({ success: true }));
    // The run row is still active, so the erase declines; settlement (and the
    // erase-on-settle it triggers) belongs to the aborted generation's outcome write.
    methods.eraseScheduleIfDrained = jest.fn(async () => false);
    // Public reads intentionally hide deleting rows. That absence must not turn a
    // declined erasure into a false `deleted` response.
    methods.getScheduleById.mockResolvedValue(null);

    await expect(service.deleteScheduleForOwner('s1', 'user-1')).resolves.toBe('draining');
  });

  afterEach(() => {
    mockJobStore = null;
    jest.restoreAllMocks();
  });
});

describe('erase-on-settle', () => {
  /**
   * Whichever process records a run's terminal outcome also attempts the deferred
   * erase of a deleting schedule. This is what makes a delete's `draining` state
   * converge in EVERY topology — the clustered entrypoint runs no reconciler, so
   * without it the hidden schedule (and its prompt, which has no TTL) survived its
   * last run indefinitely there.
   */
  it('attempts the deferred erase after recording a terminal outcome', async () => {
    const service = makeService(jest.fn<Promise<ActiveRun[]>, [string]>().mockResolvedValue([]));
    const methods = service.engineDeps.methods as unknown as {
      getScheduleById: jest.Mock;
      recordRunOutcome: jest.Mock;
      eraseScheduleIfDrained: jest.Mock;
    };
    methods.getScheduleById = jest.fn(async () => null);
    methods.recordRunOutcome = jest.fn(async () => undefined);
    methods.eraseScheduleIfDrained = jest.fn(async () => true);

    await expect(
      service.recordScheduleOutcome({
        scheduleId: 's1',
        scheduledFor: '2026-01-01T00:00:00.000Z',
        status: 'success',
      }),
    ).resolves.toBe(true);
    expect(methods.eraseScheduleIfDrained).toHaveBeenCalledWith('s1');
  });

  it('does not erase on a pause, which is not a settlement', async () => {
    const service = makeService(jest.fn<Promise<ActiveRun[]>, [string]>().mockResolvedValue([]));
    const methods = service.engineDeps.methods as unknown as {
      getScheduleById: jest.Mock;
      recordRunOutcome: jest.Mock;
      eraseScheduleIfDrained: jest.Mock;
    };
    methods.getScheduleById = jest.fn(async () => null);
    methods.recordRunOutcome = jest.fn(async () => undefined);
    methods.eraseScheduleIfDrained = jest.fn(async () => true);

    await service.recordScheduleOutcome({
      scheduleId: 's1',
      scheduledFor: '2026-01-01T00:00:00.000Z',
      status: 'requires_action',
    });
    expect(methods.eraseScheduleIfDrained).not.toHaveBeenCalled();
  });
});

describe('scheduled OBO tool failure settlement', () => {
  const occurrence = '2026-09-09T12:00:00.000Z';
  const failure = {
    server: 'Graph',
    status: 'mcp_configuration_missing' as const,
    detail: 'unattended_auth_required' as const,
  };

  function setup() {
    const service = makeService(jest.fn<Promise<ActiveRun[]>, [string]>(async () => []));
    const methods = service.engineDeps.methods as unknown as {
      getScheduleById: jest.Mock;
      eraseScheduleIfDrained: jest.Mock;
      getScheduleRunAbortState: jest.Mock;
      recordMCPToolAuthFailure: jest.Mock;
      recordRunOutcome: jest.Mock;
    };
    methods.getScheduleById = jest.fn(async () => null);
    methods.eraseScheduleIfDrained = jest.fn(async () => false);
    methods.getScheduleRunAbortState = jest.fn(async () => ({ status: 'started', mcp: [failure] }));
    const store = {
      getJob: jest.fn(async () => ({
        createdAt: 42,
        scheduleId: 's1',
        scheduledFor: occurrence,
        conversationId: 'c1',
        userId: 'owner',
        tenantId: 'tenant-1',
        status: 'running',
      })),
    };
    mockJobStore = store;
    return { service, methods, store };
  }

  it('does not initialize the schedule service for unrelated MCP errors', async () => {
    const getRecorder = jest.fn();
    await expect(
      recordScheduledMCPToolAuthFailure(
        {
          error: new Error('Ordinary MCP failure'),
          streamId: 'c1',
          jobCreatedAt: 42,
          userId: 'owner',
          serverName: 'Graph',
        },
        getRecorder,
      ),
    ).resolves.toBe(false);
    expect(getRecorder).not.toHaveBeenCalled();
  });

  it.each(['job lookup', 'run write'] as const)(
    'keeps receipt persistence best-effort when the %s fails',
    async (failurePoint) => {
      const { service, methods, store } = setup();
      const persistenceError = new Error('Storage temporarily unavailable');
      if (failurePoint === 'job lookup') {
        store.getJob.mockRejectedValueOnce(persistenceError);
      } else {
        methods.recordMCPToolAuthFailure.mockRejectedValueOnce(persistenceError);
      }
      const warn = jest.spyOn(logger, 'warn').mockImplementation(() => logger);
      const missing = new OboTokenResolutionError('missing_upstream_provider', 'No credentials');
      const input = {
        error: missing,
        streamId: 'c1',
        jobCreatedAt: 42,
        userId: 'owner',
        serverName: 'Graph',
      };

      await expect(
        recordScheduledMCPToolAuthFailure(input, () => service.recordMCPToolAuthFailure),
      ).resolves.toBe(false);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('could not persist'),
        persistenceError,
      );
      warn.mockRestore();
    },
  );

  it('records a typed tool failure only for the matching scheduled generation and owner', async () => {
    const { service, methods, store } = setup();
    const source = new OboTokenResolutionError('missing_upstream_provider', 'No credentials');
    const error = Object.assign(new McpError(ErrorCode.InternalError, 'OBO failed'), {
      cause: source,
    });
    const input = { error, streamId: 'c1', jobCreatedAt: 42, userId: 'owner', serverName: 'Graph' };
    await expect(service.recordMCPToolAuthFailure(input)).resolves.toBe(true);
    expect(methods.recordMCPToolAuthFailure).toHaveBeenCalledWith({
      scheduleId: 's1',
      scheduledFor: new Date(occurrence),
      conversationId: 'c1',
      tenantId: 'tenant-1',
      server: 'Graph',
    });
    expect(store.getJob).toHaveBeenCalledWith('c1');

    for (const wrong of [{ jobCreatedAt: 43 }, { userId: 'another' }]) {
      await expect(service.recordMCPToolAuthFailure({ ...input, ...wrong })).resolves.toBe(false);
    }
    await expect(
      service.recordMCPToolAuthFailure({ ...input, error: new Error('No credentials') }),
    ).resolves.toBe(false);
    store.getJob.mockResolvedValueOnce({
      createdAt: 42,
      userId: 'owner',
      scheduleId: '',
      scheduledFor: occurrence,
      conversationId: 'c1',
      tenantId: 'tenant-1',
      status: 'running',
    });
    await expect(service.recordMCPToolAuthFailure(input)).resolves.toBe(false);
    expect(methods.recordMCPToolAuthFailure).toHaveBeenCalledTimes(1);
  });

  it('settles a resumed run with missing MCP credentials as an error with old-client-readable guidance', async () => {
    const { service, methods } = setup();
    methods.getScheduleRunAbortState.mockResolvedValue({ status: 'started', mcp: [failure] });
    await service.recordScheduleOutcome({
      scheduleId: 's1',
      scheduledFor: occurrence,
      status: 'requires_action',
    });
    expect(methods.getScheduleRunAbortState).not.toHaveBeenCalled();
    await expect(
      service.recordScheduleOutcome({
        scheduleId: 's1',
        scheduledFor: occurrence,
        status: 'success',
        conversationId: 'c1',
        streamId: 'c1',
        jobCreatedAt: 42,
      }),
    ).resolves.toBe(true);
    expect(methods.recordRunOutcome).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'error',
        mcp: [failure],
        error: 'MCP unattended authorization unavailable',
      }),
    );
    expect(
      jest.requireMock('../stream/GenerationJobManager').GenerationJobManager.updateMetadata,
    ).toHaveBeenCalledWith('c1', expect.objectContaining({ scheduleOutcome: 'error' }), 42);
  });

  it('retains an error rather than a balance skip for a known missing OBO provider', async () => {
    const { service, methods } = setup();
    await service.recordScheduleOutcome({
      scheduleId: 's1',
      scheduledFor: occurrence,
      status: 'skipped_balance',
      conversationId: 'c1',
      streamId: 'c1',
      jobCreatedAt: 42,
    });
    expect(methods.recordRunOutcome).toHaveBeenLastCalledWith(
      expect.objectContaining({
        status: 'error',
        error: 'MCP unattended authorization unavailable',
        mcp: [failure],
      }),
    );
    expect(
      jest.requireMock('../stream/GenerationJobManager').GenerationJobManager.updateMetadata,
    ).toHaveBeenCalledWith('c1', expect.objectContaining({ scheduleOutcome: 'error' }), 42);
  });

  it('keeps ordinary completion and missing-run outcomes unchanged', async () => {
    const { service, methods } = setup();
    methods.getScheduleRunAbortState.mockResolvedValueOnce({
      status: 'started',
      mcp: [{ server: 'Graph', status: 'ready' }],
    });
    await service.recordScheduleOutcome({
      scheduleId: 's1',
      scheduledFor: occurrence,
      status: 'success',
    });
    expect(methods.recordRunOutcome).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: 'success' }),
    );
  });
});

describe('interactive Stop persistence barrier', () => {
  function outcomeService() {
    const service = makeService(jest.fn<Promise<ActiveRun[]>, [string]>().mockResolvedValue([]));
    const methods = service.engineDeps.methods as unknown as {
      getScheduleById: jest.Mock;
      recordRunOutcome: jest.Mock;
      eraseScheduleIfDrained: jest.Mock;
      getScheduleRunAbortState: jest.Mock;
      requestRunAbort: jest.Mock;
      markRunAbortPersisted: jest.Mock;
    };
    methods.getScheduleById = jest.fn(async () => null);
    methods.recordRunOutcome = jest.fn(async () => undefined);
    methods.eraseScheduleIfDrained = jest.fn(async () => true);
    return { service, methods };
  }

  it('beginScheduledStop stamps a serialized stop; acknowledge marks persistence', async () => {
    const { service, methods } = outcomeService();
    methods.requestRunAbort = jest.fn(async () => 'in_progress' as const);
    methods.markRunAbortPersisted = jest.fn(async () => undefined);

    const stamp = await service.beginScheduledStop({
      scheduleId: 's1',
      scheduledFor: '2026-01-01T00:00:00.000Z',
    });
    expect(stamp).toBe('in_progress');
    expect(methods.requestRunAbort).toHaveBeenCalledWith('s1', expect.any(Date), 'stop');

    await service.acknowledgeScheduledStopPersistence({
      scheduleId: 's1',
      scheduledFor: '2026-01-01T00:00:00.000Z',
    });
    expect(methods.markRunAbortPersisted).toHaveBeenCalledWith('s1', expect.any(Date));
  });

  it('owner terminal settlement waits until the Stop persistence is acknowledged', async () => {
    const { service, methods } = outcomeService();
    const fresh = new Date();
    let reads = 0;
    // Unresolved fresh stop for the first two reads, then acknowledged.
    methods.getScheduleRunAbortState = jest.fn(async () => {
      reads += 1;
      return {
        status: 'started',
        abortSource: 'stop',
        abortRequestedAt: fresh,
        ...(reads > 2 ? { abortPersistedAt: new Date() } : {}),
      };
    });

    await service.recordScheduleOutcome({
      scheduleId: 's1',
      scheduledFor: '2026-01-01T00:00:00.000Z',
      status: 'success',
    });

    // Polled until the acknowledgement landed, and only THEN recorded the outcome.
    expect(reads).toBeGreaterThanOrEqual(3);
    expect(methods.recordRunOutcome).toHaveBeenCalled();
    expect(methods.getScheduleRunAbortState.mock.invocationCallOrder[0]).toBeLessThan(
      methods.recordRunOutcome.mock.invocationCallOrder[0],
    );
  });

  it('does not wait on a non-stop abort source', async () => {
    const { service, methods } = outcomeService();
    methods.getScheduleRunAbortState = jest.fn(async () => ({
      status: 'started',
      abortSource: 'deletion',
      abortRequestedAt: new Date(),
    }));

    await service.recordScheduleOutcome({
      scheduleId: 's1',
      scheduledFor: '2026-01-01T00:00:00.000Z',
      status: 'interrupted',
    });

    expect(methods.getScheduleRunAbortState).toHaveBeenCalledTimes(1);
    expect(methods.recordRunOutcome).toHaveBeenCalled();
  });

  it('does not wait on a STALE stop stamp (route presumed dead)', async () => {
    const { service, methods } = outcomeService();
    // Older than ABORT_OWNER_PRESUMED_ALIVE_MS: the owner presumes the route dead.
    const stale = new Date(Date.now() - 31 * 60_000);
    methods.getScheduleRunAbortState = jest.fn(async () => ({
      status: 'started',
      abortSource: 'stop',
      abortRequestedAt: stale,
    }));

    await service.recordScheduleOutcome({
      scheduleId: 's1',
      scheduledFor: '2026-01-01T00:00:00.000Z',
      status: 'error',
    });

    expect(methods.getScheduleRunAbortState).toHaveBeenCalledTimes(1);
    expect(methods.recordRunOutcome).toHaveBeenCalled();
  });

  /**
   * The poll budget expiring proves nothing about the Stop route's writes (slow checkpoint
   * cleanup looks identical), so the barrier must DEFER rather than terminalize the run and
   * release its capacity mid-persistence.
   */
  it('defers settlement when a fresh Stop never acknowledges within the poll budget', async () => {
    const { service, methods } = outcomeService();
    methods.getScheduleRunAbortState = jest.fn(async () => ({
      status: 'started',
      abortSource: 'stop',
      abortRequestedAt: new Date(),
    }));

    const settled = await service.recordScheduleOutcome({
      scheduleId: 's1',
      scheduledFor: '2026-01-01T00:00:00.000Z',
      status: 'interrupted',
    });

    // Reported NOT settled so a durable-retry caller re-drives it, and the run is left
    // active rather than terminalized while persistence may still be in flight.
    expect(settled).toBe(false);
    expect(methods.recordRunOutcome).not.toHaveBeenCalled();
  });

  it('does not gate a pause (requires_action) on the Stop barrier', async () => {
    const { service, methods } = outcomeService();
    methods.getScheduleRunAbortState = jest.fn(async () => null);

    await service.recordScheduleOutcome({
      scheduleId: 's1',
      scheduledFor: '2026-01-01T00:00:00.000Z',
      status: 'requires_action',
    });

    // A pause is not a settlement, so the barrier is never consulted.
    expect(methods.getScheduleRunAbortState).not.toHaveBeenCalled();
  });
});

describe('attachment hold renewal', () => {
  it('renews the bounded upload hold at fire preflight, best-effort', async () => {
    const service = makeService(jest.fn<Promise<ActiveRun[]>, [string]>().mockResolvedValue([]));
    const methods = service.engineDeps.methods as unknown as {
      extendFilesTTL: jest.Mock;
      getFiles: jest.Mock;
    };
    // The hold bridges upload -> first consumption; a renewal failure must not fail
    // the fire (the file resolves now; at worst the hold lapses later).
    methods.extendFilesTTL = jest.fn(async () => {
      throw new Error('mongo down');
    });
    methods.getFiles = jest.fn(async () => [
      { file_id: 'f1', filepath: '/f1', filename: 'a.png', type: 'image/png', source: 'local' },
    ]);

    const files = await service.engineDeps.resolveFiles(['f1'], { id: 'user-1', tenantId: 't1' });
    expect(methods.extendFilesTTL).toHaveBeenCalledWith(
      ['f1'],
      expect.objectContaining({ renewMs: expect.any(Number), maxLifetimeMs: expect.any(Number) }),
      { user: 'user-1', tenantId: 't1' },
    );
    expect(files).toHaveLength(1);
  });
});

describe('isScheduleLive policy recheck', () => {
  const liveRow = { id: 's1', user: 'u1', enabled: true } as never;

  it('refuses a resume while the operator kill switch is up', async () => {
    const service = makeService(jest.fn<Promise<ActiveRun[]>, [string]>().mockResolvedValue([]));
    const methods = service.engineDeps.methods as unknown as { getScheduleById: jest.Mock };
    methods.getScheduleById = jest.fn(async () => liveRow);
    process.env.SCHEDULES_DISABLED = 'true';
    try {
      // The row-level checks alone pass; only the policy recheck sees the switch.
      await expect(service.isScheduleLive('s1')).resolves.toBe(true);
      // A pause can sit for hours; an approval must not start a billed continuation
      // the operator believes is stopped.
      await expect(service.isScheduleLive('s1', undefined, { policy: true })).resolves.toBe(false);
    } finally {
      delete process.env.SCHEDULES_DISABLED;
    }
  });

  it('refuses a resume when the owner lost SCHEDULES:USE', async () => {
    const service = makeService(jest.fn<Promise<ActiveRun[]>, [string]>().mockResolvedValue([]));
    const methods = service.engineDeps.methods as unknown as {
      getScheduleById: jest.Mock;
      getRoleByName: jest.Mock;
    };
    methods.getScheduleById = jest.fn(async () => liveRow);
    methods.getRoleByName = jest.fn(async () => ({ permissions: { SCHEDULES: { USE: false } } }));
    (service.engineDeps as unknown as { getUserContext: jest.Mock }).getUserContext = jest.fn(
      async () => ({ id: 'u1', tenantId: 't1', role: 'USER' }),
    );

    await expect(service.isScheduleLive('s1', undefined, { policy: true })).resolves.toBe(false);
  });

  /**
   * Project policy rides this branch on purpose: BOTH callers route its refusal through
   * abort-and-settle, so a policy stop settles the occurrence rather than leaving it at
   * `requires_action` answering 409 to every approval until it expires.
   */
  describe('project policy', () => {
    function makeProjectService(
      row: Record<string, unknown>,
      schedulesConfig: Record<string, unknown>,
      project: unknown = { _id: 'proj-1' },
      over: { run?: { recorded: boolean; chatProjectId?: string } | null } = {},
    ) {
      const service = makeService(
        jest.fn<Promise<ActiveRun[]>, [string]>().mockResolvedValue([]),
        jest.fn(async () => ({
          interfaceConfig: { schedules: { use: true, ...schedulesConfig } },
        })) as unknown as SchedulesServiceDeps['getAppConfig'],
      );
      const methods = service.engineDeps.methods as unknown as {
        getScheduleById: jest.Mock;
        getRoleByName: jest.Mock;
      };
      methods.getScheduleById = jest.fn(async () => ({
        id: 's1',
        user: 'u1',
        enabled: true,
        ...row,
      }));
      methods.getRoleByName = jest.fn(async () => ({ permissions: { SCHEDULES: { USE: true } } }));
      (methods as unknown as { getScheduleRunProject: jest.Mock }).getScheduleRunProject = jest.fn(
        async () => ('run' in over ? over.run : null),
      );
      (service.engineDeps as unknown as { getUserContext: jest.Mock }).getUserContext = jest.fn(
        async () => ({ id: 'u1', tenantId: 't1', role: 'USER' }),
      );
      (service.engineDeps as unknown as { projectAccess: jest.Mock }).projectAccess = jest.fn(
        async () => (project == null ? 'missing' : 'ok'),
      );
      return service;
    }

    it('refuses when the destination project was deleted', async () => {
      const service = makeProjectService({ chatProjectId: 'proj-gone' }, {}, null);
      await expect(service.isScheduleLive('s1', undefined, { policy: true })).resolves.toBe(false);
    });

    it('refuses an unscoped schedule once the owner requires a project', async () => {
      const service = makeProjectService({}, { requireProject: true });
      await expect(service.isScheduleLive('s1', undefined, { policy: true })).resolves.toBe(false);
    });

    /**
     * A pin governs where the NEXT run lands, and the fire path already redirects those.
     * The paused conversation cannot be rebound — `chatProjectId` is excluded from the
     * resume context and the continuation reuses the same conversationId — so refusing
     * here would strand a pending approval over a destination it can never reach.
     */
    it('admits a paused run whose pin moved to a different project', async () => {
      const service = makeProjectService({ chatProjectId: 'proj-old' }, { projectId: 'proj-new' });
      await expect(service.isScheduleLive('s1', undefined, { policy: true })).resolves.toBe(true);
    });

    it('admits a scoped schedule whose project is still owned', async () => {
      const service = makeProjectService({ chatProjectId: 'proj-1' }, {});
      await expect(service.isScheduleLive('s1', undefined, { policy: true })).resolves.toBe(true);
    });

    /**
     * A paused run does NOT block later occurrences (the single-active index covers
     * `started` only), so a fire after a pin move rewrites the schedule row while the
     * paused conversation stays where it was filed. The occurrence's own record is
     * what must be validated.
     */
    it('validates the occurrence record over a schedule row a later fire moved', async () => {
      const service = makeProjectService(
        { chatProjectId: 'proj-new' },
        { projectId: 'proj-new' },
        null,
        { run: { recorded: true, chatProjectId: 'proj-paused' } },
      );
      const access = (service.engineDeps as unknown as { projectAccess: jest.Mock }).projectAccess;

      await expect(
        service.isScheduleLive('s1', undefined, {
          policy: true,
          scheduledFor: '2026-08-17T12:00:00.000Z',
        }),
      ).resolves.toBe(false);
      expect(access).toHaveBeenCalledWith('proj-paused', expect.anything());
    });

    it('admits when the occurrence record itself is still live', async () => {
      const service = makeProjectService(
        { chatProjectId: 'proj-new' },
        {},
        { _id: 'x' },
        {
          run: { recorded: true, chatProjectId: 'proj-paused' },
        },
      );

      await expect(
        service.isScheduleLive('s1', undefined, {
          policy: true,
          scheduledFor: '2026-08-17T12:00:00.000Z',
        }),
      ).resolves.toBe(true);
    });

    /** An absent record is not evidence to stop a run: pre-scope occurrences and rows
     *  that are simply gone fall back to the schedule-level resolution. */
    it('falls back to the schedule when the occurrence recorded nothing', async () => {
      const service = makeProjectService({ chatProjectId: 'proj-gone' }, {}, null, { run: null });

      await expect(
        service.isScheduleLive('s1', undefined, {
          policy: true,
          scheduledFor: '2026-08-17T12:00:00.000Z',
        }),
      ).resolves.toBe(false);
    });

    /**
     * A run that DELIBERATELY went unscoped recorded that decision. Falling back to the
     * schedule's current project for it would admit a conversation satisfying no
     * present requirement — the fallback is for UNKNOWN records only.
     */
    it('refuses a recorded-unscoped occurrence once a project became required', async () => {
      const service = makeProjectService(
        { chatProjectId: 'proj-new' },
        { requireProject: true },
        { _id: 'x' },
        {
          run: { recorded: true },
        },
      );

      await expect(
        service.isScheduleLive('s1', undefined, {
          policy: true,
          scheduledFor: '2026-08-17T12:00:00.000Z',
        }),
      ).resolves.toBe(false);
    });

    /** A pre-scope row is UNKNOWN, not unscoped, and keeps today's behaviour. */
    it('falls back for an unrecorded pre-scope occurrence', async () => {
      const service = makeProjectService(
        { chatProjectId: 'proj-live' },
        { requireProject: true },
        { _id: 'x' },
        {
          run: { recorded: false },
        },
      );

      await expect(
        service.isScheduleLive('s1', undefined, {
          policy: true,
          scheduledFor: '2026-08-17T12:00:00.000Z',
        }),
      ).resolves.toBe(true);
    });

    /**
     * The INITIAL start runs the same policy branch, and its run row is reserved before
     * the loopback request is dispatched — so a pin introduced while that request sat
     * queued must not be validated in place of the destination whose envelope was
     * already built. Same call shape as the resume path.
     */
    it('refuses an initial start whose occurrence was reserved unscoped', async () => {
      const service = makeProjectService(
        { chatProjectId: 'proj-pinned' },
        { projectId: 'proj-pinned' },
        { _id: 'x' },
        { run: { recorded: true } },
      );

      await expect(
        service.isScheduleLive('s1', undefined, {
          policy: true,
          scheduledFor: '2026-08-17T12:00:00.000Z',
        }),
      ).resolves.toBe(false);
    });

    it('leaves the non-policy recheck untouched', async () => {
      const service = makeProjectService({ chatProjectId: 'proj-gone' }, {}, null);
      await expect(service.isScheduleLive('s1')).resolves.toBe(true);
    });
  });
});

describe('quiesceUserSchedules drain wait', () => {
  afterEach(() => {
    mockJobStore = null;
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('polls the active runs until they drain, then returns', async () => {
    jest.useFakeTimers();
    const active = [run()];
    const getActive = jest
      .fn<Promise<ActiveRun[]>, [string]>()
      .mockResolvedValueOnce(active) // initial collection for abort
      .mockResolvedValueOnce(active) // first poll: still settling
      .mockResolvedValue([]); // subsequent polls: drained
    const service = makeService(getActive);

    const pending = service.quiesceUserSchedules('user-1', 'attempt-1');
    // Each poll waits one interval; advance twice so the loop observes the drain.
    await jest.advanceTimersByTimeAsync(250);
    await jest.advanceTimersByTimeAsync(250);
    // The rows DRAINED, so the runs are genuinely settled even though this harness has
    // no job store and the aborts could not be confirmed delivered. The drain is the
    // authority; an undelivered abort whose run then settled must not defer deletion
    // forever.
    await expect(pending).resolves.toBe(true);

    // Initial read + at least one poll that observed a non-empty set + the empty one.
    expect(getActive.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it('stops waiting at the bounded deadline when runs never drain', async () => {
    jest.useFakeTimers();
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => logger);
    const getActive = jest.fn<Promise<ActiveRun[]>, [string]>().mockResolvedValue([run()]); // never drains
    const service = makeService(getActive);

    const pending = service.quiesceUserSchedules('user-1', 'attempt-1');
    // Advance past the full bounded timeout; the loop must give up, not hang, and must
    // report the drain as UNCONFIRMED so deletion defers rather than destroying.
    await jest.advanceTimersByTimeAsync(10_000);
    await expect(pending).resolves.toBe(false);

    // It polled repeatedly (bounded by the deadline) and surfaced the un-drained runs.
    expect(getActive.mock.calls.length).toBeGreaterThan(1);
    expect(warn).toHaveBeenCalled();
  });

  /**
   * A `started` row whose job is already terminal is the preserve-for-reconcile case:
   * the inline outcome write exhausted its retries, so the retained job is the ONLY
   * evidence the run finished. Account deletion deletes that job (nothing will ever
   * reconcile it once the rows are hard-deleted), so it has to project the job's
   * terminal state onto the row first — otherwise the row stays active, the bounded
   * drain can never confirm, and deletion defers until the 30-minute orphan cutoff.
   */
  it('does not settle a pause hand-off still in flight (started row, paused job)', async () => {
    jest.useFakeTimers();
    const started = { ...run(), status: 'started' };
    const getActive = jest.fn<Promise<ActiveRun[]>, [string]>().mockResolvedValue([started]);
    const service = makeService(getActive);
    mockJobStore = {
      getJob: jest.fn(async () => ({
        status: 'requires_action',
        createdAt: 1,
        scheduleId: 's1',
        scheduledFor: new Date('2026-01-01T00:00:00.000Z').toISOString(),
      })),
    } as unknown as typeof mockJobStore;

    const pending = service.quiesceUserSchedules('user-1', 'attempt-1');
    await jest.advanceTimersByTimeAsync(10_000);
    // The pause hand-off's writes are still in flight; confirming the drain here
    // let the destructive cascade run before they landed. Deferral is bounded: the
    // controller (or the paused-window reconciler) flips the row to requires_action
    // and the pending-deletion sweep retries.
    await expect(pending).resolves.toBe(false);

    expect(recordRunOutcome).not.toHaveBeenCalled();
  });

  it('settles a started run from its retained terminal job before dropping the evidence', async () => {
    jest.useFakeTimers();
    const started = { ...run(), status: 'started' };
    const getActive = jest
      .fn<Promise<ActiveRun[]>, [string]>()
      .mockResolvedValueOnce([started])
      .mockResolvedValue([]);
    const service = makeService(getActive);
    // deleteJob MUST be present: without it the store call throws, the delete never
    // happens, and this test would pass while proving nothing about the ordering.
    const deleteJob = jest.fn(async () => undefined);
    mockJobStore = {
      getJob: jest.fn(async () => ({
        status: 'complete',
        createdAt: 1,
        scheduleId: 's1',
        scheduledFor: new Date('2026-01-01T00:00:00.000Z').toISOString(),
      })),
      deleteJob,
    } as unknown as typeof mockJobStore;

    const pending = service.quiesceUserSchedules('user-1', 'attempt-1');
    await jest.advanceTimersByTimeAsync(500);
    await expect(pending).resolves.toBe(true);

    expect(recordRunOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ scheduleId: 's1', status: 'success' }),
    );
    // The retained job is the ONLY evidence this run finished, so it may not be deleted
    // until the outcome is durably recorded.
    expect(deleteJob).toHaveBeenCalled();
    expect(recordRunOutcome.mock.invocationCallOrder[0]).toBeLessThan(
      deleteJob.mock.invocationCallOrder[0],
    );
  });

  /**
   * `aborted` is the abort REQUEST landing, not the generation finishing: abortJob wins
   * its status CAS before the owner unwinds, and both owner paths settle LAST, after
   * saveMessage. Settling on that evidence confirms the drain while the partial write is
   * still in flight — account deletion then destroys the user's data and the owner
   * writes a message back for the account that no longer exists.
   */
  it('does not settle a run whose abort is still in flight', async () => {
    jest.useFakeTimers();
    const aborting = {
      ...run(),
      status: 'started',
      abortRequestedAt: new Date(Date.now() - 1000),
    };
    const service = makeService(
      jest.fn<Promise<ActiveRun[]>, [string]>().mockResolvedValue([aborting]),
    );
    mockJobStore = {
      getJob: jest.fn(async () => ({
        status: 'aborted',
        createdAt: 1,
        scheduleId: 's1',
        scheduledFor: new Date('2026-01-01T00:00:00.000Z').toISOString(),
      })),
      deleteJob: jest.fn(async () => undefined),
    } as unknown as typeof mockJobStore;

    const pending = service.quiesceUserSchedules('user-1', 'attempt-1');
    await jest.advanceTimersByTimeAsync(10_000);
    // Unconfirmed, so the caller defers deletion (503 + Retry-After) instead of
    // destroying data the owner is still writing.
    await expect(pending).resolves.toBe(false);
    expect(recordRunOutcome).not.toHaveBeenCalled();
  });

  /**
   * The other direction: an abort whose owner never came back is presumed dead past the
   * grace, or the account could never be deleted at all.
   */
  it('settles a run whose abort request has outlived the owner grace', async () => {
    jest.useFakeTimers();
    const abandoned = {
      ...run(),
      status: 'started',
      abortRequestedAt: new Date(Date.now() - 45 * 60 * 1000),
    };
    const getActive = jest
      .fn<Promise<ActiveRun[]>, [string]>()
      .mockResolvedValueOnce([abandoned])
      .mockResolvedValue([]);
    const service = makeService(getActive);
    mockJobStore = {
      getJob: jest.fn(async () => null),
      deleteJob: jest.fn(async () => undefined),
    } as unknown as typeof mockJobStore;

    const pending = service.quiesceUserSchedules('user-1', 'attempt-1');
    await jest.advanceTimersByTimeAsync(500);
    await expect(pending).resolves.toBe(true);
    expect(recordRunOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ scheduleId: 's1', status: 'interrupted' }),
    );
  });

  it('keeps the retained job when settling it fails', async () => {
    jest.useFakeTimers();
    const started = { ...run(), status: 'started' };
    const service = makeService(
      jest.fn<Promise<ActiveRun[]>, [string]>().mockResolvedValue([started]),
    );
    const deleteJob = jest.fn(async () => undefined);
    mockJobStore = {
      getJob: jest.fn(async () => ({
        status: 'complete',
        createdAt: 1,
        scheduleId: 's1',
        scheduledFor: new Date('2026-01-01T00:00:00.000Z').toISOString(),
      })),
      deleteJob,
    } as unknown as typeof mockJobStore;
    recordRunOutcome.mockRejectedValue(new Error('mongo down'));

    const pending = service.quiesceUserSchedules('user-1', 'attempt-1');
    await jest.advanceTimersByTimeAsync(11_000);
    // The row never settles, so the drain cannot confirm and deletion defers.
    await expect(pending).resolves.toBe(false);

    // Evidence intact for the next pass.
    expect(deleteJob).not.toHaveBeenCalled();
  });

  it('does not wait when the user has no active runs', async () => {
    jest.useFakeTimers();
    const getActive = jest.fn<Promise<ActiveRun[]>, [string]>().mockResolvedValue([]);
    const service = makeService(getActive);

    // Nothing to abort and nothing to drain, so the quiesce is trivially CONFIRMED and
    // the deletion cascade may proceed to its destructive steps.
    await expect(service.quiesceUserSchedules('user-1', 'attempt-1')).resolves.toBe(true);
    // Only the initial collection read; the drain loop is skipped for an empty set.
    expect(getActive).toHaveBeenCalledTimes(1);
  });

  /** A `requires_action` row whose HITL approval was resumed through the chat UI. */
  const pausedRun = (): ActiveRun => ({ ...run(), status: 'requires_action' });

  it('does not terminalize a paused row whose resumed generation is still running', async () => {
    jest.useFakeTimers();
    // Backward-compatibility case from a pre-capacity resume (or rolling deploy):
    // the job is running while the durable row still reads paused.
    mockJobStore = {
      getJob: jest.fn(async () => ({
        status: 'running',
        scheduleId: 's1',
        scheduledFor: '2026-01-01T00:00:00.000Z',
        createdAt: 1,
      })),
    };
    const getActive = jest.fn<Promise<ActiveRun[]>, [string]>().mockResolvedValue([pausedRun()]);
    const service = makeService(getActive);

    const pending = service.quiesceUserSchedules('user-1', 'attempt-1');
    await jest.advanceTimersByTimeAsync(10_000);
    // Terminalizing here would drop the row out of the active set, so the drain would
    // report nothing to wait for and the destructive cascade could delete messages the
    // resumed generation is still able to persist.
    await expect(pending).resolves.toBe(false);
    expect(recordRunOutcome).not.toHaveBeenCalled();
  });

  it('still terminalizes a genuinely paused row so deletion is not blocked forever', async () => {
    jest.useFakeTimers();
    // Paused for approval, no live generation behind it.
    mockJobStore = {
      getJob: jest.fn(async () => ({
        status: 'requires_action',
        scheduleId: 's1',
        scheduledFor: '2026-01-01T00:00:00.000Z',
        createdAt: 1,
      })),
    };
    const getActive = jest.fn<Promise<ActiveRun[]>, [string]>().mockResolvedValue([pausedRun()]);
    const service = makeService(getActive);

    const pending = service.quiesceUserSchedules('user-1', 'attempt-1');
    await jest.advanceTimersByTimeAsync(10_000);
    await pending;
    // An approval that will never be consumed must not keep the account undeletable.
    expect(recordRunOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ scheduleId: 's1', status: 'interrupted' }),
    );
  });

  it('does not terminalize a paused row when the job lookup FAILS', async () => {
    jest.useFakeTimers();
    mockJobStore = {
      getJob: jest.fn(async () => {
        throw new Error('redis unavailable');
      }),
    };
    const getActive = jest.fn<Promise<ActiveRun[]>, [string]>().mockResolvedValue([pausedRun()]);
    const service = makeService(getActive);

    const pending = service.quiesceUserSchedules('user-1', 'attempt-1');
    await jest.advanceTimersByTimeAsync(10_000);
    // A thrown lookup is evidence of NOTHING. Reading it as "genuinely paused" would
    // terminalize a row whose resumed generation may still be running, and the drain
    // would then permit the destructive cascade.
    await expect(pending).resolves.toBe(false);
    expect(recordRunOutcome).not.toHaveBeenCalled();
  });

  it('terminalizes a paused row when a replacement turn took over the conversation', async () => {
    jest.useFakeTimers();
    // A replacement user turn reuses the conversationId but strips the scheduled
    // identity, so this running job is NOT this occurrence's generation.
    mockJobStore = {
      getJob: jest.fn(async () => ({ status: 'running', createdAt: 1 })),
    };
    const getActive = jest.fn<Promise<ActiveRun[]>, [string]>().mockResolvedValue([pausedRun()]);
    const service = makeService(getActive);

    const pending = service.quiesceUserSchedules('user-1', 'attempt-1');
    await jest.advanceTimersByTimeAsync(10_000);
    await pending;
    expect(recordRunOutcome).toHaveBeenCalled();
  });
});

describe('global kill switch', () => {
  const noRuns = () => jest.fn<Promise<ActiveRun[]>, [string]>().mockResolvedValue([]);

  afterEach(() => {
    delete process.env.SCHEDULES_DISABLED;
  });

  it('is off by default', async () => {
    const service = makeService(noRuns());
    expect(await service.engineDeps.isGloballyDisabled()).toBe(false);
  });

  it('trips on the SCHEDULES_DISABLED env lever without reading config', async () => {
    process.env.SCHEDULES_DISABLED = 'true';
    // Throwing getAppConfig proves the env lever works even when the config plane is
    // unhealthy — the case where a config-dependent kill switch would fail.
    const getAppConfig = jest.fn(async () => {
      throw new Error('config plane down');
    }) as unknown as SchedulesServiceDeps['getAppConfig'];
    const service = makeService(noRuns(), getAppConfig);
    expect(await service.engineDeps.isGloballyDisabled()).toBe(true);
    expect(getAppConfig).not.toHaveBeenCalled();
  });

  it('trips on `interface.schedules: false` read from the BASE config only', async () => {
    const getAppConfig = jest.fn(async (options?: { baseOnly?: boolean }) =>
      options?.baseOnly === true
        ? { interfaceConfig: { schedules: false } }
        : // A principal-merged view that re-enables must NOT be consulted: the global
          // stop is base-only so no role/user/tenant override can widen past it.
          { interfaceConfig: { schedules: true } },
    ) as unknown as SchedulesServiceDeps['getAppConfig'];
    const service = makeService(noRuns(), getAppConfig);
    expect(await service.engineDeps.isGloballyDisabled()).toBe(true);
    expect(getAppConfig).toHaveBeenCalledWith({ baseOnly: true });
  });

  it('does not trip when only a principal-merged config disables it', async () => {
    // Per-principal availability is NOT the global stop; the engine keeps claiming so
    // other principals still fire, and the fire path skips this owner's occurrences.
    const getAppConfig = jest.fn(async (options?: { baseOnly?: boolean }) =>
      options?.baseOnly === true
        ? { interfaceConfig: { schedules: true } }
        : { interfaceConfig: { schedules: false } },
    ) as unknown as SchedulesServiceDeps['getAppConfig'];
    const service = makeService(noRuns(), getAppConfig);
    expect(await service.engineDeps.isGloballyDisabled()).toBe(false);
  });

  it('trips on the object form `{ use: false }` exactly like the boolean stop', async () => {
    // Both stop shapes must FREEZE occurrences (engine stops claiming, nothing
    // advances). A shape-blind gate left the engine claiming while getLimits refused
    // fires, so the disabled path ADVANCED each occurrence — a short maintenance stop
    // silently dropped everything it covered instead of leaving it due.
    const getAppConfig = jest.fn(async () => ({
      interfaceConfig: { schedules: { use: false, maxPerUser: 5 } },
    })) as unknown as SchedulesServiceDeps['getAppConfig'];
    const service = makeService(noRuns(), getAppConfig);
    expect(await service.engineDeps.isGloballyDisabled()).toBe(true);
  });

  it('does not trip on the object form while `use` stays enabled', async () => {
    const getAppConfig = jest.fn(async () => ({
      interfaceConfig: { schedules: { use: true, maxPerUser: 5 } },
    })) as unknown as SchedulesServiceDeps['getAppConfig'];
    const service = makeService(noRuns(), getAppConfig);
    expect(await service.engineDeps.isGloballyDisabled()).toBe(false);
  });
});

describe('scheduled resume capacity', () => {
  function makeResumeService(
    occupancy: { takenSlots: number[]; unslotted: number },
    over: {
      scheduleProjectId?: string;
      projectConfig?: Record<string, unknown>;
      project?: unknown;
    } = {},
  ) {
    const methods = {
      getScheduleById: jest.fn(async () => ({
        id: 's1',
        user: 'user-1',
        enabled: true,
        configRevision: 3,
        ...(over.scheduleProjectId != null && { chatProjectId: over.scheduleProjectId }),
      })),
      getRoleByName: jest.fn(async () => ({ permissions: { SCHEDULES: { USE: true } } })),
      getCapacityOccupancy: jest.fn(async () => occupancy),
      acquireResumeLease: jest.fn(async () => ({
        id: 's1',
        claimToken: 'resume-token',
        leaseBy: 'resume:resume-token',
      })),
      consumeResumeLease: jest.fn(async () => true),
      releaseLeaseByHolder: jest.fn(async () => undefined),
      markRunResumeClaimed: jest.fn(async (_id, _scheduledFor, capacitySlot) => ({
        capacitySlot,
      })),
      releaseRunResumeClaim: jest.fn(async () => true),
    };
    const service = createSchedulesService({
      methods: methods as unknown as SchedulesServiceDeps['methods'],
      getAppConfig: jest.fn(async () => ({
        interfaceConfig: {
          schedules: {
            use: true,
            maxPerUser: 10,
            minIntervalMinutes: 60,
            autoDisableAfterFailures: 5,
            admissionConcurrency: 20,
            fireConcurrency: 1,
            mcpPreflightConcurrency: 3,
            mcpPreflightTimeoutMs: 300_000,
            ...(over.projectConfig ?? {}),
          },
        },
      })),
      findUserById: jest.fn(async () => ({ _id: 'user-1', role: 'USER' })),
      findBalance: jest.fn(async () => null),
      upsertBalance: jest.fn(async () => null),
      initializeNullBalance: jest.fn(async () => null),
      preflightMCP: jest.fn().mockResolvedValue([]),
      resolveAgentFireAccess: jest.fn(async () => 'ok' as const),
      getChatProject: jest.fn(async () => ('project' in over ? over.project : { _id: 'proj-1' })),
      isUserDeleting: jest.fn(async () => false),
      enqueueAgentTrigger: jest.fn(async () => undefined),
      getTriggerDelivery: jest.fn(async () => null),
    } as unknown as SchedulesServiceDeps);
    return { service, methods };
  }

  it('promotes a pause through the global slot allocator and releases by exact slot', async () => {
    const { service, methods } = makeResumeService({ takenSlots: [], unslotted: 0 });
    const scheduledFor = '2026-08-17T12:00:00.000Z';

    await expect(service.claimScheduleResume('s1', scheduledFor)).resolves.toEqual({
      capacitySlot: 0,
      claimToken: 'resume-token',
      leaseBy: 'resume:resume-token',
    });
    expect(methods.acquireResumeLease).toHaveBeenCalledWith('s1', undefined, true, 60_000);
    expect(methods.markRunResumeClaimed).toHaveBeenCalledWith('s1', new Date(scheduledFor), 0);
    await expect(
      service.finalizeScheduleResumeClaim('s1', 'resume-token', 'resume:resume-token', {
        expectedConfigRevision: 3,
        automatic: true,
      }),
    ).resolves.toBe(true);
    expect(methods.consumeResumeLease).toHaveBeenCalledWith(
      's1',
      'resume-token',
      'resume:resume-token',
      true,
      3,
    );
    await expect(service.releaseScheduleResumeClaim('s1', scheduledFor, 0)).resolves.toBe(true);
    expect(methods.releaseRunResumeClaim).toHaveBeenCalledWith('s1', new Date(scheduledFor), 0);
  });

  it('leaves the paused row untouched when deployment capacity is full', async () => {
    const { service, methods } = makeResumeService({ takenSlots: [0], unslotted: 0 });

    await expect(service.claimScheduleResume('s1', '2026-08-17T12:00:00.000Z')).resolves.toEqual({
      conflict: 'capacity',
    });
    expect(methods.markRunResumeClaimed).not.toHaveBeenCalled();
    expect(methods.releaseLeaseByHolder).toHaveBeenCalledWith('s1', 'resume:resume-token');
  });

  it('normalizes an exhausted slot-collision retry to public capacity conflict', async () => {
    const { service, methods } = makeResumeService({ takenSlots: [], unslotted: 0 });
    methods.markRunResumeClaimed.mockResolvedValue({ conflict: 'slot-taken' } as never);

    await expect(service.claimScheduleResume('s1', '2026-08-17T12:00:00.000Z')).resolves.toEqual({
      conflict: 'capacity',
    });
  });

  it('refuses a resume whose schedule revision changed before the capacity handoff', async () => {
    const { service, methods } = makeResumeService({ takenSlots: [], unslotted: 0 });

    await expect(
      service.claimScheduleResume('s1', '2026-08-17T12:00:00.000Z', {
        expectedConfigRevision: 2,
        automatic: true,
      }),
    ).resolves.toEqual({ conflict: 'inactive' });
    expect(methods.markRunResumeClaimed).not.toHaveBeenCalled();
  });

  it('refuses an edit that wins during async policy checks at the final schedule CAS', async () => {
    const { service, methods } = makeResumeService({ takenSlots: [], unslotted: 0 });
    methods.acquireResumeLease.mockResolvedValue(null as never);

    await expect(
      service.claimScheduleResume('s1', '2026-08-17T12:00:00.000Z', {
        expectedConfigRevision: 3,
        automatic: true,
      }),
    ).resolves.toEqual({ conflict: 'inactive' });
    expect(methods.acquireResumeLease).toHaveBeenCalledWith('s1', 3, true, 60_000);
    expect(methods.markRunResumeClaimed).not.toHaveBeenCalled();
  });

  it('releases the old holder when the post-approval schedule handoff loses', async () => {
    const { service, methods } = makeResumeService({ takenSlots: [], unslotted: 0 });
    methods.consumeResumeLease.mockResolvedValue(false);

    await expect(
      service.finalizeScheduleResumeClaim('s1', 'resume-token', 'resume:resume-token', {
        expectedConfigRevision: 3,
        automatic: true,
      }),
    ).resolves.toBe(false);
    expect(methods.releaseLeaseByHolder).toHaveBeenCalledWith('s1', 'resume:resume-token');
  });

  it('refuses a disabled automatic resume but preserves explicit Run Now semantics', async () => {
    const { service, methods } = makeResumeService({ takenSlots: [], unslotted: 0 });
    methods.getScheduleById.mockResolvedValue({
      id: 's1',
      user: 'user-1',
      enabled: false,
      configRevision: 3,
    });

    await expect(
      service.claimScheduleResume('s1', '2026-08-17T12:00:00.000Z', {
        expectedConfigRevision: 3,
        automatic: true,
      }),
    ).resolves.toEqual({ conflict: 'inactive' });
    await expect(
      service.claimScheduleResume('s1', '2026-08-17T12:00:00.000Z', {
        expectedConfigRevision: 3,
        automatic: false,
      }),
    ).resolves.toEqual({
      capacitySlot: 0,
      claimToken: 'resume-token',
      leaseBy: 'resume:resume-token',
    });
  });

  it('refuses a resume when the owner lost schedule access before the capacity handoff', async () => {
    const { service, methods } = makeResumeService({ takenSlots: [], unslotted: 0 });
    methods.getRoleByName.mockResolvedValue({ permissions: { SCHEDULES: { USE: false } } });

    await expect(
      service.claimScheduleResume('s1', '2026-08-17T12:00:00.000Z', {
        expectedConfigRevision: 3,
        automatic: true,
      }),
    ).resolves.toEqual({ conflict: 'inactive' });
    expect(methods.markRunResumeClaimed).not.toHaveBeenCalled();
  });
});

describe('deployment-wide limits', () => {
  const noRuns = () => jest.fn<Promise<ActiveRun[]>, [string]>().mockResolvedValue([]);

  it('resolves a principal-less getLimits from the BASE config only', async () => {
    const getAppConfig = jest.fn(async (options?: { baseOnly?: boolean }) =>
      options?.baseOnly === true
        ? {
            interfaceConfig: {
              schedules: { use: true, fireConcurrency: 1, mcpPreflightConcurrency: 3 },
            },
          }
        : // The principal/tenant-merged view. A bare getAppConfig() resolves THIS,
          // including whatever tenant the ALS context happens to carry.
          {
            interfaceConfig: {
              schedules: { use: true, fireConcurrency: 5, mcpPreflightConcurrency: 3 },
            },
          },
    ) as unknown as SchedulesServiceDeps['getAppConfig'];
    const service = makeService(noRuns(), getAppConfig);
    const limits = await service.getLimits();
    // NO principal must mean the DEPLOYMENT's config. Both callers of this form run
    // inside a tenant context (fireSchedule clamps the global capacity allocator from
    // within runInTenantContext(owner); the engine tick budgets from within
    // runAsSystem), so resolving the merged view would let a tenant override widen the
    // very global cap it is clamped against.
    expect(limits.fireConcurrency).toBe(1);
    expect(getAppConfig).toHaveBeenCalledWith({ baseOnly: true });
  });
});

describe('durable trigger wiring', () => {
  const noRuns = () => jest.fn<Promise<ActiveRun[]>, [string]>().mockResolvedValue([]);

  it('uses the shared trigger service instead of owning a second loopback transport', async () => {
    const enqueueAgentTrigger = jest.fn(async () => ({ status: 'queued' }));
    const service = makeService(noRuns(), undefined, enqueueAgentTrigger);
    const envelope = { version: 1, mode: 'fire' } as never;

    await service.engineDeps.enqueueTrigger(envelope, { orderingKey: 'schedule-1' });

    expect(enqueueAgentTrigger).toHaveBeenCalledWith(envelope, {
      orderingKey: 'schedule-1',
    });
  });
});

describe('admission revision fence', () => {
  const noRuns = () => jest.fn<Promise<ActiveRun[]>, [string]>().mockResolvedValue([]);

  function serviceWithSchedule(schedule: { configRevision?: number; enabled?: boolean } | null) {
    const service = makeService(noRuns());
    (
      service.engineDeps.methods as unknown as {
        getScheduleById: jest.Mock;
      }
    ).getScheduleById = jest.fn(async () => schedule);
    return service;
  }

  it('admits when the claimed revision still matches', async () => {
    const service = serviceWithSchedule({ configRevision: 3 });
    expect(await service.isScheduleLive('sched-1', 3)).toBe(true);
  });

  it('REFUSES when an owner edit moved the revision on after the claim', async () => {
    // The fire was claimed under revision 3; the owner edited since (now 4). Persisting
    // would write the OLD prompt/agent into the edited schedule's history.
    const service = serviceWithSchedule({ configRevision: 4 });
    expect(await service.isScheduleLive('sched-1', 3)).toBe(false);
  });

  /**
   * A policy auto-disable flips `enabled` WITHOUT touching configRevision (an older
   * paused occurrence can resume, fail and cross the threshold while a newer occurrence
   * is already in the claim-to-controller window), so the revision fence cannot see it.
   */
  it('refuses an AUTOMATIC fire once the schedule was disabled', async () => {
    const service = serviceWithSchedule({ configRevision: 3, enabled: false });
    expect(await service.isScheduleLive('sched-1', 3, { automatic: true })).toBe(false);
  });

  it('still admits Run Now on a disabled schedule', async () => {
    // An explicit user action, matching fireScheduleNow's own relaxation.
    const service = serviceWithSchedule({ configRevision: 3, enabled: false });
    expect(await service.isScheduleLive('sched-1', 3, { automatic: false })).toBe(true);
    expect(await service.isScheduleLive('sched-1', 3)).toBe(true);
  });

  it('admits an automatic fire while the schedule is still enabled', async () => {
    const service = serviceWithSchedule({ configRevision: 3, enabled: true });
    expect(await service.isScheduleLive('sched-1', 3, { automatic: true })).toBe(true);
  });

  it('refuses a schedule that is gone regardless of revision', async () => {
    const service = serviceWithSchedule(null);
    expect(await service.isScheduleLive('sched-1', 3)).toBe(false);
  });

  it('stays permissive when either side has no revision (pre-existing rows)', async () => {
    expect(await serviceWithSchedule({}).isScheduleLive('sched-1', 3)).toBe(true);
    expect(await serviceWithSchedule({ configRevision: 4 }).isScheduleLive('sched-1')).toBe(true);
  });
});

describe('abort stamp is load-bearing (withheld abort on stamp failure)', () => {
  it('withholds the abort and reports unconfirmed when the stamp cannot be made durable', async () => {
    const service = makeService(jest.fn<Promise<ActiveRun[]>, [string]>().mockResolvedValue([]));
    const methods = service.engineDeps.methods as unknown as {
      markScheduleDeleting: jest.Mock;
      getActiveRunsForSchedule: jest.Mock;
      eraseScheduleIfDrained: jest.Mock;
      requestRunAbort: jest.Mock;
    };
    methods.markScheduleDeleting = jest.fn(async () => ({ id: 's1', user: 'user-1' }));
    methods.getActiveRunsForSchedule = jest.fn(async () => [
      {
        scheduleId: 's1',
        scheduledFor: new Date('2026-01-01T00:00:00.000Z'),
        conversationId: 'c1',
        status: 'started',
      },
    ]);
    methods.eraseScheduleIfDrained = jest.fn(async () => true);
    // The stamp is what makes concurrent drains and the reconciler defer to the
    // owner's settle; signalling an abort without it re-opens the drain-mid-write
    // window the stamp exists to close.
    methods.requestRunAbort = jest.fn(async () => {
      throw new Error('mongo down');
    });
    mockJobStore = {
      getJob: jest.fn(async () => ({
        status: 'running',
        createdAt: 1,
        scheduleId: 's1',
        scheduledFor: '2026-01-01T00:00:00.000Z',
      })),
    } as unknown as typeof mockJobStore;
    const manager = jest.requireMock('../stream/GenerationJobManager').GenerationJobManager;
    manager.abortJob = jest.fn(async () => ({ success: true }));

    await expect(service.deleteScheduleForOwner('s1', 'user-1')).resolves.toBe('unconfirmed');
    expect(manager.abortJob).not.toHaveBeenCalled();
  });

  it('reports an exact generation that remains active as not stopped', async () => {
    const service = makeService(jest.fn<Promise<ActiveRun[]>, [string]>().mockResolvedValue([]));
    mockJobStore = {
      getJob: jest.fn(async () => ({
        status: 'running',
        createdAt: 1,
        scheduleId: 's1',
        scheduledFor: '2026-01-01T00:00:00.000Z',
      })),
    } as unknown as typeof mockJobStore;
    const manager = jest.requireMock('../stream/GenerationJobManager').GenerationJobManager;
    manager.abortJob = jest.fn(async () => ({
      success: false,
      failureReason: 'job_still_active',
    }));

    const delivered = await service.engineDeps.abortScheduledJob(
      'c1',
      { scheduleId: 's1', scheduledFor: '2026-01-01T00:00:00.000Z' },
      { preserve: true },
    );
    expect(delivered).toBe(false);
  });
});

describe('deleteScheduleForOwner waits for the settle acknowledgement', () => {
  it('converges when an unconfirmed abort settles during the bounded drain', async () => {
    const service = makeService(jest.fn<Promise<ActiveRun[]>, [string]>().mockResolvedValue([]));
    const methods = service.engineDeps.methods as unknown as {
      markScheduleDeleting: jest.Mock;
      getActiveRunsForSchedule: jest.Mock;
      eraseScheduleIfDrained: jest.Mock;
    };
    methods.markScheduleDeleting = jest.fn(async () => ({ id: 's1', user: 'user-1' }));
    // Active at the abort pass, drained by the first drain poll: the owner settled.
    methods.getActiveRunsForSchedule = jest
      .fn()
      .mockResolvedValueOnce([
        {
          scheduleId: 's1',
          scheduledFor: new Date('2026-01-01T00:00:00.000Z'),
          conversationId: 'c1',
          status: 'started',
        },
      ])
      .mockResolvedValue([]);
    methods.eraseScheduleIfDrained = jest.fn(async () => true);
    mockJobStore = {
      getJob: jest.fn(async () => ({
        status: 'running',
        createdAt: 1,
        scheduleId: 's1',
        scheduledFor: '2026-01-01T00:00:00.000Z',
      })),
    } as unknown as typeof mockJobStore;
    const manager = jest.requireMock('../stream/GenerationJobManager').GenerationJobManager;
    // Delivery cannot be locally proven (peer-owned generation): honest false...
    manager.abortJob = jest.fn(async () => ({ success: true, signalDelivered: false }));

    // ...but the run row leaving the active set is the durable acknowledgement, so
    // the delete converges instead of answering a spurious 503.
    await expect(service.deleteScheduleForOwner('s1', 'user-1')).resolves.toBe('deleted');
  });
});

describe('provider-drained schedule aborts', () => {
  it('waits on the exact terminal generation instead of using the removed re-signal path', async () => {
    const service = makeService(jest.fn<Promise<ActiveRun[]>, [string]>().mockResolvedValue([]));
    mockJobStore = {
      getJob: jest.fn(async () => ({
        status: 'aborted',
        createdAt: 7,
        scheduleId: 's1',
        scheduledFor: '2026-01-01T00:00:00.000Z',
      })),
    } as unknown as typeof mockJobStore;
    const manager = jest.requireMock('../stream/GenerationJobManager').GenerationJobManager;
    manager.abortJob = jest.fn(async () => ({ success: false, failureReason: 'already_settled' }));

    const delivered = await service.engineDeps.abortScheduledJob(
      'c1',
      { scheduleId: 's1', scheduledFor: '2026-01-01T00:00:00.000Z' },
      { preserve: true },
    );
    expect(manager.abortJob).toHaveBeenCalledWith('c1', {
      expectedCreatedAt: 7,
      awaitProviderDrain: true,
    });
    expect(delivered).toBe(true);
  });

  it.each(['generation_replaced', 'job_still_active', 'job_not_found'] as const)(
    'reports %s as an undelivered abort',
    async (failureReason) => {
      const service = makeService(jest.fn<Promise<ActiveRun[]>, [string]>().mockResolvedValue([]));
      const deleteJob = jest.fn(async () => true);
      mockJobStore = {
        getJob: jest.fn(async () => ({
          status: 'running',
          createdAt: 7,
          scheduleId: 's1',
          scheduledFor: '2026-01-01T00:00:00.000Z',
        })),
        deleteJob,
      } as unknown as typeof mockJobStore;
      const manager = jest.requireMock('../stream/GenerationJobManager').GenerationJobManager;
      manager.abortJob = jest.fn(async () => ({ success: false, failureReason }));

      const delivered = await service.engineDeps.abortScheduledJob(
        'c1',
        { scheduleId: 's1', scheduledFor: '2026-01-01T00:00:00.000Z' },
        { preserve: false },
      );

      expect(delivered).toBe(false);
      // Never destroy evidence for a generation this call did not stop.
      expect(deleteJob).not.toHaveBeenCalled();
    },
  );

  it('deletes terminal evidence only after the exact provider drain is confirmed', async () => {
    const service = makeService(jest.fn<Promise<ActiveRun[]>, [string]>().mockResolvedValue([]));
    const deleteJob = jest.fn(async () => true);
    mockJobStore = {
      getJob: jest.fn(async () => ({
        status: 'aborted',
        createdAt: 7,
        scheduleId: 's1',
        scheduledFor: '2026-01-01T00:00:00.000Z',
      })),
      deleteJob,
    } as unknown as typeof mockJobStore;
    const manager = jest.requireMock('../stream/GenerationJobManager').GenerationJobManager;
    manager.abortJob = jest.fn(async () => ({ success: false, failureReason: 'already_settled' }));

    const delivered = await service.engineDeps.abortScheduledJob(
      'c1',
      { scheduleId: 's1', scheduledFor: '2026-01-01T00:00:00.000Z' },
      { preserve: false },
    );
    expect(delivered).toBe(true);
    expect(manager.abortJob).toHaveBeenCalledWith('c1', {
      expectedCreatedAt: 7,
      awaitProviderDrain: true,
    });
    expect(deleteJob).toHaveBeenCalledWith('c1', 7);
  });
});
