import { isBalanceRefillDue, Permissions, PermissionTypes } from 'librechat-data-provider';
import { logger, runAsSystem, tenantStorage, isRuntimeDisabled } from '@librechat/data-schemas';
import {
  DEFAULT_SCHEDULE_MCP_CONSENT_LIFETIME_HOURS,
  isScheduleMCPAuthorizationFailure,
  readScheduleMCPOutcomes,
  getScheduleMCPDisabledReason,
  projectScheduleMCPReceipt,
  readScheduleMCPReceipts,
  mergeScheduleMCPReceipts,
} from 'librechat-data-provider';
import type { ScheduleMethods, AppConfig, IBalance, IChatProject } from '@librechat/data-schemas';
import type { TCheckpointerConfig } from 'librechat-data-provider';
import type { ScheduleMCPOutcome } from 'librechat-data-provider';
import type { Types } from 'mongoose';
import type {
  ScheduleEngineDeps,
  ScheduleDeleteResult,
  ScheduleMCPPreflight,
  ScheduleLimits,
  ScheduleUserContext,
  FireableSchedule,
  FireResult,
  JobIdentity,
  JobState,
  ScheduleMCPFailureInput,
  ScheduleMCPSettlementBoundary,
} from './types';
import type { SerializableJobData, ScheduleProviderOwner } from '../stream/interfaces/IJobStore';
import type { AgentCheckpointGeneration } from '../agents/checkpointer';
import type { ScheduleMCPExecution } from './authorization/execution';
import type { BalanceUpdateFields } from '../types/balance';
import type { GetAppConfigOptions } from '../app/service';
import {
  resolveScheduleProjectId,
  DEFAULT_SCHEDULE_LIMITS,
  SCHEDULE_FILE_HOLD,
  hasResumeHandoffInFlight,
  retainedOutcome,
  hasAbortInFlight,
} from './types';
import {
  deleteAgentCheckpoint,
  captureAgentCheckpointGeneration,
  checkpointStorageConfigs,
} from '../agents/checkpointer';
import { isStopConfirmed, PROVIDER_DRAIN_TIMEOUT_MS } from '../stream/interfaces/IJobStore';
import { isShutdownInProgress, getShutdownSignal } from '../app/shutdown';
import { scheduleMCPFailurePriority } from '~/stream/scheduleFailure';
import { fireSchedule, BALANCE_SKIP_DISABLE_THRESHOLD } from './fire';
import { GenerationJobManager } from '../stream/GenerationJobManager';
import { ScheduledMCPPolicyError } from './authorization/policy';
import { buildBalanceUpdateFields } from '../middleware/balance';
import { getAppConfigOptionsFromUser } from '../app/service';
import { OboTokenResolutionError } from '../mcp/oauth/obo';
import { ScheduledMCPBearerError } from '../mcp/errors';
import { startScheduleErasureSweep } from './erasure';
import { getBalanceConfig } from '../app/config';
import { waitUntilDeadline } from '~/mcp/utils';
import { startScheduleEngine } from './engine';
import { withCapacitySlot } from './capacity';
import { isEnabled } from '../utils/common';

/** Recordable terminal/paused run outcome, as accepted by `recordRunOutcome`. */
type ScheduleRunOutcomeStatus = Parameters<ScheduleMethods['recordRunOutcome']>[0]['status'];

/** How a TERMINAL job status projects onto its run row. Mirrors the reconciler's
 *  mapping, so a run settled from a retained job reads the same either way. */
const TERMINAL_JOB_OUTCOMES: Record<string, ScheduleRunOutcomeStatus | undefined> = {
  complete: 'success',
  error: 'error',
  aborted: 'interrupted',
};

/** Reason text recorded when account-deletion quiesce settles a run itself. */
const QUIESCE_SETTLE_ERRORS: Partial<Record<ScheduleRunOutcomeStatus, string>> = {
  interrupted: 'Account deleted while awaiting approval',
  error: 'Run ended in error',
};

/** Short schedule-document fence spanning capacity admission -> approval CAS. */
const SCHEDULE_RESUME_LEASE_MS = 60_000;

/**
 * Whether this process may arm the scheduler at all.
 *
 * v1 is single-process by design, but the standard entrypoint runs
 * `initializeScheduleEngine` in EVERY replica and nothing stops an operator from scaling
 * it. That is only safe when replicas can see each other's generations: a shared stream
 * store (Redis) gives every replica the same job view, so reconciliation and
 * deletion-time aborts reach the run's real owner. With the process-local store a peer
 * sees the globally visible `started` row but no job, and after the orphan cutoff it
 * marks a still-running generation interrupted and frees its capacity slot.
 *
 * A single replica with the in-memory store is perfectly safe, but a process cannot
 * observe its own replica count, so that case needs an explicit operator assertion.
 */
function isTopologySafeToArm(): boolean {
  return GenerationJobManager.isRedis || isEnabled(process.env.SCHEDULES_SINGLE_PROCESS);
}

/** Whether a persisted job still carries a given scheduled occurrence's identity. */
function jobMatchesIdentity(
  job: Pick<SerializableJobData, 'scheduleId' | 'scheduledFor'> & { createdAt?: number },
  identity: JobIdentity,
): boolean {
  if (
    job.scheduleId !== identity.scheduleId ||
    job.scheduledFor == null ||
    (identity.createdAt != null && identity.createdAt !== job.createdAt)
  ) {
    return false;
  }
  return new Date(job.scheduledFor).getTime() === new Date(identity.scheduledFor).getTime();
}

export interface RecordScheduleOutcomeInput {
  scheduleId?: string;
  scheduledFor?: string | Date;
  /** Exact generation whose terminal evidence is being persisted. */
  streamId?: string;
  jobCreatedAt?: number;
  status: ScheduleRunOutcomeStatus;
  conversationId?: string;
  checkpointNamespace?: string;
  /** Erase the row's reserved conversationId (pre-start abort: no conversation exists). */
  clearConversationId?: boolean;
  error?: string;
}

export type ScheduleResumeClaimResult =
  | { capacitySlot: number; claimToken: string; leaseBy: string }
  | { conflict: 'capacity' | 'overlap' | 'not-paused' | 'inactive' };

/**
 * Api-side dependencies the schedules service needs injected: model methods,
 * config/balance access, and the owner-scoped agent access check. Everything
 * else (job store and tenant context) lives in `@librechat/api` and is imported
 * directly.
 */
export interface SchedulesServiceDeps {
  preflightMCP: ScheduleMCPPreflight;
  methods: ScheduleMethods & {
    getRoleByName: (
      role?: string,
    ) => Promise<{ permissions?: Record<string, Record<string, boolean | undefined>> } | null>;
    getFiles: (
      filter: unknown,
      sort: unknown,
      select: unknown,
    ) => Promise<Array<{
      file_id: string;
      filepath: string;
      filename: string;
      type: string;
      height?: number;
      width?: number;
      source: string;
    }> | null>;
    /** Owner-scoped bounded TTL hold (`db.extendFilesTTL`-shaped). */
    extendFilesTTL: (
      fileIds: string[],
      hold: { renewMs: number; maxLifetimeMs: number },
      owner: { user: string; tenantId?: string | null },
    ) => Promise<number>;
  };
  getAppConfig: (options?: GetAppConfigOptions) => Promise<AppConfig | undefined>;
  findUserById: (
    userId: string | Types.ObjectId,
  ) => Promise<{ _id: Types.ObjectId; tenantId?: string; role?: string } | null>;
  /** Reads the balance record together with the credits unexpired in-flight reservations hold. */
  findBalance: (userId: string, options?: { applyReset?: boolean }) => Promise<IBalance | null>;
  /**
   * Upserts a balance record. `setOnInsert` carries fields that must ONLY apply to a
   * document this call creates — chiefly the starting credit — so a record created by a
   * concurrent charge is never overwritten with a fresh balance.
   */
  upsertBalance: (
    userId: string,
    update: { set: Partial<BalanceUpdateFields>; setOnInsert: Partial<BalanceUpdateFields> },
  ) => Promise<IBalance | null>;
  /**
   * Compare-and-set initialization for an EXISTING balance whose `tokenCredits` is still
   * null. Writes the starting credit (and any refill-config sync) only while
   * `{ user, tokenCredits: null }` still matches — never an upsert — so a concurrent
   * initializer/charge that already set credits between the read and this write is not
   * clobbered. Returns the winning document, or `null` when the CAS did not match (the
   * caller re-reads the winner rather than restoring credits).
   */
  initializeNullBalance: (
    userId: string,
    update: { tokenCredits: number; sync: Partial<BalanceUpdateFields> },
  ) => Promise<IBalance | null>;
  resolveAgentFireAccess: (
    agentId: string,
    user: ScheduleUserContext,
  ) => Promise<'ok' | 'missing' | 'forbidden'>;
  /** Loads a chat project scoped to its owner, or null when it does not exist for
   *  them. Chat projects are user-owned, so this is both the existence check and the
   *  authorization check. */
  getChatProject: (userId: string, projectId: string) => Promise<IChatProject | null>;
  /** Positive process-termination proof for this exact provider segment, never a heartbeat timeout.
   * Hosts without proof retain the obligation. This hook must return null for alive/unknown owners. */
  confirmScheduleProviderOwnerLoss?: (
    owner: ScheduleProviderOwner,
  ) => Promise<ScheduleProviderOwner | null>;
  /** Whether this user's account deletion has begun. Fail-closed (unknown == true). */
  isUserDeleting: (userId: string) => Promise<boolean>;
  /** Shared durable trigger admission from the merged agent-trigger service. */
  enqueueAgentTrigger: ScheduleEngineDeps['enqueueTrigger'];
  /** Reads a durable trigger delivery by key from the merged agent-trigger service, for
   *  reconciliation's live-vs-dead delivery check. */
  getTriggerDelivery: ScheduleEngineDeps['getTriggerDelivery'];
}

export interface SchedulesService {
  getLimits: (user?: ScheduleUserContext) => Promise<ScheduleLimits>;
  engineDeps: ScheduleEngineDeps;
  fireScheduleNow: (
    schedule: FireableSchedule,
    limits: ScheduleLimits,
    options?: { signal?: AbortSignal },
  ) => Promise<FireResult | null>;
  recordScheduleOutcome: (input: RecordScheduleOutcomeInput) => Promise<boolean>;
  recordMCPToolAuthFailure: (input: ScheduleMCPFailureInput) => Promise<boolean>;
  getMCPReceiptRetryPolicy: (
    input: ScheduleMCPFailureInput,
  ) => Promise<ScheduleMCPReceiptRetryPolicy | undefined>;
  registerMCPSettlement: (boundary: ScheduleMCPSettlementBoundary) => void;
  /**
   * Stamps a scheduled run's interactive Stop BEFORE the abort is signalled, so the owner
   * settlement barrier, reconciliation, and schedule/account deletion hold off settling or
   * erasing until {@link acknowledgeScheduledStopPersistence}. Serialized: `'in_progress'`
   * means a fresh Stop already owns the stamp and the caller must not signal a second abort;
   * `false` means there is no active run to stop.
   */
  beginScheduledStop: (input: {
    scheduleId: string;
    scheduledFor: string | Date;
  }) => Promise<boolean | 'in_progress'>;
  /**
   * Releases the Stop settlement barrier once the route's partial-message/checkpoint writes
   * have landed. Call ONLY after persistence succeeds — a failed persistence must leave the
   * barrier unresolved so the run stays preserved and recovers via the stale-owner timeout.
   */
  acknowledgeScheduledStopPersistence: (input: {
    scheduleId: string;
    scheduledFor: string | Date;
    /** Optional terminal outcome to re-drive once the barrier clears, so a settlement the
     *  owner deferred past its poll budget still converges where no reconciler is armed. */
    settle?: { status: ScheduleRunOutcomeStatus; conversationId?: string; error?: string };
  }) => Promise<void>;
  /** Re-enters a paused occurrence into the DB-enforced global/same-schedule
   * capacity set before its approval job is allowed to resume. */
  claimScheduleResume: (
    scheduleId: string,
    scheduledFor: string | Date,
    options?: { expectedConfigRevision?: number; automatic?: boolean },
  ) => Promise<ScheduleResumeClaimResult>;
  /** Guarded rollback when the approval CAS did not consume the paused action. */
  releaseScheduleResumeClaim: (
    scheduleId: string,
    scheduledFor: string | Date,
    capacitySlot: number,
  ) => Promise<boolean>;
  /** Atomically validates the live schedule generation after the approval CAS and
   * releases its short-lived document fence. This is the resume linearization point. */
  finalizeScheduleResumeClaim: (
    scheduleId: string,
    claimToken: string,
    leaseBy: string,
    options?: { expectedConfigRevision?: number; automatic?: boolean },
  ) => Promise<boolean>;
  /** Releases only the schedule-document fence after an unconsumed/ambiguous approval CAS. */
  releaseScheduleResumeFence: (scheduleId: string, leaseBy: string) => Promise<void>;
  /**
   * Whether a schedule is still live (exists and not soft-deleted). The loopback
   * chat controller calls this right after creating the generation job to re-fence
   * a fire against a delete/quiesce that landed in the claim -> POST window (when
   * the reservation row exists but the job did not yet, so the deletion's abort
   * missed it) — aborting before any messages are persisted.
   */
  isScheduleLive: (
    scheduleId: string,
    expectedConfigRevision?: number,
    options?: { automatic?: boolean; policy?: boolean; scheduledFor?: string | Date },
  ) => Promise<boolean>;
  /** Soft-deletes an owner's schedule: stop claims, abort active runs, drain, erase. */
  deleteScheduleForOwner: (scheduleId: string, userId: string) => Promise<ScheduleDeleteResult>;
  /**
   * Quiesces all of a user's schedules ahead of account deletion (reversible suspension +
   * abort + drain). `token` identifies this deletion attempt and is what a later
   * {@link restoreUserSchedulesFromDeletion} restores against. Returns whether the drain was
   * CONFIRMED: false means at least one run could not be confirmed settled, and the caller
   * must NOT proceed to destructive deletion — the durable barrier keeps refusing new work
   * while a later pass finishes the cascade.
   */
  quiesceUserSchedules: (userId: string, token: string) => Promise<boolean>;
  /**
   * Reverses a quiesce whose account deletion was cancelled, re-enabling and re-arming only
   * the rows this exact attempt suspended. Safe to call even if quiesce never suspended a
   * row (no matching token → no-op).
   */
  restoreUserSchedulesFromDeletion: (userId: string, token: string) => Promise<void>;
  /** Arms the scheduler for THIS process. v1 is single-process only; the clustered
   *  entrypoint does not start it. Returns undefined when index creation failed, or when
   *  the topology cannot be shown safe (process-local job store with no single-process
   *  assertion) — see isTopologySafeToArm. */
  initializeScheduleEngine: () => Promise<ReturnType<typeof startScheduleEngine> | undefined>;
  /** Starts bounded maintenance for an entrypoint that never arms the engine (the
   *  clustered worker). Idempotent per process and a no-op once the full engine is armed.
   *  Replays terminal permanent-MCP bookkeeping but never claims, fires, advances, or
   *  infers owner death from a process-local missing job. See startScheduleErasureSweep. */
  initializeScheduleErasureSweep: () => void;
  reconcileRetainedJobs: () => Promise<void>;
}

/** A replaced/foreign generation cannot receive an old denial or model-visible result. */
export class ScheduledMCPReceiptFencedError extends Error {
  constructor() {
    super('Scheduled generation is no longer current.');
    this.name = 'AbortError';
  }
}

export interface ScheduleMCPReceiptRetryPolicy {
  baseMs?: number;
  maxMs?: number;
}
const receiptFlights = new WeakMap<
  SchedulesService['recordMCPToolAuthFailure'],
  Map<string, Promise<boolean>>
>();

/** Scheduled authorization failures cannot become model errors before durable admission. */
export function recordScheduledMCPToolAuthFailure(
  input: ScheduleMCPFailureInput,
  getRecorder: () => SchedulesService['recordMCPToolAuthFailure'],
  getRetryPolicy?: () => Promise<ScheduleMCPReceiptRetryPolicy | undefined>,
): Promise<boolean> {
  const bearer =
    input.error instanceof ScheduledMCPBearerError ||
    input.error instanceof ScheduledMCPPolicyError;
  const cause = input.error instanceof Error ? input.error.cause : undefined;
  const missing = input.error instanceof OboTokenResolutionError ? input.error : cause;
  if (
    (!bearer &&
      (!(missing instanceof OboTokenResolutionError) ||
        missing.reason !== 'missing_upstream_provider')) ||
    !input.streamId ||
    input.jobCreatedAt == null ||
    !input.userId ||
    (input.error instanceof ScheduledMCPBearerError && !input.identity)
  ) {
    return bearer ? Promise.reject(new ScheduledMCPReceiptFencedError()) : Promise.resolve(false);
  }
  if (isShutdownInProgress()) return Promise.reject(new ScheduledMCPReceiptFencedError());
  let record: SchedulesService['recordMCPToolAuthFailure'];
  try {
    record = getRecorder();
  } catch (error) {
    return Promise.reject(error);
  }
  const key = JSON.stringify([
    input.streamId,
    input.jobCreatedAt,
    input.userId,
    input.identity,
    input.serverName,
    input.error instanceof ScheduledMCPBearerError || input.error instanceof ScheduledMCPPolicyError
      ? input.error.outcomes
      : 'missing_upstream_provider',
  ]);
  let flights = receiptFlights.get(record);
  if (!flights) {
    flights = new Map();
    receiptFlights.set(record, flights);
  }
  const current = flights.get(key);
  if (current) return current;
  const flight = (async () => {
    let interval = 250;
    let cap = 30_000;
    let configured = false;
    const signal = getShutdownSignal();
    for (;;) {
      if (signal.aborted || isShutdownInProgress()) throw new ScheduledMCPReceiptFencedError();
      try {
        const result = await waitUntilDeadline(record(input), undefined, signal);
        if (!result.settled) throw new ScheduledMCPReceiptFencedError();
        if (result.value) return true;
      } catch (error) {
        if (error instanceof ScheduledMCPReceiptFencedError) throw error;
        if (!bearer) {
          logger.warn('[schedules] could not persist MCP authorization failure receipt:', error);
          return false;
        }
      }
      if (!bearer) return false;
      if (!configured) {
        const loaded = await waitUntilDeadline(
          getRetryPolicy?.().catch(() => undefined) ?? Promise.resolve(undefined),
          undefined,
          signal,
        );
        if (!loaded.settled) throw new ScheduledMCPReceiptFencedError();
        const policy = loaded.value;
        const { baseMs, maxMs } = policy ?? {};
        if (
          typeof baseMs === 'number' &&
          Number.isSafeInteger(baseMs) &&
          baseMs >= 100 &&
          baseMs <= 60_000
        )
          interval = baseMs;
        if (
          typeof maxMs === 'number' &&
          Number.isSafeInteger(maxMs) &&
          maxMs >= 100 &&
          maxMs <= 600_000
        )
          cap = maxMs;
        cap = Math.max(interval, cap);
        configured = true;
      }
      // Equal jitter; no caller cancellation may turn an unrecorded denial into model continuation.
      try {
        await new Promise<void>((resolve, reject) => {
          if (signal.aborted) {
            reject(new ScheduledMCPReceiptFencedError());
            return;
          }
          const finish = () => {
            signal.removeEventListener('abort', abort);
            resolve();
          };
          const timer = setTimeout(finish, Math.ceil(interval * (0.5 + Math.random() * 0.5)));
          const abort = () => {
            clearTimeout(timer);
            signal.removeEventListener('abort', abort);
            reject(new ScheduledMCPReceiptFencedError());
          };
          signal.addEventListener('abort', abort, { once: true });
        });
      } catch {
        throw new ScheduledMCPReceiptFencedError();
      }
      interval = Math.min(cap, interval * 2);
    }
  })().finally(() => {
    flights!.delete(key);
  });
  flights.set(key, flight);
  return flight;
}

/** Captures host scope, never model arguments or mutable runnable config. */
export function createScheduledMCPPolicyRecorder(
  execution: ScheduleMCPExecution | undefined,
  job: { streamId?: string | null; jobCreatedAt?: number; userId?: string; tenantId?: string },
  record: SchedulesService['recordMCPToolAuthFailure'],
): ((error: ScheduledMCPPolicyError) => Promise<boolean>) | undefined {
  if (!execution) return;
  const identity = Object.freeze({ ...execution.identity });
  const scope = Object.freeze({ ...job });
  return (error) => {
    if (scope.userId !== identity.ownerId || (scope.tenantId ?? null) !== identity.tenantId)
      return Promise.reject(new ScheduledMCPReceiptFencedError());
    return record({
      error,
      identity,
      streamId: scope.streamId ?? undefined,
      jobCreatedAt: scope.jobCreatedAt,
      userId: identity.ownerId,
      serverName: error.outcomes[0].server,
    });
  };
}

/** Test-only overrides for the service's bounded waits (drains, barriers). */
export interface ScheduleServiceTimings {
  drainTimeoutMs?: number;
  drainPollMs?: number;
  stopBarrierTimeoutMs?: number;
  stopBarrierPollMs?: number;
}

/**
 * Builds the scheduler service around api-side dependencies. Each call owns its
 * own engine singleton and job-store-shared flag, so state never leaks between
 * instances.
 */
export function createScheduleLimitsResolver(
  getAppConfig: SchedulesServiceDeps['getAppConfig'],
): SchedulesService['getLimits'] {
  /**
   * Resolves schedule limits, honoring per-principal (role/user) config overrides
   * when a user is supplied (routes pass req.user, the fire path passes the owner).
   */
  return async function getLimits(user?: ScheduleUserContext): Promise<ScheduleLimits> {
    // The BASE `interface.schedules: false` is a global stop and must win over any
    // principal override. Without this a tenant/role/user override resolving to
    // enabled would let the sidebar and CRUD handlers admit schedules that
    // isGloballyDisabled() correctly refuses to ever fire.
    // isRuntimeDisabled, NOT `=== false`: the base stop has TWO shapes (`false` and
    // `{ use: false }`), and deepMerge turns a base `{ use: false, ... }` plus a principal
    // override of `true` into `{ use: true, ... }`. A literal-false check missed that, so
    // getLimits reported the feature enabled and Run Now dispatched straight through
    // fireSchedule — bypassing the operator's object-form emergency stop. Same predicate
    // the engine gate (isGloballyDisabled) already uses.
    if (
      user != null &&
      isRuntimeDisabled((await getAppConfig({ baseOnly: true }))?.interfaceConfig?.schedules)
    ) {
      return { ...DEFAULT_SCHEDULE_LIMITS, enabled: false };
    }
    // NO principal means the DEPLOYMENT's config, so it must be read base-only. A bare
    // getAppConfig() still resolves principals and picks up the tenant from the ALS
    // context, and both callers of this form run inside one: fireSchedule clamps the
    // global capacity allocator from within runInTenantContext(owner), and the engine
    // tick budgets from within runAsSystem. Either would otherwise resolve a TENANT
    // override as if it were the deployment-wide value, which is exactly what the
    // global cap exists to prevent an override from widening.
    const appConfig = user
      ? await getAppConfig(getAppConfigOptionsFromUser(user))
      : await getAppConfig({ baseOnly: true });
    // The env kill switch is a GLOBAL stop and must be visible everywhere limits are
    // consulted (write handlers, fire path), not only at the engine tick.
    if (isEnabled(process.env.SCHEDULES_DISABLED)) {
      return { ...DEFAULT_SCHEDULE_LIMITS, enabled: false };
    }
    const config = appConfig?.interfaceConfig?.schedules;
    // EXPERIMENTAL, default-OFF (v1): scheduled chats are disabled unless an admin
    // explicitly enables them. Absence, null, or `false` all resolve to disabled, so a
    // deployment that never opts in never runs the scheduler. `true` uses the defaults;
    // an object opts in unless it sets `use: false`.
    if (config == null || config === false) {
      return { ...DEFAULT_SCHEDULE_LIMITS, enabled: false };
    }
    if (config === true) {
      return DEFAULT_SCHEDULE_LIMITS;
    }
    // A pinned project is itself a requirement: leaving `requireProject` to be set
    // separately would let `projectId` alone resolve to "optional destination that
    // happens to be forced", and a schedule created before the pin would keep firing
    // with no project at all rather than being stopped for review.
    const projectId = config.projectId?.trim() || undefined;
    return {
      enabled: config.use !== false,
      ...(config.mcpConsent && {
        mcpConsent: {
          enabled: config.mcpConsent.enabled === true,
          maxLifetimeHours:
            config.mcpConsent.maxLifetimeHours ?? DEFAULT_SCHEDULE_MCP_CONSENT_LIFETIME_HOURS,
        },
      }),
      maxPerUser: config.maxPerUser ?? DEFAULT_SCHEDULE_LIMITS.maxPerUser,
      minIntervalMinutes: config.minIntervalMinutes ?? DEFAULT_SCHEDULE_LIMITS.minIntervalMinutes,
      autoDisableAfterFailures:
        config.autoDisableAfterFailures ?? DEFAULT_SCHEDULE_LIMITS.autoDisableAfterFailures,
      admissionConcurrency:
        config.admissionConcurrency ?? DEFAULT_SCHEDULE_LIMITS.admissionConcurrency,
      fireConcurrency: config.fireConcurrency ?? DEFAULT_SCHEDULE_LIMITS.fireConcurrency,
      mcpPreflightConcurrency:
        config.mcpPreflightConcurrency ?? DEFAULT_SCHEDULE_LIMITS.mcpPreflightConcurrency,
      mcpPreflightTimeoutMs:
        config.mcpPreflightTimeoutMs ?? DEFAULT_SCHEDULE_LIMITS.mcpPreflightTimeoutMs,
      requireProject: config.requireProject === true || projectId != null,
      ...(projectId != null && { projectId }),
    };
  };
}

export function createSchedulesService(
  deps: SchedulesServiceDeps,
  timings?: ScheduleServiceTimings,
): SchedulesService {
  const { methods } = deps;

  // Recovery evidence only: no authorization or bearer is cached here.
  const pendingBearerFailures = new Map<
    string,
    Parameters<SchedulesService['recordMCPToolAuthFailure']>[0] & {
      admitted: boolean;
      outcomes: ScheduleMCPOutcome[];
    }
  >();
  const mcpBoundaries = new Map<
    string,
    { scheduleId: string; quiesce: () => Promise<void>; flight?: Promise<void> }
  >();
  function registerMCPSettlement(boundary: ScheduleMCPSettlementBoundary): void {
    const key = receiptKey(boundary.streamId, boundary.jobCreatedAt);
    if (mcpBoundaries.get(key)?.flight) throw new ScheduledMCPReceiptFencedError();
    mcpBoundaries.set(key, { scheduleId: boundary.identity.scheduleId, quiesce: boundary.quiesce });
  }
  async function hasScheduleCleanupObligation(scope: {
    scheduleId?: string;
    userId?: string;
  }): Promise<boolean> {
    const store = GenerationJobManager.getJobStore();
    if (!store) return false;
    return !store.hasScheduleCleanupObligation || (await store.hasScheduleCleanupObligation(scope));
  }
  async function eraseSettledSchedule(scheduleId: string): Promise<boolean> {
    for (const pending of pendingBearerFailures.values()) {
      if (pending.identity?.scheduleId === scheduleId) return false;
    }
    if (await hasScheduleCleanupObligation({ scheduleId })) return false;
    return methods.eraseScheduleIfDrained(scheduleId);
  }

  const receiptKey = (stream: string, epoch: number): string => JSON.stringify([stream, epoch]);
  const outcomeKey = (outcome: ScheduleMCPOutcome): string =>
    JSON.stringify([
      outcome.server,
      outcome.agentId,
      outcome.status,
      outcome.reason,
      outcome.recovery,
      outcome.detail,
      outcome.automaticReplay,
    ]);
  const mergeReceipts = mergeScheduleMCPReceipts;
  const preferFailure = (
    previous: ScheduleMCPOutcome | undefined,
    next: ScheduleMCPOutcome,
  ): ScheduleMCPOutcome =>
    scheduleMCPFailurePriority(next) > scheduleMCPFailurePriority(previous)
      ? next
      : (previous ?? next);
  const encodeReceipts = (outcomes: ScheduleMCPOutcome[]): string =>
    `${getScheduleMCPDisabledReason(outcomes) ?? 'mcp_unavailable'}: ${JSON.stringify(outcomes)}`;

  // Fail LOUDLY at construction, not per-fire. The JS adapter (api/server/services/
  // Schedules) is not typechecked against SchedulesServiceDeps, so a missing dep would
  // otherwise surface only as a `deps.X is not a function` deep inside a live fire —
  // which is exactly how the deletion-barrier probe shipped unwired twice.
  const REQUIRED_DEPS: Array<keyof SchedulesServiceDeps> = [
    'methods',
    'getAppConfig',
    'findUserById',
    'findBalance',
    'upsertBalance',
    'initializeNullBalance',
    'resolveAgentFireAccess',
    'getChatProject',
    'isUserDeleting',
    'enqueueAgentTrigger',
    'getTriggerDelivery',
  ];
  for (const key of REQUIRED_DEPS) {
    if (deps[key] == null) {
      throw new Error(`createSchedulesService: missing required dependency "${key}"`);
    }
  }

  const getLimits = createScheduleLimitsResolver(deps.getAppConfig);
  const MANUAL_RUN_LEASE_MS = 5 * 60 * 1000;
  // Bounded wait for aborted scheduled runs to settle during account-deletion quiesce,
  // before the message/conversation cascade runs. Long enough to cover a generation that
  // already returned from the model finishing its persistence; capped so account deletion
  // never blocks indefinitely on an unreachable peer-worker run.
  const QUIESCE_DRAIN_TIMEOUT_MS = timings?.drainTimeoutMs ?? 10 * 1000;
  const QUIESCE_DRAIN_POLL_MS = timings?.drainPollMs ?? 250;
  // The owner's terminal settlement waits (briefly, bounded) for an interactive Stop to
  // acknowledge its partial-message/checkpoint persistence before releasing capacity or
  // erasing evidence. Short: the Stop route's persistence is a couple of writes; if it
  // does not land in this window the stale-owner timeout (ABORT_OWNER_PRESUMED_ALIVE_MS)
  // takes over as the bounded recovery, so the settlement never blocks indefinitely.
  const STOP_BARRIER_TIMEOUT_MS = timings?.stopBarrierTimeoutMs ?? 5 * 1000;
  const STOP_BARRIER_POLL_MS = timings?.stopBarrierPollMs ?? 100;

  /**
   * Whether a refill would top up this zero-credit balance record right now,
   * mirroring the chat balance check's auto-refill eligibility (record-based).
   */
  function isRefillEligible(record: IBalance | null | undefined): boolean {
    return record != null && isBalanceRefillDue(record, new Date());
  }

  const engineDeps: ScheduleEngineDeps = {
    reconcileRetainedJobs,
    eraseSettledSchedule,
    preflightMCP: deps.preflightMCP,
    methods,
    getLimits,
    // On the BASE deps, not only the engine's per-pass wrapper: fireScheduleNow
    // (manual Run Now) dispatches with these deps directly, and its POST must be
    // gated by the same coordinator signal as the engine tick's.
    isShuttingDown: isShutdownInProgress,
    getUserContext: async (userId) => {
      const user = await deps.findUserById(userId);
      if (user == null) {
        return null;
      }
      return { id: user._id.toString(), tenantId: user.tenantId, role: user.role };
    },
    hasScheduleAccess: async (user) => {
      const role = await methods.getRoleByName(user.role);
      return role?.permissions?.[PermissionTypes.SCHEDULES]?.[Permissions.USE] === true;
    },
    isOutOfBalance: async (user) => {
      const appConfig = await deps.getAppConfig(getAppConfigOptionsFromUser(user));
      const balanceConfig = getBalanceConfig(appConfig);
      if (balanceConfig?.enabled !== true) {
        return false;
      }
      let record = await deps.findBalance(user.id, { applyReset: false });
      // Credits in-flight requests hold are unavailable to this fire as well: the chat
      // balance check admits against the unreserved amount. Taken from this read because
      // the initialization/sync writes below return the record without the total.
      let reservedCredits = record?.reservedCredits ?? 0;
      // Initialize/sync the record exactly as the chat's balance middleware would,
      // so a new user's startBalance is applied before we read it (avoids skipping
      // a schedule that an interactive chat would have allowed).
      if (balanceConfig.startBalance != null) {
        const updateFields = buildBalanceUpdateFields(balanceConfig, record, user.id);
        if (Object.keys(updateFields).length > 0) {
          // The read above and every write below are separate statements, and the credit
          // field is an INITIALIZATION value: a concurrent charge that set-and-spent the
          // record in between must never be handed back its starting balance. Each case
          // fences the credit write so it can only create, never restore, credits. The
          // refill-config fields are a genuine sync and never carry a credit.
          const { user: initUser, tokenCredits, ...syncFields } = updateFields;
          if (record == null) {
            // ABSENT record: upsert. The credit rides `$setOnInsert` so a document created
            // by a concurrent charge keeps its charged balance; the refill-config sync is
            // a legitimate `$set`.
            record = await deps.upsertBalance(user.id, {
              set: syncFields,
              setOnInsert: {
                ...(initUser != null ? { user: initUser } : {}),
                ...(tokenCredits != null ? { tokenCredits } : {}),
              },
            });
          } else if (tokenCredits != null) {
            // EXISTING record with a null credit: a blind `$set` would restore credits a
            // concurrent initializer/charge already set and spent between the read and
            // here. Initialize under a `{ tokenCredits: null }` CAS; on a miss re-read the
            // winner's balance instead of overwriting it.
            const initialized = await deps.initializeNullBalance(user.id, {
              tokenCredits,
              sync: syncFields,
            });
            record =
              initialized ?? (await deps.findBalance(user.id, { applyReset: false })) ?? record;
          } else if (Object.keys(syncFields).length > 0) {
            // EXISTING record with a real credit: only refill-config sync remains, which
            // never touches `tokenCredits` and is safe to `$set` directly.
            record = await deps.upsertBalance(user.id, { set: syncFields, setOnInsert: {} });
          }
        }
      }
      if (
        balanceConfig.autoRefillEnabled === true &&
        record?.refillMode === 'reset' &&
        isBalanceRefillDue(record, new Date())
      ) {
        record = await deps.findBalance(user.id, { applyReset: true });
        reservedCredits = record?.reservedCredits ?? 0;
      }
      const credits = (record?.tokenCredits ?? 0) - reservedCredits;
      if (credits > 0) {
        return false;
      }
      // At/below zero: an auto-refill user is only spared a pre-skip when a refill
      // would actually fire now (mirrors the chat balance check's eligibility). If
      // they aren't eligible yet, or the refill settings are incomplete, pre-skip as
      // a balance skip — otherwise the zero-credit fire reaches the chat, is rejected
      // there, and records a generic error that walks the schedule toward
      // too_many_failures instead of skipped_balance/insufficient_balance.
      if (balanceConfig.autoRefillEnabled === true && isRefillEligible(record)) {
        return false;
      }
      return true;
    },
    // Mirrors the loopback chat route's authorization (role AGENTS:USE + resource
    // VIEW with the manage:agents bypass); shared with the create/update precheck
    // so the two never diverge.
    agentAccess: (agentId, user) => deps.resolveAgentFireAccess(agentId, user),
    // Ownership IS existence for a chat project, so one lookup answers both. Failing
    // closed here would auto-disable a schedule on a transient Mongo blip, so a read
    // error propagates instead: the fire fails and is retried like any other error.
    projectAccess: async (projectId, user) =>
      (await deps.getChatProject(user.id, projectId)) == null ? 'missing' : 'ok',
    resolveFiles: async (fileIds, user) => {
      // Renew the bounded upload hold at every fire preflight, BEST-EFFORT: the hold
      // only has to bridge upload -> first consumption (a real send clears the TTL
      // permanently), and a failed renewal must not fail the fire — at worst the hold
      // lapses later and resolveFiles drops the reaped file (droppedFileIds records it).
      await methods
        .extendFilesTTL(fileIds, SCHEDULE_FILE_HOLD, { user: user.id, tenantId: user.tenantId })
        .catch((err) => logger.warn('[schedules] attachment hold renewal failed:', err));
      const files = await methods.getFiles(
        { file_id: { $in: fileIds }, user: user.id },
        null,
        '-text',
      );
      return (files ?? []).map((file) => ({
        file_id: file.file_id,
        filepath: file.filepath,
        filename: file.filename,
        type: file.type,
        height: file.height,
        width: file.width,
        source: file.source,
      }));
    },
    enqueueTrigger: deps.enqueueAgentTrigger,
    getTriggerDelivery: deps.getTriggerDelivery,
    runInTenantContext: (user, fn) =>
      tenantStorage.run({ tenantId: user.tenantId, userId: user.id }, fn),
    getJobStatus: async (conversationId) => {
      const job = await GenerationJobManager.getJobStore()?.getJob(conversationId);
      if (job == null) {
        return null;
      }
      const pending = pendingBearerFailures.get(receiptKey(conversationId, job.createdAt));
      const retained =
        pending?.identity &&
        job.scheduleId === pending.identity.scheduleId &&
        job.userId === pending.identity.ownerId &&
        (job.tenantId ?? null) === pending.identity.tenantId
          ? pending.outcomes.reduce(preferFailure, job.scheduleMCPFailure ?? pending.outcomes[0])
          : job.scheduleMCPFailure;
      return {
        status: job.status,
        createdAt: job.createdAt,
        checkpointNamespace: job.checkpointNamespace,
        scheduleId: job.scheduleId,
        scheduledFor: job.scheduledFor,
        createdEventEmitted: job.createdEventEmitted === true,
        providerDrained: job.providerDrained,
        terminalPersistencePending: job.terminalPersistencePending,
        terminalHostActionPending: job.terminalHostActionPending,
        preserveForScheduleReconcile: job.preserveForScheduleReconcile === true,
        ...(job.scheduleOutcome != null && { scheduleOutcome: job.scheduleOutcome }),
        ...(job.scheduleOutcomeError != null && {
          scheduleOutcomeError: job.scheduleOutcomeError,
        }),
        ...(retained && { scheduleMCPFailure: retained }),
      };
    },
    abortScheduledJob: async (conversationId, identity, options) => {
      const store = GenerationJobManager.getJobStore();
      if (store == null) {
        return false;
      }
      const job = await store.getJob(conversationId);
      // A null/identity-mismatched job is NOT reachable from this replica: it may be
      // a live generation on a peer worker's private in-memory store (unshared
      // topology). Report false so the caller knows the abort was NOT delivered.
      if (job == null || !jobMatchesIdentity(job, identity)) {
        return false;
      }
      {
        const retained = projectScheduleMCPReceipt(
          { status: 'interrupted', error: 'Schedule deleted' },
          readScheduleMCPReceipts(job.scheduleOutcomeError),
        );
        await GenerationJobManager.updateMetadata(
          conversationId,
          {
            preserveForScheduleReconcile: true,
            scheduleOutcome: retained.status,
            scheduleOutcomeError: retained.error,
          },
          job.createdAt,
        );
      }

      // #14925's provider-drain contract is the authority here. It covers both
      // locally owned and cross-replica generations and does not return until the
      // exact provider segment can no longer persist user data. Calling abortJob on
      // an already-terminal job is intentional: awaitProviderDrain still waits for
      // trailing owner work even though no new abort transition is needed.
      const aborted = await GenerationJobManager.abortJob(conversationId, {
        expectedCreatedAt: job.createdAt,
        awaitProviderDrain: true,
      });
      // Terminal-and-drained counts as delivered (see above); a replacement, a still-live
      // run, or a job that vanished before the transition does not.
      if (!isStopConfirmed(aborted)) {
        return false;
      }
      // Read again after the exact provider/pause drain; evidence may have arrived during it.
      const current = await store.getJob(conversationId);
      if (
        current?.createdAt !== job.createdAt ||
        !jobMatchesIdentity(current, identity) ||
        current.providerDrained === false ||
        current.terminalPersistencePending === true ||
        current.terminalHostActionPending === true
      )
        return false;
      if (
        readScheduleMCPReceipts(current.scheduleOutcomeError).length > 0 ||
        pendingBearerFailures.has(receiptKey(conversationId, job.createdAt))
      ) {
        const settled = await recordScheduleOutcome({
          scheduleId: job.scheduleId!,
          scheduledFor: job.scheduledFor!,
          streamId: conversationId,
          jobCreatedAt: job.createdAt,
          conversationId: job.conversationId,
          status: 'interrupted',
          error: 'Schedule deleted while the run was active',
        });
        if (!settled) return false;
      }
      if (options?.preserve === false)
        await engineDeps.clearReconciledJob(conversationId, {
          ...identity,
          createdAt: job.createdAt,
        });
      return true;
    },
    clearReconciledJob: async (conversationId, identity) => {
      const store = GenerationJobManager.getJobStore();
      if (store == null) {
        return;
      }
      const job = await store.getJob(conversationId);
      // Only delete when the job still carries THIS run's identity, so a
      // replacement generation occupying the same conversationId is never destroyed.
      if (job == null || !jobMatchesIdentity(job, identity)) {
        return;
      }
      if (
        job.providerDrained === false ||
        job.terminalPersistencePending === true ||
        job.terminalHostActionPending === true ||
        job.status === 'running' ||
        job.status === 'requires_action'
      )
        return;
      if (job.preserveForScheduleReconcile === true)
        await GenerationJobManager.updateMetadata(
          conversationId,
          { preserveForScheduleReconcile: false },
          job.createdAt,
        );
      // CAS, not read-then-delete: the identity check above is a READ, and a replacement
      // generation can land between it and the delete. Passing the observed createdAt
      // makes the delete conditional on the job still being that exact generation, so
      // the store itself rejects the write if one did.
      await store.deleteJob(conversationId, job.createdAt);
    },
    // Counted in system scope so the cap is GLOBAL — a per-owner (tenant-scoped)
    // count would let multiple tenants collectively exceed fireConcurrency.
    countActiveRunsGlobal: () => runAsSystem(() => methods.countActiveRuns()),
    isOwnerDeleting: (userId) => deps.isUserDeleting(userId),
    isGloballyDisabled: async () => {
      // Env first: an incident lever that must work even if the DB/config plane is the
      // thing failing (a kill switch that needs a healthy DB is the one that fails when
      // you need it).
      if (isEnabled(process.env.SCHEDULES_DISABLED)) {
        return true;
      }
      // BASE config only: DB principal overrides can narrow availability but must never
      // widen past an operator's global stop, so `schedules: false` in librechat.yaml is
      // genuinely non-overridable rather than emergent from the override filters.
      // isRuntimeDisabled reads BOTH stop shapes (`false` and `{ use: false }`) — the
      // same predicate the override merge preserves base stops with. A shape-blind
      // check here made the object form disable getLimits but not this gate, so the
      // engine kept claiming and fireSchedule ADVANCED each occurrence: a short
      // maintenance stop silently dropped every occurrence it covered instead of
      // leaving them due.
      const base = await deps.getAppConfig({ baseOnly: true });
      return isRuntimeDisabled(base?.interfaceConfig?.schedules);
    },
    // Occupancy is read in SYSTEM scope so the cap is global across tenants (the
    // owner's tenant context would only see its own runs); the claim itself stays in
    // the caller's context so the inserted row keeps correct tenant ownership.
    withGlobalCapacitySlot: (cap, claim) =>
      withCapacitySlot(cap, () => runAsSystem(() => methods.getCapacityOccupancy()), claim),
  };

  let engine: ReturnType<typeof startScheduleEngine> | undefined;
  let erasureSweep: ReturnType<typeof startScheduleErasureSweep> | undefined;

  /**
   * Fallback cleanup for a process whose engine refused to arm (unsafe topology, or
   * index creation failed): DELETE stays open on this entrypoint, so soft-deleted rows
   * still accrue — and with no reconciler, an owner-death case (account deletion begun
   * elsewhere, or a failed one-shot erase) would retain the hidden prompt forever.
   * The engine's own reconcile pass covers this when armed, so never run both.
   */
  function startErasureFallback(): void {
    if (erasureSweep != null || engine != null) {
      return;
    }
    erasureSweep = startScheduleErasureSweep({
      methods,
      getJobStatus: engineDeps.getJobStatus,
      // Positive-evidence delivery convergence: a dead delivery settles its reservation
      // and frees the global capacity slot even where no engine is armed.
      getTriggerDelivery: engineDeps.getTriggerDelivery,
      // Releases a run's retained terminal job once its outcome is durable, so preserved
      // evidence (kept without `completedAt`, and therefore invisible to the store's
      // finished-job sweep) cannot outlive the run it belonged to.
      clearReconciledJob: engineDeps.clearReconciledJob,
      abortScheduledJob: engineDeps.abortScheduledJob,
      reconcileRetainedJobs,
      eraseSettledSchedule,
      // If topology itself prevented arming, this process's missing job says
      // nothing about peer liveness. If only index creation failed, the topology
      // proof still holds and the existing owner-death backstop remains valid.
      canInferOwnerDeathFromMissingJob: isTopologySafeToArm(),
    });
  }

  async function initializeScheduleEngine(): Promise<
    ReturnType<typeof startScheduleEngine> | undefined
  > {
    if (engine != null) {
      return engine;
    }
    // Always arm. The engine owns BOTH firing and reconciliation, and reconciliation must
    // run even while firing is stopped: a previous process can leave `started` rows and
    // preserved terminal jobs that would otherwise never settle until scheduling is
    // re-enabled. Firing is gated separately — runTick refuses to claim while globally
    // disabled, and getLimits reports disabled to the write handlers and the fire path —
    // so "off" still means nothing fires, without stranding prior state.
    // Deliberately not gated on the base config either: schedules can be enabled for a
    // role/user/tenant while the base YAML stays default-off.
    // Explicitly build the Schedule/ScheduleRun indexes first — the unique
    // idempotency index and TTL retention index would otherwise never exist when
    // MONGO_AUTO_INDEX is disabled (the production default). If this fails the
    // unique {scheduleId, scheduledFor} guard may be absent, so leave the engine
    // DISABLED rather than firing without duplicate protection — the app still
    // runs; schedules simply don't fire until an operator resolves the index.
    if (!isTopologySafeToArm()) {
      logger.error(
        "[schedules] scheduler NOT started: this process cannot see other replicas' generations. " +
          'The job store is process-local (Redis is off), but nothing here proves this is the only ' +
          'replica — and the standard server arms the scheduler in EVERY replica. A peer would ' +
          'reconcile runs whose jobs it cannot see, eventually marking a still-running generation ' +
          'interrupted and releasing its capacity, and deletions routed elsewhere could not abort ' +
          'the generation at all. Enable a shared stream store (USE_REDIS_STREAMS), or set ' +
          'SCHEDULES_SINGLE_PROCESS=true to assert this deployment runs exactly one replica. ' +
          'Schedule writes are refused (503) until then.',
      );
      startErasureFallback();
      return undefined;
    }
    try {
      await runAsSystem(() => methods.ensureScheduleIndexes());
    } catch (err) {
      logger.error(
        '[schedules] index creation failed — scheduler NOT started (fires need the unique idempotency index):',
        err,
      );
      startErasureFallback();
      return undefined;
    }
    engine = startScheduleEngine(engineDeps);
    if (erasureSweep != null) {
      // A later successful arm supersedes the fallback: the engine's reconcile pass
      // owns erasure from here.
      erasureSweep.stop();
      erasureSweep = undefined;
    }
    return engine;
  }

  /**
   * The clustered entrypoint's ONLY schedule maintenance. The fallback erases soft-deleted
   * rows and converges terminal evidence, including permanent MCP bookkeeping interrupted
   * between the run-row transition and card projection. It shares startErasureFallback's
   * idempotent startup guard and topology-fenced owner-death policy, and never fires work.
   */
  function initializeScheduleErasureSweep(): void {
    startErasureFallback();
  }

  /**
   * Manual run-now fire. Acquires the schedule lease to serialize concurrent
   * run-now clicks (and to block against a background engine claim), then fires
   * in manual mode so the next automatic occurrence is left untouched. Returns
   * null when the lease is already held (a run is in progress).
   */
  async function fireScheduleNow(
    schedule: FireableSchedule,
    limits: ScheduleLimits,
    options?: { signal?: AbortSignal },
  ): Promise<FireResult | null> {
    // The global stop means STOP: a manual run dispatches the same billed generation as
    // an automatic one, so gating only the engine tick would leave Run Now wide open.
    if (await engineDeps.isGloballyDisabled()) {
      return { fired: false, skipped: 'disabled' as const };
    }
    const leased = await methods.acquireManualRunLease(
      schedule.id,
      schedule.user,
      MANUAL_RUN_LEASE_MS,
    );
    if (leased == null) {
      return null;
    }
    const claimToken = leased.claimToken;
    try {
      // Fire the FRESH leased row (post-image with the new claim token), not the
      // snapshot the route read before the lease — an edit that committed in the
      // window in between is reflected, so a stale prompt/agent is never dispatched.
      return await fireSchedule(engineDeps, leased, limits, new Date(), {
        manual: true,
        signal: options?.signal,
      });
    } catch (err) {
      const released =
        claimToken != null
          ? await methods.releaseLease(schedule.id, claimToken).catch(() => false)
          : false;
      if (!released && leased.leaseBy != null) {
        // An owner edit during the failed preflight rotates the token while preserving
        // this unique holder. Clear only that holder; a takeover has a different value
        // and is therefore never stripped by this exception safety net.
        await methods.releaseLeaseByHolder(schedule.id, leased.leaseBy).catch(() => undefined);
      }
      throw err;
    }
  }

  async function recordMCPToolAuthFailure(
    input: Parameters<SchedulesService['recordMCPToolAuthFailure']>[0],
  ): Promise<boolean> {
    const { error, streamId, jobCreatedAt, userId, serverName, identity } = input;
    const cause = error instanceof Error ? error.cause : undefined;
    const missing = error instanceof OboTokenResolutionError ? error : cause;
    const bearer =
      error instanceof ScheduledMCPBearerError || error instanceof ScheduledMCPPolicyError;
    if (
      (!bearer &&
        (!(missing instanceof OboTokenResolutionError) ||
          missing.reason !== 'missing_upstream_provider')) ||
      !streamId ||
      jobCreatedAt == null ||
      !userId
    )
      return false;
    const key = receiptKey(streamId, jobCreatedAt);
    if (bearer && identity && identity.ownerId === userId) {
      const previous = pendingBearerFailures.get(key);
      const priority = (value: unknown): number =>
        value instanceof ScheduledMCPBearerError || value instanceof ScheduledMCPPolicyError
          ? {
              mcp_unavailable: 1,
              mcp_reauth_required: 2,
              mcp_configuration_missing: 3,
              mcp_permission_denied: 4,
            }[value.code]
          : 0;
      const incoming = error.outcomes;
      const outcomes = mergeReceipts(previous?.outcomes ?? [], incoming);
      const admitted = previous?.admitted === true && outcomes.length === previous.outcomes.length;
      const retained = previous && priority(previous.error) > priority(error) ? previous : input;
      pendingBearerFailures.set(key, {
        ...retained,
        identity: Object.freeze({ ...identity }),
        admitted,
        outcomes,
      });
    }
    const store = GenerationJobManager.getJobStore();
    const job = await store?.getJob(streamId);
    if (
      job?.createdAt !== jobCreatedAt ||
      job.userId !== userId ||
      !job.scheduleId ||
      !job.scheduledFor ||
      !job.conversationId ||
      (error instanceof ScheduledMCPBearerError && !identity) ||
      (identity != null &&
        (identity.ownerId !== job.userId ||
          identity.scheduleId !== job.scheduleId ||
          identity.tenantId !== (job.tenantId ?? null) ||
          ((error instanceof ScheduledMCPBearerError || job.agent_id != null) &&
            identity.agentId !== job.agent_id)))
    ) {
      pendingBearerFailures.delete(key);
      if (bearer) throw new ScheduledMCPReceiptFencedError();
      return false;
    }
    if (error instanceof ScheduledMCPPolicyError && !pendingBearerFailures.has(key)) {
      pendingBearerFailures.set(key, {
        ...input,
        identity: identity ?? {
          scheduleId: job.scheduleId,
          ownerId: job.userId,
          tenantId: job.tenantId ?? null,
          agentId: job.agent_id ?? '',
          invocationMode: 'delegated',
        },
        admitted: false,
        outcomes: error.outcomes,
      });
    }
    const payload = {
      scheduleId: job.scheduleId,
      scheduledFor: new Date(job.scheduledFor),
      conversationId: job.conversationId,
      ...(job.tenantId && { tenantId: job.tenantId }),
      server: serverName,
    };
    if (!bearer) return methods.recordMCPToolAuthFailure(payload);
    const pendingReceipt = pendingBearerFailures.get(key);
    if (pendingReceipt?.admitted) return true;
    const pendingError = pendingReceipt?.error;
    const receiptError =
      pendingError instanceof ScheduledMCPBearerError ||
      pendingError instanceof ScheduledMCPPolicyError
        ? pendingError
        : error;
    const admittedOutcomes = mergeReceipts(
      pendingReceipt?.outcomes ?? receiptError.outcomes,
      error.outcomes,
    );
    const outcomes = mergeReceipts(
      readScheduleMCPOutcomes(job.scheduleOutcomeError),
      admittedOutcomes,
    );
    const encoded = encodeReceipts(outcomes);
    const writes = await Promise.allSettled([
      methods.recordMCPToolAuthFailure({
        ...payload,
        outcomes: admittedOutcomes,
        ...(error instanceof ScheduledMCPPolicyError && { outcome: receiptError.outcomes[0] }),
      }),
      GenerationJobManager.updateMetadata(
        streamId,
        {
          preserveForScheduleReconcile: true,
          scheduleOutcome: 'error',
          scheduleOutcomeError: encoded,
          scheduleMCPFailure: admittedOutcomes.reduce(
            (previous, next) =>
              scheduleMCPFailurePriority(next) > scheduleMCPFailurePriority(previous)
                ? next
                : previous,
            job.scheduleMCPFailure ?? admittedOutcomes[0],
          ),
        },
        jobCreatedAt,
      ),
    ]);
    const latest = await store?.getJob(streamId).catch(() => null);
    const retained =
      latest?.createdAt === jobCreatedAt &&
      latest.scheduleId === job.scheduleId &&
      latest.userId === userId &&
      latest.scheduledFor === job.scheduledFor &&
      readScheduleMCPOutcomes(latest.scheduleOutcomeError).some(
        (item) => outcomeKey(item) === outcomeKey(receiptError.outcomes[0]),
      );
    if (
      (writes[0].status === 'fulfilled' && writes[0].value) ||
      (store?.durableScheduleReceipts === true && writes[1].status === 'fulfilled' && retained)
    ) {
      const current = pendingBearerFailures.get(key);
      if (current)
        current.admitted =
          mergeReceipts(admittedOutcomes, current.outcomes).length === admittedOutcomes.length;
      return true;
    }
    return false;
  }

  async function getMCPReceiptRetryPolicy(
    input: ScheduleMCPFailureInput,
  ): Promise<ScheduleMCPReceiptRetryPolicy | undefined> {
    if (!input.identity || input.userId !== input.identity.ownerId) return;
    const owner = await engineDeps.getUserContext(input.identity.ownerId);
    if (!owner || (owner.tenantId ?? null) !== input.identity.tenantId) return;
    return engineDeps.runInTenantContext(owner, async () => {
      const config = await deps.getAppConfig(getAppConfigOptionsFromUser(owner));
      const schedules = config?.interfaceConfig?.schedules;
      return typeof schedules === 'object' ? schedules.mcpReceiptRetry : undefined;
    });
  }

  /** The job outbox survives both owner death and a crash after Mongo bookkeeping. */
  async function reconcileRetainedJobs(): Promise<void> {
    const store = GenerationJobManager.getJobStore();
    if (!store?.getScheduleReconcileJobs) return;
    for (const held of await store.getScheduleReconcileJobs(100)) {
      let job = held;
      if (job.terminalPersistencePending === true) {
        try {
          // The manager owns the bounded, epoch-fenced stale final-write recovery.
          await GenerationJobManager.getCleanupJob(job.streamId);
          const current = await store.getJob(job.streamId);
          if (current?.createdAt !== held.createdAt) continue;
          job = current;
        } catch (error) {
          logger.warn('[schedules] retained terminal recovery deferred:', error);
          continue;
        }
      }
      if (
        job.status === 'error' &&
        job.error === 'Scheduled generation owner became unavailable' &&
        job.providerDrained === false &&
        job.providerExecutionId &&
        job.scheduleId &&
        job.scheduledFor &&
        deps.confirmScheduleProviderOwnerLoss &&
        store.recoverScheduleProviderOwnerLoss
      ) {
        const owner: ScheduleProviderOwner = {
          streamId: job.streamId,
          createdAt: job.createdAt,
          providerExecutionId: job.providerExecutionId,
          scheduleId: job.scheduleId,
          scheduledFor: job.scheduledFor,
          userId: job.userId,
          tenantId: job.tenantId ?? null,
          lastActiveAt: job.lastActiveAt ?? job.createdAt,
        };
        try {
          const observed = await waitUntilDeadline(
            deps.confirmScheduleProviderOwnerLoss(Object.freeze(owner)),
            Date.now() + PROVIDER_DRAIN_TIMEOUT_MS,
          );
          const proof = observed.settled ? observed.value : null;
          if (
            proof &&
            Object.keys(owner).every(
              (key) =>
                owner[key as keyof ScheduleProviderOwner] ===
                proof[key as keyof ScheduleProviderOwner],
            ) &&
            (await store.recoverScheduleProviderOwnerLoss(owner))
          ) {
            const current = await store.getJob(job.streamId);
            if (!current || current.createdAt !== owner.createdAt) continue;
            job = current;
          }
        } catch {
          continue;
        }
      }
      if (
        !job.scheduleId ||
        !job.scheduledFor ||
        job.status === 'running' ||
        job.status === 'requires_action' ||
        job.providerDrained === false ||
        job.terminalPersistencePending === true ||
        job.terminalHostActionPending === true
      )
        continue;
      const intended =
        job.status === 'aborted'
          ? { status: 'interrupted' as const, error: undefined }
          : retainedOutcome(job, job.status === 'complete' ? 'success' : 'error');
      try {
        await recordScheduleOutcome({
          scheduleId: job.scheduleId,
          scheduledFor: job.scheduledFor,
          streamId: job.streamId,
          jobCreatedAt: job.createdAt,
          conversationId: job.conversationId,
          status: intended.status,
          error: intended.error,
        });
      } catch (error) {
        logger.warn('[schedules] retained outcome recovery deferred:', error);
      }
    }
  }

  const OUTCOME_RETRY_ATTEMPTS = 3;

  /**
   * Completion hook: called from the agents controller finalize paths when the
   * request carried a scheduleId. The caller deletes the job (`completeJob`) right
   * after, destroying the only evidence the reconciler could use — so a transient
   * Mongo failure here is RETRIED (bounded) before giving up, and the failure is
   * surfaced to the caller (returns false) so it can keep the job when it matters.
   */
  /**
   * OWNER-SIDE Stop barrier. An interactive Stop stamps `abortSource: 'stop'` before it
   * signals the abort, and only acknowledges (`abortPersistedAt`) once its partial-message
   * and checkpoint writes have landed. A terminal settlement here in between would release
   * the run's capacity — and let a concurrent schedule/account deletion erase the data —
   * while that write is still in flight. Wait (bounded) for the acknowledgement. A resolved
   * marker, a non-stop source, or a stamp gone stale (its route presumed dead) proceeds
   * immediately, so the stale-owner timeout remains the bounded recovery path.
   */
  async function waitForStopPersistence(
    scheduleId: string,
    scheduledFor: Date,
    initialState?: Awaited<ReturnType<ScheduleMethods['getScheduleRunAbortState']>>,
  ): Promise<ScheduleMCPOutcome[] | null> {
    let observed = initialState;
    const deadline = Date.now() + STOP_BARRIER_TIMEOUT_MS;
    for (;;) {
      const state =
        observed !== undefined
          ? observed
          : await methods.getScheduleRunAbortState(scheduleId, scheduledFor);
      observed = undefined;
      if (
        state == null ||
        state.abortSource !== 'stop' ||
        state.abortPersistedAt != null ||
        !hasAbortInFlight(state, Date.now())
      ) {
        // Cleared to settle: no Stop owns the run, it acknowledged, or its owner is past
        // the stale cutoff and is presumed dead (the bounded recovery path).
        return state?.mcp?.filter(isScheduleMCPAuthorizationFailure) ?? [];
      }
      if (Date.now() >= deadline) {
        // Still an UNACKNOWLEDGED, FRESH Stop. The poll budget expiring proves nothing about
        // the route's writes — slow checkpoint cleanup looks exactly like this — so treating
        // the barrier as satisfied would terminalize the run and release its capacity (and
        // its deletion/erasure barriers) while beforePublish may still be writing. DEFER
        // instead: the acknowledgement settles it, or the stale-owner cutoff authorizes a
        // later attempt.
        return null;
      }
      await new Promise((resolve) => setTimeout(resolve, STOP_BARRIER_POLL_MS));
    }
  }

  async function recordScheduleOutcome({
    scheduleId,
    scheduledFor,
    streamId,
    jobCreatedAt,
    status,
    conversationId,
    checkpointNamespace,
    clearConversationId,
    error,
  }: RecordScheduleOutcomeInput): Promise<boolean> {
    if (!scheduleId || !scheduledFor) {
      return true;
    }
    const boundaryKey =
      streamId && jobCreatedAt != null ? receiptKey(streamId, jobCreatedAt) : undefined;
    const boundary = boundaryKey && mcpBoundaries.get(boundaryKey);
    if (boundary && boundary.scheduleId === scheduleId) {
      try {
        boundary.flight ??= boundary.quiesce();
        await boundary.flight;
        if (mcpBoundaries.get(boundaryKey!) === boundary) mcpBoundaries.delete(boundaryKey!);
      } catch {
        return false;
      }
    }
    let terminal = status !== 'requires_action';
    let mcp: ScheduleMCPOutcome[] = [];
    const receipt =
      streamId && jobCreatedAt != null ? receiptKey(streamId, jobCreatedAt) : undefined;
    const pending = receipt && pendingBearerFailures.get(receipt);
    let retiredPolicyGeneration = false;
    if (pending && pending.identity?.scheduleId === scheduleId) {
      if (!pending.admitted) {
        try {
          const current = await GenerationJobManager.getJobStore()?.getJob(streamId!);
          retiredPolicyGeneration =
            pending.error instanceof ScheduledMCPPolicyError &&
            terminal &&
            current != null &&
            current.createdAt > jobCreatedAt! &&
            current.userId === pending.identity.ownerId &&
            (current.tenantId ?? null) === pending.identity.tenantId;
          if (retiredPolicyGeneration) {
            // A trusted denial may outlive its worker epoch; persist it only to the
            // old occurrence, never to the successor's generation metadata.
            if (
              !(await methods.recordMCPToolAuthFailure({
                scheduleId,
                scheduledFor: new Date(scheduledFor),
                conversationId: streamId!,
                ...(pending.identity.tenantId && { tenantId: pending.identity.tenantId }),
                server: pending.serverName,
                outcomes: pending.outcomes,
              }))
            )
              return false;
            pending.admitted = true;
          } else if (!(await recordMCPToolAuthFailure(pending))) return false;
        } catch {
          return false;
        }
      }
      const acknowledged = receipt ? pendingBearerFailures.get(receipt) : undefined;
      if (!acknowledged?.admitted) return false;
      mcp = mergeReceipts(mcp, acknowledged.outcomes);
    }
    if (streamId && jobCreatedAt != null) {
      try {
        const job = await GenerationJobManager.getJobStore()?.getJob(streamId);
        if (
          job?.createdAt === jobCreatedAt &&
          job.scheduleId === scheduleId &&
          new Date(job.scheduledFor ?? '').getTime() === new Date(scheduledFor).getTime()
        ) {
          mcp = mergeReceipts(
            mcp,
            readScheduleMCPReceipts(job.scheduleOutcomeError),
            job.scheduleMCPFailure ? [job.scheduleMCPFailure] : [],
          );
        }
      } catch {
        return false;
      }
    }

    let pauseState: Awaited<ReturnType<ScheduleMethods['getScheduleRunAbortState']>> | undefined;
    if (!terminal && !pending && mcp.length === 0) {
      try {
        // A peer can own the only denial. Ordinary pauses still do not wait on Stop.
        pauseState = await methods.getScheduleRunAbortState(scheduleId, new Date(scheduledFor));
        mcp = mergeReceipts(
          mcp,
          pauseState?.mcp?.filter((item) => isScheduleMCPAuthorizationFailure(item)) ?? [],
        );
      } catch {
        return false;
      }
    }
    if (terminal || pending || mcp.length > 0) {
      // Honor an in-flight interactive Stop's persistence before terminalizing. A deferral
      // is NOT a failure to record — the run is deliberately left active/preserved — but it
      // must report "not settled" so callers with durable retry (the approval-expiry host
      // action, reconciliation) re-drive it rather than assuming the outcome landed.
      const observed = await waitForStopPersistence(scheduleId, new Date(scheduledFor), pauseState);
      if (observed == null) {
        logger.info(
          `[schedules] deferring terminal settlement for ${scheduleId}: interactive Stop persistence is still unacknowledged`,
        );
        return false;
      }
      mcp = mergeReceipts(mcp, observed);
    }
    const retained = mcp.length > 0 ? mcp.reduce(preferFailure, mcp[0]) : undefined;
    const missingAuth = mcp.length > 0;
    if (missingAuth) terminal = true;
    const effectiveStatus = missingAuth ? 'error' : status;
    let effectiveError = error;
    if (missingAuth)
      effectiveError = mcp.some((item) => item.reason)
        ? encodeReceipts(mcp)
        : 'MCP unattended authorization unavailable';
    if (terminal && streamId && jobCreatedAt != null && !retiredPolicyGeneration) {
      try {
        await GenerationJobManager.updateMetadata(
          streamId,
          {
            preserveForScheduleReconcile: true,
            ...(retained && { scheduleMCPFailure: retained }),
            scheduleOutcome:
              effectiveStatus === 'success' ||
              effectiveStatus === 'error' ||
              effectiveStatus === 'interrupted' ||
              effectiveStatus === 'skipped_balance'
                ? effectiveStatus
                : 'error',
            ...(effectiveError ? { scheduleOutcomeError: effectiveError } : {}),
          },
          jobCreatedAt,
        );
      } catch (err) {
        logger.error('[schedules] failed to retain terminal outcome evidence:', err);
        return false;
      }
    }
    if (missingAuth && status === 'requires_action' && (!streamId || jobCreatedAt == null))
      return false;
    if (missingAuth && streamId && jobCreatedAt != null && !retiredPolicyGeneration) {
      try {
        const live = await GenerationJobManager.getJobStore()?.getJob(streamId);
        if (
          live?.createdAt !== jobCreatedAt ||
          live.scheduleId !== scheduleId ||
          new Date(live.scheduledFor ?? '').getTime() !== new Date(scheduledFor).getTime() ||
          live.providerDrained === false ||
          live.terminalPersistencePending === true
        )
          return false;
        if (live.status === 'requires_action') {
          // The abort owner parks accepted steers and re-enters settlement only after drain.
          return await engineDeps.abortScheduledJob(
            streamId,
            { scheduleId, scheduledFor, createdAt: jobCreatedAt },
            { preserve: true },
          );
        }
      } catch (error) {
        logger.warn('[schedules] denied generation drain deferred:', error);
        return false;
      }
    }
    for (let attempt = 1; attempt <= OUTCOME_RETRY_ATTEMPTS; attempt++) {
      try {
        // Resolve the owner's limits so auto-disable uses the same per-principal
        // threshold as the fire path (not the global default).
        const schedule = await methods.getScheduleById(scheduleId);
        const owner = schedule ? await engineDeps.getUserContext(schedule.user) : null;
        const limits = await getLimits(owner ?? undefined);
        await methods.recordRunOutcome({
          scheduleId,
          scheduledFor: new Date(scheduledFor),
          status: effectiveStatus,
          clearConversationId,
          conversationId,
          ...(status === 'requires_action' && checkpointNamespace != null
            ? { checkpointNamespace }
            : {}),
          error: effectiveError,
          ...(mcp.length > 0 ? { mcp } : {}),
          autoDisableAfterFailures: limits.autoDisableAfterFailures,
          balanceSkipDisableThreshold: BALANCE_SKIP_DISABLE_THRESHOLD,
        });
        if (terminal && streamId && jobCreatedAt != null && !retiredPolicyGeneration) {
          try {
            const current = await GenerationJobManager.getJobStore()?.getJob(streamId);
            if (
              current?.createdAt === jobCreatedAt &&
              (current.providerDrained === false ||
                current.terminalPersistencePending === true ||
                current.terminalHostActionPending === true)
            ) {
              // Its host callback may settle Mongo while independently retained cleanup stays pending.
              return true;
            }
            const latest = receipt && pendingBearerFailures.get(receipt);
            if (
              latest &&
              (!latest.admitted || mergeReceipts(mcp, latest.outcomes).length !== mcp.length)
            )
              return false;
            await GenerationJobManager.updateMetadata(
              streamId,
              { preserveForScheduleReconcile: false },
              jobCreatedAt,
            );
          } catch (error) {
            logger.warn('[schedules] failed to release terminal outcome evidence:', error);
            return false;
          }

          // A paused occurrence can be aborted while its provider is already drained.
          // In that case the manager's normal drain-time cleanup has already passed;
          // reap the exact terminal job after the Mongo outcome becomes durable.
          const store = GenerationJobManager.getJobStore();
          const job = await store?.getJob(streamId).catch(() => null);
          if (
            job?.createdAt === jobCreatedAt &&
            job.providerDrained !== false &&
            job.terminalPersistencePending !== true &&
            job.terminalHostActionPending !== true &&
            job.status !== 'running' &&
            job.status !== 'requires_action' &&
            job.preserveForScheduleReconcile !== true
          ) {
            await store?.deleteJob(streamId, jobCreatedAt).catch((err) => {
              logger.warn('[schedules] failed to clear settled generation evidence:', err);
            });
          }
        }
        if (terminal && receipt) pendingBearerFailures.delete(receipt);
        // ERASE-ON-SETTLE: whichever process records a run's terminal outcome also
        // attempts the deferred erase of a deleting schedule. This is what makes a
        // delete's `draining` state converge in EVERY topology — the clustered
        // entrypoint runs no reconciler, so without this the hidden schedule (and its
        // prompt, which has no TTL) survived its last run indefinitely there. A cheap
        // guarded no-op for live schedules (the erase filters on `deleting: true`).
        if (terminal) {
          await eraseSettledSchedule(scheduleId).catch((err) => {
            logger.warn(`[schedules] erase-on-settle failed for ${scheduleId}:`, err);
          });
        }
        return true;
      } catch (err) {
        logger.error(
          `[schedules] failed to record run outcome (attempt ${attempt}/${OUTCOME_RETRY_ATTEMPTS}):`,
          err,
        );
      }
    }
    return false;
  }

  async function beginScheduledStop({
    scheduleId,
    scheduledFor,
  }: {
    scheduleId: string;
    scheduledFor: string | Date;
  }): Promise<boolean | 'in_progress'> {
    if (!scheduleId || !scheduledFor) {
      return false;
    }
    return methods.requestRunAbort(scheduleId, new Date(scheduledFor), 'stop');
  }

  async function acknowledgeScheduledStopPersistence({
    scheduleId,
    scheduledFor,
    settle,
  }: {
    scheduleId: string;
    scheduledFor: string | Date;
    /** Terminal outcome to (re-)drive once the barrier clears. Supplied by the Stop route
     *  so a settlement its owner already DEFERRED past the poll budget still converges. */
    settle?: { status: ScheduleRunOutcomeStatus; conversationId?: string; error?: string };
  }): Promise<void> {
    if (!scheduleId || !scheduledFor) {
      return;
    }
    await methods.markRunAbortPersisted(scheduleId, new Date(scheduledFor));
    if (settle == null) {
      return;
    }
    // The owner calls recordScheduleOutcome ONCE. If its Stop barrier deferred (slow
    // beforePublish), nothing would re-drive it where no schedule reconciler is armed —
    // the run would stay `started`, its job preserved, and its global capacity slot held.
    // Now that the barrier is acknowledged, settle from here; recordRunOutcome is
    // match-guarded and idempotent, so a run the owner already settled is a no-op.
    await recordScheduleOutcome({
      scheduleId,
      scheduledFor,
      status: settle.status,
      conversationId: settle.conversationId,
      error: settle.error,
    }).catch((err) => logger.warn('[schedules] post-acknowledgement settlement failed:', err));
  }

  async function isScheduleLive(
    scheduleId: string,
    expectedConfigRevision?: number,
    options?: { automatic?: boolean; policy?: boolean; scheduledFor?: string | Date },
  ): Promise<boolean> {
    if (!scheduleId) {
      return false;
    }
    const schedule = await methods.getScheduleById(scheduleId);
    if (schedule == null) {
      return false;
    }
    // An AUTOMATIC fire must still be wanted. A policy auto-disable (too many failures,
    // insufficient balance) flips `enabled` WITHOUT touching configRevision, so the
    // revision fence below cannot see it — an occurrence already in the claim-to-
    // controller window would otherwise start a billed generation for a schedule that
    // has just been switched off. Run Now is an explicit user action and stays allowed
    // on a disabled schedule, matching fireScheduleNow.
    if (options?.automatic === true && schedule.enabled === false) {
      return false;
    }
    // REVISION FENCE at the admission boundary. Existence alone is not enough: an owner
    // edit landing between the claim and this point means the dispatched prompt/agent
    // came from a config the owner has since replaced, and nothing downstream would
    // catch it because the run persists under the NEW schedule. Refuse before any
    // message is written. Absent on either side disables the fence, so pre-existing
    // schedules and older fires keep working.
    if (
      expectedConfigRevision != null &&
      typeof schedule.configRevision === 'number' &&
      schedule.configRevision !== expectedConfigRevision
    ) {
      return false;
    }
    // LIVE dispatch policy, re-applied exactly as the fire path applies it. A pause
    // can sit unanswered for hours, and an operator's global kill switch, a narrowed
    // `interface.schedules` availability, or a revoked SCHEDULES:USE permission
    // landing in that window touches neither the row nor its revision — none of the
    // checks above can see it, and approving the pause would start a fresh billed
    // continuation the operator believes is stopped. Applies to manual runs too: an
    // emergency stop must stop those approvals as well.
    if (options?.policy === true) {
      if (await engineDeps.isGloballyDisabled()) {
        return false;
      }
      const owner = await engineDeps.getUserContext(schedule.user);
      if (owner == null) {
        return false;
      }
      const limits = await engineDeps.runInTenantContext(owner, () => getLimits(owner));
      if (!limits.enabled) {
        return false;
      }
      if (!(await engineDeps.hasScheduleAccess(owner))) {
        return false;
      }
      // Project policy belongs HERE rather than in the resume claim: this branch's
      // refusal is already routed through abort-and-settle by both callers, so a
      // policy stop settles the occurrence instead of leaving it at `requires_action`
      // answering 409 to every approval attempt until it expires.
      //
      // Deliberately NARROW. It refuses only where there is no valid destination left:
      // the requirement is on with nothing to satisfy it, or the schedule's own project
      // is gone (which also unset it on the conversation). It does NOT refuse merely
      // because an operator's pin moved to a different project — the paused
      // conversation cannot be rebound (`chatProjectId` is excluded from the resume
      // context, and the continuation reuses the same conversationId), so refusing
      // would strand a pending approval over a pin that only governs where the NEXT
      // run lands, which the fire path already redirects.
      // Prefer the destination THIS OCCURRENCE recorded over the schedule-level value.
      // A paused run does not block later occurrences (the single-active index covers
      // `started` only), so after a pin moves, a subsequent fire rewrites the schedule
      // row while the paused conversation stays where it was — validating the row would
      // then check a project that conversation was never filed under.
      //
      // An ABSENT record falls back to the schedule: a pre-scope occurrence, or one
      // whose row is gone, must never be read as evidence to stop a run.
      const occurrence =
        options?.scheduledFor != null
          ? await methods.getScheduleRunProject(scheduleId, options.scheduledFor)
          : null;
      // `recorded`, not the id: an occurrence that deliberately ran unscoped recorded a
      // null, and validating the schedule's CURRENT value for it would admit a
      // conversation that satisfies no present requirement. Only an unknown record — a
      // row from before the field, or none at all — falls back.
      const effectiveProject = occurrence?.recorded
        ? occurrence.chatProjectId
        : resolveScheduleProjectId(limits, schedule.chatProjectId);
      if (limits.requireProject && effectiveProject == null) {
        return false;
      }
      if (
        effectiveProject != null &&
        (await engineDeps.projectAccess(effectiveProject, owner)) !== 'ok'
      ) {
        return false;
      }
    }
    return true;
  }

  async function claimScheduleResume(
    scheduleId: string,
    scheduledFor: string | Date,
    options?: { expectedConfigRevision?: number; automatic?: boolean },
  ): Promise<ScheduleResumeClaimResult> {
    const schedule = await methods.getScheduleById(scheduleId);
    if (schedule == null) {
      return { conflict: 'inactive' };
    }
    if (options?.automatic !== false && schedule.enabled === false) {
      return { conflict: 'inactive' };
    }
    if (
      options?.expectedConfigRevision != null &&
      typeof schedule.configRevision === 'number' &&
      schedule.configRevision !== options.expectedConfigRevision
    ) {
      return { conflict: 'inactive' };
    }
    const owner = await engineDeps.getUserContext(schedule.user);
    if (owner == null) {
      return { conflict: 'inactive' };
    }
    return engineDeps.runInTenantContext(owner, async () => {
      const [ownerLimits, deploymentLimits, globallyDisabled, hasAccess] = await Promise.all([
        getLimits(owner),
        getLimits(),
        engineDeps.isGloballyDisabled(),
        engineDeps.hasScheduleAccess(owner),
      ]);
      if (!ownerLimits.enabled || globallyDisabled || !hasAccess) {
        return { conflict: 'inactive' };
      }
      // Project policy is NOT re-checked here. It lives in isScheduleLive's `policy`
      // branch, which both entry points consult first and whose refusal aborts and
      // settles the occurrence; a second copy here would answer a bare 409 and strand
      // the run at `requires_action` instead.
      // FINAL schedule-side admission fence. Everything above is asynchronous and an
      // owner edit/disable can land while it runs. Claim the schedule document under
      // the expected config generation now, carry this lease through the approval CAS,
      // and atomically consume it before provider execution begins.
      const resumeLease = await methods.acquireResumeLease(
        scheduleId,
        options?.expectedConfigRevision,
        options?.automatic !== false,
        SCHEDULE_RESUME_LEASE_MS,
      );
      if (resumeLease?.claimToken == null || resumeLease.leaseBy == null) {
        return { conflict: 'inactive' };
      }
      let retainResumeLease = false;
      try {
        const allocation = await engineDeps.withGlobalCapacitySlot(
          Math.min(ownerLimits.fireConcurrency, deploymentLimits.fireConcurrency),
          async (capacitySlot) => {
            const attempt = await methods.markRunResumeClaimed(
              scheduleId,
              new Date(scheduledFor),
              capacitySlot,
            );
            return 'conflict' in attempt && attempt.conflict === 'slot-taken'
              ? 'slot-taken'
              : { claimed: attempt };
          },
        );
        if (allocation === 'capacity') {
          return { conflict: 'capacity' };
        }
        const claimed = allocation.claimed;
        if ('conflict' in claimed) {
          // withCapacitySlot consumes this internal collision sentinel by retrying the
          // next free slot. Normalize defensively at the public boundary as well so a
          // custom/test allocator can never leak an implementation-only conflict.
          return {
            conflict: claimed.conflict === 'slot-taken' ? 'capacity' : claimed.conflict,
          };
        }
        retainResumeLease = true;
        return {
          capacitySlot: claimed.capacitySlot,
          claimToken: resumeLease.claimToken,
          leaseBy: resumeLease.leaseBy,
        };
      } finally {
        if (!retainResumeLease) {
          await methods.releaseLeaseByHolder(scheduleId, resumeLease.leaseBy);
        }
      }
    });
  }

  function releaseScheduleResumeClaim(
    scheduleId: string,
    scheduledFor: string | Date,
    capacitySlot: number,
  ): Promise<boolean> {
    return methods.releaseRunResumeClaim(scheduleId, new Date(scheduledFor), capacitySlot);
  }

  async function finalizeScheduleResumeClaim(
    scheduleId: string,
    claimToken: string,
    leaseBy: string,
    options?: { expectedConfigRevision?: number; automatic?: boolean },
  ): Promise<boolean> {
    const consumed = await methods.consumeResumeLease(
      scheduleId,
      claimToken,
      leaseBy,
      options?.automatic !== false,
      options?.expectedConfigRevision,
    );
    if (!consumed) {
      // An owner edit rotates claimToken but deliberately leaves the old holder's
      // lease in place. Clear only that holder so the edited schedule is immediately
      // usable; a takeover changed leaseBy and is therefore untouched.
      await methods.releaseLeaseByHolder(scheduleId, leaseBy);
    }
    return consumed;
  }

  function releaseScheduleResumeFence(scheduleId: string, leaseBy: string): Promise<void> {
    return methods.releaseLeaseByHolder(scheduleId, leaseBy);
  }

  /** Aborts an active run's loopback job (identity-guarded). Returns whether the
   * abort was delivered (false when the job wasn't reachable — e.g. a peer worker's
   * private store, or a transient error). */
  async function abortActiveRun(
    run: { scheduleId: string; scheduledFor: Date; conversationId?: string },
    preserve: boolean,
    options?: { stampRenewal?: boolean; settleAfterAbort?: boolean },
  ): Promise<boolean> {
    if (!run.conversationId) {
      return false;
    }
    // Record the abort REQUEST before signalling. This keeps the run holding its global
    // capacity slot until its generation owner writes a terminal outcome (settlement),
    // so an abort that has been asked for but not yet honored cannot free capacity for a
    // new run while the old generation is still alive. The stamp is LOAD-BEARING: it is
    // what makes a concurrent drain (and the reconciler) defer to the owner's settle,
    // so if it cannot be made durable the abort must NOT be signalled — report
    // undelivered and let the caller's unconfirmed/retry path re-drive both.
    //
    // `stampRenewal: false` skips the stamp entirely: callers pass it for CLEANUP
    // aborts of a job they just observed terminal/absent (nothing live will be
    // signalled). Renewing there would re-arm the 30-minute owner-death fence on
    // every retry against a dead owner, so the run could never age into the
    // reconciler's recovery.
    if (options?.stampRenewal !== false) {
      try {
        await methods.requestRunAbort(run.scheduleId, run.scheduledFor, 'deletion');
      } catch (err) {
        logger.warn('[schedules] failed to record abort request; abort withheld:', err);
        return false;
      }
    }
    const before = await engineDeps.getJobStatus(run.conversationId).catch(() => null);
    const generation = before && jobMatchesIdentity(before, run) ? before.createdAt : undefined;
    const stopped = await engineDeps
      .abortScheduledJob(
        run.conversationId,
        { scheduleId: run.scheduleId, scheduledFor: run.scheduledFor, createdAt: generation },
        { preserve },
      )
      .catch((err) => {
        logger.warn('[schedules] failed to abort run job on quiesce:', err);
        return false;
      });
    if (!stopped || options?.settleAfterAbort === false) {
      return stopped;
    }

    // awaitProviderDrain in abortScheduledJob is the positive persistence fence:
    // the exact provider owner has unwound, so this row can now leave the active
    // set without racing a late message write.
    const recorded = await recordScheduleOutcome({
      scheduleId: run.scheduleId,
      scheduledFor: run.scheduledFor,
      status: 'interrupted',
      streamId: run.conversationId,
      jobCreatedAt: generation,
      conversationId: run.conversationId,
      error: 'Schedule deleted while the run was active',
    });
    if (!recorded) {
      return false;
    }
    await engineDeps
      .clearReconciledJob(run.conversationId, {
        scheduleId: run.scheduleId,
        scheduledFor: run.scheduledFor,
      })
      .catch((err) => logger.warn('[schedules] failed to clear deleted run evidence:', err));
    return true;
  }

  /** Resolve the owner's durable-checkpointer config (in their tenant context) so a
   *  paused-run checkpoint can be pruned on delete, mirroring the interactive abort. */
  async function resolveOwnerCheckpointer(
    ownerId: string | Types.ObjectId,
  ): Promise<TCheckpointerConfig | undefined> {
    const owner = await engineDeps.getUserContext(ownerId);
    if (owner == null) {
      return undefined;
    }
    const appConfig = await engineDeps.runInTenantContext(owner, () =>
      deps.getAppConfig(getAppConfigOptionsFromUser(owner)),
    );
    return appConfig?.endpoints?.agents?.checkpointer;
  }

  function deletionSettlementBlocked(job: JobState | null | undefined): boolean {
    return (
      job != null &&
      (job.status === 'running' ||
        job.providerDrained === false ||
        job.terminalPersistencePending === true ||
        job.terminalHostActionPending === true)
    );
  }

  async function cleanupStillPending(
    runs: Array<{ scheduleId: string; scheduledFor: Date; conversationId?: string }>,
  ): Promise<boolean> {
    for (const run of runs) {
      try {
        const job = run.conversationId ? await engineDeps.getJobStatus(run.conversationId) : null;
        if (job && jobMatchesIdentity(job, run) && deletionSettlementBlocked(job)) return true;
      } catch {
        return true;
      }
    }
    return false;
  }

  /**
   * Soft-deletes a schedule for its owner: disables + marks it `deleting` (so the
   * engine can no longer claim it and it disappears from the owner's list), rotates
   * the claim token to fence any in-flight worker, then DRAINS with the same evidence
   * discipline as account-deletion quiesce — a run whose job is provably absent or
   * settled is recorded and erased here, synchronously; a live generation is aborted
   * and settles through its own outcome write (which erases on settle, so no
   * reconciler is required in any topology). The result is honest: `unconfirmed`
   * means at least one run could not be shown stopped, and the caller must not
   * claim it was.
   */
  async function deleteScheduleForOwner(
    scheduleId: string,
    userId: string,
  ): Promise<ScheduleDeleteResult> {
    const schedule = await methods.markScheduleDeleting(scheduleId, userId);
    if (schedule == null) {
      return 'not_found';
    }
    const active = await methods.getActiveRunsForSchedule(scheduleId);
    // Resolve the checkpointer config once (only when a paused run needs pruning) in
    // the owner's tenant context, matching the interactive abort endpoint's prune.
    const hasPausedRun = active.some(
      (run) => run.status === 'requires_action' && run.conversationId != null,
    );
    // BEST-EFFORT: the prune this feeds is itself best-effort, and a lookup failure
    // must not cost the aborts below.
    const checkpointer = hasPausedRun
      ? await resolveOwnerCheckpointer(schedule.user).catch((err) => {
          logger.warn(`[schedules] checkpointer lookup failed for delete ${scheduleId}:`, err);
          return undefined;
        })
      : undefined;
    const stores = hasPausedRun
      ? await checkpointStorageConfigs(userId, schedule.tenantId, checkpointer).catch((err) => {
          logger.warn(
            `[schedules] checkpoint storage lookup failed for delete ${scheduleId}:`,
            err,
          );
          return [checkpointer];
        })
      : [];
    let unconfirmed = 0;
    const cleanupPending: typeof active = [];
    for (const run of active) {
      // UNKNOWN is not ABSENT — the same distinction the quiesce path draws. A lookup
      // that succeeded and returned null is positive evidence no generation holds this
      // conversation; a lookup that THREW is evidence of nothing.
      const live = run.conversationId
        ? await engineDeps.getJobStatus(run.conversationId).then(
            (job) => ({ known: true, job }),
            () => ({ known: false, job: null }),
          )
        : { known: true, job: null };
      const isThisGeneration =
        live.job != null &&
        jobMatchesIdentity(live.job, {
          scheduleId: run.scheduleId,
          scheduledFor: run.scheduledFor,
        });
      // Capture the paused run's checkpoint ids BEFORE any terminal transition below:
      // the prune afterwards is scoped to exactly this set, so checkpoints a
      // replacement turn writes after this point can never be swept up by it.
      const checkpointNamespace =
        isThisGeneration || live.job == null
          ? (live.job?.checkpointNamespace ?? run.checkpointNamespace)
          : undefined;
      const captured: Array<{
        storage: TCheckpointerConfig | undefined;
        generation: AgentCheckpointGeneration;
      }> = [];
      if (
        run.status === 'requires_action' &&
        run.conversationId &&
        live.known &&
        (live.job == null || isThisGeneration)
      ) {
        for (const storage of stores) {
          const generation = await captureAgentCheckpointGeneration(
            run.conversationId,
            storage,
            checkpointNamespace == null ? {} : { checkpointNamespace },
          );
          if (generation != null) captured.push({ storage, generation });
        }
      }
      // Same abort-in-flight deferral as quiesce: post-abort job state (status `aborted`,
      // or absence once the abort deleted the job) appears before the owner has persisted
      // and settled, so it is not evidence that the generation is done.
      //
      // A paused job whose run row is still `started` is a pause HAND-OFF in flight:
      // the job reports requires_action the instant the run interrupts, while the
      // controller's pause branch is still flushing this segment's writes and records
      // the pause on the row only after them. Settling on the job state alone let the
      // cascade complete before those writes landed, which then recreated the paused
      // response for the deleted schedule. The controller's record (or the paused-
      // window reconciler) flips the row to requires_action, so the deferral is
      // bounded — a later pass settles it.
      const pauseHandoffInFlight =
        isThisGeneration &&
        live.job?.status === 'requires_action' &&
        (run.status === 'started' || hasResumeHandoffInFlight(run, Date.now()));
      const settleable =
        live.known &&
        !hasAbortInFlight(run, Date.now()) &&
        !pauseHandoffInFlight &&
        !(isThisGeneration && deletionSettlementBlocked(live.job));
      if (settleable) {
        // Positive evidence nothing is generating: settle the row HERE so the erase
        // below can proceed without any reconciler — the clustered entrypoint has
        // none, and deferring these rows to it retained the deleted schedule (and its
        // prompt) indefinitely in that topology. Settle BEFORE aborting: a retained
        // job is the only evidence of a finished run whose outcome write failed.
        const retainedOutcome = isThisGeneration
          ? TERMINAL_JOB_OUTCOMES[live.job!.status]
          : undefined;
        const settledStatus = retainedOutcome ?? 'interrupted';
        const settled = await methods
          .recordRunOutcome({
            scheduleId: run.scheduleId,
            scheduledFor: run.scheduledFor,
            ...projectScheduleMCPReceipt(
              {
                status: settledStatus,
                mcp: run.mcp,
                error: settledStatus === 'interrupted' ? 'Schedule deleted' : undefined,
              },
              isThisGeneration ? readScheduleMCPReceipts(live.job?.scheduleOutcomeError) : [],
            ),
            conversationId: run.conversationId,
            autoDisableAfterFailures: DEFAULT_SCHEDULE_LIMITS.autoDisableAfterFailures,
          })
          .then(
            () => true,
            (err) => {
              logger.warn(`[schedules] failed to settle run on delete ${scheduleId}:`, err);
              return false;
            },
          );
        if (settled) {
          // Cleanup abort of a job just observed terminal/absent: nothing live gets
          // signalled, so the stamp is NOT renewed — re-arming the owner-death fence
          // on every delete retry would keep a dead owner's row from ever aging into
          // the reconciler's recovery.
          const cleaned = await abortActiveRun(run, false, {
            stampRenewal: false,
            settleAfterAbort: false,
          });
          if (!cleaned && isThisGeneration) cleanupPending.push(run);
        } else {
          unconfirmed += 1;
        }
      } else {
        // A live generation (or an unknown one): abort it, preserving the job so its
        // outcome survives, and require the DELIVERY to be confirmed. An abort that
        // was not delivered leaves a generation that keeps producing and billing —
        // reporting this delete as a success would claim otherwise.
        const aborted = await abortActiveRun(run, true);
        if (!aborted) {
          unconfirmed += 1;
        }
      }
      // HITL: prune the durable checkpoints of a run aborted while paused so a new turn
      // in this conversation can't rehydrate the stale interrupt before the Mongo TTL
      // reclaims it (thread_id === conversationId). Idempotent / no-op otherwise.
      //
      // Two guards against a REPLACEMENT owning the conversation: ownership is re-read
      // fresh (the settle/abort awaits above are a window a replacement can claim the
      // conversationId in), and the deletion is SCOPED to the checkpoint ids captured
      // before the terminal transition — so even a replacement that slips in between
      // this read and the delete only ever loses checkpoints that predate the abort,
      // never its own. An unreadable store proves nothing, so it is left alone.
      if (
        run.status === 'requires_action' &&
        run.conversationId &&
        captured.some(({ generation }) => generation.checkpointIds.length > 0)
      ) {
        const fresh = await engineDeps.getJobStatus(run.conversationId).then(
          (job) => ({ known: true, job }),
          () => ({ known: false, job: null }),
        );
        const freshIsThisGeneration =
          fresh.job != null &&
          jobMatchesIdentity(fresh.job, {
            scheduleId: run.scheduleId,
            scheduledFor: run.scheduledFor,
          });
        const ownsConversation = fresh.known && (fresh.job == null || freshIsThisGeneration);
        if (ownsConversation) {
          for (const { storage, generation } of captured) {
            await deleteAgentCheckpoint(run.conversationId, storage, generation).catch(
              () => undefined,
            );
          }
        }
      }
    }
    if (unconfirmed > 0) {
      // The run row leaving the active set is the durable acknowledgement that its
      // generation stopped and persisted (the owner settles LAST) — wait for it,
      // bounded, before answering. Without this, every cross-replica delete whose
      // abort delivery cannot be locally proven would answer 503 even though the
      // owner settles moments later.
      const deadline = Date.now() + QUIESCE_DRAIN_TIMEOUT_MS;
      let remaining = unconfirmed;
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, QUIESCE_DRAIN_POLL_MS));
        remaining = (await methods.getActiveRunsForSchedule(scheduleId)).length;
        if (remaining === 0) {
          break;
        }
      }
      if (remaining > 0) {
        return 'unconfirmed';
      }
    }
    if (await cleanupStillPending(cleanupPending)) return 'unconfirmed';
    const erased = await eraseSettledSchedule(scheduleId).catch((err) => {
      logger.warn(`[schedules] erase failed for ${scheduleId}:`, err);
      return false;
    });
    if (erased) {
      return 'deleted';
    }
    // eraseScheduleIfDrained already returns true when the row was concurrently
    // erased or is absent. A false result therefore means the deleting row is still
    // protected by a live lease/run, or the erase could not be confirmed.
    return 'draining';
  }

  /**
   * Quiesces every schedule of a user ahead of account deletion: REVERSIBLY suspends them
   * under the attempt `token` (non-claimable, so no new occurrence fires while the cascade
   * runs) and aborts the loopback jobs of any in-flight runs, so a scheduled generation
   * cannot keep persisting messages after the account's messages/conversations are deleted.
   * The suspension is reversible so a cancelled deletion can restore it (see
   * restoreUserSchedulesFromDeletion) rather than stranding a live user with erased rows.
   */
  async function quiesceUserSchedules(userId: string, token: string): Promise<boolean> {
    await methods.suspendUserSchedulesForDeletion(userId, token);
    const active = await methods.getActiveRunsForUser(userId);
    const unconfirmed: string[] = [];
    const cleanupPending: typeof active = [];
    for (const run of active) {
      // Current resumes promote the row back to `started` with a capacity slot, but a
      // rolling deploy or crash-era row may still be `requires_action` while its job is
      // already `running`. So the row status alone cannot prove a genuine pause. Read
      // the live job BEFORE aborting, which settles or deletes it and would erase this
      // evidence.
      // UNKNOWN is not ABSENT. A lookup that THREW is evidence of nothing, while one
      // that succeeded and returned null is positive evidence that no generation holds
      // this conversation. Collapsing the two (a bare `.catch(() => null)`) would let a
      // transient store failure read as "genuinely paused" and terminalize a row whose
      // resumed generation is still running — the exact hazard this check exists for.
      const live = run.conversationId
        ? await engineDeps.getJobStatus(run.conversationId).then(
            (job) => ({ known: true, job }),
            () => ({ known: false, job: null }),
          )
        : { known: true, job: null };
      const isThisGeneration =
        live.job != null &&
        jobMatchesIdentity(live.job, {
          scheduleId: run.scheduleId,
          scheduledFor: run.scheduledFor,
        });
      // Settle only on POSITIVE evidence that nothing is generating: an identity-matched
      // job that is not running, an identity MISMATCH (a replacement turn owns the
      // conversation, so this occurrence's generation is already gone), or a confirmed
      // absence. Anything unknown falls through and the drain waits for it.
      //
      // An abort IN FLIGHT is not such evidence, and this is the subtle case: `aborted`
      // and post-abort ABSENCE both appear the instant abortJob wins its CAS, while the
      // owner has yet to persist. Deferring to the owner's settle (see
      // ABORT_SETTLE_GRACE_MS) is what stops a drain from being confirmed mid-write.
      const abortInFlight = hasAbortInFlight(run, Date.now());
      // Same pause hand-off deferral as the schedule delete path: a paused job whose
      // row is still `started` has the controller's pause-branch writes in flight,
      // and settling on the job state alone confirms the drain before they land.
      const pauseHandoffInFlight =
        isThisGeneration &&
        live.job?.status === 'requires_action' &&
        (run.status === 'started' || hasResumeHandoffInFlight(run, Date.now()));
      const settleable =
        live.known &&
        !abortInFlight &&
        !pauseHandoffInFlight &&
        !(isThisGeneration && deletionSettlementBlocked(live.job));
      // Aborts here never preserve for reconcile: account deletion hard-deletes these
      // run rows, so no reconcile pass would ever finalize or clear a retained job.
      const retainedOutcome = isThisGeneration
        ? TERMINAL_JOB_OUTCOMES[live.job!.status]
        : undefined;
      // `settleable` ALREADY means positive evidence that nothing is generating: an
      // identity-matched job that is not running, an identity MISMATCH (a replacement
      // turn owns the conversation), or a confirmed absence. Any extra condition on top
      // of it strands exactly the cases it was computed to cover — a `started` row whose
      // process died before creating its job reads as a confirmed absence, and the old
      // clause left it active through the whole drain, so account deletion answered 503
      // on every attempt until the 30-minute orphan sweep.
      if (settleable) {
        // SETTLE BEFORE ABORTING. The abort deletes the retained job, and for a run
        // whose inline outcome write exhausted its retries that job is the ONLY evidence
        // it finished — reading its status into a local is not the same as durably
        // recording it. If this write fails, the abort below has not yet run, so the
        // evidence survives for the next pass; the drain simply does not confirm and
        // deletion defers, which is the safe direction.
        // Either the retained job's own outcome, or — for a genuinely PAUSED run whose
        // approval will never be consumed for a deleted account — `interrupted`. Without
        // this a single paused run blocked the account's deletion permanently.
        const settledStatus = retainedOutcome ?? 'interrupted';
        const settledError = QUIESCE_SETTLE_ERRORS[settledStatus];
        const settled = await methods
          .recordRunOutcome({
            scheduleId: run.scheduleId,
            scheduledFor: run.scheduledFor,
            ...projectScheduleMCPReceipt(
              { status: settledStatus, mcp: run.mcp, error: settledError },
              isThisGeneration ? readScheduleMCPReceipts(live.job?.scheduleOutcomeError) : [],
            ),
            conversationId: run.conversationId,
            autoDisableAfterFailures: DEFAULT_SCHEDULE_LIMITS.autoDisableAfterFailures,
          })
          .then(() => true)
          .catch((err) => {
            logger.warn('[schedules] failed to settle run on quiesce:', err);
            return false;
          });
        // Only now is the job disposable. On a failed settle, leave it: the row is still
        // active, so the drain reports unconfirmed and a later pass retries with its
        // evidence intact. Cleanup abort of an observed-settled job — no stamp renewal,
        // or every quiesce retry would re-arm the owner-death fence and a dead owner's
        // row could never age into recovery.
        if (settled) {
          const cleaned = await abortActiveRun(run, false, {
            stampRenewal: false,
            settleAfterAbort: false,
          });
          if (!cleaned && isThisGeneration) cleanupPending.push(run);
        }
        continue;
      }
      // Not settleable here (a live generation, or an unknown job): abort it and let the
      // bounded drain below wait for its own terminal outcome to land.
      const aborted = await abortActiveRun(run, false);
      if (!aborted && run.conversationId) {
        unconfirmed.push(run.conversationId);
      }
    }
    // WAIT (bounded) for the aborted generations to actually settle before the
    // account-deletion cascade deletes messages/conversations: a run that already
    // returned from the model can observe the abort but still persist its messages,
    // which would otherwise resurrect data for the deleted account after the cascade
    // ran. Poll the run rows (they leave the active set once their outcome is
    // recorded) until drained or the deadline.
    const deadline = Date.now() + QUIESCE_DRAIN_TIMEOUT_MS;
    let remaining = active.length;
    while (remaining > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, QUIESCE_DRAIN_POLL_MS));
      remaining = (await methods.getActiveRunsForUser(userId)).length;
    }
    // Surface anything that did not drain / could not be confirmed so the deletion
    // cascade defers rather than destroying while a generation may still persist.
    // Re-evaluate rather than trusting the initial abort-delivery result: an abort can
    // report false because the job was briefly unreachable, yet that generation then
    // finishes and records a terminal outcome during the drain poll. The run is genuinely
    // settled at that point, so keeping its id in `unconfirmed` would defer account
    // deletion forever. The DRAIN is the authority; delivery is only a hint.
    const confirmed =
      remaining === 0 &&
      !(await cleanupStillPending(cleanupPending)) &&
      !(await hasScheduleCleanupObligation({ userId }));
    if (confirmed && unconfirmed.length > 0) {
      logger.info(
        `[schedules] ${unconfirmed.length} abort(s) were not confirmed delivered but their ` +
          'runs settled during the drain; treating the quiesce as complete.',
      );
    }
    if (!confirmed) {
      logger.warn(
        `[schedules] account-deletion quiesce did not confirm ${Math.max(remaining, unconfirmed.length, cleanupPending.length)} ` +
          `in-flight scheduled run(s) settled${unconfirmed.length ? ` [${unconfirmed.join(', ')}]` : ''} ` +
          '— a peer worker generation may still persist data. Guaranteed quiescing requires a ' +
          'shared stream store (USE_REDIS_STREAMS).',
      );
    }
    return confirmed;
  }

  /**
   * Reverses a quiesce whose account deletion was cancelled (a controller failure that
   * released the user-deletion fence). Re-enables and re-arms only the rows this exact
   * attempt suspended; a schedule the owner independently deleted, or one a newer attempt
   * re-suspended, is left as-is.
   */
  async function restoreUserSchedulesFromDeletion(userId: string, token: string): Promise<void> {
    await methods.restoreUserSchedulesFromDeletion(userId, token);
  }

  return {
    getLimits,
    engineDeps,
    fireScheduleNow,
    recordScheduleOutcome,
    recordMCPToolAuthFailure,
    getMCPReceiptRetryPolicy,
    registerMCPSettlement,
    beginScheduledStop,
    acknowledgeScheduledStopPersistence,
    claimScheduleResume,
    releaseScheduleResumeClaim,
    finalizeScheduleResumeClaim,
    releaseScheduleResumeFence,
    isScheduleLive,
    deleteScheduleForOwner,
    quiesceUserSchedules,
    restoreUserSchedulesFromDeletion,
    initializeScheduleEngine,
    initializeScheduleErasureSweep,
    reconcileRetainedJobs,
  };
}
