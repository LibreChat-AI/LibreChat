import { Schema } from 'mongoose';
import type { DiscordApplication, DiscordGuild } from 'librechat-data-provider';
import type { Model } from 'mongoose';
import { applyTenantIsolation } from './plugins/tenantIsolation';

export interface DiscordApplicationRecord extends DiscordApplication {
  encryptedBotToken: string;
  encryptedClientSecret: string;
}

export function createDiscordApplicationModel(
  mongoose: typeof import('mongoose'),
): Model<DiscordApplicationRecord> {
  const schema = new Schema<DiscordApplicationRecord>(
    {
      tenantId: { type: String, immutable: true },
      applicationId: { type: String, required: true, immutable: true },
      botUserId: { type: String, required: true, immutable: true },
      publicKey: { type: String, required: true },
      name: { type: String, maxlength: 100 },
      createdBy: { type: String, required: true, immutable: true },
      revision: { type: String, required: true },
      authorityWrites: { type: Number, required: true, default: 0 },
      encryptedBotToken: { type: String, required: true, select: false },
      encryptedClientSecret: { type: String, required: true, select: false },
    },
    { timestamps: true },
  );
  // One application token must never grant several tenant organizations authority.
  schema.index({ applicationId: 1 }, { unique: true });
  schema.index({ tenantId: 1, applicationId: 1 });
  applyTenantIsolation(schema);
  return (
    mongoose.models.DiscordApplication ??
    mongoose.model<DiscordApplicationRecord>('DiscordApplication', schema)
  );
}

export function createDiscordGuildModel(mongoose: typeof import('mongoose')): Model<DiscordGuild> {
  const schema = new Schema<DiscordGuild>(
    {
      tenantId: { type: String, immutable: true },
      installationId: { type: String, required: true, immutable: true },
      applicationId: { type: String, required: true, immutable: true },
      guildId: { type: String, required: true, immutable: true },
      guildName: { type: String, required: true, maxlength: 256 },
      createdBy: { type: String, required: true, immutable: true },
      status: { type: String, required: true, enum: ['active', 'disconnected'] },
      revision: { type: String, required: true },
      authorityWrites: { type: Number, required: true, default: 0 },
    },
    { timestamps: true },
  );
  schema.index({ installationId: 1 }, { unique: true });
  schema.index({ applicationId: 1, guildId: 1 }, { unique: true });
  schema.index({ tenantId: 1, installationId: 1 });
  applyTenantIsolation(schema);
  return mongoose.models.DiscordGuild ?? mongoose.model<DiscordGuild>('DiscordGuild', schema);
}
