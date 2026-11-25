import type { Model } from 'mongoose';
import type { ISkillUploadIntentDocument } from '~/types/skillDeletion';
import { applyTenantIsolation } from '~/models/plugins/tenantIsolation';
import skillUploadIntentSchema from '~/schema/skillUploadIntent';

export function createSkillUploadIntentModel(
  mongoose: typeof import('mongoose'),
): Model<ISkillUploadIntentDocument> {
  applyTenantIsolation(skillUploadIntentSchema);
  return (
    mongoose.models.SkillUploadIntent ||
    mongoose.model<ISkillUploadIntentDocument>('SkillUploadIntent', skillUploadIntentSchema)
  );
}
