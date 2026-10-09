import { Model } from 'mongoose';
import type * as t from '~/types';
import { applyTenantIsolation } from '~/models/plugins/tenantIsolation';
import accessRoleSchema from '~/schema/accessRole';

export function createAccessRoleModel(mongoose: typeof import('mongoose')): Model<t.IAccessRole> {
  applyTenantIsolation(accessRoleSchema);
  return (
    mongoose.models.AccessRole || mongoose.model<t.IAccessRole>('AccessRole', accessRoleSchema)
  );
}
