import { Model } from 'mongoose';
import type * as t from '~/types';
import { applyTenantIsolation } from '~/models/plugins/tenantIsolation';
import agentCategorySchema from '~/schema/agentCategory';

export function createAgentCategoryModel(
  mongoose: typeof import('mongoose'),
): Model<t.IAgentCategory> {
  applyTenantIsolation(agentCategorySchema);
  return (
    mongoose.models.AgentCategory ||
    mongoose.model<t.IAgentCategory>('AgentCategory', agentCategorySchema)
  );
}
