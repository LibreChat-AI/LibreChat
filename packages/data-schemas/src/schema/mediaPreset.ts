import { Schema } from 'mongoose';
import type { MediaStoredPreset } from '~/types/mediaPreset';
import { omitDefaultTenant } from '~/models/plugins/optionalTenant';

const mediaPresetSchema: Schema<MediaStoredPreset> = new Schema(
  {
    schemaVersion: { type: Number, required: true, default: 1 as const },
    tenantId: { type: String },
    ownerId: { type: String, required: true },
    presetId: { type: String, required: true },
    title: { type: String, required: true },
    isDefault: { type: Boolean, required: true, default: false },
    settings: { type: Schema.Types.Mixed, required: true },
    createdAt: { type: Date, required: true },
    updatedAt: { type: Date, required: true },
    version: { type: Number, required: true, default: 1 as const },
  },
  { minimize: false, versionKey: false, timestamps: true },
);
omitDefaultTenant(mediaPresetSchema);
mediaPresetSchema.index({ tenantId: 1, ownerId: 1, presetId: 1 }, { unique: true });
mediaPresetSchema.index({ tenantId: 1, ownerId: 1, isDefault: 1 });
mediaPresetSchema.index({ ownerId: 1, tenantId: 1, presetId: 1 });
export default mediaPresetSchema;
