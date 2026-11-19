import { Schema } from 'mongoose';
import type { Model } from 'mongoose';
import { applyTenantIsolation } from './plugins/tenantIsolation';

/** Private one-use authorization state; session secrets and provider tokens are never persisted. */
export interface DiscordInstallRecord {
  tenantId?: string;
  stateHash: string;
  sessionHash: string;
  userId: string;
  applicationId: string;
  applicationRevision: string;
  expiresAt: Date;
  installationId?: string;
  installationRevision?: string;
  guildId?: string;
}
export type DiscordInstallView = Omit<DiscordInstallRecord, 'sessionHash'>;

export function createDiscordInstallModel(
  mongoose: typeof import('mongoose'),
): Model<DiscordInstallRecord> {
  const schema = new Schema<DiscordInstallRecord>(
    {
      tenantId: { type: String, immutable: true },
      stateHash: { type: String, required: true, immutable: true, select: false },
      sessionHash: { type: String, required: true, immutable: true, select: false },
      userId: { type: String, required: true, immutable: true },
      applicationId: { type: String, required: true, immutable: true },
      applicationRevision: { type: String, required: true, immutable: true },
      expiresAt: { type: Date, required: true, immutable: true },
      installationId: { type: String, immutable: true },
      installationRevision: { type: String, immutable: true },
      guildId: { type: String, immutable: true },
    },
    { timestamps: true },
  );
  schema.index({ stateHash: 1 }, { unique: true });
  schema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
  schema.index({ tenantId: 1, userId: 1 });
  applyTenantIsolation(schema);
  return (
    mongoose.models.DiscordInstall ?? mongoose.model<DiscordInstallRecord>('DiscordInstall', schema)
  );
}
