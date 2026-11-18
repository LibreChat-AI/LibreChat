import { Schema } from 'mongoose';
import type { Model } from 'mongoose';
import { applyTenantIsolation } from '~/models/plugins/tenantIsolation';

interface MCPName {
  name: string;
  tenantId?: string;
}

export const mcpNameSchema: Schema<MCPName> = new Schema<MCPName>({
  name: { type: String, required: true },
  tenantId: { type: String },
});
mcpNameSchema.index({ name: 1, tenantId: 1 }, { unique: true });

/** Durable reservations survive server and account deletion. */
export function createMCPNameModel(mongoose: typeof import('mongoose')): Model<MCPName> {
  applyTenantIsolation(mcpNameSchema);
  return mongoose.models.MCPName || mongoose.model<MCPName>('MCPName', mcpNameSchema);
}
