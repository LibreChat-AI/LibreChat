import { Model } from 'mongoose';
import type { IArtifactSourceTombstone } from '~/types';
import artifactSourceTombstoneSchema from '~/schema/artifactSourceTombstone';
import { applyTenantIsolation } from '~/models/plugins/tenantIsolation';

export function createArtifactSourceTombstoneModel(
  mongoose: typeof import('mongoose'),
): Model<IArtifactSourceTombstone> {
  applyTenantIsolation(artifactSourceTombstoneSchema);
  return (
    mongoose.models.ArtifactSourceTombstone ||
    mongoose.model<IArtifactSourceTombstone>(
      'ArtifactSourceTombstone',
      artifactSourceTombstoneSchema,
    )
  );
}
