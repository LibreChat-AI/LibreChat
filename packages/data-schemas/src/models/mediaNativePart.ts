import type { Model } from 'mongoose';
import type { MediaNativePartDocument } from '~/types/mediaNative';
import { applyTenantIsolation } from './plugins/tenantIsolation';
import mediaNativePartSchema from '~/schema/mediaNativePart';

export function createMediaNativePartModel(
  mongoose: typeof import('mongoose'),
): Model<MediaNativePartDocument> {
  applyTenantIsolation(mediaNativePartSchema);
  return (
    mongoose.models.MediaNativePart ||
    mongoose.model<MediaNativePartDocument>('MediaNativePart', mediaNativePartSchema)
  );
}
