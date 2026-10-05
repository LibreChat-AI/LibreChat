import { Schema } from 'mongoose';
import type { MediaNativePartDocument } from '~/types/mediaNative';
import { omitDefaultTenant } from '~/models/plugins/optionalTenant';

const mediaNativePartSchema: Schema<MediaNativePartDocument> = new Schema(
  {
    tenantId: String,
    ownerId: { type: String, required: true },
    continuationRef: { type: String, required: true },
    jobId: { type: String, required: true },
    chunkIndex: { type: Number, required: true },
    partIndex: { type: Number, required: true },
    fingerprint: { type: String, required: true },
    part: { type: Schema.Types.Mixed, required: true },
    fileId: String,
    createdAt: { type: Date, required: true },
    expiresAt: Date,
  },
  { versionKey: false, minimize: false, timestamps: true },
);
omitDefaultTenant(mediaNativePartSchema);
mediaNativePartSchema.index(
  { tenantId: 1, ownerId: 1, jobId: 1, chunkIndex: 1, partIndex: 1 },
  { unique: true },
);
mediaNativePartSchema.index({ tenantId: 1, ownerId: 1, continuationRef: 1 }, { unique: true });
mediaNativePartSchema.index({ tenantId: 1, ownerId: 1, fileId: 1 });
mediaNativePartSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
export default mediaNativePartSchema;
