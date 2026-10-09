import { Model } from 'mongoose';
import type { ISkillSyncCredentialDocument } from '~/types/skillSync';
import skillSyncCredentialSchema from '~/schema/skillSyncCredential';

export function createSkillSyncCredentialModel(
  mongoose: typeof import('mongoose'),
): Model<ISkillSyncCredentialDocument> {
  // GitHub skill sync is intentionally app-wide in v1; credentials are referenced by
  // admin-managed config keys and are never returned by tenant-scoped APIs.
  return (
    mongoose.models.SkillSyncCredential ||
    mongoose.model<ISkillSyncCredentialDocument>('SkillSyncCredential', skillSyncCredentialSchema)
  );
}
