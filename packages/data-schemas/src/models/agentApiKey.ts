import { Model } from 'mongoose';
import { applyTenantIsolation } from '~/models/plugins/tenantIsolation';
import agentApiKeySchema, { IAgentApiKey } from '~/schema/agentApiKey';

export function createAgentApiKeyModel(mongoose: typeof import('mongoose')): Model<IAgentApiKey> {
  applyTenantIsolation(agentApiKeySchema);
  return (
    mongoose.models.AgentApiKey || mongoose.model<IAgentApiKey>('AgentApiKey', agentApiKeySchema)
  );
}
