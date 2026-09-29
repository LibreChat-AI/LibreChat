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

export default balanceSchema;
