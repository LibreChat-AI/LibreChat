import { Model } from 'mongoose';
import type * as t from '~/types';
import { applyTenantIsolation } from '~/models/plugins/tenantIsolation';
import userSchema from '~/schema/user';

export function createUserModel(mongoose: typeof import('mongoose')): Model<t.IUser> {
  applyTenantIsolation(userSchema);
  return mongoose.models.User || mongoose.model<t.IUser>('User', userSchema);
}
