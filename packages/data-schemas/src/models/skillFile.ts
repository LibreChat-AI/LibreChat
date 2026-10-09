import { Model } from 'mongoose';
import type { ISkillFileDocument } from '~/types/skill';
import { applyTenantIsolation } from '~/models/plugins/tenantIsolation';
import skillFileSchema from '~/schema/skillFile';

export function createSkillFileModel(
  mongoose: typeof import('mongoose'),
): Model<ISkillFileDocument> {
  applyTenantIsolation(skillFileSchema);
  return (
    mongoose.models.SkillFile || mongoose.model<ISkillFileDocument>('SkillFile', skillFileSchema)
  );
}
