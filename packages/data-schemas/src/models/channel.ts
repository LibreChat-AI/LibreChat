import { Schema } from 'mongoose';
import type { AgentChannel } from 'librechat-data-provider';
import type { Model } from 'mongoose';
import { applyTenantIsolation } from './plugins/tenantIsolation';

export interface AgentChannelRecord extends AgentChannel {
  encryptedBotToken?: string;
  encryptedSigningSecret?: string;
  encryptedApiKey?: string;
  apiKeyId?: string;
}

export interface AgentChannelThreadRecord {
  channelId: string;
  tenantId?: string;
  externalThreadKey: string;
  conversationId: string;
}

export function createAgentChannelModel(
  mongoose: typeof import('mongoose'),
): Model<AgentChannelRecord> {
  const schema = new Schema<AgentChannelRecord>(
    {
      channelId: { type: String, required: true },
      tenantId: String,
      agentId: { type: String, required: true },
      createdBy: { type: String, required: true },
      type: { type: String, enum: ['slack'], required: true },
      status: {
        type: String,
        enum: ['pending_install', 'active', 'disabled', 'deleting'],
        required: true,
      },
      credentialMode: { type: String, enum: ['shared', 'per_user'], required: true },
      revision: String,
      slack: { teamId: String, appId: String, botUserId: String },
      encryptedBotToken: { type: String, select: false },
      encryptedSigningSecret: { type: String, select: false },
      encryptedApiKey: { type: String, select: false },
      apiKeyId: { type: String, select: false },
    },
    { timestamps: true },
  );
  schema.index({ channelId: 1 }, { unique: true });
  schema.index({ tenantId: 1, agentId: 1 });
  schema.index({ status: 1, _id: 1 });
  applyTenantIsolation(schema);
  return mongoose.models.AgentChannel ?? mongoose.model<AgentChannelRecord>('AgentChannel', schema);
}

export function createAgentChannelThreadModel(
  mongoose: typeof import('mongoose'),
): Model<AgentChannelThreadRecord> {
  const schema = new Schema<AgentChannelThreadRecord>(
    {
      channelId: { type: String, required: true },
      tenantId: String,
      externalThreadKey: { type: String, required: true },
      conversationId: { type: String, required: true },
    },
    { timestamps: true },
  );
  schema.index({ tenantId: 1, channelId: 1, externalThreadKey: 1 }, { unique: true });
  applyTenantIsolation(schema);
  return (
    mongoose.models.AgentChannelThread ??
    mongoose.model<AgentChannelThreadRecord>('AgentChannelThread', schema)
  );
}
