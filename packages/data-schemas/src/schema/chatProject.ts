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
    /** Claimed only while `projects.maxProjectsPerUser` is set; see the index below. */
    slot: {
      type: Number,
      min: 0,
    },
  },
  { timestamps: true },
);

chatProjectSchema.index({ user: 1, name: 1, _id: 1 });
chatProjectSchema.index({ user: 1, createdAt: -1, _id: -1 });
chatProjectSchema.index({ user: 1, lastConversationAt: -1, _id: -1 });
/** Enforces `projects.maxProjectsPerUser` atomically: each capped create claims the lowest free
 *  slot in [0, max), and two creates racing for the same slot collide here, so one retries.
 *  Keyed by tenant too, as the reads are, so one id in two tenants holds two sets of slots. */
chatProjectSchema.index(
  { user: 1, tenantId: 1, slot: 1 },
  { unique: true, partialFilterExpression: { slot: { $exists: true } } },
);

export default chatProjectSchema;
