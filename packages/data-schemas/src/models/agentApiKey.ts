import { Model } from 'mongoose';
import { applyTenantIsolation } from '~/models/plugins/tenantIsolation';
import agentApiKeySchema, { IAgentApiKey } from '~/schema/agentApiKey';
import { applyChannelStorage } from '~/models/plugins/managed';

export function createAgentApiKeyModel(mongoose: typeof import('mongoose')): Model<IAgentApiKey> {
  applyChannelStorage(agentApiKeySchema);
  applyTenantIsolation(agentApiKeySchema);
  return (
    mongoose.models.AgentApiKey || mongoose.model<IAgentApiKey>('AgentApiKey', agentApiKeySchema)
  );
}
