import { Schema } from 'mongoose';
import type { IAgentQueuedTurnSequenceDocument } from '~/types/queuedTurn';

const queuedTurnSequenceSchema: Schema<IAgentQueuedTurnSequenceDocument> = new Schema(
  {
    _id: { type: String, required: true },
    user: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    tenantId: { type: String, index: true },
    conversationId: { type: String, required: true, maxlength: 256 },
    laneId: { type: String, required: true, maxlength: 128 },
    value: { type: Number, required: true, min: 0 },
    reservationId: { type: String, maxlength: 24 },
    writerId: { type: String, maxlength: 128 },
    writerUntil: { type: Date },
    retiredAt: { type: Date },
    expiresAt: { type: Date },
  },
  { timestamps: true },
);

queuedTurnSequenceSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export default queuedTurnSequenceSchema;
