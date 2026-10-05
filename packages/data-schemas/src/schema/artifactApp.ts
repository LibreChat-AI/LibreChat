import { Schema } from 'mongoose';
import { isAllowedArtifactPreviewUrl } from 'librechat-data-provider';
import type { IArtifactApp } from '~/types';

const toolPolicySchema = new Schema(
  {
    enabled: { type: Boolean, default: false },
    allowedServers: { type: [String], default: [] },
    allowedTools: { type: [String], default: [] },
    requireConfirmationForWrites: { type: Boolean, default: true },
  },
  { _id: false },
);

const marketplaceSchema = new Schema(
  {
    listed: { type: Boolean, default: false },
    featured: { type: Boolean, default: false },
    summary: { type: String },
    riskClass: {
      type: String,
      enum: ['none', 'read', 'write', 'external'],
      default: 'none',
    },
    costClass: {
      type: String,
      enum: ['free', 'low', 'medium', 'high'],
      default: 'free',
    },
  },
  { _id: false },
);

const artifactPreviewSchema = new Schema(
  {
    type: { type: String, enum: ['image'], required: true },
    imageUrl: {
      type: String,
      required: true,
      maxlength: 75_000,
      validate: {
        validator: isAllowedArtifactPreviewUrl,
        message: 'Artifact preview must be a base64 PNG, JPEG, or WebP image',
      },
    },
    alt: { type: String, maxlength: 500 },
  },
  { _id: false },
);

const sourceMetadataSchema = new Schema(
  {
    conversationId: { type: String },
    messageId: { type: String },
    originalArtifactId: { type: String },
    sourceKey: { type: String },
    detachedConversationId: { type: String },
  },
  { _id: false },
);

const syncLockSchema = new Schema(
  {
    token: { type: String, required: true },
    expiresAt: { type: Date, required: true },
  },
  { _id: false },
);

const deletionSchema = new Schema(
  {
    requestedBy: { type: String, required: true },
    requestedAt: { type: Date, required: true },
    finalizedAt: { type: Date },
  },
  { _id: false },
);

const reviewSchema = new Schema(
  {
    submittedAt: { type: Date },
    submittedBy: { type: String },
    reviewedAt: { type: Date },
    reviewedBy: { type: String },
    result: { type: String, enum: ['approved', 'rejected'] },
    comment: { type: String },
  },
  { _id: false },
);

const artifactAppSchema: Schema<IArtifactApp> = new Schema<IArtifactApp>(
  {
    artifactAppId: {
      type: String,
      required: true,
    },
    tenantId: {
      type: String,
    },
    title: {
      type: String,
      required: true,
    },
    description: {
      type: String,
    },
    icon: {
      type: String,
    },
    category: {
      type: String,
    },
    tags: {
      type: [String],
      default: undefined,
    },
    createdBy: {
      type: String,
      required: true,
    },
    activeVersionId: {
      type: String,
    },
    latestVersionNumber: {
      type: Number,
      default: 0,
    },
    status: {
      type: String,
      enum: ['draft', 'pending_review', 'published', 'suspended', 'archived'],
      default: 'draft',
    },
    visibility: {
      type: String,
      enum: ['private', 'restricted', 'tenant', 'public'],
      default: 'private',
    },
    allowEmbed: {
      type: Boolean,
      default: false,
    },
    allowFork: {
      type: Boolean,
      default: false,
    },
    allowAnonymousView: {
      type: Boolean,
      default: false,
    },
    toolPolicy: {
      type: toolPolicySchema,
      default: () => ({}),
    },
    marketplace: {
      type: marketplaceSchema,
      default: () => ({}),
    },
    preview: {
      type: artifactPreviewSchema,
      default: undefined,
    },
    sourceMetadata: {
      type: sourceMetadataSchema,
      default: undefined,
    },
    syncLock: {
      type: syncLockSchema,
      default: undefined,
      select: false,
    },
    deletion: {
      type: deletionSchema,
      default: undefined,
    },
    review: {
      type: reviewSchema,
      default: undefined,
    },
    archivedAt: {
      type: Date,
    },
  },
  {
    timestamps: true,
  },
);

artifactAppSchema.index({ tenantId: 1, artifactAppId: 1 }, { unique: true });
artifactAppSchema.index({ tenantId: 1, status: 1, visibility: 1 });
artifactAppSchema.index({ tenantId: 1, 'marketplace.listed': 1, 'marketplace.featured': 1 });
artifactAppSchema.index({ tenantId: 1, createdBy: 1 });
artifactAppSchema.index({ tenantId: 1, updatedAt: -1, _id: -1 });
artifactAppSchema.index({ tenantId: 1, createdBy: 1, updatedAt: -1, _id: -1 });
artifactAppSchema.index({ tenantId: 1, activeVersionId: 1 });
artifactAppSchema.index(
  {
    tenantId: 1,
    createdBy: 1,
    'sourceMetadata.conversationId': 1,
    'sourceMetadata.sourceKey': 1,
  },
  {
    unique: true,
    partialFilterExpression: {
      'sourceMetadata.conversationId': { $type: 'string' },
      'sourceMetadata.sourceKey': { $type: 'string' },
    },
  },
);
artifactAppSchema.index(
  {
    tenantId: 1,
    createdBy: 1,
    'sourceMetadata.detachedConversationId': 1,
    'sourceMetadata.sourceKey': 1,
  },
  {
    partialFilterExpression: {
      'sourceMetadata.detachedConversationId': { $type: 'string' },
      'sourceMetadata.sourceKey': { $type: 'string' },
    },
  },
);

export default artifactAppSchema;
