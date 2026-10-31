import { Schema } from 'mongoose';
import type { Model } from 'mongoose';
import { applyTenantIsolation } from './plugins/tenantIsolation';

export interface ResponseOwner {
  userId: string;
  tenantId?: string;
}

export type StoredResponseStatus =
  | 'queued'
  | 'in_progress'
  | 'requires_action'
  /** Private terminal protocol phase; legacy active-only writers cannot finalize it. */
  | 'materializing'
  | 'completed'
  | 'failed'
  | 'incomplete'
  | 'cancelled';

export interface ResponseReviewCheckpoint {
  actionId: string;
  providerExecutionId: string;
  expiresAt: number;
  /** Private seed for the resumed output; never part of the public response view. */
  partialResponseJSON: string;
  /** Visible assistant token counter, separate from billed multi-model usage. */
  visibleOutputTokens?: number;
  /** Private reviewed graph/tool/checkpoint bindings retained after the job consumes its action. */
  pendingActionJSON?: string;
  /** Exact checkpointer settings captured by the paused run, independent of later config changes. */
  checkpointConfigJSON?: string;
  checkpointId?: string;
  checkpointNs?: string;
}

export interface ResponseResumeIntent {
  intentId: string;
  actionId: string;
  previousProviderExecutionId: string;
  providerExecutionId: string;
  fingerprint: string;
  /** Validated, owner-submitted SDK resolution; not a credential or executable request. */
  resolutionJSON: string;
  /** Original validated browser decision, including edited arguments and remembered-approval scope. */
  decisionJSON?: string;
  state: 'reserved' | 'admitted';
  reservedAt: number;
  admittedAt?: number;
}

/** Server-written proposed or confirmed terminal result, bound to one provider attempt. */
export interface ResponseTerminalReceipt {
  generationCreatedAt: number;
  providerExecutionId: string;
  ownerId?: string;
  status: 'completed' | 'failed' | 'incomplete' | 'cancelled';
  responseJSON: string;
  /** Private immutable projection facts for canonical history recovery. */
  turnJSON?: string;
  checkpointNamespace?: string;
  /** Server-pinned saver settings, including initial failures before a review exists. */
  checkpointConfigJSON?: string;
}

/** Durable identity and dispatch/result journal for a background Responses request. */
export interface StoredResponseRecord {
  expiredAt?: Date;
  isTemporary?: boolean;
  tenantId?: string;
  userId: string;
  responseId: string;
  requestKey: string;
  fingerprint: string;
  agentId: string;
  sourceKeyId?: string;
  requestJSON: string;
  conversationId: string;
  parentMessageId: string;
  status: StoredResponseStatus;
  revision: number;
  deliveryKey?: string;
  generationCreatedAt?: number;
  responseJSON?: string;
  cancellationRequestedAt?: number;
  review?: ResponseReviewCheckpoint;
  resume?: ResponseResumeIntent;
  pendingTerminal?: ResponseTerminalReceipt;
  /** Durable candidate only; independent provider drain proof is required before promotion. */
  preparedTerminal?: ResponseTerminalReceipt;
  createdAt: Date;
  updatedAt: Date;
}

export function createStoredResponseModel(
  mongoose: typeof import('mongoose'),
): Model<StoredResponseRecord> {
  const terminalSchema = new Schema<ResponseTerminalReceipt>(
    {
      generationCreatedAt: { type: Number, required: true, min: 1 },
      providerExecutionId: { type: String, required: true, maxlength: 128 },
      ownerId: { type: String, maxlength: 128 },
      status: {
        type: String,
        required: true,
        enum: ['completed', 'failed', 'incomplete', 'cancelled'],
      },
      responseJSON: { type: String, required: true },
      turnJSON: String,
      checkpointNamespace: String,
      checkpointConfigJSON: String,
    },
    { _id: false },
  );
  const schema = new Schema<StoredResponseRecord>(
    {
      tenantId: String,
      expiredAt: Date,
      isTemporary: Boolean,
      userId: { type: String, required: true },
      responseId: { type: String, required: true },
      requestKey: { type: String, required: true },
      fingerprint: { type: String, required: true },
      agentId: { type: String, required: true },
      sourceKeyId: String,
      requestJSON: { type: String, required: true },
      conversationId: { type: String, required: true },
      parentMessageId: { type: String, required: true },
      status: {
        type: String,
        required: true,
        enum: [
          'queued',
          'in_progress',
          'requires_action',
          'materializing',
          'completed',
          'failed',
          'incomplete',
          'cancelled',
        ],
      },
      revision: { type: Number, required: true, default: 0 },
      deliveryKey: String,
      generationCreatedAt: Number,
      responseJSON: String,
      cancellationRequestedAt: Number,
      pendingTerminal: {
        type: terminalSchema,
        required: false,
      },
      preparedTerminal: {
        type: terminalSchema,
        required: false,
      },
      review: {
        type: new Schema<ResponseReviewCheckpoint>(
          {
            actionId: { type: String, required: true, maxlength: 256 },
            providerExecutionId: { type: String, required: true, maxlength: 128 },
            expiresAt: { type: Number, required: true, min: 1 },
            partialResponseJSON: { type: String, required: true },
            visibleOutputTokens: {
              type: Number,
              min: 0,
              max: Number.MAX_SAFE_INTEGER,
              validate: Number.isSafeInteger,
            },
            pendingActionJSON: String,
            checkpointConfigJSON: String,
            checkpointId: String,
            checkpointNs: String,
          },
          { _id: false },
        ),
        required: false,
      },
      resume: {
        type: new Schema<ResponseResumeIntent>(
          {
            intentId: { type: String, required: true, maxlength: 256 },
            actionId: { type: String, required: true, maxlength: 256 },
            previousProviderExecutionId: { type: String, required: true, maxlength: 128 },
            providerExecutionId: { type: String, required: true, maxlength: 128 },
            fingerprint: { type: String, required: true },
            resolutionJSON: { type: String, required: true },
            decisionJSON: String,
            state: { type: String, required: true, enum: ['reserved', 'admitted'] },
            reservedAt: { type: Number, required: true, min: 1 },
            admittedAt: { type: Number, min: 1 },
          },
          { _id: false },
        ),
        required: false,
      },
    },
    { timestamps: true, minimize: false },
  );
  schema.index({ tenantId: 1, userId: 1, responseId: 1 }, { unique: true });
  schema.index({ expiredAt: 1 }, { expireAfterSeconds: 0 });
  schema.index({ tenantId: 1, userId: 1, requestKey: 1 }, { unique: true });
  schema.index({ tenantId: 1, userId: 1, conversationId: 1, createdAt: 1 });
  schema.index({ userId: 1, conversationId: 1, tenantId: 1 });
  applyTenantIsolation(schema);
  return (
    mongoose.models.StoredResponse ?? mongoose.model<StoredResponseRecord>('StoredResponse', schema)
  );
}
