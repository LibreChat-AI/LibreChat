import { Model } from 'mongoose';
import type { IPluginAuth } from '~/types/pluginAuth';
import { applyTenantIsolation } from '~/models/plugins/tenantIsolation';
import pluginAuthSchema from '~/schema/pluginAuth';

export function createPluginAuthModel(mongoose: typeof import('mongoose')): Model<IPluginAuth> {
  applyTenantIsolation(pluginAuthSchema);
  return mongoose.models.PluginAuth || mongoose.model<IPluginAuth>('PluginAuth', pluginAuthSchema);
}
