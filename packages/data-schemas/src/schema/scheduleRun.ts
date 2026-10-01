import { Schema } from 'mongoose';
import type { IScheduleRunDocument } from '~/types/schedule';

const SCHEDULE_RUN_TTL_SECONDS = 90 * 24 * 60 * 60;

const scheduleRunSchema: Schema<IScheduleRunDocument> = new Schema(
  {
    scheduleId: {
      type: String,
      required: true,
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

scheduleRunSchema.index({ scheduleId: 1, scheduledFor: 1 }, { unique: true });
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
scheduleRunSchema.index(
  { scheduleId: 1 },
  { unique: true, partialFilterExpression: { status: 'started' } },
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
scheduleRunSchema.index({ scheduleId: 1, firedAt: -1 });
// Reconciliation sweeps by status; keeps `started` (capacity) fetch cheap and
// prevents long-lived `requires_action` rows from starving the scan.
scheduleRunSchema.index({ status: 1, firedAt: 1 });
// Non-terminal reconciliation windows sort on {reconciledAt, firedAt} within a status;
// without this the round-robin rotation re-sorts the whole live set every tick.
scheduleRunSchema.index({ status: 1, reconciledAt: 1, firedAt: 1 });

export default scheduleRunSchema;
