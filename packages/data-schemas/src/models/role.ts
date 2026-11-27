import { Model } from 'mongoose';
import type { IRole } from '~/types';
import { applyTenantIsolation } from '~/models/plugins/tenantIsolation';
import roleSchema from '~/schema/role';

export function createRoleModel(mongoose: typeof import('mongoose')): Model<IRole> {
  applyTenantIsolation(roleSchema);
  return mongoose.models.Role || mongoose.model<IRole>('Role', roleSchema);
}
