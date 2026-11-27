import { Model } from 'mongoose';
import type { IAgentTriggerUserPurgeDocument } from '~/types/triggerDelivery';
import { applyTenantIsolation } from '~/models/plugins/tenantIsolation';
import triggerUserPurgeSchema from '~/schema/triggerUserPurge';

export function createAgentTriggerUserPurgeModel(
  mongoose: typeof import('mongoose'),
): Model<IAgentTriggerUserPurgeDocument> {
  applyTenantIsolation(triggerUserPurgeSchema);
  return (
    mongoose.models.AgentTriggerUserPurge ||
    mongoose.model<IAgentTriggerUserPurgeDocument>('AgentTriggerUserPurge', triggerUserPurgeSchema)
  );
}
