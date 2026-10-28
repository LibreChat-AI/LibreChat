import { Schema } from 'mongoose';
import {
  MAX_CHAT_PROJECT_DESCRIPTION_LENGTH_CEILING,
  MAX_CHAT_PROJECT_INSTRUCTIONS_LENGTH_CEILING,
} from 'librechat-data-provider';
import type { IChatProjectDocument } from '~/types';

const chatProjectSchema: Schema<IChatProjectDocument> = new Schema<IChatProjectDocument>(
  {
    name: {
      type: String,
      required: true,
      trim: true,
      maxlength: 100,
      index: true,
    },
    description: {
      type: String,
      default: '',
      trim: true,
      maxlength: MAX_CHAT_PROJECT_DESCRIPTION_LENGTH_CEILING,
    },
    instructions: {
      type: String,
      default: '',
      maxlength: MAX_CHAT_PROJECT_INSTRUCTIONS_LENGTH_CEILING,
    },
    contextRevision: {
      type: Number,
      default: 0,
      min: 0,
    },
    file_ids: {
      type: [String],
      default: [],
    },
    user: {
      type: String,
      required: true,
      index: true,
    },
    conversationCount: {
      type: Number,
      default: 0,
      min: 0,
    },
    lastConversationAt: {
      type: Date,
      default: null,
      index: true,
    },
    lastConversationId: {
      type: String,
      default: null,
    },
    tenantId: {
      type: String,
      index: true,
    },
  },
  { timestamps: true },
);

chatProjectSchema.index({ user: 1, name: 1, _id: 1 });
chatProjectSchema.index({ user: 1, createdAt: -1, _id: -1 });
chatProjectSchema.index({ user: 1, lastConversationAt: -1, _id: -1 });

export default chatProjectSchema;
