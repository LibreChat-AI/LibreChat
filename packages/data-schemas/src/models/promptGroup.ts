import { Model } from 'mongoose';
import type { IPromptGroupDocument } from '~/types/prompts';
import { applyTenantIsolation } from '~/models/plugins/tenantIsolation';
import promptGroupSchema from '~/schema/promptGroup';

export function createPromptGroupModel(
  mongoose: typeof import('mongoose'),
): Model<IPromptGroupDocument> {
  applyTenantIsolation(promptGroupSchema);
  return (
    mongoose.models.PromptGroup ||
    mongoose.model<IPromptGroupDocument>('PromptGroup', promptGroupSchema)
  );
}
