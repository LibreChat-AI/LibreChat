import { Schema } from 'mongoose';
import type { ISkillDeletionDocument } from '~/types/skillDeletion';

const skillDeletionSchema: Schema<ISkillDeletionDocument> = new Schema<ISkillDeletionDocument>(
  {
    skillId: { type: Schema.Types.ObjectId, required: true, unique: true, index: true },
    author: { type: Schema.Types.ObjectId, required: true },
    tenantId: { type: String, index: true },
    startedAt: { type: Date, required: true },
    lastAttemptAt: Date,
    completedAt: Date,
    nextCheckAt: Date,
    claimOwner: String,
    claimExpiresAt: Date,
  },
  { timestamps: true },
);

// The sweep rotates attempted rows and sorts by these fields before its batch limit.
skillDeletionSchema.index({ lastAttemptAt: 1, startedAt: 1, claimExpiresAt: 1 });
skillDeletionSchema.index({ completedAt: 1, nextCheckAt: 1 });
// Let idle sweeps skip completed history whose next audit is not due.
skillDeletionSchema.index({ nextCheckAt: 1 });

export default skillDeletionSchema;
