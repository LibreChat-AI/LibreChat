import { Schema } from 'mongoose';
import type { IAssistant } from '~/types';

const assistantSchema: Schema<IAssistant> = new Schema<IAssistant>(
  {
    user: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    assistant_id: {
      type: String,
      index: true,
      required: true,
    },
    endpoint: {
      type: String,
    },
    avatar: {
      type: Schema.Types.Mixed,
      default: undefined,
    },
    conversation_starters: {
      type: [String],
      default: [],
    },
    access_level: {
      type: Number,
    },
    file_ids: { type: [String], default: undefined },
    actions: { type: [String], default: undefined },
    append_current_datetime: {
      type: Boolean,
      default: false,
    },
    tenantId: {
      type: String,
      index: true,
    },
  },
  {
    timestamps: true,
  },
);

assistantSchema.index({ tenantId: 1, 'avatar.filepath': 1 });

export default assistantSchema;
