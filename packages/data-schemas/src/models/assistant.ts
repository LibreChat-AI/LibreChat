import { Model } from 'mongoose';
import type { IAssistant } from '~/types';
import { applyTenantIsolation } from '~/models/plugins/tenantIsolation';
import assistantSchema from '~/schema/assistant';

export function createAssistantModel(mongoose: typeof import('mongoose')): Model<IAssistant> {
  applyTenantIsolation(assistantSchema);
  return mongoose.models.Assistant || mongoose.model<IAssistant>('Assistant', assistantSchema);
}
