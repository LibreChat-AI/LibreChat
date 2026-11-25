import { Schema } from 'mongoose';
import type { IAgentTriggerLaneSequenceDocument } from '~/types/triggerDelivery';

const triggerLaneSequenceSchema: Schema<IAgentTriggerLaneSequenceDocument> = new Schema(
  {
    _id: { type: String, required: true },
    value: { type: Number, required: true, min: 1 },
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    tenantId: { type: String, index: true },
    tailDeliveryId: { type: Schema.Types.ObjectId, ref: 'AgentTriggerDelivery' },
    publisherDeliveryId: { type: Schema.Types.ObjectId, ref: 'AgentTriggerDelivery' },
    publisherRequeueCount: { type: Number, min: 0 },
    publisherStartedAt: { type: Date },
    cleanupRequestedAt: { type: Date, index: true },
  },
  { timestamps: true },
);

// Publisher fields exist only while a lane admission is in flight. The sparse
// index keeps the periodic recovery scan proportional to abandoned publishers
// instead of all retained lane history (and is supported by DocumentDB 3.6+).
triggerLaneSequenceSchema.index({ publisherStartedAt: 1 }, { sparse: true });

export default triggerLaneSequenceSchema;
