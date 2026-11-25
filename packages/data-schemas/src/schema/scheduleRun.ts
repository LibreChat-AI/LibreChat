import { Schema } from 'mongoose';
import { runGrantFailureReasonSchema } from 'librechat-data-provider';
import type { IScheduleRunDocument } from '~/types/schedule';

const SCHEDULE_RUN_TTL_SECONDS = 90 * 24 * 60 * 60;

const scheduleRunSchema: Schema<IScheduleRunDocument> = new Schema(
  {
    /** The schedule whose occurrence the row records. Required on a schedule's row and
     *  absent on a row of any other kind, which the schedule-only indexes leave out. */
    scheduleId: {
      type: String,
      required: [
        function (this: { kind?: string }): boolean {
          return this.kind == null;
        },
        'A schedule run requires a scheduleId',
      ],
    },
    /** Whose run the row records, where that is not a schedule: absent on a schedule's row. */
    kind: {
      type: String,
      enum: ['subscription'],
    },
    /** That subject's id, on a row that holds a `kind`. */
    subject: {
      type: String,
    },
    user: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    tenantId: {
      type: String,
      index: true,
    },
    scheduledFor: {
      type: Date,
      required: true,
    },
    firedAt: {
      type: Date,
    },
    conversationId: {
      type: String,
    },
    checkpointNamespace: {
      type: String,
      select: false,
    },
    /** Deterministic durable-trigger delivery key for this occurrence, stamped at
     *  reservation before enqueue so reconciliation can read the delivery's live/dead
     *  state rather than orphan-settling a deferred or dead-lettered run. */
    deliveryKey: {
      type: String,
    },
    chatProjectId: {
      type: String,
    },
    /** Fresh while a RESUME of this paused run is mid-flight; a re-pause hand-off's
     *  writes are still landing, so quiesce must not settle on the paused job state.
     *  Cleared by the pause record (the hand-off completion) or aged out. */
    resumeClaimedAt: {
      type: Date,
    },
    status: {
      type: String,
      enum: [
        'started',
        'requires_action',
        'success',
        'error',
        'interrupted',
        'skipped_overlap',
        'skipped_balance',
        'skipped_cap',
      ],
      required: true,
    },
    error: {
      type: String,
      maxlength: 2048,
    },
    mcp: {
      type: [
        {
          _id: false,
          server: { type: String, required: true },
          agentId: { type: String },
          detail: { type: String, enum: ['unattended_auth_required'] },
          reason: { type: String, enum: runGrantFailureReasonSchema.options },
          recovery: {
            type: String,
            enum: ['authorize', 'configure', 'restore_permission', 'retry_later'],
          },
          automaticReplay: { type: Boolean, enum: [false] },
          skipped: { type: Boolean, enum: [true] },
          status: {
            type: String,
            required: true,
            enum: [
              'ready',
              'mcp_reauth_required',
              'mcp_configuration_missing',
              'mcp_permission_denied',
              'mcp_unavailable',
            ],
          },
        },
      ],
      default: undefined,
    },
    droppedFileIds: {
      type: [String],
      default: undefined,
    },
    durationMs: {
      type: Number,
      min: 0,
    },
    /** False on a terminal run whose schedule bookkeeping hasn't landed yet (crash-retry marker). */
    bookkept: {
      type: Boolean,
    },
    /** Set ONLY when the row reaches a terminal status; the TTL index below expires on
     *  this field, so live rows (which never carry it) never expire. */
    settledAt: {
      type: Date,
    },
    /** Global concurrency slot held while `started`. The unique partial index below
     *  turns fireConcurrency into a DB-enforced bound instead of a racy count. */
    capacitySlot: {
      type: Number,
      min: 0,
    },
    /** Marks a transient started row that exists only to settle an admission failure.
     * It never owns generation capacity, including if settlement must be reconciled. */
    admissionOnly: {
      type: Boolean,
    },
    /** When an abort was requested. The run keeps holding its capacity slot until the
     *  generation owner confirms settlement, so capacity is never freed early. */
    abortRequestedAt: {
      type: Date,
    },
    /** Who requested the abort ('stop' = interactive route, 'deletion' = delete/quiesce). */
    abortSource: {
      type: String,
      enum: ['stop', 'deletion'],
    },
    /** Stamped once the interactive Stop route has persisted everything it writes;
     *  the generation owner defers settlement until this appears (bounded). */
    abortPersistedAt: {
      type: Date,
    },
    /** When reconciliation last examined this row. Rotates each bounded non-terminal
     *  window so a full batch of live runs cannot starve an abandoned row behind it. */
    reconciledAt: {
      type: Date,
    },
    /** When the generation job that runs an event subscription's run was created. With the
     *  conversation id, which is the job's key, it names that one generation: a later turn in
     *  the same conversation is another job with another creation time. */
    jobCreatedAt: {
      type: Date,
    },
    /** Set once an event subscription's run has been counted into its subscription's failure
     *  streak, by the one writer whose conditional update set it, so a replay counts nothing. */
    counted: {
      type: Boolean,
    },
    /** The schedule's configRevision at claim time. Fences terminal bookkeeping and
     *  auto-disable from owner edits/re-enables that landed after this run started. */
    configRevision: {
      type: Number,
      min: 0,
    },
  },
  {
    timestamps: true,
  },
);

// LEGACY, dropped in the release after this one. Covers every row, so a row with no
// `scheduleId` would be held to it as a null: a subscription's row is not written while it
// exists (see `triggerRun.ts`). `occurrence` below is its schedule-only successor.
scheduleRunSchema.index({ scheduleId: 1, scheduledFor: 1 }, { unique: true });
// One row per occurrence, on schedule rows only. The key pattern differs from the legacy
// index's so the two can coexist on MongoDB before 5.0, which refuses two indexes on one
// key pattern; an equality on both fields is unique in either order, so the rule is the same.
scheduleRunSchema.index(
  { scheduledFor: 1, scheduleId: 1 },
  { name: 'occurrence', unique: true, partialFilterExpression: { scheduleId: { $exists: true } } },
);
// TTL retention applies only to SETTLED rows: an approval window configured longer
// than the retention period would otherwise let Mongo expire a still-live
// `requires_action` run — its retained job could then resume with no run row (no
// bookkeeping), and deletion quiescing could no longer discover or abort it.
// Expressed as a PLAIN TTL index on `settledAt` (stamped only by terminal writes):
// TTL expiry skips documents that lack the indexed date, so live rows never expire
// without needing a partialFilterExpression — whose `$in` predicate Amazon
// DocumentDB 5.0 cannot build (misc/documentdb/documentdb-compat.md), which would
// leave initializeScheduleEngine refusing to arm on that target.
scheduleRunSchema.index({ settledAt: 1 }, { expireAfterSeconds: SCHEDULE_RUN_TTL_SECONDS });
// At most ONE active (`started`) run per schedule, enforced by the DB rather than a
// read-then-write check: a second occurrence inserting while one is already active
// fails with a duplicate-key error instead of racing.
// LEGACY, dropped in the release after this one, for the same reason as the legacy
// occurrence index: a row with no `scheduleId` would be held to it as a null.
scheduleRunSchema.index(
  { scheduleId: 1 },
  { unique: true, partialFilterExpression: { status: 'started' } },
);
// Its schedule-only successor. Every row it holds is `started`, so `status` is one value
// across it and {scheduleId, status} is unique exactly when `scheduleId` is.
scheduleRunSchema.index(
  { scheduleId: 1, status: 1 },
  {
    name: 'active',
    unique: true,
    partialFilterExpression: { status: 'started', scheduleId: { $exists: true } },
  },
);
// GLOBAL fireConcurrency, enforced by the DB rather than a read-then-compare count.
// A fire claims a slot in [0, fireConcurrency) in the SAME write that inserts the run;
// a duplicate slot is rejected atomically, so two concurrent admissions of DIFFERENT
// schedules can never both pass a cap-1 check.
// Partial + $exists so legacy slotless rows (written before this field) never collide.
scheduleRunSchema.index(
  { capacitySlot: 1 },
  {
    unique: true,
    partialFilterExpression: { status: 'started', capacitySlot: { $exists: true } },
  },
);
// One row per delivery for a run that is not a schedule's. Two deliveries to one subscription
// can carry the same event time, so theirs are told apart by the delivery's key. Partial on an
// equality, the shape the active-run index already uses here, so no row without `kind` is in it.
scheduleRunSchema.index(
  { deliveryKey: 1 },
  { unique: true, partialFilterExpression: { kind: 'subscription' } },
);
scheduleRunSchema.index({ scheduleId: 1, firedAt: -1 });
// Reconciliation sweeps by status; keeps `started` (capacity) fetch cheap and
// prevents long-lived `requires_action` rows from starving the scan.
scheduleRunSchema.index({ status: 1, firedAt: 1 });
// Non-terminal reconciliation windows sort on {reconciledAt, firedAt} within a status;
// without this the round-robin rotation re-sorts the whole live set every tick.
scheduleRunSchema.index({ status: 1, reconciledAt: 1, firedAt: 1 });

// Owner-scoped automatic-completion admission, including settled occurrences.
scheduleRunSchema.index({ user: 1, tenantId: 1, conversationId: 1 });

export default scheduleRunSchema;
