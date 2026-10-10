import mongoose, { Schema, Document, Types } from 'mongoose';

// @ts-ignore
export interface ITransaction extends Document {
  user: Types.ObjectId;
  conversationId?: string;
  tokenType: 'prompt' | 'completion' | 'credits';
  model?: string;
  context?: string;
  valueKey?: string;
  rate?: number;
  rawAmount?: number;
  tokenValue?: number;
  inputTokens?: number;
  writeTokens?: number;
  readTokens?: number;
  messageId?: string;
  createdAt?: Date;
  updatedAt?: Date;
  tenantId?: string;
  /**
   * Idempotency key for admin-credit ledger rows. Uniquely indexed (see
   * below) — this is the durable, unbounded record of "was this operation's
   * bookkeeping ever recorded," independent of the Balance document's bounded
   * `recentIdempotencyKeys` ring buffer (see `applyIdempotentCredit` in
   * methods/transaction.ts).
   */
  idempotencyKey?: string;
  /**
   * Whether an audit entry has been *durably confirmed written* for this
   * ledger row. Set only by `markAuditRecorded` (methods/transaction.ts),
   * strictly after `recordAuditEntry` has returned success — never when
   * merely claiming the attempt — so a crash or a failed write never leaves
   * this permanently `true` without a corresponding audit entry.
   */
  auditRecorded?: boolean;
  /**
   * Time-boxed lease claimed by `claimAuditRecording` while an attempt to
   * write the audit entry is in flight. Recoverable: a failed attempt
   * releases it immediately (`releaseAuditRecordingLease`), and even an
   * attempt that crashes without releasing it is reclaimable once this
   * expires — unlike `auditRecorded`, it is never a one-way, permanent gate.
   */
  auditRecordingLeaseExpiresAt?: Date;
}

const transactionSchema: Schema<ITransaction> = new Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      index: true,
      required: true,
    },
    conversationId: {
      type: String,
      ref: 'Conversation',
      index: true,
    },
    tokenType: {
      type: String,
      enum: ['prompt', 'completion', 'credits'],
      required: true,
    },
    model: {
      type: String,
      index: true,
    },
    context: {
      type: String,
    },
    valueKey: {
      type: String,
    },
    rate: Number,
    rawAmount: Number,
    tokenValue: Number,
    inputTokens: { type: Number },
    writeTokens: { type: Number },
    readTokens: { type: Number },
    messageId: { type: String },
    tenantId: {
      type: String,
      index: true,
    },
    idempotencyKey: {
      type: String,
    },
    auditRecorded: {
      type: Boolean,
    },
    auditRecordingLeaseExpiresAt: {
      type: Date,
    },
  },
  {
    timestamps: true,
  },
);

/**
 * At most one ledger row per admin-credit idempotency key per tenant. No
 * existing Transaction document has this field, so the partial filter means
 * this can never conflict with pre-existing data — no migration needed.
 */
transactionSchema.index(
  { idempotencyKey: 1, tenantId: 1 },
  { unique: true, partialFilterExpression: { idempotencyKey: { $exists: true } } },
);

export default transactionSchema;
