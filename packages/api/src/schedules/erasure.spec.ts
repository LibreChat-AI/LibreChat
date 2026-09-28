import type { IScheduleRun, ScheduleMethods } from '@librechat/data-schemas';
import type { JobState } from './types';
import { startScheduleErasureSweep } from './erasure';

const oldRun = (overrides: Partial<IScheduleRun> = {}): IScheduleRun =>
  ({
    scheduleId: 'schedule-1',
    user: 'user-1',
    scheduledFor: new Date('2026-08-17T12:00:00.000Z'),
    firedAt: new Date(Date.now() - 31 * 60_000),
    conversationId: 'conversation-1',
    status: 'started',
    ...overrides,
  }) as unknown as IScheduleRun;

async function sweepOnce(options: {
  canInferOwnerDeathFromMissingJob: boolean;
  job?: JobState | null;
}) {
  const methods = {
    getDeletingSchedules: jest.fn(async () => [{ id: 'schedule-1' }]),
    getActiveRunsForSchedule: jest.fn(async () => [oldRun()]),
    recordRunOutcome: jest.fn(async () => undefined),
    eraseScheduleIfDrained: jest.fn(async () => false),
    markEraseAttempted: jest.fn(async () => undefined),
    getRunsForReconciliation: jest.fn(async () => []),
    getUnbookkeptRuns: jest.fn(async () => []),
    finalizeBookkeeping: jest.fn(async () => undefined),
    markRunsReconciled: jest.fn(async () => undefined),
  };
  const sweep = startScheduleErasureSweep({
    methods: methods as unknown as ScheduleMethods,
    getJobStatus: jest.fn(async () => options.job ?? null),
    getTriggerDelivery: jest.fn(async () => null),
    clearReconciledJob: jest.fn(async () => undefined),
    canInferOwnerDeathFromMissingJob: options.canInferOwnerDeathFromMissingJob,
  });
  await jest.advanceTimersByTimeAsync(5 * 60_000);
  sweep.stop();
  return methods;
}

describe('schedule erasure fallback owner-death evidence', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.spyOn(Math, 'random').mockReturnValue(0);
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('does not settle a peer-owned run from process-local job absence', async () => {
    const methods = await sweepOnce({ canInferOwnerDeathFromMissingJob: false });

    expect(methods.recordRunOutcome).not.toHaveBeenCalled();
    expect(methods.eraseScheduleIfDrained).toHaveBeenCalledWith('schedule-1');
  });

  it('retains owner-death recovery when job absence is deployment-authoritative', async () => {
    const methods = await sweepOnce({ canInferOwnerDeathFromMissingJob: true });

    expect(methods.recordRunOutcome).toHaveBeenCalledWith(
      expect.objectContaining({
        scheduleId: 'schedule-1',
        status: 'interrupted',
        error: 'Schedule deleted',
      }),
    );
  });

  it('still trusts an identity-matched terminal job in an unsafe topology', async () => {
    const methods = await sweepOnce({
      canInferOwnerDeathFromMissingJob: false,
      job: {
        status: 'complete',
        scheduleId: 'schedule-1',
        scheduledFor: '2026-08-17T12:00:00.000Z',
      },
    });

    expect(methods.recordRunOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ scheduleId: 'schedule-1', status: 'success' }),
    );
  });
});

const DEFINITE = {
  code: 'rejected',
  message: 'rejected before running',
  certainty: 'definite' as const,
};

describe('topology-safe dead-delivery convergence', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.spyOn(Math, 'random').mockReturnValue(0);
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  async function convergeOnce(options: {
    run?: Partial<IScheduleRun>;
    delivery?: {
      status: string;
      lastError?: { code: string; message: string; certainty: 'definite' | 'ambiguous' };
    } | null;
    job?: JobState | null;
    canInferOwnerDeathFromMissingJob?: boolean;
  }) {
    const methods = {
      getDeletingSchedules: jest.fn(async () => []),
      getActiveRunsForSchedule: jest.fn(async () => []),
      recordRunOutcome: jest.fn(async () => undefined),
      eraseScheduleIfDrained: jest.fn(async () => false),
      markEraseAttempted: jest.fn(async () => undefined),
      getRunsForReconciliation: jest.fn(async () => [
        oldRun({ deliveryKey: 'dk-1', ...options.run } as Partial<IScheduleRun>),
      ]),
      getUnbookkeptRuns: jest.fn(async () => []),
      finalizeBookkeeping: jest.fn(async () => undefined),
      markRunsReconciled: jest.fn(async () => undefined),
    };
    const getTriggerDelivery = jest.fn(async () => options.delivery ?? null);
    const clearReconciledJob = jest.fn(async () => undefined);
    const sweep = startScheduleErasureSweep({
      methods: methods as unknown as ScheduleMethods,
      getJobStatus: jest.fn(async () => options.job ?? null),
      getTriggerDelivery: getTriggerDelivery as never,
      clearReconciledJob,
      // Defaults to the UNSAFE topology to prove this path never depends on it.
      canInferOwnerDeathFromMissingJob: options.canInferOwnerDeathFromMissingJob ?? false,
    });
    await jest.advanceTimersByTimeAsync(5 * 60_000);
    sweep.stop();
    return { methods, getTriggerDelivery, clearReconciledJob };
  }

  it('settles a dead delivery as error even in an unsafe topology (positive evidence)', async () => {
    const { methods } = await convergeOnce({
      delivery: {
        status: 'dead',
        lastError: { code: 'blocked', message: 'blocked by moderation', certainty: 'definite' },
      },
    });
    expect(methods.recordRunOutcome).toHaveBeenCalledWith(
      expect.objectContaining({
        scheduleId: 'schedule-1',
        status: 'error',
        error: 'blocked by moderation',
      }),
    );
  });

  it('leaves a live delivery alone', async () => {
    const { methods } = await convergeOnce({ delivery: { status: 'pending' } });
    expect(methods.recordRunOutcome).not.toHaveBeenCalled();
  });

  it('never settles while an identity-matched generation still owns the reservation', async () => {
    const { methods, getTriggerDelivery } = await convergeOnce({
      delivery: { status: 'dead', lastError: DEFINITE },
      job: {
        status: 'running',
        scheduleId: 'schedule-1',
        scheduledFor: '2026-08-17T12:00:00.000Z',
      } as unknown as JobState,
    });
    expect(getTriggerDelivery).not.toHaveBeenCalled();
    expect(methods.recordRunOutcome).not.toHaveBeenCalled();
  });

  it('defers a run whose abort is still in flight', async () => {
    const { methods } = await convergeOnce({
      run: { abortRequestedAt: new Date() } as Partial<IScheduleRun>,
      delivery: { status: 'dead', lastError: DEFINITE },
    });
    expect(methods.recordRunOutcome).not.toHaveBeenCalled();
  });

  /**
   * The gap this closes: a generation that FINISHED but whose owner exhausted every Mongo
   * outcome retry leaves a preserved terminal job as the only evidence. The armed engine's
   * reconciler replays that; the clustered entrypoint arms no engine, so before this the run
   * kept its `started` row — and its global capacity slot — until the job store expired it.
   */
  it('settles a live schedule from its retained terminal job, then releases the evidence', async () => {
    const { methods, clearReconciledJob } = await convergeOnce({
      job: {
        status: 'complete',
        scheduleId: 'schedule-1',
        scheduledFor: '2026-08-17T12:00:00.000Z',
      } as unknown as JobState,
    });
    expect(methods.recordRunOutcome).toHaveBeenCalledWith(
      expect.objectContaining({
        scheduleId: 'schedule-1',
        status: 'success',
        conversationId: 'conversation-1',
      }),
    );
    expect(clearReconciledJob).toHaveBeenCalledWith('conversation-1', {
      scheduleId: 'schedule-1',
      scheduledFor: new Date('2026-08-17T12:00:00.000Z'),
    });
  });

  /** Presence of an identity-matched job is positive evidence in EVERY topology, so this
   *  must not depend on the owner-death inference the unsafe fallback refuses. */
  it('honors the owner-stamped outcome over the generic terminal status', async () => {
    const { methods } = await convergeOnce({
      job: {
        status: 'complete',
        scheduleId: 'schedule-1',
        scheduledFor: '2026-08-17T12:00:00.000Z',
        scheduleOutcome: 'skipped_balance',
      } as unknown as JobState,
    });
    expect(methods.recordRunOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'skipped_balance' }),
    );
  });

  it('carries the stamped failure reason from a retained error job', async () => {
    const { methods } = await convergeOnce({
      job: {
        status: 'error',
        scheduleId: 'schedule-1',
        scheduledFor: '2026-08-17T12:00:00.000Z',
        scheduleOutcomeError: 'provider exploded',
      } as unknown as JobState,
    });
    expect(methods.recordRunOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'error', error: 'provider exploded' }),
    );
  });

  /** A pre-start abort reserves a conversationId but never creates the conversation, so
   *  projecting it would point the schedule card at a chat that does not exist. */
  it('clears the reserved conversationId when the generation never emitted its created event', async () => {
    const { methods } = await convergeOnce({
      job: {
        status: 'aborted',
        scheduleId: 'schedule-1',
        scheduledFor: '2026-08-17T12:00:00.000Z',
        createdEventEmitted: false,
      } as unknown as JobState,
    });
    expect(methods.recordRunOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'interrupted', clearConversationId: true }),
    );
    expect(methods.recordRunOutcome).toHaveBeenCalledWith(
      expect.not.objectContaining({ conversationId: 'conversation-1' }),
    );
  });

  /** A terminal job belonging to a REPLACEMENT turn (same conversationId, no scheduled
   *  identity) must never finalize this run, nor have its evidence deleted for it. */
  it("ignores a terminal job that lost this occurrence's identity", async () => {
    const { methods, clearReconciledJob } = await convergeOnce({
      job: { status: 'complete' } as unknown as JobState,
    });
    expect(methods.recordRunOutcome).not.toHaveBeenCalled();
    expect(clearReconciledJob).not.toHaveBeenCalled();
  });

  /**
   * A pause whose `requires_action` projection failed every retry leaves the row `started`
   * while the job is durably paused. The armed reconciler replays that; with no engine the
   * row held its GLOBAL capacity slot forever, since a paused job is not terminal and the
   * dead-delivery path never inspects an identity-matched job.
   */
  it('projects a pause the owner never managed to record, freeing the slot', async () => {
    const { methods, clearReconciledJob } = await convergeOnce({
      job: {
        status: 'requires_action',
        scheduleId: 'schedule-1',
        scheduledFor: '2026-08-17T12:00:00.000Z',
      } as unknown as JobState,
    });
    expect(methods.recordRunOutcome).toHaveBeenCalledWith(
      expect.objectContaining({
        scheduleId: 'schedule-1',
        status: 'requires_action',
        conversationId: 'conversation-1',
        // Every replica runs this sweep, so the write itself must be fenced against a
        // resume that claimed the row after this snapshot was taken — as a staleness
        // CUTOFF, so an abandoned claim still recovers.
        resumeClaimStaleBefore: expect.any(Date),
      }),
    );
    // The job is still LIVE awaiting approval — its evidence must not be released.
    expect(clearReconciledJob).not.toHaveBeenCalled();
  });

  /** A resume claims capacity before flipping the job back to `running`; re-projecting the
   *  pause during that hand-off would release the slot the continuation just took. */
  it('defers a paused job while a resume hand-off is in flight', async () => {
    const { methods } = await convergeOnce({
      run: { resumeClaimedAt: new Date() } as Partial<IScheduleRun>,
      job: {
        status: 'requires_action',
        scheduleId: 'schedule-1',
        scheduledFor: '2026-08-17T12:00:00.000Z',
      } as unknown as JobState,
    });
    expect(methods.recordRunOutcome).not.toHaveBeenCalled();
  });

  it('never settles a terminal job while its abort is still in flight', async () => {
    const { methods, clearReconciledJob } = await convergeOnce({
      run: { abortRequestedAt: new Date() } as Partial<IScheduleRun>,
      job: {
        status: 'aborted',
        scheduleId: 'schedule-1',
        scheduledFor: '2026-08-17T12:00:00.000Z',
      } as unknown as JobState,
    });
    expect(methods.recordRunOutcome).not.toHaveBeenCalled();
    expect(clearReconciledJob).not.toHaveBeenCalled();
  });

  it('ignores a legacy reservation carrying no deliveryKey', async () => {
    const { methods, getTriggerDelivery } = await convergeOnce({
      run: { deliveryKey: undefined } as Partial<IScheduleRun>,
      delivery: { status: 'dead', lastError: DEFINITE },
    });
    expect(getTriggerDelivery).not.toHaveBeenCalled();
    expect(methods.recordRunOutcome).not.toHaveBeenCalled();
  });
});

describe('permanent MCP bookkeeping recovery without an armed scheduler', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.spyOn(Math, 'random').mockReturnValue(0);
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('replays a half-bookkept MCP run without applying ordinary failure policy', async () => {
    const mcp = [
      {
        server: 'Graph',
        status: 'mcp_configuration_missing' as const,
        detail: 'unattended_auth_required' as const,
      },
    ];
    const permanent = oldRun({ status: 'error', error: 'MCP unavailable', mcp });
    const ordinary = oldRun({
      scheduleId: 'schedule-2',
      status: 'error',
      error: 'Temporary upstream failure',
    });
    const methods = {
      getDeletingSchedules: jest.fn(async () => []),
      getActiveRunsForSchedule: jest.fn(async () => []),
      eraseScheduleIfDrained: jest.fn(async () => false),
      markEraseAttempted: jest.fn(async () => undefined),
      getRunsForReconciliation: jest.fn(async () => []),
      recordRunOutcome: jest.fn(async () => undefined),
      getUnbookkeptRuns: jest.fn(async () => [permanent, ordinary]),
      finalizeBookkeeping: jest.fn(async () => undefined),
      markRunsReconciled: jest.fn(async () => undefined),
    };
    const sweep = startScheduleErasureSweep({
      methods: methods as unknown as ScheduleMethods,
      getJobStatus: jest.fn(async () => null),
      getTriggerDelivery: jest.fn(async () => null),
      clearReconciledJob: jest.fn(async () => undefined),
      canInferOwnerDeathFromMissingJob: false,
    });
    await jest.advanceTimersByTimeAsync(5 * 60_000);
    sweep.stop();
    expect(methods.finalizeBookkeeping).toHaveBeenCalledTimes(1);
    expect(methods.finalizeBookkeeping).toHaveBeenCalledWith(
      expect.objectContaining({
        scheduleId: 'schedule-1',
        status: 'error',
        mcp,
        autoDisableAfterFailures: Number.MAX_SAFE_INTEGER,
      }),
    );
    expect(methods.markRunsReconciled).toHaveBeenCalledWith([permanent, ordinary]);
  });
});

describe('dead-delivery certainty fence', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.spyOn(Math, 'random').mockReturnValue(0);
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  async function sweepWithDelivery(options: {
    certainty: 'definite' | 'ambiguous';
    canInferOwnerDeathFromMissingJob: boolean;
  }) {
    const methods = {
      getDeletingSchedules: jest.fn(async () => []),
      getActiveRunsForSchedule: jest.fn(async () => []),
      recordRunOutcome: jest.fn(async () => undefined),
      eraseScheduleIfDrained: jest.fn(async () => false),
      markEraseAttempted: jest.fn(async () => undefined),
      getRunsForReconciliation: jest.fn(async () => [oldRun({ deliveryKey: 'dk-1' } as never)]),
      getUnbookkeptRuns: jest.fn(async () => []),
      finalizeBookkeeping: jest.fn(async () => undefined),
      markRunsReconciled: jest.fn(async () => undefined),
    };
    const sweep = startScheduleErasureSweep({
      methods: methods as unknown as ScheduleMethods,
      getJobStatus: jest.fn(async () => null),
      getTriggerDelivery: (async () => ({
        status: 'dead',
        lastError: { code: 'x', message: 'timed out', certainty: options.certainty },
      })) as never,
      clearReconciledJob: jest.fn(async () => undefined),
      canInferOwnerDeathFromMissingJob: options.canInferOwnerDeathFromMissingJob,
    });
    await jest.advanceTimersByTimeAsync(5 * 60_000);
    sweep.stop();
    return methods;
  }

  /**
   * `dead` is not proof of rejection: the trigger host marks response timeouts and invalid
   * success responses `ambiguous`, and the engine dead-letters those after exhausting
   * retries — so an ambiguous dead letter can sit over a generation a peer accepted and is
   * still running. Settling it here would release capacity mid-run.
   */
  it('refuses an AMBIGUOUS dead letter when absence is not deployment-authoritative', async () => {
    const methods = await sweepWithDelivery({
      certainty: 'ambiguous',
      canInferOwnerDeathFromMissingJob: false,
    });
    expect(methods.recordRunOutcome).not.toHaveBeenCalled();
  });

  it('settles an ambiguous dead letter once job absence IS deployment-authoritative', async () => {
    const methods = await sweepWithDelivery({
      certainty: 'ambiguous',
      canInferOwnerDeathFromMissingJob: true,
    });
    expect(methods.recordRunOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'error', error: 'timed out' }),
    );
  });

  it('settles a DEFINITE rejection even in an unsafe topology', async () => {
    const methods = await sweepWithDelivery({
      certainty: 'definite',
      canInferOwnerDeathFromMissingJob: false,
    });
    expect(methods.recordRunOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'error', error: 'timed out' }),
    );
  });
});
