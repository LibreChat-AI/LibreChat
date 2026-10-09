import { Model } from 'mongoose';
import { applyTenantIsolation } from '~/models/plugins/tenantIsolation';
import transactionSchema, { ITransaction } from '~/schema/transaction';

export function createTransactionModel(mongoose: typeof import('mongoose')): Model<ITransaction> {
  applyTenantIsolation(transactionSchema);
  return (
    mongoose.models.Transaction || mongoose.model<ITransaction>('Transaction', transactionSchema)
  );
}
