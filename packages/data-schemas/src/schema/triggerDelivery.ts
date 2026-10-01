import { Schema } from 'mongoose';
import type { IAgentTriggerDeliveryDocument } from '~/types/triggerDelivery';
import { AGENT_BACKGROUND_TOOL_RESULT_STORAGE_MAX_CHARS } from '~/types/triggerDelivery';

const failureSchema = new Schema(
  {
    code: { type: String, required: true, maxlength: 128 },
    message: { type: String, required: true, maxlength: 2048 },
    certainty: { type: String, enum: ['definite', 'ambiguous'], required: true },
    retryable: { type: Boolean, required: true },
    attemptedAt: { type: Date, required: true },
    status: { type: Number },
  },
  { _id: false },
);

const historySchema = new Schema(
  {
    attempt: { type: Number, required: true, min: 1 },
    outcome: { type: String, enum: ['succeeded', 'retry', 'dead'], required: true },
    at: { type: Date, required: true },
    workerId: { type: String, required: true },
    error: { type: failureSchema },
  },
  { _id: false },
);

const handlingSchema = new Schema(
  {
    status: {
      type: String,
      enum: ['started', 'applied', 'completed_no_action', 'failed', 'cancelled'],
      required: true,
    },
    conversationId: { type: String, required: true, maxlength: 256 },
    streamId: { type: String, required: true, maxlength: 256 },
    generationCreatedAt: { type: Number, required: true, min: 0 },
    startedAt: { type: Date, required: true },
    settledAt: { type: Date },
    error: { type: String, maxlength: 2048 },
    action: {
      type: new Schema(
        {
          toolName: { type: String, required: true, maxlength: 256 },
          toolCallId: { type: String, maxlength: 256 },
        },
        { _id: false },
      ),
      required: false,
    },
  },
  { _id: false },
);

const actorReceiptSchema = new Schema(
  {
    bindingId: { type: String, required: true, maxlength: 256 },
    resolution: {
      type: String,
      enum: ['checkpoint_verified', 'action_compensated', 'history_repaired'],
      required: true,
    },
    checkpoint: {
      type: new Schema(
        {
          threadId: { type: String, required: true, maxlength: 256 },
          checkpointId: { type: String, maxlength: 512 },
          checkpointNs: { type: String, required: true, maxlength: 512 },
        },
        { _id: false },
      ),
      required: true,
    },
    action: {
      type: new Schema(
        {
          toolName: { type: String, required: true, maxlength: 256 },
          toolCallId: { type: String, maxlength: 256 },
        },
        { _id: false },
      ),
      required: true,
    },
    settledAt: { type: Date, required: true },
  },
  { _id: false },
);

const actorDetachedActionSchema = new Schema(
  {
    version: { type: Number, enum: [1], required: true },
    invocationId: { type: String, required: true, maxlength: 128 },
    expectedToolName: { type: String, required: true, maxlength: 256 },
    toolName: { type: String, required: true, maxlength: 256 },
    toolCallId: { type: String, required: true, maxlength: 256 },
    turnId: { type: String, required: true, maxlength: 512 },
    taskId: { type: String, required: true, maxlength: 128 },
    idempotencyKey: { type: String, required: true, minlength: 64, maxlength: 64 },
    launchAttempt: { type: Number, min: 0, max: 15, required: true },
    status: {
      type: String,
      enum: ['reserved', 'running', 'launch_indeterminate', 'succeeded', 'failed', 'cancelled'],
      required: true,
    },
    reservedAt: { type: Date, required: true },
    observedAt: { type: Date, required: true },
    recoveryAfter: { type: Date, required: true },
    launchedAt: { type: Date },
    settledAt: { type: Date },
    result: { type: String, maxlength: 32_768 },
    error: { type: String, maxlength: 2_048 },
  },
  { _id: false },
);

const triggerDeliverySchema: Schema<IAgentTriggerDeliveryDocument> = new Schema(
  {
    deliveryKey: { type: String, required: true, maxlength: 128 },
    fingerprint: { type: String, required: true, maxlength: 128 },
    orderingKey: { type: String, required: true, maxlength: 128 },
    // Zero is reserved for a staging row that is visible before sequence allocation.
    laneSequence: { type: Number, required: true, min: 0 },
    envelope: { type: Schema.Types.Mixed, required: true },
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    tenantId: { type: String, index: true },
    status: {
      type: String,
      enum: [
        'staging',
        'capability_staging',
        'batched',
        'pending',
        'capability_pending',
        'leased',
        'capability_leased',
        'succeeded',
        'capability_dead',
        'dead',
      ],
      required: true,
      default: 'pending',
    },
    requiredWorkerCapability: { type: String, maxlength: 128 },
    capabilityStatus: { type: String, enum: ['publishing', 'pending', 'leased', 'dead'] },
    claimAvailableAt: { type: Date },
    capabilityLeaseBy: { type: String },
    capabilityLeaseUntil: { type: Date },
    capabilityClaimToken: { type: String },
    /** Private process-owner heartbeat; never projected to legacy consumers. */
    producerLeaseUntil: { type: Date, select: false },
    backgroundToolResult: {
      type: new Schema(
        {
          status: {
            type: String,
            enum: ['completed', 'error', 'cancelled'],
            required: true,
          },
          output: {
            type: String,
            required: true,
            maxlength: AGENT_BACKGROUND_TOOL_RESULT_STORAGE_MAX_CHARS,
          },
          settledAt: { type: Date, required: true },
          resultClaim: {
            type: new Schema(
              {
                kind: { type: String, enum: ['wakeup'], required: true },
                claimId: { type: String, required: true, maxlength: 128 },
                claimedAt: { type: Date, required: true },
              },
              { _id: false },
            ),
            required: false,
          },
        },
        { _id: false },
      ),
      select: false,
    },
    backgroundToolResultErasedAt: { type: Date, select: false },
    backgroundToolResultDeletionPendingAt: { type: Date, select: false },
    attempts: { type: Number, required: true, default: 0, min: 0 },
    availableAt: { type: Date, required: true },
    envelopeBytes: { type: Number, min: 0 },
    coalesceKey: { type: String, maxlength: 128 },
    coalesceFrom: { type: Date },
    coalesceUntil: { type: Date },
    batchSize: { type: Number, min: 1 },
    batchBytes: { type: Number, min: 0 },
    batchMemberIds: {
      type: [{ type: Schema.Types.ObjectId, ref: 'AgentTriggerDelivery' }],
      default: undefined,
    },
    batchRootId: { type: Schema.Types.ObjectId, ref: 'AgentTriggerDelivery' },
    batchRootRequeueCount: { type: Number, min: 0 },
    batchMembersSettledAt: { type: Date },
    awaitTerminalHandling: { type: Boolean },
    handling: { type: handlingSchema },
    actorReceipt: { type: actorReceiptSchema, select: false },
    actorDetachedAction: { type: actorDetachedActionSchema, select: false },
    actorDetachedActionHistory: {
      type: [actorDetachedActionSchema],
      default: undefined,
      select: false,
    },
    actorActionAdmittedAt: { type: Date, select: false },
    actorActionAdmissionId: { type: String, maxlength: 64, select: false },
    actorActionAdmissionClosedAt: { type: Date, select: false },
    leaseBy: { type: String },
    leaseUntil: { type: Date },
    claimToken: { type: String },
    lastError: { type: failureSchema },
    result: { type: Schema.Types.Mixed },
    history: { type: [historySchema], default: undefined },
    settledAt: { type: Date },
    expiresAt: { type: Date },
    requeueCount: { type: Number, default: 0, min: 0 },
    stagingRecoveryAt: { type: Date },
    laneCleanupPendingAt: { type: Date },
    wakeRequestedAt: { type: Date },
  },
  { timestamps: true },
);

triggerDeliverySchema.index({ deliveryKey: 1 }, { unique: true });
triggerDeliverySchema.index({ status: 1, availableAt: 1, createdAt: 1 });
triggerDeliverySchema.index({ status: 1, leaseUntil: 1, createdAt: 1 });
triggerDeliverySchema.index({ status: 1, claimAvailableAt: 1, createdAt: 1 });
triggerDeliverySchema.index({
  requiredWorkerCapability: 1,
  capabilityStatus: 1,
  claimAvailableAt: 1,
  createdAt: 1,
});
triggerDeliverySchema.index({
  requiredWorkerCapability: 1,
  capabilityStatus: 1,
  capabilityLeaseUntil: 1,
  createdAt: 1,
});
triggerDeliverySchema.index({ orderingKey: 1, status: 1, laneSequence: 1 });
triggerDeliverySchema.index({
  orderingKey: 1,
  awaitTerminalHandling: 1,
  status: 1,
  'handling.status': 1,
  batchRootId: 1,
  laneSequence: 1,
});
triggerDeliverySchema.index({ batchRootId: 1 }, { sparse: true });
triggerDeliverySchema.index(
  { orderingKey: 1, coalesceKey: 1, status: 1, coalesceUntil: 1 },
  { sparse: true },
);
triggerDeliverySchema.index({ status: 1, updatedAt: -1 });
/** One user's waiting deliveries, read when that user's generation settles. */
triggerDeliverySchema.index({ user: 1, status: 1, availableAt: 1 });
/** Bounded background-result polls by owner, conversation, capability and status. */
triggerDeliverySchema.index({
  user: 1,
  'envelope.event.source.type': 1,
  'envelope.event.source.id': 1,
  'envelope.target.conversationId': 1,
  requiredWorkerCapability: 1,
  status: 1,
  updatedAt: -1,
  _id: -1,
});
triggerDeliverySchema.index({ 'actorReceipt.resolution': 1 }, { sparse: true });
triggerDeliverySchema.index({ user: 1, actorActionAdmittedAt: 1 }, { sparse: true });
triggerDeliverySchema.index({ stagingRecoveryAt: 1 }, { sparse: true });
triggerDeliverySchema.index({ laneCleanupPendingAt: 1 }, { sparse: true });
triggerDeliverySchema.index({ backgroundToolResultDeletionPendingAt: 1 }, { sparse: true });
// Only successful rows receive expiresAt. Dead letters remain available until
// an operator explicitly requeues or removes them.
triggerDeliverySchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export default triggerDeliverySchema;
