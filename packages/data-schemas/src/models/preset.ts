import { Model } from 'mongoose';
import { applyTenantIsolation } from '~/models/plugins/tenantIsolation';
import presetSchema, { IPreset } from '~/schema/preset';

export function createPresetModel(mongoose: typeof import('mongoose')): Model<IPreset> {
  applyTenantIsolation(presetSchema);
  return mongoose.models.Preset || mongoose.model<IPreset>('Preset', presetSchema);
}
