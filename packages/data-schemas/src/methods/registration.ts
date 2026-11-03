import { durableStorageConfigSchema } from 'librechat-data-provider';
import type { ManagedRegistration } from '~/types/managed';
import type { ResponseOwner } from '~/models/response';
import { initializeResponseScopes, responseScopeKeys } from './responseScope';
import { createResponseScopeModel } from '~/models/responseScope';
import { managedTargetFilter } from './managed';

export type ManagedRegistrationResult =
  | { status: 'registered'; retentionEpoch: number; expiredAt?: Date }
  | { status: 'closed' | 'capacity' | 'conflict' };

function registrationScope(
  mongoose: typeof import('mongoose'),
  owner: ResponseOwner,
  conversationId: string | undefined,
  entry: ManagedRegistration,
): string {
  managedTargetFilter(mongoose, entry.target);
  if (
    !owner.userId ||
    (owner.tenantId || undefined) !== (entry.target.tenantId || undefined) ||
    (conversationId !== undefined && !conversationId) ||
    !/^[a-f\d]{64}$/.test(entry.key) ||
    !Number.isSafeInteger(entry.retentionEpoch) ||
    entry.retentionEpoch < 0 ||
    // Include conservative array-key/element overhead, not just the value's encoding.
    mongoose.mongo.BSON.calculateObjectSize(entry) + 16 > 512
  )
    throw new TypeError('Invalid managed registration');
  return responseScopeKeys(owner, conversationId ?? '')[conversationId === undefined ? 0 : 1];
}

function sameRegistration(left: ManagedRegistration, right: ManagedRegistration): boolean {
  return (
    left.key === right.key &&
    left.retentionEpoch === right.retentionEpoch &&
    left.target.kind === right.target.kind &&
    left.target.id === right.target.id &&
    left.target.incarnation === right.target.incarnation &&
    (left.target.tenantId || undefined) === (right.target.tenantId || undefined)
  );
}

/** Register before payload publication. Closure freezes this bounded discovery list. */
export async function registerResponseTarget(
  mongoose: typeof import('mongoose'),
  owner: ResponseOwner,
  conversationId: string | undefined,
  entry: ManagedRegistration,
  options: { maxPendingTargetsPerScope?: number } = {},
): Promise<ManagedRegistrationResult> {
  const key = registrationScope(mongoose, owner, conversationId, entry);
  const { maxPendingTargetsPerScope } = durableStorageConfigSchema.parse(options);
  await initializeResponseScopes(mongoose, [key]);
  const scopes = createResponseScopeModel(mongoose);
  const epoch = entry.retentionEpoch === 0 ? { $in: [0, null] } : entry.retentionEpoch;
  const current = await scopes
    .findOneAndUpdate(
      {
        _id: key,
        closed: false,
        retentionEpoch: epoch,
        'pending.key': { $ne: entry.key },
        $and: [
          { $or: [{ expiredAt: null }, { expiredAt: { $gt: new Date() } }] },
          {
            $or: [
              { pendingCount: { $gte: 0, $lt: maxPendingTargetsPerScope } },
              { pendingCount: { $exists: false }, pending: { $exists: false } },
              { pendingCount: { $exists: false }, pending: { $size: 0 } },
            ],
          },
        ],
      },
      {
        $push: { pending: entry },
        $inc: { pendingCount: 1 },
      },
      { new: true },
    )
    .lean();
  if (current)
    return {
      status: 'registered',
      retentionEpoch: current.retentionEpoch ?? 0,
      ...(current.expiredAt && { expiredAt: current.expiredAt }),
    };
  // An ambiguous command is not caught here. Recovery reads the same entry on the primary.
  const anchor = await scopes.findById(key).lean();
  if (!anchor || anchor.closed || (anchor.expiredAt && anchor.expiredAt <= new Date()))
    return { status: 'closed' };
  const existing = anchor.pending?.find((candidate) => candidate.key === entry.key);
  if (existing)
    return sameRegistration(existing, entry)
      ? {
          status: 'registered',
          retentionEpoch: anchor.retentionEpoch ?? 0,
          ...(anchor.expiredAt && { expiredAt: anchor.expiredAt }),
        }
      : { status: 'conflict' };
  if ((anchor.retentionEpoch ?? 0) !== entry.retentionEpoch) return { status: 'conflict' };
  if ((anchor.pendingCount ?? 0) >= maxPendingTargetsPerScope) return { status: 'capacity' };
  throw new Error('Managed registration counter is inconsistent');
}

/** Remove discovery metadata only after indexed canonical ownership is installed. */
export async function settleResponseTarget(
  mongoose: typeof import('mongoose'),
  owner: ResponseOwner,
  conversationId: string | undefined,
  entry: ManagedRegistration,
  observedRetentionEpoch: number,
): Promise<boolean> {
  const key = registrationScope(mongoose, owner, conversationId, entry);
  if (!Number.isSafeInteger(observedRetentionEpoch) || observedRetentionEpoch < 0)
    throw new TypeError('Invalid managed retention epoch');
  const scopes = createResponseScopeModel(mongoose);
  const anchor = await scopes.findById(key).lean();
  if (
    !anchor ||
    anchor.closed ||
    (anchor.retentionEpoch ?? 0) !== observedRetentionEpoch ||
    (anchor.expiredAt && anchor.expiredAt <= new Date())
  )
    return false;
  const existing = anchor.pending?.find((candidate) => candidate.key === entry.key);
  if (!existing || !sameRegistration(existing, entry)) return false;
  const model = mongoose.model(entry.target.kind === 'message' ? 'Message' : 'Conversation');
  const target = await model
    .exists({
      ...managedTargetFilter(mongoose, entry.target),
      '_managed.phase': 'published',
      [conversationId === undefined ? '_managed.ownerKey' : '_managed.conversationKey']: key,
      user: owner.userId,
      ...(conversationId === undefined ? {} : { conversationId }),
      ...(anchor.expiredAt ? { expiredAt: { $lte: anchor.expiredAt } } : {}),
    })
    .read('primary');
  if (!target) return false;
  const result = await scopes.updateOne(
    {
      _id: key,
      closed: false,
      retentionEpoch: observedRetentionEpoch === 0 ? { $in: [0, null] } : observedRetentionEpoch,
      pending: {
        $elemMatch: {
          key: entry.key,
          retentionEpoch: entry.retentionEpoch,
          'target.kind': entry.target.kind,
          'target.id': entry.target.id,
          'target.incarnation': entry.target.incarnation,
          'target.tenantId': entry.target.tenantId || null,
        },
      },
      pendingCount: { $gt: 0 },
      $or: [{ expiredAt: null }, { expiredAt: { $gt: new Date() } }],
    },
    { $pull: { pending: { key: entry.key } }, $inc: { pendingCount: -1 } },
  );
  return result.matchedCount === 1;
}
