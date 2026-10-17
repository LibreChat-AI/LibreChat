import { Schema } from 'mongoose';
import type { IResourceLock } from '~/types';

const resourceLockSchema: Schema<IResourceLock> = new Schema<IResourceLock>({
  key: {
    type: String,
    required: true,
    unique: true,
  },
  ownerId: {
    type: String,
    required: true,
  },
  expiresAt: {
    type: Date,
    required: true,
  },
});

resourceLockSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export default resourceLockSchema;
