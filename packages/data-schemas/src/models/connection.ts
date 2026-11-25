import { Schema } from 'mongoose';
import { connectionProviders, connectionStatuses } from 'librechat-data-provider';
import type { Connection } from 'librechat-data-provider';
import type { Model } from 'mongoose';
import { applyTenantIsolation } from './plugins/tenantIsolation';

/**
 * A connection as stored. `stateAt` is when the provider was asked for the install's state
 * that `status` last recorded: a later answer is applied only when it was asked for later
 * still, so answers that arrive out of order cannot undo a newer one. Never returned.
 */
export type ConnectionRecord = Connection & { stateAt?: Date };

export function createAgentEventConnectionModel(
  mongoose: typeof import('mongoose'),
): Model<ConnectionRecord> {
  const existing = mongoose.models.AgentEventConnection as Model<ConnectionRecord> | undefined;
  if (existing) return existing;
  const schema = new Schema<ConnectionRecord>(
    {
      id: { type: String, required: true },
      tenantId: String,
      provider: { type: String, enum: connectionProviders, required: true },
      installation: { type: String, required: true },
      account: {
        id: { type: String, required: true },
        name: { type: String, required: true },
      },
      status: { type: String, enum: connectionStatuses, required: true },
      stateAt: Date,
      createdBy: { type: String, required: true },
    },
    { timestamps: true },
  );
  // An ingress URL names a connection before any tenant is known, so the id is unique
  // across tenants.
  schema.index({ id: 1 }, { unique: true });
  // A provider sends one stream per install. The tenant it belongs to must be unambiguous.
  schema.index({ provider: 1, installation: 1 }, { unique: true });
  schema.index({ tenantId: 1, createdAt: -1 });
  applyTenantIsolation(schema);
  return mongoose.model<ConnectionRecord>('AgentEventConnection', schema);
}
