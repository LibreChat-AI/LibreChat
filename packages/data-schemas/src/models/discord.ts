import { Schema } from 'mongoose';
import type { DiscordApplication } from 'librechat-data-provider';
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
