import { Schema } from 'mongoose';
import { channelSnowflakeSchema } from 'librechat-data-provider';
import type { AgentChannel } from 'librechat-data-provider';
import type { Model } from 'mongoose';
import { applyTenantIsolation } from './plugins/tenantIsolation';

export type AgentChannelRecord = AgentChannel & {
  /** Current private credential authority, populated on service reads, never persisted. */
  applicationRevision?: string;
  encryptedBotToken?: string;
  encryptedSigningSecret?: string;
};

export function createAgentChannelModel(
  mongoose: typeof import('mongoose'),
): Model<AgentChannelRecord> {
  const schema = new Schema<AgentChannelRecord>(
    {
      channelId: { type: String, required: true },
      tenantId: String,
      agentId: { type: String, required: true },
      createdBy: { type: String, required: true },
      type: { type: String, enum: ['slack', 'discord'], required: true },
      status: {
        type: String,
        enum: ['pending_install', 'active', 'disabled', 'deleting'],
        required: true,
      },
      credentialMode: { type: String, enum: ['shared', 'per_user'], required: true },
      revision: { type: String, required: true },
      workspaceId: String,
      installationId: String,
      installationRevision: String,
      discord: {
        applicationId: String,
        guildId: String,
        botUserId: String,
        externalChannelId: String,
      },
      slack: { teamId: String, appId: String, botUserId: String },
      encryptedBotToken: { type: String, select: false },
      encryptedSigningSecret: { type: String, select: false },
    },
    { timestamps: true },
  );
  schema.pre('validate', function () {
    if (this.type === 'discord') {
      if (
        this.credentialMode !== 'per_user' ||
        !this.installationId ||
        !this.installationRevision ||
        !channelSnowflakeSchema.safeParse(this.get('discord.applicationId')).success ||
        !channelSnowflakeSchema.safeParse(this.get('discord.guildId')).success ||
        !channelSnowflakeSchema.safeParse(this.get('discord.botUserId')).success ||
        !channelSnowflakeSchema.safeParse(this.get('discord.externalChannelId')).success ||
        this.workspaceId ||
        this.get('slack.teamId') ||
        this.get('slack.appId') ||
        this.get('slack.botUserId') ||
        this.encryptedBotToken ||
        this.encryptedSigningSecret
      )
        this.invalidate('type', 'Invalid Discord channel binding');
    } else if (
      this.get('installationId') ||
      this.get('installationRevision') ||
      this.get('discord.applicationId') ||
      this.get('discord.guildId') ||
      this.get('discord.botUserId') ||
      this.get('discord.externalChannelId')
    ) {
      this.invalidate('type', 'Invalid Slack channel binding');
    }
  });
  schema.index({ channelId: 1 }, { unique: true });
  schema.index({ tenantId: 1, agentId: 1 });
  schema.index({ tenantId: 1, createdBy: 1 });
  schema.index({ status: 1, _id: 1 });
  schema.index({ type: 1, status: 1, _id: 1 });
  schema.index({ tenantId: 1, 'discord.applicationId': 1, 'discord.guildId': 1 });
  applyTenantIsolation(schema);
  return mongoose.models.AgentChannel ?? mongoose.model<AgentChannelRecord>('AgentChannel', schema);
}
