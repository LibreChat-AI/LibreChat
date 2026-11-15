import { Schema } from 'mongoose';
import type { Model } from 'mongoose';
import { applyTenantIsolation } from './plugins/tenantIsolation';

/** Organization ownership survives removal of every user-owned application field. */
export interface DiscordReservationRecord {
  tenantId?: string;
  applicationId: string;
  retiring: boolean;
  authorityWrites: number;
}
export function createDiscordReservationModel(
  mongoose: typeof import('mongoose'),
): Model<DiscordReservationRecord> {
  const schema = new Schema<DiscordReservationRecord>(
    {
      tenantId: { type: String, immutable: true },
      applicationId: { type: String, required: true, immutable: true },
      retiring: { type: Boolean, required: true, default: false },
      authorityWrites: { type: Number, required: true, default: 0 },
    },
    { versionKey: false },
  );
  schema.index({ applicationId: 1 }, { unique: true });
  applyTenantIsolation(schema);
  return (
    mongoose.models.DiscordReservation ??
    mongoose.model<DiscordReservationRecord>('DiscordReservation', schema)
  );
}
