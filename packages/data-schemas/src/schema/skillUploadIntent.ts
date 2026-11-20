import { Schema } from 'mongoose';
import type { ISkillUploadIntentDocument } from '~/types/skillDeletion';

const skillUploadIntentSchema: Schema<ISkillUploadIntentDocument> =
  new Schema<ISkillUploadIntentDocument>(
    {
      skillId: { type: Schema.Types.ObjectId, required: true, index: true },
      fileId: { type: String, required: true, unique: true, index: true },
      source: { type: String, required: true },
      storageKey: { type: String, required: true },
      author: { type: Schema.Types.ObjectId, required: true },
      tenantId: { type: String, index: true },
      writerId: { type: String, required: true },
      state: {
        type: String,
        enum: ['uploading', 'committing', 'committed', 'abandoned'],
        required: true,
      },
      cleanupHoldOwner: String,
      cleanupRequestedAt: Date,
      cleanedAt: Date,
      nextCheckAt: Date,
      lastCleanupAttemptAt: Date,
      claimOwner: String,
      claimExpiresAt: Date,
    },
    { timestamps: true },
  );

skillUploadIntentSchema.index({ skillId: 1, state: 1 });
skillUploadIntentSchema.index({ skillId: 1, state: 1, cleanedAt: 1 });
skillUploadIntentSchema.index({ state: 1, lastCleanupAttemptAt: 1, createdAt: 1 });
// The committed cleanup branch must not scan healthy live uploads just to preserve ordering.
skillUploadIntentSchema.index(
  { state: 1, lastCleanupAttemptAt: 1, createdAt: 1 },
  {
    name: 'committed_cleanup_candidates',
    partialFilterExpression: { state: 'committed', cleanupRequestedAt: { $exists: true } },
  },
);
skillUploadIntentSchema.index({ state: 1, cleanedAt: 1, nextCheckAt: 1 });
skillUploadIntentSchema.index({ cleanupRequestedAt: 1, state: 1, nextCheckAt: 1 });

export default skillUploadIntentSchema;
