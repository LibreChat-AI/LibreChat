import { logger } from '@librechat/data-schemas';
import { createHash, randomUUID } from 'node:crypto';
import {
  createSchedulePayloadSchema,
  updateSchedulePayloadSchema,
  isCronCadence,
} from 'librechat-data-provider';
import type { TScheduleCadence, TCreateSchedule, TUpdateSchedule } from 'librechat-data-provider';
import type { ScheduleMethods, ISchedule, IScheduleRun } from '@librechat/data-schemas';
import type { Response } from 'express';
import type {
  ScheduleDeleteResult,
  ScheduleUserContext,
  FireableSchedule,
  ScheduleMCPPreflight,
  ScheduleLimits,
  FireResult,
} from './types';
import type { ServerRequest } from '~/types';
import {
  isValidCronExpression,
  cadenceIntervalMinutes,
  computeNextRunAt,
  isValidTimezone,
} from './cadence';
import { ScheduleMCPError, getScheduleMCPFailureCode } from './mcp';
import { resolveScheduleProjectId } from './types';

export interface SchedulesHandlersDeps {
  preflightMCP: ScheduleMCPPreflight;
  methods: ScheduleMethods;
  getLimits: (user?: ScheduleUserContext) => Promise<ScheduleLimits>;
  /** Agent existence + VIEW access for the requesting user. */
  canViewAgent: (agentId: string, req: ServerRequest) => Promise<boolean>;
  /** Whether the requesting user owns this chat project. Projects are user-owned,
   *  so existence and authorization are the same question. */
  canUseProject: (projectId: string, userId: string) => Promise<boolean>;
  /** Filters to file ids owned by the user. */
  filterOwnedFileIds: (fileIds: string[], userId: string) => Promise<string[]>;
  /** Extends a bounded renewable upload hold on attached files so they survive to the
   *  first fire, which consumes them permanently; a schedule that dies first lets the
   *  hold lapse instead of retaining the upload forever. Throws when any file is gone. */
  markFilesUsed: (fileIds: string[], userId: string) => Promise<void>;
  /** Serialized manual fire (acquires the schedule lease); null if already leased. */
  fireNow: (
    schedule: FireableSchedule,
    limits: ScheduleLimits,
    options?: { signal?: AbortSignal },
  ) => Promise<FireResult | null>;
  /**
   * Soft-deletes a schedule with quiescing: stops new claims, aborts in-flight
   * runs, and erases once drained. See ScheduleDeleteResult for the honest states.
   */
  deleteSchedule: (id: string, userId: string) => Promise<ScheduleDeleteResult>;
  /** Whether this user's account deletion has begun. Fail-closed (unknown == true). */
  isUserDeleting: (userId: string) => Promise<boolean>;
}

/**
 * Rolls back a create that raced past the account-deletion cascade. Hard-deletes only
 * the exact unarmed, unedited revision this attempt inserted: a concurrent same-key
 * replay can have ARMED the row — and the engine can have CLAIMED it — before the
 * post-insert barrier re-check ran, and hard deletion there would bypass run
 * quiescence and erase evidence out from under a live fire. Anything past that
 * revision is soft-deleted instead, which makes it non-claimable at once and hands it
 * to the ordinary drain-then-erase teardown. Returns false only when BOTH fail, which
 * the caller must surface rather than answering a clean 410.
 */
async function compensateLateCreate(
  deps: SchedulesHandlersDeps,
  id: string,
  userId: string,
  expectedConfigRevision: number,
): Promise<boolean> {
  const rolled = await deps.methods
    .deleteUnarmedSchedule(id, userId, expectedConfigRevision)
    .catch((err) => {
      logger.error(`[schedules] compensating delete failed for late create ${id}`, err);
      return null;
    });
  // 'draining' is compensated too: the row is soft-claimed (hidden, unclaimable) and
  // the ordinary erase-on-settle / sweep teardown finishes it once its live manual
  // run — the reason it could not erase immediately — settles.
  if (rolled === 'deleted' || rolled === 'missing' || rolled === 'draining') {
    return true;
  }
  const marked = await deps.methods.markScheduleDeleting(id, userId).catch((err) => {
    logger.error(`[schedules] compensating soft-delete failed for late create ${id}`, err);
    return null;
  });
  return marked != null;
}

/**
 * Refuses a scheduling WRITE once the owner's account deletion has begun. A one-shot
 * disable scan can never close this race (a create landing after the scan is simply not
 * in it), so admission consults the durable user-level barrier instead. Fail-closed.
 */
async function rejectIfUserDeleting(
  deps: SchedulesHandlersDeps,
  userId: string,
  res: Response,
): Promise<boolean> {
  if (!(await deps.isUserDeleting(userId))) {
    return false;
  }
  res.status(410).json({ error: 'This account is being deleted' });
  return true;
}

/** Bounded attempts to extend the upload hold on a schedule's attachments. */
const FILE_RETAIN_ATTEMPTS = 3;

/** Soft-deleted rows re-checked for erasure per list request. Small: it is a retry for
 *  a rare stranded row, not a sweep, and it rides a user-facing read. */
const DEFERRED_ERASE_RETRY_LIMIT = 5;

/**
 * Digest of a create payload's FULL intent, stamped on the row at insert and never
 * edited. Replay matching compares this immutable record instead of mutable schedule
 * state, so a PATCH (or a policy auto-disable flipping `enabled`) landing between the
 * first attempt and its retry cannot make a genuine replay read as key reuse.
 */
export function computeCreateDigest(payload: TCreateSchedule): string {
  const canonical = JSON.stringify({
    name: payload.name,
    prompt: payload.prompt,
    agent_id: payload.agent_id,
    timezone: payload.timezone,
    target: payload.target,
    enabled: payload.enabled,
    // A structured cadence keeps EXACTLY the shape it hashed under before cron
    // existed. Adding `expression: null` to it would change the canonical JSON, and
    // with it the digest, for every schedule already out there: a create that
    // committed before a deploy and lost its response would then retry against a
    // digest that no longer matches and be refused as key reuse.
    cadence: isCronCadence(payload.cadence)
      ? { frequency: 'cron' as const, expression: payload.cadence.expression }
      : {
          frequency: payload.cadence.frequency,
          hour: payload.cadence.hour,
          minute: payload.cadence.minute,
          daysOfWeek: payload.cadence.daysOfWeek ?? null,
        },
    file_ids: payload.file_ids ?? null,
    // `!== undefined`, NOT `!= null`: an OMITTED field still digests byte-identically
    // to a payload from before project scope existed, so an in-flight create retried
    // across the upgrade matches its own row — but an explicit `null` is a different
    // INTENT (clear the scope) and must digest differently. Collapsing the two let a
    // request reuse a pinned create's key with `chatProjectId: null` and receive 201
    // for the pinned row, i.e. success for the opposite of what it asked. A pre-scope
    // client never sent the field at all, so nothing legacy can carry an explicit null.
    ...(payload.chatProjectId !== undefined && { chatProjectId: payload.chatProjectId }),
  });
  return createHash('sha256').update(canonical).digest('hex');
}

function sameList<T>(left: T[] | undefined, right: T[] | undefined): boolean {
  if (left == null || right == null) {
    return (left?.length ?? 0) === (right?.length ?? 0);
  }
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

/**
 * Compares the fields that belong to the payload's cadence kind. A cron row has no
 * hour or minute and a structured row has no expression, so comparing all of them
 * unconditionally would read two identical cron rows as different (undefined vs
 * undefined is fine, but a structured row's populated hour against a cron row's
 * missing one is not) and resurface the duplicate this matching exists to prevent.
 */
function sameCadenceShape(
  existing: ISchedule['cadence'] | undefined,
  payload: TScheduleCadence,
): boolean {
  if (existing == null) {
    return false;
  }
  if (isCronCadence(payload)) {
    return isCronCadence(existing) && existing.expression === payload.expression;
  }
  return (
    !isCronCadence(existing) &&
    existing.hour === payload.hour &&
    existing.minute === payload.minute &&
    sameList(existing.daysOfWeek, payload.daysOfWeek)
  );
}

/**
 * Legacy replay matching for rows stamped before `clientRequestDigest` existed.
 * Deliberately omits `enabled` — a policy auto-disable mutates it, and this
 * comparison exists precisely because mutable state makes a poor replay record.
 */
function matchesCreatedSchedule(existing: ISchedule, payload: TCreateSchedule): boolean {
  return (
    existing.name === payload.name &&
    existing.prompt === payload.prompt &&
    existing.agent_id === payload.agent_id &&
    existing.timezone === payload.timezone &&
    existing.target === payload.target &&
    existing.cadence?.frequency === payload.cadence.frequency &&
    sameCadenceShape(existing.cadence, payload.cadence) &&
    sameList(existing.file_ids, payload.file_ids) &&
    // Only when the payload names one: an operator pin is written to the row without
    // the client ever sending it, and a legacy row predates project scope entirely.
    (payload.chatProjectId === undefined ||
      (existing.chatProjectId ?? null) === (payload.chatProjectId ?? null))
  );
}

/** Whether an existing row is the schedule this create attempt is asking for: the
 *  immutable digest when the row carries one, the legacy field comparison otherwise. */
function matchesCreateIntent(
  existing: ISchedule,
  payload: TCreateSchedule,
  digest: string,
): boolean {
  if (existing.clientRequestDigest != null) {
    return existing.clientRequestDigest === digest;
  }
  return matchesCreatedSchedule(existing, payload);
}

/** Public projection of a schedule — an allowlist of the `TSchedule` fields, so internal
 *  bookkeeping (_id, tenantId, __v, claimToken, lease*, slot, deleting, countedFor,
 *  balanceSkipCount, bookkept, ...) never reaches the browser. */
export type WireSchedule = Pick<
  ISchedule,
  | 'id'
  | 'user'
  | 'name'
  | 'prompt'
  | 'agent_id'
  | 'cadence'
  | 'timezone'
  | 'target'
  | 'chatProjectId'
  | 'file_ids'
  | 'enabled'
  | 'disabledReason'
  | 'nextRunAt'
  | 'lastRun'
  | 'runCount'
  | 'failureCount'
  | 'configRevision'
  | 'createdAt'
  | 'updatedAt'
> & {
  /** See `TSchedule.inFlight`: the generating occurrences, from their own run rows. */
  inFlight?: Array<{ conversationId: string }>;
};

/** Only generating occurrences are read for the list. `ScheduleRun` is indexed by
 *  status, not by user, and `started` rows are bounded globally by the capacity
 *  slots; `requires_action` rows accumulate for as long as their approvals wait. */
export const LISTED_RUN_STATUSES: readonly IScheduleRun['status'][] = ['started'];

/**
 * The chats a schedule's generating occurrences are producing. A reservation that
 * has not been dispatched yet carries no conversation id, and there is nothing to
 * look for until it does.
 */
export function toWireInFlight(
  runs: readonly IScheduleRun[],
): Array<{ conversationId: string }> | undefined {
  const chats = runs.flatMap((run) =>
    run.conversationId != null ? [{ conversationId: run.conversationId }] : [],
  );
  return chats.length > 0 ? chats : undefined;
}

function inFlightBySchedule(runs: readonly IScheduleRun[]): Map<string, IScheduleRun[]> {
  const grouped = new Map<string, IScheduleRun[]>();
  for (const run of runs) {
    const list = grouped.get(run.scheduleId);
    if (list) {
      list.push(run);
    } else {
      grouped.set(run.scheduleId, [run]);
    }
  }
  return grouped;
}

/**
 * Public projection. `limits` is optional only for callers that have none to hand;
 * pass it wherever one is available so the card shows the destination a fire would
 * ACTUALLY use — an operator pin added after a row was written outranks its stored
 * id at fire time, and a projection reading the raw field would name the wrong
 * project until the owner next edits the schedule.
 */
export function toWireSchedule(
  schedule: ISchedule,
  limits?: Pick<ScheduleLimits, 'projectId'>,
  inFlight: readonly IScheduleRun[] = [],
): WireSchedule {
  return {
    id: schedule.id,
    user: schedule.user,
    name: schedule.name,
    prompt: schedule.prompt,
    agent_id: schedule.agent_id,
    cadence: schedule.cadence,
    timezone: schedule.timezone,
    target: schedule.target,
    chatProjectId: resolveScheduleProjectId(limits ?? {}, schedule.chatProjectId),
    file_ids: schedule.file_ids,
    enabled: schedule.enabled,
    disabledReason: schedule.disabledReason,
    nextRunAt: schedule.nextRunAt,
    lastRun: schedule.lastRun,
    runCount: schedule.runCount,
    failureCount: schedule.failureCount,
    configRevision: schedule.configRevision,
    createdAt: schedule.createdAt,
    updatedAt: schedule.updatedAt,
    ...(inFlight.length > 0 && { inFlight: toWireInFlight(inFlight) }),
  };
}

function requestUser(req: ServerRequest): { id: string; tenantId?: string; role?: string } {
  const user = req.user as { id: string; tenantId?: string; role?: string };
  return { id: user.id, tenantId: user.tenantId, role: user.role };
}

type ScheduleHandler = (req: ServerRequest, res: Response) => Promise<void>;

export interface SchedulesHandlers {
  listSchedules: ScheduleHandler;
  getSchedule: ScheduleHandler;
  createSchedule: ScheduleHandler;
  updateSchedule: ScheduleHandler;
  deleteSchedule: ScheduleHandler;
  runScheduleNow: ScheduleHandler;
}

export function createSchedulesHandlers(deps: SchedulesHandlersDeps): SchedulesHandlers {
  /**
   * Wellformedness only: is this payload storable at all. Anything that depends on
   * CURRENT policy, like the interval floor, is deliberately not here, because this
   * runs before an idempotent create can resolve its existing row and a policy change
   * would then refuse a retry of a schedule that already committed.
   *
   * `storedTimezone` is the row's own, for a PATCH that edits the cadence and leaves
   * the timezone alone. Without it the cron below was validated against `undefined`,
   * i.e. UTC, while the schedule actually runs in its stored zone.
   */
  /**
   * The interval floor, which is policy AT THIS MOMENT rather than a property of the
   * payload. Applied only once a create is known to be a genuinely new row: an admin
   * raising the floor between a create committing and its lost response being retried
   * must not turn that retry into a 400 for a schedule that already exists.
   */
  function withinIntervalFloor(
    res: Response,
    cadence: TScheduleCadence,
    timezone: string,
    limits: ScheduleLimits,
  ): boolean {
    if (cadenceIntervalMinutes(cadence, timezone) >= limits.minIntervalMinutes) {
      return true;
    }
    res.status(400).json({
      error: `Schedule interval must be at least ${limits.minIntervalMinutes} minutes`,
    });
    return false;
  }

  function responseAbortSignal(req: ServerRequest, res: Response): AbortSignal {
    const controller = new AbortController();
    const abort = () => controller.abort(new Error('Schedule request closed'));
    const detach = () => {
      req.off?.('aborted', abort);
      res.off?.('close', abort);
    };
    req.once?.('aborted', abort);
    res.once?.('close', abort);
    res.once?.('finish', detach);
    if (req.aborted === true || res.destroyed === true) abort();
    return controller.signal;
  }

  async function validateMCP(
    agentId: string,
    req: ServerRequest,
    res: Response,
    signal: AbortSignal,
    limits: ScheduleLimits,
    scheduleId: string,
  ): Promise<boolean> {
    try {
      await deps.preflightMCP(agentId, requestUser(req), {
        scheduleId,
        signal,
        concurrency: limits.mcpPreflightConcurrency,
        deadlineMs: Date.now() + limits.mcpPreflightTimeoutMs,
      });
      return true;
    } catch (error) {
      if (signal.aborted) return false;
      if (error instanceof ScheduleMCPError) {
        res.status(error.code === 'mcp_unavailable' ? 503 : 400).json({
          code: error.code,
          error: error.message,
          mcp: error.outcomes,
        });
      } else {
        res.status(503).json({ code: 'mcp_unavailable', error: 'MCP preflight unavailable' });
      }
      return false;
    }
  }

  async function validatePayload(
    req: ServerRequest,
    res: Response,
    payload: TCreateSchedule | TUpdateSchedule,
    limits: ScheduleLimits,
    storedTimezone?: string,
  ): Promise<boolean> {
    if (payload.timezone != null && !isValidTimezone(payload.timezone)) {
      res.status(400).json({ error: 'Invalid IANA timezone' });
      return false;
    }
    const timezone = payload.timezone ?? storedTimezone;
    // Rejected here rather than left to `computeNextRunAt` returning null, which the
    // engine reads as an unreadable cadence and disables, giving the user a saved
    // schedule that never fires.
    if (
      payload.cadence != null &&
      isCronCadence(payload.cadence) &&
      !isValidCronExpression(payload.cadence.expression, timezone)
    ) {
      res.status(400).json({ error: 'Invalid cron expression' });
      return false;
    }

    if (payload.agent_id != null && !(await deps.canViewAgent(payload.agent_id, req))) {
      res.status(400).json({ error: 'Agent not found or not accessible' });
      return false;
    }
    if (payload.file_ids != null && payload.file_ids.length > 0) {
      const owned = await deps.filterOwnedFileIds(payload.file_ids, requestUser(req).id);
      if (owned.length !== payload.file_ids.length) {
        res.status(400).json({ error: 'One or more attached files were not found' });
        return false;
      }
    }
    return true;
  }

  /**
   * The destination project a write commits, or `false` when the write was refused
   * (the response is already sent). `undefined` is a real value: an unscoped create,
   * or an update that explicitly cleared the scope.
   *
   * Deliberately resolved from the SAME {@link resolveScheduleProjectId} the fire path
   * uses, so a schedule this handler accepts is one the next fire also accepts —
   * the create/fire precheck symmetry `resolveAgentFireAccess` already establishes
   * for agents.
   */
  async function resolveWriteProject(
    res: Response,
    userId: string,
    limits: ScheduleLimits,
    requested: string | null | undefined,
    stored?: string,
    /** Lets a DISABLING edit skip the requirement while still refusing a destination
     *  that disagrees with a pin — the two rules are independent, and folding them
     *  together let an explicit clear slip past the pin check entirely. */
    options?: { enforceRequirement?: boolean },
  ): Promise<string | undefined | false> {
    // A pin is the ONLY destination. An OMITTED field takes it silently (the client has
    // no choice to make), but anything explicit that disagrees is refused rather than
    // quietly rewritten — including `null`, which the payload contract defines as
    // clearing the scope. Answering 201/200 to an explicit clear while filing the
    // schedule under the pin reports success for the opposite of what was asked.
    if (limits.projectId != null && requested !== undefined && requested !== limits.projectId) {
      res.status(400).json({ error: 'Scheduled chats are pinned to a specific project' });
      return false;
    }
    const chatProjectId = resolveScheduleProjectId(
      limits,
      requested === undefined ? stored : requested,
    );
    if (chatProjectId == null) {
      if (limits.requireProject && options?.enforceRequirement !== false) {
        res.status(400).json({ error: 'Scheduled chats must be assigned to a project' });
        return false;
      }
      return undefined;
    }
    // Re-checked even when it only came from storage: the hold is bounded by the
    // project's lifetime, not by whether this request touched the field, and an
    // edit that leaves a schedule pointing at a deleted project would otherwise
    // succeed and then be auto-disabled by its very next fire.
    if (!(await deps.canUseProject(chatProjectId, userId))) {
      res.status(400).json({
        error:
          limits.projectId != null
            ? 'The configured schedules project was not found'
            : 'Project not found',
      });
      return false;
    }
    return chatProjectId;
  }

  /**
   * Extends the bounded upload hold on attached files (so they survive to the first
   * fire, which consumes them permanently), with bounded retry. Returns false when it
   * exhausts retries — the caller then compensates (roll back the create / revert the
   * edit) so a persisted schedule never references files the upload sweep is about to
   * reap.
   */
  async function retainFiles(fileIds: string[], userId: string): Promise<boolean> {
    for (let attempt = 1; attempt <= FILE_RETAIN_ATTEMPTS; attempt++) {
      try {
        await deps.markFilesUsed(fileIds, userId);
        return true;
      } catch (err) {
        logger.error(
          `[schedules] attachment retention failed (attempt ${attempt}/${FILE_RETAIN_ATTEMPTS}):`,
          err,
        );
      }
    }
    return false;
  }

  /**
   * Re-drives the FULL deletion of the caller's soft-deleted schedules, off the
   * response path.
   *
   * A `deleting` row is settled and erased by the delete request itself, or by the
   * terminal outcome write (erase-on-settle). Both are best-effort, and the
   * reconciler that would otherwise retry does not exist in the clustered
   * entrypoint. Meanwhile the row is HIDDEN from the owner's list, so once a delete
   * answers 503-unconfirmed there is no UI/API-list handle left to retry the drain
   * with — the "please retry" the response asks for has nothing to click.
   *
   * A read the owner performs anyway is therefore the re-driver: bounded, scoped to
   * their own rows, a no-op when nothing is deleting. Re-driving the WHOLE delete
   * (abort, settle, erase) rather than only the erase is what un-strands a row whose
   * active run never settled; every step is idempotent and evidence-guarded, so
   * repeated polls race harmlessly.
   */
  function retryDeferredDeletions(userId: string): void {
    void deps.methods
      .getDeletingScheduleIds(userId, DEFERRED_ERASE_RETRY_LIMIT)
      .then(async (ids) => {
        if (ids.length === 0) {
          return;
        }
        // Stamp BEFORE attempting: the read window is least-recently-attempted
        // first, so rows this pass touches rotate to the back and an owner with
        // more stuck rows than the limit reaches all of them across successive
        // lists instead of re-driving the same unconfirmable few forever.
        await deps.methods.markEraseAttempted(ids);
        await Promise.all(
          ids.map((id) => deps.deleteSchedule(id, userId).catch(() => 'unconfirmed')),
        );
      })
      .catch((err) => logger.warn('[schedules] deferred deletion retry failed', err));
  }

  async function listSchedules(req: ServerRequest, res: Response): Promise<void> {
    const user = requestUser(req);
    // Three independent, user-scoped reads; the generating runs ride alongside so
    // the list can name the chat each one is producing without a second round trip
    // per card.
    const [schedules, limits, inFlight] = await Promise.all([
      deps.methods.getSchedulesByUser(user.id),
      deps.getLimits(user),
      deps.methods.getActiveRunsForUser(user.id, LISTED_RUN_STATUSES),
    ]);
    const inFlightBySchedule_ = inFlightBySchedule(inFlight);
    retryDeferredDeletions(user.id);
    res.json({
      schedules: schedules.map((schedule) =>
        toWireSchedule(schedule, limits, inFlightBySchedule_.get(schedule.id)),
      ),
      limits: {
        maxPerUser: limits.maxPerUser,
        // minIntervalMinutes ships with the list so the dialog can refuse a cadence
        // the floor would reject, instead of surfacing it as a 400 after submit.
        minIntervalMinutes: limits.minIntervalMinutes,
        requireProject: limits.requireProject,
        ...(limits.projectId != null && { projectId: limits.projectId }),
      },
    });
  }

  async function getSchedule(req: ServerRequest, res: Response): Promise<void> {
    const { id } = req.params as { id: string };
    const user = requestUser(req);
    // The run read starts before ownership is established, so it is scoped to the
    // caller — the same user-bound query the list uses — and narrowed here, rather
    // than a by-schedule read that would touch rows the caller may not own.
    const [schedule, limits, inFlight] = await Promise.all([
      deps.methods.getScheduleById(id, user.id),
      deps.getLimits(user),
      deps.methods.getActiveRunsForUser(user.id, LISTED_RUN_STATUSES),
    ]);
    if (schedule == null) {
      res.status(404).json({ error: 'Schedule not found' });
      return;
    }
    res.json(
      toWireSchedule(
        schedule,
        limits,
        inFlight.filter((run) => run.scheduleId === id),
      ),
    );
  }

  async function createSchedule(req: ServerRequest, res: Response): Promise<void> {
    const mcpSignal = responseAbortSignal(req, res);
    if (mcpSignal.aborted) return;
    const parsed = createSchedulePayloadSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid schedule payload', issues: parsed.error.issues });
      return;
    }
    const user = requestUser(req);
    if (await rejectIfUserDeleting(deps, user.id, res)) {
      return;
    }
    const limits = await deps.getLimits(user);
    if (!limits.enabled) {
      res.status(403).json({ error: 'Scheduled chats are disabled' });
      return;
    }
    if (!(await validatePayload(req, res, parsed.data, limits))) {
      return;
    }
    // Digested from the CLIENT's payload, never from the policy-resolved destination:
    // the digest records one create INTENT, and today's policy is not part of that
    // intent. Resolving first made an operator's pin change (or a deleted project)
    // re-digest a genuine retry into a mismatch.
    const digest = computeCreateDigest(parsed.data);

    /**
     * Answers a retry with the row its FIRST attempt committed — an ESTABLISHED
     * schedule this attempt must never reshape. Re-drives only the arm (guarded:
     * only-if-still-unarmed, jitter derived from the EXISTING row's id, no claim-token
     * rotation or revision bump, so an active run is never fenced off), and never
     * compensates: rollback belongs exclusively to the attempt that inserted a row.
     */
    const respondToReplay = async (existing: ISchedule): Promise<void> => {
      // A key identifies one create INTENT. Reusing it for different content is a
      // client bug, and silently returning the first row would hide it behind a 201
      // describing a schedule the caller did not ask for — so say so instead.
      if (!matchesCreateIntent(existing, parsed.data, digest)) {
        res.status(409).json({
          error: 'clientRequestId was already used to create a different schedule',
        });
        return;
      }
      // The key stays claimed while its row drains (the unique index spans deleting
      // rows), so a retry of a create whose schedule was since deleted resolves here.
      if (existing.deleting === true) {
        res.status(410).json({ error: 'Schedule no longer exists' });
        return;
      }
      if (await deps.isUserDeleting(user.id)) {
        res.status(410).json({ error: 'This account is being deleted' });
        return;
      }
      if (existing.enabled && existing.nextRunAt == null) {
        const next = computeNextRunAt({
          cadence: existing.cadence,
          timezone: existing.timezone,
          scheduleId: existing.id,
        });
        if (next != null) {
          try {
            await deps.methods.armSchedule(existing.id, next);
          } catch (armError) {
            logger.error(`[schedules] replay arming failed for ${existing.id}`, armError);
            res.status(500).json({ error: 'Failed to create schedule. Please retry.' });
            return;
          }
        }
      }
      const fresh = await deps.methods.getScheduleById(existing.id, user.id);
      if (fresh == null) {
        res.status(410).json({ error: 'Schedule no longer exists' });
        return;
      }
      logger.info(`[schedules] create retry resolved to ${existing.id} for user ${user.id}`);
      res.status(201).json(toWireSchedule(fresh, limits));
    };

    // Resolve a retry BEFORE the capacity pre-check: a retry whose first attempt
    // already occupies the final slot is a replay of THAT row, not a request for a
    // new one — refusing it as over-limit would deny the client the very row it is
    // trying to confirm.
    const replayed = await deps.methods.getScheduleByClientRequestId(
      user.id,
      parsed.data.clientRequestId,
    );
    if (mcpSignal.aborted) return;
    if (replayed != null) {
      await respondToReplay(replayed);
      return;
    }
    const id = `sched_${randomUUID()}`;
    if (
      parsed.data.enabled &&
      !(await validateMCP(parsed.data.agent_id, req, res, mcpSignal, limits, id))
    )
      return;
    // Project policy applies to a NEW insert only, and is therefore resolved AFTER every
    // replay lookup above. A committed create whose response was lost must still be
    // recoverable by an identical retry: applying today's policy first let a raised
    // requirement, a deleted project, or a moved pin answer 400 for a row that already
    // exists — pushing the client to rotate its key and create a duplicate schedule,
    // which is precisely what the idempotency key exists to prevent.
    const chatProjectId = await resolveWriteProject(
      res,
      user.id,
      limits,
      parsed.data.chatProjectId,
    );
    if (chatProjectId === false) {
      return;
    }
    // Fail fast on an obvious over-limit BEFORE retaining attachments, so the common
    // case never clears an upload TTL it then can't use. The {user, slot} partial
    // unique index below is the atomic arbiter for the concurrent-create race.
    if ((await deps.methods.countSchedulesByUser(user.id)) >= limits.maxPerUser) {
      // A concurrent first attempt with this key can have landed between the replay
      // lookup above and this count — and can itself be what filled the last slot.
      // The retry must resolve to that row, not be refused for being at capacity.
      const raced = await deps.methods.getScheduleByClientRequestId(
        user.id,
        parsed.data.clientRequestId,
      );
      if (raced != null) {
        await respondToReplay(raced);
        return;
      }
      res.status(400).json({
        error: `Schedule limit reached (${limits.maxPerUser}). Delete a schedule to add another.`,
      });
      return;
    }
    // Past the replay lookup, so this is a genuinely new row and the current floor
    // applies to it. BEFORE the next-run computation below, which is a croner walk
    // wasted on a request this check refuses.
    if (!withinIntervalFloor(res, parsed.data.cadence, parsed.data.timezone, limits)) {
      return;
    }
    const nextRunAt = parsed.data.enabled
      ? computeNextRunAt({
          cadence: parsed.data.cadence,
          timezone: parsed.data.timezone,
          scheduleId: id,
        })
      : undefined;
    // Retain attachments BEFORE creating, so a persisted (claimable) schedule never
    // references uploads still eligible for TTL expiry: that leaves no create-then-
    // retain window where a crash or a failed rollback makes the two inconsistent.
    // AFTER the floor check, for the same reason the capacity pre-check runs early:
    // it is deterministic, so retaining first meant every retry of the same rejected
    // payload extended the TTL of uploads no schedule will ever reference.
    if (parsed.data.file_ids?.length && !(await retainFiles(parsed.data.file_ids, user.id))) {
      res.status(500).json({ error: 'Failed to retain schedule attachments' });
      return;
    }
    if (mcpSignal.aborted) return;
    // Atomic cap: createScheduleWithSlot claims a free per-user slot via the
    // {user, slot} partial unique index, so concurrent creates can never exceed
    // maxPerUser. 'limit' means a concurrent racer took the last slot after the
    // pre-check above; the just-retained files are then unreferenced (a rare, minor
    // leak of the user's own uploads) — acceptable vs. a partial/expiring commit.
    // Inserted WITHOUT nextRunAt regardless of `enabled`: the engine claims by
    // nextRunAt, so the row is inert until armed below. That is what makes the
    // barrier re-check durable — every failure mode leaves a row that cannot fire,
    // rather than one that fires for an account already being erased. The reconciler's
    // unarmed sweep later arms anything left this way, so an inert row is a delay, not
    // a permanent state.
    const created = await deps.methods.createScheduleWithSlot(
      {
        ...parsed.data,
        chatProjectId: chatProjectId ?? undefined,
        id,
        user: user.id as never,
        tenantId: user.tenantId,
        clientRequestDigest: digest,
      },
      limits.maxPerUser,
    );
    if (created === 'limit') {
      // A CONCURRENT first attempt with this key can be what filled the last slot;
      // resolve to it rather than refusing the retry for being at capacity.
      const raced = await deps.methods.getScheduleByClientRequestId(
        user.id,
        parsed.data.clientRequestId,
      );
      if (raced != null) {
        await respondToReplay(raced);
        return;
      }
      res.status(400).json({
        error: `Schedule limit reached (${limits.maxPerUser}). Delete a schedule to add another.`,
      });
      return;
    }
    if (created.id !== id) {
      // The allocator hit the idempotency index: a concurrent attempt with this key
      // committed first. That row is established — hand it to the replay path.
      await respondToReplay(created);
      return;
    }
    // FRESH insert (this attempt owns the row) from here down; compensation is safe.
    //
    // POST-INSERT barrier re-check. The admission check at the top of this handler
    // shrinks the window to roughly one request, but cannot close it: account deletion
    // can raise the barrier after we passed that check and before this insert landed,
    // and its one-shot disable scan would not have seen a row that did not exist yet.
    // Re-checking AFTER the write is what makes the barrier authoritative.
    if (await deps.isUserDeleting(user.id)) {
      // Best-effort tidy-up. Hard-deletes only the exact unarmed revision this
      // attempt inserted (a concurrent replay can have armed it, and the engine can
      // have claimed the armed row); anything past that is soft-deleted into the
      // ordinary drain-then-erase teardown. Its failure is reported but no longer
      // load-bearing for BILLING: even once the reconciler's sweep arms a residual
      // row, the fire path refuses it at the account-deletion barrier
      // (isOwnerDeleting). The residual is a retained row, not a billed generation.
      if (!(await compensateLateCreate(deps, id, user.id, created.configRevision ?? 0))) {
        res.status(500).json({ error: 'Failed to roll back schedule creation' });
        return;
      }
      res.status(410).json({ error: 'This account is being deleted' });
      return;
    }
    // ARM last, through the SAME unarmed-guarded CAS the replay path and the
    // reconciler's sweep use — one arming write per schedule, ever. Fenced on the
    // revision stamped at insert: a PATCH racing this arm bumps configRevision, and
    // this POST must not overwrite the nextRunAt that PATCH derived from newer
    // config. Never updateScheduleById here: its claim-token rotation would fence an
    // occurrence the engine may have claimed off a row a concurrent replay armed
    // first, and its revision bump would break a concurrent PATCH's CAS.
    if (nextRunAt) {
      let armedNow: boolean;
      try {
        armedNow = await deps.methods.armSchedule(id, nextRunAt, created.configRevision ?? 0);
      } catch (armError) {
        // Roll back ONLY the exact unarmed, unedited revision this attempt inserted.
        // An ambiguously-committed arm, a concurrent replay that armed the row and
        // already answered 201, or a concurrent PATCH that edited it (even while
        // leaving it unarmed) all leave a row that must survive.
        logger.error(`[schedules] arming failed for ${id}; rolling back the create`, armError);
        const rolledBack = await deps.methods
          .deleteUnarmedSchedule(id, user.id, created.configRevision ?? 0)
          .catch(() => null);
        if (rolledBack === 'kept') {
          const current = await deps.methods.getScheduleById(id, user.id);
          if (current != null) {
            res.status(201).json(toWireSchedule(current, limits));
            return;
          }
        }
        // A retry is always safe: the same key collides on the idempotency index and
        // resolves to whatever this attempt left behind (or a clean re-insert).
        res.status(500).json({ error: 'Failed to create schedule. Please retry.' });
        return;
      }
      // Whether THIS call armed or a concurrent actor got there first (a replay's
      // arm, a PATCH whose own arming governs), the response reports the row as it
      // now stands; only a row the deletion cascade claimed answers 410.
      const current = await deps.methods.getScheduleById(id, user.id);
      if (current == null) {
        res.status(410).json({ error: 'Schedule no longer exists' });
        return;
      }
      if (!armedNow && current.nextRunAt == null && current.enabled) {
        // Unarmed with an unmoved revision would have matched the CAS; reaching here
        // means the revision moved to an edit that keeps it enabled but unarmed —
        // report it as-is, the reconciler's sweep recovers the arm.
        logger.warn(`[schedules] create for ${id} left unarmed after a concurrent edit`);
      }
      logger.info(`[schedules] created ${id} for user ${user.id}`);
      res.status(201).json(toWireSchedule(current, limits));
      return;
    }
    logger.info(`[schedules] created ${id} for user ${user.id}`);
    res.status(201).json(toWireSchedule(created, limits));
  }

  async function updateSchedule(req: ServerRequest, res: Response): Promise<void> {
    const mcpSignal = responseAbortSignal(req, res);
    if (mcpSignal.aborted) return;
    const parsed = updateSchedulePayloadSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid schedule payload', issues: parsed.error.issues });
      return;
    }
    // The fence input is not a schedule field: strip it before the emptiness check
    // and the update spread below, or it would count as an edit and be written to
    // the row.
    const { expectedConfigRevision, ...editedFields } = parsed.data;
    // A field-less PATCH is not a harmless no-op: updateScheduleById rotates the claim
    // token and bumps the config revision on every write, so an empty update would
    // fence a legitimate in-flight occurrence — its terminal bookkeeping revision-
    // fences to a no-op, and a fire in the POST-to-controller window is refused at
    // the admission boundary without ever running. Refuse before touching fencing.
    if (Object.keys(editedFields).length === 0) {
      res.status(400).json({ error: 'Schedule update must include at least one field' });
      return;
    }
    const { id } = req.params as { id: string };
    const user = requestUser(req);
    if (await rejectIfUserDeleting(deps, user.id, res)) {
      return;
    }
    const existing = await deps.methods.getScheduleById(id, user.id);
    if (mcpSignal.aborted) return;
    if (existing == null) {
      res.status(404).json({ error: 'Schedule not found' });
      return;
    }
    // Client-side revision fence: the dialog rebuilds compound fields (cadence)
    // from the snapshot it opened with, so an edit from another tab is invisible
    // to the fresh-read fence below — the payload is internally consistent with a
    // row that no longer exists. Refuse before any side effect (file holds) when
    // the client says which revision it edited.
    if (expectedConfigRevision != null && existing.configRevision !== expectedConfigRevision) {
      res.status(409).json({ error: 'Schedule was modified concurrently. Please retry.' });
      return;
    }
    const limits = await deps.getLimits(user);
    // When the owner's config disables schedules, block edits that keep the
    // schedule enabled; still allow turning one OFF.
    if (!limits.enabled && (parsed.data.enabled ?? existing.enabled)) {
      res.status(403).json({ error: 'Scheduled chats are disabled' });
      return;
    }
    if (!(await validatePayload(req, res, parsed.data, limits, existing.timezone))) {
      return;
    }
    const cadence = parsed.data.cadence ?? existing.cadence;
    const timezone = parsed.data.timezone ?? existing.timezone;
    const enabled = parsed.data.enabled ?? existing.enabled;
    // Timing is the CADENCE AND THE ZONE it is read in: the same expression is a
    // different schedule in another zone, and `0 0,12 * * *` moved from UTC into
    // America/New_York goes from a 12-hour gap to an 11-hour one on spring-forward
    // day. A timezone-only PATCH therefore faces the floor exactly as a cadence one
    // does, whatever the row's enabled state; checking only a SUBMITTED cadence let a
    // disabled row be retimed under the floor and rejected later at enable.
    const timingChanged = parsed.data.cadence != null || parsed.data.timezone != null;
    // Measured on the EFFECTIVE pair, so a bare {enabled:true} still cannot re-enable
    // a schedule that now runs too often, and a pure rename of a disabled row below a
    // raised floor is still left alone: it changes no timing and the API accepts it.
    if ((timingChanged || enabled) && !withinIntervalFloor(res, cadence, timezone, limits)) {
      return;
    }
    // A supplied agent_id is validated in validatePayload; when an edit omits it
    // but leaves the schedule enabled (e.g. toggling `enabled` back on after an
    // agent_deleted/permission_revoked auto-disable), re-validate the STORED
    // agent too. Otherwise re-enabling clears disabledReason for a target the
    // next fire would immediately reject and disable again.
    if (
      enabled &&
      parsed.data.agent_id == null &&
      !(await deps.canViewAgent(existing.agent_id, req))
    ) {
      res.status(400).json({ error: 'Agent not found or not accessible' });
      return;
    }
    if (
      enabled &&
      !(await validateMCP(
        parsed.data.agent_id ?? existing.agent_id,
        req,
        res,
        mcpSignal,
        limits,
        existing.id,
      ))
    )
      return;
    // The destination is re-resolved on every edit that leaves the schedule ENABLED,
    // against the stored id when this PATCH does not touch the field — the same shape
    // as the stored-agent and effective-cadence rechecks above, and for the same
    // reason: an edit that "succeeds" into a state the next fire auto-disables is not
    // a success. A disabling edit skips the requirement so a schedule stopped by a
    // project_required/project_deleted auto-disable can still be turned off or renamed.
    let chatProjectId: string | undefined;
    if (enabled) {
      const resolved = await resolveWriteProject(
        res,
        user.id,
        limits,
        parsed.data.chatProjectId,
        existing.chatProjectId,
      );
      if (resolved === false) {
        return;
      }
      chatProjectId = resolved;
    } else if (parsed.data.chatProjectId !== undefined) {
      // `!== undefined`, so an explicit `null` lands here too: a pin disagreement is
      // refused whether the edit assigns a different project or clears the scope
      // outright. Only the REQUIREMENT is waived for a disabling edit — without that
      // distinction a pinned deployment accepted `{enabled: false, chatProjectId: null}`
      // and unset the row while still reporting the pin back on the wire.
      const resolved = await resolveWriteProject(
        res,
        user.id,
        limits,
        parsed.data.chatProjectId,
        undefined,
        { enforceRequirement: false },
      );
      if (resolved === false) {
        return;
      }
      chatProjectId = resolved;
    }
    const cadenceChanged =
      parsed.data.cadence != null || parsed.data.timezone != null || parsed.data.enabled != null;
    const reEnabled = parsed.data.enabled === true && existing.enabled === false;
    // RECOVERY: an enabled schedule with no nextRunAt is inert — claimDueSchedule sorts
    // on nextRunAt and can never select it. Creation arms in a second write, so a crash
    // or a failed arm leaves exactly this state; re-arm on ANY edit rather than only a
    // cadence one, or a name/prompt edit would silently leave it dead.
    const needsArming = existing.nextRunAt == null;
    const update: Partial<ISchedule> = { ...editedFields } as Partial<ISchedule>;
    // `chatProjectId` is resolved, not copied: an operator pin rewrites it even when
    // this PATCH never mentioned the field, so the row converges on the policy
    // instead of drifting until the owner happens to touch the picker.
    delete (update as { chatProjectId?: unknown }).chatProjectId;
    // ONLY an explicit `null` clears the scope. A disabling edit resolves nothing and
    // must leave the stored destination intact, or turning a schedule off would
    // silently forget where its runs used to land.
    const clearsProject = parsed.data.chatProjectId === null && chatProjectId == null;
    if (chatProjectId != null) {
      update.chatProjectId = chatProjectId;
    }
    if (enabled && (cadenceChanged || needsArming)) {
      const nextRunAt = computeNextRunAt({ cadence, timezone, scheduleId: existing.id });
      if (nextRunAt == null) {
        res.status(400).json({ error: 'Schedule has no computable next run' });
        return;
      }
      update.nextRunAt = nextRunAt;
    }
    if (reEnabled) {
      update.failureCount = 0;
      update.balanceSkipCount = 0;
    }
    const unset =
      reEnabled || clearsProject
        ? {
            ...(reEnabled && { disabledReason: 1 as const }),
            ...(clearsProject && { chatProjectId: 1 as const }),
          }
        : undefined;
    // Retain the new attachments BEFORE committing the edit, so a retention failure
    // leaves the ENTIRE schedule unchanged rather than persisting prompt/cadence/
    // agent/enabled changes while only reverting file_ids. A file whose TTL was
    // cleared before the edit failed simply persists unreferenced (the user's own
    // upload) — a minor leak, not a partial config change future runs would use.
    if (parsed.data.file_ids?.length && !(await retainFiles(parsed.data.file_ids, user.id))) {
      res.status(500).json({ error: 'Failed to retain schedule attachments' });
      return;
    }
    // Re-enabling with STORED attachments: the bounded upload hold only renews while
    // the schedule fires, so a schedule that sat disabled past the hold can have lost
    // its uploads. Validate the effective list and renew its hold now, mirroring the
    // stored-agent recheck above — otherwise the re-enable succeeds and the next run
    // silently fires without the missing files instead of telling the user to
    // replace them.
    if (reEnabled && parsed.data.file_ids == null && existing.file_ids?.length) {
      // Deduped before the count comparison: the ownership query returns one doc
      // per unique id, so a legacy row holding the same id twice would otherwise
      // read as a missing file. New payloads are deduped at the schema.
      const storedIds = Array.from(new Set(existing.file_ids));
      const stillOwned = await deps.filterOwnedFileIds(storedIds, user.id);
      if (stillOwned.length !== storedIds.length) {
        res.status(400).json({
          error:
            'One or more attached files are no longer available. Replace the attachments before re-enabling.',
        });
        return;
      }
      if (!(await retainFiles(storedIds, user.id))) {
        res.status(500).json({ error: 'Failed to retain schedule attachments' });
        return;
      }
    }
    if (mcpSignal.aborted) return;
    // FENCED on the revision this edit was computed from. `nextRunAt` above is derived
    // from (cadence, timezone) resolved against the row read at the top of this handler,
    // so two overlapping edits — one changing cadence, one changing timezone — would
    // each persist a nextRunAt consistent with neither final state, and it would stay
    // wrong until the next edit (advanceSchedule recomputes from the row, so a fire
    // propagates the bad occurrence rather than repairing it). configRevision is already
    // the row's edit generation and is $inc'd inside the same atomic update, so the
    // loser simply retries against fresh state.
    const schedule = await deps.methods.updateScheduleById(existing.id, user.id, update, unset, {
      expectedConfigRevision: existing.configRevision,
    });
    if (schedule == null) {
      // Either the row is gone, or a concurrent edit moved the revision. Distinguish
      // them so the owner sees a retryable conflict rather than a phantom 404.
      const stillThere = await deps.methods.getScheduleById(existing.id, user.id);
      if (stillThere != null) {
        res.status(409).json({ error: 'Schedule was modified concurrently. Please retry.' });
        return;
      }
      res.status(404).json({ error: 'Schedule not found' });
      return;
    }
    res.json(toWireSchedule(schedule, limits));
  }

  async function deleteSchedule(req: ServerRequest, res: Response): Promise<void> {
    const { id } = req.params as { id: string };
    // Quiesce-then-erase: disable + mark deleting (stops new claims, hides it),
    // abort in-flight loopback jobs, and erase once drained — so a live run's
    // evidence is never destroyed out from under it.
    const result = await deps.deleteSchedule(id, requestUser(req).id);
    if (result === 'not_found') {
      res.status(404).json({ error: 'Schedule not found' });
      return;
    }
    // HONEST failure: at least one active run could not be confirmed stopped, so its
    // generation may still be producing and billing. The schedule is already hidden
    // and fenced (no new claims), and the delete is idempotent — a retry re-runs the
    // drain. Reporting success here would claim the run was stopped.
    if (result === 'unconfirmed') {
      res.set('Retry-After', '30');
      res.status(503).json({
        error: 'Could not confirm the active run was stopped. Please retry shortly.',
      });
      return;
    }
    // 202 for `draining`: the aborts were delivered but a generation has not yet
    // recorded its terminal outcome. The schedule is hidden and erasure follows the
    // settlement (erase-on-settle), in any topology.
    res.status(result === 'draining' ? 202 : 200).json({ id });
  }

  async function runScheduleNow(req: ServerRequest, res: Response): Promise<void> {
    const signal = responseAbortSignal(req, res);
    if (signal.aborted) return;
    const { id } = req.params as { id: string };
    if (await rejectIfUserDeleting(deps, requestUser(req).id, res)) {
      return;
    }
    const schedule = await deps.methods.getScheduleById(id, requestUser(req).id);
    if (schedule == null) {
      res.status(404).json({ error: 'Schedule not found' });
      return;
    }
    const limits = await deps.getLimits(requestUser(req));
    if (signal.aborted) return;
    const result = await deps.fireNow(schedule, limits, { signal });
    if (signal.aborted) return;
    if (result == null) {
      res.status(409).json({ error: 'A run for this schedule is already in progress' });
      return;
    }
    if (!result.fired) {
      // A limiter refusal is the caller's own quota, not a conflicting schedule state,
      // so answer 429 rather than burying it in the generic 409.
      const failedMCP = result.mcp?.filter((outcome) => outcome.status !== 'ready') ?? [];
      const mcpStatus = failedMCP.length > 0 ? getScheduleMCPFailureCode(failedMCP) : undefined;
      let status = 409;
      if (result.skipped === 'rate_limited') status = 429;
      else if (mcpStatus === 'mcp_unavailable' || result.mcpPreflightUnavailable === true)
        status = 503;
      else if (mcpStatus != null) status = 400;
      const error =
        result.skipped === 'rate_limited'
          ? 'Too many messages. Try running this schedule again shortly.'
          : (result.error ?? `Run skipped (${result.skipped ?? 'unknown'})`);
      const responseCode =
        mcpStatus ?? (result.mcpPreflightUnavailable === true ? 'mcp_unavailable' : undefined);
      res.status(status).json({
        error,
        skipped: result.skipped,
        mcp: result.mcp,
        ...(responseCode != null ? { code: responseCode } : {}),
      });
      return;
    }
    res.json({ scheduleId: schedule.id, conversationId: result.conversationId, status: 'started' });
  }

  return {
    listSchedules,
    getSchedule,
    createSchedule,
    updateSchedule,
    deleteSchedule,
    runScheduleNow,
  };
}

export type { ScheduleUserContext };
