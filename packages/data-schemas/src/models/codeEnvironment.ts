import type { Model } from 'mongoose';
import type { CodeEnvironmentDocument } from '~/types';
import { applyTenantIsolation } from '~/models/plugins/tenantIsolation';
import codeEnvironmentSchema from '~/schema/codeEnvironment';

export function createCodeEnvironmentModel(
  mongoose: typeof import('mongoose'),
): Model<CodeEnvironmentDocument> {
  applyTenantIsolation(codeEnvironmentSchema);
  return (
    mongoose.models.CodeEnvironment ||
    mongoose.model<CodeEnvironmentDocument>('CodeEnvironment', codeEnvironmentSchema)
  );
}
