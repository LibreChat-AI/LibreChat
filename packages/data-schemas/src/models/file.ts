import { Model } from 'mongoose';
import type { IMongoFile } from '~/types';
import { applyTenantIsolation } from '~/models/plugins/tenantIsolation';
import fileSchema from '~/schema/file';

export function createFileModel(mongoose: typeof import('mongoose')): Model<IMongoFile> {
  applyTenantIsolation(fileSchema);
  return mongoose.models.File || mongoose.model<IMongoFile>('File', fileSchema);
}
