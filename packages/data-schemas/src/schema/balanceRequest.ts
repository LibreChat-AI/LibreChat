import { Schema } from 'mongoose';
import type * as t from '~/types';

const balanceRequestSchema: Schema<t.IBalanceRequest> = new Schema<t.IBalanceRequest>(
  {
    user: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      index: true,
      required: true,
    },
    status: {
      type: String,
      enum: ['pending', 'resolved'],
      default: 'pending',
      required: true,
    },
    reason: {
      type: String,
    },
    requestedAt: {
      type: Date,
      default: Date.now,
      required: true,
    },
    resolvedAt: {
      type: Date,
    },
    resolvedBy: {
      type: Schema.Types.ObjectId,
      ref: 'User',
    },
    resolvedAmount: {
      type: Number,
    },
    tenantId: {
      type: String,
      index: true,
    },
    resolutionLeaseExpiresAt: {
      type: Date,
    },
  },
  { timestamps: true },
);

/** Admin list/badge lookups: most recent pending requests first. */
balanceRequestSchema.index({ status: 1, requestedAt: -1 });

/**
 * At most one active (pending) request per user per tenant — the real guard
 * against duplicate pending requests, not just an app-level pre-check.
 */
balanceRequestSchema.index(
  { user: 1, tenantId: 1, status: 1 },
  { unique: true, partialFilterExpression: { status: 'pending' } },
);

/** Resolved requests age out after 90 days so they don't accumulate forever. */
balanceRequestSchema.index(
  { resolvedAt: 1 },
  { expireAfterSeconds: 60 * 60 * 24 * 90, partialFilterExpression: { status: 'resolved' } },
);

export default balanceRequestSchema;
