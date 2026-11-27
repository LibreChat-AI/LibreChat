import { Model } from 'mongoose';
import type * as t from '~/types';
import { applyTenantIsolation } from '~/models/plugins/tenantIsolation';
import groupSchema from '~/schema/group';

export function createGroupModel(mongoose: typeof import('mongoose')): Model<t.IGroup> {
  applyTenantIsolation(groupSchema);
  return mongoose.models.Group || mongoose.model<t.IGroup>('Group', groupSchema);
}
