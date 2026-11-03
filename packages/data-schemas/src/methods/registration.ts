import { durableStorageConfigSchema } from 'librechat-data-provider';
import type { Types } from 'mongoose';
import type { ManagedRegistration } from '~/types/managed';
import type { ResponseOwner } from '~/models/response';
import { initializeResponseScopes, responseScopeKeys } from './responseScope';
import { managedTargetFilter, assertManagedTenant } from './managed';
import { createResponseScopeModel } from '~/models/responseScope';
import { includeManagedAllocations } from '~/utils/managed';

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
async function registerResponseTargetOnce(
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

/** Reclaim missing one-shot allocations before refusing new work at the bounded capacity. */
export async function registerResponseTarget(
  mongoose: typeof import('mongoose'),
  owner: ResponseOwner,
  conversationId: string | undefined,
  entry: ManagedRegistration,
  options: { maxPendingTargetsPerScope?: number } = {},
): Promise<ManagedRegistrationResult> {
  const admitted = await registerResponseTargetOnce(
    mongoose,
    owner,
    conversationId,
    entry,
    options,
  );
  if (admitted.status !== 'capacity') return admitted;
  if (!(await reconcileAbsentResponseTargets(mongoose, owner, conversationId))) return admitted;
  // One bounded retry: concurrent registrars may consume the reclaimed space first.
  return registerResponseTargetOnce(mongoose, owner, conversationId, entry, options);
}

/** Remove discovery metadata only after indexed canonical ownership is installed. */
export async function settleResponseTarget(
  mongoose: typeof import('mongoose'),
  owner: ResponseOwner,
  conversationId: string | undefined,
  entry: ManagedRegistration,
  observedRetentionEpoch: number,
): Promise<boolean> {
  return settleTarget(mongoose, owner, conversationId, entry, observedRetentionEpoch, 'published');
}

/** A deleted one-shot allocation cannot return: canonical publication never upserts its ID. */
export async function settleAbsentResponseTarget(
  mongoose: typeof import('mongoose'),
  owner: ResponseOwner,
  conversationId: string | undefined,
  entry: ManagedRegistration,
  observedRetentionEpoch: number,
): Promise<boolean> {
  return settleTarget(mongoose, owner, conversationId, entry, observedRetentionEpoch, 'absent');
}

/** Recovery also discovers a registrar that resumed after its original parent was removed. */
export async function reconcileAbsentResponseTargets(
  mongoose: typeof import('mongoose'),
  owner: ResponseOwner,
  conversationId?: string,
): Promise<number> {
  assertManagedTenant(owner.tenantId);
  if (!owner.userId || (conversationId !== undefined && !conversationId))
    throw new TypeError('Invalid managed scope');
  const key = responseScopeKeys(owner, conversationId ?? '')[conversationId === undefined ? 0 : 1];
  const scopes = createResponseScopeModel(mongoose);
  const anchor = await scopes
    .findById(key)
    .select('pending retentionEpoch closed expiredAt')
    .lean();
  if (!anchor || anchor.closed || (anchor.expiredAt && anchor.expiredAt <= new Date())) return 0;
  const entries = anchor.pending ?? [];
  for (const entry of entries) registrationScope(mongoose, owner, conversationId, entry);
  const absent: ManagedRegistration[] = [];
  for (const kind of ['message', 'conversation'] as const) {
    const candidates = entries.filter((entry) => entry.target.kind === kind);
    if (!candidates.length) continue;
    const model = mongoose.model(kind === 'message' ? 'Message' : 'Conversation');
    const present = await includeManagedAllocations(
      model.find({
        $or: candidates.map((entry) => managedTargetFilter(mongoose, entry.target)),
      }),
    )
      .select({ _id: 1, '_managed.incarnation': 1 })
      .read('primary')
      .lean<Array<{ _id: Types.ObjectId; _managed: { incarnation: string } }>>();
    const identities = new Set(present.map((row) => `${row._id}:${row._managed.incarnation}`));
    absent.push(
      ...candidates.filter(
        (entry) => !identities.has(`${entry.target.id.toLowerCase()}:${entry.target.incarnation}`),
      ),
    );
  }
  if (!absent.length) return 0;
  // Each removal retains its own exact-entry/closure/retention CAS. Partial or lost replies are retryable.
  // eslint-disable-next-line no-restricted-syntax -- payload-free ResponseScope has no tenant field; each CAS uses the validated tenant/owner scope hash.
  const result = await scopes.bulkWrite(
    absent.map((entry) => ({
      updateOne: {
        filter: settlementFilter(key, entry, anchor.retentionEpoch ?? 0),
        update: { $pull: { pending: { key: entry.key } }, $inc: { pendingCount: -1 } },
      },
    })),
    { ordered: false },
  );
  return result.matchedCount;
}

function settlementFilter(key: string, entry: ManagedRegistration, retentionEpoch: number) {
  return {
    _id: key,
    closed: false,
    retentionEpoch: retentionEpoch === 0 ? { $in: [0, null] } : retentionEpoch,
    pending: {
      $elemMatch: {
        key: entry.key,
        retentionEpoch: entry.retentionEpoch,
        'target.kind': entry.target.kind,
        'target.id': entry.target.id,
        'target.incarnation': entry.target.incarnation,
        'target.tenantId': entry.target.tenantId || { $in: [null, ''] },
      },
    },
    pendingCount: { $gt: 0 },
    $or: [{ expiredAt: null }, { expiredAt: { $gt: new Date() } }],
  };
}

async function settleTarget(
  mongoose: typeof import('mongoose'),
  owner: ResponseOwner,
  conversationId: string | undefined,
  entry: ManagedRegistration,
  observedRetentionEpoch: number,
  proof: 'published' | 'absent',
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
  if (proof === 'absent') {
    // Ordinary queries hide unpublished allocations. Hidden is not absent.
    const present = await includeManagedAllocations(
      model.exists(managedTargetFilter(mongoose, entry.target)),
    ).read('primary');
    if (present) return false;
  } else {
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
  }
  const result = await scopes.updateOne(settlementFilter(key, entry, observedRetentionEpoch), {
    $pull: { pending: { key: entry.key } },
    $inc: { pendingCount: -1 },
  });
  return result.matchedCount === 1;
}
