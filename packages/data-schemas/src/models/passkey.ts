import { Model } from 'mongoose';
import type * as t from '~/types';
import { applyTenantIsolation } from '~/models/plugins/tenantIsolation';
import passkeySchema from '~/schema/passkey';

export function createPasskeyModel(mongoose: typeof import('mongoose')): Model<t.IPasskey> {
  applyTenantIsolation(passkeySchema);
  return mongoose.models.Passkey || mongoose.model<t.IPasskey>('Passkey', passkeySchema);
}
