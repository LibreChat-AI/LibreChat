import type { Model } from 'mongoose';
import type { ISkillDeletionDocument } from '~/types/skillDeletion';
import { applyTenantIsolation } from '~/models/plugins/tenantIsolation';
import skillDeletionSchema from '~/schema/skillDeletion';

export function createSkillDeletionModel(
  mongoose: typeof import('mongoose'),
): Model<ISkillDeletionDocument> {
  applyTenantIsolation(skillDeletionSchema);
  return (
    mongoose.models.SkillDeletion ||
    mongoose.model<ISkillDeletionDocument>('SkillDeletion', skillDeletionSchema)
  );
}
