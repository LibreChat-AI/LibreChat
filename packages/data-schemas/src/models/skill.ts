import { Model } from 'mongoose';
import type { ISkillDocument } from '~/types/skill';
import { applyTenantIsolation } from '~/models/plugins/tenantIsolation';
import skillSchema from '~/schema/skill';

export function createSkillModel(mongoose: typeof import('mongoose')): Model<ISkillDocument> {
  applyTenantIsolation(skillSchema);
  return mongoose.models.Skill || mongoose.model<ISkillDocument>('Skill', skillSchema);
}
