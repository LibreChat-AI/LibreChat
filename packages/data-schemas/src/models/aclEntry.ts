import { Model } from 'mongoose';
import type * as t from '~/types';
import { applyTenantIsolation } from '~/models/plugins/tenantIsolation';
import aclEntrySchema from '~/schema/aclEntry';

export function createAclEntryModel(mongoose: typeof import('mongoose')): Model<t.IAclEntry> {
  applyTenantIsolation(aclEntrySchema);
  return mongoose.models.AclEntry || mongoose.model<t.IAclEntry>('AclEntry', aclEntrySchema);
}
