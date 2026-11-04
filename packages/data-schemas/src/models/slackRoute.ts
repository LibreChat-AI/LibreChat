import { Schema } from 'mongoose';
import type { Model } from 'mongoose';
import { applyTenantIsolation } from './plugins/tenantIsolation';

/** Route changes select new threads; an existing run keeps its original agent binding. */
export interface SlackRouteRecord {
  tenantId?: string;
  workspaceId: string;
  externalChannelId?: string;
  channelId: string;
  revision: string;
}

export function createSlackRouteModel(
  mongoose: typeof import('mongoose'),
): Model<SlackRouteRecord> {
  const schema = new Schema<SlackRouteRecord>(
    {
      tenantId: String,
      workspaceId: { type: String, required: true },
      externalChannelId: String,
      channelId: { type: String, required: true },
      revision: { type: String, required: true },
    },
    { timestamps: true },
  );
  schema.index({ workspaceId: 1, externalChannelId: 1 }, { unique: true });
  schema.index({ tenantId: 1, channelId: 1, _id: 1 });
  applyTenantIsolation(schema);
  return mongoose.models.SlackRoute ?? mongoose.model<SlackRouteRecord>('SlackRoute', schema);
}

export interface SlackThreadRouteRecord {
  tenantId?: string;
  workspaceId: string;
  externalUserId: string;
  externalThreadKey: string;
  channelId: string;
  userId: string;
}

export function createSlackThreadRouteModel(
  mongoose: typeof import('mongoose'),
): Model<SlackThreadRouteRecord> {
  const schema = new Schema<SlackThreadRouteRecord>({
    tenantId: String,
    workspaceId: { type: String, required: true },
    externalUserId: { type: String, required: true },
    externalThreadKey: { type: String, required: true },
    channelId: { type: String, required: true },
    userId: { type: String, required: true },
  });
  schema.index(
    { workspaceId: 1, externalUserId: 1, externalThreadKey: 1 },
    { unique: true, name: 'slack_thread_binding' },
  );
  schema.index({ tenantId: 1, userId: 1 });
  applyTenantIsolation(schema);
  return (
    mongoose.models.SlackThreadRoute ??
    mongoose.model<SlackThreadRouteRecord>('SlackThreadRoute', schema)
  );
}
