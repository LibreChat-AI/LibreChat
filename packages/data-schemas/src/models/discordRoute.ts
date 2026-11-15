import { Schema } from 'mongoose';
import type { Model } from 'mongoose';
import { applyTenantIsolation } from './plugins/tenantIsolation';

/** A stable destination slot; replacement changes its channel, never its installation. */
export interface DiscordRouteRecord {
  tenantId?: string;
  installationId: string;
  externalChannelId: string;
  channelId: string;
  revision: string;
  authorityWrites: number;
}

export function createDiscordRouteModel(
  mongoose: typeof import('mongoose'),
): Model<DiscordRouteRecord> {
  const schema = new Schema<DiscordRouteRecord>(
    {
      tenantId: { type: String, immutable: true },
      installationId: { type: String, required: true, immutable: true },
      externalChannelId: { type: String, required: true, immutable: true },
      channelId: { type: String, required: true },
      revision: { type: String, required: true },
      authorityWrites: { type: Number, required: true, default: 0 },
    },
    { timestamps: true },
  );
  schema.index(
    { installationId: 1, externalChannelId: 1 },
    { unique: true, name: 'discord_route_slot' },
  );
  schema.index({ channelId: 1 }, { unique: true });
  applyTenantIsolation(schema);
  return mongoose.models.DiscordRoute ?? mongoose.model<DiscordRouteRecord>('DiscordRoute', schema);
}
