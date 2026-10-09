import { Model } from 'mongoose';
import type { IAgentTriggerDeliveryDocument } from '~/types/triggerDelivery';
import { applyTenantIsolation } from '~/models/plugins/tenantIsolation';
import triggerDeliverySchema from '~/schema/triggerDelivery';

export function createAgentTriggerDeliveryModel(
  mongoose: typeof import('mongoose'),
): Model<IAgentTriggerDeliveryDocument> {
  applyTenantIsolation(triggerDeliverySchema);
  return (
    mongoose.models.AgentTriggerDelivery ||
    mongoose.model<IAgentTriggerDeliveryDocument>('AgentTriggerDelivery', triggerDeliverySchema)
  );
}
