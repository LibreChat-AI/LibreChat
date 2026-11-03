import { Model } from 'mongoose';
import { applyTenantIsolation } from '~/models/plugins/tenantIsolation';
import agentApiKeySchema, { IAgentApiKey } from '~/schema/agentApiKey';
import { applyManagedStorage } from '~/models/plugins/managed';

export function createAgentApiKeyModel(mongoose: typeof import('mongoose')): Model<IAgentApiKey> {
  applyManagedStorage(agentApiKeySchema);
  applyTenantIsolation(agentApiKeySchema);
  return (
    mongoose.models.AgentApiKey || mongoose.model<IAgentApiKey>('AgentApiKey', agentApiKeySchema)
  );
}
