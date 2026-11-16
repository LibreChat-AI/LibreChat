import { Schema } from 'mongoose';
import type { Model } from 'mongoose';
import { applyTenantIsolation } from '~/models/plugins/tenantIsolation';

interface MCPName {
  name: string;
  tenantId?: string;
}

const schema = new Schema<MCPName>({ name: { type: String, required: true, unique: true } });

/** Durable reservations survive server and account deletion. */
export function createMCPNameModel(mongoose: typeof import('mongoose')): Model<MCPName> {
  applyTenantIsolation(schema);
  return mongoose.models.MCPName || mongoose.model<MCPName>('MCPName', schema);
}
