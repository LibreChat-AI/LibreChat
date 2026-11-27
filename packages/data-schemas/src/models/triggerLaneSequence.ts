import { Model } from 'mongoose';
import type { IAgentTriggerLaneSequenceDocument } from '~/types/triggerDelivery';
import { applyTenantIsolation } from '~/models/plugins/tenantIsolation';
import triggerLaneSequenceSchema from '~/schema/triggerLaneSequence';

export function createAgentTriggerLaneSequenceModel(
  mongoose: typeof import('mongoose'),
): Model<IAgentTriggerLaneSequenceDocument> {
  applyTenantIsolation(triggerLaneSequenceSchema);
  return (
    mongoose.models.AgentTriggerLaneSequence ||
    mongoose.model<IAgentTriggerLaneSequenceDocument>(
      'AgentTriggerLaneSequence',
      triggerLaneSequenceSchema,
    )
  );
}
