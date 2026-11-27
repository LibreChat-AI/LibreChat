import { Model } from 'mongoose';
import type { IBanner } from '~/types';
import { applyTenantIsolation } from '~/models/plugins/tenantIsolation';
import bannerSchema from '~/schema/banner';

export function createBannerModel(mongoose: typeof import('mongoose')): Model<IBanner> {
  applyTenantIsolation(bannerSchema);
  return mongoose.models.Banner || mongoose.model<IBanner>('Banner', bannerSchema);
}
