import { Schema } from 'mongoose';
import { CODE_APPROVAL_MODES } from 'librechat-data-provider';
import type { IAgentQueuedTurnDocument } from '~/types/queuedTurn';

const fileRefSchema = new Schema(
  {
    file_id: { type: String, required: true, maxlength: 256 },
    type: { type: String, maxlength: 256 },
    filepath: { type: String, maxlength: 2048 },
    filename: { type: String, maxlength: 1024 },
    llmDeliveryPath: { type: String, enum: ['provider', 'text', 'none'] },
    height: { type: Number, min: 0 },
    width: { type: Number, min: 0 },
    bytes: { type: Number, min: 0 },
  },
  { _id: false },
);

const failureSchema = new Schema(
  {
    code: { type: String, required: true, maxlength: 128 },
    message: { type: String, required: true, maxlength: 2048 },
  },
  { _id: false },
);

const terminalReceiptSchema = new Schema(
  {
    outcome: {
      type: String,
      enum: ['admitted', 'cancelled', 'dead'],
      required: true,
    },
    settledAt: { type: Date, required: true },
    admissionId: { type: String, maxlength: 128 },
    admissionMode: { type: String, enum: ['warm', 'ordinary'] },
    generationId: { type: String, maxlength: 256 },
    generationCreatedAt: { type: Number, min: 0 },
    effectivePredecessorCreatedAt: { type: Number, min: 0 },
    lineagePredecessorId: { type: String, maxlength: 128 },
    rootPredecessor: { type: Boolean, enum: [true] },
    failure: { type: failureSchema },
  },
  { _id: false },
);

const queuedTurnSchema: Schema<IAgentQueuedTurnDocument> = new Schema(
  {
    user: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    tenantId: { type: String, index: true },
    conversationId: { type: String, required: true, maxlength: 256 },
    agentId: { type: String, required: true, maxlength: 256 },
    parentMessageId: { type: String, required: true, maxlength: 256 },
    clientRequestId: { type: String, required: true, maxlength: 128 },
    fingerprint: { type: String, required: true, minlength: 43, maxlength: 64 },
    laneId: { type: String, required: true, maxlength: 128 },
    sequence: { type: Number, min: 1 },
    reservationWriterId: { type: String, maxlength: 128 },
    activeSlot: { type: Number, min: 0, max: 99 },
    admissionSlot: { type: Boolean },
    status: {
      type: String,
      enum: ['reserving', 'queued', 'claimed', 'admitted', 'cancelled', 'dead'],
      required: true,
      default: 'reserving',
    },
    priority: { type: Boolean, required: true, default: false },
    text: { type: String, required: true, maxlength: 32_768 },
    files: { type: [fileRefSchema], default: undefined },
    quotes: { type: [String], default: undefined },
    manualSkills: { type: [String], default: undefined },
    codeApprovalMode: { type: String, enum: [...CODE_APPROVAL_MODES] },
    expectedPredecessorCreatedAt: { type: Number, min: 0 },
    attempts: { type: Number, required: true, default: 0, min: 0 },
    availableAt: { type: Date, required: true },
    deliveryKey: { type: String, maxlength: 128 },
    deliveryState: {
      type: String,
      enum: ['pending', 'publishing', 'published', 'retiring', 'retired'],
      required: true,
      default: 'pending',
    },
    scheduledAt: { type: Date },
    claimId: { type: String, maxlength: 128 },
    claimBy: { type: String, maxlength: 256 },
    claimUntil: { type: Date },
    admissionStartedAt: { type: Date },
    admissionId: { type: String, maxlength: 128 },
    admissionEffectivePredecessorCreatedAt: { type: Number, min: 0 },
    admissionLineagePredecessorId: { type: String, maxlength: 128 },
    admissionProtocolVersion: { type: Number, enum: [2] },
    reconciliationAvailableAt: { type: Date },
    reconciliationClaimId: { type: String, maxlength: 128 },
    reconciliationClaimBy: { type: String, maxlength: 256 },
    reconciliationClaimUntil: { type: Date },
    reconciliationAttempts: { type: Number, min: 0 },
    terminalReceipt: { type: terminalReceiptSchema },
  },
  { timestamps: true },
);

queuedTurnSchema.index(
  { tenantId: 1, user: 1, conversationId: 1, clientRequestId: 1 },
  { unique: true },
);
queuedTurnSchema.index(
  { tenantId: 1, user: 1, conversationId: 1, sequence: 1 },
  {
    name: 'agent_queued_turn_sequence',
    unique: true,
    partialFilterExpression: { sequence: { $exists: true } },
  },
);
queuedTurnSchema.index(
  { tenantId: 1, user: 1, conversationId: 1, activeSlot: 1 },
  {
    name: 'agent_queued_turn_active_capacity',
    unique: true,
    partialFilterExpression: { activeSlot: { $exists: true } },
  },
);
queuedTurnSchema.index(
  { tenantId: 1, user: 1, conversationId: 1, laneId: 1, status: 1 },
  {
    name: 'agent_queued_turn_claim_lane',
    unique: true,
    partialFilterExpression: { status: 'claimed' },
  },
);
queuedTurnSchema.index(
  { tenantId: 1, user: 1, conversationId: 1, laneId: 1 },
  {
    name: 'agent_queued_turn_admission_started_lane',
    unique: true,
    /** `admissionStartedAt` is written by both legacy and current workers and
     * survives legacy `dead/ADMISSION_INDETERMINATE` quarantine. This is the
     * cross-version fence after a claim crosses the provider boundary. */
    partialFilterExpression: { admissionStartedAt: { $exists: true } },
  },
);
queuedTurnSchema.index(
  { tenantId: 1, user: 1, conversationId: 1, laneId: 1, admissionSlot: 1 },
  {
    name: 'agent_queued_turn_admission_slot',
    unique: true,
    partialFilterExpression: { admissionSlot: true },
  },
);
queuedTurnSchema.index(
  {
    tenantId: 1,
    user: 1,
    conversationId: 1,
    status: 1,
    priority: -1,
    availableAt: 1,
    sequence: 1,
  },
  { name: 'agent_queued_turn_claim' },
);
queuedTurnSchema.index(
  {
    tenantId: 1,
    user: 1,
    conversationId: 1,
    status: 1,
    priority: -1,
    sequence: 1,
  },
  { name: 'agent_queued_turn_active' },
);
queuedTurnSchema.index({ tenantId: 1, user: 1, status: 1, claimUntil: 1 });
queuedTurnSchema.index({ status: 1, createdAt: 1, _id: 1 });
queuedTurnSchema.index({
  status: 1,
  reconciliationAvailableAt: 1,
  reconciliationClaimUntil: 1,
  _id: 1,
});
queuedTurnSchema.index({
  status: 1,
  scheduledAt: 1,
  availableAt: 1,
  sequence: 1,
});

export default queuedTurnSchema;
