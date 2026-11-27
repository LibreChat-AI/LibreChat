import { Schema } from 'mongoose';
import type { IAgentTriggerUserPurgeDocument } from '~/types/triggerDelivery';

const triggerUserPurgeSchema: Schema<IAgentTriggerUserPurgeDocument> = new Schema(
  {
    _id: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    fenceStartedAt: { type: Date, required: true },
    tenantId: { type: String, index: true },
  },
  { timestamps: true },
);

export default triggerUserPurgeSchema;
