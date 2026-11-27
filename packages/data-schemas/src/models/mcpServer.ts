import { Model } from 'mongoose';
import type { MCPServerDocument } from '~/types';
import { applyTenantIsolation } from '~/models/plugins/tenantIsolation';
import mcpServerSchema from '~/schema/mcpServer';

export function createMCPServerModel(
  mongoose: typeof import('mongoose'),
): Model<MCPServerDocument> {
  applyTenantIsolation(mcpServerSchema);
  return (
    mongoose.models.MCPServer || mongoose.model<MCPServerDocument>('MCPServer', mcpServerSchema)
  );
}
