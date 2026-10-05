import { Schema } from 'mongoose';
import type {
  MediaAssetWrite,
  MediaPermit,
  MediaStoredJob,
  MediaStoredOwner,
  MediaStoredThread,
  MediaStoredTurn,
} from '~/types/media';
import { omitDefaultTenant } from '~/models/plugins/optionalTenant';

const common = {
  schemaVersion: { type: Number, required: true, default: 1 as const },
  tenantId: { type: String },
  ownerId: { type: String, required: true },
  createdAt: { type: Date, required: true },
  updatedAt: { type: Date, required: true },
  version: { type: Number, required: true, default: 1 as const },
};
const options = { minimize: false, versionKey: false, timestamps: true } as const;

export const mediaOwnerSchema: Schema<MediaStoredOwner> = new Schema(
  {
    tenantId: { type: String },
    ownerId: { type: String, required: true },
    status: {
      type: String,
      enum: ['initializing', 'active', 'deleting', 'deleted'],
      required: true,
    },
    creationToken: String,
    workIds: { type: [String], default: [] },
    deletionToken: String,
    deletionPrepared: Boolean,
    expiresAt: Date,
    updatedAt: { type: Date, required: true },
  },
  options,
);
omitDefaultTenant(mediaOwnerSchema);
mediaOwnerSchema.index({ tenantId: 1, ownerId: 1 }, { unique: true });
mediaOwnerSchema.index({ status: 1, ownerId: 1, tenantId: 1 });
mediaOwnerSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const mediaThreadSchema: Schema<MediaStoredThread> = new Schema(
  {
    ...common,
    threadId: { type: String, required: true },
    title: { type: String, required: true },
    status: { type: String, enum: ['active', 'retiring', 'retired'], required: true },
    epoch: { type: Number, required: true },
    originRequestId: { type: String, required: true },
    nextTurnSequence: { type: Number, required: true, default: 0 },
    pendingTurnId: String,
    dispatchJobIds: { type: [String], default: [] },
    cover: Schema.Types.Mixed,
    coverExplicit: Boolean,
    pendingJobCount: { type: Number, default: 0 },
    turnCount: { type: Number, default: 0 },
    retiredAt: Date,
    temporary: Boolean,
    expiresAt: Date,
    payloadPurgedAt: Date,
    titleClaim: {
      type: new Schema({ jobId: String, claimedAt: Date }, { _id: false }),
      default: undefined,
    },
  },
  options,
);
omitDefaultTenant(mediaThreadSchema);
mediaThreadSchema.index({ tenantId: 1, ownerId: 1, threadId: 1 }, { unique: true });
mediaThreadSchema.index({
  tenantId: 1,
  ownerId: 1,
  status: 1,
  temporary: 1,
  createdAt: -1,
  threadId: -1,
});
mediaThreadSchema.index(
  { tenantId: 1, ownerId: 1, status: 1, expiresAt: 1 },
  { partialFilterExpression: { expiresAt: { $exists: true } } },
);

export const mediaTurnSchema: Schema<MediaStoredTurn> = new Schema(
  {
    ...common,
    turnId: { type: String, required: true },
    threadId: { type: String, required: true },
    threadEpoch: { type: Number, required: true },
    sequence: Number,
    kind: { type: String, enum: ['generation', 'import'], required: true },
    parentTurnId: String,
    comparisonId: String,
    prompt: { type: String, default: '' },
    inputs: { type: Schema.Types.Mixed, default: [] },
    selection: Schema.Types.Mixed,
    operation: String,
    sourceJobId: String,
    newThread: Boolean,
    importRequest: Schema.Types.Mixed,
    importIdentityRequest: Schema.Types.Mixed,
    importReceipt: Schema.Types.Mixed,
    clientRequestId: String,
    fingerprint: String,
    publicationPhase: { type: String, enum: ['preparing', 'accepted', 'rejected'], required: true },
    publicationExpiresAt: Date,
  },
  options,
);
omitDefaultTenant(mediaTurnSchema);
mediaTurnSchema.index({ tenantId: 1, ownerId: 1, turnId: 1 }, { unique: true });
mediaTurnSchema.index(
  { tenantId: 1, ownerId: 1, threadId: 1, sequence: 1 },
  {
    unique: true,
    partialFilterExpression: { sequence: { $exists: true } },
  },
);
mediaTurnSchema.index(
  { tenantId: 1, ownerId: 1, kind: 1, clientRequestId: 1 },
  {
    unique: true,
    partialFilterExpression: { kind: 'import' },
  },
);
mediaTurnSchema.index({ publicationPhase: 1, kind: 1, updatedAt: 1, turnId: 1 });

export const mediaJobSchema: Schema<MediaStoredJob> = new Schema(
  {
    ...common,
    jobId: { type: String, required: true },
    threadId: { type: String, required: true },
    turnId: { type: String, required: true },
    threadEpoch: { type: Number, required: true },
    clientRequestId: { type: String, required: true },
    fingerprint: { type: String, required: true },
    request: { type: Schema.Types.Mixed, required: true },
    execution: { type: Schema.Types.Mixed, required: true },
    receipt: { type: Schema.Types.Mixed, required: true },
    phase: { type: String, required: true },
    executionOwner: { type: String, enum: ['media', 'chat'], required: true },
    operation: { type: String, required: true },
    selection: { type: Schema.Types.Mixed, required: true },
    outputs: { type: Schema.Types.Mixed, default: [] },
    error: Schema.Types.Mixed,
    allowedActions: Schema.Types.Mixed,
    retryOfJobId: String,
    newThread: Boolean,
    provider: { type: Schema.Types.Mixed, required: true },
    activeSlot: Number,
    queueCapacity: { type: Number, required: true },
    accounting: Schema.Types.Mixed,
    accountingReview: Schema.Types.Mixed,
    nativeSource: Schema.Types.Mixed,
    temporary: Boolean,
    nativeLimits: Schema.Types.Mixed,
    nativePartKeys: { type: Schema.Types.Mixed, default: undefined },
    nativePartBytes: Number,
    nativeConsumers: { type: [String], default: undefined },
    nativeRetentionState: { type: String, enum: ['live', 'purging', 'purged'] },
    nativeCleanupPending: Boolean,
    nativeConsumerClaims: {
      type: [{ _id: false, conversationId: String, expiresAt: String }],
      default: undefined,
    },
    nativeConsumersCheckedAt: Date,
    nativeConsumersTracked: Boolean,
    recoveryDecisions: { type: [Schema.Types.Mixed], default: undefined },
    publicationExpiresAt: Date,
    payloadPurgedAt: Date,
    dueAt: { type: Date, required: true },
    recoveryFailures: { type: Number, min: 0 },
    leaseToken: String,
    leaseOwner: String,
    leaseUntil: Date,
    cancelRequestedAt: Date,
    dispatchGrantedAt: Date,
  },
  options,
);
omitDefaultTenant(mediaJobSchema);
mediaJobSchema.index({ tenantId: 1, ownerId: 1, jobId: 1 }, { unique: true });
mediaJobSchema.index({ tenantId: 1, ownerId: 1, clientRequestId: 1 }, { unique: true });
mediaJobSchema.index(
  { tenantId: 1, ownerId: 1, activeSlot: 1 },
  {
    unique: true,
    partialFilterExpression: { activeSlot: { $exists: true } },
  },
);
mediaJobSchema.index({ tenantId: 1, ownerId: 1, turnId: 1, createdAt: 1, jobId: 1 });
mediaJobSchema.index({ tenantId: 1, ownerId: 1, threadId: 1, 'receipt.phase': 1, phase: 1 });
mediaJobSchema.index({ executionOwner: 1, 'receipt.phase': 1, phase: 1, dueAt: 1, leaseUntil: 1 });
mediaJobSchema.index({ executionOwner: 1, 'receipt.phase': 1, phase: 1, createdAt: 1 });
mediaJobSchema.index({ 'receipt.phase': 1, updatedAt: 1, jobId: 1 });
mediaJobSchema.index({ tenantId: 1, ownerId: 1, nativeConsumers: 1 });
mediaJobSchema.index({ tenantId: 1, phase: 1, jobId: 1, ownerId: 1 });
mediaJobSchema.index({ tenantId: 1, executionOwner: 1, 'receipt.phase': 1, createdAt: 1 });
mediaJobSchema.index({ executionOwner: 1, nativeCleanupPending: 1, ownerId: 1, tenantId: 1 });
mediaJobSchema.index({ executionOwner: 1, nativeConsumersTracked: 1, nativeConsumersCheckedAt: 1 });
mediaJobSchema.index({ executionOwner: 1, 'nativeSource.expiresAt': 1, nativeRetentionState: 1 });
mediaJobSchema.index(
  {
    tenantId: 1,
    ownerId: 1,
    'execution.bindingRevision': 1,
    'execution.api': 1,
    'provider.operationId': 1,
  },
  {
    unique: true,
    partialFilterExpression: { 'provider.operationId': { $exists: true } },
  },
);

export const mediaAssetWriteSchema: Schema<MediaAssetWrite> = new Schema(
  {
    ...common,
    writeId: { type: String, required: true },
    outputKey: { type: String, required: true },
    rendition: { type: String, required: true },
    ingestToken: { type: String, required: true },
    fileId: { type: String, required: true },
    storageKey: { type: String, required: true },
    source: String,
    storageRegion: String,
    filepath: String,
    renditionLocations: { type: [Schema.Types.Mixed], default: undefined },
    fingerprint: { type: String, required: true },
    state: {
      type: String,
      enum: ['reserved', 'committing', 'published', 'abandoned', 'deleted'],
      required: true,
    },
    asset: Schema.Types.Mixed,
    publicationContent: Schema.Types.Mixed,
    deletionToken: String,
    deletionRetryAt: Date,
    deletionAttempts: Number,
  },
  options,
);
omitDefaultTenant(mediaAssetWriteSchema);
mediaAssetWriteSchema.index({ tenantId: 1, ownerId: 1, writeId: 1 }, { unique: true });
mediaAssetWriteSchema.index(
  { tenantId: 1, ownerId: 1, outputKey: 1, rendition: 1, ingestToken: 1 },
  { unique: true },
);
mediaAssetWriteSchema.index({ tenantId: 1, ownerId: 1, storageKey: 1 }, { unique: true });
mediaAssetWriteSchema.index({ state: 1, updatedAt: 1, writeId: 1 });

/** Capacity spans tenants. All access is through the owner/job-derived repository methods. */
export const mediaPermitSchema: Schema<MediaPermit> = new Schema(
  {
    tenantId: { type: String },
    ownerId: { type: String, required: true },
    permitId: { type: String, required: true },
    capacityKey: { type: String, required: true },
    kind: { type: String, enum: ['queue', 'deployment', 'integration', 'owner'], required: true },
    slot: { type: Number, required: true },
    jobId: { type: String, required: true },
    jobIdentity: { type: String, required: true },
    createdAt: { type: Date, required: true },
  },
  options,
);
omitDefaultTenant(mediaPermitSchema);
mediaPermitSchema.index({ capacityKey: 1, slot: 1 }, { unique: true });
mediaPermitSchema.index({ capacityKey: 1, jobIdentity: 1 }, { unique: true });
mediaPermitSchema.index({ permitId: 1 }, { unique: true });
mediaPermitSchema.index({ ownerId: 1, tenantId: 1, jobId: 1 });

export const mediaActivationSchema: Schema<{ key: string; activatedAt: Date }> = new Schema(
  {
    key: { type: String, required: true },
    activatedAt: { type: Date, required: true },
  },
  options,
);
mediaActivationSchema.index({ key: 1 }, { unique: true });
