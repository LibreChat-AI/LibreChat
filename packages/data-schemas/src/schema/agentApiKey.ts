import mongoose, { Schema, Document, Types } from 'mongoose';

export interface IAgentApiKey extends Document {
  userId: Types.ObjectId;
  name: string;
  keyHash: string;
  keyPrefix: string;
  lastUsedAt?: Date;
  expiresAt?: Date;
  createdAt: Date;
  updatedAt: Date;
  tenantId?: string;
}

const agentApiKeySchema: Schema<IAgentApiKey> = new Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
      maxlength: 100,
    },
    keyHash: {
      type: String,
      required: true,
      select: false,
      index: true,
    },
    keyPrefix: {
      type: String,
      required: true,
      index: true,
    },
    lastUsedAt: {
      type: Date,
    },
    expiresAt: {
      type: Date,
    },
    tenantId: {
      type: String,
      index: true,
    },
  },
  { timestamps: true },
);

agentApiKeySchema.index({ userId: 1, name: 1, tenantId: 1 });

/**
 * TTL index for automatic cleanup of expired keys.
 * MongoDB deletes documents when expiresAt passes (expireAfterSeconds: 0 means immediate).
 * Note: Expired keys are permanently removed, not soft-deleted.
 * If audit trails are needed, remove this index and check expiration programmatically.
 */
agentApiKeySchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export default agentApiKeySchema;
