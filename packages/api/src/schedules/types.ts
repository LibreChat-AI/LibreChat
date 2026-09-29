import type {
  ScheduleMethods,
  ISchedule,
  AgentTriggerDeliveryStatus,
  AgentTriggerDeliveryFailure,
} from '@librechat/data-schemas';
import type { ScheduleMCPOutcome } from 'librechat-data-provider';
import type { Types } from 'mongoose';
import type { AgentTriggerEnqueueOptions, AgentTriggerEnvelope } from '../agents/triggers';
import type { SlotClaimResult } from './capacity';

export interface ScheduleLimits {
  /** Feature-level switch: when false the engine claims/fires nothing. */
  enabled: boolean;
  maxPerUser: number;
  minIntervalMinutes: number;
  autoDisableAfterFailures: number;
  /** Maximum claimed occurrences concurrently passing readiness admission per replica. */
  admissionConcurrency: number;
  fireConcurrency: number;
  /** Maximum MCP readiness probes active during one schedule admission. */
  mcpPreflightConcurrency: number;
  /** Maximum wall-clock time for one unattended MCP readiness admission. */
  mcpPreflightTimeoutMs: number;
  /** Every schedule must be filed under a chat project. A pinned `projectId`
   *  implies this, so callers only ever have to read one flag. */
  requireProject: boolean;
  /** Operator-pinned destination project. When set it OVERRIDES whatever the row
   *  stores, at write time and at fire time alike — the pin is a policy about where
   *  scheduled runs land, and a stored id from before the pin must not outrank it. */
  projectId?: string;
}

export const DEFAULT_SCHEDULE_LIMITS: ScheduleLimits = {
  enabled: true,
  maxPerUser: 10,
  minIntervalMinutes: 60,
  autoDisableAfterFailures: 5,
  admissionConcurrency: 20,
  fireConcurrency: 5,
  mcpPreflightConcurrency: 3,
  mcpPreflightTimeoutMs: 5 * 60_000,
  requireProject: false,
};

/**
 * The project a schedule's runs must land in under the CURRENT policy: an operator
 * pin outranks the stored choice, otherwise the owner's own selection stands.
 * Single source of truth for the write handlers, the fire path, and the wire
 * projection, so the form, the precheck, and the dispatched conversation can never
 * disagree about the destination.
 */
export function resolveScheduleProjectId(
  limits: Pick<ScheduleLimits, 'projectId'>,
  stored?: string | null,
): string | undefined {
  return limits.projectId ?? stored ?? undefined;
}

export interface ScheduleUserContext {
  id: string;
  tenantId?: string;
  role?: string;
}

/**
 * Outcome of an owner-initiated schedule delete.
 * - `deleted`: drained and erased.
 * - `draining`: every active run's abort was DELIVERED; erasure follows once the
 *   generation records its terminal outcome (erase-on-settle), in any topology.
 * - `unconfirmed`: at least one run could not be confirmed stopped (job store
 *   unreachable, or the abort was not delivered). The schedule stays hidden and
 *   fenced, but its generation may still be producing — callers must not report
 *   the run as stopped.
 */
export type ScheduleDeleteResult = 'not_found' | 'deleted' | 'draining' | 'unconfirmed';

/**
 * How long an abort's OWNER is presumed alive and obliged to settle the run itself.
 *
 * The rule this enforces: **job state is never persistence acknowledgement.** A job
 * reads `aborted` — or vanishes, or carries `completedAt` — the moment `abortJob` wins
 * its status CAS, which is BEFORE the owner unwinds and writes anything. Both owner
 * paths deliberately settle LAST, after `saveMessage`, so the ONLY acknowledgement that
 * all persistence-producing work finished is the owner's own terminal outcome write
 * (i.e. the run row leaving the active set). Reading post-abort job state as "nothing is
 * generating" confirms a drain mid-write: account deletion destroys the user's data and
 * the owner then writes a message back for the deleted account.
 *
 * So while an abort is in flight, nothing but the owner settles — deletion drains
 * defer (503 + Retry-After) and the reconciler leaves the row alone. Past the window
 * the owner is presumed dead, and the reconciler's orphan handling takes over.
 *
 * Deliberately the reconciler's ORPHAN cutoff rather than a shorter local grace: that
 * presumption already exists and is already the thing that would eventually clear the
 * row. One rule, not two.
 */
export const ABORT_OWNER_PRESUMED_ALIVE_MS: number = 30 * 60_000;

/**
 * Whether an abort was requested for this run recently enough that its owner is still
 * expected to persist and settle. `abortRequestedAt` is stamped BEFORE any abort is
 * signalled (see `abortActiveRun` and the interactive abort route), which is what makes
 * it usable as evidence that post-abort job state is not yet a settled generation.
 */
/** How long a resume-claim stamp fences quiesce settling before it is presumed
 *  crashed. A resume's own generation shows `running` (already unsettleable);
 *  this bound only covers the re-pause hand-off window plus crash recovery. */
export const RESUME_HANDOFF_STALE_MS: number = 10 * 60_000;

/** Whether a paused run's RESUME hand-off is still in flight: its approval was
 *  consumed and the continuation's re-pause writes may still be landing, so the
 *  paused job state is not settleable evidence yet. */
export function hasResumeHandoffInFlight(
  run: { resumeClaimedAt?: Date | null },
  now: number,
): boolean {
  return (
    run.resumeClaimedAt != null && now - run.resumeClaimedAt.getTime() < RESUME_HANDOFF_STALE_MS
  );
}

/**
 * The outcome the generation owner intended for a RETAINED `complete` job, or `success`
 * when it left none (a fire from before the stamp, or a store that never carried it).
 * An unrecognized value is treated as `success` rather than forwarded: it crossed a
 * serialization boundary, and `recordRunOutcome` would reject a status outside its
 * union — losing a rare refinement beats failing the recovery write outright.
 */
export function retainedOutcome(
  jobState: JobState | null,
  fallback: 'success' | 'error',
): {
  status: 'success' | 'error' | 'interrupted' | 'skipped_balance';
  error?: string;
} {
  const stamped = jobState?.scheduleOutcome;
  if (stamped === 'skipped_balance') {
    return { status: 'skipped_balance' };
  }
  if (stamped === 'interrupted') {
    return { status: 'interrupted', error: jobState?.scheduleOutcomeError };
  }
  if (stamped === 'error' || fallback === 'error') {
    return { status: 'error', error: jobState?.scheduleOutcomeError ?? 'Run ended in error' };
  }
  return { status: fallback };
}

export function hasAbortInFlight(run: { abortRequestedAt?: Date }, now: number): boolean {
  if (run.abortRequestedAt == null) {
    return false;
  }
  return now - new Date(run.abortRequestedAt).getTime() < ABORT_OWNER_PRESUMED_ALIVE_MS;
}

/**
 * Renewable upload hold for schedule attachments (extendFilesTTL-shaped), replacing
 * the earlier permanent TTL removal, which leaked the upload forever when the schedule
 * was deleted before its first run, its file_ids were replaced, or creation failed.
 * Touched at create/edit and at every fire preflight; the FIRST fire that actually
 * sends the file clears its TTL permanently through the ordinary consumption path, so
 * the hold only has to bridge upload -> first consumption. `renewMs` covers the longest
 * cadence gap (weekly) twice over; `maxLifetimeMs` bounds a schedule that never manages
 * to consume (auto-disable stops its renewals long before this ceiling).
 */
export const SCHEDULE_FILE_HOLD: { renewMs: number; maxLifetimeMs: number } = {
  renewMs: 14 * 24 * 60 * 60 * 1000,
  maxLifetimeMs: 90 * 24 * 60 * 60 * 1000,
};

export interface ScheduleFileRef {
  file_id: string;
  filepath?: string;
  filename?: string;
  type?: string;
  height?: number;
  width?: number;
  source?: string;
}

export interface ScheduleEngineDeps {
  preflightMCP: ScheduleMCPPreflight;
  methods: ScheduleMethods;
  /** Resolves interface.schedules limits, per-principal when a user is given. */
  getLimits: (user?: ScheduleUserContext) => Promise<ScheduleLimits>;
  /** Loads the owning user (id + tenant) or null when deleted/disabled. */
  getUserContext: (userId: string | Types.ObjectId) => Promise<ScheduleUserContext | null>;
  /** Whether the balance feature gates this user and they are out of credits. */
  isOutOfBalance: (user: ScheduleUserContext) => Promise<boolean>;
  /** Live agent access for the owner: 'missing' (deleted) vs 'forbidden' (ACL revoked). */
  agentAccess: (
    agentId: string,
    user: ScheduleUserContext,
  ) => Promise<'ok' | 'missing' | 'forbidden'>;
  /**
   * Whether the owner still owns the schedule's destination chat project. Projects
   * are user-owned, so 'missing' covers both deletion and a pinned id belonging to
   * someone else — the fire path treats them identically because the observable
   * outcome is the same: the conversation would be filed nowhere.
   */
  projectAccess: (projectId: string, user: ScheduleUserContext) => Promise<'ok' | 'missing'>;
  /** Whether the owning user's current role still grants SCHEDULES access. */
  hasScheduleAccess: (user: ScheduleUserContext) => Promise<boolean>;
  /** Re-resolves stored file_ids to attachment payloads; missing files are simply absent. */
  resolveFiles: (fileIds: string[], user: ScheduleUserContext) => Promise<ScheduleFileRef[]>;
  /** Persists a trusted trigger delivery before this occurrence releases its claim. */
  enqueueTrigger: (
    envelope: AgentTriggerEnvelope,
    options?: AgentTriggerEnqueueOptions,
  ) => Promise<unknown>;
  /**
   * Reads the durable trigger delivery for a reservation's `deliveryKey`, so
   * reconciliation can tell a still-live admission (`staging`/`batched`/`pending`/`leased`, which
   * a `Retry-After` can defer up to 24h) or a dead-letter (`dead`, with its `lastError`)
   * apart from a genuinely orphaned jobless run. Null when no delivery record exists.
   */
  getTriggerDelivery: (deliveryKey: string) => Promise<{
    status: AgentTriggerDeliveryStatus;
    lastError?: AgentTriggerDeliveryFailure;
  } | null>;
  /** Runs fn inside the owner's tenant ALS context. */
  runInTenantContext: <T>(user: ScheduleUserContext, fn: () => Promise<T>) => Promise<T>;
  /**
   * Job-store state for a run's conversation, or null when the job is gone. Carries
   * the job's scheduled identity so reconciliation can verify the job at this
   * conversationId is THIS occurrence's generation (a replacement user turn reuses
   * the conversationId but strips scheduleId/scheduledFor) before trusting the status.
   */
  getJobStatus: (conversationId: string) => Promise<JobState | null>;
  /** True once graceful shutdown began; fires step aside instead of dispatching. */
  isShuttingDown?: () => boolean;
  /**
   * Aborts the loopback generation for a scheduled occurrence, identity-guarded so
   * it never signals/clobbers a replacement turn that reused the conversationId.
   * Used by deletion quiescing to stop an in-flight run before its evidence is
   * erased. `preserve` keeps the terminal job for the reconciler (per-schedule
   * delete, whose run row survives to drive cleanup); account deletion passes false
   * since it hard-deletes the run rows, so a preserved job would leak in the store.
   */
  abortScheduledJob: (
    conversationId: string,
    identity: JobIdentity,
    options?: { preserve?: boolean },
  ) => Promise<boolean>;
  /**
   * Deletes a retained terminal job after the reconciler has finalized its run.
   * Identity-guarded: only deletes when the job still carries this run's
   * scheduleId/scheduledFor, so a replacement generation occupying the same
   * conversationId is never destroyed. Gives `preserveForReconcile` jobs (kept
   * without `completedAt` so the finished-job sweep can't reap them early) a
   * definitive cleanup path.
   */
  clearReconciledJob: (conversationId: string, identity: JobIdentity) => Promise<void>;
  /** Global in-flight scheduled-run count (system tenant scope) for the fire cap. */
  countActiveRunsGlobal: () => Promise<number>;
  /**
   * The GLOBAL kill switch, deliberately distinct from per-principal availability.
   * True when scheduling is stopped for the whole deployment: the SCHEDULES_DISABLED
   * env lever (works even when the config plane is unhealthy), or `interface.schedules:
   * false` in the BASE config — read base-only so no role/user/tenant override can
   * re-enable it. Checked once per engine tick, so the uncached read is negligible.
   */
  isGloballyDisabled: () => Promise<boolean>;
  /** Whether the run owner's account deletion has begun. Fail-closed (unknown == true). */
  isOwnerDeleting: (userId: string) => Promise<boolean>;
  /**
   * Runs `claim` against the lowest free GLOBAL capacity slot, retrying the next slot
   * when the unique partial index rejects a collision. Enforces fireConcurrency in the
   * database instead of via a read-then-compare count, so concurrent admissions of
   * different schedules cannot both pass a cap-1 check. Occupancy is read in system
   * scope so the cap stays global across tenants.
   */
  withGlobalCapacitySlot: <T>(
    cap: number,
    claim: (slot: number) => Promise<SlotClaimResult<T>>,
  ) => Promise<{ claimed: T } | 'capacity'>;
}

/** The immutable scheduled identity of a generation job, for reconcile/abort fencing. */
export interface JobIdentity {
  scheduleId: string;
  scheduledFor: string | Date;
}

/** Job-store state plus the job's scheduled identity (absent on a replacement turn). */
export interface JobState {
  status: string;
  checkpointNamespace?: string;
  createdAt?: number;
  scheduleId?: string;
  scheduledFor?: string;
  /** Whether the generation ever emitted its created event — false means a
   *  pre-start abort whose conversation never came to exist. */
  createdEventEmitted?: boolean;
  /** The outcome the generation owner intended to record, stamped on a retained
   *  terminal job. A generic `complete` cannot distinguish a clean run from a balance
   *  refusal or a swallowed provider failure, so reconciliation prefers this when the
   *  owner left it. See SerializableJobData.scheduleOutcome. */
  scheduleOutcome?: string;
  scheduleOutcomeError?: string;
  preserveForScheduleReconcile?: boolean;
}

export interface FireResult {
  mcp?: ScheduleMCPOutcome[];
  mcpPreflightUnavailable?: boolean;
  fired: boolean;
  conversationId?: string;
  skipped?:
    | 'overlap'
    | 'balance'
    | 'capacity'
    | 'duplicate'
    | 'superseded'
    | 'agent_deleted'
    | 'user_missing'
    | 'user_deleting'
    | 'permission_revoked'
    | 'project_deleted'
    | 'project_required'
    | 'rate_limited'
    | 'disabled';
  error?: string;
}

export type FireableSchedule = ISchedule;

export type ScheduleMCPPreflight = (
  agentId: string,
  user: ScheduleUserContext,
  options: { concurrency: number; signal?: AbortSignal; deadlineMs?: number; scheduleId?: string },
) => Promise<ScheduleMCPOutcome[]>;
