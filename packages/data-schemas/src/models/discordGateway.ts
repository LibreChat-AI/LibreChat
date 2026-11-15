import { Schema } from 'mongoose';
import type { Model } from 'mongoose';
import { applyTenantIsolation } from './plugins/tenantIsolation';

export interface DiscordGatewayCheckpointRecord {
  tenantId?: string;
  applicationId: string;
  applicationRevision: string;
  botUserId: string;
  shardId: number;
  shardCount: number;
  encryptedSession: string;
}
export function createDiscordGatewayCheckpointModel(
  mongoose: typeof import('mongoose'),
): Model<DiscordGatewayCheckpointRecord> {
  const schema = new Schema<DiscordGatewayCheckpointRecord>({
    tenantId: { type: String, immutable: true },
    applicationId: { type: String, required: true, immutable: true },
    applicationRevision: { type: String, required: true },
    botUserId: { type: String, required: true },
    shardId: { type: Number, required: true, min: 0, max: 127, immutable: true },
    shardCount: { type: Number, required: true, min: 1, max: 128 },
    encryptedSession: { type: String, required: true, maxlength: 8192, select: false },
  });
  schema.index({ applicationId: 1, shardId: 1 }, { unique: true });
  applyTenantIsolation(schema);
  return (
    mongoose.models.DiscordGatewayCheckpoint ??
    mongoose.model<DiscordGatewayCheckpointRecord>('DiscordGatewayCheckpoint', schema)
  );
}
