import { Model } from 'mongoose';
import type * as t from '~/types';
import { applyTenantIsolation } from '~/models/plugins/tenantIsolation';
import balanceRequestSchema from '~/schema/balanceRequest';

export function createBalanceRequestModel(
  mongoose: typeof import('mongoose'),
): Model<t.IBalanceRequest> {
  applyTenantIsolation(balanceRequestSchema);
  return (
    mongoose.models.BalanceRequest ||
    mongoose.model<t.IBalanceRequest>('BalanceRequest', balanceRequestSchema)
  );
}
