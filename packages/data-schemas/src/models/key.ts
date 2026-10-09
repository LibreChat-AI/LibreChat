import { Model } from 'mongoose';
import { applyTenantIsolation } from '~/models/plugins/tenantIsolation';
import keySchema, { IKey } from '~/schema/key';

export function createKeyModel(mongoose: typeof import('mongoose')): Model<IKey> {
  applyTenantIsolation(keySchema);
  return mongoose.models.Key || mongoose.model<IKey>('Key', keySchema);
}
