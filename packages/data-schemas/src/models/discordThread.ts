import { Schema } from 'mongoose';
import type { DiscordThreadRoute } from 'librechat-data-provider';
import type { Model } from 'mongoose';
import { applyTenantIsolation } from './plugins/tenantIsolation';

export interface DiscordThreadRouteRecord extends DiscordThreadRoute {
  authorityWrites: number;
}
export interface DiscordThreadPinRecord {
  applicationId: string;
  threadChannelId: string;
  fingerprint: string;
}
export function createDiscordThreadRouteModel(
  mongoose: typeof import('mongoose'),
): Model<DiscordThreadRouteRecord> {
  const schema = new Schema<DiscordThreadRouteRecord>({
    tenantId: { type: String, immutable: true },
    applicationId: { type: String, required: true, immutable: true },
    botUserId: { type: String, required: true, immutable: true },
    guildId: { type: String, required: true, immutable: true },
    parentChannelId: { type: String, required: true, immutable: true },
    threadChannelId: { type: String, required: true, immutable: true },
    threadType: { type: Number, required: true, enum: [11, 12], immutable: true },
    channelId: { type: String, required: true, immutable: true },
    channelRevision: { type: String, required: true, immutable: true },
    routeRevision: { type: String, required: true, immutable: true },
    installationId: { type: String, required: true, immutable: true },
    installationRevision: { type: String, required: true, immutable: true },
    mappingRevision: { type: String, required: true, immutable: true },
    authorityWrites: { type: Number, required: true, default: 0 },
  });
  schema.index({ applicationId: 1, threadChannelId: 1 }, { unique: true });
  schema.index({ tenantId: 1, channelId: 1, _id: 1 });
  schema.index({ tenantId: 1, applicationId: 1, guildId: 1, _id: 1 });
  applyTenantIsolation(schema);
  return (
    mongoose.models.DiscordThreadRoute ??
    mongoose.model<DiscordThreadRouteRecord>('DiscordThreadRoute', schema)
  );
}
/** Opaque pins survive private-state erasure so an existing thread can never silently retarget. */
export function createDiscordThreadPinModel(
  mongoose: typeof import('mongoose'),
): Model<DiscordThreadPinRecord> {
  const schema = new Schema<DiscordThreadPinRecord>(
    {
      applicationId: { type: String, required: true, immutable: true },
      threadChannelId: { type: String, required: true, immutable: true },
      fingerprint: { type: String, required: true, immutable: true },
    },
    { versionKey: false },
  );
  schema.index({ applicationId: 1, threadChannelId: 1 }, { unique: true });
  return (
    mongoose.models.DiscordThreadPin ??
    mongoose.model<DiscordThreadPinRecord>('DiscordThreadPin', schema)
  );
}
