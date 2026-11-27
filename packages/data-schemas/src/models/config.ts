import { Model } from 'mongoose';
import type * as t from '~/types';
import { applyTenantIsolation } from '~/models/plugins/tenantIsolation';
import configSchema from '~/schema/config';

export function createConfigModel(mongoose: typeof import('mongoose')): Model<t.IConfig> {
  applyTenantIsolation(configSchema);
  return mongoose.models.Config || mongoose.model<t.IConfig>('Config', configSchema);
}
