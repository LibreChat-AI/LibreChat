import { Schema } from 'mongoose';
import { SCHEDULE_CRON_MAX_LENGTH } from 'librechat-data-provider';
import { scheduledMCPEnrollmentSchema } from 'librechat-data-provider';
import { scheduledMCPFailureReasonSchema } from 'librechat-data-provider';
import type { IScheduleDocument } from '~/types/schedule';

/** `cadence` is a nested path rather than a subdocument, so a validator on
 *  `cadence.hour` is called with the DOCUMENT as `this`, not the cadence object.
 *  Reading `this.frequency` there is always undefined, which made every cadence
 *  look like a structured one and rejected every cron write. */
interface CadenceValidatorDocument {
  cadence?: { frequency?: string };
}

function isStructuredCadence(this: CadenceValidatorDocument): boolean {
  return this.cadence?.frequency !== 'cron';
}

const scheduleSchema: Schema<IScheduleDocument> = new Schema(
  {
    id: {
      type: String,
      required: true,
      index: true,
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
    name: {
      type: String,
      required: true,
      maxlength: 256,
    },
    prompt: {
      type: String,
      required: true,
      maxlength: 32000,
    },
    agent_id: {
      type: String,
      required: true,
    },
    cadence: {
      frequency: {
        type: String,
        enum: ['hourly', 'daily', 'weekdays', 'weekly', 'cron'],
        required: true,
      },
      /**
       * Required for the structured cadences only. A cron row carries its hour and
       * minute inside `expression`, so a blanket `required: true` here would reject
       * every cron write; the function form keeps the guarantee for the four
       * structured frequencies, where a missing hour would silently fire at 00:00.
       */
      hour: {
        type: Number,
        min: 0,
        max: 23,
        required: isStructuredCadence,
      },
      minute: {
        type: Number,
        min: 0,
        max: 59,
        required: isStructuredCadence,
      },
      daysOfWeek: { type: [Number], default: undefined },
      /** The mirror of the rule above: a cron row IS its expression, so persisting
       *  one without it arms a schedule the engine cannot compile a next run from. */
      expression: {
        type: String,
        default: undefined,
        /** Mirrors the zod gate, so a methods-layer writer bypassing the handlers
         *  cannot persist an expression the engine then refuses to compile. */
        maxlength: SCHEDULE_CRON_MAX_LENGTH,
        required: function (this: CadenceValidatorDocument) {
          return !isStructuredCadence.call(this);
        },
      },
    },
    timezone: {
      type: String,
      required: true,
    },
    target: {
      type: String,
      enum: ['new'],
      default: 'new',
      required: true,
    },
    chatProjectId: {
      type: String,
    },
    file_ids: {
      type: [String],
      default: undefined,
    },
    tools: {
      type: [String],
      default: undefined,
    },
    mcpConsent: {
      type: Schema.Types.Mixed,
      default: undefined,
      validate: (value: import('librechat-data-provider').ScheduledMCPEnrollment) =>
        scheduledMCPEnrollmentSchema.safeParse(value).success,
    },
    cron: {
      type: String,
    },
    enabled: {
      type: Boolean,
      default: true,
      required: true,
    },
    disabledReason: {
      type: String,
      enum: [
        'mcp_reauth_required',
        'mcp_configuration_missing',
        'mcp_permission_denied',
        'too_many_failures',
        'agent_deleted',
        'invalid_schedule',
        'permission_revoked',
        'insufficient_balance',
        'project_deleted',
        'project_required',
      ],
    },
    nextRunAt: {
      type: Date,
    },
    leaseUntil: {
      type: Date,
    },
    leaseBy: {
      type: String,
    },
    /**
     * Per-claim fencing token. Set fresh on every lease acquisition (engine or
     * manual) and rotated on every owner edit, so a stale/expired-lease worker's
     * writes (disable/advance/release) and its pre-dispatch revalidation no-op
     * once the schedule was re-claimed, edited, re-enabled, or deleted.
     */
    claimToken: {
      type: String,
    },
    /**
     * Owner-config generation. Bumped ONLY by an owner edit (updateScheduleById),
     * atomically with the claimToken rotation. Distinct from claimToken, which also
     * rotates on every lease acquisition. A run captures this at claim time so its
     * terminal bookkeeping / auto-disable cannot act on config it never ran under.
     */
    configRevision: {
      type: Number,
      default: 0,
      min: 0,
    },
    /**
     * Soft-delete marker. A delete disables + marks the schedule `deleting` (so
     * it is hidden from the owner and never re-claimed) and aborts in-flight
     * runs; the reconciler erases it only once no run is still active, so a live
     * loopback generation's evidence is never destroyed out from under it.
     * Defaults false so the per-user `slot` partial unique index covers it.
     */
    deleting: {
      type: Boolean,
      default: false,
    },
    /**
     * Reversible account-deletion suspension. Set at quiesce under a per-attempt token
     * that snapshots the pre-suspension enabled/next-run state. A deletion cancelled by a
     * controller failure restores exactly the rows carrying its token; a successful
     * deletion hard-deletes the row (and this snapshot with it). Distinct from `deleting`:
     * a suspended row is NOT eligible for erasure, so a failed attempt cannot lose it.
     */
    deletionSuspension: {
      type: {
        token: { type: String, required: true },
        enabled: { type: Boolean, required: true },
        nextRunAt: { type: Date },
      },
      default: undefined,
      _id: false,
    },
    /** Erased tombstone: content is gone, only the create-idempotency identity
     *  remains for a bounded retry window (TTL below). A delayed create retry that
     *  matches this key must answer "deleted", not resurrect the recurring work. */
    erased: {
      type: Boolean,
    },
    erasedAt: {
      type: Date,
    },
    /**
     * Per-user occupancy slot in [0, maxPerUser). Assigned atomically via the
     * partial unique index below so concurrent creates cannot exceed the cap: two
     * racers claiming the same slot collide on the index and one retries the next
     * free slot. Freed (excluded from the index) when the schedule is `deleting`.
     */
    slot: {
      type: Number,
      min: 0,
    },
    /** Client-supplied idempotency key for the CREATE that produced this row, unique
     *  per user via the partial index below. Creation commits the row and arms it in
     *  two writes, so a retry after a failure between them would otherwise mint a
     *  second recurring schedule; the index makes that retry collide and resolve to
     *  this row instead. */
    clientRequestId: {
      type: String,
    },
    /** Digest of the original create payload, stamped at insert and never edited, so a
     *  retry is matched against what was actually requested rather than a row a
     *  concurrent PATCH may have already reshaped. */
    clientRequestDigest: {
      type: String,
    },
    /** Last erasure-sweep attempt; rotates the `deleting` window (see eraseAttemptedAt
     *  ordering in getDeletingSchedules) so undrainable rows can't starve later ones. */
    eraseAttemptedAt: {
      type: Date,
    },
    lastRun: {
      type: {
        conversationId: { type: String },
        status: { type: String, required: true },
        error: { type: String },
        mcp: {
          type: [
            {
              _id: false,
              server: { type: String, required: true },
              agentId: { type: String },
              detail: { type: String, enum: ['unattended_auth_required'] },
              reason: { type: String, enum: scheduledMCPFailureReasonSchema.options },
              recovery: {
                type: String,
                enum: ['authorize', 'configure', 'restore_permission', 'retry_later'],
              },
              automaticReplay: { type: Boolean, enum: [false] },
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
        firedAt: { type: Date, required: true },
        scheduledFor: { type: Date },
      },
      default: undefined,
      _id: false,
    },
    runCount: {
      type: Number,
      default: 0,
      min: 0,
    },
    /**
     * Bounded set of recently-counted occurrence timestamps. Per-occurrence
     * idempotency guard for `recordRunOutcome` counter increments: a single
     * scalar could be moved by an interleaved earlier occurrence, letting the
     * reconciler double-count a crashed later one. Kept bounded via `$slice`.
     */
    countedFor: {
      type: [Date],
      default: undefined,
    },
    /** Newest occurrence whose outcome has been applied to the streak counters.
     *  `countedFor` makes counting idempotent per occurrence; this makes it ORDERED,
     *  so an older occurrence settling late cannot rebuild a streak a newer one
     *  cleared. Absent on rows written before it existed (fence disabled). */
    countersAsOf: {
      type: Date,
    },
    failureCount: {
      type: Number,
      default: 0,
      min: 0,
    },
    balanceSkipCount: {
      type: Number,
      default: 0,
      min: 0,
    },
  },
  {
    timestamps: true,
  },
);

// Idempotency tombstones expire after the bounded retry window; live rows never match.
scheduleSchema.index(
  { erasedAt: 1 },
  { expireAfterSeconds: 24 * 60 * 60, partialFilterExpression: { erased: true } },
);
scheduleSchema.index({ id: 1, tenantId: 1 }, { unique: true });
scheduleSchema.index({ enabled: 1, nextRunAt: 1 });
// Atomic per-user create cap: a live (non-deleting) schedule occupies a unique
// slot, so concurrent creates cannot collectively exceed maxPerUser — a second
// claimant of the same slot collides and retries the next free one. Scoped to
// slot-bearing docs so the (non-user-facing) slotless create path is unaffected.
scheduleSchema.index(
  { user: 1, slot: 1 },
  { unique: true, partialFilterExpression: { deleting: false, slot: { $exists: true } } },
);

// Makes a client's create RETRY idempotent: the second attempt collides here instead of
// committing a second recurring schedule. Deliberately NOT filtered on `deleting` —
// a key must stay claimed while its row is being erased, or a retry arriving mid-erase
// would create a duplicate that outlives it.
scheduleSchema.index(
  { user: 1, clientRequestId: 1 },
  { unique: true, partialFilterExpression: { clientRequestId: { $exists: true } } },
);

// Erasure sweeps read `deleting: true` ordered by last attempt (rotation).
scheduleSchema.index({ deleting: 1, eraseAttemptedAt: 1 });

export default scheduleSchema;
