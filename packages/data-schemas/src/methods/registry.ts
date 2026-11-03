import type { FilterQuery } from 'mongoose';
import type {
  ManagedRegistryState,
  ManagedRegistration,
  ManagedRegistrationIntent,
} from '~/types/managed';
import { managedTargetFilter, managedTargetPredicate, assertManagedCleanupTenant } from './managed';
import { MANAGED_REGISTRATION_BYTES } from '~/types/managed';

/** Budget the stamped entry, including its array element and worst-case epoch encoding. */
export function assertManagedRegistration(
  mongoose: typeof import('mongoose'),
  entry: ManagedRegistrationIntent | ManagedRegistration,
  access: 'publication' | 'cleanup' = 'publication',
): void {
  if (access === 'cleanup') {
    assertManagedCleanupTenant(entry.target.tenantId);
    managedTargetPredicate(mongoose, entry.target);
  } else managedTargetFilter(mongoose, entry.target);
  if (
    !/^[a-f\d]{64}$/.test(entry.key) ||
    mongoose.mongo.BSON.calculateObjectSize({ ...entry, retentionEpoch: Number.MAX_SAFE_INTEGER }) +
      16 >
      MANAGED_REGISTRATION_BYTES
  )
    throw new TypeError('Invalid managed registration');
}

export function sameManagedRegistration(
  left: ManagedRegistrationIntent,
  right: ManagedRegistrationIntent,
): boolean {
  return (
    left.key === right.key &&
    left.target.kind === right.target.kind &&
    left.target.id.toLowerCase() === right.target.id.toLowerCase() &&
    left.target.incarnation === right.target.incarnation &&
    (left.target.tenantId || undefined) === (right.target.tenantId || undefined)
  );
}

export function managedRegistryCount(anchor: ManagedRegistryState): number {
  const count = anchor.pendingCount ?? 0;
  if (!Number.isSafeInteger(count) || count < 0 || count !== (anchor.pending?.length ?? 0))
    throw new Error('Managed registration counter is inconsistent');
  return count;
}

export function managedRegistryEpoch(anchor: ManagedRegistryState): number {
  const epoch = anchor.retentionEpoch ?? 0;
  if (!Number.isSafeInteger(epoch) || epoch < 0)
    throw new Error('Managed retention epoch is inconsistent');
  return epoch;
}

export function managedRegistryAdmissionFilter(
  key: string,
  capacity: number,
  epoch: number,
): FilterQuery<ManagedRegistryState> {
  return {
    retentionEpoch: epoch === 0 ? { $in: [0, null] } : epoch,
    'pending.key': { $ne: key },
    $and: [
      {
        $or: [
          { pendingCount: { $gte: 0, $lt: capacity } },
          { pendingCount: { $exists: false }, pending: { $exists: false } },
          { pendingCount: { $exists: false }, pending: { $size: 0 } },
        ],
      },
    ],
  };
}

/** Exact-entry removal: concurrent settlement cannot decrement a second time. */
export function managedRegistryEntryFilter(
  entry: ManagedRegistration,
  epoch: number,
): FilterQuery<ManagedRegistryState> {
  return {
    retentionEpoch: epoch === 0 ? { $in: [0, null] } : epoch,
    pending: {
      $elemMatch: {
        key: entry.key,
        retentionEpoch: entry.retentionEpoch,
        authorityRevision: entry.authorityRevision ?? { $exists: false },
        'target.kind': entry.target.kind,
        'target.id': entry.target.id,
        'target.incarnation': entry.target.incarnation,
        'target.tenantId': entry.target.tenantId || { $in: [null, ''] },
      },
    },
    pendingCount: { $gt: 0 },
  };
}
