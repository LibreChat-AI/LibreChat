import { Model } from 'mongoose';
import type * as t from '~/types';
import { applyTenantIsolation } from '~/models/plugins/tenantIsolation';
import balanceSchema from '~/schema/balance';

export function createBalanceModel(mongoose: typeof import('mongoose')): Model<t.IBalance> {
  applyTenantIsolation(balanceSchema);
  return mongoose.models.Balance || mongoose.model<t.IBalance>('Balance', balanceSchema);
}
