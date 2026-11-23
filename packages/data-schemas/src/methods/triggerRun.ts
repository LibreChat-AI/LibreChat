import {
  isScheduleMCPAuthorizationFailure,
  runGrantFailureReasonSchema,
  mergeScheduleMCPReceipts,
} from 'librechat-data-provider';
import type { ScheduleMCPOutcome, ScheduleRunStatus } from 'librechat-data-provider';
import type { Model } from 'mongoose';
import type {
  TriggerRun,
  TriggerRunRef,
  TriggerRunRow,
  TriggerRunSkip,
  TriggerRunScope,
  TriggerRunClaim,
  TriggerRunPause,
  RecordedRunRef,
  TriggerRunOrigin,
  TriggerRunBinding,
  TriggerRunDetails,
  TriggerRunOutcome,
  TriggerRunSettlement,
  TriggerRunUnrecorded,
  TriggerRunExpectation,
  TriggerRunReservation,
} from '~/types/triggerRun';
import type { IScheduleRun, IScheduleRunDocument } from '~/types/schedule';

export const DUPLICATE_KEY = 11000;

/** Statuses that occupy a subject's live capacity and block another of its runs. */
export const ACTIVE_RUN_STATUSES: ScheduleRunStatus[] = ['started', 'requires_action'];

/**
 * Age past which an unresolved interactive-stop attempt is presumed dead and its
 * per-run serialization claim becomes takeable again. Mirrors the api layer's
 * ABORT_OWNER_PRESUMED_ALIVE_MS — one presumption, two enforcement points.
 */
const ABORT_STAMP_STALE_MS = 30 * 60_000;

export type DuplicateKeyError = {
  code?: number;
  keyPattern?: Record<string, number>;
  errmsg?: string;
  message?: string;
};

/** DocumentDB can omit keyPattern; retain the deployed default index names as a fallback. */
function matchesRunDuplicate(
  error: unknown,
  fields: readonly string[],
  indexName: string,
): boolean {
  const err = error as DuplicateKeyError;
  if (err?.code !== DUPLICATE_KEY) {
    return false;
  }
  const keyPattern = err.keyPattern;
  if (keyPattern != null) {
    return (
      Object.keys(keyPattern).length === fields.length &&
      fields.every((field) => Object.prototype.hasOwnProperty.call(keyPattern, field))
    );
  }
  const message = err.errmsg || err.message;
  return typeof message === 'string' && /\bindex:\s+(\S+)/.exec(message)?.[1] === indexName;
}

/** A duplicate-key error whose conflict is the {scheduleId, scheduledFor} occurrence index. */
function isOccurrenceDuplicate(error: unknown): boolean {
  return matchesRunDuplicate(error, ['scheduleId', 'scheduledFor'], 'scheduleId_1_scheduledFor_1');
}

/** A duplicate-key error whose conflict is the single-active-run partial index. */
function isActiveRunConflict(error: unknown): boolean {
  return matchesRunDuplicate(error, ['scheduleId'], 'scheduleId_1');
}

/** A duplicate-key error whose conflict is the one-row-per-delivery partial index. */
function isDeliveryDuplicate(error: unknown): boolean {
  return matchesRunDuplicate(error, ['deliveryKey'], 'deliveryKey_1');
}

/** A duplicate-key error whose conflict is the GLOBAL {capacitySlot} cap index. */
function isCapacitySlotConflict(error: unknown): boolean {
  return matchesRunDuplicate(error, ['capacitySlot'], 'capacitySlot_1');
}

type Field = keyof TriggerRun;
/** A row as one field's reader sees it: the read selected that field's columns. */
type Row = IScheduleRun;

/** The stored columns each field of a run is read from. */
const columns: Record<Field, string> = {
  subject: 'scheduleId',
  delivery: 'scheduledFor deliveryKey',
  owner: 'user',
  tenantId: 'tenantId',
  status: 'status',
  conversationId: 'conversationId',
  chatProjectId: 'chatProjectId',
  mcp: 'mcp',
  error: 'error',
  firedAt: 'firedAt',
  settledAt: 'settledAt',
  revision: 'configRevision',
  abortRequestedAt: 'abortRequestedAt',
  abortSource: 'abortSource',
  abortPersistedAt: 'abortPersistedAt',
};

/**
 * Where a subscription's row holds its subject. Its `scheduleId` is the delivery's key, so
 * the subject is read from the two columns a row of that kind is given instead.
 */
const delivered: Partial<Record<Field, string>> = { subject: 'kind subject' };

const read: { [K in Field]: (row: Row) => TriggerRun[K] | undefined } = {
  subject: (row) =>
    row.kind === 'subscription' && row.subject != null
      ? { kind: 'subscription', id: row.subject }
      : { kind: 'schedule', id: row.scheduleId },
  delivery: (row) => ({
    at: row.scheduledFor,
    ...(row.deliveryKey != null && { key: row.deliveryKey }),
  }),
  owner: (row) => String(row.user),
  tenantId: (row) => row.tenantId,
  status: (row) => row.status,
  conversationId: (row) => row.conversationId,
  chatProjectId: (row) => row.chatProjectId,
  mcp: (row) => row.mcp,
  error: (row) => row.error,
  firedAt: (row) => row.firedAt,
  settledAt: (row) => row.settledAt,
  revision: (row) => row.configRevision,
  abortRequestedAt: (row) => row.abortRequestedAt,
  abortSource: (row) => row.abortSource,
  abortPersistedAt: (row) => row.abortPersistedAt,
};

function set<K extends Field>(run: Partial<TriggerRun>, field: K, row: Row): void {
  const value = read[field](row);
  if (value !== undefined) run[field] = value;
}

/** A stored `null` is kept and a missing column is left out, so the two stay distinct. */
function view<K extends Field>(row: Row, fields: readonly K[]): Pick<TriggerRun, K> {
  const run: Partial<TriggerRun> = {};
  for (const field of fields) set(run, field, row);
  // The projection named exactly these fields, and a row always holds the required ones.
  return run as Pick<TriggerRun, K>;
}

const project = (fields: readonly Field[], at: object): string =>
  fields.map((field) => ('kind' in at && delivered[field]) || columns[field]).join(' ');

/** The two columns that name a schedule's row. */
type Occurrence = Pick<IScheduleRun, 'scheduleId' | 'scheduledFor'>;
/** The columns a subscription's row is found by: its kind, its subject and its delivery. */
type Delivered = Required<Pick<IScheduleRun, 'kind' | 'subject' | 'deliveryKey'>>;
type Place = Occurrence | Delivered;

/**
 * The columns a run's row is found by, or nothing for a ref no row is kept under. A
 * schedule's run is its schedule and the time of its event. A subscription's is its delivery,
 * since two of its deliveries can carry one event time: the kind is named so the lookup stays
 * inside the index that holds one row per delivery, and the subject so a key filed under
 * another subscription never answers.
 */
function where(ref: TriggerRunRef): Place | null {
  if (ref.subject.kind === 'schedule') {
    return { scheduleId: ref.subject.id, scheduledFor: new Date(ref.delivery.event.occurredAt) };
  }
  if (ref.subject.kind !== 'subscription' || !ref.delivery.key) return null;
  return { kind: 'subscription', subject: ref.subject.id, deliveryKey: ref.delivery.key };
}

/**
 * The columns a new row is given. A subscription's row also takes the two a schedule's is
 * found by, which every row must hold: its delivery's key stands as `scheduleId`, so the row
 * is alone under the index that allows a schedule one active run, and other runs of its
 * subscription are free to overlap it.
 */
function named(ref: TriggerRunRef, at: Place): Place & Occurrence {
  if (!('kind' in at)) return at;
  return {
    ...at,
    scheduleId: at.deliveryKey,
    scheduledFor: new Date(ref.delivery.event.occurredAt),
  };
}

/**
 * What on a row refuses its run: a tool that found no authorization it could use unattended,
 * or a grant failure that is not replayed.
 */
const refusals = (): Record<string, unknown>[] => [
  { 'mcp.detail': 'unattended_auth_required' },
  {
    mcp: {
      $elemMatch: {
        reason: { $in: runGrantFailureReasonSchema.options },
        status: { $ne: 'ready' },
        automaticReplay: false,
      },
    },
  },
];

/**
 * Holds a recovery replay off a run a resume claimed after the replay's snapshot was taken,
 * while a claim older than the cutoff, left by a worker that died, can still be recovered.
 */
const unclaimed = (staleBefore?: Date): Record<string, unknown> =>
  staleBefore != null
    ? {
        $or: [{ resumeClaimedAt: { $exists: false } }, { resumeClaimedAt: { $lt: staleBefore } }],
      }
    : {};

/**
 * The record a triggered run leaves, found by who the run acts for and the delivery that
 * started it. A read takes the fields to return and reads no other column. A write changes
 * the run's own row and nothing else: what a run's outcome means to its subject is not here.
 *
 * The record lives in the schedule run collection. A schedule's row holds its schedule's id
 * as `scheduleId` and the time of its delivery's event as `scheduledFor`; its delivery
 * carries both, so the pair names one row and the unique index on it answers the read. A
 * subscription's row holds `kind`, its subscription's id as `subject` and its delivery's key,
 * and the unique index on that key answers for it. Schedules and subscriptions record runs:
 * for a subject of any other kind, or a subscription's delivery with no key, there is no row
 * to find, and a write sends nothing and answers as it would for a run that is not on record.
 */
export type TriggerRuns = {
  /** The run a delivery started; `null` when none is on record. */
  get: <K extends Field>(
    ref: TriggerRunRef,
    fields: readonly K[],
  ) => Promise<Pick<TriggerRun, K> | null>;
  /**
   * The run that started a conversation, among one owner's runs of one subject; `null` when
   * none is on record. Should a conversation hold more than one, the latest fired stands.
   */
  byConversation: <K extends Field>(
    scope: TriggerRunScope,
    conversationId: string,
    fields: readonly K[],
  ) => Promise<Pick<TriggerRun, K> | null>;
  /**
   * Inserts the row of a run that is starting, which takes, when the row names one, a
   * capacity slot, and for a schedule its single active place. The database decides every
   * conflict in the insert itself; nothing is read first.
   */
  reserve: {
    (ref: RecordedRunRef, row: TriggerRunRow): Promise<TriggerRunReservation>;
    (ref: TriggerRunRef, row: TriggerRunRow): Promise<TriggerRunReservation | TriggerRunUnrecorded>;
  };
  /** Adds what an accepted fire learned to the row it reserved, matched by its conversation. */
  detail: (ref: TriggerRunRef, details: TriggerRunDetails) => Promise<void>;
  /**
   * Records that an abort was requested, without freeing the run's capacity: the run keeps
   * its place until its owner writes a terminal outcome. `false` when no active run is on
   * record; `'in_progress'` when another stop attempt is still unresolved.
   */
  abort: (
    ref: TriggerRunRef,
    source?: IScheduleRun['abortSource'],
  ) => Promise<boolean | 'in_progress'>;
  /** Records that everything a stop writes has landed, which lets the run settle. */
  abortSaved: (ref: TriggerRunRef) => Promise<void>;
  /** Moves a paused run back among the started ones, into the capacity slot given. */
  claim: (ref: TriggerRunRef, capacitySlot: number) => Promise<TriggerRunClaim>;
  /** Undoes a claim while the run still holds the slot it claimed; `false` when it does not. */
  release: (ref: TriggerRunRef, capacitySlot: number) => Promise<boolean>;
  /**
   * Adds MCP receipts to a live run bound to the conversation given. `true` when they are on
   * the row, including a settled row that already holds every one of them.
   */
  receipt: (
    ref: TriggerRunRef,
    binding: TriggerRunBinding,
    receipts: ScheduleMCPOutcome[],
  ) => Promise<boolean>;
  /** Deletes a run's row, only while it still holds what is expected of it. */
  remove: (ref: TriggerRunRef, expected?: TriggerRunExpectation) => Promise<void>;
  /**
   * Moves an active run to paused and frees its capacity slot. `null` when no active run is
   * on record, when a receipt on the row refuses the run, or when a resume holds the row.
   */
  pause: (ref: TriggerRunRef, hold: TriggerRunPause) => Promise<TriggerRunOrigin | null>;
  /**
   * Writes what an active run ended as, with its receipts, and frees its capacity slot. A
   * receipt that refuses the run, given here or already on the row, ends it as an error
   * whatever was asked. The row is left marked as not yet settled with its subject: `settled`
   * clears the mark once the subject's own step has landed. `null` when no active run is on
   * record, or a resume holds the row.
   */
  finish: (ref: TriggerRunRef, outcome: TriggerRunOutcome) => Promise<TriggerRunSettlement | null>;
  /**
   * Inserts the row of a run that never starts, marked as not yet settled with its subject.
   * A delivery that already has a row is answered from that row while it is the same skip,
   * so a retry repeats the subject's step; `null` when the row is anything else.
   */
  skip: (ref: TriggerRunRef, row: TriggerRunSkip) => Promise<TriggerRunOrigin | null>;
  /** Marks a run as settled with its subject, once the subject's own step has landed. */
  settled: (ref: TriggerRunRef) => Promise<void>;
};

export function createTriggerRuns(mongoose: typeof import('mongoose')): TriggerRuns {
  const Run = () => mongoose.models.ScheduleRun as Model<IScheduleRunDocument>;

  async function get<K extends Field>(
    ref: TriggerRunRef,
    fields: readonly K[],
  ): Promise<Pick<TriggerRun, K> | null> {
    const at = where(ref);
    if (at == null) return null;
    const row = await Run().findOne(at).select(project(fields, at)).lean<Row | null>();
    return row == null ? null : view(row, fields);
  }

  async function byConversation<K extends Field>(
    scope: TriggerRunScope,
    conversationId: string,
    fields: readonly K[],
  ): Promise<Pick<TriggerRun, K> | null> {
    const { kind, id } = scope.subject;
    if (kind !== 'schedule' && kind !== 'subscription') return null;
    const of: Pick<IScheduleRun, 'scheduleId'> | Pick<Delivered, 'kind' | 'subject'> =
      kind === 'schedule' ? { scheduleId: id } : { kind, subject: id };
    const row = await Run()
      .findOne({ user: scope.owner, tenantId: scope.tenantId, conversationId, ...of })
      .sort({ firedAt: -1 })
      .select(project(fields, of))
      .lean<Row | null>();
    return row == null ? null : view(row, fields);
  }

  function reserve(ref: RecordedRunRef, row: TriggerRunRow): Promise<TriggerRunReservation>;
  function reserve(
    ref: TriggerRunRef,
    row: TriggerRunRow,
  ): Promise<TriggerRunReservation | TriggerRunUnrecorded>;
  async function reserve(
    ref: TriggerRunRef,
    row: TriggerRunRow,
  ): Promise<TriggerRunReservation | TriggerRunUnrecorded> {
    const at = where(ref);
    if (at == null) return { conflict: 'unrecorded' };
    try {
      const doc = await Run().create({ ...row, ...named(ref, at), status: 'started' });
      return { run: doc.toObject() };
    } catch (error) {
      // A subscription's row holds its delivery's key under every index that names a row, so
      // whichever of them refuses a second insert of that delivery, it is the same answer:
      // the active-run index included, which for a schedule means another occurrence.
      const again = 'kind' in at && (isDeliveryDuplicate(error) || isActiveRunConflict(error));
      if (isOccurrenceDuplicate(error) || again) {
        // Report the EXISTING row's status. A duplicate means another fire owns this
        // occurrence — but "owns" and "already finished" need opposite handling, and the
        // caller cannot distinguish them without this.
        const existing = await Run()
          .findOne(at)
          .select('status')
          .lean<Pick<IScheduleRun, 'status'>>();
        return { conflict: 'duplicate', existingStatus: existing?.status };
      }
      // Checked BEFORE overlap: the global cap index and the per-schedule active
      // index are different failures and drive different caller behavior (retry the
      // next slot vs skip the occurrence).
      if (isCapacitySlotConflict(error)) {
        return { conflict: 'slot-taken' };
      }
      if (isActiveRunConflict(error)) {
        return { conflict: 'overlap' };
      }
      throw error;
    }
  }

  async function detail(ref: TriggerRunRef, details: TriggerRunDetails): Promise<void> {
    const at = where(ref);
    if (at == null) return;
    await Run().updateOne(
      { ...at, conversationId: details.conversationId },
      {
        $set: {
          conversationId: details.conversationId,
          ...(details.droppedFileIds?.length ? { droppedFileIds: details.droppedFileIds } : {}),
        },
        ...(details.mcp?.length ? { $addToSet: { mcp: { $each: details.mcp } } } : {}),
      },
    );
  }

  /**
   * The stamp is RENEWED per attempt, not first-wins: the fences read
   * `abortRequestedAt` for freshness, and a retry abort signalled against a live
   * generation must re-arm them — a 31-minute-old stamp from a failed first attempt
   * must not let a drain read the retry's post-abort job state as settled. Callers
   * therefore only invoke this against a generation they observed LIVE (or unknown);
   * stamping cleanup aborts of already-terminal jobs would re-fence a dead owner
   * forever and block the reconciler's recovery.
   *
   * Source semantics: a 'stop' attempt takes the source and re-opens the persistence
   * marker (the Stop route persists writes the owner's barrier must wait on, and each
   * attempt resolves it anew); a 'deletion' request renews freshness but never steals
   * the source from an UNRESOLVED stop attempt — the route may still be persisting,
   * and the owner's barrier keys off `abortSource === 'stop'`.
   * Classic operators only (DocumentDB).
   */
  async function abort(
    ref: TriggerRunRef,
    source?: IScheduleRun['abortSource'],
  ): Promise<boolean | 'in_progress'> {
    const at = where(ref);
    if (at == null) return false;
    const now = new Date();
    if (source === 'stop') {
      // SERIALIZED per run: only one unresolved fresh stop attempt may exist. A second
      // Stop stamping over a live one would re-open the persistence marker, and its
      // own lost-CAS resolution would then release the settlement barrier while the
      // FIRST attempt (the terminal-CAS winner) was still pruning and saving. The
      // guarded update is the arbiter; a loser answers 'in_progress' and must neither
      // signal the abort nor resolve anything. A stale unresolved attempt (its route
      // presumed dead) is claimable again.
      const staleCutoff = new Date(now.getTime() - ABORT_STAMP_STALE_MS);
      const stamped = await Run().updateOne(
        {
          ...at,
          status: { $in: ACTIVE_RUN_STATUSES },
          $nor: [
            {
              abortSource: 'stop',
              abortPersistedAt: { $exists: false },
              abortRequestedAt: { $gt: staleCutoff },
            },
          ],
        },
        { $set: { abortRequestedAt: now, abortSource: 'stop' }, $unset: { abortPersistedAt: 1 } },
      );
      if ((stamped.matchedCount ?? 0) > 0) {
        return true;
      }
      const holder = await Run()
        .findOne({ ...at, status: { $in: ACTIVE_RUN_STATUSES } })
        .select('_id')
        .lean();
      return holder != null ? 'in_progress' : false;
    }
    const claimed = await Run().updateOne(
      {
        ...at,
        status: { $in: ACTIVE_RUN_STATUSES },
        $or: [{ abortSource: { $ne: 'stop' } }, { abortPersistedAt: { $exists: true } }],
      },
      { $set: { abortRequestedAt: now, ...(source ? { abortSource: source } : {}) } },
    );
    if ((claimed.matchedCount ?? 0) > 0) {
      return true;
    }
    // An unresolved stop attempt holds the source; renew freshness only.
    const renewed = await Run().updateOne(
      { ...at, status: { $in: ACTIVE_RUN_STATUSES } },
      { $set: { abortRequestedAt: now } },
    );
    return (renewed.matchedCount ?? 0) > 0;
  }

  /** Bookkeeping only: never touches `updatedAt`. */
  async function abortSaved(ref: TriggerRunRef): Promise<void> {
    const at = where(ref);
    if (at == null) return;
    await Run().updateOne(at, { $set: { abortPersistedAt: new Date() } }, { timestamps: false });
  }

  /**
   * Stamps a paused run as RESUME-CLAIMED: its approval was consumed and a
   * continuation is running. While fresh, a re-paused job's state is a hand-off in
   * flight (segment writes still landing), not settleable evidence. The pause
   * record ($unset below) is the completion signal; a crash leaves the stamp to
   * age out on the caller's staleness bound.
   */
  async function claim(ref: TriggerRunRef, capacitySlot: number): Promise<TriggerRunClaim> {
    const at = where(ref);
    if (at == null) return { conflict: 'not-paused' };
    try {
      const claimed = await Run().findOneAndUpdate(
        { ...at, status: 'requires_action' },
        {
          $set: {
            status: 'started',
            capacitySlot,
            resumeClaimedAt: new Date(),
          },
        },
        { new: true, timestamps: false },
      );
      return claimed == null ? { conflict: 'not-paused' } : { capacitySlot };
    } catch (error) {
      if (isCapacitySlotConflict(error)) {
        return { conflict: 'slot-taken' };
      }
      if (isActiveRunConflict(error)) {
        return { conflict: 'overlap' };
      }
      throw error;
    }
  }

  /**
   * Rolls back a claim only while the exact slot this caller claimed still belongs to this
   * run, so a committed or racing resume never has its capacity released by a losing request.
   */
  async function release(ref: TriggerRunRef, capacitySlot: number): Promise<boolean> {
    const at = where(ref);
    if (at == null) return false;
    const released = await Run().updateOne(
      { ...at, status: 'started', capacitySlot },
      {
        $set: { status: 'requires_action' },
        $unset: { capacitySlot: 1, resumeClaimedAt: 1 },
      },
      { timestamps: false },
    );
    return (released.modifiedCount ?? 0) > 0;
  }

  async function receipt(
    ref: TriggerRunRef,
    { conversationId, tenantId }: TriggerRunBinding,
    receipts: ScheduleMCPOutcome[],
  ): Promise<boolean> {
    const at = where(ref);
    if (at == null) return false;
    const binding = {
      ...at,
      conversationId,
      ...(tenantId ? { tenantId } : { tenantId: { $exists: false } }),
    };
    const updated = await Run().updateOne(
      { ...binding, status: { $in: ['started', 'requires_action'] } },
      { $addToSet: { mcp: { $each: receipts } } },
      { timestamps: false },
    );
    if ((updated.matchedCount ?? 0) > 0) return true;
    if (receipts.length === 0) return false;
    // A durable replay acknowledges existing evidence, never appends a late diagnosis.
    const terminal = await Run()
      .findOne({
        ...binding,
        status: { $in: ['success', 'error', 'interrupted', 'skipped_balance', 'skipped_overlap'] },
      })
      .select('mcp')
      .lean<Pick<IScheduleRun, 'mcp'>>();
    if (!terminal) return false;
    const admitted = mergeScheduleMCPReceipts(terminal.mcp ?? []);
    return mergeScheduleMCPReceipts(admitted, receipts).length === admitted.length;
  }

  /**
   * Used to roll back a reservation. Fenced on status so a rollback cannot delete a row a
   * concurrent process already advanced, and on the conversation so a fire only ever deletes
   * the reservation it inserted.
   */
  async function remove(ref: TriggerRunRef, expected: TriggerRunExpectation = {}): Promise<void> {
    const at = where(ref);
    if (at == null) return;
    const filter: Record<string, unknown> = at;
    if (expected.status !== undefined) {
      filter.status = expected.status;
    }
    if (expected.conversationId !== undefined) {
      filter.conversationId = expected.conversationId;
    }
    await Run().deleteOne(filter);
  }

  /**
   * The row transition is won before anything is projected from it, and an already paused
   * row matches too: a retried pause is answered again, and a sweep can repeat one whose
   * owner died after this write. Leaving `started` frees the capacity slot, and clearing the
   * claim stamp is what tells a resume hand-off that its re-pause is complete.
   */
  async function pause(
    ref: TriggerRunRef,
    hold: TriggerRunPause,
  ): Promise<TriggerRunOrigin | null> {
    const at = where(ref);
    if (at == null) return null;
    const now = new Date();
    const paused = await Run().findOneAndUpdate(
      {
        ...at,
        status: { $in: ACTIVE_RUN_STATUSES },
        $nor: refusals(),
        ...unclaimed(hold.resumeClaimStaleBefore),
      },
      {
        $set: {
          status: 'requires_action',
          ...(hold.conversationId ? { conversationId: hold.conversationId } : {}),
          ...(hold.checkpointNamespace != null
            ? { checkpointNamespace: hold.checkpointNamespace }
            : {}),
        },
        $unset: { capacitySlot: 1, resumeClaimedAt: 1 },
      },
      { new: false },
    );
    if (paused == null) return null;
    // The row's own fire time: a pause is repeated every sweep for as long as it waits.
    return { firedAt: paused.firedAt ?? now, revision: paused.configRevision };
  }

  /**
   * Receipts are merged in the same transition, so neither a receipt race nor a crash can
   * lose one. That no refusal is on the row is part of the update's own filter, not a read
   * before it: a receipt written first sends this to the second update, which ends the run as
   * an error, and one written after finds the run no longer live.
   */
  async function finish(
    ref: TriggerRunRef,
    outcome: TriggerRunOutcome,
  ): Promise<TriggerRunSettlement | null> {
    const at = where(ref);
    if (at == null) return null;
    const now = new Date();
    const live = {
      ...at,
      status: { $in: ACTIVE_RUN_STATUSES },
      ...unclaimed(outcome.resumeClaimStaleBefore),
    };
    const overridable =
      outcome.status === 'success' ||
      outcome.status === 'error' ||
      outcome.status === 'skipped_balance' ||
      outcome.status === 'interrupted';
    const refused = overridable && outcome.mcp?.some(isScheduleMCPAuthorizationFailure) === true;
    const refusal =
      outcome.status === 'error' && outcome.error
        ? outcome.error
        : 'MCP unattended authorization unavailable';
    const update = (status: TriggerRunOutcome['status'], error: string | undefined) => ({
      $set: {
        status,
        bookkept: false,
        settledAt: now,
        ...(outcome.conversationId && !outcome.clearConversationId
          ? { conversationId: outcome.conversationId }
          : {}),
        ...(error ? { error } : {}),
        ...(outcome.durationMs != null ? { durationMs: outcome.durationMs } : {}),
      },
      ...(outcome.mcp?.length && { $addToSet: { mcp: { $each: outcome.mcp } } }),
      // Only a terminal outcome releases the capacity slot, never an abort request.
      $unset: {
        capacitySlot: 1,
        admissionOnly: 1,
        ...(outcome.clearConversationId ? { conversationId: 1 } : {}),
      },
    });
    let status: TriggerRunOutcome['status'] = refused ? 'error' : outcome.status;
    let error = refused ? refusal : outcome.error;
    let row = await Run()
      .findOneAndUpdate(
        { ...live, ...(overridable ? { $nor: refusals() } : {}) },
        update(status, error),
        { new: true },
      )
      .lean<Row>();
    if (row == null && overridable) {
      row = await Run()
        .findOneAndUpdate({ $and: [live, { $or: refusals() }] }, update('error', refusal), {
          new: true,
        })
        .lean<Row>();
      status = 'error';
      error = refusal;
    }
    if (row == null) return null;
    return {
      status,
      error,
      mcp: row.mcp,
      firedAt: row.firedAt ?? now,
      revision: row.configRevision,
    };
  }

  /**
   * The unique index on a delivery makes the insert the claim: a duplicate means an earlier
   * attempt holds the delivery. Only a row that is the same skip is answered, with its own
   * fire time, since anything else is a run that started and must not be read as a skip.
   */
  async function skip(ref: TriggerRunRef, row: TriggerRunSkip): Promise<TriggerRunOrigin | null> {
    const at = where(ref);
    if (at == null) return null;
    const now = new Date();
    try {
      const doc = await Run().create({
        ...row,
        ...named(ref, at),
        firedAt: now,
        settledAt: now,
        bookkept: false,
      });
      return { firedAt: now, revision: doc.toObject().configRevision };
    } catch (error) {
      if ((error as DuplicateKeyError)?.code !== DUPLICATE_KEY) throw error;
    }
    const existing = await Run()
      .findOne(at)
      .select('status configRevision firedAt')
      .lean<Pick<IScheduleRun, 'status' | 'configRevision' | 'firedAt'>>();
    if (existing == null || existing.status !== row.status) return null;
    return { firedAt: existing.firedAt ?? now, revision: existing.configRevision };
  }

  async function settled(ref: TriggerRunRef): Promise<void> {
    const at = where(ref);
    if (at == null) return;
    await Run().updateOne(at, { $set: { bookkept: true } });
  }

  return {
    get,
    byConversation,
    reserve,
    detail,
    abort,
    abortSaved,
    claim,
    release,
    receipt,
    remove,
    pause,
    finish,
    skip,
    settled,
  };
}
