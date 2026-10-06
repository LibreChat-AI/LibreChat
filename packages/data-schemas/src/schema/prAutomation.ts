import { Schema } from 'mongoose';
import { PR_AUTOMATION_STATES } from 'librechat-data-provider';
import { PR_AUTOMATION_STOP_CODES } from 'librechat-data-provider';
import { PR_AUTOMATION_TRUST_LEVELS } from 'librechat-data-provider';
import type { IPRAutomationDocument } from '~/types/prAutomation';
import { MAX_PR_AUTOMATION_BOTS } from '~/types/prAutomation';

const trustedBotSchema = new Schema(
  {
    id: { type: Number, required: true, min: 1 },
    login: { type: String, maxlength: 128 },
  },
  { _id: false },
);

const prAutomationSchema: Schema<IPRAutomationDocument> = new Schema(
  {
    user: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    tenantId: {
      type: String,
      index: true,
    },
    conversationId: {
      type: String,
      required: true,
      maxlength: 256,
    },
    repository: { type: String, maxlength: 256 },
    pullNumber: { type: Number, min: 1 },
    state: {
      type: String,
      enum: PR_AUTOMATION_STATES,
      default: 'idle',
      required: true,
    },
    stopCode: { type: String, enum: PR_AUTOMATION_STOP_CODES },
    trust: {
      type: String,
      enum: PR_AUTOMATION_TRUST_LEVELS,
      default: 'approvedBots',
      required: true,
    },
    trustedBots: {
      type: [trustedBotSchema],
      default: [],
      validate: {
        validator: (bots: unknown[]) => bots.length <= MAX_PR_AUTOMATION_BOTS,
        message: `At most ${MAX_PR_AUTOMATION_BOTS} approved bots`,
      },
    },
    round: { type: Number, default: 0, min: 0, required: true },
    startedAt: { type: Date },
    lastHeadSha: { type: String, maxlength: 64 },
  },
  { timestamps: true },
);

/**
 * One automation per user and conversation. The unique index makes enabling
 * idempotent and race-free. It excludes `tenantId` for the same reason as
 * `ToolFavorite`: user ObjectIds are globally unique.
 */
prAutomationSchema.index({ user: 1, conversationId: 1 }, { unique: true });

export default prAutomationSchema;
