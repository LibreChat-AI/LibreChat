import { Model } from 'mongoose';
import type { IAction } from '~/types';
import { applyTenantIsolation } from '~/models/plugins/tenantIsolation';
import actionSchema from '~/schema/action';

export function createActionModel(mongoose: typeof import('mongoose')): Model<IAction> {
  applyTenantIsolation(actionSchema);
  return mongoose.models.Action || mongoose.model<IAction>('Action', actionSchema);
}
