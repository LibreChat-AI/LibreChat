import { Schema } from 'mongoose';
import type { MediaSettlementRecord } from '~/types/mediaAccounting';
import { omitDefaultTenant } from '~/models/plugins/optionalTenant';

const mediaSettlementSchema: Schema<MediaSettlementRecord> = new Schema(
  {
    settlementId: { type: String, required: true },
    ownerId: { type: String, required: true },
    tenantId: { type: String },
    jobId: { type: String, required: true },
    balanceId: { type: String },
    estimatedCredits: { type: Number, required: true },
    maxCredits: { type: Number, required: true },
    holdFingerprint: { type: String, required: true },
    createdAt: { type: Date, required: true },
    reviewAt: { type: Date, required: true },
    state: {
      type: String,
      enum: ['initializing', 'holding', 'held', 'ready', 'applied', 'published'],
      required: true,
    },
    effect: {
      type: new Schema(
        {
          kind: { type: String, enum: ['charge', 'release', 'debt_collection'], required: true },
          credits: { type: Number, required: true },
          costUSD: Number,
          costSource: { type: String, enum: ['provider', 'tokens', 'estimate'] },
          shortfall: { type: String, enum: ['debt', 'absorb'] },
          creditsPerUSD: Number,
          inputTokens: Number,
          outputTokens: Number,
          model: String,
          operation: { type: String, enum: ['image.generate', 'image.edit', 'video.generate'] },
        },
        { _id: false },
      ),
      default: undefined,
    },
    effectFingerprint: String,
    sequence: Number,
    result: {
      type: new Schema(
        {
          debitedCredits: Number,
          debtCredits: Number,
          overrunDebtCredits: Number,
          holdShortfallCredits: Number,
          releasedCredits: Number,
          remainingCredits: Number,
        },
        { _id: false },
      ),
      default: undefined,
    },
    balanceAcknowledged: { type: Boolean, default: false },
  },
  { versionKey: false, minimize: false, timestamps: true },
);
omitDefaultTenant(mediaSettlementSchema);
mediaSettlementSchema.index({ tenantId: 1, ownerId: 1, jobId: 1 }, { unique: true });
mediaSettlementSchema.index({ settlementId: 1 }, { unique: true });
mediaSettlementSchema.index(
  { balanceId: 1, sequence: 1 },
  {
    unique: true,
    partialFilterExpression: { sequence: { $type: 'number' } },
  },
);
mediaSettlementSchema.index({ tenantId: 1, ownerId: 1, balanceAcknowledged: 1, settlementId: 1 });
mediaSettlementSchema.index({ balanceAcknowledged: 1, ownerId: 1, tenantId: 1 });
mediaSettlementSchema.index({
  tenantId: 1,
  ownerId: 1,
  balanceAcknowledged: 1,
  reviewAt: 1,
  settlementId: 1,
});

export default mediaSettlementSchema;
