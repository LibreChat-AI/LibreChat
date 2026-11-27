import { Model } from 'mongoose';
import type { IAgent } from '~/types';
import { applyTenantIsolation } from '~/models/plugins/tenantIsolation';
import agentSchema from '~/schema/agent';

export function createAgentModel(mongoose: typeof import('mongoose')): Model<IAgent> {
  applyTenantIsolation(agentSchema);
  return mongoose.models.Agent || mongoose.model<IAgent>('Agent', agentSchema);
}
