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
  mediaSettlementId?: string;
  mediaAccountPending?: boolean;
  mediaJobId?: string;
  debtCredits?: number;
  /** Legacy receipt column; new writes use debtCredits. */
  mediaDebtCredits?: number;
  overrunDebtCredits?: number;
  /** Legacy receipt column; new writes use overrunDebtCredits. */
  mediaOverrunDebtCredits?: number;
  holdShortfallCredits?: number;
  /** Legacy receipt column; new writes use holdShortfallCredits. */
  mediaHoldShortfallCredits?: number;
  costUSD?: number;
  /** Legacy receipt column; new writes use costUSD. */
  mediaCostUSD?: number;
  costSource?: 'provider' | 'tokens' | 'estimate';
  mediaFingerprint?: string;
  mediaAccountingMode?: 'balance' | 'transactions';
  outputTokens?: number;
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
    mediaSettlementId: String,
    mediaAccountPending: { type: Boolean, select: false },
    mediaJobId: String,
    debtCredits: Number,
    mediaDebtCredits: Number,
    overrunDebtCredits: Number,
    mediaOverrunDebtCredits: Number,
    holdShortfallCredits: Number,
    mediaHoldShortfallCredits: Number,
    costUSD: Number,
    mediaCostUSD: Number,
    costSource: { type: String, enum: ['provider', 'tokens', 'estimate'] },
    mediaFingerprint: String,
    mediaAccountingMode: { type: String, enum: ['balance', 'transactions'] },
    outputTokens: Number,
    tenantId: {
      type: String,
      index: true,
    },
  },
  {
    timestamps: true,
  },
);

transactionSchema.index({ mediaJobId: 1 });
transactionSchema.index(
  { mediaAccountPending: 1, user: 1, tenantId: 1, _id: 1 },
  { partialFilterExpression: { mediaAccountPending: true } },
);
transactionSchema.index(
  { mediaSettlementId: 1 },
  { unique: true, partialFilterExpression: { mediaSettlementId: { $type: 'string' } } },
);

export default transactionSchema;
