import { Schema } from 'mongoose';
import type { IArtifactSourceTombstone } from '~/types';

/**
 * Independent of ArtifactApp: conversation deletion writes this even when no
 * catalog record exists yet, so a later first sync cannot recreate a live link
 * to a conversation that is already gone.
 */
const artifactSourceTombstoneSchema: Schema<IArtifactSourceTombstone> =
  new Schema<IArtifactSourceTombstone>(
    {
      createdBy: { type: String, required: true },
      conversationId: { type: String, required: true },
      tenantId: { type: String },
    },
    { timestamps: { createdAt: true, updatedAt: false } },
  );

artifactSourceTombstoneSchema.index(
  { tenantId: 1, createdBy: 1, conversationId: 1 },
  { unique: true },
);

export default artifactSourceTombstoneSchema;
