import { Schema } from 'mongoose';
import { REFILL_INTERVAL_UNITS } from 'librechat-data-provider';
import type * as t from '~/types';

const balanceSchema: Schema<t.IBalance> = new Schema<t.IBalance>({
  user: {
    type: Schema.Types.ObjectId,
    ref: 'User',
    index: true,
    required: true,
  },
  // 1000 tokenCredits = 1 mill ($0.001 USD)
  tokenCredits: {
    type: Number,
    default: 0,
  },
  // Automatic refill settings
  autoRefillEnabled: {
    type: Boolean,
    default: false,
  },
  refillIntervalValue: {
    type: Number,
    default: 30,
  },
  refillIntervalUnit: {
    type: String,
    enum: REFILL_INTERVAL_UNITS,
    default: 'days',
  },
  lastRefill: {
    type: Date,
    default: Date.now,
  },
  // amount to add on each refill
  refillAmount: {
    type: Number,
    default: 0,
  },
  tenantId: {
    type: String,
    index: true,
  },
  /** Credits held by in-flight requests; released when each request settles, or pruned once expired */
  reservations: {
    type: [
      {
        _id: false,
        id: { type: String, required: true },
        amount: { type: Number, required: true },
        expiresAt: { type: Date, required: true },
      },
    ],
    default: undefined,
    select: false,
  },
  reservedCredits: {
    type: Number,
    select: false,
  },
  /** Reservations expire automatically; durable holds are released only by their settlement owner. */
  mediaHolds: {
    type: [
      new Schema(
        {
          settlementId: { type: String, required: true },
          jobId: { type: String, required: true },
          amount: { type: Number, required: true },
          reviewAt: { type: Date, required: true },
        },
        { _id: false },
      ),
    ],
    default: undefined,
    select: false,
  },
  /** Fences a delayed media CAS when the same balance id is deleted and recreated. */
  mediaGeneration: { type: String, select: false },
  mediaDebtCredits: { type: Number, select: false },
  mediaSettlementSequence: { type: Number, select: false },
  mediaPendingSettlement: {
    type: new Schema(
      {
        settlementId: { type: String, required: true },
        sequence: { type: Number, required: true },
        phase: { type: String, enum: ['allocated', 'applied'], required: true },
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
      },
      { _id: false },
    ),
    default: undefined,
    select: false,
  },
  pendingRefill: {
    type: {
      transactionId: { type: Schema.Types.ObjectId, required: true },
      rawAmount: { type: Number, required: true },
    },
    _id: false,
    default: undefined,
    select: false,
  },
});

balanceSchema.index({ mediaDebtCredits: 1, user: 1, tenantId: 1 });

export default balanceSchema;
