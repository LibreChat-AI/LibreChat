import { logger, runAsSystem } from '@librechat/data-schemas';
import {
  getScheduleMCPDisabledReason,
  projectScheduleMCPReceipt,
  readScheduleMCPReceipts,
} from 'librechat-data-provider';
import type { ScheduleMethods, IScheduleRun } from '@librechat/data-schemas';
import type { JobState, ScheduleEngineDeps } from './types';
import {
  hasResumeHandoffInFlight,
  hasAbortInFlight,
  retainedOutcome,
  RESUME_HANDOFF_STALE_MS,
} from './types';
import { registerShutdownTask } from '~/app/shutdown';

const SWEEP_MS = 5 * 60_000;
const SWEEP_JITTER_MS = 30_000;
const SWEEP_BATCH = 100;
/** Runs with no readable job older than this are presumed owner-dead (matches the
 *  engine reconciler's orphan cutoff). */
const ABANDONED_RUN_AGE_MS = 30 * 60_000;
/** Grace before a live schedule's reservation is converged, so an accepted delivery still
 *  creating its generation — or an owner still writing its terminal outcome — is never
 *  settled mid-handoff. */
const STRANDED_RUN_MIN_AGE_MS = 2 * 60_000;

/** Terminal job status → the run outcome it proves (mirror of the quiesce map). */
const TERMINAL_JOB_OUTCOMES: Record<string, 'success' | 'error' | 'interrupted' | undefined> = {
  complete: 'success',
  error: 'error',
  aborted: 'interrupted',
};

export interface ScheduleErasureSweep {
  stop: () => void;
  sweep: () => Promise<void>;
}

export interface ScheduleErasureDeps {
  abortScheduledJob: ScheduleEngineDeps['abortScheduledJob'];
  /** Retries held job outcomes even after the run's Mongo bookkeeping committed. */
  reconcileRetainedJobs?: () => Promise<void>;
  eraseSettledSchedule?: ScheduleEngineDeps['eraseSettledSchedule'];
  methods: Pick<
    ScheduleMethods,
    | 'getDeletingSchedules'
    | 'eraseScheduleIfDrained'
    | 'markEraseAttempted'
    | 'getActiveRunsForSchedule'
    | 'getRunsForReconciliation'
    | 'getUnbookkeptRuns'
    | 'markRunsReconciled'
    | 'finalizeBookkeeping'
    | 'recordRunOutcome'
  >;
  /** Job state at a run's conversationId; null = confirmed absent, throw = unknown. */
  getJobStatus: (conversationId: string) => Promise<JobState | null>;
  /** Durable trigger delivery for a reservation's `deliveryKey`. A `dead` delivery is
   *  POSITIVE shared evidence that no generation owns the reservation, so settling on it
   *  is topology-safe (unlike absence). */
  getTriggerDelivery: ScheduleEngineDeps['getTriggerDelivery'];
  /** Deletes a run's retained terminal job once its outcome is durable. Identity-guarded,
   *  so a replacement generation reusing the conversationId is never destroyed. */
  clearReconciledJob: ScheduleEngineDeps['clearReconciledJob'];
  /** Whether absence in this process's job store proves absence deployment-wide.
   * False for the process-local fallback whose scheduler refused unsafe topology. */
  canInferOwnerDeathFromMissingJob: boolean;
}

/** Whether the observed job still carries THIS occurrence's scheduled identity. */
function jobMatchesRun(job: JobState | null, run: IScheduleRun): boolean {
  if (job == null || job.scheduleId !== run.scheduleId || job.scheduledFor == null) {
    return false;
  }
  return new Date(job.scheduledFor).getTime() === run.scheduledFor.getTime();
}

/**
 * Settles the abandoned active runs of a DELETING schedule so the erase below can
 * proceed. The clustered entrypoint runs no engine reconciler, and the run TTL now
 * (correctly) never expires active rows — so a deleting schedule whose generation
 * owner died would otherwise retain the run and the owner's prompt indefinitely.
 * Same evidence discipline as the quiesce paths: settle only on positive evidence
 * (a terminal identity-matched job, or a confirmed-absent job past the owner-death
 * cutoff), and defer anything fenced by an in-flight abort or resume hand-off.
 */
async function settleAbandonedRuns(deps: ScheduleErasureDeps, scheduleId: string): Promise<void> {
  const runs = await deps.methods.getActiveRunsForSchedule(scheduleId);
  const now = Date.now();
  for (const run of runs) {
    try {
      if (hasAbortInFlight(run, now) || hasResumeHandoffInFlight(run, now)) {
        continue;
      }
      const job = run.conversationId
        ? await deps.getJobStatus(run.conversationId).then(
            (state) => ({ known: true, state }),
            () => ({ known: false, state: null }),
          )
        : { known: true, state: null };
      if (!job.known) {
        continue;
      }
      const identity = jobMatchesRun(job.state, run);
      if (
        identity &&
        (job.state?.providerDrained === false ||
          job.state?.terminalPersistencePending === true ||
          job.state?.terminalHostActionPending === true)
      )
        continue;
      if (identity && job.state!.status === 'running') {
        continue;
      }
      if (identity && job.state!.status === 'requires_action') {
        // A paused run of a DELETING schedule: its approval can never be consumed,
        // but a fresh pause hand-off may still be writing — the started-row gate
        // and the resume fence above already deferred those; a settled-state
        // paused row is safe to interrupt.
        if (run.status === 'started') {
          continue;
        }
      }
      const settledPause =
        identity && job.state!.status === 'requires_action' && run.status === 'requires_action';
      const retained = identity ? TERMINAL_JOB_OUTCOMES[job.state!.status] : undefined;
      if (retained == null) {
        // In the unsafe-topology fallback, a peer-owned live job is indistinguishable
        // from an absent one. Never turn that local absence (or identity mismatch) into
        // owner-death evidence and free its globally visible run/capacity slot.
        // An identity-matched, durably paused row is positive local evidence, so it
        // remains eligible for the existing age-based deleting-schedule cleanup.
        if (!settledPause && !deps.canInferOwnerDeathFromMissingJob) {
          continue;
        }
        // No terminal evidence: only presume the owner dead past the cutoff.
        const age = now - (run.firedAt?.getTime() ?? 0);
        if (age < ABANDONED_RUN_AGE_MS) {
          continue;
        }
      }
      if (
        settledPause &&
        !(await deps.abortScheduledJob(
          run.conversationId as string,
          {
            scheduleId: run.scheduleId,
            scheduledFor: run.scheduledFor,
            createdAt: job.state?.createdAt,
          },
          { preserve: true },
        ))
      )
        continue;
      await deps.methods.recordRunOutcome({
        scheduleId: run.scheduleId,
        scheduledFor: run.scheduledFor,
        ...projectScheduleMCPReceipt(
          {
            status: retained ?? 'interrupted',
            mcp: run.mcp,
            error: retained == null ? 'Schedule deleted' : undefined,
          },
          identity ? readScheduleMCPReceipts(job.state?.scheduleOutcomeError) : [],
        ),
        conversationId: run.conversationId,
        autoDisableAfterFailures: Number.MAX_SAFE_INTEGER,
      });
    } catch (err) {
      logger.warn(`[schedules] abandoned-run settle failed for ${scheduleId}:`, err);
    }
  }
}

/**
 * Converges a run from its OWN identity-matched job — the clustered mirror of the engine
 * reconciler's retained-job and pause branches.
 */
async function settleFromObservedJob(
  deps: ScheduleErasureDeps,
  run: IScheduleRun,
  job: JobState,
  now: number,
): Promise<void> {
  if (
    job.providerDrained === false ||
    job.terminalPersistencePending === true ||
    job.terminalHostActionPending === true
  )
    return;
  // A PAUSE the owner never managed to project. `recordRunOutcome('requires_action')`
  // moves the row off `started`, which is what frees its global capacity slot; the job
  // itself stays live awaiting approval, so its evidence is NOT released here. Without
  // this the row held a slot forever wherever no engine is armed, since a paused job is
  // not terminal and the dead-delivery path never looks at an identity-matched job.
  if (job.status === 'requires_action') {
    const projection = projectScheduleMCPReceipt(
      { status: 'requires_action', mcp: run.mcp },
      readScheduleMCPReceipts(job.scheduleOutcomeError),
    );
    if (run.status !== 'started' && projection.status !== 'error') return;
    if (
      projection.status === 'error' &&
      !(await deps.abortScheduledJob(
        run.conversationId as string,
        {
          scheduleId: run.scheduleId,
          scheduledFor: run.scheduledFor,
          createdAt: job.createdAt,
        },
        { preserve: true },
      ))
    )
      return;
    await deps.methods.recordRunOutcome({
      scheduleId: run.scheduleId,
      scheduledFor: run.scheduledFor,
      ...projection,
      conversationId: run.conversationId,
      autoDisableAfterFailures: Number.MAX_SAFE_INTEGER,
      // Every clustered replica runs this sweep, so N sweepers can observe the same
      // unprojected pause. The `run` above is a SNAPSHOT: once one sweeper projects the
      // pause, the owner's approval can claim a fresh slot, and a peer still holding the
      // pre-projection snapshot would pass hasResumeHandoffInFlight and unset that slot
      // and claim stamp under the running continuation. Fence it in the write itself —
      // on the SAME staleness bound as the caller's check above, so an abandoned claim
      // (worker died between claiming and resuming) still recovers rather than pinning
      // the row `started` forever with its approval unresumable.
      resumeClaimStaleBefore: new Date(now - RESUME_HANDOFF_STALE_MS),
    });
    if (projection.status === 'error')
      await deps.clearReconciledJob(run.conversationId as string, {
        scheduleId: run.scheduleId,
        scheduledFor: run.scheduledFor,
      });
    return;
  }
  const terminal = TERMINAL_JOB_OUTCOMES[job.status];
  if (terminal == null) {
    // `running`: the owner is alive and owns the settlement.
    return;
  }
  // An `aborted` job flips the moment abortJob wins its status CAS — BEFORE its owner
  // unwinds and persists — so it is the abort fence, not this status, that decides. The
  // in-flight check in the caller already deferred those; reaching here means the owner
  // is past its presumed-alive window and this is the backstop.
  const intended =
    terminal === 'interrupted'
      ? { status: 'interrupted' as const, error: undefined }
      : retainedOutcome(job, terminal === 'error' ? 'error' : 'success');
  await deps.methods.recordRunOutcome({
    scheduleId: run.scheduleId,
    scheduledFor: run.scheduledFor,
    ...projectScheduleMCPReceipt(
      { ...intended, mcp: run.mcp },
      readScheduleMCPReceipts(job.scheduleOutcomeError),
    ),
    // A pre-start abort reserved a conversationId but never created the conversation;
    // projecting it would point the card at a chat that does not exist.
    ...(terminal === 'interrupted' && job.createdEventEmitted !== true
      ? { clearConversationId: true }
      : { conversationId: run.conversationId }),
    autoDisableAfterFailures: Number.MAX_SAFE_INTEGER,
  });
  // AFTER the outcome write, never before: the retained job is the only surviving
  // evidence if that write fails, and a preserved job carries no `completedAt`, so the
  // store's finished-job sweep can never reap it on its own.
  await deps.clearReconciledJob(run.conversationId as string, {
    scheduleId: run.scheduleId,
    scheduledFor: run.scheduledFor,
  });
}

/**
 * Converges the stranded reservations of LIVE (non-deleting) schedules, on POSITIVE
 * EVIDENCE ONLY.
 *
 * `fireSchedule` reserves the run and its global capacity slot before the delivery reaches
 * the chat route, and the clustered entrypoint arms no engine — so three states would
 * otherwise hold that slot indefinitely:
 *
 * - A RETAINED TERMINAL JOB. The generation finished, but its owner's Mongo outcome write
 *   exhausted every retry (`recordScheduleOutcome` returns false) and left the preserved
 *   job as the only surviving evidence. The armed engine's reconciler replays exactly
 *   this; with no engine nothing did, so the run stayed `started` and its retained
 *   generation evidence lived until store expiry.
 * - AN UNPROJECTED PAUSE. The generation paused for approval, but the owner's
 *   `requires_action` projection failed every retry, so the row never left `started` even
 *   though the pause itself is durable in the job.
 * - A DEAD DELIVERY. A pre-generation rejection (interactive limiter, PII, moderation)
 *   dead-letters the delivery while the run stays `started` with no job at all.
 *
 * Both are safe in EVERY topology because both read positive, durable evidence instead of
 * inferring owner death from absence: an identity-matched job is authoritative wherever it
 * is observed (a shared store shows the real generation; a process-local store can only be
 * showing this process's own), and a `dead` delivery is shared state proving no generation
 * owns the reservation. This never claims, fires, or advances, and defers anything fenced
 * by an in-flight abort or resume hand-off. Generic failures retain the fallback's
 * no-auto-disable policy; a durable MCP configuration receipt still disables via the
 * run-row transition, including when a retained job originally ended as a success.
 */
async function settleStrandedRuns(deps: ScheduleErasureDeps): Promise<void> {
  const runs = await deps.methods.getRunsForReconciliation(
    new Date(Date.now() - STRANDED_RUN_MIN_AGE_MS),
    SWEEP_BATCH,
  );
  const now = Date.now();
  for (const run of runs) {
    try {
      // `started` is the capacity-consuming state this pass exists to release. A paused
      // row holds no slot, and its approval-expiry path owns its own durable retry.
      if (run.status !== 'started' && run.status !== 'requires_action') continue;
      if (hasAbortInFlight(run, now) || hasResumeHandoffInFlight(run, now)) {
        continue;
      }
      const job = run.conversationId
        ? await deps.getJobStatus(run.conversationId).then(
            (state) => ({ known: true, state }),
            () => ({ known: false, state: null }),
          )
        : { known: true, state: null };
      // Unknown is not gone: never settle on a failed job-store read.
      if (!job.known) {
        continue;
      }
      if (jobMatchesRun(job.state, run)) {
        if (
          run.status === 'requires_action' &&
          projectScheduleMCPReceipt(
            { status: 'requires_action', mcp: run.mcp },
            readScheduleMCPReceipts(job.state?.scheduleOutcomeError),
          ).status !== 'error'
        )
          continue;
        await settleFromObservedJob(deps, run, job.state as JobState, now);
        continue;
      }
      if (run.status !== 'started') continue;
      // No job of THIS occurrence's identity, so the durable delivery is the authority.
      if (!run.deliveryKey) {
        continue;
      }
      const delivery = await deps.getTriggerDelivery(run.deliveryKey);
      if (delivery?.status !== 'dead') {
        continue;
      }
      // `dead` alone is NOT proof the request was rejected. The trigger host marks
      // response timeouts and invalid success responses `ambiguous`, and the engine
      // dead-letters those once retries are exhausted — so an ambiguous dead letter can
      // sit over a generation a peer accepted and is still running. Settle only on a
      // DEFINITE rejection, unless this process can observe generation absence
      // deployment-wide (safe topology), where the confirmed-absent job above is itself
      // authoritative evidence.
      if (delivery.lastError?.certainty !== 'definite' && !deps.canInferOwnerDeathFromMissingJob) {
        continue;
      }
      await deps.methods.recordRunOutcome({
        scheduleId: run.scheduleId,
        scheduledFor: run.scheduledFor,
        status: 'error',
        conversationId: run.conversationId,
        // `lastError` is an AgentTriggerDeliveryFailure, not a string: passing the object
        // into the String-typed run/schedule error fields fails the Mongoose cast, and the
        // per-row catch would swallow it while the run kept its capacity slot.
        error: delivery.lastError?.message ?? 'Scheduled delivery failed before running',
        autoDisableAfterFailures: Number.MAX_SAFE_INTEGER,
      });
    } catch (err) {
      logger.warn(`[schedules] stranded-run settle failed for ${run.scheduleId}:`, err);
    }
  }
}

/** Replays a crashed permanent-MCP terminal projection where no engine is armed. */
async function replayUnbookkeptMCPRuns(deps: ScheduleErasureDeps): Promise<void> {
  const runs = await deps.methods.getUnbookkeptRuns(
    new Date(Date.now() - STRANDED_RUN_MIN_AGE_MS),
    SWEEP_BATCH,
  );
  for (const run of runs) {
    if (run.status !== 'error' || !getScheduleMCPDisabledReason(run.mcp)) {
      continue;
    }
    try {
      await deps.methods.finalizeBookkeeping({
        scheduleId: run.scheduleId,
        scheduledFor: run.scheduledFor,
        status: 'error',
        conversationId: run.conversationId,
        error: run.error,
        mcp: run.mcp,
        autoDisableAfterFailures: Number.MAX_SAFE_INTEGER,
      });
    } catch (error) {
      logger.warn(`[schedules] MCP bookkeeping replay failed for ${run.scheduleId}:`, error);
    }
  }
  await deps.methods.markRunsReconciled(runs);
}

/**
 * Maintains erasure and positively evidenced stranded-run convergence without arming a scheduler.
 *
 * A `deleting` row is normally erased by whichever actor first observes it drained: the
 * delete request, or the terminal outcome write (erase-on-settle). Both are single
 * best-effort attempts, so one transient failure — or a lease that outlived the delete —
 * leaves a hidden row holding the user's prompt, with no TTL and no way for the owner to
 * retry it (the row is hidden from their list). In the standard entrypoint the
 * reconciler retries it; the clustered entrypoint runs no engine, so nothing does.
 *
 * This is deliberately NOT the engine: it never claims, leases, fires or advances.
 * Every convergence write is idempotent and guarded by the run or schedule's current
 * state, so concurrent clustered sweepers can re-drive cleanup safely.
 */
export function startScheduleErasureSweep(deps: ScheduleErasureDeps): ScheduleErasureSweep {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;

  async function sweep(): Promise<void> {
    try {
      await runAsSystem(async () => {
        await deps
          .reconcileRetainedJobs?.()
          .catch((error) => logger.warn('[schedules] retained job recovery failed:', error));
        const deleting = await deps.methods.getDeletingSchedules(SWEEP_BATCH);
        for (const schedule of deleting) {
          await settleAbandonedRuns(deps, schedule.id).catch((err) => {
            logger.warn(`[schedules] abandoned-run pass failed for ${schedule.id}:`, err);
          });
          await (
            deps.eraseSettledSchedule
              ? deps.eraseSettledSchedule(schedule.id)
              : deps.methods.eraseScheduleIfDrained(schedule.id)
          ).catch((err) => {
            logger.warn(`[schedules] erasure sweep failed for ${schedule.id}:`, err);
          });
        }
        // Rotate the window (never-attempted first) so a batch of undrainable rows
        // cannot re-fill it every sweep and starve the rows behind them.
        await deps.methods
          .markEraseAttempted(deleting.map((schedule) => schedule.id))
          .catch((err) => logger.warn('[schedules] failed to stamp erase attempts:', err));
        // Live schedules too: converge reservations left stranded by a retained terminal
        // job or a dead delivery, so neither can hold a global capacity slot — and no
        // generation evidence can outlive its run — where no engine is armed.
        await settleStrandedRuns(deps).catch((err) =>
          logger.warn('[schedules] stranded-run convergence pass failed:', err),
        );
        await replayUnbookkeptMCPRuns(deps).catch((err) =>
          logger.warn('[schedules] MCP bookkeeping replay pass failed:', err),
        );
      });
    } catch (err) {
      logger.error('[schedules] erasure sweep failed:', err);
    }
  }

  function schedule(): void {
    if (stopped) {
      return;
    }
    // Jittered so replicas of a clustered deployment do not sweep in lockstep.
    const delay = SWEEP_MS + Math.floor(Math.random() * SWEEP_JITTER_MS);
    timer = setTimeout(() => {
      void sweep().finally(schedule);
    }, delay);
    timer.unref?.();
  }

  schedule();

  const engineSweep: ScheduleErasureSweep = {
    sweep,
    stop: () => {
      stopped = true;
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
    },
  };

  registerShutdownTask('schedule erasure sweep', () => engineSweep.stop(), { phase: 'pre-drain' });

  return engineSweep;
}
