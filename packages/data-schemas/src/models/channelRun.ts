import { Schema } from 'mongoose';
import type {
  ChannelRunView,
  ChannelRunPrincipal,
  ChannelDeliveryReceipt,
} from 'librechat-data-provider';
import type { Model } from 'mongoose';
import { applyTenantIsolation } from './plugins/tenantIsolation';

export interface ChannelRunRecord extends Omit<ChannelRunView, 'revision'> {
  tenantId: string;
  agentId: string;
  laneId: string;
  principal: ChannelRunPrincipal;
  payloadHash: string;
  receivedAt: number;
  leaseOwner?: string;
  leaseEpoch: number;
  leaseExpiresAt: number;
  /** Durable fairness stamp; not execution authority or a retry policy. */
  claimCheckedAt?: number;
  /** Persisted before dispatch; every retry attaches to this exact identity. */
  execution?: {
    protocol?: 'responses';
    responseId?: string;
    apiKeyId?: string;
    encryptedApiKey?: string;
    requestId: string;
    conversationId: string;
    parentMessageId: string;
    generationCreatedAt?: number;
    deliveryKey?: string;
    enqueueAttemptedAt?: number;
  };
  errorCode?: string;
  deliveredAt?: number;
}

export interface ChannelLaneRecord {
  tenantId: string;
  channelId: string;
  laneId: string;
  nextSequence: number;
  activeRunId?: string;
  conversationId?: string;
  responseId?: string;
}

export function createChannelRunModel(
  mongoose: typeof import('mongoose'),
): Model<ChannelRunRecord> {
  const receipt = new Schema<ChannelDeliveryReceipt>(
    {
      operationId: { type: String, required: true },
      outcome: {
        type: String,
        required: true,
        enum: ['planned', 'inflight', 'confirmed', 'retryable', 'unknown', 'permanent_failure'],
      },
      attempts: { type: Number, required: true },
      externalMessageKey: String,
      externalFileId: String,
      retryAt: Number,
      errorCode: String,
      upload: {
        type: new Schema(
          {
            fileId: { type: String, required: true },
            stage: {
              type: String,
              required: true,
              enum: ['allocated', 'uploaded'],
            },
          },
          { _id: false },
        ),
      },
    },
    { _id: false },
  );
  const schema = new Schema<ChannelRunRecord>(
    {
      tenantId: { type: String, required: true },
      channelId: { type: String, required: true },
      agentId: { type: String, required: true },
      laneId: { type: String, required: true },
      runId: { type: String, required: true },
      state: {
        type: String,
        required: true,
        enum: [
          'queued',
          'executing',
          'requires_action',
          'delivering',
          'delivered',
          'failed',
          'cancelled',
          'blocked',
        ],
      },
      admission: { type: Schema.Types.Mixed, required: true },
      principal: { type: Schema.Types.Mixed, required: true },
      payloadHash: { type: String, required: true },
      sequence: { type: Number, required: true },
      receivedAt: { type: Number, required: true },
      leaseOwner: String,
      leaseEpoch: { type: Number, required: true, default: 0 },
      leaseExpiresAt: { type: Number, required: true, default: 0 },
      claimCheckedAt: { type: Number, default: 0 },
      execution: Schema.Types.Mixed,
      snapshot: Schema.Types.Mixed,
      progress: Schema.Types.Mixed,
      plan: Schema.Types.Mixed,
      receipts: { type: [receipt], required: true, default: [] },
      cancellationRequested: { type: Boolean, required: true, default: false },
      errorCode: String,
      deliveredAt: Number,
    },
    { timestamps: true, minimize: false },
  );
  schema.index({ tenantId: 1, runId: 1 }, { unique: true });
  schema.index(
    { tenantId: 1, channelId: 1, 'admission.actor.teamId': 1, 'admission.eventId': 1 },
    { unique: true },
  );
  schema.index({ tenantId: 1, laneId: 1, sequence: 1 }, { unique: true });
  schema.index({ tenantId: 1, channelId: 1, state: 1, leaseExpiresAt: 1, receivedAt: 1 });
  schema.index(
    {
      tenantId: 1,
      channelId: 1,
      state: 1,
      claimCheckedAt: 1,
      receivedAt: 1,
      sequence: 1,
      leaseExpiresAt: 1,
    },
    { name: 'channel_run_fair_claim' },
  );
  schema.index({ state: 1, _id: 1 });
  schema.index({ tenantId: 1, channelId: 1, 'receipts.externalMessageKey': 1 });
  applyTenantIsolation(schema);
  return mongoose.models.ChannelRun ?? mongoose.model<ChannelRunRecord>('ChannelRun', schema);
}

export function createChannelLaneModel(
  mongoose: typeof import('mongoose'),
): Model<ChannelLaneRecord> {
  const schema = new Schema<ChannelLaneRecord>(
    {
      tenantId: { type: String, required: true },
      channelId: { type: String, required: true },
      laneId: { type: String, required: true },
      nextSequence: { type: Number, required: true, default: 0 },
      activeRunId: String,
      conversationId: String,
      responseId: String,
    },
    { timestamps: true },
  );
  schema.index({ tenantId: 1, laneId: 1 }, { unique: true });
  applyTenantIsolation(schema);
  return mongoose.models.ChannelLane ?? mongoose.model<ChannelLaneRecord>('ChannelLane', schema);
}
