import { Model } from 'mongoose';
import type * as t from '~/types';
import resourceLockSchema from '~/schema/resourceLock';

/**
 * Short-lived per-resource leases that serialize read-audit-write sequences on
 * deployments without transactions. Documents expire via TTL.
 */
export function createResourceLockModel(
  mongoose: typeof import('mongoose'),
): Model<t.IResourceLock> {
  return (
    mongoose.models.ResourceLock ||
    mongoose.model<t.IResourceLock>('ResourceLock', resourceLockSchema)
  );
}
