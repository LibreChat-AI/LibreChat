import { Model } from 'mongoose';
import type { IArtifactApp } from '~/types';
import { applyTenantIsolation } from '~/models/plugins/tenantIsolation';
import artifactAppSchema from '~/schema/artifactApp';

export function createArtifactAppModel(mongoose: typeof import('mongoose')): Model<IArtifactApp> {
  applyTenantIsolation(artifactAppSchema);
  return (
    mongoose.models.ArtifactApp || mongoose.model<IArtifactApp>('ArtifactApp', artifactAppSchema)
  );
}
