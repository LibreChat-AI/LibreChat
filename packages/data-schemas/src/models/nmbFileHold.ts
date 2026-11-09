import type { Model } from 'mongoose';
import type { INmbFileHold } from '~/schema/nmbFileHold';
import { applyTenantIsolation } from '~/models/plugins/tenantIsolation';
import nmbFileHoldSchema from '~/schema/nmbFileHold';

export function createNmbFileHoldModel(mongoose: typeof import('mongoose')): Model<INmbFileHold> {
  applyTenantIsolation(nmbFileHoldSchema);
  return (
    mongoose.models.NmbFileHold || mongoose.model<INmbFileHold>('NmbFileHold', nmbFileHoldSchema)
  );
}
