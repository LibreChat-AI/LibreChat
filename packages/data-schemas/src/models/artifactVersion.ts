import { Model } from 'mongoose';
import type { IArtifactVersion } from '~/types';
import { applyTenantIsolation } from '~/models/plugins/tenantIsolation';
import artifactVersionSchema from '~/schema/artifactVersion';

export function createArtifactVersionModel(
  mongoose: typeof import('mongoose'),
): Model<IArtifactVersion> {
  applyTenantIsolation(artifactVersionSchema);
  return (
    mongoose.models.ArtifactVersion ||
    mongoose.model<IArtifactVersion>('ArtifactVersion', artifactVersionSchema)
  );
}
