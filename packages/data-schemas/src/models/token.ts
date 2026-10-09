import { Model } from 'mongoose';
import type * as t from '~/types';
import { applyTenantIsolation } from '~/models/plugins/tenantIsolation';
import tokenSchema from '~/schema/token';

export function createTokenModel(mongoose: typeof import('mongoose')): Model<t.IToken> {
  applyTenantIsolation(tokenSchema);
  return mongoose.models.Token || mongoose.model<t.IToken>('Token', tokenSchema);
}
