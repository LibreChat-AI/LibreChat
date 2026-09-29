import { randomUUID } from 'node:crypto';
import { logger } from '@librechat/data-schemas';
import type { ScheduleEngineDeps, ScheduleLimits, FireResult, FireableSchedule } from './types';
import type { AgentTriggerEnvelope } from '../agents/triggers/envelope';
import type { JsonValue } from '../agents/json';
import {
  AgentTriggerEnvelopeError,
  createAgentTriggerEnvelope,
  getAgentTriggerIdempotencyKey,
} from '../agents/triggers/envelope';
import { AgentTriggerServiceUnavailableError } from '../agents/triggers/service';
import { AgentTriggerDeliveryError } from '../agents/triggers/delivery';
import { computeNextRunAt, cadenceIntervalMinutes } from './cadence';
import { resolveScheduleProjectId } from './types';
import { ScheduleMCPError } from './mcp';

/** Consecutive balance skips (pre-fire or mid-generation) before auto-disable. */
export const BALANCE_SKIP_DISABLE_THRESHOLD: number = 5;

/**
 * Stable source delivery identity for one scheduled occurrence. The trigger
 * service hashes this into the generation-compatible idempotency key.
 */
export function buildFireClientRequestId(scheduleId: string, scheduledFor: Date): string {
  return `sched:${scheduleId}:${scheduledFor.toISOString().replace('.', '-')}`;
}

/**
 * `ambiguous` means Mongo may have committed the idempotent trigger delivery even
 * though enqueue returned an error. Those must remain reconcilable rather than be
 * terminalized as a definite failure.
 */
class ScheduleFireError extends Error {
  constructor(
    message: string,
    readonly ambiguous: boolean,
  ) {
    super(message);
  }
}

/**
 * Builds the durable trigger envelope for one occurrence. Pure and deterministic in the
 * fields that {@link getAgentTriggerIdempotencyKey} hashes (only `requestId`/`receivedAt`
 * vary), so the `deliveryKey` derived from it is stable across retries and is stored on
 * the reservation BEFORE enqueue — that lets schedule reconciliation read the durable
 * delivery state even for an ambiguously-committed enqueue.
 */
function buildScheduleTriggerEnvelope(
  schedule: FireableSchedule,
  user: NonNullable<Awaited<ReturnType<ScheduleEngineDeps['getUserContext']>>>,
  scheduledFor: Date,
  files: Awaited<ReturnType<ScheduleEngineDeps['resolveFiles']>>,
  conversationId: string,
  manual: boolean,
  chatProjectId?: string,
): AgentTriggerEnvelope {
  const occurrenceId = buildFireClientRequestId(schedule.id, scheduledFor);
  const triggerFiles: JsonValue[] = files.map((file) => {
    const value: { [key: string]: JsonValue } = { file_id: file.file_id };
    if (file.filepath != null) value.filepath = file.filepath;
    if (file.filename != null) value.filename = file.filename;
    if (file.type != null) value.type = file.type;
    if (file.height != null) value.height = file.height;
    if (file.width != null) value.width = file.width;
    if (file.source != null) value.source = file.source;
    return value;
  });
  return createAgentTriggerEnvelope({
    mode: 'fire',
    requestId: randomUUID(),
    deliveryId: occurrenceId,
    receivedAt: Date.now(),
    principal: {
      id: user.id,
      ...(user.role != null && { role: user.role }),
      ...(user.tenantId != null && { tenantId: user.tenantId }),
    },
    target: { agentId: schedule.agent_id },
    event: {
      id: occurrenceId,
      type: 'schedule.occurrence',
      occurredAt: scheduledFor.getTime(),
      source: { id: schedule.id, type: 'schedule' },
    },
    input: schedule.prompt,
    run: {
      conversationId,
      timezone: schedule.timezone,
      ...(chatProjectId != null && { chatProjectId }),
      ...(triggerFiles.length > 0 && { files: triggerFiles }),
      metadata: {
        manual,
        ...(typeof schedule.configRevision === 'number' && {
          configRevision: schedule.configRevision,
        }),
      },
    },
  });
}

async function enqueueScheduleTrigger(
  deps: ScheduleEngineDeps,
  envelope: AgentTriggerEnvelope,
  orderingKey: string,
): Promise<void> {
  try {
    await deps.enqueueTrigger(envelope, { orderingKey });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const definite =
      error instanceof AgentTriggerEnvelopeError ||
      error instanceof AgentTriggerDeliveryError ||
      error instanceof AgentTriggerServiceUnavailableError;
    // A storage error can be returned after Mongo committed the idempotent delivery.
    // Leave that occurrence reconcilable; a later worker may already own it.
    throw new ScheduleFireError(`Trigger enqueue failed: ${message}`, !definite);
  }
}

/**
 * Fires one claimed occurrence. The caller owns the lease; this function owns
 * the run-doc idempotency insert, the skip checks, durable trigger enqueue, and
 * advancing `nextRunAt` (every path advances so a schedule can never wedge).
 */
export async function fireSchedule(
  deps: ScheduleEngineDeps,
  schedule: FireableSchedule,
  limits: ScheduleLimits,
  scheduledFor: Date,
  options?: { manual?: boolean; dbNow?: Date; signal?: AbortSignal },
): Promise<FireResult> {
  const { methods } = deps;
  // Compute the NEXT occurrence relative to the CLAIM's clock (the engine passes
  // the claim time derived from leaseUntil), keeping the advance self-consistent
  // with the claim that selected this occurrence. Falls back to the process clock
  // when no claim time is provided (e.g. manual run-now, which never reschedules
  // and so ignores the result anyway). Inter-replica skew shifts WHEN an occurrence
  // fires by at most the skew; it can never fire one twice (lease CAS + the unique
  // occurrence index) — see LEASE_SKEW_MARGIN_MS in data-schemas for the takeover
  // margin that protects the only cross-worker clock comparison.
  const now = options?.dbNow ?? new Date();
  const nextRunAt = computeNextRunAt({
    cadence: schedule.cadence,
    timezone: schedule.timezone,
    scheduleId: schedule.id,
    after: new Date(Math.max(now.getTime(), scheduledFor.getTime())),
  });
  // Every worker-side schedule write is fenced on the claim token so a stale
  // worker (lease expired + re-claimed, or the schedule edited/re-enabled/deleted
  // — all of which rotate the token) cannot clobber the newer authoritative state.
  const claimToken = schedule.claimToken;

  /**
   * Rolls back the `started` row this fire reserved. Fenced on the conversation id it
   * generated rather than on lease ownership: every call site here is a path where
   * NOTHING was dispatched, and the row can only carry this id if this fire inserted
   * it (the single-active partial index admits one). Lease state is the wrong fence —
   * the preflight and capacity allocator can outlast the 5-minute lease, and gating on
   * a takeover left the undispatched row (and its global capacity slot) stranded until
   * the 30-minute orphan sweep while the new holder saw `duplicate` and advanced past
   * the occurrence without firing it.
   */
  const rollbackReservation = (conversationId: string) =>
    methods.deleteScheduleRun(schedule.id, scheduledFor, 'started', conversationId);

  /**
   * Steps aside from a superseded fire (owner edit/delete, or a lease-expiry re-claim).
   * `advance()` is fenced on the OLD claim token, which the edit rotated, so it no-ops
   * and would leave this worker's lease held until its TTL — reporting the edited
   * schedule / Run now as "already in progress" though no run was dispatched. Releasing
   * by HOLDER makes it immediately re-claimable, and correctly no-ops after a takeover
   * (leaseBy changed) so the new holder's lease is never stripped.
   */
  const releaseSupersededLease = async () => {
    if (schedule.leaseBy != null) {
      await methods.releaseLeaseByHolder(schedule.id, schedule.leaseBy);
    }
  };

  /**
   * Releases a manual run's lease without leaving its old holder behind when an owner
   * edit rotates the claim token during an asynchronous preflight. The token fence is
   * authoritative when it still matches; the unique holder fallback can only clear this
   * fire's lease and safely no-ops if another worker has taken it over.
   */
  const releaseManualLease = async () => {
    const released = await methods.releaseLease(schedule.id, claimToken);
    if (!released) {
      await releaseSupersededLease();
    }
    return released;
  };

  // A manual run-now must never reschedule the next automatic occurrence; it only
  // releases its serialization lease. Both writes are token-fenced, so an owner edit
  // racing after durable enqueue can make them miss while deliberately preserving the
  // old holder fields. Release by the unique OLD holder on a miss: an edit is unwedged
  // immediately, while a takeover changed leaseBy and remains untouched.
  const advance = async () => {
    if (options?.manual) {
      return releaseManualLease();
    }
    const advanced = await methods.advanceSchedule(
      schedule.id,
      nextRunAt,
      scheduledFor,
      claimToken,
    );
    if (!advanced) {
      await releaseSupersededLease();
    }
    return advanced;
  };

  /**
   * Steps aside after a failed revalidation WITHOUT advancing. `advance()` here is a
   * designed no-op in every true supersession (takeover, owner edit — both rotate the
   * claim token, so its token-fenced filter misses), which means the only case where it
   * actually LANDS is the one it must not: a PURE lease expiry with no takeover, where
   * the token never rotated. advanceSchedule checks no lease, so the advance moved
   * nextRunAt past an occurrence nothing had fired — a preflight outlasting the lease
   * silently dropped it instead of leaving it due for the next claim to retry.
   * Manual run-now still releases its serialization lease (release-only, no advance)
   * so a repeat click isn't met with a stale "already in progress".
   */
  const stepAsideSuperseded = async () => {
    if (options?.manual) {
      await releaseManualLease();
    } else {
      await releaseSupersededLease();
    }
    return { fired: false, skipped: 'superseded' as const };
  };

  if (nextRunAt == null) {
    await methods.disableSchedule(schedule.id, 'invalid_schedule', claimToken);
    await advance();
    return { fired: false, error: 'No next occurrence computable' };
  }

  const user = await deps.getUserContext(schedule.user);
  if (user == null) {
    await methods.disableSchedule(schedule.id, 'permission_revoked', claimToken);
    await advance();
    return { fired: false, skipped: 'user_missing' };
  }

  return deps.runInTenantContext(user, async () => {
    // Re-resolve limits for the OWNER (per-principal role/user + tenant config):
    // a tenant- or role-specific config (disabled schedules, different
    // auto-disable threshold) must win over the base config the engine read.
    const ownerLimits = await deps.getLimits(user);
    const deploymentLimits = await deps.getLimits();
    if (!ownerLimits.enabled) {
      // A deployment-wide stop freezes due occurrences. The engine may have claimed
      // this one just before the switch changed, so hand its lease back without
      // advancing. A principal-scoped disable still consumes the occurrence because
      // that owner is not allowed to dispatch it under the current policy.
      if (!deploymentLimits.enabled) {
        return stepAsideSuperseded();
      }
      await advance();
      return { fired: false, skipped: 'disabled' as const };
    }

    // Enforce a raised interval floor at fire time: create/update reject too-frequent
    // cadences, but an admin raising the floor later must also stop an already-enabled
    // schedule that now runs more often than policy allows.
    // The schedule's own zone, because a cron cadence's tightest gap is a wall-clock
    // question: spring-forward compresses a pair that straddles it, and the structured
    // branches ignore the argument entirely.
    if (
      cadenceIntervalMinutes(schedule.cadence, schedule.timezone) < ownerLimits.minIntervalMinutes
    ) {
      await methods.disableSchedule(schedule.id, 'invalid_schedule', claimToken);
      await advance();
      return { fired: false, skipped: 'disabled' as const };
    }

    // Account-deletion barrier, re-checked at the DISPATCH boundary. Admission (the
    // create/update/run-now handlers) is the primary gate, but there is always a window
    // between admission and persistence, so the owner is re-checked immediately before a
    // billed generation is dispatched. Skips silently: the deletion cascade owns the row.
    if (await deps.isOwnerDeleting(user.id)) {
      await advance();
      return { fired: false, skipped: 'user_deleting' as const };
    }

    // Re-check the owner's live schedule permission: a role that lost
    // SCHEDULES access after the schedule was created must stop firing.
    if (!(await deps.hasScheduleAccess(user))) {
      await methods.disableSchedule(schedule.id, 'permission_revoked', claimToken);
      await advance();
      return { fired: false, skipped: 'permission_revoked' as const };
    }

    // The owner-config generation this occurrence was CLAIMED under, stamped onto every
    // run row (fired or skipped) so bookkeeping can derive its fence from the row.
    const claimedRevision =
      typeof schedule.configRevision === 'number'
        ? { configRevision: schedule.configRevision }
        : {};

    const baseRun = {
      scheduleId: schedule.id,
      user: schedule.user,
      tenantId: schedule.tenantId,
      scheduledFor,
    };

    const agentAccess = await deps.agentAccess(schedule.agent_id, user);
    if (agentAccess !== 'ok') {
      // 'missing' → deleted; 'forbidden' → the owner's VIEW access was revoked.
      // Disable immediately instead of letting the loopback chat reject the run
      // and burn attempts toward the failure threshold.
      const reason = agentAccess === 'missing' ? 'agent_deleted' : 'permission_revoked';
      await methods.disableSchedule(schedule.id, reason, claimToken);
      await advance();
      return { fired: false, skipped: reason };
    }

    // Destination project, re-resolved under the OWNER's current policy: an operator
    // pin outranks the stored id, so tightening the config redirects (or stops) an
    // existing schedule instead of grandfathering where its runs land.
    const chatProjectId = resolveScheduleProjectId(ownerLimits, schedule.chatProjectId);
    if (ownerLimits.requireProject && chatProjectId == null) {
      // The requirement was raised after this schedule was created. Disable rather
      // than filing runs loose: the owner chose no project under the old policy, and
      // only they can say which one now applies.
      await methods.disableSchedule(schedule.id, 'project_required', claimToken);
      await advance();
      return { fired: false, skipped: 'project_required' as const };
    }
    if (chatProjectId != null && (await deps.projectAccess(chatProjectId, user)) !== 'ok') {
      // Gone, or pinned to a project this owner does not have. Either way the run
      // would be filed nowhere (saveConvo drops an unowned chatProjectId), so stop
      // instead of quietly widening the schedule's scope — same reasoning as
      // agent_deleted, and the same immediate disable so failures aren't burned.
      await methods.disableSchedule(schedule.id, 'project_deleted', claimToken);
      await advance();
      return { fired: false, skipped: 'project_deleted' as const };
    }
    // Converge the ROW on the destination this fire resolved — AFTER it has been
    // validated, so an unusable pin is never written. The pin outranks the stored id
    // here and the conversation this occurrence creates is filed under the RESOLVED
    // project, so leaving the row on its old value would make every later
    // re-validation (notably the resume boundary) check a project the conversation was
    // never filed under. Best-effort: the envelope already carries the right
    // destination, so a failed write costs accuracy on a later recheck, never this run.
    if (chatProjectId !== (schedule.chatProjectId ?? undefined)) {
      await methods
        .persistResolvedProject(schedule.id, chatProjectId, claimToken)
        .catch((err: unknown) =>
          logger.warn(`[schedules] could not converge stored project for ${schedule.id}`, err),
        );
    }

    if (await deps.isOutOfBalance(user)) {
      // Revalidate BEFORE writing the skip. Everything above (user, config, permission
      // and balance lookups) can outlast the 5-minute lease, and a skip is not a no-op:
      // it stamps the card and walks the balance-skip streak toward auto-disable. Under
      // a dead claim — lease taken over, schedule deleted, account deletion begun — that
      // is a write on behalf of a fire that no longer owns this occurrence. The reserve
      // path below has its own revalidation for the same reason; this one guards the
      // branch that returns before ever reaching it.
      if (
        claimToken != null &&
        !(await methods.revalidateClaim(schedule.id, claimToken, !options?.manual))
      ) {
        return stepAsideSuperseded();
      }
      // Skip rows carry no `bookkept:false` marker, so the reconciler has no path to
      // repair a half-applied skip. If the schedule-side bookkeeping throws, do NOT
      // advance: leave the occurrence due so the next claim retries it (the insert is
      // duplicate-guarded and the same-skip retry path is idempotent).
      try {
        await methods.recordSkippedRun(
          { ...baseRun, status: 'skipped_balance', ...claimedRevision },
          BALANCE_SKIP_DISABLE_THRESHOLD,
        );
      } catch (skipError) {
        logger.error(`[schedules] balance-skip bookkeeping failed for ${schedule.id}:`, skipError);
        return { fired: false, skipped: 'balance' as const };
      }
      await advance();
      return { fired: false, skipped: 'balance' as const };
    }

    // Resolve attachments BEFORE claiming the run row: a transient file-query
    // failure here must not orphan a `started` run that consumes capacity.
    const requestedFileIds = schedule.file_ids ?? [];
    let files: Awaited<ReturnType<ScheduleEngineDeps['resolveFiles']>>;
    try {
      files = requestedFileIds.length ? await deps.resolveFiles(requestedFileIds, user) : [];
    } catch (fileError) {
      logger.error(
        `[schedules] file resolution failed for ${schedule.id} (will retry):`,
        fileError,
      );
      // nextRunAt is untouched so the occurrence retries. Automatic claims keep the
      // lease as a backoff (releasing it would let the nextRunAt-sorted claimer
      // re-pick this failing row every tick and starve others / hammer the file
      // lookup); manual run-now releases so the user can retry immediately.
      if (options?.manual) {
        await releaseManualLease();
      }
      return { fired: false, error: 'File resolution failed' };
    }
    const droppedFileIds = requestedFileIds.filter(
      (id) => !files.some((file) => file.file_id === id),
    );

    // Revalidate BEFORE reserving, not only before the POST below. The preflight above
    // (user, config, permission, balance, attachment queries) can outlast the 5-minute
    // lease, and a stale worker that reserves anyway wins the occurrence's unique row:
    // the fresh claimer then sees `duplicate` and advances without firing, while this
    // worker's own revalidation fails and rollbackReservation deliberately RETAINS the
    // row (the lease takeover changed leaseBy). The occurrence is lost and its global
    // capacity slot stays held until the 30-minute orphan sweep. Nothing is reserved yet
    // here, so a superseded fire simply steps aside.
    if (
      claimToken != null &&
      !(await methods.revalidateClaim(schedule.id, claimToken, !options?.manual))
    ) {
      return stepAsideSuperseded();
    }

    // SHUTDOWN gate at the dispatch boundary: the coordinator closes the listener
    // BEFORE the engine's pre-drain task runs, so a pass already past its preflight
    // would POST at a refusing socket — a definite connect failure that terminalizes
    // as `error` and walks a healthy schedule toward auto-disable for nothing more
    // than a restart. Nothing is reserved yet, so stepping aside leaves the
    // occurrence due for the restarted process (within the misfire grace).
    if (deps.isShuttingDown?.() === true) {
      logger.info(`[schedules] shutdown in progress; releasing claim on ${schedule.id}`);
      return stepAsideSuperseded();
    }

    // Readiness is admission work, not generation work. Probe before reserving a
    // durable started row or a global generation slot so a slow MCP endpoint cannot
    // consume the capacity healthy ready schedules need to dispatch.
    let mcp: Awaited<ReturnType<ScheduleEngineDeps['preflightMCP']>> = [];
    let mcpFailure: { error: ScheduleMCPError | null; message: string } | null = null;
    try {
      const leaseDeadline = schedule.leaseUntil?.getTime() ?? Number.POSITIVE_INFINITY;
      const preflightDeadline =
        Date.now() +
        Math.min(ownerLimits.mcpPreflightTimeoutMs, deploymentLimits.mcpPreflightTimeoutMs);
      mcp = await deps.preflightMCP(schedule.agent_id, user, {
        scheduleId: schedule.id,
        signal: options?.signal,
        concurrency: Math.min(
          ownerLimits.mcpPreflightConcurrency,
          deploymentLimits.mcpPreflightConcurrency,
        ),
        deadlineMs: Math.min(leaseDeadline, preflightDeadline),
      });
    } catch (error) {
      if (options?.signal?.aborted) {
        return stepAsideSuperseded();
      }
      if (
        claimToken != null &&
        !(await methods.revalidateClaim(schedule.id, claimToken, !options?.manual))
      ) {
        return stepAsideSuperseded();
      }
      const failure = error instanceof ScheduleMCPError ? error : null;
      mcpFailure = { error: failure, message: failure?.message ?? 'MCP preflight unavailable' };
    }

    if (options?.signal?.aborted) {
      return stepAsideSuperseded();
    }

    // Pre-generate the conversation id and reserve the run row up front. The
    // loopback POST reuses it (streamId === conversationId), so reconciliation can
    // ALWAYS locate this occurrence's job — even if the post-accept detail write
    // fails — instead of mislabeling an accepted (or preserved) run as an orphan.
    // reserveStartedRun is the atomic overlap guard: the single-active partial index
    // rejects a second `started` run for the schedule, so a concurrent occurrence
    // surfaces as 'overlap' with no read-then-insert race.
    const conversationId = randomUUID();
    // Build the durable trigger envelope NOW so the deterministic deliveryKey can be
    // stored on the reservation below — before enqueue. That way schedule reconciliation
    // can read the delivery state (live vs dead) even when the enqueue commits ambiguously,
    // instead of orphaning a still-live delivery after the 30-minute cutoff. A schedule
    // whose envelope cannot be built can never fire, so skip WITHOUT reserving a phantom
    // `started` run (a definite, retry-invariant failure).
    let triggerEnvelope: AgentTriggerEnvelope;
    try {
      triggerEnvelope = buildScheduleTriggerEnvelope(
        schedule,
        user,
        scheduledFor,
        files,
        conversationId,
        options?.manual === true,
        chatProjectId,
      );
    } catch (envelopeError) {
      logger.error(`[schedules] trigger envelope build failed for ${schedule.id}:`, envelopeError);
      if (options?.manual) {
        await releaseManualLease();
      } else {
        await advance();
      }
      return {
        fired: false,
        error: envelopeError instanceof Error ? envelopeError.message : String(envelopeError),
      };
    }
    const deliveryKey = getAgentTriggerIdempotencyKey(triggerEnvelope);
    const reserveRun = (
      capacitySlot?: number,
      admissionFailure?: {
        error: string;
        mcp?: Awaited<ReturnType<ScheduleEngineDeps['preflightMCP']>>;
      },
    ) =>
      methods.reserveStartedRun({
        ...baseRun,
        conversationId,
        firedAt: new Date(),
        ...(capacitySlot != null ? { capacitySlot } : {}),
        ...(admissionFailure
          ? {
              admissionOnly: true,
              error: admissionFailure.error,
              ...(admissionFailure.mcp ? { mcp: admissionFailure.mcp } : {}),
            }
          : {}),
        deliveryKey,
        // The destination THIS occurrence used. The schedule-level value can move on
        // (a pin redirects later fires, and a paused run does not block them), so a
        // resume must re-validate what its own conversation was filed under.
        // ALWAYS written, `null` when deliberately unscoped: a later reader has to be
        // able to tell "this run had no project" from "this row predates the field",
        // and only the latter may fall back to the schedule's current value.
        chatProjectId: chatProjectId ?? null,
        ...(typeof schedule.configRevision === 'number'
          ? { configRevision: schedule.configRevision }
          : {}),
      });

    let reservation: Awaited<ReturnType<typeof methods.reserveStartedRun>>;
    if (mcpFailure != null) {
      // A terminal admission failure needs durable evidence and schedule bookkeeping,
      // but it never starts a generation. Reserve the occurrence idempotently without
      // a generation slot, then settle it immediately below.
      reservation = await reserveRun(undefined, {
        error: mcpFailure.message.slice(0, 2048),
        ...(mcpFailure.error ? { mcp: mcpFailure.error.outcomes } : {}),
      });
    } else {
      // The GLOBAL fireConcurrency cap is enforced by claiming a unique capacity slot
      // in the SAME insert that reserves a generation, so it is decided by the DB rather
      // than by a count read before the write. The allocator advances to the next free
      // slot when another ready admission wins one, and reports 'capacity' only when
      // genuinely saturated. Occupancy is read system-scoped so the cap stays global
      // across tenants.
      // CLAMPED to the deployment-wide cap. The slots are global across every owner, so a
      // role/user/tenant override must never be able to WIDEN them: manual Run Now resolves
      // the owner's limits and bypasses the engine tick's base-config budget entirely, so
      // an override of 5 against a base of 1 would otherwise let concurrent clicks occupy
      // slots 0-4 and run five billed generations at once. Re-read without a principal for
      // the base value (the same read the tick budgets from); a STRICTER owner value still
      // applies, since only widening is the defect.
      const allocation = await deps.withGlobalCapacitySlot(
        Math.min(ownerLimits.fireConcurrency, deploymentLimits.fireConcurrency),
        async (capacitySlot) => {
          const attempt = await reserveRun(capacitySlot);
          return 'conflict' in attempt && attempt.conflict === 'slot-taken'
            ? 'slot-taken'
            : { claimed: attempt };
        },
      );
      if (allocation === 'capacity') {
        // Automatic claims keep the claim's lease as a backoff so the nextRunAt-sorted
        // claimer doesn't immediately re-pick this row and starve others; nextRunAt is
        // untouched, so the occurrence retries once the lease expires. A manual run-now
        // MUST release its lease, or repeated Run-now clicks hit a misleading "already
        // in progress" 409 for the full manual-lease TTL even after capacity frees.
        if (options?.manual) {
          await releaseManualLease();
        } else {
          const released = await methods.releaseLease(schedule.id, claimToken);
          if (!released) {
            await releaseSupersededLease();
          }
        }
        return { fired: false, skipped: 'capacity' as const };
      }
      reservation = allocation.claimed;
    }
    if ('conflict' in reservation) {
      if (reservation.conflict === 'overlap') {
        // Another occurrence of this schedule is already active. Record the skip
        // (its own occurrence row) and advance past this one.
        try {
          await methods.recordSkippedRun({
            ...baseRun,
            status: 'skipped_overlap',
            ...claimedRevision,
          });
        } catch (skipError) {
          // Same reasoning as the balance skip: no reconciliation path repairs a
          // half-applied skip, so leave the occurrence due rather than advancing past it.
          logger.error(
            `[schedules] overlap-skip bookkeeping failed for ${schedule.id}:`,
            skipError,
          );
          return { fired: false, skipped: 'overlap' as const };
        }
        await advance();
        return { fired: false, skipped: 'overlap' as const };
      }
      // A duplicate means another fire already holds this occurrence's row — but
      // "still running it" and "already finished with it" need OPPOSITE handling.
      //
      // TERMINAL: the occurrence is done and merely never advanced past (its fire was
      // accepted but the post-accept advance failed). nextRunAt still points here, so
      // refusing to advance makes every future claim re-pick the same settled
      // occurrence — a permanent stall. Advance past it.
      //
      // ACTIVE: another worker owns it. Advancing hands the occurrence away — if that
      // worker is a stale lease holder whose own revalidation then fails, it rolls its
      // undispatched row back and nothing ever fires this occurrence. Leave nextRunAt
      // alone so it stays claimable; whichever worker actually dispatches is the one
      // that advances, and the claim's lease is the retry backoff (the same shape as
      // `capacity` above). A crashed holder's row is cleared by the orphan sweep, after
      // which the occurrence reserves cleanly.
      const settledAlready =
        reservation.existingStatus != null &&
        reservation.existingStatus !== 'started' &&
        reservation.existingStatus !== 'requires_action';
      if (settledAlready) {
        await advance();
        return { fired: false, skipped: 'duplicate' as const };
      }
      // Manual run-now still releases its lease so repeated clicks aren't met with a
      // stale "already in progress".
      if (options?.manual) {
        await releaseManualLease();
      }
      return { fired: false, skipped: 'duplicate' as const };
    }

    if (mcpFailure != null) {
      await methods.recordRunOutcome({
        scheduleId: schedule.id,
        scheduledFor,
        status: 'error',
        error: mcpFailure.message,
        ...(mcpFailure.error ? { mcp: mcpFailure.error.outcomes } : {}),
        autoDisableAfterFailures: ownerLimits.autoDisableAfterFailures,
        clearConversationId: true,
      });
      await advance();
      return {
        fired: false,
        error: mcpFailure.message,
        ...(mcpFailure.error
          ? { mcp: mcpFailure.error.outcomes }
          : { mcpPreflightUnavailable: true }),
      };
    }

    if (options?.signal?.aborted) {
      await rollbackReservation(conversationId);
      return stepAsideSuperseded();
    }

    // Last check before the point of no return: re-verify this fire still holds an
    // authoritative claim (same claim token, lease unexpired, not deleting; and for
    // an automatic fire, still enabled). An owner delete/edit or a lease-expiry
    // re-claim landing AFTER the lease was taken but before here supersedes this
    // fire — roll the reservation back (status-fenced) and skip WITHOUT dispatching
    // a billed generation. Manual run-now still revalidates (a delete/edit can land
    // after acquireManualRunLease); it only relaxes the `enabled` check since the
    // user explicitly triggered it.
    if (
      claimToken != null &&
      !(await methods.revalidateClaim(schedule.id, claimToken, !options?.manual))
    ) {
      await rollbackReservation(conversationId);
      return stepAsideSuperseded();
    }

    if (options?.signal?.aborted) {
      await rollbackReservation(conversationId);
      return stepAsideSuperseded();
    }

    // SHUTDOWN recheck immediately before dispatch: the gate before the reservation
    // is not the last dispatch-boundary operation — the deployment-limit read,
    // capacity allocation, and claim revalidation all run after it and can overlap
    // SIGTERM, leaving the listener closing by the time the POST goes out. Roll the
    // reservation back (status-fenced) and step aside without advancing: the
    // occurrence stays due for the restarted process within the misfire grace.
    if (deps.isShuttingDown?.() === true) {
      logger.info(
        `[schedules] shutdown in progress; rolling back reserved dispatch of ${schedule.id}`,
      );
      await rollbackReservation(conversationId);
      return stepAsideSuperseded();
    }

    try {
      await enqueueScheduleTrigger(deps, triggerEnvelope, schedule.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const ambiguous = error instanceof ScheduleFireError && error.ambiguous;
      if (ambiguous) {
        // Mongo may have accepted the durable delivery, which can later start a
        // generation and call recordScheduleOutcome. Leave the run `started` (a
        // reconcilable, non-terminal state) so that completion can finalize it and
        // overlap/capacity keep seeing it; the orphan sweep settles it otherwise.
        // Do NOT terminalize here — `interrupted` would block the real outcome.
        logger.warn(
          `[schedules] trigger enqueue ambiguously failed for ${schedule.id} (left reconcilable):`,
          error,
        );
        await advance();
        return { fired: false, error: message };
      }
      // Definite enqueue rejection: no durable delivery exists and nothing started.
      logger.error(`[schedules] trigger enqueue rejected for ${schedule.id}:`, error);
      await methods.recordRunOutcome({
        scheduleId: schedule.id,
        scheduledFor,
        status: 'error',
        error: message,
        autoDisableAfterFailures: ownerLimits.autoDisableAfterFailures,
      });
      await advance();
      return { fired: false, error: message };
    }

    // The trigger delivery is durable: the eventual chat reports its own terminal
    // outcome via the completion hook. Post-enqueue bookkeeping failures must NOT
    // flip the run to `error` (that would block the real completion, which only
    // matches started/paused).
    try {
      await advance();
      await methods.setRunFireDetails(schedule.id, scheduledFor, {
        conversationId,
        ...(mcp.length > 0 ? { mcp } : {}),
        ...(droppedFileIds.length > 0 ? { droppedFileIds } : {}),
      });
      if (droppedFileIds.length > 0) {
        logger.warn(
          `[schedules] ${schedule.id} fired without ${droppedFileIds.length} missing attachment(s)`,
        );
      }
    } catch (bookkeepingError) {
      logger.error(
        `[schedules] post-enqueue bookkeeping failed for ${schedule.id} (run continues):`,
        bookkeepingError,
      );
    }
    return { fired: true, conversationId };
  });
}
