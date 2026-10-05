import type { Model } from 'mongoose';
import type {
  MediaAssetWrite,
  MediaPermit,
  MediaStoredJob,
  MediaStoredOwner,
  MediaStoredThread,
  MediaStoredTurn,
} from '~/types/media';
import type { MediaStoredPreset } from '~/types/mediaPreset';
import {
  mediaOwnerSchema,
  mediaActivationSchema,
  mediaPermitSchema,
  mediaAssetWriteSchema,
  mediaJobSchema,
  mediaThreadSchema,
  mediaTurnSchema,
} from '~/schema/media';
import { applyTenantIsolation } from './plugins/tenantIsolation';
import mediaPresetSchema from '~/schema/mediaPreset';

export function createMediaOwnerModel(
  mongoose: typeof import('mongoose'),
): Model<MediaStoredOwner> {
  applyTenantIsolation(mediaOwnerSchema);
  return (
    mongoose.models.MediaOwner || mongoose.model<MediaStoredOwner>('MediaOwner', mediaOwnerSchema)
  );
}

export function createMediaThreadModel(
  mongoose: typeof import('mongoose'),
): Model<MediaStoredThread> {
  applyTenantIsolation(mediaThreadSchema);
  return (
    mongoose.models.MediaThread ||
    mongoose.model<MediaStoredThread>('MediaThread', mediaThreadSchema)
  );
}
export function createMediaTurnModel(mongoose: typeof import('mongoose')): Model<MediaStoredTurn> {
  applyTenantIsolation(mediaTurnSchema);
  return mongoose.models.MediaTurn || mongoose.model<MediaStoredTurn>('MediaTurn', mediaTurnSchema);
}
export function createMediaJobModel(mongoose: typeof import('mongoose')): Model<MediaStoredJob> {
  applyTenantIsolation(mediaJobSchema);
  return mongoose.models.MediaJob || mongoose.model<MediaStoredJob>('MediaJob', mediaJobSchema);
}
export function createMediaAssetWriteModel(
  mongoose: typeof import('mongoose'),
): Model<MediaAssetWrite> {
  applyTenantIsolation(mediaAssetWriteSchema);
  return (
    mongoose.models.MediaAssetWrite ||
    mongoose.model<MediaAssetWrite>('MediaAssetWrite', mediaAssetWriteSchema)
  );
}

export function createMediaPresetModel(
  mongoose: typeof import('mongoose'),
): Model<MediaStoredPreset> {
  applyTenantIsolation(mediaPresetSchema);
  return (
    mongoose.models.MediaPreset ||
    mongoose.model<MediaStoredPreset>('MediaPreset', mediaPresetSchema)
  );
}

export function createMediaPermitModel(mongoose: typeof import('mongoose')): Model<MediaPermit> {
  // Intentionally global: adding the tenant query plugin would partition global capacity.
  return (
    mongoose.models.MediaPermit || mongoose.model<MediaPermit>('MediaPermit', mediaPermitSchema)
  );
}
export function createMediaActivationModel(
  mongoose: typeof import('mongoose'),
): Model<{ key: string; activatedAt: Date }> {
  return (
    mongoose.models.MediaActivation || mongoose.model('MediaActivation', mediaActivationSchema)
  );
}
