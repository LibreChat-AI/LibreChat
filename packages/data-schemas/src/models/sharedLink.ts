import { Model } from 'mongoose';
import { applyTenantIsolation } from '~/models/plugins/tenantIsolation';
import shareSchema, { ISharedLink } from '~/schema/share';

export function createSharedLinkModel(mongoose: typeof import('mongoose')): Model<ISharedLink> {
  applyTenantIsolation(shareSchema);
  return mongoose.models.SharedLink || mongoose.model<ISharedLink>('SharedLink', shareSchema);
}
