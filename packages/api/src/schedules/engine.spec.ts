import type { ScheduleEngineDeps, ScheduleLimits, ScheduleUserContext } from './types';
import type { FireableSchedule } from './types';
import { startScheduleEngine } from './engine';

const LEASE_MS = 5 * 60_000;
const OWNER: ScheduleUserContext = { id: 'user-1', tenantId: 't1', role: 'USER' };
const LIMITS: ScheduleLimits = {
  enabled: true,
  maxPerUser: 10,
  minIntervalMinutes: 60,
  autoDisableAfterFailures: 5,
  admissionConcurrency: 20,
  fireConcurrency: 5,
  mcpPreflightConcurrency: 3,
  mcpPreflightTimeoutMs: 300_000,
  requireProject: false,
};

/**
 * A schedule due 60s ago whose lease was just taken, so the tick reads it as due
 * rather than misfired (`dbNow` is derived from `leaseUntil - LEASE_MS`).
 */
function makeClaimedSchedule(overrides: Partial<FireableSchedule> = {}): FireableSchedule {
  const now = Date.now();
  return {
    id: 'sched-1',
    user: 'user-1' as never,
    tenantId: 't1',
    name: 'Digest',
    prompt: 'Summarize',
    agent_id: 'agent-1',
    cadence: { frequency: 'daily', hour: 8, minute: 0 },
    timezone: 'America/New_York',
    target: 'new',
    enabled: true,
    claimToken: 'ct-1',
    leaseBy: 'inst-1',
    nextRunAt: new Date(now - 60_000),
    leaseUntil: new Date(now + LEASE_MS),
    runCount: 0,
    failureCount: 0,
    balanceSkipCount: 0,
    ...overrides,
  } as FireableSchedule;
}

function makeMethods(schedule: FireableSchedule) {
  let claims = 0;
  return {
    // One claimable occurrence per tick, then the claim scan comes up empty.
    claimDueSchedule: jest.fn(async () => (claims++ === 0 ? schedule : null)),
    countActiveRuns: jest.fn(async () => 0),
    advanceSchedule: jest.fn(
      async (_id: string, _next: Date | null, _from?: Date, _token?: string) => true,
    ),
    releaseLeaseByHolder: jest.fn(async () => undefined),
    disableSchedule: jest.fn(async (_id: string, _reason: string, _token?: string) => undefined),
    releaseLease: jest.fn(async () => true),
    holdsLease: jest.fn(async () => true),
    scheduleExists: jest.fn(async () => true),
    deleteScheduleRun: jest.fn(async () => undefined),
    getRunsForReconciliation: jest.fn(async () => []),
    markRunsReconciled: jest.fn(async () => undefined),
    getUnbookkeptRuns: jest.fn(async () => []),
    getDeletingSchedules: jest.fn(async () => []),
    markEraseAttempted: jest.fn(async () => undefined),
    recordRunOutcome: jest.fn(async () => undefined),
    getUnarmedSchedules: jest.fn(async () => []),
    armSchedule: jest.fn(async () => undefined),
    eraseScheduleIfDrained: jest.fn(async () => true),
    finalizeBookkeeping: jest.fn(async () => undefined),
  };
}

function makeDeps(
  methods: ReturnType<typeof makeMethods>,
  over: Partial<ScheduleEngineDeps> = {},
): ScheduleEngineDeps {
  return {
    methods: methods as unknown as ScheduleEngineDeps['methods'],
    getLimits: async () => LIMITS,
    getUserContext: async () => OWNER,
    isOutOfBalance: async () => false,
    preflightMCP: jest.fn().mockResolvedValue([]),
    agentAccess: async () => 'ok',
    hasScheduleAccess: async () => true,
    resolveFiles: async () => [],
    enqueueTrigger: jest.fn(async () => undefined),
    getTriggerDelivery: async () => null,
    runInTenantContext: (_user, fn) => fn(),
    getJobStatus: async () => null,
    abortScheduledJob: async () => undefined,
    clearReconciledJob: async () => undefined,
    isOwnerDeleting: async () => false,
    isGloballyDisabled: async () => false,
    countActiveRunsGlobal: async () => 0,
    withGlobalCapacitySlot: (_cap: number, claim: (slot: number) => Promise<unknown>) => claim(0),
    ...over,
  } as ScheduleEngineDeps;
}

/** Builds the engine and immediately parks its timer; tests drive `runTick` directly. */
async function tickOnce(deps: ScheduleEngineDeps): Promise<void> {
  const engine = startScheduleEngine(deps);
  engine.stop();
  await engine.runTick();
}

/** Drives one AWAITED reconciliation pass (startup's own is fire-and-forget). */
async function reconcileOnce(deps: ScheduleEngineDeps): Promise<void> {
  const engine = startScheduleEngine(deps);
  engine.stop();
  await engine.reconcile();
}

afterEach(() => jest.restoreAllMocks());

/** Overdue past MISFIRE_GRACE_MS (15m), so the tick skips it forward instead of firing. */
const staleAt = () => new Date(Date.now() - 20 * 60_000);

describe('runTick misfire skip-forward', () => {
  it('advances a stale occurrence to the next future one', async () => {
    const schedule = makeClaimedSchedule({ nextRunAt: staleAt() });
    const methods = makeMethods(schedule);
    const fetchSpy = jest.fn();
    global.fetch = fetchSpy as never;
    await tickOnce(makeDeps(methods));
    // Skipping forward is the whole point of the branch. Leaving nextRunAt on the
    // stale occurrence would make every later tick reclaim and skip the same one,
    // so a schedule overdue past an outage would never fire again.
    expect(methods.advanceSchedule).toHaveBeenCalledTimes(1);
    const [id, next, expectedFrom, token] = methods.advanceSchedule.mock.calls[0];
    expect(id).toBe('sched-1');
    expect(next).toBeInstanceOf(Date);
    expect(next?.getTime()).toBeGreaterThan(Date.now());
    // Fenced on the claimed occurrence and the claim token, so a re-claim or an
    // owner edit is not clobbered.
    expect(expectedFrom).toBe(schedule.nextRunAt);
    expect(token).toBe('ct-1');
    // Being overdue is not a fault: the schedule stays enabled and is not fired.
    expect(methods.disableSchedule).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('releases its old holder when an owner edit fences the misfire advance', async () => {
    const schedule = makeClaimedSchedule({ nextRunAt: staleAt() });
    const methods = makeMethods(schedule);
    // The edit rotated claimToken/nextRunAt after this worker claimed but preserved
    // its unique lease holder, so the token-fenced advance no longer matches.
    methods.advanceSchedule.mockResolvedValueOnce(false);

    await tickOnce(makeDeps(methods));

    expect(methods.releaseLeaseByHolder).toHaveBeenCalledWith('sched-1', 'inst-1');
  });

  it('disables and clears a stale occurrence whose cadence is uncomputable', async () => {
    const schedule = makeClaimedSchedule({ nextRunAt: staleAt(), timezone: 'Not/AZone' });
    const methods = makeMethods(schedule);
    await tickOnce(makeDeps(methods));
    expect(methods.disableSchedule).toHaveBeenCalledWith('sched-1', 'invalid_schedule', 'ct-1');
    expect(methods.advanceSchedule).toHaveBeenCalledWith(
      'sched-1',
      null,
      schedule.nextRunAt,
      'ct-1',
    );
  });

  it('leaves a stale occurrence alone when its disable failed', async () => {
    const schedule = makeClaimedSchedule({ nextRunAt: staleAt(), timezone: 'Not/AZone' });
    const methods = makeMethods(schedule);
    methods.disableSchedule.mockRejectedValue(new Error('mongo unavailable') as never);
    await tickOnce(makeDeps(methods));
    // Clearing nextRunAt without the disable landing would leave `enabled: true`
    // with no nextRunAt and no disabledReason: unclaimable and invisible.
    expect(methods.advanceSchedule).not.toHaveBeenCalled();
  });
});

describe('runTick error handling', () => {
  it('uses readiness admission capacity independently of generation capacity', async () => {
    const schedules = Array.from({ length: 6 }, (_, index) =>
      makeClaimedSchedule({
        id: `sched-${index}`,
        user: `user-${index}` as never,
        claimToken: `ct-${index}`,
        leaseBy: `inst-${index}`,
      }),
    );
    const methods = makeMethods(schedules[0]);
    const claims: Array<FireableSchedule | null> = [...schedules, null];
    methods.claimDueSchedule.mockImplementation(async () => claims.shift() ?? null);
    methods.countActiveRuns.mockResolvedValue(5);
    const getUserContext = jest.fn(async () => null);

    await tickOnce(
      makeDeps(methods, {
        getLimits: async () => ({ ...LIMITS, admissionConcurrency: 6, fireConcurrency: 1 }),
        getUserContext,
      }),
    );

    expect(getUserContext).toHaveBeenCalledTimes(6);
    expect(methods.countActiveRuns).not.toHaveBeenCalled();
  });

  it('starts later admissions while an earlier schedule is still in preflight', async () => {
    const first = makeClaimedSchedule();
    const second = makeClaimedSchedule({
      id: 'sched-2',
      user: 'user-2' as never,
      claimToken: 'ct-2',
      leaseBy: 'inst-2',
    });
    const methods = makeMethods(first);
    const claims = [first, second, null];
    methods.claimDueSchedule.mockImplementation(async () => claims.shift() ?? null);
    let releaseFirst!: () => void;
    const firstPreflight = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let markSecondStarted!: () => void;
    const secondStarted = new Promise<void>((resolve) => {
      markSecondStarted = resolve;
    });
    const getUserContext = jest.fn(
      async (userId: Parameters<ScheduleEngineDeps['getUserContext']>[0]) => {
        if (String(userId) === 'user-1') {
          await firstPreflight;
        } else {
          markSecondStarted();
        }
        return null;
      },
    );
    const engine = startScheduleEngine(makeDeps(methods, { getUserContext }));

    const tick = engine.runTick();
    await secondStarted;
    expect(getUserContext).toHaveBeenCalledWith('user-2');
    releaseFirst();
    await expect(tick).resolves.toBe(0);
    engine.stop();
  });

  it('retains the due occurrence when a preflight query throws', async () => {
    const schedule = makeClaimedSchedule();
    const methods = makeMethods(schedule);
    await tickOnce(
      makeDeps(methods, {
        // A transient infrastructure failure on one of the preflight reads.
        getUserContext: async () => {
          throw new Error('mongo unavailable');
        },
      }),
    );
    // Advancing schedules the NEXT recurrence, so the due one would be discarded
    // permanently with no ScheduleRun row and no evidence it was ever attempted.
    // The lease is left to expire instead, which re-claims THIS occurrence.
    expect(methods.advanceSchedule).not.toHaveBeenCalled();
    // A transient read failure says nothing about the schedule's validity.
    expect(methods.disableSchedule).not.toHaveBeenCalled();
  });

  it('disables and clears an uncomputable cadence whose in-fire disable threw', async () => {
    // An unparseable timezone makes the next run uncomputable, so fireSchedule
    // disables the schedule up front — and throws out to the tick when that write
    // fails. Retrying is pointless here: the occurrence can never be computed, and
    // leaving the lease would re-claim it forever.
    const schedule = makeClaimedSchedule({ timezone: 'Not/AZone' });
    const methods = makeMethods(schedule);
    methods.disableSchedule
      .mockRejectedValueOnce(new Error('mongo unavailable') as never)
      .mockResolvedValueOnce(undefined as never);
    await tickOnce(makeDeps(methods));
    expect(methods.disableSchedule).toHaveBeenCalledTimes(2);
    // null clears nextRunAt, so the disabled schedule is no longer due.
    expect(methods.advanceSchedule).toHaveBeenCalledWith(
      'sched-1',
      null,
      schedule.nextRunAt,
      'ct-1',
    );
  });

  it('does not clear nextRunAt when the disable itself keeps failing', async () => {
    const schedule = makeClaimedSchedule({ timezone: 'Not/AZone' });
    const methods = makeMethods(schedule);
    methods.disableSchedule.mockRejectedValue(new Error('mongo unavailable') as never);
    await tickOnce(makeDeps(methods));
    // Advancing on a failed disable would leave `enabled: true` with no nextRunAt
    // and no disabledReason: permanently unclaimable and invisible to its owner.
    expect(methods.advanceSchedule).not.toHaveBeenCalled();
  });
});

describe('reconciliation consults the durable trigger delivery', () => {
  const YOUNG = () => new Date(Date.now() - 5 * 60_000); // past reconcile min, before orphan cutoff
  const OLD = () => new Date(Date.now() - 60 * 60_000); // past the 30-minute orphan cutoff

  function joblessRun(firedAt: Date, deliveryKey: string | undefined = 'dk1') {
    return {
      scheduleId: 's1',
      scheduledFor: new Date('2026-01-01T00:00:00.000Z'),
      user: 'u1',
      status: 'started',
      conversationId: 'conv-1',
      firedAt,
      ...(deliveryKey != null ? { deliveryKey } : {}),
    };
  }

  async function runReconcile(
    run: ReturnType<typeof joblessRun>,
    getTriggerDelivery: ScheduleEngineDeps['getTriggerDelivery'],
  ) {
    const methods = makeMethods(makeClaimedSchedule());
    (methods.getRunsForReconciliation as jest.Mock).mockResolvedValue([run]);
    await tickOnce(makeDeps(methods, { getJobStatus: async () => null, getTriggerDelivery }));
    return methods;
  }

  it('settles a DEAD delivery as error promptly, before the 30-minute orphan age', async () => {
    const methods = await runReconcile(joblessRun(YOUNG()), async () => ({
      status: 'dead',
      // The durable record's lastError is an AgentTriggerDeliveryFailure OBJECT, not a
      // string — the recorded outcome must carry its `message`, or the String-typed
      // Mongoose field rejects the cast and the run keeps its capacity slot.
      lastError: {
        code: 'rate_limited',
        message: 'rate limited',
        certainty: 'definite' as const,
        retryable: false,
        attemptedAt: new Date(),
      },
    }));
    expect(methods.recordRunOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ scheduleId: 's1', status: 'error', error: 'rate limited' }),
    );
  });

  it('replays admission-only MCP evidence without consulting a generation job', async () => {
    const methods = makeMethods(makeClaimedSchedule());
    (methods.getRunsForReconciliation as jest.Mock).mockResolvedValue([
      {
        ...joblessRun(YOUNG()),
        admissionOnly: true,
        error: 'mcp_configuration_missing',
        mcp: [
          {
            server: 'Notion',
            agentId: 'research-agent',
            status: 'mcp_configuration_missing',
          },
        ],
      },
    ]);
    const getJobStatus = jest.fn(async () => {
      throw new Error('admission-only rows have no job');
    });

    await tickOnce(makeDeps(methods, { getJobStatus }));

    expect(getJobStatus).not.toHaveBeenCalled();
    expect(methods.recordRunOutcome).toHaveBeenCalledWith(
      expect.objectContaining({
        scheduleId: 's1',
        status: 'error',
        error: 'mcp_configuration_missing',
        clearConversationId: true,
        mcp: [
          {
            server: 'Notion',
            agentId: 'research-agent',
            status: 'mcp_configuration_missing',
          },
        ],
      }),
    );
  });

  it('does NOT orphan a PENDING delivery past the cutoff (Retry-After may still fire it)', async () => {
    const methods = await runReconcile(joblessRun(OLD()), async () => ({ status: 'pending' }));
    expect(methods.recordRunOutcome).not.toHaveBeenCalled();
  });

  it('does NOT orphan a LEASED delivery past the cutoff', async () => {
    const methods = await runReconcile(joblessRun(OLD()), async () => ({ status: 'leased' }));
    expect(methods.recordRunOutcome).not.toHaveBeenCalled();
  });

  it('does NOT orphan a STAGING delivery past the cutoff', async () => {
    const methods = await runReconcile(joblessRun(OLD()), async () => ({ status: 'staging' }));
    expect(methods.recordRunOutcome).not.toHaveBeenCalled();
  });

  it('does NOT orphan a BATCHED delivery past the cutoff', async () => {
    const methods = await runReconcile(joblessRun(OLD()), async () => ({ status: 'batched' }));
    expect(methods.recordRunOutcome).not.toHaveBeenCalled();
  });

  it('falls back to the legacy interrupted orphan for a SUCCEEDED delivery past the cutoff', async () => {
    const methods = await runReconcile(joblessRun(OLD()), async () => ({ status: 'succeeded' }));
    expect(methods.recordRunOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ scheduleId: 's1', status: 'interrupted' }),
    );
  });

  it('does not prematurely orphan a SUCCEEDED delivery before the cutoff', async () => {
    const methods = await runReconcile(joblessRun(YOUNG()), async () => ({ status: 'succeeded' }));
    expect(methods.recordRunOutcome).not.toHaveBeenCalled();
  });

  it('uses the legacy orphan policy when the delivery record is gone (null)', async () => {
    const methods = await runReconcile(joblessRun(OLD()), async () => null);
    expect(methods.recordRunOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'interrupted' }),
    );
  });

  it('DEFERS (stays reconcilable) when the delivery lookup fails', async () => {
    const methods = await runReconcile(joblessRun(OLD()), async () => {
      throw new Error('delivery store unavailable');
    });
    expect(methods.recordRunOutcome).not.toHaveBeenCalled();
  });
});

describe('reconciliation is isolated per row', () => {
  /**
   * A row that always throws must not abort the pass. The store stamps every examined
   * row afterward so persistent failures rotate behind rows the bounded window has not
   * inspected yet.
   */
  it('keeps reconciling after a row throws', async () => {
    const methods = makeMethods(makeClaimedSchedule());
    const rows = [
      { scheduleId: 'poison', scheduledFor: new Date(0), user: 'u1', status: 'started' },
      { scheduleId: 'healthy', scheduledFor: new Date(0), user: 'u1', status: 'started' },
    ];
    (methods.getRunsForReconciliation as jest.Mock).mockResolvedValue(rows);
    (methods.recordRunOutcome as jest.Mock).mockImplementation(async (params) => {
      if (params.scheduleId === 'poison') {
        throw new Error('permanently broken row');
      }
    });

    await tickOnce(
      makeDeps(methods, {
        // Both rows are orphans well past the cutoff, so both reach recordRunOutcome.
        getJobStatus: async () => null,
      }),
    );

    const settled = (methods.recordRunOutcome as jest.Mock).mock.calls.map(
      ([params]) => params.scheduleId,
    );
    expect(settled).toContain('poison');
    expect(settled).toContain('healthy');
  });
});

describe('unarmed recovery sweep', () => {
  it('disables an unarmed schedule whose cadence is uncomputable', async () => {
    const methods = makeMethods(makeClaimedSchedule());
    methods.claimDueSchedule.mockResolvedValue(null);
    const broken = makeClaimedSchedule({
      id: 'sched-broken',
      timezone: 'Not/AZone',
      claimToken: 'ct-9',
      configRevision: 4,
      nextRunAt: undefined,
    });
    const healthy = makeClaimedSchedule({
      id: 'sched-ok',
      claimToken: 'ct-10',
      nextRunAt: undefined,
    });
    (methods.getUnarmedSchedules as jest.Mock).mockResolvedValue([broken, healthy]);

    await reconcileOnce(makeDeps(methods));

    // Skipping the broken row left it enabled-but-unarmed forever: holding the
    // owner's slot, never firing, and re-filling the bounded window ahead of
    // valid crash-left rows. Fenced on token + revision so a concurrent edit
    // that repairs the cadence wins over this observation of the broken one.
    expect(methods.disableSchedule).toHaveBeenCalledWith(
      'sched-broken',
      'invalid_schedule',
      'ct-9',
      4,
    );
    expect(methods.armSchedule).toHaveBeenCalledWith('sched-ok', expect.any(Date));
  });
});

describe('bookkeeping replay rotation', () => {
  it('stamps every replayed row so persistent failures rotate out of the window', async () => {
    const methods = makeMethods(makeClaimedSchedule());
    methods.claimDueSchedule.mockResolvedValue(null);
    const poison = {
      _id: 'row-1',
      scheduleId: 'poison',
      scheduledFor: new Date(0),
      user: 'u1',
      status: 'success',
    };
    (methods.getUnbookkeptRuns as jest.Mock).mockResolvedValue([poison]);
    (methods.finalizeBookkeeping as jest.Mock).mockRejectedValue(new Error('permanently broken'));

    await reconcileOnce(makeDeps(methods));

    // getUnbookkeptRuns reads least-recently-attempted first; without the stamp a
    // batch of failing rows re-fills the bounded window and every later terminal
    // row's counters never land.
    expect(methods.markRunsReconciled).toHaveBeenCalledWith([poison]);
  });

  /**
   * A terminal run reaches this pass only because its OWNER crashed before bookkeeping —
   * which is also before it could release the job it retained for exactly this recovery.
   * A preserved job is kept WITHOUT `completedAt` so the store's finished-job sweep cannot
   * reap it early, so if this pass does not clear it, nothing ever does.
   */
  it('releases the retained job once replayed bookkeeping is durable', async () => {
    const methods = makeMethods(makeClaimedSchedule());
    methods.claimDueSchedule.mockResolvedValue(null);
    const unbookkept = {
      _id: 'row-2',
      scheduleId: 'sched-crashed',
      scheduledFor: new Date(0),
      user: 'u1',
      status: 'success',
      conversationId: 'convo-crashed',
      mcp: [{ server: 'Notion', agentId: 'research-agent', status: 'ready' }],
    };
    (methods.getUnbookkeptRuns as jest.Mock).mockResolvedValue([unbookkept]);
    const clearReconciledJob = jest.fn(async () => undefined);

    await reconcileOnce(makeDeps(methods, { clearReconciledJob }));

    expect(methods.finalizeBookkeeping).toHaveBeenCalledWith(
      expect.objectContaining({
        scheduleId: 'sched-crashed',
        mcp: [{ server: 'Notion', agentId: 'research-agent', status: 'ready' }],
      }),
    );
    expect(clearReconciledJob).toHaveBeenCalledWith('convo-crashed', {
      scheduleId: 'sched-crashed',
      scheduledFor: new Date(0),
    });
  });

  /** The retained job is the only surviving evidence when bookkeeping fails, so it must
   *  outlive a failed replay rather than be cleared alongside it. */
  it('keeps the retained job when the bookkeeping replay itself fails', async () => {
    const methods = makeMethods(makeClaimedSchedule());
    methods.claimDueSchedule.mockResolvedValue(null);
    (methods.getUnbookkeptRuns as jest.Mock).mockResolvedValue([
      {
        _id: 'row-3',
        scheduleId: 'sched-broken-bk',
        scheduledFor: new Date(0),
        user: 'u1',
        status: 'success',
        conversationId: 'convo-broken',
      },
    ]);
    (methods.finalizeBookkeeping as jest.Mock).mockRejectedValue(new Error('mongo down'));
    const clearReconciledJob = jest.fn(async () => undefined);

    await reconcileOnce(makeDeps(methods, { clearReconciledJob }));

    expect(clearReconciledJob).not.toHaveBeenCalled();
  });
});

describe('reconciliation abort fence', () => {
  const scheduledFor = new Date(0);
  const abortedRun = (abortAgeMs: number, status = 'started', jobGone = false) => ({
    scheduleId: 'sched-1',
    scheduledFor,
    user: 'u1',
    status,
    conversationId: jobGone ? 'c1' : 'c1',
    firedAt: new Date(Date.now() - 60 * 60_000),
    abortRequestedAt: new Date(Date.now() - abortAgeMs),
  });
  const abortedJob = async () => ({
    status: 'aborted',
    scheduleId: 'sched-1',
    scheduledFor: scheduledFor.toISOString(),
  });

  /**
   * A job reads `aborted` the moment abortJob wins its status CAS — BEFORE the
   * generation owner has unwound and persisted (partial response, user message).
   * Settling here releases the run mid-persistence: an account-deletion drain then
   * observes zero active runs and destroys data a pending save recreates. The owner's
   * own outcome write is the only settlement while its abort is in flight.
   */
  it('defers an aborted job while its abort is in flight', async () => {
    const methods = makeMethods(makeClaimedSchedule());
    (methods.getRunsForReconciliation as jest.Mock).mockResolvedValue([abortedRun(60_000)]);
    const clearReconciledJob = jest.fn(async () => undefined);
    await tickOnce(makeDeps(methods, { getJobStatus: abortedJob, clearReconciledJob }));

    expect(methods.recordRunOutcome).not.toHaveBeenCalled();
    expect(clearReconciledJob).not.toHaveBeenCalled();
  });

  it('finalizes an aborted job once its owner is presumed dead', async () => {
    const methods = makeMethods(makeClaimedSchedule());
    (methods.getRunsForReconciliation as jest.Mock).mockResolvedValue([abortedRun(31 * 60_000)]);
    const clearReconciledJob = jest.fn(async () => undefined);
    await tickOnce(makeDeps(methods, { getJobStatus: abortedJob, clearReconciledJob }));

    expect(methods.recordRunOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ scheduleId: 'sched-1', status: 'interrupted' }),
    );
    expect(clearReconciledJob).toHaveBeenCalled();
  });

  it('omits the conversation link when the aborted job never started', async () => {
    const methods = makeMethods(makeClaimedSchedule());
    (methods.getRunsForReconciliation as jest.Mock).mockResolvedValue([abortedRun(31 * 60_000)]);
    const preStartAbortedJob = async () => ({
      status: 'aborted',
      scheduleId: 'sched-1',
      scheduledFor: scheduledFor.toISOString(),
      createdEventEmitted: false,
    });
    await tickOnce(
      makeDeps(methods, {
        getJobStatus: preStartAbortedJob,
        clearReconciledJob: jest.fn(async () => undefined),
      }),
    );

    // A pre-start abort reserved an id but no conversation ever came to exist;
    // projecting it hands the card a link to a missing chat, and the row's
    // reserved id is erased so the crash-retry replay cannot restore it either.
    expect(methods.recordRunOutcome).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'interrupted',
        conversationId: undefined,
        clearConversationId: true,
      }),
    );
  });

  /** Account-deletion quiesce DELETES the aborted job, so post-abort absence carries
   *  the same fence: the orphan branch must not settle a run whose owner is still
   *  unwinding its persistence. */
  it('defers a vanished job while its abort is in flight', async () => {
    const methods = makeMethods(makeClaimedSchedule());
    (methods.getRunsForReconciliation as jest.Mock).mockResolvedValue([abortedRun(60_000)]);
    await tickOnce(makeDeps(methods, { getJobStatus: async () => null }));

    expect(methods.recordRunOutcome).not.toHaveBeenCalled();
  });

  it('still reaps a vanished job once the abort fence lapses', async () => {
    const methods = makeMethods(makeClaimedSchedule());
    (methods.getRunsForReconciliation as jest.Mock).mockResolvedValue([abortedRun(31 * 60_000)]);
    await tickOnce(makeDeps(methods, { getJobStatus: async () => null }));

    expect(methods.recordRunOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'interrupted' }),
    );
  });
});

describe('reconciliation resume hand-off fence', () => {
  const scheduledFor = new Date(0);
  const resumedRun = (claimAgeMs: number) => ({
    scheduleId: 'sched-1',
    scheduledFor,
    user: 'u1',
    status: 'started',
    conversationId: 'c1',
    firedAt: new Date(Date.now() - 60 * 60_000),
    resumeClaimedAt: new Date(Date.now() - claimAgeMs),
  });
  const pausedJob = async () => ({
    status: 'requires_action',
    scheduleId: 'sched-1',
    scheduledFor: scheduledFor.toISOString(),
  });

  it('does not release freshly reacquired capacity while approval claiming is in flight', async () => {
    const methods = makeMethods(makeClaimedSchedule());
    (methods.getRunsForReconciliation as jest.Mock).mockResolvedValue([resumedRun(60_000)]);

    await reconcileOnce(makeDeps(methods, { getJobStatus: pausedJob }));

    expect(methods.recordRunOutcome).not.toHaveBeenCalled();
  });

  it('does not treat a temporarily missing hand-off job as an orphan', async () => {
    const methods = makeMethods(makeClaimedSchedule());
    (methods.getRunsForReconciliation as jest.Mock).mockResolvedValue([resumedRun(60_000)]);

    await reconcileOnce(makeDeps(methods, { getJobStatus: async () => null }));

    expect(methods.recordRunOutcome).not.toHaveBeenCalled();
  });

  it('re-pauses a crashed resume after the hand-off fence expires', async () => {
    const methods = makeMethods(makeClaimedSchedule());
    (methods.getRunsForReconciliation as jest.Mock).mockResolvedValue([resumedRun(11 * 60_000)]);

    await reconcileOnce(makeDeps(methods, { getJobStatus: pausedJob }));

    expect(methods.recordRunOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ scheduleId: 'sched-1', status: 'requires_action' }),
    );
  });
});

describe('reconciliation preserves the intended outcome', () => {
  const scheduledFor = new Date(0);
  /** A run whose inline outcome write never landed: old enough to reconcile, still
   *  `started`, with the owner's retained terminal job as the only evidence. */
  const unsettledRun = () => ({
    scheduleId: 'sched-1',
    scheduledFor,
    user: 'u1',
    status: 'started',
    conversationId: 'c1',
    firedAt: new Date(Date.now() - 60 * 60_000),
  });
  const retainedComplete =
    (extra: Record<string, string> = {}) =>
    async () => ({
      status: 'complete',
      scheduleId: 'sched-1',
      scheduledFor: scheduledFor.toISOString(),
      ...extra,
    });

  /**
   * A terminal `complete` is generic: it covers a clean finish, a mid-run balance
   * refusal, and a provider failure the client swallowed into an error part. Deriving
   * `success` from it turned a transient outcome-write failure into a reset of the very
   * streaks that drive insufficient_balance and too_many_failures auto-disable.
   */
  it('recovers a balance refusal as skipped_balance, not success', async () => {
    const methods = makeMethods(makeClaimedSchedule());
    (methods.getRunsForReconciliation as jest.Mock).mockResolvedValue([unsettledRun()]);
    const clearReconciledJob = jest.fn(async () => undefined);
    await tickOnce(
      makeDeps(methods, {
        getJobStatus: retainedComplete({ scheduleOutcome: 'skipped_balance' }),
        clearReconciledJob,
      }),
    );

    expect(methods.recordRunOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ scheduleId: 'sched-1', status: 'skipped_balance' }),
    );
    expect(clearReconciledJob).toHaveBeenCalled();
  });

  it('preserves an interrupted owner outcome instead of converting it to success', async () => {
    const methods = makeMethods(makeClaimedSchedule());
    (methods.getRunsForReconciliation as jest.Mock).mockResolvedValue([unsettledRun()]);
    await tickOnce(
      makeDeps(methods, {
        getJobStatus: retainedComplete({
          scheduleOutcome: 'interrupted',
          scheduleOutcomeError: 'Stopped by owner',
        }),
        clearReconciledJob: jest.fn(async () => undefined),
      }),
    );

    expect(methods.recordRunOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'interrupted', error: 'Stopped by owner' }),
    );
  });

  it('recovers a balance refusal that claimed an ERROR terminal as skipped_balance', async () => {
    const methods = makeMethods(makeClaimedSchedule());
    (methods.getRunsForReconciliation as jest.Mock).mockResolvedValue([unsettledRun()]);
    await tickOnce(
      makeDeps(methods, {
        // A mid-continuation balance refusal finalizes through completeJob('error'),
        // so the terminal is `error` — but the stamp still routes it to the
        // insufficient_balance streak instead of too_many_failures.
        getJobStatus: async () => ({
          status: 'error',
          scheduleId: 'sched-1',
          scheduledFor: scheduledFor.toISOString(),
          scheduleOutcome: 'skipped_balance',
        }),
        clearReconciledJob: jest.fn(async () => undefined),
      }),
    );

    expect(methods.recordRunOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'skipped_balance' }),
    );
  });

  it('recovers a swallowed generation failure as error, with the owner’s message', async () => {
    const methods = makeMethods(makeClaimedSchedule());
    (methods.getRunsForReconciliation as jest.Mock).mockResolvedValue([unsettledRun()]);
    await tickOnce(
      makeDeps(methods, {
        getJobStatus: retainedComplete({
          scheduleOutcome: 'error',
          scheduleOutcomeError: 'upstream 503',
        }),
        clearReconciledJob: jest.fn(async () => undefined),
      }),
    );

    expect(methods.recordRunOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'error', error: 'upstream 503' }),
    );
  });

  it('still records success when the owner left no stamp', async () => {
    const methods = makeMethods(makeClaimedSchedule());
    (methods.getRunsForReconciliation as jest.Mock).mockResolvedValue([unsettledRun()]);
    await tickOnce(
      makeDeps(methods, {
        getJobStatus: retainedComplete(),
        clearReconciledJob: jest.fn(async () => undefined),
      }),
    );

    expect(methods.recordRunOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'success' }),
    );
  });

  // The stamp crosses a serialization boundary, and recordRunOutcome would reject a
  // status outside its union: degrade to success rather than fail the recovery write.
  it('degrades an unrecognized stamp to success', async () => {
    const methods = makeMethods(makeClaimedSchedule());
    (methods.getRunsForReconciliation as jest.Mock).mockResolvedValue([unsettledRun()]);
    await tickOnce(
      makeDeps(methods, {
        getJobStatus: retainedComplete({ scheduleOutcome: 'not_a_status' }),
        clearReconciledJob: jest.fn(async () => undefined),
      }),
    );

    expect(methods.recordRunOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'success' }),
    );
  });
});
