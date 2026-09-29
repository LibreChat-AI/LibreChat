import { logger, runAsSystem } from '@librechat/data-schemas';
import type { IScheduleRun } from '@librechat/data-schemas';
import type { ScheduleEngineDeps, JobState } from './types';
import { hasAbortInFlight, hasResumeHandoffInFlight, retainedOutcome } from './types';
import { isShutdownInProgress, registerShutdownTask } from '~/app/shutdown';
import { fireSchedule, BALANCE_SKIP_DISABLE_THRESHOLD } from './fire';
import { computeNextRunAt } from './cadence';

const TICK_MS = 30_000;
const TICK_JITTER_MS = 2_000;
const LEASE_MS = 5 * 60_000;
const RECONCILE_MIN_RUN_AGE_MS = 2 * 60_000;
const ORPHAN_RUN_AGE_MS = 30 * 60_000;
const ABANDONED_PAUSE_AGE_MS = 25 * 60 * 60_000;
const RECONCILE_BATCH = 100;
// Occurrences due more than this long ago (server downtime / paused engine) are
// skipped forward instead of fired, so a restart doesn't burst stale chats.
const MISFIRE_GRACE_MS = 15 * 60_000;

/**
 * Whether the job currently at a run's conversationId is THIS occurrence's
 * generation. A replacement turn reuses the conversationId but strips the
 * scheduleId/scheduledFor metadata, so an identity mismatch means the original
 * job is gone and its status must not be attributed to (or its hash deleted for)
 * this scheduled run.
 */
function jobIdentityMatches(jobState: JobState | null, run: IScheduleRun): boolean {
  if (jobState == null || jobState.scheduleId !== run.scheduleId || jobState.scheduledFor == null) {
    return false;
  }
  const jobFor = new Date(jobState.scheduledFor).getTime();
  return jobFor === run.scheduledFor.getTime();
}

export type ScheduleEngine = {
  stop: () => void;
  /** Exposed for tests and the run-now handler: one full claim/fire pass. */
  runTick: () => Promise<number>;
  /** Exposed for tests: one awaitable reconciliation pass (the tick loop's is fire-and-forget). */
  reconcile: () => Promise<void>;
};

export function startScheduleEngine(deps: ScheduleEngineDeps): ScheduleEngine {
  let stopped = false;
  const stopController = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  let ticks = 0;
  const instanceId = `${process.pid}-${Math.random().toString(36).slice(2, 8)}`;

  /**
   * Job-store-aware run reconciliation: pauses (`requires_action`) surface on
   * the run doc so overlap-skip ignores them; crashed runs become
   * `interrupted`; runs resumed elsewhere become `success` when the job store
   * still shows completion. Long-running generations are left alone.
   */
  async function reconcile() {
    try {
      const limits = await deps.getLimits();
      const runs = await runAsSystem(() =>
        deps.methods.getRunsForReconciliation(
          new Date(Date.now() - RECONCILE_MIN_RUN_AGE_MS),
          RECONCILE_BATCH,
        ),
      );
      await runAsSystem(async () => {
        for (const run of runs) {
          // PER-ROW isolation. A single throwing row used to abort the whole pass.
          // Reconciliation is the backstop for exactly the states nothing else
          // settles, so it has to make progress on the rest; the examined-at stamp
          // below then rotates failures behind rows this pass did not inspect.
          try {
            let jobState: Awaited<ReturnType<typeof deps.getJobStatus>> | null = null;
            // Identity-fence the job lookup: a replacement user turn reuses this
            // conversationId but sheds the scheduleId/scheduledFor metadata. Only
            // trust the job's status when it still carries THIS occurrence's identity;
            // otherwise treat the job as gone (null) so a replacement generation's
            // status can never finalize — or its hash be deleted for — this run.
            // Resolve the run owner's limits so crash-reconciled auto-disable uses
            // the same per-principal threshold as an inline completion. Must run in
            // the OWNER's tenant context: getLimits resolves config via the ALS
            // tenant, and this loop is under runAsSystem (system tenant).
            const owner = await deps.getUserContext(run.user);
            const runLimits = owner
              ? await deps.runInTenantContext(owner, () => deps.getLimits(owner))
              : limits;
            // All transitions go through recordRunOutcome so the schedule's lastRun
            // (and the card's status chip) tracks the run, including the pause.
            const finalize = (
              status: 'success' | 'interrupted' | 'error' | 'requires_action' | 'skipped_balance',
              error?: string,
              opts?: { omitConversationId?: boolean },
            ) =>
              deps.methods.recordRunOutcome({
                scheduleId: run.scheduleId,
                scheduledFor: run.scheduledFor,
                status,
                ...(status === 'requires_action' && jobState?.checkpointNamespace != null
                  ? { checkpointNamespace: jobState.checkpointNamespace }
                  : {}),
                // Pre-start aborts have a reserved id but no conversation was ever
                // created; projecting it gives the card a link to a missing chat.
                conversationId: opts?.omitConversationId ? undefined : run.conversationId,
                clearConversationId: opts?.omitConversationId,
                error,
                ...(run.mcp ? { mcp: run.mcp } : {}),
                autoDisableAfterFailures: runLimits.autoDisableAfterFailures,
              });
            // Admission-only rows never reached the delivery or generation layers.
            // Their deterministic failure was stored with the reservation, so replay it
            // directly instead of waiting for the generic orphan timeout.
            if (run.status === 'started' && run.admissionOnly) {
              await finalize('error', run.error ?? 'MCP preflight unavailable', {
                omitConversationId: true,
              });
              continue;
            }
            jobState = run.conversationId ? await deps.getJobStatus(run.conversationId) : null;
            const jobStatus = jobIdentityMatches(jobState, run) ? jobState!.status : null;
            const ageMs = Date.now() - (run.firedAt?.getTime() ?? 0);
            // The clear runs AFTER finalize (the retained job is the only evidence if
            // the finalize write fails), which means a clear that keeps failing has no
            // natural retry: the now-terminal run never rescans, so nothing else would
            // reap the retained job. Retry the transient case inline; the store's own
            // aged-retained-job backstop bounds anything more persistent.
            const clearRetainedJob = async () => {
              for (let attempt = 1; attempt <= 2; attempt++) {
                try {
                  await deps.clearReconciledJob(run.conversationId as string, {
                    scheduleId: run.scheduleId,
                    scheduledFor: run.scheduledFor,
                  });
                  return;
                } catch (clearError) {
                  logger.warn(
                    `[schedules] failed to clear retained job for ${run.scheduleId} (attempt ${attempt}/2):`,
                    clearError,
                  );
                }
              }
            };
            if (jobStatus === 'running') {
              continue;
            }
            // Surface a pause on the card (lastRun → requires_action). Also re-invoked for
            // a row ALREADY `requires_action`: recordRunOutcome flips the row before
            // projecting the card, so a crash between the two leaves the pause invisible
            // until this replays it. Both writes are idempotent.
            if (
              (run.status === 'started' || run.status === 'requires_action') &&
              jobStatus === 'requires_action'
            ) {
              // A resumed run claims capacity in Mongo BEFORE the approval CAS flips
              // the job back to `running`. During that short hand-off, the old paused
              // job is expected and must not re-pause the run (which would release the
              // newly claimed capacity slot while the continuation is about to run).
              // A stale stamp still falls through so a crashed resume can recover.
              if (run.status === 'started' && hasResumeHandoffInFlight(run, Date.now())) {
                continue;
              }
              await finalize('requires_action');
              continue;
            }
            // A retained terminal job whose inline outcome hook failed transiently —
            // finalize the run from the retained status, then delete the job. The
            // delete is the cleanup path for `preserveForReconcile` jobs (kept
            // without `completedAt`, so the store's finished-job sweep never reaps
            // them); `conversationId` is guaranteed here since jobStatus was fetched.
            if (jobStatus === 'complete') {
              // Finalize either a paused OR a still-started run so it stops consuming
              // capacity / blocking overlap — but from the OWNER'S intended outcome when
              // it left one. A terminal `complete` covers a clean finish, a mid-run
              // balance refusal, and a provider failure the client swallowed into an
              // error part alike, so re-deriving `success` here turned a transient
              // outcome-write failure into a reset of the very streaks that drive
              // insufficient_balance and too_many_failures auto-disable.
              const intended = retainedOutcome(jobState, 'success');
              await finalize(intended.status, intended.error);
              await clearRetainedJob();
              continue;
            }
            if (jobStatus === 'error') {
              // Honor the stamp here too: a mid-continuation balance refusal claims an
              // `error` terminal but must walk the insufficient_balance streak.
              const intended = retainedOutcome(jobState, 'error');
              await finalize(intended.status, intended.error);
              await clearRetainedJob();
              continue;
            }
            if (jobStatus === 'aborted') {
              // ABORT FENCE, same rule as the deletion drains: a job flips `aborted`
              // the moment abortJob wins its status CAS, BEFORE the generation owner
              // has unwound and persisted (partial response, user message). Settling
              // here would release the run mid-persistence — the exact drain-mid-write
              // hazard the deletion paths defer on — so while the abort is in flight
              // the owner's own outcome write is the only settlement. Past the window
              // the owner is presumed dead and this backstop finalizes the run.
              if (hasAbortInFlight(run, Date.now())) {
                continue;
              }
              await finalize('interrupted', undefined, {
                omitConversationId: jobState?.createdEventEmitted !== true,
              });
              await clearRetainedJob();
              continue;
            }
            // A `started` run whose job is gone (jobStatus null). Every run records its
            // conversationId up front, so getJobStatus above already liveness-checked it: a
            // live long-running fire reads as `running` and is left alone. A fresh abort
            // also DELETES the job (account-deletion quiesce), so absence carries the same
            // abort fence as `aborted` above.
            //
            // But a jobless run is NOT automatically an orphan: fireSchedule reserves the
            // run and its capacity BEFORE the durable trigger delivery reaches the chat
            // route, and that delivery can be deferred (a `Retry-After` up to 24h, far past
            // the 30-minute cutoff) or dead-lettered by a pre-generation rejection (an
            // interactive limiter, PII, or moderation). Consult the durable delivery keyed
            // by the reservation before deciding.
            if (
              run.status === 'started' &&
              jobStatus == null &&
              !hasAbortInFlight(run, Date.now()) &&
              !hasResumeHandoffInFlight(run, Date.now())
            ) {
              let delivery: Awaited<ReturnType<typeof deps.getTriggerDelivery>> | null = null;
              try {
                delivery = run.deliveryKey ? await deps.getTriggerDelivery(run.deliveryKey) : null;
              } catch (deliveryError) {
                // Unknown is not gone: defer rather than orphan a possibly-live delivery.
                logger.warn(
                  `[schedules] delivery lookup failed for ${run.scheduleId}@${run.scheduledFor?.toISOString?.() ?? run.scheduledFor}; deferring:`,
                  deliveryError,
                );
                continue;
              }
              const deliveryStatus = delivery?.status;
              if (
                deliveryStatus === 'staging' ||
                deliveryStatus === 'batched' ||
                deliveryStatus === 'pending' ||
                deliveryStatus === 'leased'
              ) {
                // Admission is still live; the delivery will fire or dead-letter later.
                continue;
              }
              if (deliveryStatus === 'dead') {
                // Definitively failed before a generation ever existed. Record the error
                // PROMPTLY from the durable lastError and release capacity through the
                // ordinary outcome path — no need to wait the 30-minute orphan age.
                await finalize(
                  'error',
                  delivery?.lastError?.message ?? 'Scheduled delivery failed before running',
                );
                continue;
              }
              // `succeeded` (a generation ran; its own job/outcome evidence is the
              // authority) or NO delivery record (a legacy fire): only a genuinely aged
              // jobless run is an orphan.
              if (ageMs > ORPHAN_RUN_AGE_MS) {
                await finalize('interrupted');
              }
              continue;
            }
            if (
              run.status === 'requires_action' &&
              jobStatus == null &&
              ageMs > ABANDONED_PAUSE_AGE_MS &&
              !hasAbortInFlight(run, Date.now())
            ) {
              await finalize('interrupted');
            }
          } catch (rowError) {
            logger.error(
              `[schedules] reconciliation failed for run ${run.scheduleId}@${run.scheduledFor?.toISOString?.() ?? run.scheduledFor}:`,
              rowError,
            );
          }
        }
        // Stamp EVERY row this pass looked at, including the ones that threw — a row
        // that keeps failing must still rotate to the back, or it re-fills the window
        // and starves the rest, which is the same starvation the ordering exists to
        // prevent (and the per-row try/catch above already exists because of).
        await deps.methods
          .markRunsReconciled(runs)
          .catch((err) => logger.warn('[schedules] failed to stamp reconciled runs:', err));
      });

      // Catch terminal runs whose schedule bookkeeping never landed (a crash
      // between the run-row terminalization and the schedule counter update).
      const unbookkept = await runAsSystem(() =>
        deps.methods.getUnbookkeptRuns(
          new Date(Date.now() - RECONCILE_MIN_RUN_AGE_MS),
          RECONCILE_BATCH,
        ),
      );
      await runAsSystem(async () => {
        for (const run of unbookkept) {
          try {
            const owner = await deps.getUserContext(run.user);
            const runLimits = owner
              ? await deps.runInTenantContext(owner, () => deps.getLimits(owner))
              : limits;
            await deps.methods.finalizeBookkeeping({
              scheduleId: run.scheduleId,
              scheduledFor: run.scheduledFor,
              status: run.status as
                | 'success'
                | 'error'
                | 'interrupted'
                | 'skipped_balance'
                | 'skipped_overlap',
              conversationId: run.conversationId,
              error: run.error,
              mcp: run.mcp,
              autoDisableAfterFailures: runLimits.autoDisableAfterFailures,
              balanceSkipDisableThreshold: BALANCE_SKIP_DISABLE_THRESHOLD,
            });
            // The run is terminal but its OWNER crashed before bookkeeping, which is also
            // before it could release the job it retained for exactly this recovery. The
            // active-run pass clears its own; this one never did, and a preserved job is
            // kept WITHOUT `completedAt` precisely so the store's finished-job sweep
            // cannot reap it early — so nothing else would ever have. Identity-guarded,
            // and a no-op when no retained job is there.
            if (run.conversationId) {
              await deps
                .clearReconciledJob(run.conversationId, {
                  scheduleId: run.scheduleId,
                  scheduledFor: run.scheduledFor,
                })
                .catch((clearError) =>
                  logger.warn(
                    `[schedules] failed to clear retained job after bookkeeping replay for ${run.scheduleId}:`,
                    clearError,
                  ),
                );
            }
          } catch (rowError) {
            logger.error(
              `[schedules] bookkeeping replay failed for run ${run.scheduleId}:`,
              rowError,
            );
          }
        }
        // Same rotation as the active-run pass above: stamp every row this pass
        // looked at so persistent failures rotate to the back of the bounded
        // window instead of starving the rows behind them. Successful replays
        // left the query via bookkept:true; re-stamping them is harmless.
        await deps.methods
          .markRunsReconciled(unbookkept)
          .catch((err) => logger.warn('[schedules] failed to stamp replayed runs:', err));
      });

      // Erase soft-deleted schedules once their active runs have drained. Delete
      // disabled + marked them `deleting` and aborted in-flight jobs; the run
      // reconciliation above finalizes those runs, so here we erase only the
      // schedules with no run still active — their evidence is preserved until
      // settled. eraseScheduleIfDrained is idempotent, so concurrent workers are safe.
      await runAsSystem(async () => {
        const deleting = await deps.methods.getDeletingSchedules(RECONCILE_BATCH);
        for (const schedule of deleting) {
          await deps.methods.eraseScheduleIfDrained(schedule.id).catch(() => undefined);
        }
        // Rotate the window (never-attempted first) so a batch of undrainable rows
        // cannot re-fill it every pass and starve the rows behind them.
        await deps.methods
          .markEraseAttempted(deleting.map((schedule) => schedule.id))
          .catch((err) => logger.warn('[schedules] failed to stamp erase attempts:', err));
      });

      // Re-arm schedules that are enabled but carry no nextRunAt. Creation arms in a
      // second write, so a crash or a failed arm leaves a row that LOOKS enabled to its
      // owner and occupies a slot while claimDueSchedule (which sorts on nextRunAt) can
      // never select it. Recovering here means the owner does not have to notice and
      // edit it; armSchedule is conditional on still being unarmed, so it cannot
      // disturb one that armed itself meanwhile.
      await runAsSystem(async () => {
        const unarmed = await deps.methods.getUnarmedSchedules(RECONCILE_BATCH);
        for (const schedule of unarmed) {
          const nextRunAt = computeNextRunAt({
            cadence: schedule.cadence,
            timezone: schedule.timezone,
            scheduleId: schedule.id,
          });
          if (nextRunAt == null) {
            // Uncomputable cadence is NOT transient (same policy as the claim path):
            // skipping left the row enabled-but-unarmed forever — holding the owner's
            // slot while never firing, and re-filling this bounded window until valid
            // crash-left rows behind it could never be recovered. Fenced on both the
            // claim token and revision so a concurrent edit that repairs the cadence
            // wins over this observation of the broken one.
            await deps.methods
              .disableSchedule(
                schedule.id,
                'invalid_schedule',
                schedule.claimToken,
                schedule.configRevision,
              )
              .catch((err) => {
                logger.warn(`[schedules] failed to disable unarmed ${schedule.id}:`, err);
              });
            continue;
          }
          await deps.methods.armSchedule(schedule.id, nextRunAt).catch((err) => {
            logger.warn(`[schedules] failed to re-arm ${schedule.id}:`, err);
          });
        }
      });
    } catch (error) {
      logger.error('[schedules] run reconciliation failed:', error);
    }
  }

  /**
   * One claim/fire pass. Claims and cross-tenant reconciliation run in a system
   * tenant context (the claim scans all tenants; strict tenant isolation would
   * otherwise throw on the unscoped query). The fire itself re-enters the
   * owner's context via `runInTenantContext`.
   */
  async function runTick(): Promise<number> {
    // GLOBAL kill switch: stop claiming entirely. This is the operator's hard stop
    // (SCHEDULES_DISABLED, or `interface.schedules: false` in the BASE config), which
    // no principal override can widen — distinct from per-principal availability below.
    // Deliberately gates CLAIMS only; reconcile() is never gated, because in-flight
    // runs must still be settled while the feature is off or they strand `started`
    // rows and leak capacity forever.
    if (await deps.isGloballyDisabled()) {
      return 0;
    }
    // Do NOT gate claims on the per-principal `enabled`: schedules can be enabled per
    // user/role/tenant, so gating here would silently never fire those users'
    // occurrences. The fire path re-resolves the OWNER's limits and skips ('disabled')
    // any occurrence whose owner has the feature off, so an owner-scoped disable is
    // still honored. The base config only supplies the per-tick claim budget.
    const limits = await deps.getLimits();
    let fired = 0;
    // Admission has its own bounded pool. MCP readiness runs before a generation
    // slot is reserved, so slow external servers cannot make generation occupancy
    // suppress later healthy claims. The durable capacity allocator in fireSchedule
    // remains the cross-replica authority for actual generations.
    const budget = limits.admissionConcurrency;
    const fires: Promise<unknown>[] = [];
    for (let i = 0; i < budget; i++) {
      // Claim + the fire's pre-owner-context bookkeeping (disable/advance,
      // cross-tenant reads) run as system; fireSchedule re-enters owner context
      // internally for the run-specific work.
      const schedule = await runAsSystem(() =>
        deps.methods.claimDueSchedule({ instanceId, leaseMs: LEASE_MS }),
      );
      if (schedule == null) {
        break;
      }
      // Start each admission as soon as its claim lands. MCP preflight is bounded but
      // can legitimately wait for its full deadline; awaiting it here used to hold the
      // claim loop and could push healthy schedules beyond the misfire grace window.
      // The claim budget still caps this batch, and the durable capacity allocator in
      // fireSchedule arbitrates against work started by concurrent engine replicas.
      fires.push(
        runAsSystem(async () => {
          const scheduledFor = schedule.nextRunAt ?? new Date();
          /**
           * Advances this claimed occurrence without preserving a superseded holder.
           * Owner edits rotate the token/next occurrence but intentionally leave the old
           * lease in place; a fenced miss therefore releases only this worker's unique
           * holder. Infrastructure errors keep the lease as retry backoff, as before.
           */
          const advanceClaim = async (nextRunAt: Date | null): Promise<void> => {
            try {
              const advanced = await deps.methods.advanceSchedule(
                schedule.id,
                nextRunAt,
                scheduledFor,
                schedule.claimToken,
              );
              if (!advanced && schedule.leaseBy != null) {
                await deps.methods.releaseLeaseByHolder(schedule.id, schedule.leaseBy);
              }
            } catch {
              // Leave the claim lease as bounded backoff for transient storage failures.
            }
          };
          // Use the CLAIM's clock for the misfire cutoff: the claim wrote
          // leaseUntil = now + LEASE_MS from the claiming worker's clock, so
          // leaseUntil - LEASE_MS is that worker's "now" at claim — usually this very
          // process, making cutoff and claim self-consistent. (DocumentDB rules out the
          // server-clock `$$NOW` CAS; skew between REPLICAS shifts fire timing by at
          // most the skew and can never double-fire — the lease CAS and the unique
          // occurrence index arbitrate that regardless of clocks.)
          const dbNow = schedule.leaseUntil ? schedule.leaseUntil.getTime() - LEASE_MS : Date.now();
          // Misfire skip-forward: an occurrence overdue past the grace window (the
          // engine was down/paused) is advanced to the next FUTURE occurrence
          // without firing, so a restart doesn't launch stale or bursty chats.
          if (dbNow - scheduledFor.getTime() > MISFIRE_GRACE_MS) {
            const next = computeNextRunAt({
              cadence: schedule.cadence,
              timezone: schedule.timezone,
              scheduleId: schedule.id,
              // The claim's own clock (see dbNow above): a clock-behind worker would
              // otherwise compute another already-due occurrence and reclaim the row.
              after: new Date(dbNow),
            });
            if (next == null) {
              // Uncomputable cadence is NOT transient, so this occurrence can never run.
              // The advance below would clear nextRunAt AND the lease; doing that after a
              // transiently failed disable would leave `enabled: true` with no nextRunAt
              // and no disabledReason, permanently unclaimable and invisible. Bail
              // instead: the lease expires and the occurrence is retried.
              const disabled = await deps.methods
                .disableSchedule(schedule.id, 'invalid_schedule', schedule.claimToken)
                .then(() => true)
                .catch(() => false);
              if (!disabled) {
                return false;
              }
            }
            // The SKIP-FORWARD itself, and the whole point of this branch: move to the
            // next FUTURE occurrence. Without it nextRunAt keeps pointing at the stale
            // one, so every later tick reclaims and skips the same occurrence forever and
            // a schedule overdue past an outage never fires again.
            await advanceClaim(next);
            logger.info(`[schedules] skipped stale occurrence for ${schedule.id} (misfire grace)`);
            return false;
          }
          try {
            const result = await fireSchedule(
              // The dispatch boundary observes shutdown from BOTH signals: the
              // coordinator flag flips before the listener starts closing (ahead of
              // any pre-drain task ordering), and the engine's own stop covers direct
              // runTick callers outside a coordinated shutdown.
              { ...deps, isShuttingDown: () => stopped || isShutdownInProgress() },
              schedule,
              limits,
              scheduledFor,
              {
                dbNow: new Date(dbNow),
                signal: stopController.signal,
              },
            );
            if (result.fired) {
              fired += 1;
            }
          } catch (error) {
            // A transient preflight throw (user/config/permission/balance/capacity query)
            // must NOT advance past this occurrence: advancing schedules the NEXT
            // recurrence, so the due one is discarded permanently with no ScheduleRun row
            // and no evidence it was ever attempted. Leave nextRunAt alone and keep the
            // claim lease as backoff — the lease expires and the SAME occurrence is
            // re-claimed and retried, matching how the fire path already treats a
            // transient file-resolution failure.
            logger.error(
              `[schedules] unexpected fire error for ${schedule.id} (will retry):`,
              error,
            );
            // An UNCOMPUTABLE cadence is the one non-transient case: retrying can never
            // make progress, and leaving the lease would re-claim the same occurrence
            // forever. Disable so it stops being due, and only then clear nextRunAt —
            // advancing on a failed disable would leave `enabled: true` with no nextRunAt
            // and no disabledReason (permanently unclaimable and invisible). Everything
            // else falls through untouched: nextRunAt and the lease both stand.
            const next = computeNextRunAt({
              cadence: schedule.cadence,
              timezone: schedule.timezone,
              scheduleId: schedule.id,
              // The claim's clock (see the misfire branch) so a skewed worker doesn't
              // reschedule to an already-due occurrence and reclaim the same row.
              after: new Date(dbNow),
            });
            if (next == null) {
              const disabled = await deps.methods
                .disableSchedule(schedule.id, 'invalid_schedule', schedule.claimToken)
                .then(() => true)
                .catch(() => false);
              if (disabled) {
                await advanceClaim(null);
              }
            }
          }
        }),
      );
    }
    const results = await Promise.allSettled(fires);
    const rejected = results.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    if (rejected) {
      throw rejected.reason;
    }
    return fired;
  }

  const scheduleNext = () => {
    if (stopped) {
      return;
    }
    timer = setTimeout(tick, TICK_MS + Math.floor(Math.random() * TICK_JITTER_MS));
    timer.unref?.();
  };

  let activePass: Promise<void> | null = null;

  async function tick() {
    if (stopped) {
      return;
    }
    const pass = (async () => {
      try {
        if (ticks % 4 === 0) {
          await reconcile();
        }
        ticks += 1;
        await runTick();
      } catch (error) {
        logger.error('[schedules] tick failed:', error);
      }
    })().finally(() => {
      activePass = null;
    });
    activePass = pass;
    await pass;
    scheduleNext();
  }

  void reconcile();
  scheduleNext();

  const engine: ScheduleEngine = {
    stop: () => {
      stopped = true;
      stopController.abort(new Error('Schedule engine stopped'));
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
    },
    runTick,
    reconcile,
  };

  // PRE-DRAIN: the default post-drain phase leaves this timer armed while the HTTP
  // listener is closing and the generation manager has already begun refusing new jobs.
  // A tick in that window claims a due occurrence, fails its loopback POST against a
  // server that is shutting down, and books the failure against the schedule — walking a
  // healthy schedule toward auto-disable for nothing more than a restart. Stopping the
  // timer alone only narrowed the window: a pass ALREADY in flight could still claim a
  // due occurrence and lose its loopback POST against the closing listener, so the
  // shutdown also AWAITS the active pass — the coordinator's drain then holds the
  // listener open until that pass's fire completes or its claim is released.
  // Occurrences skipped by stopping early are simply still due at restart, within the
  // misfire grace.
  registerShutdownTask(
    'schedule engine',
    async () => {
      engine.stop();
      if (activePass) {
        await activePass;
      }
    },
    { phase: 'pre-drain' },
  );

  logger.info('[schedules] engine started');
  return engine;
}
